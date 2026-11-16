package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	rawSpoolStoreVersion           = 1
	maxRawSpoolLabels              = 9_007_199_254_740_991
	maxRawSpoolBatchBytes    int64 = 1024 * 1024 * 1024
	maxRawSpoolStoredBytes   int64 = 2 * 1024 * 1024 * 1024
	maxRawSpoolStoredBatches       = 1000
	maxRawSpoolActiveBatches       = 64
)

type rawSpoolChunk struct {
	Sequence   int    `json:"sequence"`
	LabelCount int    `json:"labelCount"`
	Bytes      int64  `json:"bytes"`
	SHA256     string `json:"sha256"`
}

type rawSpoolManifest struct {
	Version          int             `json:"version"`
	Owner            string          `json:"owner"`
	Ordinal          uint64          `json:"ordinal"`
	BatchID          string          `json:"batchId"`
	PrinterName      string          `json:"printerName"`
	DocumentName     string          `json:"documentName"`
	TotalLabels      int             `json:"totalLabels"`
	State            string          `json:"state"`
	Chunks           []rawSpoolChunk `json:"chunks"`
	StagedBytes      int64           `json:"stagedBytes"`
	StagedLabels     int             `json:"stagedLabels"`
	PayloadSHA256    string          `json:"payloadSha256,omitempty"`
	JobID            *uint32         `json:"jobId"`
	Error            string          `json:"error,omitempty"`
	RecoveryRequired bool            `json:"recoveryRequired,omitempty"`
	Reconciliation   string          `json:"reconciliation,omitempty"`
	Archived         bool            `json:"archived,omitempty"`
	ArchivedChunks   int             `json:"archivedChunks,omitempty"`
	CreatedAt        string          `json:"createdAt"`
	UpdatedAt        string          `json:"updatedAt"`
}

type rawSpoolBatchResult struct {
	OK               bool          `json:"ok"`
	BatchID          string        `json:"batchId"`
	PrinterName      string        `json:"printerName"`
	DocumentName     string        `json:"documentName"`
	State            string        `json:"state"`
	NextSequence     int           `json:"nextSequence"`
	TotalChunks      int           `json:"totalChunks"`
	StagedBytes      int64         `json:"stagedBytes"`
	StagedLabels     int           `json:"stagedLabels"`
	TotalLabels      int           `json:"totalLabels"`
	JobID            *uint32       `json:"jobId"`
	PayloadSHA256    string        `json:"payloadSha256,omitempty"`
	Error            string        `json:"error,omitempty"`
	RecoveryRequired bool          `json:"recoveryRequired,omitempty"`
	Reconciliation   string        `json:"reconciliation,omitempty"`
	Archived         bool          `json:"archived,omitempty"`
	CreatedAt        string        `json:"createdAt"`
	UpdatedAt        string        `json:"updatedAt"`
	SpoolStatus      *RawJobStatus `json:"spoolStatus,omitempty"`
}

type rawSpoolBatch struct {
	manifest    rawSpoolManifest
	reservation *printerQueueReservation
	running     bool
}

type rawFileSpooler func(string, string, string, func(uint32) error) (RawPrintResult, error)
type rawJobInspector func(string, uint32) (RawJobStatus, error)

// Every accepted begin gets a durable ordinal and a shared printer-queue
// reservation. File upload never prints. A committed worker owns its job
// independently of HTTP/browser lifetime; ambiguous work retains its lease.
type rawSpoolBatchManager struct {
	mu          sync.Mutex
	dir         string
	batches     map[string]*rawSpoolBatch
	queues      *printerTargetQueue
	nextOrdinal uint64
	spool       rawFileSpooler
	inspect     rawJobInspector
	fault       error
	closed      bool
	done        chan struct{}
	workers     sync.WaitGroup
	unlockStore func() error
}

func newRawSpoolBatchManager(dir string, queues *printerTargetQueue, spool rawFileSpooler, inspect rawJobInspector) *rawSpoolBatchManager {
	m := &rawSpoolBatchManager{dir: dir, batches: make(map[string]*rawSpoolBatch), queues: queues, spool: spool, inspect: inspect, done: make(chan struct{})}
	if strings.TrimSpace(dir) == "" {
		m.fault = errors.New("RAW spool state directory is not configured")
		return m
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		m.fault = err
		return m
	}
	if err := syncRawSpoolDirectory(filepath.Dir(dir)); err != nil {
		m.fault = err
		return m
	}
	unlock, err := lockRawSpoolStore(filepath.Join(dir, "store.lock"))
	if err != nil {
		m.fault = err
		return m
	}
	m.unlockStore = unlock
	if err = m.load(); err != nil {
		m.fault = fmt.Errorf("RAW spool recovery failed; printing is disabled: %w", err)
	}
	return m
}

func rawSpoolConflict(message string) error {
	return &apiError{Status: 409, Code: "RAW_SPOOL_BATCH_CONFLICT", Message: message}
}

func (m *rawSpoolBatchManager) availableLocked() error {
	if m.closed {
		return &apiError{Status: 503, Code: "RAW_SPOOL_STORE_CLOSED", Message: "RAW spool store is closed."}
	}
	if m.fault != nil {
		return &apiError{Status: 503, Code: "RAW_SPOOL_STORE_UNHEALTHY", Message: m.fault.Error()}
	}
	return nil
}

func (m *rawSpoolBatchManager) availability() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.availableLocked()
}

func (m *rawSpoolBatchManager) failLocked(err error) error {
	m.fault = fmt.Errorf("RAW spool storage failure; printing disabled until recovery: %w", err)
	return m.availableLocked()
}

func (m *rawSpoolBatchManager) directory(id string) string { return filepath.Join(m.dir, id) }
func (m *rawSpoolBatchManager) payloadPath(id string) string {
	return filepath.Join(m.directory(id), "payload.zpl")
}
func (m *rawSpoolBatchManager) chunkPath(id string, sequence int) string {
	return filepath.Join(m.directory(id), fmt.Sprintf("chunk-%06d.zpl", sequence))
}

func rawSpoolDocumentName(document, id string) string { return document + " [NW:" + id + "]" }

func writeRawSpoolAtomic(path string, data []byte) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".write-*.tmp")
	if err != nil {
		return err
	}
	temp := file.Name()
	defer os.Remove(temp)
	if err = file.Chmod(0600); err == nil {
		_, err = file.Write(data)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return durableReplaceRawSpoolFile(temp, path)
}

func (m *rawSpoolBatchManager) saveLocked(batch *rawSpoolBatch) error {
	batch.manifest.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	data, err := json.MarshalIndent(batch.manifest, "", "  ")
	if err != nil {
		return err
	}
	return writeRawSpoolAtomic(filepath.Join(m.directory(batch.manifest.BatchID), "manifest.json"), append(data, '\n'))
}

func rawSpoolTerminal(state string) bool {
	return state == "spool-accepted" || state == "cancelled" || state == "failed"
}

func (m *rawSpoolBatchManager) resultLocked(b *rawSpoolBatch) rawSpoolBatchResult {
	s := b.manifest
	chunks := len(s.Chunks)
	if s.Archived {
		chunks = s.ArchivedChunks
	}
	var jobID *uint32
	if s.JobID != nil {
		v := *s.JobID
		jobID = &v
	}
	return rawSpoolBatchResult{OK: true, BatchID: s.BatchID, PrinterName: s.PrinterName, DocumentName: s.DocumentName, State: s.State, NextSequence: chunks + 1, TotalChunks: chunks, StagedBytes: s.StagedBytes, StagedLabels: s.StagedLabels, TotalLabels: s.TotalLabels, JobID: jobID, PayloadSHA256: s.PayloadSHA256, Error: s.Error, RecoveryRequired: s.RecoveryRequired, Reconciliation: s.Reconciliation, Archived: s.Archived, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt}
}

func (m *rawSpoolBatchManager) lookupLocked(owner, id string) (*rawSpoolBatch, error) {
	if err := m.availableLocked(); err != nil {
		return nil, err
	}
	b := m.batches[id]
	if b == nil || b.manifest.Owner != owner {
		return nil, &apiError{Status: 404, Code: "RAW_SPOOL_BATCH_NOT_FOUND", Message: "RAW spool batch not found for this owner."}
	}
	return b, nil
}

func (m *rawSpoolBatchManager) begin(owner, id, printer, document string, totalLabels int) (rawSpoolBatchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.availableLocked(); err != nil {
		return rawSpoolBatchResult{}, err
	}
	if !rawBatchIDPattern.MatchString(id) || totalLabels < 1 || totalLabels > maxRawSpoolLabels {
		return rawSpoolBatchResult{}, badRequest("batchId must be 8-128 URL-safe characters; totalLabels must be a positive safe integer.")
	}
	if strings.TrimSpace(printer) == "" || strings.ContainsRune(printer, '\x00') || strings.ContainsRune(document, '\x00') {
		return rawSpoolBatchResult{}, badRequest("A valid Windows printer and document name are required.")
	}
	if existing := m.batches[id]; existing != nil {
		if existing.manifest.Owner != owner {
			return rawSpoolBatchResult{}, forbidden("batchId belongs to a different owner.")
		}
		s := existing.manifest
		if s.PrinterName != printer || s.DocumentName != document || s.TotalLabels != totalLabels {
			return rawSpoolBatchResult{}, rawSpoolConflict("batchId is already bound to different batch metadata.")
		}
		return m.resultLocked(existing), nil
	}
	active, detailed := 0, 0
	for _, b := range m.batches {
		if !b.manifest.Archived {
			detailed++
		}
		if !rawSpoolTerminal(b.manifest.State) {
			active++
		}
	}
	if active >= maxRawSpoolActiveBatches || detailed >= maxRawSpoolStoredBatches {
		return rawSpoolBatchResult{}, &apiError{Status: 429, Code: "RAW_SPOOL_STORE_FULL", Message: "RAW spool batch capacity reached; reconcile unfinished batches or archive completed manifests before accepting more."}
	}
	reservation, err := m.queues.reserve(spoolPrinterTargetKey(printer))
	if err != nil {
		return rawSpoolBatchResult{}, err
	}
	if err := os.Mkdir(m.directory(id), 0700); err != nil {
		reservation.release()
		return rawSpoolBatchResult{}, m.failLocked(err)
	}
	if err := syncRawSpoolDirectory(m.dir); err != nil {
		reservation.release()
		return rawSpoolBatchResult{}, m.failLocked(err)
	}
	m.nextOrdinal++
	now := time.Now().UTC().Format(time.RFC3339Nano)
	b := &rawSpoolBatch{manifest: rawSpoolManifest{Version: rawSpoolStoreVersion, Owner: owner, Ordinal: m.nextOrdinal, BatchID: id, PrinterName: printer, DocumentName: document, TotalLabels: totalLabels, State: "staging", Chunks: []rawSpoolChunk{}, CreatedAt: now, UpdatedAt: now}, reservation: reservation}
	if err = m.saveLocked(b); err != nil {
		reservation.release()
		return rawSpoolBatchResult{}, m.failLocked(err)
	}
	m.batches[id] = b
	return m.resultLocked(b), nil
}

func (m *rawSpoolBatchManager) append(owner, id string, sequence, labelCount int, payload []byte) (rawSpoolBatchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := m.lookupLocked(owner, id)
	if err != nil {
		return rawSpoolBatchResult{}, err
	}
	if sequence < 1 || labelCount < 1 || len(payload) == 0 || len(payload) > maxPayloadBytes {
		return rawSpoolBatchResult{}, badRequest("append requires sequence >= 1, labelCount >= 1, and a nonempty bounded payload.")
	}
	hash := rawPayloadHash(payload)
	if sequence <= len(b.manifest.Chunks) {
		old := b.manifest.Chunks[sequence-1]
		if old.SHA256 != hash || old.Bytes != int64(len(payload)) || old.LabelCount != labelCount {
			return rawSpoolBatchResult{}, rawSpoolConflict("An accepted sequence was replayed with different payload or labelCount.")
		}
		return m.resultLocked(b), nil
	}
	if b.manifest.State != "staging" || sequence != len(b.manifest.Chunks)+1 {
		return rawSpoolBatchResult{}, rawSpoolConflict("Batch is not staging or sequence is not the next checkpoint.")
	}
	if b.manifest.StagedLabels+labelCount > b.manifest.TotalLabels {
		return rawSpoolBatchResult{}, badRequest("append exceeds the reserved totalLabels.")
	}
	stored := int64(0)
	for _, other := range m.batches {
		if !rawSpoolTerminal(other.manifest.State) {
			stored += other.manifest.StagedBytes
		}
	}
	if b.manifest.StagedBytes+int64(len(payload)) > maxRawSpoolBatchBytes || stored+int64(len(payload)) > maxRawSpoolStoredBytes {
		return rawSpoolBatchResult{}, &apiError{Status: 413, Code: "RAW_SPOOL_DISK_QUOTA", Message: "Staging exceeds the 1 GiB batch or 2 GiB active-payload quota (up to twice that space is needed while assembling)."}
	}
	chunkPath := m.chunkPath(id, sequence)
	// Existing uncommitted files after a crash must never be overwritten.
	if _, statErr := os.Lstat(chunkPath); !os.IsNotExist(statErr) {
		return rawSpoolBatchResult{}, m.failLocked(fmt.Errorf("uncommitted chunk already exists: %s", chunkPath))
	}
	if err = writeRawSpoolAtomic(chunkPath, payload); err != nil {
		return rawSpoolBatchResult{}, m.failLocked(err)
	}
	b.manifest.Chunks = append(b.manifest.Chunks, rawSpoolChunk{Sequence: sequence, LabelCount: labelCount, Bytes: int64(len(payload)), SHA256: hash})
	b.manifest.StagedLabels += labelCount
	b.manifest.StagedBytes += int64(len(payload))
	if err = m.saveLocked(b); err != nil {
		return rawSpoolBatchResult{}, m.failLocked(err)
	}
	return m.resultLocked(b), nil
}

func hashRawSpoolFile(path string) (int64, string, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return 0, "", err
	}
	if !info.Mode().IsRegular() {
		return 0, "", fmt.Errorf("staging data is not a regular file: %s", path)
	}
	f, err := os.Open(path)
	if err != nil {
		return 0, "", err
	}
	defer f.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, f)
	return size, hex.EncodeToString(hash.Sum(nil)), err
}

func (m *rawSpoolBatchManager) assembleLocked(b *rawSpoolBatch) error {
	id := b.manifest.BatchID
	output, err := os.CreateTemp(m.directory(id), ".assemble-*.tmp")
	if err != nil {
		return err
	}
	temp := output.Name()
	defer os.Remove(temp)
	hash := sha256.New()
	destination := io.MultiWriter(output, hash)
	for _, chunk := range b.manifest.Chunks {
		path := m.chunkPath(id, chunk.Sequence)
		size, digest, verifyErr := hashRawSpoolFile(path)
		if verifyErr != nil || size != chunk.Bytes || digest != chunk.SHA256 {
			output.Close()
			return fmt.Errorf("chunk %d failed integrity verification: %v", chunk.Sequence, verifyErr)
		}
		source, openErr := os.Open(path)
		if openErr != nil {
			output.Close()
			return openErr
		}
		_, copyErr := io.Copy(destination, source)
		source.Close()
		if copyErr != nil {
			output.Close()
			return copyErr
		}
	}
	if err = output.Sync(); err != nil {
		output.Close()
		return err
	}
	if err = output.Close(); err != nil {
		return err
	}
	if err = durableReplaceRawSpoolFile(temp, m.payloadPath(id)); err != nil {
		return err
	}
	b.manifest.PayloadSHA256 = hex.EncodeToString(hash.Sum(nil))
	return nil
}

func (m *rawSpoolBatchManager) commit(owner, id string, totalChunks int, totalBytes int64) (rawSpoolBatchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := m.lookupLocked(owner, id)
	if err != nil {
		return rawSpoolBatchResult{}, err
	}
	if totalChunks != len(b.manifest.Chunks) || totalBytes != b.manifest.StagedBytes || b.manifest.StagedLabels != b.manifest.TotalLabels || totalChunks < 1 {
		return rawSpoolBatchResult{}, rawSpoolConflict("commit totals do not match all staged chunks, bytes, and reserved labels.")
	}
	switch b.manifest.State {
	case "spooling", "spool-accepted", "uncertain":
		return m.resultLocked(b), nil
	case "queued":
		if b.running {
			return m.resultLocked(b), nil
		}
	case "staging":
		if err = m.assembleLocked(b); err != nil {
			return rawSpoolBatchResult{}, m.failLocked(err)
		}
	default:
		return rawSpoolBatchResult{}, rawSpoolConflict("This batch cannot be committed again.")
	}
	b.manifest.State = "queued"
	b.manifest.RecoveryRequired = false
	if err = m.saveLocked(b); err != nil {
		return rawSpoolBatchResult{}, m.failLocked(err)
	}
	b.running = true
	m.workers.Add(1)
	go m.run(b)
	return m.resultLocked(b), nil
}

func (m *rawSpoolBatchManager) run(b *rawSpoolBatch) {
	defer m.workers.Done()
	select {
	case <-b.reservation.ready:
	case <-m.done:
		return
	}
	m.mu.Lock()
	if m.closed || m.fault != nil || b.manifest.State != "queued" {
		b.running = false
		m.mu.Unlock()
		return
	}
	size, hash, err := hashRawSpoolFile(m.payloadPath(b.manifest.BatchID))
	if err != nil || size != b.manifest.StagedBytes || hash != b.manifest.PayloadSHA256 {
		m.failLocked(fmt.Errorf("committed payload integrity check failed: %v", err))
		b.running = false
		m.mu.Unlock()
		return
	}
	b.manifest.State = "spooling"
	if err = m.saveLocked(b); err != nil {
		m.failLocked(err)
		b.running = false
		m.mu.Unlock()
		return
	}
	printer, document, path := b.manifest.PrinterName, rawSpoolDocumentName(b.manifest.DocumentName, b.manifest.BatchID), m.payloadPath(b.manifest.BatchID)
	m.mu.Unlock()
	result, spoolErr := m.spool(printer, document, path, func(jobID uint32) error {
		m.mu.Lock()
		defer m.mu.Unlock()
		if m.closed {
			return errors.New("connector is shutting down before RAW data was written")
		}
		b.manifest.JobID = &jobID
		if err := m.saveLocked(b); err != nil {
			return m.failLocked(err)
		}
		return nil
	})
	m.mu.Lock()
	defer m.mu.Unlock()
	b.running = false
	if spoolErr == nil && (!result.OK || int64(result.BytesWritten) != b.manifest.StagedBytes || b.manifest.JobID == nil || *b.manifest.JobID == 0) {
		spoolErr = &apiError{Status: 502, Outcome: "possibly_sent", Message: "RAW spooler returned an incomplete byte/job receipt"}
	}
	if spoolErr != nil {
		b.manifest.Error = spoolErr.Error()
		b.manifest.State = "failed"
		var apiErr *apiError
		if b.manifest.JobID != nil || (errors.As(spoolErr, &apiErr) && apiErr.Outcome == "possibly_sent") {
			b.manifest.State = "uncertain"
		}
	} else {
		b.manifest.State = "spool-accepted"
		b.manifest.Error = ""
	}
	if err = m.saveLocked(b); err != nil {
		b.manifest.State = "uncertain"
		b.manifest.Error = "Final spool receipt could not be persisted; do not reprint."
		m.failLocked(err)
		return
	}
	if rawSpoolTerminal(b.manifest.State) {
		b.reservation.release()
		m.removePayloadLocked(b)
	}
}

func (m *rawSpoolBatchManager) removePayloadLocked(b *rawSpoolBatch) {
	// Only connector-generated regular files beneath this validated batch ID.
	for _, chunk := range b.manifest.Chunks {
		if err := os.Remove(m.chunkPath(b.manifest.BatchID, chunk.Sequence)); err != nil && !os.IsNotExist(err) {
			m.failLocked(err)
		}
	}
	if err := os.Remove(m.payloadPath(b.manifest.BatchID)); err != nil && !os.IsNotExist(err) {
		m.failLocked(err)
	}
	if err := syncRawSpoolDirectory(m.directory(b.manifest.BatchID)); err != nil {
		m.failLocked(err)
	}
}

func (m *rawSpoolBatchManager) status(owner, id string) (rawSpoolBatchResult, error) {
	m.mu.Lock()
	b, err := m.lookupLocked(owner, id)
	if err != nil {
		m.mu.Unlock()
		return rawSpoolBatchResult{}, err
	}
	result := m.resultLocked(b)
	m.mu.Unlock()
	if result.JobID != nil && m.inspect != nil {
		status, inspectErr := m.inspect(result.PrinterName, *result.JobID)
		if inspectErr == nil {
			if status.Exists && status.DocumentName != rawSpoolDocumentName(result.DocumentName, result.BatchID) {
				status.State = "job-id-reused"
				status.StatusText = "Windows job ID now belongs to a different document."
			}
			result.SpoolStatus = &status
		}
	}
	return result, nil
}

func (m *rawSpoolBatchManager) list(owner string) ([]rawSpoolBatchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if err := m.availableLocked(); err != nil {
		return nil, err
	}
	batches := []*rawSpoolBatch{}
	for _, b := range m.batches {
		if b.manifest.Owner == owner && !b.manifest.Archived {
			batches = append(batches, b)
		}
	}
	sort.Slice(batches, func(i, j int) bool { return batches[i].manifest.Ordinal > batches[j].manifest.Ordinal })
	results := make([]rawSpoolBatchResult, 0, len(batches))
	for _, b := range batches {
		results = append(results, m.resultLocked(b))
	}
	return results, nil
}

func (m *rawSpoolBatchManager) cancel(owner, id string) (rawSpoolBatchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := m.lookupLocked(owner, id)
	if err != nil {
		return rawSpoolBatchResult{}, err
	}
	if b.manifest.State == "cancelled" {
		return m.resultLocked(b), nil
	}
	if b.manifest.State != "staging" && b.manifest.State != "queued" && !(b.manifest.State == "failed" && b.manifest.JobID == nil) {
		return rawSpoolBatchResult{}, rawSpoolConflict("Only an unsent staging/queued/failed batch may be cancelled. Inspect and reconcile uncertain work; do not reprint it.")
	}
	b.manifest.State = "cancelled"
	b.manifest.RecoveryRequired = false
	if err = m.saveLocked(b); err != nil {
		return rawSpoolBatchResult{}, m.failLocked(err)
	}
	if b.reservation != nil {
		b.reservation.release()
	}
	m.removePayloadLocked(b)
	return m.resultLocked(b), nil
}

func (m *rawSpoolBatchManager) reconcile(owner, id, resolution string, ack bool) (rawSpoolBatchResult, error) {
	if resolution != "do-not-reprint" || !ack {
		return rawSpoolBatchResult{}, badRequest("Reconciliation requires resolution=do-not-reprint and acknowledgePrinterCleared=true after the operator inspects/clears the old Windows and printer job.")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := m.lookupLocked(owner, id)
	if err != nil {
		return rawSpoolBatchResult{}, err
	}
	if b.manifest.State == "cancelled" && b.manifest.Reconciliation == resolution {
		return m.resultLocked(b), nil
	}
	if b.manifest.State != "uncertain" {
		return rawSpoolBatchResult{}, rawSpoolConflict("Only an uncertain batch can be reconciled.")
	}
	if b.manifest.JobID != nil && m.inspect != nil {
		status, inspectErr := m.inspect(b.manifest.PrinterName, *b.manifest.JobID)
		if inspectErr != nil {
			return rawSpoolBatchResult{}, fmt.Errorf("inspect old Windows job before reconciliation: %w", inspectErr)
		}
		if status.Exists && status.DocumentName == rawSpoolDocumentName(b.manifest.DocumentName, b.manifest.BatchID) && status.State != "spooler_completed" {
			return rawSpoolBatchResult{}, rawSpoolConflict("The old Windows job is still active. Resolve it in the Windows print queue before releasing this printer lane.")
		}
	}
	b.manifest.State = "cancelled"
	b.manifest.Reconciliation = resolution
	b.manifest.RecoveryRequired = false
	b.manifest.Error = "Operator released the lane after inspection; this batch will not be reprinted. Physical completion is not confirmed."
	if err = m.saveLocked(b); err != nil {
		return rawSpoolBatchResult{}, m.failLocked(err)
	}
	b.reservation.release()
	m.removePayloadLocked(b)
	return m.resultLocked(b), nil
}

func (m *rawSpoolBatchManager) stats() (bool, map[string]int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	counts := map[string]int{"staging": 0, "queued": 0, "spooling": 0, "uncertain": 0, "failed": 0}
	for _, b := range m.batches {
		counts[b.manifest.State]++
	}
	return !m.closed && m.fault == nil, counts
}

func (m *rawSpoolBatchManager) archive(owner, id string) (rawSpoolBatchResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	b, err := m.lookupLocked(owner, id)
	if err != nil {
		return rawSpoolBatchResult{}, err
	}
	if !rawSpoolTerminal(b.manifest.State) {
		return rawSpoolBatchResult{}, rawSpoolConflict("Only spool-accepted, cancelled, or definitely-unsent failed batches can be archived.")
	}
	if b.manifest.Archived {
		return m.resultLocked(b), nil
	}
	m.removePayloadLocked(b)
	if err = m.availableLocked(); err != nil {
		return rawSpoolBatchResult{}, err
	}
	b.manifest.Archived = true
	b.manifest.ArchivedChunks = len(b.manifest.Chunks)
	b.manifest.Chunks = nil
	if err = m.saveLocked(b); err != nil {
		return rawSpoolBatchResult{}, m.failLocked(err)
	}
	return m.resultLocked(b), nil
}

func (m *rawSpoolBatchManager) close() {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return
	}
	m.closed = true
	close(m.done)
	m.mu.Unlock()
	m.workers.Wait()
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, b := range m.batches {
		if b.reservation != nil {
			b.reservation.release()
		}
	}
	if m.unlockStore != nil {
		_ = m.unlockStore()
		m.unlockStore = nil
	}
}

func (m *rawSpoolBatchManager) load() error {
	entries, err := os.ReadDir(m.dir)
	if err != nil {
		return err
	}
	ordered := []*rawSpoolBatch{}
	ordinals := map[uint64]bool{}
	for _, entry := range entries {
		if entry.Name() == "store.lock" {
			continue
		}
		if !entry.IsDir() || !rawBatchIDPattern.MatchString(entry.Name()) {
			return fmt.Errorf("unexpected entry in RAW spool state: %s", entry.Name())
		}
		dir := m.directory(entry.Name())
		info, err := os.Lstat(dir)
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("unsafe RAW spool directory: %s", dir)
		}
		data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
		if os.IsNotExist(err) {
			// begin may crash after mkdir/temp-write, before its first durable
			// manifest. No worker can have existed for this unaccepted directory.
			files, readErr := os.ReadDir(dir)
			if readErr != nil {
				return readErr
			}
			for _, file := range files {
				info, statErr := os.Lstat(filepath.Join(dir, file.Name()))
				if statErr != nil || !info.Mode().IsRegular() || !strings.HasPrefix(file.Name(), ".write-") || !strings.HasSuffix(file.Name(), ".tmp") {
					return fmt.Errorf("manifest missing from nonempty batch directory: %s", entry.Name())
				}
			}
			for _, file := range files {
				if removeErr := os.Remove(filepath.Join(dir, file.Name())); removeErr != nil {
					return removeErr
				}
			}
			if removeErr := os.Remove(dir); removeErr != nil {
				return removeErr
			}
			if err := syncRawSpoolDirectory(m.dir); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		var s rawSpoolManifest
		if err = json.Unmarshal(data, &s); err != nil {
			return err
		}
		if s.Version != rawSpoolStoreVersion || s.BatchID != entry.Name() || s.Owner == "" || s.PrinterName == "" || s.Ordinal == 0 || ordinals[s.Ordinal] || s.TotalLabels < 1 || s.TotalLabels > maxRawSpoolLabels {
			return fmt.Errorf("invalid RAW spool manifest: %s", entry.Name())
		}
		switch s.State {
		case "staging", "queued", "spooling", "spool-accepted", "failed", "uncertain", "cancelled":
		default:
			return fmt.Errorf("invalid batch state: %s", s.State)
		}
		ordinals[s.Ordinal] = true
		if s.Ordinal > m.nextOrdinal {
			m.nextOrdinal = s.Ordinal
		}
		totalBytes := int64(0)
		totalLabels := 0
		for i, chunk := range s.Chunks {
			if chunk.Sequence != i+1 || chunk.Bytes < 1 || chunk.Bytes > maxPayloadBytes || chunk.LabelCount < 1 || len(chunk.SHA256) != 64 {
				return fmt.Errorf("invalid chunk manifest in %s", s.BatchID)
			}
			totalBytes += chunk.Bytes
			totalLabels += chunk.LabelCount
			if !rawSpoolTerminal(s.State) {
				size, hash, err := hashRawSpoolFile(m.chunkPath(s.BatchID, chunk.Sequence))
				if err != nil || size != chunk.Bytes || hash != chunk.SHA256 {
					return fmt.Errorf("chunk integrity failed in %s sequence %d", s.BatchID, chunk.Sequence)
				}
			}
		}
		if (!s.Archived && (totalBytes != s.StagedBytes || totalLabels != s.StagedLabels)) || s.StagedLabels > s.TotalLabels || s.StagedBytes > maxRawSpoolBatchBytes || (s.Archived && (!rawSpoolTerminal(s.State) || len(s.Chunks) > 0 || s.ArchivedChunks < 0)) {
			return fmt.Errorf("invalid batch totals in %s", s.BatchID)
		}
		// An unreferenced *next* staging chunk is definitely unsent: no commit
		// was durable. Discard it so the same sequence can be safely uploaded
		// again. Never discard referenced/queued/uncertain data on a guess.
		files, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, file := range files {
			filePath := filepath.Join(dir, file.Name())
			fileInfo, statErr := os.Lstat(filePath)
			if statErr != nil || !fileInfo.Mode().IsRegular() {
				return fmt.Errorf("unexpected nonregular batch data: %s", filePath)
			}
			if (strings.HasPrefix(file.Name(), ".write-") || strings.HasPrefix(file.Name(), ".assemble-")) && strings.HasSuffix(file.Name(), ".tmp") {
				if removeErr := os.Remove(filePath); removeErr != nil {
					return removeErr
				}
				continue
			}
			if strings.HasPrefix(file.Name(), "chunk-") && strings.HasSuffix(file.Name(), ".zpl") {
				known := false
				for _, chunk := range s.Chunks {
					if filepath.Base(m.chunkPath(s.BatchID, chunk.Sequence)) == file.Name() {
						known = true
						break
					}
				}
				if !known {
					if s.State == "staging" && file.Name() == filepath.Base(m.chunkPath(s.BatchID, len(s.Chunks)+1)) {
						if removeErr := os.Remove(filePath); removeErr != nil {
							return removeErr
						}
						continue
					}
					return fmt.Errorf("uncommitted chunk found in %s", s.BatchID)
				}
			}
		}
		b := &rawSpoolBatch{manifest: s}
		if err := syncRawSpoolDirectory(dir); err != nil {
			return err
		}
		if rawSpoolTerminal(s.State) {
			m.removePayloadLocked(b)
			if m.fault != nil {
				return m.fault
			}
		}
		if s.State == "spooling" {
			b.manifest.State = "uncertain"
			b.manifest.RecoveryRequired = true
			b.manifest.Error = "Connector stopped while submitting this Windows job. Do not reprint; inspect and reconcile its physical outcome."
			if err = m.saveLocked(b); err != nil {
				return err
			}
		}
		if s.State == "queued" {
			b.manifest.RecoveryRequired = true
			b.manifest.Error = "Recovered unsent batch; explicit commit or cancel is required."
			if err = m.saveLocked(b); err != nil {
				return err
			}
		}
		m.batches[s.BatchID] = b
		ordered = append(ordered, b)
	}
	sort.Slice(ordered, func(i, j int) bool { return ordered[i].manifest.Ordinal < ordered[j].manifest.Ordinal })
	for _, b := range ordered {
		if !rawSpoolTerminal(b.manifest.State) {
			r, err := m.queues.reserve(spoolPrinterTargetKey(b.manifest.PrinterName))
			if err != nil {
				return err
			}
			b.reservation = r
		}
	}
	return nil
}

type rawSpoolBatchRequest struct {
	Action                    string `json:"action"`
	BatchID                   string `json:"batchId"`
	PrinterName               string `json:"printerName"`
	DocumentName              string `json:"documentName"`
	TotalLabels               int    `json:"totalLabels"`
	Sequence                  int    `json:"sequence"`
	LabelCount                int    `json:"labelCount"`
	PayloadBase64             string `json:"payloadBase64"`
	TotalChunks               int    `json:"totalChunks"`
	TotalBytes                int64  `json:"totalBytes"`
	Resolution                string `json:"resolution"`
	AcknowledgePrinterCleared bool   `json:"acknowledgePrinterCleared"`
}

func (s *appServer) handleRawSpoolBatch(writer http.ResponseWriter, request *http.Request, origin string) error {
	var body rawSpoolBatchRequest
	if err := decodeJSON(writer, request, &body); err != nil {
		return err
	}
	owner := tcpJobOwner(origin)
	id := strings.TrimSpace(body.BatchID)
	var result rawSpoolBatchResult
	var err error
	switch body.Action {
	case "begin":
		printer := cleanText(body.PrinterName, "", 260, false)
		document := cleanText(body.DocumentName, "Nextwaves label", 160, true)
		if s.rawQueueValidator != nil {
			if validationErr := s.rawQueueValidator(printer); validationErr != nil {
				return validationErr
			}
		}
		if platformSpoolerAvailable() && !s.allowNonZebraQueues {
			printers, listErr := listPlatformPrinters()
			if listErr != nil {
				return listErr
			}
			trusted := false
			for i := range printers {
				if strings.EqualFold(printers[i].Name, printer) && isTrustedZebraQueue(&printers[i]) {
					trusted = true
					break
				}
			}
			if !trusted {
				return forbidden("Windows RAW batch printing requires an installed Zebra/ZDesigner/Seagull queue.")
			}
		}
		result, err = s.rawSpoolBatches.begin(owner, id, printer, document, body.TotalLabels)
	case "append":
		var payload []byte
		payload, err = decodeBase64Payload(strings.TrimSpace(body.PayloadBase64))
		if err == nil {
			result, err = s.rawSpoolBatches.append(owner, id, body.Sequence, body.LabelCount, payload)
		}
	case "commit":
		result, err = s.rawSpoolBatches.commit(owner, id, body.TotalChunks, body.TotalBytes)
	case "status":
		result, err = s.rawSpoolBatches.status(owner, id)
	case "list":
		batches, listErr := s.rawSpoolBatches.list(owner)
		if listErr != nil {
			return listErr
		}
		s.writeJSON(writer, http.StatusOK, map[string]any{"ok": true, "batches": batches})
		return nil
	case "cancel":
		result, err = s.rawSpoolBatches.cancel(owner, id)
	case "reconcile":
		result, err = s.rawSpoolBatches.reconcile(owner, id, body.Resolution, body.AcknowledgePrinterCleared)
	case "archive":
		result, err = s.rawSpoolBatches.archive(owner, id)
	default:
		return badRequest("action must be begin, append, commit, status, list, cancel, reconcile, or archive.")
	}
	if err != nil {
		return err
	}
	s.writeJSON(writer, http.StatusOK, result)
	return nil
}
