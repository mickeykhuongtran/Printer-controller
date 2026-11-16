package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type tcpExchangeRequest struct {
	Host             string   `json:"host"`
	Port             *float64 `json:"port"`
	Text             *string  `json:"text"`
	PayloadBase64    *string  `json:"payloadBase64"`
	ReadWindowMS     *float64 `json:"readWindowMs"`
	ReadIdleMS       *float64 `json:"readIdleMs"`
	CloseWaitMS      *float64 `json:"closeWaitMs"`
	ConnectTimeoutMS *float64 `json:"connectTimeoutMs"`
	WriteTimeoutMS   *float64 `json:"writeTimeoutMs"`
}

type tcpExchangeOptions struct {
	host           string
	port           int
	payload        []byte
	readWindow     time.Duration
	readIdle       time.Duration
	closeWait      time.Duration
	connectTimeout time.Duration
	writeTimeout   time.Duration
}

func tcpFailure(
	status int,
	message string,
	code string,
	stage string,
	bytesWritten int,
	writeStarted bool,
	writeCompleted bool,
) error {
	outcome := "not_sent"
	retrySafety := "safe"
	if writeStarted {
		outcome = "possibly_sent"
		retrySafety = "unsafe"
	}
	return &apiError{
		Status:         status,
		Message:        message,
		Code:           code,
		Stage:          stage,
		Outcome:        outcome,
		RetrySafety:    retrySafety,
		BytesWritten:   bytesWritten,
		WriteStarted:   writeStarted,
		WriteCompleted: writeCompleted,
	}
}

func wrapTCPResolveFailure(err error) error {
	status := http.StatusBadGateway
	message := err.Error()
	var apiErr *apiError
	if errors.As(err, &apiErr) {
		status = apiErr.Status
		message = apiErr.Message
	}
	code := "TCP_DNS_FAILED"
	if status == http.StatusGatewayTimeout {
		code = "TCP_DNS_TIMEOUT"
	}
	return tcpFailure(status, message, code, "resolve", 0, false, false)
}

func parseAllowedPorts(value string) (map[int]struct{}, error) {
	ports := make(map[int]struct{})
	for _, raw := range strings.Split(value, ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		port, err := strconv.Atoi(raw)
		if err != nil || port < 1 || port > 65535 {
			return nil, fmt.Errorf("%q is not a valid port", raw)
		}
		ports[port] = struct{}{}
	}
	if len(ports) == 0 {
		return nil, fmt.Errorf("at least one port is required")
	}
	return ports, nil
}

func numberAsInt(value *float64, fallback, minimum, maximum int, field string) (int, error) {
	if value == nil {
		return fallback, nil
	}
	if math.IsNaN(*value) || math.IsInf(*value, 0) || *value != math.Trunc(*value) {
		return 0, badRequest("%s must be an integer.", field)
	}
	numeric := int(*value)
	if numeric < minimum || numeric > maximum {
		return 0, badRequest("%s must be between %d and %d.", field, minimum, maximum)
	}
	return numeric, nil
}

func decodeBase64Payload(encoded string) ([]byte, error) {
	if encoded == "" {
		return nil, badRequest("payloadBase64 decoded to an empty payload.")
	}
	if base64.StdEncoding.DecodedLen(len(encoded)) > maxPayloadBytes {
		return nil, &apiError{Status: 413, Message: fmt.Sprintf("Payload is too large. Max is %d bytes.", maxPayloadBytes)}
	}
	payload, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return nil, badRequest("payloadBase64 is not valid base64.")
	}
	if len(payload) == 0 {
		return nil, badRequest("payloadBase64 decoded to an empty payload.")
	}
	if len(payload) > maxPayloadBytes {
		return nil, &apiError{Status: 413, Message: fmt.Sprintf("Payload is too large. Max is %d bytes.", maxPayloadBytes)}
	}
	return payload, nil
}

func latin1TextPayload(text string) ([]byte, error) {
	normalized := strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\r", "\n")
	if !strings.HasSuffix(normalized, "\n") {
		normalized += "\n"
	}
	normalized = strings.ReplaceAll(normalized, "\n", "\r\n")
	payload := make([]byte, 0, len(normalized))
	for _, value := range normalized {
		if value > 255 {
			return nil, badRequest("text contains characters outside Latin-1; use payloadBase64 for exact bytes.")
		}
		payload = append(payload, byte(value))
		if len(payload) > maxPayloadBytes {
			return nil, &apiError{Status: 413, Message: fmt.Sprintf("Payload is too large. Max is %d bytes.", maxPayloadBytes)}
		}
	}
	return payload, nil
}

func (s *appServer) handleTCPExchange(writer http.ResponseWriter, request *http.Request) error {
	var body tcpExchangeRequest
	if err := decodeJSON(writer, request, &body); err != nil {
		return err
	}
	host := strings.TrimSpace(body.Host)
	if host == "" {
		return badRequest("host is required.")
	}
	if strings.ContainsAny(host, `/\@`) {
		return badRequest("host is invalid.")
	}
	port, err := numberAsInt(body.Port, 9100, 1, 65535, "port")
	if err != nil {
		return err
	}
	if _, ok := s.allowedTCPPorts[port]; !ok {
		return forbidden("TCP port %d is not allowed by this connector.", port)
	}

	var payload []byte
	switch {
	case body.PayloadBase64 != nil && strings.TrimSpace(*body.PayloadBase64) != "":
		payload, err = decodeBase64Payload(strings.TrimSpace(*body.PayloadBase64))
	case body.Text != nil:
		payload, err = latin1TextPayload(*body.Text)
	default:
		err = badRequest("text or payloadBase64 is required.")
	}
	if err != nil {
		return err
	}

	readWindowMS, err := numberAsInt(body.ReadWindowMS, 250, 0, 30_000, "readWindowMs")
	if err != nil {
		return err
	}
	readIdleMS, err := numberAsInt(body.ReadIdleMS, 250, 25, 30_000, "readIdleMs")
	if err != nil {
		return err
	}
	closeWaitMS, err := numberAsInt(body.CloseWaitMS, 750, 50, 30_000, "closeWaitMs")
	if err != nil {
		return err
	}
	connectTimeoutMS, err := numberAsInt(body.ConnectTimeoutMS, 5_000, 500, 30_000, "connectTimeoutMs")
	if err != nil {
		return err
	}
	writeTimeoutMS, err := numberAsInt(body.WriteTimeoutMS, 30_000, 500, 120_000, "writeTimeoutMs")
	if err != nil {
		return err
	}

	operationContext, cancel := context.WithTimeout(request.Context(), 45*time.Second)
	defer cancel()
	if result, handled, activeErr := s.tcpJobs.activeExchange(operationContext, host, port, payload, time.Duration(readWindowMS)*time.Millisecond, time.Duration(readIdleMS)*time.Millisecond); handled {
		if activeErr != nil {
			return activeErr
		}
		s.writeJSON(writer, http.StatusOK, map[string]any{"ok": true, "bytesWritten": result.bytesWritten, "response": result.response, "resolvedAddress": result.resolvedAddress})
		return nil
	}
	release, err := s.printerQueues.acquire(
		operationContext,
		tcpPrinterTargetKey(host, port),
	)
	if err != nil {
		return err
	}
	defer release()
	result, err := exchangePrinterTCP(operationContext, tcpExchangeOptions{
		host:           host,
		port:           port,
		payload:        payload,
		readWindow:     time.Duration(readWindowMS) * time.Millisecond,
		readIdle:       time.Duration(readIdleMS) * time.Millisecond,
		closeWait:      time.Duration(closeWaitMS) * time.Millisecond,
		connectTimeout: time.Duration(connectTimeoutMS) * time.Millisecond,
		writeTimeout:   time.Duration(writeTimeoutMS) * time.Millisecond,
	})
	if err != nil {
		return err
	}
	s.writeJSON(writer, http.StatusOK, map[string]any{
		"ok":              true,
		"bytesWritten":    result.bytesWritten,
		"response":        result.response,
		"resolvedAddress": result.resolvedAddress,
	})
	return nil
}

type tcpExchangeResult struct {
	bytesWritten    int
	response        string
	resolvedAddress string
}

func exchangePrinterTCP(parent context.Context, options tcpExchangeOptions) (tcpExchangeResult, error) {
	addresses, err := resolveAllowedPrinterAddresses(parent, options.host)
	if err != nil {
		return tcpExchangeResult{}, wrapTCPResolveFailure(err)
	}
	connectContext, cancel := context.WithTimeout(parent, options.connectTimeout)
	defer cancel()

	var connection net.Conn
	var connectedIP net.IP
	var dialErrors []string
	var lastDialError error
	dialer := net.Dialer{Timeout: options.connectTimeout, KeepAlive: 5 * time.Second}
	for _, ip := range addresses {
		address := net.JoinHostPort(ip.String(), strconv.Itoa(options.port))
		connection, err = dialer.DialContext(connectContext, "tcp", address)
		if err == nil {
			connectedIP = ip
			break
		}
		lastDialError = err
		dialErrors = append(dialErrors, err.Error())
		if connectContext.Err() != nil {
			break
		}
	}
	if connection == nil {
		lastDialTimedOut := false
		if networkError, ok := lastDialError.(net.Error); ok {
			lastDialTimedOut = networkError.Timeout()
		}
		if errors.Is(connectContext.Err(), context.DeadlineExceeded) || lastDialTimedOut {
			return tcpExchangeResult{}, tcpFailure(
				http.StatusGatewayTimeout,
				fmt.Sprintf("TCP connect timeout to %s:%d.", options.host, options.port),
				"TCP_CONNECT_TIMEOUT",
				"connect",
				0,
				false,
				false,
			)
		}
		return tcpExchangeResult{}, tcpFailure(
			http.StatusBadGateway,
			fmt.Sprintf("Could not connect to printer %s:%d (%s).", options.host, options.port, strings.Join(dialErrors, "; ")),
			"TCP_CONNECT_FAILED",
			"connect",
			0,
			false,
			false,
		)
	}
	defer connection.Close()
	if tcpConnection, ok := connection.(*net.TCPConn); ok {
		_ = tcpConnection.SetNoDelay(true)
		_ = tcpConnection.SetKeepAlive(true)
		_ = tcpConnection.SetKeepAlivePeriod(5 * time.Second)
	}

	writeDeadline := time.Now().Add(options.writeTimeout)
	if parentDeadline, ok := parent.Deadline(); ok && parentDeadline.Before(writeDeadline) {
		writeDeadline = parentDeadline
	}
	if err := connection.SetWriteDeadline(writeDeadline); err != nil {
		return tcpExchangeResult{}, tcpFailure(
			http.StatusBadGateway,
			"Could not set printer write timeout.",
			"TCP_WRITE_FAILED",
			"write",
			0,
			false,
			false,
		)
	}
	written := 0
	writeStarted := true
	for written < len(options.payload) {
		count, writeErr := connection.Write(options.payload[written:])
		written += count
		if writeErr != nil {
			completed := written >= len(options.payload)
			if timeout, ok := writeErr.(net.Error); ok && timeout.Timeout() {
				return tcpExchangeResult{}, tcpFailure(
					http.StatusGatewayTimeout,
					fmt.Sprintf("TCP write to printer timed out after %d bytes.", written),
					"TCP_WRITE_TIMEOUT",
					"write",
					written,
					writeStarted,
					completed,
				)
			}
			return tcpExchangeResult{}, tcpFailure(
				http.StatusBadGateway,
				fmt.Sprintf("TCP write to printer failed after %d bytes: %v.", written, writeErr),
				"TCP_WRITE_FAILED",
				"write",
				written,
				writeStarted,
				completed,
			)
		}
		if count == 0 {
			return tcpExchangeResult{}, tcpFailure(
				http.StatusBadGateway,
				"TCP connection accepted zero bytes.",
				"TCP_WRITE_ZERO",
				"write",
				written,
				writeStarted,
				false,
			)
		}
	}
	writeCompleted := true
	_ = connection.SetWriteDeadline(time.Time{})

	result := tcpExchangeResult{
		bytesWritten:    written,
		resolvedAddress: connectedIP.String(),
	}
	if options.readWindow <= 0 {
		return result, nil
	}

	windowDeadline := time.Now().Add(options.readWindow)
	buffer := make([]byte, 32*1024)
	response := bytes.NewBuffer(make([]byte, 0, 4096))
	receivedAny := false
	for {
		deadline := windowDeadline
		if receivedAny {
			idleDeadline := time.Now().Add(options.readIdle)
			if idleDeadline.Before(deadline) {
				deadline = idleDeadline
			}
		}
		if parentDeadline, ok := parent.Deadline(); ok && parentDeadline.Before(deadline) {
			deadline = parentDeadline
		}
		if err := connection.SetReadDeadline(deadline); err != nil {
			return tcpExchangeResult{}, tcpFailure(
				http.StatusBadGateway,
				"Could not set printer read timeout.",
				"TCP_READ_FAILED",
				"read",
				written,
				writeStarted,
				writeCompleted,
			)
		}
		count, readErr := connection.Read(buffer)
		if count > 0 {
			receivedAny = true
			if response.Len()+count > maxTCPResponseBytes {
				return tcpExchangeResult{}, tcpFailure(
					http.StatusBadGateway,
					fmt.Sprintf("Printer response exceeded %d bytes.", maxTCPResponseBytes),
					"TCP_RESPONSE_TOO_LARGE",
					"read",
					written,
					writeStarted,
					writeCompleted,
				)
			}
			_, _ = response.Write(buffer[:count])
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			if timeout, ok := readErr.(net.Error); ok && timeout.Timeout() {
				break
			}
			return tcpExchangeResult{}, tcpFailure(
				http.StatusBadGateway,
				fmt.Sprintf("TCP read from printer failed: %v.", readErr),
				"TCP_READ_FAILED",
				"read",
				written,
				writeStarted,
				writeCompleted,
			)
		}
		if !time.Now().Before(windowDeadline) {
			break
		}
	}
	result.response = bytesToLatin1String(response.Bytes())

	if tcpConnection, ok := connection.(*net.TCPConn); ok {
		_ = tcpConnection.SetDeadline(time.Now().Add(options.closeWait))
		_ = tcpConnection.CloseWrite()
	}
	return result, nil
}

func resolveAllowedPrinterAddresses(parent context.Context, host string) ([]net.IP, error) {
	host = strings.TrimSpace(strings.Trim(host, "[]"))
	if parsed := net.ParseIP(host); parsed != nil {
		if !isAllowedPrinterIP(parsed) {
			return nil, forbidden("TCP destination must be a private or link-local IP address.")
		}
		return []net.IP{parsed}, nil
	}
	if !validDNSName(strings.ToLower(host)) {
		return nil, badRequest("host is not a valid IP address or DNS hostname.")
	}
	resolveContext, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()
	resolved, err := net.DefaultResolver.LookupIPAddr(resolveContext, host)
	if err != nil {
		if errors.Is(resolveContext.Err(), context.DeadlineExceeded) {
			return nil, &apiError{Status: http.StatusGatewayTimeout, Message: "DNS lookup for printer host timed out."}
		}
		return nil, &apiError{Status: http.StatusBadGateway, Message: fmt.Sprintf("Could not resolve printer host: %v.", err)}
	}
	if len(resolved) == 0 {
		return nil, &apiError{Status: http.StatusBadGateway, Message: "Printer host resolved to no addresses."}
	}
	unique := make(map[string]net.IP)
	for _, address := range resolved {
		if !isAllowedPrinterIP(address.IP) {
			return nil, forbidden("Printer hostname resolved to a non-private or non-link-local address.")
		}
		unique[address.IP.String()] = address.IP
	}
	addresses := make([]net.IP, 0, len(unique))
	keys := make([]string, 0, len(unique))
	for value := range unique {
		keys = append(keys, value)
	}
	sort.Strings(keys)
	for _, value := range keys {
		addresses = append(addresses, unique[value])
	}
	return addresses, nil
}

func isAllowedPrinterIP(ip net.IP) bool {
	if ip == nil || ip.IsUnspecified() || ip.IsLoopback() || ip.IsMulticast() || isMetadataServiceIP(ip) {
		return false
	}
	return ip.IsPrivate() || ip.IsLinkLocalUnicast()
}

func isMetadataServiceIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	blocked := []net.IP{
		net.ParseIP("169.254.169.254"),
		net.ParseIP("169.254.170.2"),
		net.ParseIP("fd00:ec2::254"),
		net.ParseIP("fe80::a9fe:a9fe"),
		net.ParseIP("fe80::a9fe:aa02"),
	}
	for _, candidate := range blocked {
		if ip.Equal(candidate) {
			return true
		}
	}
	return false
}

func bytesToLatin1String(value []byte) string {
	runes := make([]rune, len(value))
	for index, item := range value {
		runes[index] = rune(item)
	}
	return string(runes)
}
