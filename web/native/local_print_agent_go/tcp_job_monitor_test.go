package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type monitoredPrinter struct {
	mu      sync.Mutex
	events  []string
	bits    atomic.Uint32
	dials   atomic.Int32
	queries atomic.Int32
	labels  atomic.Int32
	jobID   string
	capture bool
	write   bool
	void    bool
	silent  bool
}

func (p *monitoredPrinter) dial(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
	p.dials.Add(1)
	client, peer := net.Pipe()
	go func() {
		defer peer.Close()
		scanner := bufio.NewScanner(peer)
		for scanner.Scan() {
			command := scanner.Text()
			p.mu.Lock()
			p.events = append(p.events, command)
			p.mu.Unlock()
			switch {
			case command == "~HQES":
				p.queries.Add(1)
				if !p.silent {
					bits := p.bits.Load()
					health := serviceHqes(fmt.Sprintf("%08X", bits))
					if bits == 0 {
						health = strings.Replace(health, "ERRORS: 1", "ERRORS: 0", 1)
					}
					io.WriteString(peer, health)
				}
			case command == "~HS":
				io.WriteString(peer, recoveryHS("000"))
			case rfidCounterName(command) != "":
				value := p.labels.Load()
				if rfidCounterName(command) == "void" {
					value = 0
				}
				fmt.Fprintf(peer, "\"%d\"\r\n", value)
			case strings.HasPrefix(command, "LABEL"):
				ordinal := p.labels.Add(1)
				if p.capture {
					value := fmt.Sprintf("%08X", ordinal)
					if p.void && ordinal == 2 {
						value = ""
					}
					// Deliberately split a host frame across writes. The status
					// consumer must never take ownership away from the collector.
					frame := fmt.Sprintf("NWEP|%s|%d|%s|END\r\n", p.jobID, ordinal, value)
					if p.write {
						frame = fmt.Sprintf("NWEP|%s|%d|W|%s|%s|END\r\n", p.jobID, ordinal, value, value)
					}
					io.WriteString(peer, frame[:len(frame)/2])
					io.WriteString(peer, frame[len(frame)/2:])
				}
			}
		}
	}()
	return client, "simulated", nil
}

func monitorTestManager(t *testing.T, p *monitoredPrinter) *tcpJobManager {
	t.Helper()
	m := newTCPJobManagerWithDialAndQueue(p.dial, newPrinterTargetQueue())
	if m.monitorInterval <= 0 || m.monitorTimeout <= 0 {
		t.Fatal("production monitor defaults disabled")
	}
	m.monitorInterval = 10 * time.Millisecond
	m.monitorTimeout = 150 * time.Millisecond
	m.captureDir = t.TempDir()
	t.Cleanup(m.close)
	return m
}

func awaitMonitor(t *testing.T, s *tcpJobSession) {
	t.Helper()
	s.mu.Lock()
	done := s.monitorDone
	s.mu.Unlock()
	if done == nil {
		t.Fatal("monitor was not started")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("monitor did not terminate")
	}
}

func TestBackgroundMonitorStopsServiceFaultWithoutUIRequests(t *testing.T) {
	for _, mode := range []string{"none", "read", "write", "read_write"} {
		capture := mode != "none"
		for _, fault := range []struct {
			bits   uint32
			reason string
		}{{1, "Media out"}, {2, "Ribbon out"}, {4, "Printhead open"}} {
			t.Run(fmt.Sprintf("mode=%s/%s", mode, fault.reason), func(t *testing.T) {
				p := &monitoredPrinter{jobID: "background-fault", capture: capture, write: strings.Contains(mode, "write")}
				p.bits.Store(fault.bits)
				m := monitorTestManager(t, p)
				var options *rfidCaptureOptions
				if capture {
					options = &rfidCaptureOptions{ExpectedLabels: 20, FirstRow: 1, RowStep: 1, Bank: "EPC", OperationMode: mode, AuditBatchCounters: true}
				}
				_, err := m.open(context.Background(), "owner", p.jobID, "simulated", 9100, time.Second, time.Second, time.Minute, options)
				if err != nil {
					t.Fatal(err)
				}
				if capture {
					for _, command := range auditQueries {
						if _, err := m.queryContext(context.Background(), "owner", p.jobID, []byte(command), time.Second, time.Millisecond); err != nil {
							t.Fatal(err)
						}
					}
				}
				payload := []byte("LABEL 1\n")
				receipt, err := m.append("owner", p.jobID, 1, payload, payloadDigest(payload))
				if err != nil {
					t.Fatal(err)
				}
				s, _ := m.lookup("owner", p.jobID)
				// No HTTP/query/poll call after the label submission. Only the
				// connector worker can discover the fault and preserve this run.
				awaitMonitor(t, s)
				s.mu.Lock()
				result := s.resultLocked()
				s.mu.Unlock()
				if result.State != "uncertain" || result.ServiceFault != fault.reason || !result.FaultClearRequested {
					t.Fatalf("fault not stopped: %+v", result)
				}
				if capture && (result.Capture.State != "interrupted" || result.Capture.UniqueLabels != 1 || result.Capture.Audit.ValidDelta != 1) {
					t.Fatalf("saved evidence lost: %+v", result.Capture)
				}
				if p.dials.Load() != 1 {
					t.Fatal("monitor opened another printer connection")
				}
				_, err = m.append("owner", p.jobID, 2, payload, payloadDigest(payload))
				apiErr := requireAPIErrorCode(t, err, "TCP_JOB_SERVICE_FAULT")
				if apiErr.ServiceFault != fault.reason || !apiErr.FaultClearRequested {
					t.Fatal("HTTP fault metadata lost")
				}
				if result.CumulativeBytes != receipt.CumulativeBytes || result.NextSequence != 2 {
					t.Fatal("monitor changed print checkpoints")
				}
				p.mu.Lock()
				events := strings.Join(p.events, "|")
				p.mu.Unlock()
				if strings.Count(events, "~PP") != 1 || strings.Count(events, "~JA") != 1 || strings.Count(events, "LABEL") != 1 {
					t.Fatal("cancel/replay mismatch", events)
				}
				_, err = m.open(context.Background(), "owner", "background-next", "simulated", 9100, time.Second, time.Second, time.Minute)
				requireAPIErrorCode(t, err, "TCP_JOB_SERVICE_NOT_READY")
				p.bits.Store(0)
				if _, err = m.open(context.Background(), "owner", "background-next", "simulated", 9100, time.Second, time.Second, time.Minute); err != nil {
					t.Fatal("repaired empty printer blocked", err)
				}
			})
		}
	}
}

func TestBackgroundMonitorSharesReaderWithConcurrentQueriesAndVoid(t *testing.T) {
	p := &monitoredPrinter{jobID: "background-void", capture: true, void: true}
	m := monitorTestManager(t, p)
	_, err := m.open(context.Background(), "owner", p.jobID, "simulated", 9100, time.Second, time.Second, time.Minute,
		&rfidCaptureOptions{ExpectedLabels: 3, FirstRow: 1, RowStep: 1, Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	var receipt tcpJobResult
	for i := 1; i <= 3; i++ {
		payload := []byte(fmt.Sprintf("LABEL %d\n", i))
		receipt, err = m.append("owner", p.jobID, i, payload, payloadDigest(payload))
		if err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	errors := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := m.queryContext(context.Background(), "owner", p.jobID, []byte("~HS\r\n"), time.Second, time.Millisecond)
			errors <- err
		}()
	}
	wg.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(time.Second)
	for p.queries.Load() < 2 {
		if time.Now().After(deadline) {
			t.Fatal("background status was not queried")
		}
		time.Sleep(time.Millisecond)
	}
	s, _ := m.lookup("owner", p.jobID)
	s.mu.Lock()
	snapshot := s.resultLocked()
	s.mu.Unlock()
	if snapshot.State != "open" || snapshot.ServiceFault != "" || snapshot.Capture.Received != 3 || snapshot.Capture.UniqueLabels != 2 || snapshot.Capture.InvalidReads != 1 {
		t.Fatalf("VOID corrupted monitor/capture: %+v", snapshot)
	}
	finished, err := m.finish("owner", p.jobID, 3, receipt.CumulativeBytes, receipt.CheckpointHash)
	if err != nil || finished.State != "finished" {
		t.Fatal(finished, err)
	}
	awaitMonitor(t, s)
	p.mu.Lock()
	events := strings.Join(p.events, "|")
	p.mu.Unlock()
	if strings.Contains(events, "~JA") || strings.Contains(events, "~PP") || p.dials.Load() != 1 {
		t.Fatal("isolated VOID caused cancellation/second socket", events)
	}
}

func TestBackgroundMonitorDoesNotExtendOwnerLeaseAndExpiryClears(t *testing.T) {
	p := &monitoredPrinter{jobID: "background-expiry"}
	m := monitorTestManager(t, p)
	_, err := m.open(context.Background(), "owner", p.jobID, "simulated", 9100, time.Second, time.Second, 80*time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("LABEL 1\n")
	if _, err = m.append("owner", p.jobID, 1, payload, payloadDigest(payload)); err != nil {
		t.Fatal(err)
	}
	s, _ := m.lookup("owner", p.jobID)
	awaitMonitor(t, s)
	s.mu.Lock()
	result := s.resultLocked()
	s.mu.Unlock()
	if result.State != "expired" || !result.FaultClearRequested || result.ServiceFault != "Host print session idle timeout" || p.queries.Load() < 2 {
		t.Fatalf("monitor renewed lease or expiry did not clear: %+v", result)
	}
}

func TestBackgroundMonitorTimeoutAndShutdownAreBounded(t *testing.T) {
	p := &monitoredPrinter{jobID: "background-timeout", silent: true}
	m := monitorTestManager(t, p)
	_, err := m.open(context.Background(), "owner", p.jobID, "simulated", 9100, time.Second, time.Second, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("LABEL 1\n")
	if _, err = m.append("owner", p.jobID, 1, payload, payloadDigest(payload)); err != nil {
		t.Fatal(err)
	}
	s, _ := m.lookup("owner", p.jobID)
	awaitMonitor(t, s)
	s.mu.Lock()
	result := s.resultLocked()
	s.mu.Unlock()
	if result.State != "uncertain" || !result.FaultClearRequested {
		t.Fatalf("unavailable monitor left queued job resumable: %+v", result)
	}
	start := time.Now()
	m.close()
	if time.Since(start) > time.Second {
		t.Fatal("shutdown did not join monitor")
	}
	_, err = m.open(context.Background(), "owner", "closed-manager", "simulated", 9100, time.Second, time.Second, time.Minute)
	requireAPIErrorCode(t, err, "TCP_JOB_MANAGER_CLOSED")
}

func TestBackgroundMonitorShutdownStopsActiveCapture(t *testing.T) {
	p := &monitoredPrinter{jobID: "background-shutdown", capture: true}
	m := monitorTestManager(t, p)
	_, err := m.open(context.Background(), "owner", p.jobID, "simulated", 9100, time.Second, time.Second, time.Minute,
		&rfidCaptureOptions{ExpectedLabels: 10, FirstRow: 1, RowStep: 1, Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("LABEL 1\n")
	if _, err = m.append("owner", p.jobID, 1, payload, payloadDigest(payload)); err != nil {
		t.Fatal(err)
	}
	s, _ := m.lookup("owner", p.jobID)
	m.close()
	awaitMonitor(t, s)
	s.mu.Lock()
	result := s.resultLocked()
	s.mu.Unlock()
	if result.State != "aborted" || !result.FaultClearRequested || result.Capture.State != "interrupted" || result.Capture.UniqueLabels != 1 {
		t.Fatalf("shutdown lost capture or left work queued: %+v", result)
	}
	p.mu.Lock()
	events := strings.Join(p.events, "|")
	p.mu.Unlock()
	if strings.Count(events, "~PP") != 1 || strings.Count(events, "~JA") != 1 {
		t.Fatal(events)
	}
}

func TestTCPJobShutdownCancelsDialAndNeverReopens(t *testing.T) {
	started := make(chan struct{})
	m := newTCPJobManagerWithDial(func(ctx context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		close(started)
		<-ctx.Done()
		return nil, "", ctx.Err()
	})
	result := make(chan error, 1)
	go func() {
		_, err := m.open(context.Background(), "owner", "shutdown-opening", "simulated", 9100, time.Minute, time.Second, time.Minute)
		result <- err
	}()
	<-started
	m.close()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("shutdown reopened a printer socket")
		}
	case <-time.After(time.Second):
		t.Fatal("shutdown did not cancel active dial")
	}
	active, _ := m.stats()
	if active != 0 {
		t.Fatal("opening session survived shutdown")
	}
}
