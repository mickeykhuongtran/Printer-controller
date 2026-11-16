package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func reconciliationFormat(job string, ordinal int) string {
	return fmt.Sprintf("^XA\n^FH_^HV1,256,NWEP|%s|%d|,|END_0D_0A,L^FS\n^PQ1\n^XZ\n", job, ordinal)
}

type reconciliationPrinter struct {
	mu         sync.Mutex
	events     []string
	samples    [][3]int64
	round      int
	submitted  bool
	queue      string
	badCounter string
}

func (p *reconciliationPrinter) dial(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
	client, peer := net.Pipe()
	go func() {
		defer peer.Close()
		scanner := bufio.NewScanner(peer)
		for scanner.Scan() {
			command := scanner.Text()
			p.mu.Lock()
			p.events = append(p.events, command)
			p.mu.Unlock()
			switch command {
			case "^XZ":
				p.submitted = true
			case "~HQES":
				io.WriteString(peer, serviceHqes("00010004"))
			case "~HS":
				host := recoveryHS("000")
				if p.submitted && p.queue != "" {
					host = p.queue
				}
				io.WriteString(peer, host)
			default:
				name := rfidCounterName(command)
				if name == "" {
					continue
				}
				value := [3]int64{100, 4, 200}
				if p.submitted {
					if name == "valid" {
						p.round++
					}
					value = p.samples[min(p.round-1, len(p.samples)-1)]
				}
				if p.submitted && name == p.badCounter {
					io.WriteString(peer, "\"?\"\r\n")
					continue
				}
				index := map[string]int{"valid": 0, "void": 1, "total": 2}[name]
				fmt.Fprintf(peer, "\"%d\"\r\n", value[index])
			}
		}
	}()
	return client, "simulated", nil
}

func runReconciliationTest(t *testing.T, printer *reconciliationPrinter, foreground bool, mutate func(*tcpJobSession)) rfidCaptureSummary {
	t.Helper()
	const id = "reconciliation-partial"
	m := newTCPJobManagerWithDialAndQueue(printer.dial, newPrinterTargetQueue())
	m.captureDir, m.monitorInterval, m.monitorTimeout = t.TempDir(), 5*time.Millisecond, time.Second
	if foreground {
		m.monitorInterval = time.Hour
	}
	t.Cleanup(m.close)
	_, err := m.open(context.Background(), "owner", id, "printer", 9100, time.Second, time.Second, time.Minute,
		&rfidCaptureOptions{ExpectedLabels: 2500, FirstRow: 1, RowStep: 1, Bank: "EPC", AuditBatchCounters: true})
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range auditQueries {
		if _, err := m.queryContext(context.Background(), "owner", id, []byte(command), time.Second, time.Millisecond); err != nil {
			t.Fatal(err)
		}
	}
	var payload strings.Builder
	for n := 1; n <= 2500; n++ {
		payload.WriteString(reconciliationFormat(id, n))
	}
	data := []byte(payload.String())
	if _, err := m.append("owner", id, 1, data, payloadDigest(data)); err != nil {
		t.Fatal(err)
	}
	session, _ := m.lookup("owner", id)
	if mutate != nil {
		session.mu.Lock()
		mutate(session)
		session.mu.Unlock()
	}
	if foreground {
		if _, err := m.queryContext(context.Background(), "owner", id, []byte("~HQES\r\n"), time.Second, time.Millisecond); err != nil {
			t.Fatal(err)
		}
		if _, err := m.abort("owner", id); err != nil {
			t.Fatal(err)
		}
	}
	awaitMonitor(t, session)
	summary := session.capture.snapshot()
	if summary.State != "interrupted" {
		t.Fatalf("must preserve physical interruption: %+v", summary)
	}
	if mutate == nil {
		data, err := os.ReadFile(filepath.Join(captureDirectory(m.captureDir, "owner", id), "manifest.json"))
		if err != nil {
			t.Fatal(err)
		}
		var saved rfidCaptureManifest
		if err := json.Unmarshal(data, &saved); err != nil {
			t.Fatal(err)
		}
		if hasReconciledRfidCounters(saved.Summary) != hasReconciledRfidCounters(*summary) {
			t.Fatal("proof not durable")
		}
	}
	printer.mu.Lock()
	events := strings.Join(printer.events, "|")
	printer.mu.Unlock()
	if strings.Count(events, "~PP") != 1 || strings.Count(events, "~JA") != 1 || strings.Count(events, "^XZ") != 2500 {
		t.Fatal("clear/replay changed", events[:min(200, len(events))])
	}
	return *summary
}

func TestServiceFaultCounterReconciliationPartial1250WithVoid(t *testing.T) {
	for _, foreground := range []bool{false, true} {
		t.Run(fmt.Sprint("foreground=", foreground), func(t *testing.T) {
			p := &reconciliationPrinter{samples: [][3]int64{{1348, 6, 1450}, {1348, 6, 1450}}}
			s := runReconciliationTest(t, p, foreground, nil)
			if !hasReconciledRfidCounters(s) || s.Audit.State != "reconciled" || s.Audit.ValidDelta != 1248 || s.Audit.VoidDelta != 2 {
				t.Fatalf("partial run not final: %+v", s)
			}
			if s.UniqueLabels != 0 || s.Received != 0 {
				t.Fatal("invented EPC records")
			}
			if s.Options.ExpectedLabels != 2500 || s.Audit.SubmittedAttempts != 2500 {
				t.Fatal("rewrote requested or submitted quantity")
			}
		})
	}
}

func TestServiceFaultCounterReconciliationSettlesTail(t *testing.T) {
	p := &reconciliationPrinter{samples: [][3]int64{{1347, 6, 1449}, {1348, 6, 1450}, {1348, 6, 1450}}}
	s := runReconciliationTest(t, p, true, nil)
	if !hasReconciledRfidCounters(s) || s.Audit.ValidDelta != 1248 || p.round != 3 {
		t.Fatalf("tail lost: %+v", s)
	}
}

func TestServiceFaultCounterReconciliationRejectsUnreliableEvidence(t *testing.T) {
	for _, tc := range []struct {
		name string
		p    *reconciliationPrinter
	}{
		{"unstable", &reconciliationPrinter{samples: [][3]int64{{1346, 6, 1448}, {1347, 6, 1449}, {1348, 6, 1450}}}},
		{"reset_above_baseline", &reconciliationPrinter{samples: [][3]int64{{1348, 6, 1450}, {1347, 6, 1450}, {1347, 6, 1450}}}},
		{"reset_below_baseline", &reconciliationPrinter{samples: [][3]int64{{2, 0, 1450}}}},
		{"beyond_submitted", &reconciliationPrinter{samples: [][3]int64{{2601, 4, 2701}}}},
		{"missing_counter", &reconciliationPrinter{samples: [][3]int64{{1348, 6, 1450}}, badCounter: "void"}},
		{"queue_not_empty", &reconciliationPrinter{samples: [][3]int64{{1348, 6, 1450}}, queue: recoveryHS("019")}},
		{"not_paused", &reconciliationPrinter{samples: [][3]int64{{1348, 6, 1450}}, queue: strings.Replace(recoveryHS("000"), ",0,1,0251,", ",0,0,0251,", 1)}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := runReconciliationTest(t, tc.p, true, nil)
			if hasReconciledRfidCounters(s) || s.Audit.State == "reconciled" {
				t.Fatalf("false finality: %+v", s)
			}
		})
	}
}

func TestSubmittedRfidFormatsTrackOnlyPhysicalSingleLabelFormats(t *testing.T) {
	c := &rfidCapture{summary: rfidCaptureSummary{JobID: "test-job", Options: rfidCaptureOptions{ExpectedLabels: 3}}}
	payload := reconciliationFormat("test-job", 1) + reconciliationFormat("test-job", 2)
	for _, part := range []string{payload[:2], payload[2:29], payload[29 : len(payload)-2], payload[len(payload)-2:]} {
		c.submitted(1, []byte(part))
	}
	if c.summary.Audit.SubmittedAttempts != 2 || !c.summary.Audit.SubmittedAttemptsKnown {
		t.Fatal(c.summary.Audit)
	}
	c.submitted(2, []byte(strings.Replace(reconciliationFormat("test-job", 3), "^PQ1", "^PQ2", 1)))
	if c.summary.Audit.SubmittedAttemptsKnown {
		t.Fatal("multi-copy format was accepted")
	}
}

func TestReconciledCounterProofInvalidatesOnEvidenceChange(t *testing.T) {
	p := &reconciliationPrinter{samples: [][3]int64{{1348, 6, 1450}}}
	base := runReconciliationTest(t, p, true, nil)
	for _, mutate := range []func(*rfidCaptureSummary){
		func(s *rfidCaptureSummary) { s.Audit.Latest.Valid++ },
		func(s *rfidCaptureSummary) { s.Audit.Latest.At = time.Now().UTC().Format(time.RFC3339Nano) },
		func(s *rfidCaptureSummary) { s.Audit.LastSubmittedSequence++ },
		func(s *rfidCaptureSummary) { s.Audit.CounterResetObserved = true },
		func(s *rfidCaptureSummary) { s.Error = "disk failure" },
		func(s *rfidCaptureSummary) { s.UniqueLabels = 1300 },
		func(s *rfidCaptureSummary) { s.Audit.SubmittedAttempts = 1000 },
		func(s *rfidCaptureSummary) { markRfidCrashInterrupted(s) },
	} {
		s := base
		mutate(&s)
		if hasReconciledRfidCounters(s) {
			t.Fatal("stale proof accepted", s)
		}
	}
}

func TestServiceFaultCounterReconciliationNeverFinalizesStorageFailure(t *testing.T) {
	p := &reconciliationPrinter{samples: [][3]int64{{1348, 6, 1450}}}
	s := runReconciliationTest(t, p, true, func(session *tcpJobSession) {
		path := filepath.Join(t.TempDir(), "not-a-directory")
		if err := os.WriteFile(path, []byte("storage fault"), 0600); err != nil {
			t.Fatal(err)
		}
		session.capture.mu.Lock()
		session.capture.dir = path
		session.capture.mu.Unlock()
	})
	if hasReconciledRfidCounters(s) || s.Error == "" {
		t.Fatal("storage failure sealed", s)
	}
}

func TestServiceFaultCounterReconciliationHonorsCancellation(t *testing.T) {
	p := &reconciliationPrinter{samples: [][3]int64{{1348, 6, 1450}}}
	start := time.Now()
	s := runReconciliationTest(t, p, true, func(session *tcpJobSession) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		session.monitorContext = ctx
	})
	if hasReconciledRfidCounters(s) || time.Since(start) > time.Second {
		t.Fatal("cancelled proof collection did not stop", s)
	}
}

func TestCounterRegressionLatchSurvivesLaterGrowthAndSequenceChanges(t *testing.T) {
	c := &rfidCapture{dir: t.TempDir(), summary: rfidCaptureSummary{Options: rfidCaptureOptions{AuditBatchCounters: true}}}
	for i, count := range []int{100, 4, 200} {
		if err := c.recordCounter(auditQueries[i], fmt.Sprintf(`"%d"`, count), 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	for _, row := range []struct {
		seq    int
		values [3]int
	}{{1, [3]int{150, 10, 260}}, {2, [3]int{160, 8, 270}}, {3, [3]int{180, 20, 300}}} {
		c.summary.Audit.LastSubmittedSequence = row.seq
		for i, count := range row.values {
			if err := c.recordCounter(auditQueries[i], fmt.Sprintf(`"%d"`, count), 100, row.seq); err != nil {
				t.Fatal(err)
			}
		}
	}
	if !c.summary.Audit.CounterResetObserved || c.summary.Audit.CountsKnown {
		t.Fatal("counter reset was forgotten", c.summary.Audit)
	}
}
