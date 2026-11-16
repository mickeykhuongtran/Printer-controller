package main

// One reader owns the socket for capture-enabled jobs. Host-verification
// records are removed before status parsing; TCP packet boundaries are irrelevant.
import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const capturePrefix = "NWEP|"
const captureEnd = "|END\r\n"
const maxCaptureFileBytes = 128 * 1024 * 1024

type rfidCaptureOptions struct {
	RequireZeroBaseline   bool   `json:"requireZeroBaseline,omitempty"`
	AllowTemplateRevision bool   `json:"allowTemplateRevision,omitempty"`
	ConfigurationSnapshot string `json:"configurationSnapshot,omitempty"`
	OperationMode         string `json:"operationMode,omitempty"`
	ProductionRollID      string `json:"productionRollId,omitempty"`
	TemplateFingerprint   string `json:"templateFingerprint,omitempty"`
	SourceRollID          string `json:"sourceRollId,omitempty"`
	MaterialLot           string `json:"materialLot,omitempty"`
	Operator              string `json:"operator,omitempty"`
	AuditBatchCounters    bool   `json:"auditBatchCounters,omitempty"`
	ExpectedHexChars      int    `json:"expectedHexChars,omitempty"`
	ExpectedLabels        int    `json:"expectedLabels"`
	FirstRow              int    `json:"firstRow"`
	RowStep               int    `json:"rowStep"`
	Bank                  string `json:"bank"`
	TemplateName          string `json:"templateName"`
}
type rfidCaptureSummary struct {
	ServiceFault  *rfidServiceFault  `json:"serviceFault,omitempty"`
	Audit         rfidBatchAudit     `json:"audit"`
	JobID         string             `json:"jobId"`
	Owner         string             `json:"-"`
	Host          string             `json:"host"`
	Port          int                `json:"port"`
	Options       rfidCaptureOptions `json:"options"`
	CreatedAt     string             `json:"createdAt"`
	State         string             `json:"state"`
	Received      int                `json:"received"`
	UniqueLabels  int                `json:"uniqueLabels"`
	InvalidReads  int                `json:"invalidReads"`
	Issues        int                `json:"issues"`
	Error         string             `json:"error,omitempty"`
	TransportNote string             `json:"transportNote,omitempty"`
}
type rfidServiceFault struct {
	Reason         string `json:"reason"`
	At             string `json:"at"`
	ClearRequested bool   `json:"clearRequested"`
}

func (c *rfidCapture) recordServiceFault(reason, at string, clearRequested bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.summary.ServiceFault = &rfidServiceFault{Reason: reason, At: at, ClearRequested: clearRequested}
	if err := c.saveLocked(); err != nil {
		c.failLocked(err)
	}
}

type rfidCaptureManifest struct {
	Owner   string             `json:"owner"`
	Summary rfidCaptureSummary `json:"summary"`
}
type rfidCapture struct {
	diagnosticBuffer        []byte
	buffering               bool
	dirty                   bool
	pendingCounter          *rfidCounterSnapshot
	pendingCounterBaseline  bool
	submittedFormatTail     string
	submittedFormatsInvalid bool
	counterHighWater        rfidCounterSnapshot
	mu                      sync.Mutex
	summary                 rfidCaptureSummary
	dir                     string
	file                    *os.File
	csv                     *csv.Writer
	seen                    map[int]bool
	epcs                    map[string]bool
	nextOrdinal             int
	bytes                   int64
	pending                 []byte
	status                  []byte
	querying                bool
	fault                   error
	readError               error
	closing                 bool
	closed                  bool
	lastReceive             time.Time
	done                    chan struct{}
	changed                 chan struct{}
}

func captureDirectory(root, owner, id string) string {
	digest := sha256.Sum256([]byte(owner + "\x00" + id))
	return filepath.Join(root, hex.EncodeToString(digest[:]))
}
func validateCaptureOptions(o *rfidCaptureOptions) error {
	if o == nil {
		return nil
	}
	if o.ConfigurationSnapshot != "" {
		sum := sha256.Sum256([]byte(o.ConfigurationSnapshot))
		if len(o.ConfigurationSnapshot) > 8*1024*1024 || !json.Valid([]byte(o.ConfigurationSnapshot)) || hex.EncodeToString(sum[:]) != o.TemplateFingerprint {
			return badRequest("Invalid immutable configuration snapshot.")
		}
	}
	if o.AllowTemplateRevision && o.ConfigurationSnapshot == "" {
		return badRequest("A configuration snapshot is required for template revisions.")
	}
	if o.OperationMode != "" && o.OperationMode != "read" && o.OperationMode != "write" && o.OperationMode != "read_write" {
		return badRequest("Invalid RFID operation mode.")
	}
	if (o.OperationMode == "write" || o.OperationMode == "read_write") && o.Bank != "EPC" {
		return badRequest("RFID write verification must capture the EPC memory bank.")
	}
	if len(o.ProductionRollID) > 96 || len(o.Operator) > 128 || len(o.SourceRollID) > 128 || len(o.MaterialLot) > 128 || (o.ProductionRollID != "" && !validProductionFingerprint(o.TemplateFingerprint)) {
		return badRequest("Invalid production roll metadata or template fingerprint.")
	}
	if o.ExpectedHexChars < 0 || o.ExpectedHexChars > 256 || o.ExpectedHexChars%2 != 0 {
		return badRequest("Invalid expected RFID read length.")
	}
	if o.ExpectedLabels < 1 || o.ExpectedLabels > 9_007_199_254_740_991 || o.FirstRow < 1 ||
		(o.RowStep != 1 && o.RowStep != -1) || (o.Bank != "EPC" && o.Bank != "TID") || len(o.TemplateName) > 512 {
		return badRequest("Invalid RFID capture range, bank or template name.")
	}
	last := int64(o.FirstRow) + int64(o.ExpectedLabels-1)*int64(o.RowStep)
	if last < 1 || last > 9_007_199_254_740_991 {
		return badRequest("RFID capture row range is invalid.")
	}
	return nil
}
func newRfidCapture(root, owner, id, host string, port int, options rfidCaptureOptions) (*rfidCapture, error) {
	if err := validateCaptureOptions(&options); err != nil {
		return nil, err
	}
	if options.AllowTemplateRevision && options.ProductionRollID != "" {
		roll, err := readProductionRoll(root, owner, options.ProductionRollID)
		if err != nil {
			return nil, err
		}
		priorSent := false
		for _, run := range roll.Runs {
			data, err := os.ReadFile(filepath.Join(captureDirectory(root, owner, run.RunID), "manifest.json"))
			if err != nil {
				return nil, err
			}
			var manifest rfidCaptureManifest
			if json.Unmarshal(data, &manifest) != nil {
				return nil, errors.New("Invalid earlier roll evidence")
			}
			if manifest.Summary.Audit.LastSubmittedSequence > 0 || manifest.Summary.Received > 0 {
				priorSent = true
			}
		}
		options.RequireZeroBaseline = !priorSent
	}

	if root == "" {
		return nil, errors.New("RFID capture storage is not configured; update the local connector")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, err
	}
	dir := captureDirectory(root, owner, id)
	// Never overwrite an earlier session after a restart/lost open receipt.
	if err := os.Mkdir(dir, 0700); err != nil {
		return nil, fmt.Errorf("cannot create RFID session (do not reuse its job ID): %w", err)
	}
	c := &rfidCapture{dir: dir, seen: map[int]bool{}, epcs: map[string]bool{}, nextOrdinal: 1, done: make(chan struct{}), changed: make(chan struct{}, 1),
		summary: rfidCaptureSummary{JobID: id, Owner: owner, Host: host, Port: port, Options: options, CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), State: "capturing"}}
	if options.ConfigurationSnapshot != "" {
		if err := writeRawSpoolAtomic(filepath.Join(dir, "configuration.json"), []byte(options.ConfigurationSnapshot)); err != nil {
			return nil, err
		}
		c.summary.Options.ConfigurationSnapshot = ""
	}
	if err := c.saveLocked(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "reads.csv"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return nil, err
	}
	c.file = f
	c.csv = csv.NewWriter(f)
	header := []string{"job_id", "ordinal", "source_row", "bank", "data_hex", "received_at_utc", "result"}
	if options.OperationMode == "write" || options.OperationMode == "read_write" {
		header = append(header, "expected_hex")
	}
	err = c.csv.Write(header)
	c.csv.Flush()
	if err == nil {
		err = c.csv.Error()
	}
	if err == nil {
		err = f.Sync()
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	if options.ProductionRollID != "" {
		if err := registerProductionRun(root, owner, id, host, port, options); err != nil {
			f.Close()
			c.file = nil
			c.summary.State = "interrupted"
			c.summary.Error = "Production registration failed before any print data: " + err.Error()
			_ = c.saveLocked()
			return nil, err
		}
	}
	return c, nil
}
func (c *rfidCapture) saveLocked() error {
	if err := c.flushEvidenceLocked(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(rfidCaptureManifest{Owner: c.summary.Owner, Summary: c.summary}, "", "  ")
	if err != nil {
		return err
	}
	return writeRawSpoolAtomic(filepath.Join(c.dir, "manifest.json"), data)
}
func (c *rfidCapture) snapshot() *rfidCaptureSummary {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := c.summary
	return &s
}
func (c *rfidCapture) notify() {
	select {
	case c.changed <- struct{}{}:
	default:
	}
}
func (c *rfidCapture) failLocked(err error) {
	sealedSocketClose := strings.HasPrefix(err.Error(), "RFID return channel closed:") && hasFinalRfidCounterSnapshot(c.summary)
	if c.summary.Audit.LifecycleVersion > 0 && c.summary.Audit.FinalizationStatus != "unresolved" && !sealedSocketClose {
		c.unresolvedCounterLocked("capture_evidence_failed", "RFID evidence unavailable: "+err.Error())
	}
	c.summary.Audit.CounterReconciliation = nil
	if c.summary.Audit.State == "reconciled" {
		c.summary.Audit.State, c.summary.Audit.Note = "needs_review", "Stopped-run evidence could not be saved completely: "+err.Error()
	}
	if c.fault == nil {
		c.fault = err
		c.summary.Error = err.Error()
	}
	if c.summary.State == "complete" {
		c.summary.State = "incomplete"
		if c.summary.Audit.State == "matched" {
			c.summary.Audit.State, c.summary.Audit.Note = "needs_review", "Session evidence could not be saved completely: "+err.Error()
		}
	}
	c.notify()
}
func (c *rfidCapture) recordLocked(raw string) {
	fields := strings.Split(raw, "|")
	ordinal := 0
	data := ""
	issue := ""
	writeMode := c.summary.Options.OperationMode == "write" || c.summary.Options.OperationMode == "read_write"
	expected := ""
	framedWrite := len(fields) == 5 && fields[2] == "W"
	if (len(fields) != 3 && !framedWrite) || fields[0] != c.summary.JobID {
		issue = "unexpected_frame"
	} else {
		ordinal, _ = strconv.Atoi(fields[1])
		if framedWrite {
			expected = fields[3]
			data = strings.ToUpper(strings.Trim(fields[4], "\x00 \r\n"))
		} else {
			data = strings.ToUpper(strings.Trim(fields[2], "\x00 \r\n"))
		}
		decoded, err := hex.DecodeString(data)
		if ordinal < 1 || ordinal > c.summary.Options.ExpectedLabels {
			issue = "unexpected_ordinal"
		} else if c.seen[ordinal] {
			issue = "duplicate_response"
		} else {
			c.seen[ordinal] = true
			// Ascending gaps can be labels voided before ^HV returned data.
			// Only backwards responses contradict the ordered printer stream.
			if ordinal < c.nextOrdinal {
				issue = "out_of_order"
			}
			c.nextOrdinal = max(c.nextOrdinal, ordinal+1)
			verificationIssue := ""
			expectedBytes, expectedErr := hex.DecodeString(expected)
			if writeMode && (!framedWrite || expectedErr != nil || len(expectedBytes) == 0 || len(expected) > 256) {
				verificationIssue = "write_unverified"
			} else if !writeMode && framedWrite {
				verificationIssue = "unexpected_operation"
			} else if writeMode && err == nil && len(decoded) > 0 && !strings.EqualFold(data, expected) {
				verificationIssue = "write_mismatch"
			}
			if verificationIssue != "" || err != nil || len(decoded) == 0 || len(data) > 256 || (c.summary.Options.ExpectedHexChars > 0 && len(data) != c.summary.Options.ExpectedHexChars) {
				c.summary.InvalidReads++
				if verificationIssue == "" {
					verificationIssue = "invalid_read"
				}
				if issue == "" {
					issue = verificationIssue
				} else {
					issue += ";" + verificationIssue
				}
			} else {
				c.summary.UniqueLabels++
				if c.epcs[data] {
					if issue != "" {
						issue += ";"
					}
					issue += "duplicate_data"
				}
				c.epcs[data] = true
			}
		}
	}
	c.summary.Received++
	if issue != "" && issue != "invalid_read" {
		c.summary.Issues++
	} else if issue == "" {
		issue = "read"
	}
	row := ""
	if ordinal >= 1 && ordinal <= c.summary.Options.ExpectedLabels {
		row = strconv.Itoa(c.summary.Options.FirstRow + (ordinal-1)*c.summary.Options.RowStep)
	}
	// Only hexadecimal enters data_hex, never an executable spreadsheet cell.
	if _, err := hex.DecodeString(data); err != nil || len(data) > 256 {
		data = ""
	}
	record := []string{c.summary.JobID, strconv.Itoa(ordinal), row, c.summary.Options.Bank, data, time.Now().UTC().Format(time.RFC3339Nano), issue}
	if writeMode {
		if _, err := hex.DecodeString(expected); err != nil || len(expected) > 256 {
			expected = ""
		}
		record = append(record, strings.ToUpper(expected))
	}
	// Keep malformed feedback verbatim in a separate hex-encoded journal.
	// Never fabricate a valid EPC from printer counters or neighbouring labels.
	if issue != "read" {
		c.recordDiagnosticLocked(raw, issue)
	}
	err := c.csv.Write(record)
	c.dirty = true
	if err == nil && !c.buffering {
		err = c.flushEvidenceLocked()
	}
	c.bytes += int64(len(raw) + 160)
	if err == nil && c.bytes > maxCaptureFileBytes {
		err = errors.New("RFID history reached its disk safety budget; session stopped")
	}
	if err != nil {
		c.failLocked(err)
	}
	c.notify()
}
func (c *rfidCapture) statusLocked(b []byte) {
	if !c.querying {
		return
	}
	if len(c.status)+len(b) > maxTCPResponseBytes {
		c.failLocked(errors.New("RFID/status receive buffer overflow"))
		return
	}
	c.status = append(c.status, b...)
	c.notify()
}
func (c *rfidCapture) feed(data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	defer func() {
		if err := c.flushEvidenceLocked(); err != nil {
			c.failLocked(err)
		}
	}()
	c.buffering = true
	defer func() { c.buffering = false }()
	c.lastReceive = time.Now()
	c.pending = append(c.pending, data...)
	for len(c.pending) > 0 {
		i := bytes.Index(c.pending, []byte(capturePrefix))
		if i < 0 {
			keep := 0
			for n := 1; n < len(capturePrefix) && n <= len(c.pending); n++ {
				if bytes.HasSuffix(c.pending, []byte(capturePrefix[:n])) {
					keep = n
				}
			}
			c.statusLocked(c.pending[:len(c.pending)-keep])
			c.pending = append([]byte(nil), c.pending[len(c.pending)-keep:]...)
			return
		}
		if i > 0 {
			c.statusLocked(c.pending[:i])
			c.pending = c.pending[i:]
		}
		end := bytes.Index(c.pending, []byte(captureEnd))
		// A broken frame must not swallow the following intact EPC response.
		next := bytes.Index(c.pending[len(capturePrefix):], []byte(capturePrefix))
		if next >= 0 && (end < 0 || next+len(capturePrefix) < end) {
			next += len(capturePrefix)
			c.recordLocked(string(c.pending[len(capturePrefix):next]) + "|TRUNCATED")
			c.pending = c.pending[next:]
			continue
		}
		if end < 0 {
			if len(c.pending) > 4096 {
				c.recordDiagnosticLocked(string(c.pending), "unterminated_frame")
				c.failLocked(errors.New("Malformed/unterminated RFID host response"))
				c.pending = nil
			}
			return
		}
		c.recordLocked(string(c.pending[len(capturePrefix):end]))
		c.pending = c.pending[end+len(captureEnd):]
	}
}
func (c *rfidCapture) readLoop(conn net.Conn) {
	defer close(c.done)
	buf := make([]byte, 32*1024)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			c.feed(buf[:n])
		}
		c.mu.Lock()
		fault := c.fault
		c.mu.Unlock()
		if err != nil || fault != nil {
			c.mu.Lock()
			c.readError = err
			if !c.closing && c.fault == nil {
				if err != nil && len(c.pending) == 0 && hasFinalRfidCounterSnapshot(c.summary) {
					// All expected payload and physical counts were already sealed.
					// A later socket Read error is transport loss, not a disk failure
					// or uncertainty about those labels. Finish can close locally.
					c.summary.TransportNote = "Printer connection closed after the final counter proof was saved; no label replay or reconnect was needed."
					if saveErr := c.saveLocked(); saveErr != nil {
						c.failLocked(saveErr)
					}
				} else {
					if !hasFinalRfidCounterSnapshot(c.summary) {
						c.unresolvedCounterLocked("socket_lost", "The original printer connection closed before final counter confirmation. Saved EPCs and complete counter samples are retained.")
					}
					c.failLocked(fmt.Errorf("RFID return channel closed: %v", err))
				}
			}
			c.mu.Unlock()
			c.notify()
			return
		}
	}
}
func (c *rfidCapture) beginQuery() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fault != nil {
		return c.fault
	}
	c.querying = true
	c.status = nil
	return nil
}
func (c *rfidCapture) readQuery(ctx context.Context, command string, window time.Duration) (string, error) {
	defer func() { c.mu.Lock(); c.querying = false; c.mu.Unlock() }()
	timer := time.NewTimer(window)
	defer timer.Stop()
	for {
		c.mu.Lock()
		response := string(c.status)
		err := c.fault
		c.mu.Unlock()
		if err != nil {
			return "", err
		}
		if completeZebraStatusResponse(command, response) || completeRfidCounterResponse(command, response) {
			return response, nil
		}
		select {
		case <-c.changed:
		case <-ctx.Done():
			return "", ctx.Err()
		case <-timer.C:
			return "", errors.New("Zebra status timeout while collecting RFID data")
		}
	}
}
func (c *rfidCapture) close(conn net.Conn, state string) error {
	c.mu.Lock()
	if c.closed {
		err := c.fault
		c.mu.Unlock()
		return err
	}
	c.closing = true
	c.mu.Unlock()
	if state == "finished" || state == "cancelled" {
		// Keep the continuous reader alive through a bounded quiet interval so
		// in-flight ^HV records cannot be discarded by an immediate Close().
		started := time.Now()
		for time.Since(started) < 2*time.Second {
			c.mu.Lock()
			last := c.lastReceive
			c.mu.Unlock()
			if last.Before(started) {
				last = started
			}
			if time.Since(last) >= 250*time.Millisecond {
				break
			}
			select {
			case <-c.done:
				goto drained
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
drained:
	if conn != nil {
		_ = conn.Close()
	}
	<-c.done
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed = true
	if len(c.pending) > 0 {
		c.recordDiagnosticLocked(string(c.pending), "incomplete_frame_at_close")
		c.summary.Issues++
		c.summary.Error = "Incomplete RFID response at socket close"
	}
	if state == "finished" && c.summary.Issues == 0 && c.fault == nil && c.summary.Error == "" &&
		(c.summary.Options.AuditBatchCounters || (c.summary.UniqueLabels == c.summary.Options.ExpectedLabels && c.summary.Received == c.summary.Options.ExpectedLabels)) {
		c.summary.State = "complete"
	} else if state == "finished" {
		c.summary.State = "incomplete"
	} else {
		c.summary.State = "interrupted"
	}
	if state == "cancelled" {
		c.summary.State = "cancelled"
	}
	c.finalizeAuditLocked(state)
	if err := c.flushEvidenceLocked(); err != nil {
		c.failLocked(err)
	}
	if c.file != nil {
		if err := c.file.Close(); err != nil {
			c.failLocked(err)
		}
		c.file = nil
	}
	if err := c.saveLocked(); err != nil {
		c.failLocked(err)
	}
	// Keep raw evidence durable, but create a human CSV only on explicit export.
	return c.fault
}

func rfidCaptureFileName(summary rfidCaptureSummary) string {
	stamp := "unknown-time"
	if started, err := time.Parse(time.RFC3339Nano, summary.CreatedAt); err == nil {
		stamp = started.In(time.Local).Format("2006-01-02_15-04-05")
	}
	bank := "epc"
	if summary.Options.Bank == "TID" {
		bank = "tid"
	}
	digest := sha256.Sum256([]byte(summary.JobID))
	operation := "Read"
	if summary.Options.OperationMode == "write" || summary.Options.OperationMode == "read_write" {
		operation = "Write"
	}
	return fmt.Sprintf("%s_%s_%s_%s.csv", stamp, bank, operation, hex.EncodeToString(digest[:6]))
}

// History remains readable after connector/app restart. Only the authenticated
// owner can list/export a session. The CSV is streamed, not loaded into RAM.
func (m *tcpJobManager) handleCaptureHistory(w http.ResponseWriter, r *http.Request, owner string, body tcpJobRequest) error {
	if m.captureDir == "" {
		return &apiError{Status: 503, Code: "RFID_CAPTURE_UNAVAILABLE", Message: "RFID history storage is unavailable."}
	}
	if body.Action == "capture-export" {
		path := captureDirectory(m.captureDir, owner, body.JobID)
		raw, err := os.ReadFile(filepath.Join(path, "manifest.json"))
		if err != nil {
			return &apiError{Status: 404, Message: "RFID session not found."}
		}
		var manifest rfidCaptureManifest
		if json.Unmarshal(raw, &manifest) != nil || manifest.Owner != owner || manifest.Summary.JobID != body.JobID {
			return forbidden("RFID session owner mismatch.")
		}
		f, err := os.Open(filepath.Join(path, "reads.csv"))
		if err != nil {
			return err
		}
		defer f.Close()
		// Export exactly the bytes committed at the start of the download, even
		// when the collector is still appending records to this file.
		m.mu.Lock()
		session := m.jobs[tcpJobMapKey(owner, body.JobID)]
		m.mu.Unlock()
		var collector *rfidCapture
		if session != nil {
			session.mu.Lock()
			collector = session.capture
			session.mu.Unlock()
		}
		if collector != nil {
			collector.mu.Lock()
		}
		info, err := f.Stat()
		summary := manifest.Summary
		if collector != nil {
			summary = collector.summary
			collector.mu.Unlock()
		} else if summary.State == "capturing" {
			markRfidCrashInterrupted(&summary)
		}
		if err != nil {
			return err
		}
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=\"%s\"", rfidCaptureFileName(manifest.Summary)))
		return exportRfidResultReport(w, io.LimitReader(f, info.Size()), summary)
	}
	entries, err := os.ReadDir(m.captureDir)
	if os.IsNotExist(err) {
		entries = nil
	} else if err != nil {
		return err
	}
	summaries := []rfidCaptureSummary{}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(m.captureDir, entry.Name(), "manifest.json"))
		if err != nil {
			continue
		}
		var manifest rfidCaptureManifest
		if json.Unmarshal(raw, &manifest) != nil || manifest.Owner != owner {
			continue
		}
		summary := manifest.Summary
		m.mu.Lock()
		session := m.jobs[tcpJobMapKey(owner, summary.JobID)]
		m.mu.Unlock()
		if session != nil {
			session.mu.Lock()
			if session.capture != nil {
				summary = *session.capture.snapshot()
			}
			session.mu.Unlock()
		} else if summary.State == "capturing" {
			markRfidCrashInterrupted(&summary)
			// Recover counts from the append-only CSV after a crash, ignoring an incomplete tail.
			if f, e := os.Open(filepath.Join(m.captureDir, entry.Name(), "reads.csv")); e == nil {
				summary.Received, summary.UniqueLabels, summary.InvalidReads, summary.Issues = 0, 0, 0, 0
				reader := csv.NewReader(f)
				_, _ = reader.Read()
				seen := map[string]bool{}
				for {
					row, e := reader.Read()
					if e != nil {
						break
					}
					if len(row) != 7 && len(row) != 8 {
						break
					}
					summary.Received++
					if strings.Contains(row[6], "invalid_read") || strings.Contains(row[6], "write_mismatch") || strings.Contains(row[6], "write_unverified") {
						summary.InvalidReads++
					}
					if row[6] != "read" && row[6] != "invalid_read" {
						summary.Issues++
					}
					validResult := row[6] == "read" || row[6] == "out_of_order" || row[6] == "duplicate_data" || row[6] == "out_of_order;duplicate_data"
					if row[4] != "" && validResult && validProductionRead(row, summary) && !seen[row[1]] {
						seen[row[1]] = true
						summary.UniqueLabels++
					}
				}
				f.Close()
			}
		}
		summaries = append(summaries, summary)
	}
	sort.Slice(summaries, func(i, j int) bool { return summaries[i].CreatedAt > summaries[j].CreatedAt })
	// Metadata pagination is independent of the number of labels in a session.
	offset := body.HistoryOffset
	if offset < 0 {
		offset = 0
	}
	if offset > len(summaries) {
		offset = len(summaries)
	}
	end := offset + 50
	if end > len(summaries) {
		end = len(summaries)
	}
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(map[string]any{"ok": true, "sessions": summaries[offset:end], "total": len(summaries), "offset": offset})
}
