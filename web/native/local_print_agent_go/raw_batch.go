package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"regexp"
	"sync"
	"time"
)

const rawBatchIdleTimeout = 30 * time.Minute

var rawBatchIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)

type rawBatchReceipt struct {
	payloadHash string
	result      RawPrintResult
}

type rawBatchSession struct {
	mu           sync.Mutex
	ready        chan struct{}
	operation    chan struct{}
	initialError error
	target       string
	printerName  string
	release      func()
	state        string
	nextSequence int
	receipts     map[int]rawBatchReceipt
	expiresAt    time.Time
	active       bool
}

// rawBatchManager retains one printer-queue lease across every Windows RAW
// chunk in a logical batch. This prevents independent browser/app clients from
// interleaving A1,B1,A2,B2 spool documents on the same physical queue.
// Receipts are retained for the idle window so a lost HTTP response can be
// replayed with the same batch/sequence without submitting the chunk twice.
type rawBatchManager struct {
	mu      sync.Mutex
	batches map[string]*rawBatchSession
	queues  *printerTargetQueue
}

func newRawBatchManager(queues *printerTargetQueue) *rawBatchManager {
	return &rawBatchManager{
		batches: make(map[string]*rawBatchSession),
		queues:  queues,
	}
}

func rawPayloadHash(payload []byte) string {
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func rawBatchError(status int, code, message, batchID, state string, sequence, nextSequence int) error {
	return &apiError{
		Status:       status,
		Code:         code,
		Message:      message,
		Stage:        "admission",
		JobID:        batchID,
		Sequence:     sequence,
		JobState:     state,
		NextSequence: nextSequence,
		Outcome:      "not_sent",
		RetrySafety:  "safe",
	}
}

func (m *rawBatchManager) getOrOpen(
	ctx context.Context,
	batchID string,
	target string,
	printerName string,
) (*rawBatchSession, error) {
	m.mu.Lock()
	session := m.batches[batchID]
	created := session == nil
	if created {
		session = &rawBatchSession{
			ready:        make(chan struct{}),
			operation:    make(chan struct{}, 1),
			target:       target,
			printerName:  printerName,
			state:        "opening",
			nextSequence: 1,
			receipts:     make(map[int]rawBatchReceipt),
		}
		session.operation <- struct{}{}
		m.batches[batchID] = session
	}
	m.mu.Unlock()

	if created {
		release, err := m.queues.acquire(ctx, target)
		session.mu.Lock()
		if err != nil {
			session.initialError = err
			session.state = "failed"
		} else {
			session.release = release
			session.state = "open"
			session.expiresAt = time.Now().Add(rawBatchIdleTimeout)
		}
		close(session.ready)
		session.mu.Unlock()
		if err != nil {
			m.mu.Lock()
			if m.batches[batchID] == session {
				delete(m.batches, batchID)
			}
			m.mu.Unlock()
			return nil, err
		}
		m.scheduleExpiry(batchID, session)
	} else {
		select {
		case <-session.ready:
		case <-ctx.Done():
			return nil, rawBatchError(
				http.StatusRequestTimeout,
				"RAW_BATCH_WAIT_CANCELLED",
				"RAW batch wait was cancelled before any bytes were sent.",
				batchID,
				"opening",
				0,
				0,
			)
		}
	}

	session.mu.Lock()
	defer session.mu.Unlock()
	if session.initialError != nil {
		return nil, session.initialError
	}
	if session.target != target || session.printerName != printerName {
		return nil, rawBatchError(
			http.StatusConflict,
			"RAW_BATCH_TARGET_CONFLICT",
			"batchId is already bound to a different Windows printer target.",
			batchID,
			session.state,
			0,
			session.nextSequence,
		)
	}
	return session, nil
}

func (m *rawBatchManager) submit(
	ctx context.Context,
	batchID string,
	target string,
	printerName string,
	sequence int,
	finalChunk bool,
	payload []byte,
	spool func() (RawPrintResult, error),
) (RawPrintResult, error) {
	if !rawBatchIDPattern.MatchString(batchID) {
		return RawPrintResult{}, badRequest("batchId must be 8-128 URL-safe characters.")
	}
	if sequence < 1 {
		return RawPrintResult{}, badRequest("sequence must be a positive integer for a RAW batch.")
	}
	session, err := m.getOrOpen(ctx, batchID, target, printerName)
	if err != nil {
		return RawPrintResult{}, err
	}

	select {
	case <-session.operation:
		defer func() { session.operation <- struct{}{} }()
	case <-ctx.Done():
		return RawPrintResult{}, rawBatchError(
			http.StatusRequestTimeout,
			"RAW_BATCH_OPERATION_CANCELLED",
			"RAW batch operation was cancelled before any bytes were sent.",
			batchID,
			"open",
			sequence,
			0,
		)
	}

	payloadHash := rawPayloadHash(payload)
	session.mu.Lock()
	if cached, ok := session.receipts[sequence]; ok {
		if cached.payloadHash != payloadHash {
			next := session.nextSequence
			state := session.state
			session.mu.Unlock()
			return RawPrintResult{}, rawBatchError(
				http.StatusConflict,
				"RAW_BATCH_SEQUENCE_PAYLOAD_CONFLICT",
				"The RAW batch sequence was already accepted with a different payload.",
				batchID,
				state,
				sequence,
				next,
			)
		}
		result := cached.result
		result.Deduplicated = true
		session.mu.Unlock()
		return result, nil
	}
	if session.state != "open" {
		next := session.nextSequence
		state := session.state
		session.mu.Unlock()
		return RawPrintResult{}, rawBatchError(
			http.StatusConflict,
			"RAW_BATCH_TERMINAL",
			"RAW batch is terminal; only an already accepted sequence can be replayed.",
			batchID,
			state,
			sequence,
			next,
		)
	}
	if sequence != session.nextSequence {
		next := session.nextSequence
		session.mu.Unlock()
		return RawPrintResult{}, rawBatchError(
			http.StatusConflict,
			"RAW_BATCH_SEQUENCE_CONFLICT",
			"RAW batch sequence does not match the next checkpoint.",
			batchID,
			"open",
			sequence,
			next,
		)
	}
	session.active = true
	session.expiresAt = time.Now().Add(rawBatchIdleTimeout)
	session.mu.Unlock()

	result, spoolErr := spool()

	session.mu.Lock()
	session.active = false
	if spoolErr != nil {
		var apiErr *apiError
		if errors.As(spoolErr, &apiErr) {
			if apiErr.Outcome == "possibly_sent" {
				// Keep the target lease quarantined for the idle window. A partial
				// RAW/ZPL stream can otherwise consume the beginning of the next job.
				session.state = "uncertain"
			}
			apiErr.JobID = batchID
			apiErr.Sequence = sequence
			apiErr.JobState = session.state
			apiErr.NextSequence = session.nextSequence
			apiErr.CheckpointHash = payloadHash
		}
		session.expiresAt = time.Now().Add(rawBatchIdleTimeout)
		session.mu.Unlock()
		return RawPrintResult{}, spoolErr
	}

	result.BatchID = batchID
	result.Sequence = sequence
	result.NextSequence = sequence + 1
	result.FinalChunk = finalChunk
	result.PayloadSHA256 = payloadHash
	result.Deduplicated = false
	result.BatchState = "open"
	if finalChunk {
		result.BatchState = "finished"
	}
	session.receipts[sequence] = rawBatchReceipt{
		payloadHash: payloadHash,
		result:      result,
	}
	session.nextSequence++
	session.expiresAt = time.Now().Add(rawBatchIdleTimeout)
	var release func()
	if finalChunk {
		session.state = "finished"
		release = session.release
		session.release = nil
	}
	session.mu.Unlock()
	if release != nil {
		release()
	}
	return result, nil
}

func (m *rawBatchManager) scheduleExpiry(batchID string, session *rawBatchSession) {
	time.AfterFunc(rawBatchIdleTimeout, func() {
		m.expire(batchID, session)
	})
}

func (m *rawBatchManager) expire(batchID string, session *rawBatchSession) {
	m.mu.Lock()
	if m.batches[batchID] != session {
		m.mu.Unlock()
		return
	}
	session.mu.Lock()
	now := time.Now()
	if session.active || now.Before(session.expiresAt) {
		delay := time.Until(session.expiresAt)
		if delay < time.Second {
			delay = time.Second
		}
		session.mu.Unlock()
		m.mu.Unlock()
		time.AfterFunc(delay, func() { m.expire(batchID, session) })
		return
	}
	var release func()
	if session.release != nil {
		release = session.release
		session.release = nil
	}
	if session.state == "open" || session.state == "uncertain" {
		session.state = "expired"
		session.expiresAt = now.Add(rawBatchIdleTimeout)
		session.mu.Unlock()
		m.mu.Unlock()
		if release != nil {
			release()
		}
		time.AfterFunc(rawBatchIdleTimeout, func() { m.expire(batchID, session) })
		return
	}
	delete(m.batches, batchID)
	session.mu.Unlock()
	m.mu.Unlock()
	if release != nil {
		release()
	}
}

func (m *rawBatchManager) stats() (open, uncertain, retained int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, session := range m.batches {
		session.mu.Lock()
		switch session.state {
		case "opening", "open":
			open++
		case "uncertain":
			uncertain++
		default:
			retained++
		}
		session.mu.Unlock()
	}
	return open, uncertain, retained
}
