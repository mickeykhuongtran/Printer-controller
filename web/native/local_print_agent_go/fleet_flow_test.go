package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// A printer that receives independently of its physical print cadence. Unlike
// immediate-response fixtures it detects drain/refill gaps and excess lookahead.
type flowingPrinter struct {
	mu                                     sync.Mutex
	writeMu                                sync.Mutex
	queue                                  []string
	accepted, printed, maxPending, starved int
	paused, cleared                        bool
	commands                               []string
}

func (p *flowingPrinter) dial(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
	client, peer := net.Pipe()
	done := make(chan struct{})
	write := func(s string) { p.writeMu.Lock(); defer p.writeMu.Unlock(); _, _ = io.WriteString(peer, s) }
	go func() {
		timer := time.NewTicker(15 * time.Millisecond)
		defer timer.Stop()
		for {
			select {
			case <-done:
				return
			case <-timer.C:
				p.mu.Lock()
				frame := ""
				if !p.paused && len(p.queue) > 0 {
					frame = p.queue[0]
					p.queue = p.queue[1:]
					p.printed++
				}
				p.mu.Unlock()
				if frame != "" {
					write(frame)
				}
			}
		}
	}()
	go func() {
		defer close(done)
		defer peer.Close()
		scanner := bufio.NewScanner(peer)
		frame := ""
		for scanner.Scan() {
			line := scanner.Text()
			if capture := submittedCapturePattern.FindStringSubmatch(line); len(capture) == 3 {
				frame = fmt.Sprintf("NWEP|%s|%s|%024s|END\r\n", capture[1], capture[2], capture[2])
			}
			p.mu.Lock()
			out := ""
			switch {
			case line == "^XZ":
				if p.accepted > 0 && len(p.queue) == 0 && !p.paused && !p.cleared {
					p.starved++
				}
				p.accepted++
				p.queue = append(p.queue, frame)
				p.maxPending = max(p.maxPending, len(p.queue))
			case line == "~HS":
				out = recoveryHS(fmt.Sprintf("%03d", len(p.queue)))
				if !p.paused {
					out = strings.Replace(out, "000,0,1,0251,", "000,0,0,0251,", 1)
				}
			case line == "~HQES":
				out = strings.Replace(serviceHqes("00000000"), "ERRORS: 1", "ERRORS: 0", 1)
			case line == "~PP":
				p.paused = true
				p.commands = append(p.commands, line)
			case line == "~PS":
				p.paused = false
				p.commands = append(p.commands, line)
			case line == "~JA":
				p.queue = nil
				p.cleared = true
				p.commands = append(p.commands, line)
			case rfidCounterName(line) != "":
				v := p.printed
				if rfidCounterName(line) == "void" {
					v = 0
				}
				out = fmt.Sprintf("\"%d\"\r\n", v)
			}
			p.mu.Unlock()
			if out != "" {
				write(out)
			}
		}
	}()
	return client, "simulated", nil
}

func stageFlowJob(t *testing.T, m *tcpJobManager, id string, total int, zero bool) (*appServer, fleetSpool) {
	t.Helper()
	s := &appServer{tcpJobs: m, allowedTCPPorts: map[int]struct{}{9100: {}}}
	p, err := fleetCall(t, s, tcpJobRequest{Action: "spool-create", JobID: id, Host: "192.0.2.1", WindowLabels: 20, Capture: &rfidCaptureOptions{AuditBatchCounters: true, RequireZeroBaseline: zero, ExpectedLabels: total, FirstRow: 1, RowStep: 1, Bank: "EPC"}})
	if err != nil {
		t.Fatal(err)
	}
	for first, seq := 1, 1; first <= total; first, seq = first+10, seq+1 {
		data := ""
		for i := first; i < min(first+10, total+1); i++ {
			data += reconciliationFormat(id, i)
		}
		encoded := base64.StdEncoding.EncodeToString([]byte(data))
		sequence := float64(seq)
		p, err = fleetCall(t, s, tcpJobRequest{Action: "spool-append", JobID: id, Sequence: &sequence, PayloadBase64: &encoded, PayloadSHA256: payloadDigest([]byte(data))})
		if err != nil {
			t.Fatal(err)
		}
	}
	sequence, size := float64((total+9)/10), float64(p.Bytes)
	_, err = fleetCall(t, s, tcpJobRequest{Action: "spool-commit", JobID: id, ExpectedSequence: &sequence, ExpectedBytes: &size, CheckpointHash: p.Checkpoint})
	if err != nil {
		t.Fatal(err)
	}
	return s, p
}

func waitFleetTerminal(t *testing.T, m *tcpJobManager, id string) fleetSpool {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		m.spoolMu.Lock()
		p := *m.spools[tcpJobMapKey("owner", id)]
		m.spoolMu.Unlock()
		if !fleetActive(p.State) {
			return p
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("fleet did not stop")
	return fleetSpool{}
}

func TestFleetSlidingWindowContinuousAndBounded(t *testing.T) {
	p := &flowingPrinter{}
	m := newTCPJobManagerWithDialAndQueue(p.dial, newPrinterTargetQueue())
	m.captureDir = t.TempDir()
	m.monitorInterval = 0
	defer m.close()
	stageFlowJob(t, m, "flow-continuous", 200, true)
	r := waitFleetTerminal(t, m, "flow-continuous")
	if r.State != "done" {
		t.Fatalf("%s: %s", r.State, r.Error)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.printed != 200 || p.accepted != 200 || p.maxPending > 20 || p.maxPending < 11 || p.starved != 0 {
		t.Fatalf("printed=%d accepted=%d maxPending=%d starvation=%d", p.printed, p.accepted, p.maxPending, p.starved)
	}
}

func TestFleetCancelStopsHostAndClearsOnlyThisPrinter(t *testing.T) {
	p := &flowingPrinter{}
	m := newTCPJobManagerWithDialAndQueue(p.dial, newPrinterTargetQueue())
	m.captureDir = t.TempDir()
	m.monitorInterval = 0
	defer m.close()
	s, _ := stageFlowJob(t, m, "flow-cancel", 2500, true)
	deadline := time.Now().Add(5 * time.Second)
	for {
		p.mu.Lock()
		n := p.printed
		p.mu.Unlock()
		if n >= 15 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("never printed")
		}
		time.Sleep(10 * time.Millisecond)
	}
	start := time.Now()
	if _, err := fleetCall(t, s, tcpJobRequest{Action: "spool-cancel", JobID: "flow-cancel"}); err != nil {
		t.Fatal(err)
	}
	r := waitFleetTerminal(t, m, "flow-cancel")
	if r.State != "cancelled" || !hasReconciledRfidCounters(*r.Receipt.Capture) {
		t.Fatalf("stop proof: %s %s %+v", r.State, r.Error, r.Receipt)
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("cancel was not prompt")
	}
	p.mu.Lock()
	n, accepted, queued, paused, commands := p.printed, p.accepted, len(p.queue), p.paused, strings.Join(p.commands, ",")
	p.mu.Unlock()
	if n >= 2500 || accepted > n+20 || queued != 0 || !paused || !strings.Contains(commands, "~PP,~JA") {
		t.Fatal("stop did not clear bounded FIFO", n, accepted, queued, paused, commands)
	}
	if err := m.checkSpoolAdmission("owner", "next", "192.0.2.1", 9100); err != nil {
		t.Fatal("stale fleet lock", err)
	}
	// No restart: explicitly resume and print an adjusted next run.
	if _, _, err := m.activeExchange(context.Background(), "192.0.2.1", 9100, []byte("~PS\r\n"), 0, 0); err != nil {
		t.Fatal(err)
	}
	p.mu.Lock()
	p.paused = false
	p.mu.Unlock()
	stageFlowJob(t, m, "after-cancel", 3, false)
	if next := waitFleetTerminal(t, m, "after-cancel"); next.State != "done" {
		t.Fatal(next.State, next.Error)
	}
}

func TestFleetBaselineRejectionReleasesWithoutRestart(t *testing.T) {
	p := &lifecyclePrinter{job: "zero-required", unpaused: true}
	m := newTCPJobManagerWithDialAndQueue(p.dial, newPrinterTargetQueue())
	m.captureDir = t.TempDir()
	m.monitorInterval = 0
	defer m.close()
	stageFlowJob(t, m, p.job, 3, true)
	r := waitFleetTerminal(t, m, p.job)
	if r.State != "not_sent" || !fleetProvenUnsent(r.Receipt) || p.labels.Load() != 0 {
		t.Fatal(r.State, r.Error)
	}
	if err := m.checkSpoolAdmission("owner", "next", "192.0.2.1", 9100); err != nil {
		t.Fatal(err)
	}
	// Reproduce the 3.9.0 retained state and verify narrow migration on restart.
	r.State = "needs_review"
	if err := m.saveSpool(&r); err != nil {
		t.Fatal(err)
	}
	fresh := newTCPJobManager()
	fresh.captureDir = m.captureDir
	defer fresh.close()
	if err := fresh.checkSpoolAdmission("owner", "next", "192.0.2.1", 9100); err != nil {
		t.Fatal("known-unsent upgrade remained locked", err)
	}
}

func TestFleetCapacityRejectsFullPausedPartialAndMalformed(t *testing.T) {
	ready := strings.Replace(recoveryHS("005"), "000,0,1,0251,", "000,0,0,0251,", 1)
	for name, response := range map[string]string{
		"room":     ready,
		"full":     strings.Replace(ready, "0251,005,0,0,0,", "0251,005,1,0,0,", 1),
		"partial":  strings.Replace(ready, "0251,005,0,0,0,", "0251,005,0,0,1,", 1),
		"too-many": strings.Replace(ready, "0251,005,", "0251,015,", 1),
		"paused":   recoveryHS("005"),
		"invalid":  "malformed status",
	} {
		t.Run(name, func(t *testing.T) {
			room, paused, err := fleetHostCapacity(response, 10, 20)
			allowed := room && !paused && err == nil
			if allowed != (name == "room") {
				t.Fatalf("capacity=%v paused=%v err=%v", room, paused, err)
			}
		})
	}
}

func TestQuarantinedPrinterStillAllowsReadOnlyStatus(t *testing.T) {
	p := &lifecyclePrinter{job: "quarantined", unpaused: true}
	m := newTCPJobManagerWithDialAndQueue(p.dial, newPrinterTargetQueue())
	defer m.close()
	m.jobs["stopped"] = &tcpJobSession{owner: "owner", jobID: "stopped", host: "192.0.2.1", port: 9100, state: "uncertain", cumulativeBytes: 100}
	r, handled, err := m.activeExchange(context.Background(), "192.0.2.1", 9100, []byte("~HS\r\n"), time.Second, time.Second)
	if err != nil || !handled || !completeZebraStatusResponse("~HS", r.response) {
		t.Fatal(handled, err, r.response)
	}
	if m.jobs["stopped"].reconciled || p.labels.Load() != 0 {
		t.Fatal("diagnostics unlocked or printed")
	}
	if _, handled, err = m.activeExchange(context.Background(), "192.0.2.1", 9100, []byte("~PS\r\n"), 0, 0); !handled || err == nil {
		t.Fatal("quarantine permitted mutation")
	}
}

func TestControlWaitDoesNotHoldFleetManagerLock(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	s := &tcpJobSession{owner: "owner", jobID: "busy", host: "192.0.2.1", port: 9100, state: "uncertain"}
	m.jobs["busy"] = s
	s.mu.Lock()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, _ = m.activeExchange(context.Background(), s.host, s.port, []byte("~PS"), 0, 0)
	}()
	// The request waits on this printer's I/O lock, never on the fleet lock.
	time.Sleep(25 * time.Millisecond)
	other := make(chan struct{})
	go func() { m.stats(); close(other) }()
	select {
	case <-other:
	case <-time.After(200 * time.Millisecond):
		s.mu.Unlock()
		<-done
		t.Fatal("control request blocked all printers")
	}
	s.mu.Unlock()
	<-done
}
