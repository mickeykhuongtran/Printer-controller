package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func fleetCall(t *testing.T, s *appServer, b tcpJobRequest) (fleetSpool, error) {
	t.Helper()
	w := httptest.NewRecorder()
	err := s.handleFleetSpool(w, httptest.NewRequest("POST", "/v1/tcp/job", nil), "owner", b)
	var result struct {
		Job fleetSpool `json:"job"`
	}
	if err == nil && b.Action != "spool-list" {
		if e := json.Unmarshal(w.Body.Bytes(), &result); e != nil {
			t.Fatal(e)
		}
	}
	return result.Job, err
}
func stageTestFleetJob(t *testing.T, s *appServer, id, host string) fleetSpool {
	t.Helper()
	_, err := fleetCall(t, s, tcpJobRequest{Action: "spool-create", JobID: id, Host: host, Capture: &rfidCaptureOptions{AuditBatchCounters: true, ExpectedLabels: 3, FirstRow: 1, RowStep: 1, Bank: "EPC"}})
	if err != nil {
		t.Fatal(err)
	}
	payload := ""
	for i := 1; i <= 3; i++ {
		payload += reconciliationFormat(id, i)
	}
	encoded := base64.StdEncoding.EncodeToString([]byte(payload))
	seq := float64(1)
	p, err := fleetCall(t, s, tcpJobRequest{Action: "spool-append", JobID: id, Sequence: &seq, PayloadBase64: &encoded, PayloadSHA256: payloadDigest([]byte(payload))})
	if err != nil {
		t.Fatal(err)
	}
	again, err := fleetCall(t, s, tcpJobRequest{Action: "spool-append", JobID: id, Sequence: &seq, PayloadBase64: &encoded, PayloadSHA256: payloadDigest([]byte(payload))})
	if err != nil || again.Bytes != p.Bytes {
		t.Fatal("staging replay was not idempotent", err)
	}
	return p
}
func commitTestFleetJob(t *testing.T, s *appServer, p fleetSpool) {
	t.Helper()
	seq := float64(1)
	size := float64(p.Bytes)
	_, err := fleetCall(t, s, tcpJobRequest{Action: "spool-commit", JobID: p.JobID, ExpectedSequence: &seq, ExpectedBytes: &size, CheckpointHash: p.Checkpoint})
	if err != nil {
		t.Fatal(err)
	}
}

func TestFleetFlexiblePrintersAndDurableQueue(t *testing.T) {
	for _, n := range []int{1, 2, 3, 4, 5, 10} {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			printers := map[string]*lifecyclePrinter{}
			for i := 0; i < n; i++ {
				printers[fmt.Sprintf("192.0.2.%d", i+1)] = &lifecyclePrinter{job: fmt.Sprintf("fleet-job-%02d", i), unpaused: true}
			}
			m := newTCPJobManagerWithDialAndQueue(func(ctx context.Context, host string, port int, d time.Duration) (net.Conn, string, error) {
				return printers[host].dial(ctx, host, port, d)
			}, newPrinterTargetQueue())
			m.captureDir = t.TempDir()
			m.maxActive = 2
			m.monitorInterval = 0
			defer m.close()
			s := &appServer{tcpJobs: m, allowedTCPPorts: map[int]struct{}{9100: {}}}
			jobs := []fleetSpool{}
			for host, p := range printers {
				jobs = append(jobs, stageTestFleetJob(t, s, p.job, host))
			}
			for _, p := range printers {
				if p.labels.Load() != 0 {
					t.Fatal("staging printed labels")
				}
			}
			for _, job := range jobs {
				commitTestFleetJob(t, s, job)
			}
			deadline := time.Now().Add(35 * time.Second)
			for {
				done := 0
				m.spoolMu.Lock()
				for _, p := range m.spools {
					if p.State == "needs_review" {
						t.Errorf("unexpected review: %s", p.Error)
					}
					if p.State == "done" {
						done++
						if p.Receipt.Capture.Audit.ValidDelta != 3 {
							t.Error("counter attribution")
						}
					}
				}
				m.spoolMu.Unlock()
				if t.Failed() {
					return
				}
				if done == n {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("queue did not drain")
				}
				time.Sleep(20 * time.Millisecond)
			}
			for _, p := range printers {
				if p.labels.Load() != 3 || p.dials.Load() != 1 {
					t.Fatal("missing or replayed labels", p.labels.Load(), p.dials.Load())
				}
			}
		})
	}
}

func TestFleetRestartNeverReplaysAndStagedHashIsChecked(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	defer m.close()
	s := &appServer{tcpJobs: m, allowedTCPPorts: map[int]struct{}{9100: {}}}
	p := stageTestFleetJob(t, s, "restart-fleet", "192.0.2.2")
	m.spoolMu.Lock()
	stored := m.spools[tcpJobMapKey("owner", p.JobID)]
	stored.State = "printing"
	if err := m.saveSpool(stored); err != nil {
		t.Fatal(err)
	}
	m.spoolMu.Unlock()
	recovered := newTCPJobManager()
	defer recovered.close()
	recovered.captureDir = m.captureDir
	recovered.spoolMu.Lock()
	err := recovered.loadSpoolsLocked()
	copyJob := *recovered.spools[tcpJobMapKey("owner", p.JobID)]
	recovered.spoolMu.Unlock()
	if err != nil || copyJob.State != "needs_review" {
		t.Fatal("restart was not quarantined", err, copyJob.State)
	}
	if _, err := os.Stat(filepath.Join(m.spoolDirectory("owner", p.JobID), "000001.zpl")); err != nil {
		t.Fatal("staging evidence lost", err)
	}
	other := &appServer{tcpJobs: recovered, allowedTCPPorts: map[int]struct{}{9100: {}}}
	_, err = fleetCall(t, other, tcpJobRequest{Action: "spool-create", JobID: "restart-next", Host: p.Host, Capture: p.Capture})
	if err == nil {
		t.Fatal("unresolved target admitted")
	}
}

func TestFleetSlowPrinterDoesNotBlockOtherAdmission(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	sess := &tcpJobSession{owner: "owner", jobID: "slow-printer", host: "192.0.2.1", port: 9100, state: "open"}
	m.jobs["slow"] = sess
	sess.mu.Lock()
	defer sess.mu.Unlock()
	done := make(chan struct{})
	go func() {
		a, _ := m.stats()
		if a != 1 {
			t.Error("busy printer not counted")
		}
		m.productionActiveRuns("owner")
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(100 * time.Millisecond):
		t.Fatal("global status blocked behind printer I/O")
	}
	// The synthetic locked session has no monitor/socket to shut down.
	delete(m.jobs, "slow")
}

func TestFleetFailedFeedbackKeepsRawFrameAndFragmentedReads(t *testing.T) {
	for _, step := range []int{1, 2, 7, 4096} {
		t.Run(fmt.Sprint(step), func(t *testing.T) {
			c, err := newRfidCapture(t.TempDir(), "owner", "fragment-test", "192.0.2.1", 9100, rfidCaptureOptions{ExpectedLabels: 2, FirstRow: 1, RowStep: 1, Bank: "EPC"})
			if err != nil {
				t.Fatal(err)
			}
			stream := "NWEP|fragment-test|1|ABCD1234|END\r\nNWEP|fragment-test|2|READ ERROR\x00|END\r\n"
			for i := 0; i < len(stream); i += step {
				end := min(i+step, len(stream))
				c.feed([]byte(stream[i:end]))
			}
			close(c.done)
			if err := c.close(nil, "finished"); err != nil {
				t.Fatal(err)
			}
			if c.summary.UniqueLabels != 1 || c.summary.InvalidReads != 1 {
				t.Fatal("fragmentation changed record classification", c.summary)
			}
			raw, err := os.ReadFile(filepath.Join(c.dir, "feedback-errors.jsonl"))
			if err != nil || !strings.Contains(string(raw), "52454144204552524f52") {
				t.Fatal("invalid feedback evidence not retained", err, string(raw))
			}
		})
	}
}

func TestFleetZeroBaselineRejectsBeforeAnyLabel(t *testing.T) {
	p := &lifecyclePrinter{job: "zero-baseline-test", unpaused: true}
	m, s := lifecycleManager(t, p, 3)
	s.capture.mu.Lock()
	s.capture.summary.Options.RequireZeroBaseline = true
	s.capture.mu.Unlock()
	_, err := lifecycleAppend(t, m, p.job, 1, 1, 3)
	if err == nil || p.labels.Load() != 0 {
		t.Fatal("nonzero new-roll counters admitted labels", err, p.labels.Load())
	}
}

func TestCaptureResynchronizesAfterDamagedFrame(t *testing.T) {
	c, err := newRfidCapture(t.TempDir(), "owner", "frame-resync", "192.0.2.1", 9100, rfidCaptureOptions{ExpectedLabels: 2, FirstRow: 1, RowStep: 1, Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	c.feed([]byte("NWEP|frame-resync|1|BADNWEP|frame-resync|2|AABB0011|END\r\n"))
	close(c.done)
	if err := c.close(nil, "finished"); err != nil {
		t.Fatal(err)
	}
	if c.summary.UniqueLabels != 1 || c.summary.Received != 2 || c.summary.Issues == 0 {
		t.Fatal("valid following frame was lost", c.summary)
	}
}

func TestFleetCancelBeforePayloadHasNotSentEvidence(t *testing.T) {
	printer := &lifecyclePrinter{job: "cancel-fleet-before"}
	m := newTCPJobManagerWithDialAndQueue(printer.dial, newPrinterTargetQueue())
	m.captureDir = t.TempDir()
	m.monitorInterval = 0
	defer m.close()
	server := &appServer{tcpJobs: m, allowedTCPPorts: map[int]struct{}{9100: {}}}
	job := stageTestFleetJob(t, server, printer.job, "192.0.2.1")
	commitTestFleetJob(t, server, job)
	deadline := time.Now().Add(5 * time.Second)
	for {
		m.spoolMu.Lock()
		started := m.spools[tcpJobMapKey("owner", printer.job)].Receipt != nil
		m.spoolMu.Unlock()
		if started {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("job did not enter pause")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := fleetCall(t, server, tcpJobRequest{Action: "spool-cancel", JobID: printer.job}); err != nil {
		t.Fatal(err)
	}
	for {
		m.spoolMu.Lock()
		p := m.spools[tcpJobMapKey("owner", printer.job)]
		done := p.State == "cancelled"
		if done && (p.Receipt == nil || p.Receipt.Capture == nil || !hasUnsentRfidAdmission(*p.Receipt.Capture)) {
			t.Error("cancel lost guaranteed not-sent evidence")
		}
		m.spoolMu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cancel did not stop")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if printer.labels.Load() != 0 {
		t.Fatal("cancelled preparation printed labels")
	}
}

func TestFleetHeadOpenBeforePayloadStopsAndKeepsNotSentEvidence(t *testing.T) {
	printer := &lifecyclePrinter{job: "head-open-before", unpaused: true, headOpen: true}
	m := newTCPJobManagerWithDialAndQueue(printer.dial, newPrinterTargetQueue())
	m.captureDir = t.TempDir()
	m.monitorInterval = 0
	defer m.close()
	server := &appServer{tcpJobs: m, allowedTCPPorts: map[int]struct{}{9100: {}}}
	job := stageTestFleetJob(t, server, printer.job, "192.0.2.1")
	commitTestFleetJob(t, server, job)
	deadline := time.Now().Add(10 * time.Second)
	for {
		m.spoolMu.Lock()
		p := m.spools[tcpJobMapKey("owner", printer.job)]
		done := p.State == "not_sent"
		if done && (p.Receipt == nil || p.Receipt.Capture == nil || !hasUnsentRfidAdmission(*p.Receipt.Capture)) {
			t.Error("head fault lost not-sent evidence")
		}
		m.spoolMu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("head-open remained printing")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if printer.labels.Load() != 0 {
		t.Fatal("head-open printed labels")
	}
}

func TestFleetLiveListBoundedAndHistoryDoesNotLoadConfigurations(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	m.spools = map[string]*fleetSpool{}
	defer m.close()
	for i := 0; i < 305; i++ {
		id := fmt.Sprintf("history-%04d", i)
		m.spools[tcpJobMapKey("owner", id)] = &fleetSpool{Owner: "owner", JobID: id, Host: fmt.Sprintf("192.0.2.%d", i%5+1), Port: 9100, State: "done", CreatedAt: time.Unix(int64(i), 0).UTC().Format(time.RFC3339), Capture: &rfidCaptureOptions{AllowTemplateRevision: true, ConfigurationSnapshot: "large-config"}}
	}
	server := &appServer{tcpJobs: m}
	fetch := func(action string, offset int) []fleetSpool {
		w := httptest.NewRecorder()
		if err := server.handleFleetSpool(w, httptest.NewRequest("POST", "/v1/tcp/job", nil), "owner", tcpJobRequest{Action: action, HistoryOffset: offset}); err != nil {
			t.Fatal(err)
		}
		var out struct {
			Jobs []fleetSpool `json:"jobs"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		for _, p := range out.Jobs {
			if p.Capture.ConfigurationSnapshot != "" {
				t.Fatal("large configuration leaked into polling")
			}
		}
		return out.Jobs
	}
	live := fetch("spool-list", 0)
	if len(live) != 5 || live[0].JobID != "history-0304" || live[4].JobID != "history-0300" {
		t.Fatal("live list not latest per printer", live)
	}
	if len(fetch("spool-history", 0)) != 100 || len(fetch("spool-history", 300)) != 5 || len(fetch("spool-history", 999)) != 0 {
		t.Fatal("history page size")
	}
	stored := m.spools[tcpJobMapKey("owner", "history-0304")]
	if err := os.MkdirAll(m.spoolDirectory("owner", stored.JobID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := m.saveSpool(stored); err != nil {
		t.Fatal(err)
	}
	recovered := newTCPJobManager()
	recovered.captureDir = m.captureDir
	defer recovered.close()
	if err := recovered.loadSpoolsLocked(); err != nil {
		t.Fatal("finished history should not load configuration file", err)
	}
	if recovered.spools[tcpJobMapKey("owner", stored.JobID)].Capture.ConfigurationSnapshot != "" {
		t.Fatal("finished config retained in memory")
	}
}

func TestFleetTamperedPayloadNeverSent(t *testing.T) {
	printer := &lifecyclePrinter{job: "tamper-test", unpaused: true}
	m := newTCPJobManagerWithDialAndQueue(printer.dial, newPrinterTargetQueue())
	m.captureDir = t.TempDir()
	m.monitorInterval = 0
	defer m.close()
	server := &appServer{tcpJobs: m, allowedTCPPorts: map[int]struct{}{9100: {}}}
	p := stageTestFleetJob(t, server, printer.job, "192.0.2.1")
	if err := os.WriteFile(filepath.Join(m.spoolDirectory("owner", p.JobID), "000001.zpl"), []byte("changed after staging"), 0600); err != nil {
		t.Fatal(err)
	}
	commitTestFleetJob(t, server, p)
	deadline := time.Now().Add(10 * time.Second)
	for {
		m.spoolMu.Lock()
		job := m.spools[tcpJobMapKey("owner", p.JobID)]
		done := job.State == "not_sent"
		if done && !strings.Contains(job.Error, "integrity") {
			t.Error("missing integrity error", job.Error)
		}
		m.spoolMu.Unlock()
		if done {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("tampered job did not stop")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if printer.labels.Load() != 0 {
		t.Fatal("tampered payload sent")
	}
}

func TestFleetBrokenInventoryNeverPublishesPartialAdmissionState(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	defer m.close()
	dir := m.spoolDirectory("owner", "broken-job")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "spool.json")
	if err := os.WriteFile(file, []byte("{broken"), 0600); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := m.loadSpoolsLocked(); err == nil || m.spools != nil {
			t.Fatal("partial inventory allowed next admission", err, m.spools)
		}
	}
	p := &fleetSpool{Owner: "owner", JobID: "broken-job", Host: "192.0.2.1", Port: 9100, State: "needs_review"}
	if err := m.saveSpool(p); err != nil {
		t.Fatal(err)
	}
	if err := m.loadSpoolsLocked(); err != nil || len(m.spools) != 1 {
		t.Fatal("repaired inventory unavailable", err)
	}
}
