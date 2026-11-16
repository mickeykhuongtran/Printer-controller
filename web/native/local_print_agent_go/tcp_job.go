package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxTCPJobSequence       = 9_007_199_254_740_990
	maxTCPJobBytes          = int64(1024 * 1024 * 1024)
	maxTCPJobControlReserve = int64(64 * 1024)
	maxActiveTCPJobs        = 10
	maxRetainedTCPJobRecord = 512
	tcpJobTerminalRetention = time.Hour
)

type tcpJobRequest struct {
	WindowLabels       int                    `json:"windowLabels,omitempty"`
	Production         *productionRollRequest `json:"production,omitempty"`
	Capture            *rfidCaptureOptions    `json:"capture,omitempty"`
	HistoryOffset      int                    `json:"historyOffset,omitempty"`
	Confirmed          bool                   `json:"confirmed"`
	ReconciliationNote string                 `json:"reconciliationNote"`
	Action             string                 `json:"action"`
	JobID              string                 `json:"jobId"`
	Host               string                 `json:"host"`
	Port               *float64               `json:"port"`
	ConnectTimeoutMS   *float64               `json:"connectTimeoutMs"`
	WriteTimeoutMS     *float64               `json:"writeTimeoutMs"`
	IdleTimeoutMS      *float64               `json:"idleTimeoutMs"`
	Sequence           *float64               `json:"sequence"`
	PayloadBase64      *string                `json:"payloadBase64"`
	PayloadSHA256      string                 `json:"payloadSha256"`
	ExpectedSequence   *float64               `json:"expectedSequence"`
	ExpectedBytes      *float64               `json:"expectedBytes"`
	CheckpointHash     string                 `json:"checkpointHash"`
	ReadWindowMS       *float64               `json:"readWindowMs"`
	ReadIdleMS         *float64               `json:"readIdleMs"`
}

type tcpJobResult struct {
	CounterFinishRecoverable bool                `json:"counterFinishRecoverable,omitempty"`
	ServiceFault             string              `json:"serviceFault,omitempty"`
	FaultClearRequested      bool                `json:"faultClearRequested,omitempty"`
	Capture                  *rfidCaptureSummary `json:"capture,omitempty"`
	Host                     string              `json:"host"`
	Port                     int                 `json:"port"`
	Reconciled               bool                `json:"reconciled,omitempty"`
	ReconciliationNote       string              `json:"reconciliationNote,omitempty"`
	OK                       bool                `json:"ok"`
	JobID                    string              `json:"jobId"`
	State                    string              `json:"state"`
	NextSequence             int                 `json:"nextSequence"`
	CumulativeBytes          int64               `json:"cumulativeBytes"`
	BytesWritten             int                 `json:"bytesWritten,omitempty"`
	PayloadSHA256            string              `json:"payloadSha256,omitempty"`
	CheckpointHash           string              `json:"checkpointHash"`
	Deduplicated             bool                `json:"deduplicated,omitempty"`
	ResolvedAddress          string              `json:"resolvedAddress,omitempty"`
	Response                 string              `json:"response,omitempty"`
}

type tcpJobReceipt struct {
	sequence      int
	payloadSHA256 string
	payloadBytes  int
	checkpoint    string
}

type tcpJobDialFunc func(
	context.Context,
	string,
	int,
	time.Duration,
) (net.Conn, string, error)

type tcpJobManager struct {
	spoolWorkers      sync.WaitGroup
	spoolMu           sync.Mutex
	spools            map[string]*fleetSpool
	captureDir        string
	mu                sync.Mutex
	jobs              map[string]*tcpJobSession
	dial              tcpJobDialFunc
	maxActive         int
	maxRecords        int
	terminalRetention time.Duration
	printerQueues     *printerTargetQueue
	monitorInterval   time.Duration
	monitorTimeout    time.Duration
	lifetime          context.Context
	stop              context.CancelFunc
	closed            bool
}

type tcpJobSession struct {
	sealedTransportFailure bool
	serviceFault           string
	serviceFaultAt         string
	faultClearRequested    bool
	cancelled              bool
	capture                *rfidCapture
	captureOptions         *rfidCaptureOptions
	reservation            *printerQueueReservation
	mu                     sync.Mutex
	reconciled             bool
	reconciliationNote     string

	managerKey      string
	owner           string
	jobID           string
	host            string
	port            int
	resolvedAddress string
	writeTimeout    time.Duration
	idleTimeout     time.Duration
	state           string
	conn            net.Conn
	nextSequence    int
	cumulativeBytes int64
	checkpointHash  string
	receipts        map[int]tcpJobReceipt
	lastActivity    time.Time
	terminalAt      time.Time
	idleTimer       *time.Timer
	openReady       chan struct{}
	monitorCancel   context.CancelFunc
	monitorDone     chan struct{}
	monitorContext  context.Context
}

func newTCPJobManager() *tcpJobManager {
	return newTCPJobManagerWithDialAndQueue(
		dialPersistentTCPJob,
		newPrinterTargetQueue(),
	)
}

func newTCPJobManagerWithQueue(queue *printerTargetQueue) *tcpJobManager {
	return newTCPJobManagerWithDialAndQueue(dialPersistentTCPJob, queue)
}

func newTCPJobManagerWithDialAndQueue(
	dial tcpJobDialFunc,
	queue *printerTargetQueue,
) *tcpJobManager {
	if dial == nil {
		dial = dialPersistentTCPJob
	}
	if queue == nil {
		queue = newPrinterTargetQueue()
	}
	lifetime, stop := context.WithCancel(context.Background())
	return &tcpJobManager{
		jobs:              make(map[string]*tcpJobSession),
		dial:              dial,
		maxActive:         configuredPrinterConcurrency(),
		maxRecords:        maxRetainedTCPJobRecord,
		terminalRetention: tcpJobTerminalRetention,
		printerQueues:     queue,
		monitorInterval:   500 * time.Millisecond,
		monitorTimeout:    2 * time.Second,
		lifetime:          lifetime,
		stop:              stop,
	}
}

func tcpJobOwner(origin string) string {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return "local-native"
	}
	return origin
}

func tcpJobMapKey(owner, jobID string) string {
	return owner + "\x00" + jobID
}

func validTCPJobID(value string) bool {
	value = strings.TrimSpace(value)
	if len(value) < 8 || len(value) > 128 {
		return false
	}
	for index, item := range value {
		if (item >= 'a' && item <= 'z') ||
			(item >= 'A' && item <= 'Z') ||
			(item >= '0' && item <= '9') ||
			(index > 0 && (item == '-' || item == '_' || item == '.' || item == ':')) {
			continue
		}
		return false
	}
	return true
}

func normalizeSHA256(value string) (string, []byte, error) {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if len(normalized) != sha256.Size*2 {
		return "", nil, badRequest("SHA-256 values must contain exactly 64 hexadecimal characters.")
	}
	decoded, err := hex.DecodeString(normalized)
	if err != nil {
		return "", nil, badRequest("SHA-256 values must contain exactly 64 hexadecimal characters.")
	}
	return normalized, decoded, nil
}

// TCP job checkpoint hashing is binary-canonical so Next.js and Go produce
// exactly the same digest:
//
//	H0 = SHA256(UTF8("zbre-tcp-job-v1\0" + jobId))
//	Hn = SHA256(previousRaw32 || sequenceUint64BE ||
//	            payloadSHA256Raw32 || payloadLengthUint64BE)
func tcpJobSeed(jobID string) string {
	sum := sha256.Sum256([]byte("zbre-tcp-job-v1\x00" + jobID))
	return hex.EncodeToString(sum[:])
}

func nextTCPJobCheckpoint(
	previous string,
	sequence int,
	payloadBytes int,
	payloadSHA256 string,
) string {
	previousBytes, _ := hex.DecodeString(previous)
	payloadHashBytes, _ := hex.DecodeString(payloadSHA256)
	canonical := make([]byte, 0, sha256.Size+8+sha256.Size+8)
	canonical = append(canonical, previousBytes...)
	var numeric [8]byte
	binary.BigEndian.PutUint64(numeric[:], uint64(sequence))
	canonical = append(canonical, numeric[:]...)
	canonical = append(canonical, payloadHashBytes...)
	binary.BigEndian.PutUint64(numeric[:], uint64(payloadBytes))
	canonical = append(canonical, numeric[:]...)
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:])
}

func (m *tcpJobManager) cleanupTerminalLocked(now time.Time) {
	for key, session := range m.jobs {
		if !session.mu.TryLock() {
			continue
		}
		remove := (session.reconciled || (session.state != "uncertain" && !(session.state == "expired" && session.cumulativeBytes > 0))) && !session.terminalAt.IsZero() &&
			now.Sub(session.terminalAt) >= m.terminalRetention
		session.mu.Unlock()
		if remove {
			delete(m.jobs, key)
		}
	}
}

func (m *tcpJobManager) activeCountLocked() int {
	count := 0
	for _, session := range m.jobs {
		if !session.mu.TryLock() {
			count++
			continue
		}
		active := session.state == "opening" || session.state == "open"
		session.mu.Unlock()
		if active {
			count++
		}
	}
	return count
}

func (m *tcpJobManager) stats() (active, retained int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cleanupTerminalLocked(time.Now())
	return m.activeCountLocked(), len(m.jobs)
}

func (m *tcpJobManager) open(
	parent context.Context,
	owner string,
	jobID string,
	host string,
	port int,
	connectTimeout time.Duration,
	writeTimeout time.Duration,
	idleTimeout time.Duration,
	captureOptions ...*rfidCaptureOptions,
) (tcpJobResult, error) {
	if err := m.checkSpoolAdmission(owner, jobID, host, port); err != nil {
		return tcpJobResult{}, productionAdmissionError(err)
	}
	// The connector owns socket lifetimes. A browser request may end sooner,
	// but shutdown must also interrupt queued admissions and in-flight dials.
	parent, cancel := context.WithCancel(parent)
	stop := context.AfterFunc(m.lifetime, cancel)
	defer stop()
	defer cancel()
	var capture *rfidCaptureOptions
	if len(captureOptions) > 0 {
		capture = captureOptions[0]
	}
	if err := validateCaptureOptions(capture); err != nil {
		return tcpJobResult{}, err
	}
	if err := validateProductionJobIdentity(m.captureDir, owner, host, port, capture); err != nil {
		return tcpJobResult{}, productionAdmissionError(err)
	}
	key := tcpJobMapKey(owner, jobID)
openAttempt:
	for {
		m.mu.Lock()
		if m.closed {
			m.mu.Unlock()
			return tcpJobResult{}, &apiError{Status: http.StatusServiceUnavailable, Code: "TCP_JOB_MANAGER_CLOSED", Message: "The connector is shutting down; no new print job was opened."}
		}
		m.cleanupTerminalLocked(time.Now())
		if existing := m.jobs[key]; existing != nil {
			existing.mu.Lock()
			sameTarget := existing.host == host && existing.port == port
			if (existing.captureOptions != nil) != (capture != nil) {
				sameTarget = false
			}
			if existing.captureOptions != nil && capture != nil && *existing.captureOptions != *capture {
				sameTarget = false
			}
			ready := existing.openReady
			existing.mu.Unlock()
			m.mu.Unlock()

			if !sameTarget {
				return tcpJobResult{}, jobError(
					existing,
					http.StatusConflict,
					"TCP_JOB_CONFLICT",
					"jobId is already bound to a different printer target.",
					0,
				)
			}
			if ready != nil {
				select {
				case <-ready:
					continue
				case <-parent.Done():
					return tcpJobResult{}, tcpFailure(
						http.StatusGatewayTimeout,
						"Timed out waiting for the existing TCP job to open.",
						"TCP_JOB_OPEN_TIMEOUT",
						"connect",
						0,
						false,
						false,
					)
				}
			}
			existing.mu.Lock()
			if existing.state != "open" {
				err := jobStateErrorLocked(existing, 0)
				existing.mu.Unlock()
				return tcpJobResult{}, err
			}
			result := existing.resultLocked()
			result.Deduplicated = true
			existing.touchLocked()
			existing.mu.Unlock()
			return result, nil
		}
		if len(m.jobs) >= m.maxRecords {
			m.mu.Unlock()
			return tcpJobResult{}, &apiError{
				Status:  http.StatusTooManyRequests,
				Message: "Too many retained TCP job records. Retry after old receipts expire.",
				Code:    "TCP_JOB_RECORD_CAPACITY",
				JobID:   jobID,
			}
		}
		if m.activeCountLocked() >= m.maxActive {
			m.mu.Unlock()
			return tcpJobResult{}, &apiError{
				Status:  http.StatusTooManyRequests,
				Message: "The connector already has the maximum number of active TCP jobs.",
				Code:    "TCP_JOB_CAPACITY",
				JobID:   jobID,
			}
		}
		for _, other := range m.jobs {
			if !strings.EqualFold(other.host, host) || other.port != port {
				continue
			}
			other.mu.Lock()
			sameTarget := strings.EqualFold(other.host, host) && other.port == port
			activeTarget := other.state == "opening" || other.state == "open"
			quarantinedTarget := !other.reconciled && (other.state == "uncertain" ||
				(other.state == "expired" && other.cumulativeBytes > 0))
			canRecoverServiceFault := other.owner == owner && recoverableServiceFault(other.serviceFault) && other.faultClearRequested && other.conn == nil
			other.mu.Unlock()
			if sameTarget && quarantinedTarget {
				m.mu.Unlock()
				if canRecoverServiceFault {
					if err := m.recoverServiceFault(parent, other, connectTimeout); err != nil {
						return tcpJobResult{}, err
					}
					continue openAttempt
				}
				return tcpJobResult{}, &apiError{
					Status:          http.StatusConflict,
					Message:         "This printer target is quarantined after an earlier job had an unknown outcome; reconcile the printed/VOID labels before starting another job.",
					Code:            "TCP_JOB_TARGET_QUARANTINED",
					Stage:           "admission",
					Outcome:         "possibly_sent",
					RetrySafety:     "unsafe",
					WriteStarted:    false,
					WriteCompleted:  false,
					JobID:           jobID,
					CheckpointState: "uncertain",
				}
			}
			if sameTarget && activeTarget {
				m.mu.Unlock()
				return tcpJobResult{}, &apiError{
					Status:         http.StatusTooManyRequests,
					Message:        "Another persistent TCP job already owns this printer target; queue the logical job and retry after it finishes.",
					Code:           "TCP_JOB_TARGET_BUSY",
					Stage:          "admission",
					Outcome:        "not_sent",
					RetrySafety:    "safe",
					WriteStarted:   false,
					WriteCompleted: false,
					JobID:          jobID,
				}
			}
		}
		session := &tcpJobSession{
			captureOptions: capture,
			managerKey:     key,
			owner:          owner,
			jobID:          jobID,
			host:           host,
			port:           port,
			writeTimeout:   writeTimeout,
			idleTimeout:    idleTimeout,
			state:          "opening",
			nextSequence:   1,
			checkpointHash: tcpJobSeed(jobID),
			receipts:       make(map[int]tcpJobReceipt),
			lastActivity:   time.Now(),
			openReady:      make(chan struct{}),
		}
		reservation, reserveErr := m.printerQueues.reserve(tcpPrinterTargetKey(host, port))
		if reserveErr != nil {
			m.mu.Unlock()
			return tcpJobResult{}, reserveErr
		}
		session.reservation = reservation
		m.jobs[key] = session
		m.mu.Unlock()

		var connection net.Conn
		var resolvedAddress string
		var err error
		select {
		case <-session.reservation.ready:
			// A preceding queued operation may have bound a roll after the
			// initial preflight. Recheck while owning this endpoint's slot.
			err = productionAdmissionError(validateProductionJobIdentity(m.captureDir, owner, host, port, capture))
			if err == nil {
				connection, resolvedAddress, err = m.dial(parent, host, port, connectTimeout)
			}
		case <-parent.Done():
			err = parent.Err()
		}
		session.mu.Lock()
		if session.state != "opening" {
			if connection != nil {
				_ = connection.Close()
			}
			err = &apiError{Status: http.StatusServiceUnavailable, Code: "TCP_JOB_MANAGER_CLOSED", Message: "The connector stopped while opening this print job."}
		}
		if err == nil && capture != nil {
			session.capture, err = newRfidCapture(m.captureDir, owner, jobID, host, port, *capture)
			if err == nil {
				err = session.capture.enableCounterLifecycle()
			}
			if err != nil {
				// Capture registration precedes all socket writes, including label data.
				err = productionAdmissionError(err)
				_ = connection.Close()
			} else {
				go session.capture.readLoop(connection)
			}
		}
		if err == nil {
			session.conn = connection
			session.resolvedAddress = resolvedAddress
			session.state = "open"
			session.lastActivity = time.Now()
			session.armIdleTimerLocked()
		}
		ready := session.openReady
		session.openReady = nil
		if ready != nil {
			close(ready)
		}
		result := session.resultLocked()
		session.mu.Unlock()

		if err != nil {
			session.reservation.release()
			m.mu.Lock()
			if m.jobs[key] == session {
				delete(m.jobs, key)
			}
			m.mu.Unlock()
			return tcpJobResult{}, err
		}
		return result, nil
	}
}

func (m *tcpJobManager) lookup(owner, jobID string) (*tcpJobSession, error) {
	key := tcpJobMapKey(owner, jobID)
	m.mu.Lock()
	m.cleanupTerminalLocked(time.Now())
	session := m.jobs[key]
	m.mu.Unlock()
	if session == nil {
		return nil, &apiError{
			Status:  http.StatusNotFound,
			Message: "TCP job was not found. Do not recreate it after an append had an unknown outcome.",
			Code:    "TCP_JOB_NOT_FOUND",
			JobID:   jobID,
		}
	}
	session.mu.Lock()
	ready := session.openReady
	session.mu.Unlock()
	if ready != nil {
		return nil, &apiError{
			Status:   http.StatusConflict,
			Message:  "TCP job is still opening.",
			Code:     "TCP_JOB_OPENING",
			JobID:    jobID,
			JobState: "opening",
		}
	}
	return session, nil
}

func (m *tcpJobManager) append(
	owner string,
	jobID string,
	sequence int,
	payload []byte,
	payloadSHA256 string,
) (tcpJobResult, error) {
	return m.appendContext(
		context.Background(),
		owner,
		jobID,
		sequence,
		payload,
		payloadSHA256,
	)
}

func (m *tcpJobManager) appendContext(
	ctx context.Context,
	owner string,
	jobID string,
	sequence int,
	payload []byte,
	payloadSHA256 string,
) (tcpJobResult, error) {
	session, err := m.lookup(owner, jobID)
	if err != nil {
		return tcpJobResult{}, err
	}

	normalizedHash, suppliedDigest, err := normalizeSHA256(payloadSHA256)
	if err != nil {
		return tcpJobResult{}, err
	}
	actualDigest := sha256.Sum256(payload)
	if subtle.ConstantTimeCompare(suppliedDigest, actualDigest[:]) != 1 {
		return tcpJobResult{}, jobError(
			session,
			http.StatusBadRequest,
			"TCP_JOB_HASH_MISMATCH",
			"payloadSha256 does not match the decoded payload.",
			sequence,
		)
	}

	if ctx.Err() != nil {
		return tcpJobResult{}, ctx.Err()
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	if receipt, exists := session.receipts[sequence]; exists {
		if receipt.payloadSHA256 != normalizedHash || receipt.payloadBytes != len(payload) {
			return tcpJobResult{}, jobErrorLocked(
				session,
				http.StatusConflict,
				"TCP_JOB_CHECKPOINT_CONFLICT",
				"That sequence was already committed with a different payload.",
				sequence,
			)
		}
		result := session.resultLocked()
		result.BytesWritten = receipt.payloadBytes
		result.PayloadSHA256 = receipt.payloadSHA256
		result.Deduplicated = true
		session.touchLocked()
		return result, nil
	}
	if session.state != "open" {
		return tcpJobResult{}, jobStateErrorLocked(session, sequence)
	}
	if session.serviceFault != "" {
		return tcpJobResult{}, jobErrorLocked(session, http.StatusConflict, "TCP_JOB_SERVICE_FAULT", "A media/ribbon/head fault stopped this run. No further label payload is allowed; abort and reconcile the stopped run.", sequence)
	}
	if session.capture != nil && strings.TrimSpace(string(payload)) != "~JA" {
		snapshot := session.capture.snapshot()
		if snapshot.Options.AuditBatchCounters && snapshot.Audit.LifecycleVersion == 0 && !snapshot.Audit.Baseline.complete() {
			return tcpJobResult{}, jobErrorLocked(session, http.StatusConflict, "RFID_BASELINE_REQUIRED", "Read the printer counters before sending any label payload.", sequence)
		}
		if snapshot.Error != "" {
			return tcpJobResult{}, session.markUncertainLocked(sequence, 0, false, "RFID evidence could not be saved: "+snapshot.Error, "RFID_CAPTURE_FAILED")
		}
	}
	if sequence < session.nextSequence {
		return tcpJobResult{}, jobErrorLocked(
			session,
			http.StatusConflict,
			"TCP_JOB_CHECKPOINT_MISSING",
			"The sequence is older than nextSequence but no committed receipt exists.",
			sequence,
		)
	}
	if sequence > session.nextSequence {
		return tcpJobResult{}, jobErrorLocked(
			session,
			http.StatusConflict,
			"TCP_JOB_SEQUENCE_GAP",
			fmt.Sprintf(
				"Expected sequence %d, received sequence %d.",
				session.nextSequence,
				sequence,
			),
			sequence,
		)
	}
	if sequence < 1 || sequence > maxTCPJobSequence {
		return tcpJobResult{}, jobErrorLocked(
			session,
			http.StatusBadRequest,
			"TCP_JOB_SEQUENCE_INVALID",
			fmt.Sprintf("sequence must be between 1 and %d.", maxTCPJobSequence),
			sequence,
		)
	}
	byteLimit := maxTCPJobBytes
	if len(payload) <= 64 && strings.TrimSpace(string(payload)) == "~JA" {
		byteLimit += maxTCPJobControlReserve
	}
	if session.cumulativeBytes+int64(len(payload)) > byteLimit {
		return tcpJobResult{}, jobErrorLocked(
			session,
			http.StatusRequestEntityTooLarge,
			"TCP_JOB_BYTE_CAPACITY",
			fmt.Sprintf(
				"Persistent TCP job exceeds the %d-byte cumulative limit.",
				maxTCPJobBytes,
			),
			sequence,
		)
	}

	session.lastActivity = time.Now()
	if session.conn == nil {
		return tcpJobResult{}, session.markUncertainLocked(
			sequence,
			0,
			false,
			"TCP job has no active printer socket.",
			"TCP_JOB_SOCKET_LOST",
		)
	}
	if strings.TrimSpace(string(payload)) != "~JA" {
		if err := session.ensureCounterBaselineLocked(); err != nil {
			return tcpJobResult{}, err
		}
	}
	if session.lifecycleEnabled() {
		c := session.capture
		c.mu.Lock()
		c.invalidateCounterFinalityLocked()
		err := c.saveLocked()
		if err != nil {
			c.failLocked(err)
		}
		c.mu.Unlock()
		if err != nil {
			return tcpJobResult{}, session.markUncertainLocked(sequence, 0, false, err.Error(), "RFID_CAPTURE_STORE_FAILED")
		}
	}
	written := 0
	for written < len(payload) {
		// Treat writeTimeout as an idle/progress timeout rather than one fixed
		// deadline for the whole chunk. A Zebra applying TCP backpressure may
		// drain slowly while still making valid forward progress.
		if err := session.conn.SetWriteDeadline(time.Now().Add(session.writeTimeout)); err != nil {
			return tcpJobResult{}, session.markUncertainLocked(
				sequence,
				written,
				written > 0,
				"Could not set the persistent printer write timeout.",
				"TCP_JOB_WRITE_FAILED",
			)
		}
		count, writeErr := session.conn.Write(payload[written:])
		written += count
		if writeErr != nil {
			code := "TCP_JOB_WRITE_FAILED"
			status := http.StatusBadGateway
			if timeout, ok := writeErr.(net.Error); ok && timeout.Timeout() {
				code = "TCP_JOB_WRITE_TIMEOUT"
				status = http.StatusGatewayTimeout
			}
			return tcpJobResult{}, session.markUncertainWithStatusLocked(
				sequence,
				written,
				true,
				fmt.Sprintf(
					"Persistent TCP job write failed after %d bytes: %v.",
					written,
					writeErr,
				),
				code,
				status,
			)
		}
		if count == 0 {
			return tcpJobResult{}, session.markUncertainLocked(
				sequence,
				written,
				true,
				"Persistent printer socket accepted zero bytes.",
				"TCP_JOB_WRITE_ZERO",
			)
		}
	}
	_ = session.conn.SetWriteDeadline(time.Time{})

	checkpoint := nextTCPJobCheckpoint(
		session.checkpointHash,
		sequence,
		len(payload),
		normalizedHash,
	)
	session.receipts[sequence] = tcpJobReceipt{
		sequence:      sequence,
		payloadSHA256: normalizedHash,
		payloadBytes:  len(payload),
		checkpoint:    checkpoint,
	}
	session.nextSequence++
	session.cumulativeBytes += int64(len(payload))
	session.checkpointHash = checkpoint
	if session.capture != nil {
		session.capture.submitted(sequence, payload)
		if snapshot := session.capture.snapshot(); snapshot.Error != "" {
			return tcpJobResult{}, session.markUncertainLocked(sequence, len(payload), true, snapshot.Error, "RFID_CAPTURE_STORE_FAILED")
		}
	}
	if len(payload) <= 64 && strings.TrimSpace(string(payload)) == "~JA" {
		session.cancelled = true
	}
	session.touchLocked()
	m.startMonitorLocked(session)

	result := session.resultLocked()
	result.BytesWritten = len(payload)
	result.PayloadSHA256 = normalizedHash
	return result, nil
}

func (m *tcpJobManager) queryContext(
	ctx context.Context,
	owner string,
	jobID string,
	payload []byte,
	readWindow time.Duration,
	readIdle time.Duration,
) (tcpJobResult, error) {
	session, err := m.lookup(owner, jobID)
	if err != nil {
		return tcpJobResult{}, err
	}
	if ctx.Err() != nil {
		return tcpJobResult{}, ctx.Err()
	}

	session.mu.Lock()
	defer session.mu.Unlock()
	return session.queryLocked(ctx, payload, readWindow, readIdle, true)
}

// The monitor and HTTP requests share one command lock and one response reader.
// Background observations must not extend an abandoned owner's idle lease.
func (session *tcpJobSession) queryLocked(ctx context.Context, payload []byte, readWindow, readIdle time.Duration, ownerActivity bool) (tcpJobResult, error) {
	if ctx.Err() != nil {
		return tcpJobResult{}, ctx.Err()
	}
	if session.state != "open" {
		return tcpJobResult{}, jobStateErrorLocked(session, 0)
	}
	if session.conn == nil {
		return tcpJobResult{}, session.markUncertainLocked(
			0, 0, false,
			"TCP job has no active printer socket for status query.",
			"TCP_JOB_SOCKET_LOST",
		)
	}

	if session.capture != nil {
		command := strings.TrimSpace(string(payload))
		if command != "~HS" && command != "~HQES" && rfidCounterName(command) == "" {
			return tcpJobResult{}, badRequest("Capture sessions only accept ~HS or ~HQES queries.")
		}
		if err := session.capture.beginQuery(); err != nil {
			return tcpJobResult{}, session.markUncertainLocked(0, 0, false, err.Error(), "RFID_CAPTURE_FAILED")
		}
	}
	written := 0
	for written < len(payload) {
		deadline := time.Now().Add(session.writeTimeout)
		if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
			deadline = ctxDeadline
		}
		if err := session.conn.SetWriteDeadline(deadline); err != nil {
			return tcpJobResult{}, session.markUncertainLocked(
				0, written, written > 0,
				"Could not set the Zebra status-query write timeout.",
				"TCP_JOB_QUERY_WRITE_FAILED",
			)
		}
		count, writeErr := session.conn.Write(payload[written:])
		written += count
		if writeErr != nil || count == 0 {
			message := "Persistent Zebra status query accepted zero bytes."
			code := "TCP_JOB_QUERY_WRITE_ZERO"
			status := http.StatusBadGateway
			if writeErr != nil {
				message = fmt.Sprintf(
					"Persistent Zebra status query failed after %d bytes: %v.",
					written,
					writeErr,
				)
				code = "TCP_JOB_QUERY_WRITE_FAILED"
				if timeout, ok := writeErr.(net.Error); ok && timeout.Timeout() {
					code = "TCP_JOB_QUERY_WRITE_TIMEOUT"
					status = http.StatusGatewayTimeout
				}
			}
			return tcpJobResult{}, session.markUncertainWithStatusLocked(
				0, written, true, message, code, status,
			)
		}
	}
	_ = session.conn.SetWriteDeadline(time.Time{})

	if session.capture != nil {
		response, err := session.capture.readQuery(ctx, string(payload), readWindow)
		if err != nil {
			return tcpJobResult{}, session.markUncertainLocked(0, written, true, err.Error(), "RFID_CAPTURE_QUERY_FAILED")
		}
		if err := session.capture.recordCounter(string(payload), response, session.cumulativeBytes, session.nextSequence-1); err != nil {
			return tcpJobResult{}, session.markUncertainLocked(0, written, true, err.Error(), "RFID_COUNTER_FAILED")
		}
		if err := session.latchServiceFaultLocked(string(payload), response); err != nil {
			return tcpJobResult{}, err
		}
		if ownerActivity {
			session.touchLocked()
		}
		result := session.resultLocked()
		result.BytesWritten = written
		result.Response = response
		return result, nil
	}
	windowDeadline := time.Now().Add(readWindow)
	response := bytes.NewBuffer(make([]byte, 0, 4096))
	buffer := make([]byte, 32*1024)
	receivedAny := false
	for {
		deadline := windowDeadline
		if receivedAny {
			idleDeadline := time.Now().Add(readIdle)
			if idleDeadline.Before(deadline) {
				deadline = idleDeadline
			}
		}
		if ctxDeadline, ok := ctx.Deadline(); ok && ctxDeadline.Before(deadline) {
			deadline = ctxDeadline
		}
		if err := session.conn.SetReadDeadline(deadline); err != nil {
			// net.Pipe and some socket implementations report a peer close from
			// SetReadDeadline before the following Read can return io.EOF. Once
			// response bytes exist this is equivalent to EOF-after-data: return
			// those bytes and let the command-specific parser validate completeness.
			if receivedAny && (errors.Is(err, io.ErrClosedPipe) || errors.Is(err, net.ErrClosed)) {
				break
			}
			return tcpJobResult{}, session.markUncertainLocked(
				0, written, true,
				"Could not set the Zebra status-query read timeout.",
				"TCP_JOB_QUERY_READ_FAILED",
			)
		}
		count, readErr := session.conn.Read(buffer)
		if count > 0 {
			receivedAny = true
			if response.Len()+count > maxTCPResponseBytes {
				return tcpJobResult{}, session.markUncertainLocked(
					0, written, true,
					fmt.Sprintf("Zebra status response exceeded %d bytes.", maxTCPResponseBytes),
					"TCP_JOB_QUERY_RESPONSE_TOO_LARGE",
				)
			}
			_, _ = response.Write(buffer[:count])
			if completeZebraStatusResponse(string(payload), response.String()) {
				break
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) && receivedAny {
				break
			}
			if timeout, ok := readErr.(net.Error); ok && timeout.Timeout() {
				if receivedAny {
					break
				}
				return tcpJobResult{}, session.markUncertainWithStatusLocked(
					0, written, true,
					"Zebra printer did not return status before the query timeout.",
					"TCP_JOB_QUERY_TIMEOUT",
					http.StatusGatewayTimeout,
				)
			}
			return tcpJobResult{}, session.markUncertainLocked(
				0, written, true,
				fmt.Sprintf("Could not read Zebra status: %v.", readErr),
				"TCP_JOB_QUERY_READ_FAILED",
			)
		}
	}
	_ = session.conn.SetReadDeadline(time.Time{})
	if err := session.latchServiceFaultLocked(string(payload), response.String()); err != nil {
		return tcpJobResult{}, err
	}
	if ownerActivity {
		session.touchLocked()
	}
	result := session.resultLocked()
	result.BytesWritten = written
	result.Response = bytesToLatin1String(response.Bytes())
	return result, nil
}

func (m *tcpJobManager) poll(owner, jobID string) (tcpJobResult, error) {
	session, err := m.lookup(owner, jobID)
	if err != nil {
		return tcpJobResult{}, err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	session.touchLocked()
	return session.resultLocked(), nil
}

// expectedSequence is the final committed sequence number N, not nextSequence.
func (m *tcpJobManager) finish(
	owner string,
	jobID string,
	expectedSequence int,
	expectedBytes int64,
	checkpointHash string,
) (tcpJobResult, error) {
	session, err := m.lookup(owner, jobID)
	if err != nil {
		return tcpJobResult{}, err
	}
	normalizedCheckpoint, _, err := normalizeSHA256(checkpointHash)
	if err != nil {
		return tcpJobResult{}, err
	}

	session.mu.Lock()
	defer session.mu.Unlock()
	if session.serviceFault != "" {
		return tcpJobResult{}, jobErrorLocked(session, http.StatusConflict, "TCP_JOB_SERVICE_FAULT", "A service fault stopped this run. It cannot finish or resume; abort and reconcile its printed labels.", expectedSequence)
	}
	if session.state == "finished" {
		if session.nextSequence != expectedSequence+1 ||
			session.cumulativeBytes != expectedBytes ||
			session.checkpointHash != normalizedCheckpoint {
			return tcpJobResult{}, jobErrorLocked(
				session,
				http.StatusConflict,
				"TCP_JOB_FINISH_CONFLICT",
				"The completed job receipt does not match this finish request.",
				expectedSequence,
			)
		}
		result := session.resultLocked()
		result.Deduplicated = true
		return result, nil
	}
	if session.state != "open" && !session.canRecoverSealedTransportLocked() {
		return tcpJobResult{}, jobStateErrorLocked(session, expectedSequence)
	}
	if session.nextSequence != expectedSequence+1 {
		return tcpJobResult{}, jobErrorLocked(
			session,
			http.StatusConflict,
			"TCP_JOB_INCOMPLETE",
			fmt.Sprintf(
				"Finish expected final sequence %d, but nextSequence is %d.",
				expectedSequence,
				session.nextSequence,
			),
			expectedSequence,
		)
	}
	if session.cumulativeBytes != expectedBytes {
		return tcpJobResult{}, jobErrorLocked(
			session,
			http.StatusConflict,
			"TCP_JOB_BYTE_COUNT_CONFLICT",
			fmt.Sprintf(
				"Finish expected %d bytes, but the job committed %d bytes.",
				expectedBytes,
				session.cumulativeBytes,
			),
			expectedSequence,
		)
	}
	if session.checkpointHash != normalizedCheckpoint {
		return tcpJobResult{}, jobErrorLocked(
			session,
			http.StatusConflict,
			"TCP_JOB_CHECKPOINT_CONFLICT",
			"Finish checkpointHash does not match the committed checkpoint chain.",
			expectedSequence,
		)
	}
	if session.canRecoverSealedTransportLocked() {
		if err := session.capture.finishSealedTransportReceipt(); err != nil {
			return tcpJobResult{}, session.markUncertainLocked(0, 0, false, err.Error(), "RFID_CAPTURE_STORE_FAILED")
		}
	}

	if session.lifecycleEnabled() && !session.cancelled {
		if err := session.finalizeCounterLifecycleLocked(rfidCounterFinishTimeout); err != nil {
			if session.state != "open" {
				return tcpJobResult{}, jobStateErrorLocked(session, expectedSequence)
			}
			if session.serviceFault != "" {
				_, _ = session.abortLocked()
				return tcpJobResult{}, jobStateErrorLocked(session, expectedSequence)
			}
			if session.capture.snapshot().Audit.FinalizationReason != "counter_reset" {
				return tcpJobResult{}, session.markUncertainLocked(0, 0, false, err.Error(), "TCP_JOB_QUERY_FINALIZATION_FAILED")
			}
		}
	}
	session.stopIdleTimerLocked()
	session.stopMonitorLocked()
	if tcpConnection, ok := session.conn.(*net.TCPConn); ok {
		_ = tcpConnection.CloseWrite()
	}
	if session.capture != nil {
		captureState := "finished"
		if session.cancelled {
			captureState = "cancelled"
		}
		if err := session.capture.close(session.conn, captureState); err != nil {
			return tcpJobResult{}, session.markUncertainLocked(0, 0, true, err.Error(), "RFID_CAPTURE_STORE_FAILED")
		}
		// Readback quality is evidence, not a print interlock. The caller has
		// drained the printer; keep incomplete/duplicate reads in the durable
		// report and release the session so the operator can print a top-up.
	}
	if session.conn != nil {
		if session.capture != nil {
			_ = session.capture.close(session.conn, "interrupted")
		}
		_ = session.conn.Close()
		session.conn = nil
	}
	if session.reservation != nil {
		session.reservation.release()
	}
	session.state = "finished"
	session.terminalAt = time.Now()
	return session.resultLocked(), nil
}

func (m *tcpJobManager) abort(owner, jobID string) (tcpJobResult, error) {
	session, err := m.lookup(owner, jobID)
	if err != nil {
		return tcpJobResult{}, err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.abortLocked()
}

func (session *tcpJobSession) abortLocked() (tcpJobResult, error) {
	if session.state == "aborted" || session.state == "uncertain" ||
		session.state == "expired" || session.state == "failed" {
		result := session.resultLocked()
		result.Deduplicated = true
		return result, nil
	}
	if session.state == "finished" {
		return tcpJobResult{}, jobErrorLocked(
			session,
			http.StatusConflict,
			"TCP_JOB_ALREADY_FINISHED",
			"A finished TCP job cannot be aborted.",
			0,
		)
	}
	// A foreground service-fault handler may abort before the monitor's next
	// tick. Both paths must seal the stopped run on this original connection.
	session.reconcileFaultCountersLocked()
	session.stopIdleTimerLocked()
	session.stopMonitorLocked()
	if session.conn != nil {
		if session.capture != nil {
			_ = session.capture.close(session.conn, "interrupted")
		}
		_ = session.conn.Close()
		session.conn = nil
	}
	if session.nextSequence > 1 {
		// Bytes already committed to the printer cannot be withdrawn. Preserve
		// the forensic state as uncertain instead of implying a clean abort.
		session.state = "uncertain"
	} else {
		session.state = "aborted"
		if session.reservation != nil {
			session.reservation.release()
		}
	}
	session.terminalAt = time.Now()
	return session.resultLocked(), nil
}

// Reconciliation records the operator's physical audit without replaying bytes,
// erasing receipts, or reopening the stopped job. Only future jobs are admitted.
func (m *tcpJobManager) reconcile(owner, jobID string, sequence int, expectedBytes int64, checkpoint, note string) (tcpJobResult, error) {
	session, err := m.lookup(owner, jobID)
	if err != nil {
		return tcpJobResult{}, err
	}
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.state != "uncertain" && session.state != "expired" && session.state != "failed" && session.state != "aborted" {
		return tcpJobResult{}, jobErrorLocked(session, http.StatusConflict, "TCP_JOB_RECONCILE_STATE", "Only a stopped TCP job can be reconciled.", 0)
	}
	if sequence != session.nextSequence-1 || expectedBytes != session.cumulativeBytes || checkpoint != session.checkpointHash {
		return tcpJobResult{}, jobErrorLocked(session, http.StatusConflict, "TCP_JOB_RECONCILE_CHECKPOINT", "Reconciliation checkpoint changed; read the job again before confirming.", 0)
	}
	if !session.reconciled {
		session.reconciled = true
		session.reconciliationNote = note
		if session.reservation != nil {
			session.reservation.release()
		}
	}
	return session.resultLocked(), nil
}

func (m *tcpJobManager) close() {
	m.mu.Lock()
	m.closed = true
	m.stop()
	sessions := make([]*tcpJobSession, 0, len(m.jobs))
	for _, session := range m.jobs {
		sessions = append(sessions, session)
	}
	m.mu.Unlock()
	for _, session := range sessions {
		session.mu.Lock()
		session.stopIdleTimerLocked()
		session.stopMonitorLocked()
		if session.state == "open" && session.cumulativeBytes > 0 && session.conn != nil && session.serviceFault == "" {
			session.requestFaultClearLocked("Connector shutdown interrupted the print session")
		}
		if session.conn != nil {
			if session.capture != nil {
				_ = session.capture.close(session.conn, "interrupted")
			}
			_ = session.conn.Close()
			session.conn = nil
		}
		if session.state == "open" || session.state == "opening" {
			session.state = "aborted"
			session.terminalAt = time.Now()
		}
		session.mu.Unlock()
	}
	for _, session := range sessions {
		if session.monitorDone != nil {
			<-session.monitorDone
		}
	}
	m.spoolWorkers.Wait()
}

func (session *tcpJobSession) resultLocked() tcpJobResult {
	var capture *rfidCaptureSummary
	if session.capture != nil {
		capture = session.capture.snapshot()
	}
	return tcpJobResult{
		CounterFinishRecoverable: session.canRecoverSealedTransportLocked(),
		ServiceFault:             session.serviceFault,
		FaultClearRequested:      session.faultClearRequested,
		Capture:                  capture,
		Host:                     session.host,
		Port:                     session.port,
		Reconciled:               session.reconciled,
		ReconciliationNote:       session.reconciliationNote,
		OK:                       true,
		JobID:                    session.jobID,
		State:                    session.state,
		NextSequence:             session.nextSequence,
		CumulativeBytes:          session.cumulativeBytes,
		CheckpointHash:           session.checkpointHash,
		ResolvedAddress:          session.resolvedAddress,
	}
}

func (session *tcpJobSession) stopIdleTimerLocked() {
	if session.idleTimer != nil {
		session.idleTimer.Stop()
		session.idleTimer = nil
	}
}

func (session *tcpJobSession) armIdleTimerLocked() {
	session.stopIdleTimerLocked()
	if session.state != "open" || session.idleTimeout <= 0 {
		return
	}
	session.idleTimer = time.AfterFunc(session.idleTimeout, session.expireIfIdle)
}

func (session *tcpJobSession) touchLocked() {
	if session.state != "open" {
		return
	}
	session.lastActivity = time.Now()
	session.armIdleTimerLocked()
}

func (session *tcpJobSession) expireIfIdle() {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.state != "open" {
		return
	}
	remaining := session.idleTimeout - time.Since(session.lastActivity)
	if remaining > 0 {
		session.stopIdleTimerLocked()
		session.idleTimer = time.AfterFunc(remaining, session.expireIfIdle)
		return
	}
	if session.conn != nil {
		sealed := session.capture != nil && hasFinalRfidCounterSnapshot(*session.capture.snapshot())
		if session.cumulativeBytes > 0 && session.serviceFault == "" && !sealed {
			session.requestFaultClearLocked("Host print session idle timeout")
		}
		if session.capture != nil {
			if !sealed {
				session.capture.unresolvedCounter("idle_expired", "The host session expired before a normal finish. Prior counter samples and EPCs are retained.")
			}
			_ = session.capture.close(session.conn, "interrupted")
		}
		_ = session.conn.Close()
		session.conn = nil
	}
	session.state = "expired"
	session.stopMonitorLocked()
	if session.cumulativeBytes == 0 && session.reservation != nil {
		session.reservation.release()
	}
	session.terminalAt = time.Now()
	session.idleTimer = nil
}

func (session *tcpJobSession) markUncertainLocked(
	sequence int,
	bytesWritten int,
	writeStarted bool,
	message string,
	code string,
) error {
	return session.markUncertainWithStatusLocked(
		sequence,
		bytesWritten,
		writeStarted,
		message,
		code,
		http.StatusBadGateway,
	)
}

func (session *tcpJobSession) markUncertainWithStatusLocked(
	sequence int,
	bytesWritten int,
	writeStarted bool,
	message string,
	code string,
	status int,
) error {
	session.stopIdleTimerLocked()
	session.stopMonitorLocked()
	if session.capture != nil {
		s := session.capture.snapshot()
		if s.Audit.FinalizationStatus != "unresolved" && !hasFinalRfidCounterSnapshot(*s) {
			session.capture.unresolvedCounter(strings.ToLower(code), message)
		}
	}
	// Losing status or durable RFID evidence must not leave accepted formats
	// printing after the collector disconnects. An ordinary VOID is a recorded
	// outcome, not an evidence failure, and never reaches this branch.
	evidenceFailure := code == "RFID_CAPTURE_FAILED" || code == "RFID_CAPTURE_STORE_FAILED" || code == "RFID_COUNTER_FAILED"
	sealedCounters := session.capture != nil && hasFinalRfidCounterSnapshot(*session.capture.snapshot())
	recoverableTransport := sealedCounters && sealedCounterQueryTransportCode(code) && session.serviceFault == "" && !session.cancelled && session.capture.sealedCounterFinishSafe()
	if !sealedCounters && session.serviceFault == "" && session.cumulativeBytes > 0 && session.conn != nil &&
		(strings.HasPrefix(code, "TCP_JOB_QUERY_") || code == "RFID_CAPTURE_QUERY_FAILED" || evidenceFailure) {
		reason := "Printer status unavailable after label submission"
		if evidenceFailure {
			reason = "RFID evidence unavailable after label submission"
		}
		if session.requestFaultClearLocked(reason) {
			message += " Pause and buffer clear were requested on the same socket; physical completion remains unverified."
		} else {
			message += " Pause/buffer clear could not be confirmed; keep the printer paused and clear it physically."
		}
	}
	if session.conn != nil {
		if session.capture != nil {
			_ = session.capture.close(session.conn, "interrupted")
		}
		_ = session.conn.Close()
		session.conn = nil
	}
	session.state = "uncertain"
	session.sealedTransportFailure = recoverableTransport && session.capture.sealedCounterFinishSafe()
	session.terminalAt = time.Now()
	return &apiError{
		ServiceFault:        session.serviceFault,
		FaultClearRequested: session.faultClearRequested,
		Status:              status,
		Message:             message,
		Code:                code,
		Stage:               "write",
		Outcome:             "possibly_sent",
		RetrySafety:         "unsafe",
		BytesWritten:        bytesWritten,
		WriteStarted:        writeStarted,
		WriteCompleted:      false,
		JobID:               session.jobID,
		Sequence:            sequence,
		JobState:            session.state,
		NextSequence:        session.nextSequence,
		CheckpointState:     "uncertain",
		CheckpointHash:      session.checkpointHash,
	}
}

func jobStateErrorLocked(session *tcpJobSession, sequence int) error {
	if recoverableServiceFault(session.serviceFault) {
		return jobErrorLocked(session, http.StatusConflict, "TCP_JOB_SERVICE_FAULT", "Printer run stopped: "+session.serviceFault+". Start a new run only after the printer is repaired and its queue is cleared.", sequence)
	}
	status := http.StatusConflict
	code := "TCP_JOB_NOT_OPEN"
	message := fmt.Sprintf("TCP job is %s and cannot accept this action.", session.state)
	if session.state == "expired" {
		status = http.StatusGone
		code = "TCP_JOB_EXPIRED"
	}
	if session.state == "uncertain" {
		code = "TCP_JOB_UNCERTAIN"
		message = "TCP job has an uncertain write outcome. Do not resend; reconcile the affected labels first."
	}
	return jobErrorLocked(session, status, code, message, sequence)
}

func jobError(
	session *tcpJobSession,
	status int,
	code string,
	message string,
	sequence int,
) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	return jobErrorLocked(session, status, code, message, sequence)
}

func jobErrorLocked(
	session *tcpJobSession,
	status int,
	code string,
	message string,
	sequence int,
) error {
	outcome := "not_sent"
	retrySafety := "safe"
	checkpointState := "not_committed"
	if session.state == "uncertain" ||
		(session.state == "expired" && session.cumulativeBytes > 0) {
		outcome = "possibly_sent"
		retrySafety = "unsafe"
		checkpointState = "uncertain"
	}
	return &apiError{
		ServiceFault:        session.serviceFault,
		FaultClearRequested: session.faultClearRequested,
		Status:              status,
		Message:             message,
		Code:                code,
		JobID:               session.jobID,
		Sequence:            sequence,
		JobState:            session.state,
		NextSequence:        session.nextSequence,
		Outcome:             outcome,
		RetrySafety:         retrySafety,
		CheckpointState:     checkpointState,
		CheckpointHash:      session.checkpointHash,
	}
}

func numberAsInt64(
	value *float64,
	minimum int64,
	maximum int64,
	field string,
) (int64, error) {
	if value == nil {
		return 0, badRequest("%s is required.", field)
	}
	if *value != float64(int64(*value)) {
		return 0, badRequest("%s must be an integer.", field)
	}
	numeric := int64(*value)
	if numeric < minimum || numeric > maximum {
		return 0, badRequest(
			"%s must be between %d and %d.",
			field,
			minimum,
			maximum,
		)
	}
	return numeric, nil
}

func (s *appServer) handleTCPJob(
	writer http.ResponseWriter,
	request *http.Request,
	origin string,
) error {
	var body tcpJobRequest
	if err := decodeJSON(writer, request, &body); err != nil {
		return err
	}
	action := strings.ToLower(strings.TrimSpace(body.Action))
	body.Action = action
	if strings.HasPrefix(action, "spool-") {
		return s.handleFleetSpool(writer, request, tcpJobOwner(origin), body)
	}
	if strings.HasPrefix(action, "roll-") {
		return s.tcpJobs.handleProductionRoll(writer, request, tcpJobOwner(origin), body)
	}
	if action == "capture-list" || action == "capture-export" {
		if action == "capture-export" && !validTCPJobID(body.JobID) {
			return badRequest("Invalid capture job ID.")
		}
		return s.tcpJobs.handleCaptureHistory(writer, request, tcpJobOwner(origin), body)
	}
	jobID := strings.TrimSpace(body.JobID)
	if !validTCPJobID(jobID) {
		return badRequest("jobId must be 8-128 characters using letters, digits, '.', '_', ':' or '-'.")
	}
	owner := tcpJobOwner(origin)

	switch action {
	case "open":
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
		connectTimeoutMS, err := numberAsInt(
			body.ConnectTimeoutMS,
			5_000,
			500,
			30_000,
			"connectTimeoutMs",
		)
		if err != nil {
			return err
		}
		writeTimeoutMS, err := numberAsInt(
			body.WriteTimeoutMS,
			30_000,
			500,
			120_000,
			"writeTimeoutMs",
		)
		if err != nil {
			return err
		}
		idleTimeoutMS, err := numberAsInt(
			body.IdleTimeoutMS,
			300_000,
			30_000,
			1_800_000,
			"idleTimeoutMs",
		)
		if err != nil {
			return err
		}
		operationContext, cancel := context.WithTimeout(
			context.Background(),
			time.Duration(connectTimeoutMS+4_000)*time.Millisecond,
		)
		defer cancel()
		result, err := s.tcpJobs.open(
			operationContext,
			owner,
			jobID,
			host,
			port,
			time.Duration(connectTimeoutMS)*time.Millisecond,
			time.Duration(writeTimeoutMS)*time.Millisecond,
			time.Duration(idleTimeoutMS)*time.Millisecond,
			body.Capture,
		)
		if err != nil {
			return err
		}
		s.writeJSON(writer, http.StatusOK, result)
		return nil

	case "append":
		sequence, err := numberAsInt(
			body.Sequence,
			0,
			1,
			maxTCPJobSequence,
			"sequence",
		)
		if err != nil {
			return err
		}
		if body.PayloadBase64 == nil {
			return badRequest("payloadBase64 is required for append.")
		}
		payload, err := decodeBase64Payload(strings.TrimSpace(*body.PayloadBase64))
		if err != nil {
			return err
		}
		result, err := s.tcpJobs.appendContext(
			request.Context(),
			owner,
			jobID,
			sequence,
			payload,
			body.PayloadSHA256,
		)
		if err != nil {
			return err
		}
		s.writeJSON(writer, http.StatusOK, result)
		return nil

	case "query":
		if body.PayloadBase64 == nil {
			return badRequest("payloadBase64 is required for query.")
		}
		payload, err := decodeBase64Payload(strings.TrimSpace(*body.PayloadBase64))
		if err != nil {
			return err
		}
		queryText := strings.TrimSpace(strings.ReplaceAll(
			strings.ReplaceAll(string(payload), "\r\n", "\n"),
			"\r", "\n",
		))
		if queryText != `! U1 getvar "zpl.system_status"` &&
			queryText != "~HQES" && queryText != "~HS" && rfidCounterName(queryText) == "" {
			return badRequest("Persistent TCP query only accepts Zebra status commands.")
		}
		readWindowMS, err := numberAsInt(
			body.ReadWindowMS, 8_000, 250, 30_000, "readWindowMs",
		)
		if err != nil {
			return err
		}
		readIdleMS, err := numberAsInt(
			body.ReadIdleMS, 300, 25, readWindowMS, "readIdleMs",
		)
		if err != nil {
			return err
		}
		result, err := s.tcpJobs.queryContext(
			request.Context(),
			owner,
			jobID,
			payload,
			time.Duration(readWindowMS)*time.Millisecond,
			time.Duration(readIdleMS)*time.Millisecond,
		)
		if err != nil {
			return err
		}
		s.writeJSON(writer, http.StatusOK, result)
		return nil

	case "poll":
		result, err := s.tcpJobs.poll(owner, jobID)
		if err != nil {
			return err
		}
		s.writeJSON(writer, http.StatusOK, result)
		return nil

	case "finish":
		expectedSequence, err := numberAsInt(
			body.ExpectedSequence,
			0,
			1,
			maxTCPJobSequence,
			"expectedSequence",
		)
		if err != nil {
			return err
		}
		expectedBytes, err := numberAsInt64(
			body.ExpectedBytes,
			1,
			maxTCPJobBytes+maxTCPJobControlReserve,
			"expectedBytes",
		)
		if err != nil {
			return err
		}
		result, err := s.tcpJobs.finish(
			owner,
			jobID,
			expectedSequence,
			expectedBytes,
			body.CheckpointHash,
		)
		if err != nil {
			return err
		}
		s.writeJSON(writer, http.StatusOK, result)
		return nil

	case "abort":
		result, err := s.tcpJobs.abort(owner, jobID)
		if err != nil {
			return err
		}
		s.writeJSON(writer, http.StatusOK, result)
		return nil

	case "reconcile":
		if !body.Confirmed || len(strings.TrimSpace(body.ReconciliationNote)) < 8 || len(body.ReconciliationNote) > 2000 {
			return badRequest("Confirm physical label/EPC reconciliation and provide a note (8-2000 characters).")
		}
		sequence, err := numberAsInt(body.ExpectedSequence, -1, 0, maxTCPJobSequence, "expectedSequence")
		if err != nil {
			return err
		}
		expectedBytes, err := numberAsInt64(body.ExpectedBytes, 0, maxTCPJobBytes+maxTCPJobControlReserve, "expectedBytes")
		if err != nil {
			return err
		}
		result, err := s.tcpJobs.reconcile(owner, jobID, sequence, expectedBytes, body.CheckpointHash, strings.TrimSpace(body.ReconciliationNote))
		if err != nil {
			return err
		}
		s.writeJSON(writer, http.StatusOK, result)
		return nil

	default:
		return badRequest("action must be open, append, query, poll, finish, abort, or reconcile.")
	}
}

func dialPersistentTCPJob(
	parent context.Context,
	host string,
	port int,
	connectTimeout time.Duration,
) (net.Conn, string, error) {
	addresses, err := resolveAllowedPrinterAddresses(parent, host)
	if err != nil {
		return nil, "", wrapTCPResolveFailure(err)
	}
	connectContext, cancel := context.WithTimeout(parent, connectTimeout)
	defer cancel()

	var dialErrors []string
	var lastDialError error
	dialer := net.Dialer{Timeout: connectTimeout, KeepAlive: 5 * time.Second}
	for _, ip := range addresses {
		address := net.JoinHostPort(ip.String(), strconv.Itoa(port))
		connection, dialErr := dialer.DialContext(connectContext, "tcp", address)
		if dialErr == nil {
			if tcpConnection, ok := connection.(*net.TCPConn); ok {
				_ = tcpConnection.SetNoDelay(true)
				_ = tcpConnection.SetKeepAlive(true)
				_ = tcpConnection.SetKeepAlivePeriod(5 * time.Second)
			}
			return connection, ip.String(), nil
		}
		lastDialError = dialErr
		dialErrors = append(dialErrors, dialErr.Error())
		if connectContext.Err() != nil {
			break
		}
	}

	lastDialTimedOut := false
	if networkError, ok := lastDialError.(net.Error); ok {
		lastDialTimedOut = networkError.Timeout()
	}
	if errors.Is(connectContext.Err(), context.DeadlineExceeded) || lastDialTimedOut {
		return nil, "", tcpFailure(
			http.StatusGatewayTimeout,
			fmt.Sprintf("TCP connect timeout to %s:%d.", host, port),
			"TCP_CONNECT_TIMEOUT",
			"connect",
			0,
			false,
			false,
		)
	}
	return nil, "", tcpFailure(
		http.StatusBadGateway,
		fmt.Sprintf(
			"Could not connect to printer %s:%d (%s).",
			host,
			port,
			strings.Join(dialErrors, "; "),
		),
		"TCP_CONNECT_FAILED",
		"connect",
		0,
		false,
		false,
	)
}
