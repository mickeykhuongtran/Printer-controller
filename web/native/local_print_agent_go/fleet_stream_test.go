package main

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func createStreamingFleet(t *testing.T, printer *flowingPrinter, id string, total int) (*tcpJobManager, *appServer) {
	t.Helper()
	m := newTCPJobManagerWithDialAndQueue(printer.dial, newPrinterTargetQueue())
	m.captureDir, m.monitorInterval = t.TempDir(), 0
	t.Cleanup(m.close)
	s := &appServer{tcpJobs: m, allowedTCPPorts: map[int]struct{}{9100: {}}}
	_, err := fleetCall(t, s, tcpJobRequest{Action: "spool-create", JobID: id, Host: "192.0.2.1", WindowLabels: 20, Capture: &rfidCaptureOptions{AuditBatchCounters: true, RequireZeroBaseline: true, ExpectedLabels: total, FirstRow: 1, RowStep: 1, Bank: "EPC"}})
	if err != nil {
		t.Fatal(err)
	}
	return m, s
}
func appendStreamingFleet(t *testing.T, s *appServer, id string, seq, first, last int) (fleetSpool, error) {
	t.Helper()
	data := ""
	for n := first; n <= last; n++ {
		data += reconciliationFormat(id, n)
	}
	encoded, sequence := base64.StdEncoding.EncodeToString([]byte(data)), float64(seq)
	return fleetCall(t, s, tcpJobRequest{Action: "spool-append", JobID: id, Sequence: &sequence, PayloadBase64: &encoded, PayloadSHA256: payloadDigest([]byte(data))})
}
func startStreamingFleet(t *testing.T, s *appServer, id string) {
	t.Helper()
	if _, err := fleetCall(t, s, tcpJobRequest{Action: "spool-start", JobID: id}); err != nil {
		t.Fatal(err)
	}
}
func waitStreamingPrinted(t *testing.T, p *flowingPrinter, n int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		p.mu.Lock()
		got := p.printed
		p.mu.Unlock()
		if got >= n {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("first chunk did not print before producer finished")
}
func TestFleetStreamsBeforeAllChunksArePrepared(t *testing.T) {
	p := &flowingPrinter{}
	m, s := createStreamingFleet(t, p, "stream-early", 30)
	if _, err := appendStreamingFleet(t, s, "stream-early", 1, 1, 10); err != nil {
		t.Fatal(err)
	}
	startStreamingFleet(t, s, "stream-early")
	startStreamingFleet(t, s, "stream-early") // duplicate start receipt is safe
	waitStreamingPrinted(t, p, 10)
	m.spoolMu.Lock()
	state := *m.spools[tcpJobMapKey("owner", "stream-early")]
	m.spoolMu.Unlock()
	if state.State != "printing" || state.InputComplete || len(state.Chunks) != 1 {
		t.Fatal("waited for the full job or finished early", state.State)
	}
	// A repeated append after printing only acknowledges durable staging.
	if _, err := appendStreamingFleet(t, s, "stream-early", 1, 1, 10); err != nil {
		t.Fatal(err)
	}
	if _, err := appendStreamingFleet(t, s, "stream-early", 2, 11, 20); err != nil {
		t.Fatal(err)
	}
	last, err := appendStreamingFleet(t, s, "stream-early", 3, 21, 30)
	if err != nil {
		t.Fatal(err)
	}
	seq, size := float64(3), float64(last.Bytes)
	request := tcpJobRequest{Action: "spool-commit", JobID: last.JobID, ExpectedSequence: &seq, ExpectedBytes: &size, CheckpointHash: "wrong"}
	if _, err = fleetCall(t, s, request); err == nil {
		t.Fatal("sealed wrong manifest")
	}
	request.CheckpointHash = last.Checkpoint
	if _, err = fleetCall(t, s, request); err != nil {
		t.Fatal(err)
	}
	if _, err = fleetCall(t, s, request); err != nil {
		t.Fatal("seal retry", err)
	}
	result := waitFleetTerminal(t, m, last.JobID)
	if result.State != "done" || result.Receipt.Capture.Audit.ValidDelta != 30 {
		t.Fatal(result.State, result.Error)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.printed != 30 || p.accepted != 30 || p.maxPending > 20 {
		t.Fatal(p.printed, p.accepted, p.maxPending)
	}
}
func TestFleetUnsealedStopAndProducerLoss(t *testing.T) {
	for _, mode := range []string{"cancel", "producer-loss", "short-seal"} {
		t.Run(mode, func(t *testing.T) {
			p := &flowingPrinter{}
			id := "stream-" + mode
			m, s := createStreamingFleet(t, p, id, 30)
			first, err := appendStreamingFleet(t, s, id, 1, 1, 10)
			if err != nil {
				t.Fatal(err)
			}
			startStreamingFleet(t, s, id)
			waitStreamingPrinted(t, p, 10)
			switch mode {
			case "cancel":
				_, err = fleetCall(t, s, tcpJobRequest{Action: "spool-cancel", JobID: id})
			case "producer-loss":
				m.spoolMu.Lock()
				m.spools[tcpJobMapKey("owner", id)].InputUpdatedAt = time.Now().Add(-31 * time.Second)
				m.spoolMu.Unlock()
			case "short-seal":
				seq, size := float64(1), float64(first.Bytes)
				_, err = fleetCall(t, s, tcpJobRequest{Action: "spool-commit", JobID: id, ExpectedSequence: &seq, ExpectedBytes: &size, CheckpointHash: first.Checkpoint})
			}
			if err != nil {
				t.Fatal(err)
			}
			result := waitFleetTerminal(t, m, id)
			expected := "needs_review"
			if mode == "cancel" {
				expected = "cancelled"
			}
			if result.State != expected {
				t.Fatal(result.State, result.Error)
			}
			if _, err = appendStreamingFleet(t, s, id, 2, 11, 20); err == nil {
				t.Fatal("accepted late payload")
			}
			p.mu.Lock()
			defer p.mu.Unlock()
			if p.accepted != 10 || !p.cleared || len(p.queue) != 0 {
				t.Fatal("unexpected payload after stop")
			}
		})
	}
}
func TestFleetEarlyBaselineRejectsBeforePreparingRemainingLabels(t *testing.T) {
	p := &flowingPrinter{printed: 33}
	m, s := createStreamingFleet(t, p, "stream-baseline", 2500)
	if _, err := appendStreamingFleet(t, s, "stream-baseline", 1, 1, 10); err != nil {
		t.Fatal(err)
	}
	startStreamingFleet(t, s, "stream-baseline")
	result := waitFleetTerminal(t, m, "stream-baseline")
	if result.State != "not_sent" || !strings.Contains(result.Error, "VALID 33, VOID 0") || !fleetProvenUnsent(result.Receipt) {
		t.Fatal(result.State, result.Error)
	}
	if _, err := appendStreamingFleet(t, s, "stream-baseline", 2, 11, 20); err == nil || !strings.Contains(err.Error(), "VALID 33") {
		t.Fatal("baseline reason lost", err)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.accepted != 0 {
		t.Fatal("baseline rejection printed labels")
	}
}
