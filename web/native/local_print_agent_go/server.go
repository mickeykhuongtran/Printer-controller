package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

type serverConfig struct {
	ListenAddress       listenAddress
	Port                int
	AllowedTCPPorts     map[int]struct{}
	AllowNonZebraQueues bool
	RequireOriginToken  bool
	Pairing             *pairingManager
	Logger              *log.Logger
	RawSpoolStateDir    string
}

type appServer struct {
	listenAddress       listenAddress
	port                int
	allowedTCPPorts     map[int]struct{}
	allowNonZebraQueues bool
	requireOriginToken  bool
	pairing             *pairingManager
	logger              *log.Logger
	workSlots           chan struct{}
	printerQueues       *printerTargetQueue
	rawBatches          *rawBatchManager
	rawSpoolBatches     *rawSpoolBatchManager
	rawQueueValidator   func(string) error
	tcpJobs             *tcpJobManager
}

func newAppServer(config serverConfig) *appServer {
	logger := config.Logger
	if logger == nil {
		logger = log.New(io.Discard, "", 0)
	}
	printerQueues := newPrinterTargetQueue()
	stateDir := config.RawSpoolStateDir
	if stateDir == "" && config.Pairing != nil && config.Pairing.store.path != "" {
		stateDir = filepath.Join(filepath.Dir(config.Pairing.store.path), "raw-spool-batches")
	}
	tcpJobs := newTCPJobManagerWithQueue(printerQueues)
	if stateDir != "" {
		tcpJobs.captureDir = filepath.Join(filepath.Dir(stateDir), "rfid-sessions")
	}
	return &appServer{
		listenAddress:       config.ListenAddress,
		port:                config.Port,
		allowedTCPPorts:     config.AllowedTCPPorts,
		allowNonZebraQueues: config.AllowNonZebraQueues,
		requireOriginToken:  config.RequireOriginToken || config.ListenAddress.siteMode,
		pairing:             config.Pairing,
		logger:              logger,
		workSlots:           make(chan struct{}, 4),
		printerQueues:       printerQueues,
		rawBatches:          newRawBatchManager(printerQueues),
		rawSpoolBatches:     newRawSpoolBatchManager(stateDir, printerQueues, printPlatformRawFile, inspectPlatformRawJob),
		rawQueueValidator:   validatePlatformRawQueue,
		tcpJobs:             tcpJobs,
	}
}

func (s *appServer) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Content-Type-Options", "nosniff")

	if err := validateRequestHost(request.Host, s.listenAddress, s.port); err != nil {
		s.writeError(writer, err)
		return
	}

	route, ok := routeFor(request.URL.Path)
	if !ok {
		s.writeError(writer, &apiError{Status: 404, Message: "Unknown endpoint."})
		return
	}

	rawOrigin := strings.TrimSpace(request.Header.Get("Origin"))
	origin := ""
	if rawOrigin != "" {
		var err error
		origin, err = normalizeOrigin(rawOrigin)
		if err != nil {
			s.writeError(writer, forbidden("Origin is not allowed."))
			return
		}
	}

	if request.Method == http.MethodOptions {
		s.handlePreflight(writer, request, route, rawOrigin, origin)
		return
	}

	if rawOrigin != "" {
		if !s.corsOriginAllowed(route, origin) {
			s.writeError(writer, forbidden("Origin is not paired with this connector."))
			return
		}
		s.setCORSHeaders(writer, rawOrigin)
	}

	if route.pairing && s.requireOriginToken && !isHTTPSOrigin(origin) {
		s.writeError(writer, forbidden("Strict pairing requires an HTTPS Origin header."))
		return
	}

	if !route.public {
		if s.requireOriginToken && rawOrigin == "" {
			s.writeError(writer, forbidden("This connector requires a browser Origin and paired token."))
			return
		}
		tokenRequired := rawOrigin != "" && (s.requireOriginToken || !isLoopbackOrigin(origin))
		if tokenRequired {
			token, err := bearerToken(request)
			if err != nil {
				s.writeError(writer, err)
				return
			}
			if !s.pairing.store.verify(origin, token) {
				s.writeError(writer, &apiError{Status: 401, Message: "A valid connector token is required."})
				return
			}
		}
	}

	if request.Method != route.method {
		writer.Header().Set("Allow", route.method+", OPTIONS")
		s.writeError(writer, &apiError{Status: 405, Message: "Method not allowed."})
		return
	}

	switch request.URL.Path {
	case "/v1/health":
		s.handleHealth(writer)
	case "/v1/pair":
		s.handlePair(writer, request, origin)
	case "/v1/printers":
		s.handlePrinters(writer)
	case "/v1/tcp/exchange":
		if err := s.handleTCPExchange(writer, request); err != nil {
			s.writeError(writer, err)
		}
	case "/v1/tcp/job":
		if err := s.handleTCPJob(writer, request, origin); err != nil {
			s.writeError(writer, err)
		}
	case "/v1/print":
		if err := s.handleRawPrint(writer, request); err != nil {
			s.writeError(writer, err)
		}
	case "/v1/print/batch":
		if err := s.handleRawSpoolBatch(writer, request, origin); err != nil {
			s.writeError(writer, err)
		}
	default:
		s.writeError(writer, &apiError{Status: 404, Message: "Unknown endpoint."})
	}
}

type routePolicy struct {
	method  string
	public  bool
	pairing bool
}

func routeFor(path string) (routePolicy, bool) {
	switch path {
	case "/v1/health":
		return routePolicy{method: http.MethodGet, public: true}, true
	case "/v1/pair":
		return routePolicy{method: http.MethodPost, public: true, pairing: true}, true
	case "/v1/printers":
		return routePolicy{method: http.MethodGet}, true
	case "/v1/tcp/exchange", "/v1/tcp/job", "/v1/print", "/v1/print/batch":
		return routePolicy{method: http.MethodPost}, true
	default:
		return routePolicy{}, false
	}
}

func (s *appServer) corsOriginAllowed(route routePolicy, origin string) bool {
	if origin == "" {
		return false
	}
	if s.requireOriginToken && (route.pairing || !route.public) && !isHTTPSOrigin(origin) {
		return false
	}
	if route.public {
		return true
	}
	if !s.requireOriginToken && isLoopbackOrigin(origin) {
		return true
	}
	return s.pairing.store.isPaired(origin)
}

func (s *appServer) setCORSHeaders(writer http.ResponseWriter, exactOrigin string) {
	writer.Header().Set("Access-Control-Allow-Origin", exactOrigin)
	writer.Header().Add("Vary", "Origin")
	writer.Header().Set("Access-Control-Allow-Private-Network", "true")
}

func (s *appServer) handlePreflight(
	writer http.ResponseWriter,
	request *http.Request,
	route routePolicy,
	rawOrigin string,
	origin string,
) {
	if rawOrigin == "" || !s.corsOriginAllowed(route, origin) {
		s.writeError(writer, forbidden("Origin is not allowed for this endpoint."))
		return
	}
	requestedMethod := strings.ToUpper(strings.TrimSpace(request.Header.Get("Access-Control-Request-Method")))
	if requestedMethod != route.method {
		s.writeError(writer, forbidden("Requested CORS method is not allowed."))
		return
	}
	if !allowedPreflightHeaders(request.Header.Get("Access-Control-Request-Headers")) {
		s.writeError(writer, forbidden("Requested CORS headers are not allowed."))
		return
	}
	s.setCORSHeaders(writer, rawOrigin)
	writer.Header().Set("Access-Control-Allow-Methods", route.method+", OPTIONS")
	writer.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Nextwaves-Token, X-Requested-With")
	writer.Header().Set("Access-Control-Max-Age", "600")
	writer.WriteHeader(http.StatusNoContent)
}

func (s *appServer) handleHealth(writer http.ResponseWriter) {
	targets, activeOperations, queuedOperations := s.printerQueues.stats()
	openRawBatches, uncertainRawBatches, retainedRawBatches := s.rawBatches.stats()
	activeTCPJobs, retainedTCPJobs := s.tcpJobs.stats()
	activeTCPJobs += s.tcpJobs.queuedSpoolCount()
	rawSpoolHealthy, rawSpoolCounts := s.rawSpoolBatches.stats()
	s.writeJSON(writer, http.StatusOK, map[string]any{
		"ok":         true,
		"name":       agentName,
		"version":    agentVersion,
		"platform":   runtime.GOOS,
		"arch":       runtime.GOARCH,
		"win32print": platformSpoolerAvailable(),
		"windowsRaw": platformSpoolerAvailable(),
		"tcp":        true,
		"capabilities": map[string]bool{
			"fleetStreamingV1":                s.tcpJobs.captureDir != "",
			"fleetFlowControlV1":              s.tcpJobs.captureDir != "",
			"fleetSpoolV1":                    s.tcpJobs.captureDir != "",
			"productionRowNotesV1":            s.tcpJobs.captureDir != "",
			"productionRevisionsV1":           s.tcpJobs.captureDir != "",
			"tcpExchangeV1":                   true,
			"tcpJobV1":                        true,
			"rfidCaptureV1":                   s.tcpJobs.captureDir != "",
			"rfidBatchAuditV1":                s.tcpJobs.captureDir != "",
			"productionRollLifecycleV1":       s.tcpJobs.captureDir != "",
			"productionRollHistoryV1":         s.tcpJobs.captureDir != "",
			"connectorCounterLifecycleV1":     s.tcpJobs.captureDir != "",
			"productionRollV1":                s.tcpJobs.captureDir != "",
			"tcpServiceFaultLatchV1":          true,
			"tcpBackgroundMonitorV1":          true,
			"productionRollIdentityV2":        s.tcpJobs.captureDir != "",
			"productionRollCountsV2":          s.tcpJobs.captureDir != "",
			"productionRemovalAccountingV2":   s.tcpJobs.captureDir != "",
			"tcpFaultCounterReconciliationV1": s.tcpJobs.captureDir != "",
			"rfidWriteVerifyV1":               s.tcpJobs.captureDir != "",
			"largePrintBatchV1":               true,
			"tcpJobIdempotencyV1":             true,
			"tcpJobReconcileV1":               true,
			"printerTargetQueueV1":            true,
			"rawBatchLeaseV1":                 true,
			"rawSpoolBatchV1":                 rawSpoolHealthy,
		},
		"printerQueue": map[string]int{
			"targets": targets,
			"active":  activeOperations,
			"queued":  queuedOperations,
		},
		"tcpJobs": map[string]int{
			"active":   activeTCPJobs,
			"retained": retainedTCPJobs,
		},
		"rawBatches": map[string]int{
			"open":      openRawBatches,
			"uncertain": uncertainRawBatches,
			"retained":  retainedRawBatches,
		},
		"host":                 s.listenAddress.value,
		"rawSpoolBatches":      rawSpoolCounts,
		"listenAddress":        s.listenAddress.value,
		"siteMode":             s.listenAddress.siteMode,
		"requireOriginToken":   s.requireOriginToken,
		"port":                 s.port,
		"pairedOrigins":        s.pairing.store.count(),
		"pairingCodeExpiresAt": s.pairing.expiresAt().UTC().Format(time.RFC3339),
		"allowedTCPPorts":      sortedPorts(s.allowedTCPPorts),
		"allowNonZebraQueues":  s.allowNonZebraQueues,
	})
}

func (s *appServer) handlePair(writer http.ResponseWriter, request *http.Request, requestOrigin string) {
	var body struct {
		Code   string `json:"code"`
		Origin string `json:"origin"`
	}
	if err := decodeJSON(writer, request, &body); err != nil {
		s.writeError(writer, err)
		return
	}
	origin := requestOrigin
	if origin == "" {
		var err error
		origin, err = normalizeOrigin(body.Origin)
		if err != nil {
			s.writeError(writer, badRequest("origin is required when the Origin header is absent."))
			return
		}
	} else if strings.TrimSpace(body.Origin) != "" {
		bodyOrigin, err := normalizeOrigin(body.Origin)
		if err != nil || bodyOrigin != origin {
			s.writeError(writer, badRequest("origin must match the Origin header."))
			return
		}
	}
	token, err := s.pairing.pair(origin, strings.TrimSpace(body.Code))
	if err != nil {
		s.writeError(writer, err)
		return
	}
	s.logger.Printf("paired origin %s", origin)
	s.writeJSON(writer, http.StatusOK, map[string]any{
		"ok":          true,
		"origin":      origin,
		"token":       token,
		"tokenType":   "Bearer",
		"tokenHeader": "Authorization",
	})
}

func (s *appServer) handlePrinters(writer http.ResponseWriter) {
	printers, err := listPlatformPrinters()
	if err != nil {
		s.writeError(writer, err)
		return
	}
	if printers == nil {
		printers = []PrinterInfo{}
	}
	s.writeJSON(writer, http.StatusOK, map[string]any{"printers": printers})
}

func (s *appServer) withWorkSlot(writer http.ResponseWriter, work func() error) {
	select {
	case s.workSlots <- struct{}{}:
		defer func() { <-s.workSlots }()
	default:
		s.writeError(writer, &apiError{Status: 429, Message: "Connector is busy. Retry the request shortly."})
		return
	}
	if err := work(); err != nil {
		s.writeError(writer, err)
	}
}

func decodeJSON(writer http.ResponseWriter, request *http.Request, destination any) error {
	if request.ContentLength > maxJSONBytes {
		return &apiError{Status: 413, Message: fmt.Sprintf("Request JSON is too large. Max is %d bytes.", maxJSONBytes)}
	}
	contentType := strings.TrimSpace(request.Header.Get("Content-Type"))
	if contentType != "" {
		mediaType, _, err := mime.ParseMediaType(contentType)
		if err != nil || !strings.EqualFold(mediaType, "application/json") {
			return badRequest("Content-Type must be application/json.")
		}
	}
	request.Body = http.MaxBytesReader(writer, request.Body, maxJSONBytes)
	decoder := json.NewDecoder(request.Body)
	if err := decoder.Decode(destination); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return &apiError{Status: 413, Message: fmt.Sprintf("Request JSON is too large. Max is %d bytes.", maxJSONBytes)}
		}
		if errors.Is(err, io.EOF) {
			return badRequest("Request body is empty.")
		}
		return badRequest("Request body is not valid JSON.")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return badRequest("Request body must contain exactly one JSON object.")
	}
	return nil
}

func (s *appServer) writeError(writer http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := "Internal connector error."
	payload := map[string]any{"ok": false}
	var apiErr *apiError
	if errors.As(err, &apiErr) {
		status = apiErr.Status
		message = apiErr.Message
		if apiErr.ServiceFault != "" {
			payload["serviceFault"] = apiErr.ServiceFault
			payload["faultClearRequested"] = apiErr.FaultClearRequested
		}
		if apiErr.Code != "" {
			payload["code"] = apiErr.Code
		}
		if apiErr.Stage != "" {
			payload["stage"] = apiErr.Stage
			payload["outcome"] = apiErr.Outcome
			payload["retrySafety"] = apiErr.RetrySafety
			payload["bytesWritten"] = apiErr.BytesWritten
			payload["writeStarted"] = apiErr.WriteStarted
			payload["writeCompleted"] = apiErr.WriteCompleted
		}
		if apiErr.JobID != "" {
			payload["jobId"] = apiErr.JobID
		}
		if apiErr.Sequence > 0 {
			payload["sequence"] = apiErr.Sequence
		}
		if apiErr.JobState != "" {
			payload["jobState"] = apiErr.JobState
		}
		if apiErr.NextSequence > 0 {
			payload["nextSequence"] = apiErr.NextSequence
		}
		if apiErr.CheckpointState != "" {
			payload["checkpointState"] = apiErr.CheckpointState
		}
		if apiErr.CheckpointHash != "" {
			payload["checkpointHash"] = apiErr.CheckpointHash
		}
	} else {
		s.logger.Printf("internal error: %v", err)
	}
	payload["error"] = message
	s.writeJSON(writer, status, payload)
}

func (s *appServer) writeJSON(writer http.ResponseWriter, status int, payload any) {
	body, err := json.Marshal(payload)
	if err != nil {
		status = http.StatusInternalServerError
		body = []byte(`{"ok":false,"error":"Internal connector error."}`)
	}
	body = append(body, '\n')
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
	writer.WriteHeader(status)
	_, _ = writer.Write(body)
}
