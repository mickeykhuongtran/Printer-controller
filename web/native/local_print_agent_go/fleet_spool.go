package main

// A committed spool is owned by the connector, independently of the renderer.
// A process restart never replays a possibly transmitted payload.
import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type fleetChunk struct {
	Hash  string `json:"hash"`
	Bytes int    `json:"bytes"`
}
type fleetSpool struct {
	Streaming       bool                `json:"streaming,omitempty"`
	InputComplete   bool                `json:"inputComplete,omitempty"`
	InputUpdatedAt  time.Time           `json:"inputUpdatedAt,omitempty"`
	WindowLabels    int                 `json:"windowLabels,omitempty"`
	RollValidBefore int64               `json:"rollValidBefore"`
	RollVoidBefore  int64               `json:"rollVoidBefore"`
	Paused          bool                `json:"paused,omitempty"`
	Owner           string              `json:"owner"`
	JobID           string              `json:"jobId"`
	Host            string              `json:"host"`
	Port            int                 `json:"port"`
	State           string              `json:"state"`
	CreatedAt       string              `json:"createdAt"`
	Error           string              `json:"error,omitempty"`
	Capture         *rfidCaptureOptions `json:"capture,omitempty"`
	Chunks          []fleetChunk        `json:"chunks"`
	Bytes           int64               `json:"bytes"`
	Checkpoint      string              `json:"checkpoint"`
	CancelRequested bool                `json:"cancelRequested,omitempty"`
	Receipt         *tcpJobResult       `json:"receipt,omitempty"`
}

func (m *tcpJobManager) spoolDirectory(owner, id string) string {
	return captureDirectory(filepath.Join(m.captureDir, "spools"), owner, id)
}
func (m *tcpJobManager) saveSpool(s *fleetSpool) error {
	snapshot := *s
	if s.Capture != nil {
		options := *s.Capture
		options.ConfigurationSnapshot = ""
		snapshot.Capture = &options
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	return writeRawSpoolAtomic(filepath.Join(m.spoolDirectory(s.Owner, s.JobID), "spool.json"), data)
}
func (m *tcpJobManager) loadSpoolsLocked() error {
	if m.spools != nil {
		return nil
	}
	loaded := map[string]*fleetSpool{}
	entries, err := os.ReadDir(filepath.Join(m.captureDir, "spools"))
	if os.IsNotExist(err) {
		m.spools = loaded
		return nil
	}
	if err != nil {
		return err
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(m.captureDir, "spools", e.Name(), "spool.json"))
		if err != nil {
			return err
		}
		var s fleetSpool
		if json.Unmarshal(data, &s) != nil || !validTCPJobID(s.JobID) {
			return fmt.Errorf("invalid saved spool")
		}
		if s.State == "printing" || s.State == "queued" {
			s.State = "needs_review"
			s.Error = "Connector restarted. Verify the printer and reconcile this run before continuing; no payload was replayed."
			if err := m.saveSpool(&s); err != nil {
				return err
			}
		}
		// Upgrade only an explicit durable no-payload proof, never a zero byte
		// checkpoint alone (a failed write can have reached the printer).
		if s.State == "needs_review" && fleetProvenUnsent(s.Receipt) {
			s.State = "not_sent"
			if err := m.saveSpool(&s); err != nil {
				return err
			}
		}
		if s.State == "staging" && s.Capture != nil && s.Capture.AllowTemplateRevision {
			config, err := os.ReadFile(filepath.Join(m.spoolDirectory(s.Owner, s.JobID), "configuration.json"))
			if err != nil {
				return err
			}
			s.Capture.ConfigurationSnapshot = string(config)
			if err := validateCaptureOptions(s.Capture); err != nil {
				return err
			}
		}
		loaded[tcpJobMapKey(s.Owner, s.JobID)] = &s
	}
	// Publish only a complete inventory. A damaged manifest must not make
	// the next request overlook an unresolved printer from a partial load.
	m.spools = loaded
	return nil
}
func fleetActive(state string) bool { return state == "queued" || state == "printing" }
func (s *appServer) handleFleetSpool(w http.ResponseWriter, r *http.Request, owner string, b tcpJobRequest) error {
	m := s.tcpJobs
	if m.captureDir == "" {
		return badRequest("Durable spool storage unavailable.")
	}
	m.spoolMu.Lock()
	defer m.spoolMu.Unlock()
	if err := m.loadSpoolsLocked(); err != nil {
		return err
	}
	reply := func(v any) error {
		w.Header().Set("Content-Type", "application/json")
		return json.NewEncoder(w).Encode(v)
	}
	if b.Action == "spool-list" || b.Action == "spool-history" {
		jobs := []fleetSpool{}
		for _, p := range m.spools {
			if p.Owner != owner {
				continue
			}
			v := *p
			v.Owner = ""
			v.Chunks = nil
			if v.Capture != nil {
				c := *v.Capture
				c.ConfigurationSnapshot = ""
				v.Capture = &c
			}

			if v.Receipt != nil {
				rec := *v.Receipt
				if rec.Capture != nil {
					c := *rec.Capture
					c.Options.ConfigurationSnapshot = ""
					rec.Capture = &c
				}
				v.Receipt = &rec
			}
			jobs = append(jobs, v)
		}
		sort.Slice(jobs, func(i, j int) bool {
			if b.Action == "spool-list" {
				a, z := fleetActive(jobs[i].State) || jobs[i].State == "needs_review", fleetActive(jobs[j].State) || jobs[j].State == "needs_review"
				if a != z {
					return a
				}
			}
			return jobs[i].CreatedAt > jobs[j].CreatedAt
		})
		if b.Action == "spool-list" {
			latest := make([]fleetSpool, 0)
			seen := map[string]bool{}
			for _, job := range jobs {
				target := tcpPrinterTargetKey(job.Host, job.Port)
				if !seen[target] {
					latest = append(latest, job)
					seen[target] = true
				}
			}
			jobs = latest
		} else {
			offset := b.HistoryOffset
			if offset < 0 {
				return badRequest("Invalid history offset.")
			}
			if offset > len(jobs) {
				offset = len(jobs)
			}
			jobs = jobs[offset:min(offset+100, len(jobs))]
		}
		return reply(map[string]any{"ok": true, "jobs": jobs, "maxActive": m.maxActive})
	}
	if !validTCPJobID(b.JobID) {
		return badRequest("Invalid spool job ID.")
	}
	key := tcpJobMapKey(owner, b.JobID)
	p := m.spools[key]
	switch b.Action {
	case "spool-create":
		if b.WindowLabels < 0 || b.WindowLabels > 20 {
			return badRequest("windowLabels must be between 1 and 20.")
		}
		port, err := numberAsInt(b.Port, 9100, 1, 65535, "port")
		if err != nil {
			return err
		}
		if _, ok := s.allowedTCPPorts[port]; !ok {
			return forbidden("TCP port is not allowed.")
		}
		host := productionEndpointHost(b.Host)
		if host == "" || strings.ContainsAny(host, `/\@`) {
			return badRequest("Invalid printer host.")
		}
		if err := validateCaptureOptions(b.Capture); err != nil {
			return err
		}
		if b.Capture == nil || !b.Capture.AuditBatchCounters {
			return badRequest("Fleet jobs require RFID counter capture.")
		}
		if p != nil {
			if p.Host != host || p.Port != port || p.Capture == nil || *p.Capture != *b.Capture {
				return productionError("Spool ID is already bound to different data.")
			}
			return reply(map[string]any{"ok": true, "job": fleetPublicJob(p)})
		}
		for _, other := range m.spools {
			if other.Host == host && other.Port == port && (fleetActive(other.State) || other.State == "needs_review") {
				return productionError("This printer has an active or unresolved run. Finish or reconcile it first.")
			}
		}
		if err := validateProductionJobIdentity(m.captureDir, owner, host, port, b.Capture); err != nil {
			return err
		}
		dir := m.spoolDirectory(owner, b.JobID)
		if err := os.MkdirAll(dir, 0700); err != nil {
			return err
		}
		if b.Capture.ConfigurationSnapshot != "" {
			if err := writeRawSpoolAtomic(filepath.Join(dir, "configuration.json"), []byte(b.Capture.ConfigurationSnapshot)); err != nil {
				return err
			}
		}
		p = &fleetSpool{WindowLabels: b.WindowLabels, Owner: owner, JobID: b.JobID, Host: host, Port: port, State: "staging", CreatedAt: time.Now().UTC().Format(time.RFC3339Nano), Capture: b.Capture, Checkpoint: tcpJobSeed(b.JobID)}
		if p.Capture.ProductionRollID != "" {
			productionRollMu.Lock()
			roll, e := readProductionRoll(m.captureDir, owner, p.Capture.ProductionRollID)
			if e == nil {
				var v productionRollView
				v, e = m.inspectProductionRoll(owner, roll, map[string]bool{})
				p.RollValidBefore = v.Summary.ValidCount
				p.RollVoidBefore = v.Summary.VoidCount
			}
			productionRollMu.Unlock()
			if e != nil {
				return e
			}
		}
		if err := m.saveSpool(p); err != nil {
			return err
		}
		m.spools[key] = p
	case "spool-append":
		if p == nil {
			return productionError("Spool not found.")
		}
		if p.CancelRequested || (p.State != "staging" && !(p.Streaming && fleetActive(p.State) && !p.InputComplete)) {
			if p.Error != "" {
				return productionError(p.Error)
			}
			return productionError("Lượt đã dừng hoặc đã nhận đủ dữ liệu; không nhận thêm tem.")
		}
		seq, err := numberAsInt(b.Sequence, 0, 1, 100000, "sequence")
		if err != nil {
			return err
		}
		if b.PayloadBase64 == nil {
			return badRequest("Missing chunk.")
		}
		payload, err := decodeBase64Payload(*b.PayloadBase64)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(payload)
		hash := hex.EncodeToString(sum[:])
		if hash != b.PayloadSHA256 {
			return badRequest("Chunk hash mismatch.")
		}
		if seq <= len(p.Chunks) {
			if p.Chunks[seq-1].Hash != hash {
				return productionError("Staged sequence conflict.")
			}
			return reply(map[string]any{"ok": true, "job": fleetPublicJob(p)})
		}
		if seq != len(p.Chunks)+1 || len(payload) == 0 || p.Bytes+int64(len(payload)) > maxTCPJobBytes {
			return badRequest("Invalid spool sequence or size.")
		}
		if err := writeRawSpoolAtomic(filepath.Join(m.spoolDirectory(owner, b.JobID), fmt.Sprintf("%06d.zpl", seq)), payload); err != nil {
			return err
		}
		old := *p
		p.Chunks = append(p.Chunks, fleetChunk{Hash: hash, Bytes: len(payload)})
		p.Bytes += int64(len(payload))
		p.Checkpoint = nextTCPJobCheckpoint(p.Checkpoint, seq, len(payload), hash)
		p.InputUpdatedAt = time.Now()
		if err := m.saveSpool(p); err != nil {
			*p = old
			return err
		}
	case "spool-start", "spool-commit":
		if p == nil {
			return badRequest("Spool not found.")
		}
		if b.Action == "spool-start" && p.State != "staging" {
			return reply(map[string]any{"ok": true, "job": fleetPublicJob(p)})
		}
		if len(p.Chunks) == 0 {
			return productionError("Prepare the first chunk before starting.")
		}
		if b.Action == "spool-commit" && (b.ExpectedSequence == nil || int(*b.ExpectedSequence) != len(p.Chunks) || b.ExpectedBytes == nil || int64(*b.ExpectedBytes) != p.Bytes || b.CheckpointHash != p.Checkpoint) {
			return productionError("Spool manifest does not match the prepared job.")
		}
		if b.Action == "spool-commit" && p.State != "staging" {
			if p.InputComplete {
				return reply(map[string]any{"ok": true, "job": fleetPublicJob(p)})
			}
			if !p.Streaming || !fleetActive(p.State) || p.CancelRequested {
				if p.Error != "" {
					return productionError(p.Error)
				}
				return productionError("Lượt đã dừng; không gửi lại dữ liệu.")
			}
			p.InputComplete = true
			if err := m.saveSpool(p); err != nil {
				p.InputComplete = false
				return err
			}
			return reply(map[string]any{"ok": true, "job": fleetPublicJob(p)})
		}
		for _, other := range m.spools {
			if other != p && other.Host == p.Host && other.Port == p.Port && (fleetActive(other.State) || other.State == "needs_review") {
				return productionError("This printer already has an active or unresolved run.")
			}
		}
		if err := validateProductionJobIdentity(m.captureDir, owner, p.Host, p.Port, p.Capture); err != nil {
			return err
		}
		p.State = "queued"
		p.Streaming = b.Action == "spool-start"
		p.InputComplete = !p.Streaming
		p.InputUpdatedAt = time.Now()
		if err := m.saveSpool(p); err != nil {
			p.State = "staging"
			return err
		}
		m.spoolWorkers.Add(1)
		go func() { defer m.spoolWorkers.Done(); m.runSpool(key) }()
	case "spool-cancel":
		if p == nil {
			return badRequest("Spool not found.")
		}
		if p.State == "staging" || p.State == "queued" {
			p.State = "cancelled"
		} else if p.State == "printing" {
			p.CancelRequested = true
		}
		if err := m.saveSpool(p); err != nil {
			return err
		}
	case "spool-reconcile":
		if p == nil || p.State != "needs_review" || !b.Confirmed || len(strings.TrimSpace(b.ReconciliationNote)) < 8 {
			return badRequest("Confirm the stopped printer and enter a reconciliation note.")
		}
		if rec, err := m.poll(owner, p.JobID); err == nil && rec.State != "finished" {
			if _, err = m.reconcile(owner, p.JobID, rec.NextSequence-1, rec.CumulativeBytes, rec.CheckpointHash, b.ReconciliationNote); err != nil {
				return err
			}
		}
		p.State = "reviewed"
		p.Error += " | Operator: " + strings.TrimSpace(b.ReconciliationNote)
		if err := m.saveSpool(p); err != nil {
			return err
		}
	default:
		return badRequest("Unknown spool action.")
	}
	return reply(map[string]any{"ok": true, "job": fleetPublicJob(p)})
}

func (m *tcpJobManager) runSpool(key string) {
	m.spoolMu.Lock()
	p := m.spools[key]
	copyJob := *p
	if p.Capture != nil {
		options := *p.Capture
		copyJob.Capture = &options
	}
	m.spoolMu.Unlock()
	owner, id := copyJob.Owner, copyJob.JobID
	stopRequested := func() bool {
		m.spoolMu.Lock()
		defer m.spoolMu.Unlock()
		return p.CancelRequested || p.State == "cancelled" || m.lifetime.Err() != nil
	}
	finish := func(state string, rec *tcpJobResult, err error) {
		m.spoolMu.Lock()
		defer m.spoolMu.Unlock()
		p.State = state
		p.Receipt = rec
		if err != nil {
			p.Error = err.Error()
		}
		if e := m.saveSpool(p); e != nil {
			p.State = "needs_review"
			p.Error = "Cannot save spool outcome: " + e.Error()
		}
		// Keep large configurations on disk, outside repeated UI/history snapshots.
		if p.Capture != nil {
			options := *p.Capture
			options.ConfigurationSnapshot = ""
			p.Capture = &options
		}
	}
	// Admission is a durable waiting state; renderer connections are irrelevant.
	for {
		if stopRequested() {
			finish("cancelled", nil, nil)
			return
		}
		active, _ := m.stats()
		if active < m.maxActive {
			break
		}
		select {
		case <-m.lifetime.Done():
			return
		case <-time.After(200 * time.Millisecond):
		}
	}
	m.spoolMu.Lock()
	if p.State != "queued" {
		m.spoolMu.Unlock()
		return
	}
	p.State = "printing"
	err := m.saveSpool(p)
	m.spoolMu.Unlock()
	if err != nil {
		finish("needs_review", nil, err)
		return
	}
	var rec tcpJobResult
	for {
		rec, err = m.open(m.lifetime, owner, id, copyJob.Host, copyJob.Port, 10*time.Second, 5*time.Second, 30*time.Minute, copyJob.Capture)
		api, capacity := err.(*apiError)
		if !capacity || api.Code != "TCP_JOB_CAPACITY" {
			break
		}
		if stopRequested() {
			finish("cancelled", nil, nil)
			return
		}
		select {
		case <-m.lifetime.Done():
			return
		case <-time.After(200 * time.Millisecond):
		}
	}
	if err != nil {
		// No append has been attempted. Keep the cause visible, but do not
		// create a second quarantine around an admission/connect rejection.
		finish("not_sent", nil, err)
		return
	}
	appendAttempted := false
	fail := func(err error) {
		cancelled := stopRequested()
		if sess, e := m.lookup(owner, id); e == nil {
			sess.mu.Lock()
			if !appendAttempted && sess.capture != nil {
				c := sess.capture
				c.mu.Lock()
				c.summary.Audit.AdmissionRejection = &rfidAdmissionRejection{Method: "before_first_payload_v1", Outcome: "not_sent", At: time.Now().UTC().Format(time.RFC3339Nano), Reason: "stopped_before_payload"}
				if err := c.saveLocked(); err != nil {
					c.failLocked(err)
				}
				c.mu.Unlock()
			}
			if sess.state == "open" && sess.conn != nil {
				if sess.serviceFault == "" && appendAttempted {
					reason := "Fleet run stopped"
					if cancelled {
						reason = "Operator cancelled"
					}
					sess.requestFaultClearLocked(reason)
				}
			}
			sess.mu.Unlock()
		}
		r, _ := m.abort(owner, id)
		if fleetProvenUnsent(&r) {
			_, _ = m.reconcile(owner, id, r.NextSequence-1, r.CumulativeBytes, r.CheckpointHash, "Confirmed no label payload was sent; retain admission evidence.")
			state := "not_sent"
			if stopRequested() {
				state = "cancelled"
			}
			finish(state, &r, err)
			return
		}
		if stopRequested() && r.Capture != nil && hasReconciledRfidCounters(*r.Capture) {
			if _, e := m.reconcile(owner, id, r.NextSequence-1, r.CumulativeBytes, r.CheckpointHash, "Host cancelled; original socket verified paused empty queue and stable final counters. No replay."); e == nil {
				finish("cancelled", &r, err)
				return
			}
		}
		finish("needs_review", &r, err)
	}
	if err := m.fleetVerifyBaseline(owner, id); err != nil {
		fail(err)
		return
	}
	window := copyJob.WindowLabels
	if window == 0 {
		window = 20
	}
	waitCapacity := func(nextLabels int) error {
		for {
			if stopRequested() {
				return fmt.Errorf("Operator cancelled this run; inspect labels and buffer before continuing")
			}
			r, e := m.queryContext(m.lifetime, owner, id, []byte("~HS\r\n"), 2*time.Second, 2*time.Second)
			if e != nil {
				return e
			}
			if r.ServiceFault != "" {
				return fmt.Errorf("Printer service fault: %s", r.ServiceFault)
			}
			if !completeZebraStatusResponse("~HS", r.Response) {
				return fmt.Errorf("Incomplete printer status")
			}
			empty, paused := recoveryHostDrained(r.Response)
			room := empty
			if nextLabels > 0 {
				room, paused, e = fleetHostCapacity(r.Response, nextLabels, window)
				if e != nil {
					return e
				}
				if !paused && room && r.Capture != nil && r.Capture.Audit.LastSubmittedSequence > 0 {
					// The printer's format count excludes transport/parser backlog.
					// Independently bound submitted attempts using fresh RFID counters.
					if !fleetAttemptCapacity(r.Capture, nextLabels, window) {
						r, e = m.fleetCounterSample(owner, id)
						if e != nil {
							return e
						}
					}
					room = fleetAttemptCapacity(r.Capture, nextLabels, window)
				}
			}
			m.spoolMu.Lock()
			p.Receipt = &r
			p.Paused = paused
			m.spoolMu.Unlock()
			if room && (!paused || nextLabels == 0) {
				return nil
			}
			select {
			case <-m.lifetime.Done():
				return m.lifetime.Err()
			case <-time.After(75 * time.Millisecond):
			}
		}
	}
	validator := &rfidCapture{summary: rfidCaptureSummary{JobID: id, Options: *copyJob.Capture}}
	// Read only persisted, acknowledged chunks. Preparation and physical printing
	// overlap; a missing producer never means successful completion or replay.
	i := 0
	for {
		if stopRequested() {
			fail(fmt.Errorf("Operator cancelled this run"))
			return
		}
		m.spoolMu.Lock()
		available := i < len(p.Chunks)
		sealed := !p.Streaming || p.InputComplete
		updated := p.InputUpdatedAt
		var chunk fleetChunk
		if available {
			chunk = p.Chunks[i]
		}
		m.spoolMu.Unlock()
		if !available {
			if sealed {
				break
			}
			if time.Since(updated) > 30*time.Second {
				fail(fmt.Errorf("Host không cung cấp thêm dữ liệu trong 30 giây. Lượt đã dừng; kiểm tra số tem đã in trước khi in tiếp."))
				return
			}
			select {
			case <-m.lifetime.Done():
				fail(m.lifetime.Err())
				return
			case <-time.After(25 * time.Millisecond):
			}
			continue
		}
		data, e := os.ReadFile(filepath.Join(m.spoolDirectory(owner, id), fmt.Sprintf("%06d.zpl", i+1)))
		if e != nil {
			fail(e)
			return
		}
		sum := sha256.Sum256(data)
		if hex.EncodeToString(sum[:]) != chunk.Hash || len(data) != chunk.Bytes {
			fail(fmt.Errorf("Staged payload integrity failure"))
			return
		}
		before := validator.summary.Audit.SubmittedAttempts
		validator.recordSubmittedFormatsLocked(data)
		labels := validator.summary.Audit.SubmittedAttempts - before
		if len(data) > 8*1024*1024 || validator.submittedFormatsInvalid || strings.TrimSpace(validator.submittedFormatTail) != "" || labels < 1 || labels > window || validator.summary.Audit.SubmittedAttempts > copyJob.Capture.ExpectedLabels {
			fail(fmt.Errorf("Invalid or oversized staged label window; no further payload sent"))
			return
		}
		if err = waitCapacity(labels); err != nil {
			fail(err)
			return
		}
		if stopRequested() {
			fail(fmt.Errorf("Operator cancelled this run"))
			return
		}
		appendAttempted = true
		rec, err = m.appendContext(m.lifetime, owner, id, i+1, data, chunk.Hash)
		if err != nil {
			fail(err)
			return
		}
		m.spoolMu.Lock()
		p.Receipt = &rec
		m.spoolMu.Unlock()
		i++
	}
	if validator.summary.Audit.SubmittedAttempts != copyJob.Capture.ExpectedLabels {
		fail(fmt.Errorf("Prepared label count does not match the requested run; verify the printed labels."))
		return
	}
	if err = waitCapacity(0); err != nil {
		r, e := m.poll(owner, id)
		if e != nil || !r.CounterFinishRecoverable {
			fail(err)
			return
		}
	}
	m.spoolMu.Lock()
	finalBytes, finalCheckpoint := p.Bytes, p.Checkpoint
	m.spoolMu.Unlock()
	rec, err = m.finish(owner, id, i, finalBytes, finalCheckpoint)
	if err != nil {
		fail(err)
		return
	}
	if rec.Capture == nil || !hasFinalRfidCounterSnapshot(*rec.Capture) {
		finish("needs_review", &rec, fmt.Errorf("Final printer counters require reconciliation"))
		return
	}
	finish("done", &rec, nil)
}

func configuredPrinterConcurrency() int {
	n, err := strconv.Atoi(os.Getenv("ZBRE_MAX_ACTIVE_PRINTERS"))
	if err == nil && n >= 1 && n <= 64 {
		return n
	}
	return maxActiveTCPJobs
}

func fleetPublicJob(p *fleetSpool) fleetSpool {
	v := *p
	v.Owner = ""
	v.Chunks = nil
	if v.Capture != nil {
		c := *v.Capture
		c.ConfigurationSnapshot = ""
		v.Capture = &c
	}
	if v.Receipt != nil {
		r := *v.Receipt
		if r.Capture != nil {
			c := *r.Capture
			c.Options.ConfigurationSnapshot = ""
			r.Capture = &c
		}
		v.Receipt = &r
	}
	return v
}

func (m *tcpJobManager) queuedSpoolCount() int {
	m.spoolMu.Lock()
	defer m.spoolMu.Unlock()
	n := 0
	for _, p := range m.spools {
		if p.State == "queued" {
			n++
		}
	}
	return n
}

func (m *tcpJobManager) checkSpoolAdmission(owner, id, host string, port int) error {
	if m.captureDir == "" {
		return nil
	}
	m.spoolMu.Lock()
	defer m.spoolMu.Unlock()
	if err := m.loadSpoolsLocked(); err != nil {
		return err
	}
	for _, p := range m.spools {
		if p.Owner == owner && p.JobID == id {
			continue
		}
		if productionEndpointHost(p.Host) == productionEndpointHost(host) && p.Port == port && (fleetActive(p.State) || p.State == "needs_review") {
			return productionError("This printer has a committed or unresolved durable run. Reconcile it before starting another job.")
		}
	}
	return nil
}
