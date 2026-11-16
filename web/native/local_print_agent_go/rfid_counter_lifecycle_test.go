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
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

type lifecyclePrinter struct {
	headOpen        bool
	unpaused        bool
	mu              sync.Mutex
	events          []string
	labels          atomic.Int32
	dials           atomic.Int32
	job             string
	badBaseline     string
	badFinal        string
	disconnectFinal bool
	dirty           bool
	reset           bool
	extra           int64
	missingRead     bool
	peer            net.Conn
	readError       error
}

type lifecycleReadErrorConn struct {
	net.Conn
	readError error
}

func (c *lifecycleReadErrorConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if err != nil {
		return n, c.readError
	}
	return n, nil
}

func (p *lifecyclePrinter) dial(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
	p.dials.Add(1)
	client, peer := net.Pipe()
	p.peer = peer
	go func() {
		defer peer.Close()
		scanner := bufio.NewScanner(peer)
		for scanner.Scan() {
			command := scanner.Text()
			p.mu.Lock()
			p.events = append(p.events, command)
			p.mu.Unlock()
			switch {
			case command == "~HS":
				queue := "000"
				if p.dirty {
					queue = "003"
				}
				status := recoveryHS(queue)
				if p.unpaused {
					status = strings.Replace(status, "000,0,1,0251,", "000,0,0,0251,", 1)
				}
				if p.headOpen {
					status = strings.Replace(status, "000,0,0,0,1,2,6", "000,0,1,0,1,2,6", 1)
				}
				io.WriteString(peer, status)
			case command == "~HQES":
				io.WriteString(peer, strings.Replace(serviceHqes("00000000"), "ERRORS: 1", "ERRORS: 0", 1))
			case command == "^XZ":
				n := p.labels.Add(1)
				if !p.missingRead {
					fmt.Fprintf(peer, "NWEP|%s|%d|%08X|END\r\n", p.job, n, n)
				}
			case rfidCounterName(command) != "":
				name := rfidCounterName(command)
				n := int64(p.labels.Load())
				if n > 0 && p.disconnectFinal {
					return
				}
				if (n == 0 && name == p.badBaseline) || (n > 0 && name == p.badFinal) {
					io.WriteString(peer, "\"?\"\r\n")
					continue
				}
				value := int64(100) + n + p.extra
				if name == "void" {
					value = 7
				}
				if name == "total" {
					value = 200 + n
				}
				if n == 0 && name == "valid" {
					value = 100
				}
				if n > 0 && p.reset && name == "valid" {
					value = 2
				}
				// Fragmented quoted response, with trailing CRLF on its own write.
				io.WriteString(peer, "\"")
				fmt.Fprintf(peer, "%d\"", value)
				io.WriteString(peer, "\r\n")
			}
		}
	}()
	if p.readError != nil {
		return &lifecycleReadErrorConn{Conn: client, readError: p.readError}, "simulated", nil
	}
	return client, "simulated", nil
}

func lifecycleManager(t *testing.T, p *lifecyclePrinter, expected int) (*tcpJobManager, *tcpJobSession) {
	t.Helper()
	m := newTCPJobManagerWithDialAndQueue(p.dial, newPrinterTargetQueue())
	m.captureDir = t.TempDir()
	m.monitorInterval = 0
	t.Cleanup(m.close)
	r, err := m.open(context.Background(), "owner", p.job, "simulated", 9100, time.Second, time.Second, time.Minute, &rfidCaptureOptions{ExpectedLabels: expected, FirstRow: 1, RowStep: 1, Bank: "EPC", AuditBatchCounters: true})
	if err != nil {
		t.Fatal(err)
	}
	if r.Capture.Audit.LifecycleVersion != 1 {
		t.Fatal("ownership missing")
	}
	s, _ := m.lookup("owner", p.job)
	return m, s
}
func lifecycleAppend(t *testing.T, m *tcpJobManager, id string, sequence, start, n int) (tcpJobResult, error) {
	t.Helper()
	var data strings.Builder
	for i := start; i < start+n; i++ {
		data.WriteString(reconciliationFormat(id, i))
	}
	payload := []byte(data.String())
	return m.append("owner", id, sequence, payload, payloadDigest(payload))
}

func TestConnectorCounterLifecycleOwnsBaselineAndFinalWithoutBrowserQueries(t *testing.T) {
	p := &lifecyclePrinter{job: "native-owned"}
	m, s := lifecycleManager(t, p, 3)
	r, err := lifecycleAppend(t, m, p.job, 1, 1, 3)
	if err != nil {
		t.Fatal(err)
	}
	if r.Capture.Audit.Baseline.Valid != 100 || r.Capture.Audit.CountsKnown {
		t.Fatal("baseline/provisional", r.Capture.Audit)
	}
	final, err := m.finish("owner", p.job, 1, r.CumulativeBytes, r.CheckpointHash)
	if err != nil {
		t.Fatal(err)
	}
	if !hasFinalRfidCounterSnapshot(*final.Capture) || !final.Capture.Audit.CountsKnown || final.Capture.Audit.ValidDelta != 3 || final.Capture.Audit.CounterSampleCount != 4 {
		t.Fatalf("final: %+v", final.Capture)
	}
	if final.Capture.Audit.Baseline.Valid != 100 || final.Capture.Audit.Latest.Valid != 103 || p.labels.Load() != 3 || p.dials.Load() != 1 {
		t.Fatal("count/source/replay mismatch")
	}
	data, err := os.ReadFile(filepath.Join(s.capture.dir, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var saved rfidCaptureManifest
	if json.Unmarshal(data, &saved) != nil || !hasFinalRfidCounterSnapshot(saved.Summary) {
		t.Fatal("not durable")
	}
	duplicate, err := m.finish("owner", p.job, 1, r.CumulativeBytes, r.CheckpointHash)
	if err != nil || !duplicate.Deduplicated || p.labels.Load() != 3 {
		t.Fatal("finish replay")
	}
}

func TestConnectorCounterBaselineFailureNeverSendsPayload(t *testing.T) {
	for _, kind := range []string{"invalid_void", "dirty_queue"} {
		t.Run(kind, func(t *testing.T) {
			p := &lifecyclePrinter{job: "baseline-" + kind}
			if kind == "dirty_queue" {
				p.dirty = true
			} else {
				p.badBaseline = "void"
			}
			m, s := lifecycleManager(t, p, 1)
			_, err := lifecycleAppend(t, m, p.job, 1, 1, 1)
			api := requireAPIErrorCode(t, err, "RFID_BASELINE_UNVERIFIED")
			if api.Outcome != "not_sent" || api.BytesWritten != 0 || p.labels.Load() != 0 {
				t.Fatal("unsafe baseline", api)
			}
			if s.capture.snapshot().Audit.FinalizationStatus != "unresolved" {
				t.Fatal("missing reason")
			}
			_, err = lifecycleAppend(t, m, p.job, 1, 1, 1)
			if err == nil || p.labels.Load() != 0 {
				t.Fatal("aborted baseline reused")
			}
			// The failed baseline did not send labels. A fresh job must be
			// admitted immediately without a fictitious physical reconciliation.
			if _, err = m.open(context.Background(), "owner", p.job+"-retry", "simulated", 9100, time.Second, time.Second, time.Minute,
				&rfidCaptureOptions{ExpectedLabels: 1, FirstRow: 1, RowStep: 1, Bank: "EPC", AuditBatchCounters: true}); err != nil {
				t.Fatal("unsent baseline quarantined target", err)
			}
			if p.labels.Load() != 0 || s.state != "aborted" {
				t.Fatal("baseline cleanup submitted labels or left uncertain state")
			}
			if _, err = os.Stat(filepath.Join(s.capture.dir, "manifest.json")); err != nil {
				t.Fatal("failed baseline history lost", err)
			}
			data, err := os.ReadFile(filepath.Join(s.capture.dir, "manifest.json"))
			if err != nil {
				t.Fatal(err)
			}
			var saved rfidCaptureManifest
			if json.Unmarshal(data, &saved) != nil || !hasUnsentRfidAdmission(saved.Summary) {
				t.Fatal("no durable no-payload proof", string(data))
			}
			legacy := saved.Summary
			legacy.Audit.LifecycleVersion = 0
			if hasUnsentRfidAdmission(legacy) {
				t.Fatal("legacy rejected session inferred as zero")
			}
		})
	}
}

func TestConnectorCounterBaselineCleanupCannotReleaseSubmittedRun(t *testing.T) {
	p := &lifecyclePrinter{job: "baseline-release-guard"}
	m, s := lifecycleManager(t, p, 2)
	if _, err := lifecycleAppend(t, m, p.job, 1, 1, 1); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	err := s.baselineAdmissionError(fmt.Errorf("injected invalid baseline cleanup after submission"))
	s.mu.Unlock()
	api := requireAPIErrorCode(t, err, "RFID_BASELINE_UNVERIFIED")
	if api.Outcome != "possibly_sent" || s.state != "uncertain" {
		t.Fatal("submitted run became safely unsent", api)
	}
	if hasUnsentRfidAdmission(*s.capture.snapshot()) || s.capture.snapshot().Audit.AdmissionRejection != nil {
		t.Fatal("submitted run gained no-payload proof")
	}
	_, err = m.open(context.Background(), "owner", "must-stay-quarantined", "simulated", 9100, time.Second, time.Second, time.Minute)
	requireAPIErrorCode(t, err, "TCP_JOB_TARGET_QUARANTINED")
	if p.labels.Load() != 1 || p.dials.Load() != 1 {
		t.Fatal("payload replay or extra socket after uncertain run")
	}
}

func TestConnectorCounterPartialRoundAndDisconnectRetainCheckpoint(t *testing.T) {
	for _, disconnect := range []bool{false, true} {
		t.Run(fmt.Sprint(disconnect), func(t *testing.T) {
			p := &lifecyclePrinter{job: "checkpoint-loss"}
			m, s := lifecycleManager(t, p, 2)
			r, err := lifecycleAppend(t, m, p.job, 1, 1, 1)
			if err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			checkpoint, err := s.sampleCounterRoundLocked(context.Background(), false)
			s.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			p.badFinal = "void"
			p.disconnectFinal = disconnect
			r, err = lifecycleAppend(t, m, p.job, 2, 2, 1)
			if err != nil {
				t.Fatal(err)
			}
			_, err = m.finish("owner", p.job, 2, r.CumulativeBytes, r.CheckpointHash)
			if err == nil {
				t.Fatal("failed final accepted")
			}
			got := s.capture.snapshot()
			if got.Audit.Latest != checkpoint || got.Audit.FinalizationStatus != "unresolved" || got.Audit.CountsKnown || got.UniqueLabels != 2 || p.labels.Load() != 2 || p.dials.Load() != 1 {
				t.Fatalf("evidence lost/mixed/replayed: %+v", got)
			}
			if got.Audit.LastSampleAt != checkpoint.At {
				t.Fatal("partial timestamp became complete")
			}
		})
	}
}

func TestConnectorCounterResetAndAttributionConflictNeverCertify(t *testing.T) {
	for _, kind := range []string{"reset", "extra", "short"} {
		t.Run(kind, func(t *testing.T) {
			p := &lifecyclePrinter{job: "contradiction-" + kind}
			if kind == "reset" {
				p.reset = true
			}
			if kind == "extra" {
				p.extra = 1
			}
			if kind == "short" {
				p.extra = -1
				p.missingRead = true
			}
			m, s := lifecycleManager(t, p, 2)
			r, err := lifecycleAppend(t, m, p.job, 1, 1, 2)
			if err != nil {
				t.Fatal(err)
			}
			_, _ = m.finish("owner", p.job, 1, r.CumulativeBytes, r.CheckpointHash)
			got := s.capture.snapshot()
			if got.Audit.FinalizationStatus != "unresolved" || hasFinalRfidCounterSnapshot(*got) || got.Audit.CountsKnown {
				t.Fatalf("false certainty %+v", got)
			}
		})
	}
}

func TestConnectorCounterVerifiedTotalsDoNotRequireEveryEPC(t *testing.T) {
	p := &lifecyclePrinter{job: "missing-epc", missingRead: true}
	m, _ := lifecycleManager(t, p, 2)
	r, err := lifecycleAppend(t, m, p.job, 1, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	f, err := m.finish("owner", p.job, 1, r.CumulativeBytes, r.CheckpointHash)
	if err != nil {
		t.Fatal(err)
	}
	if !hasFinalRfidCounterSnapshot(*f.Capture) || f.Capture.Audit.ValidDelta != 2 || f.Capture.UniqueLabels != 0 || f.Capture.State != "incomplete" {
		t.Fatal("physical count confused with capture quality", f.Capture)
	}
}

func TestConnectorCounterAutonomousSealSurvivesLostBrowserAndSocket(t *testing.T) {
	p := &lifecyclePrinter{job: "browser-gone"}
	m, s := lifecycleManager(t, p, 2)
	m.monitorInterval = 20 * time.Millisecond
	_, err := lifecycleAppend(t, m, p.job, 1, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for !hasFinalRfidCounterSnapshot(*s.capture.snapshot()) {
		if time.Now().After(deadline) {
			t.Fatal("no autonomous proof", s.capture.snapshot())
		}
		time.Sleep(10 * time.Millisecond)
	}
	before := s.capture.snapshot().Audit.FinalCounterProof
	_ = p.peer.Close()
	time.Sleep(30 * time.Millisecond)
	s.mu.Lock()
	s.idleTimeout = time.Millisecond
	s.lastActivity = time.Now().Add(-time.Second)
	s.mu.Unlock()
	s.expireIfIdle()
	got := s.capture.snapshot()
	if !hasFinalRfidCounterSnapshot(*got) || got.Audit.FinalCounterProof != before || got.Audit.ValidDelta != 2 {
		t.Fatal("sealed proof erased by transport loss", got)
	}
	loaded := *got
	markRfidCrashInterrupted(&loaded)
	if !hasFinalRfidCounterSnapshot(loaded) {
		t.Fatal("restart erased persisted proof")
	}
}

func TestConnectorCounterExternalQueriesCannotOverwriteBaselineOrFinal(t *testing.T) {
	p := &lifecyclePrinter{job: "external-query"}
	m, s := lifecycleManager(t, p, 1)
	r, err := lifecycleAppend(t, m, p.job, 1, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	err = s.finalizeCounterLifecycleLocked(2 * time.Second)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	before := s.capture.snapshot().Audit
	for _, q := range auditQueries {
		if _, err := m.queryContext(context.Background(), "owner", p.job, []byte(q), time.Second, time.Second); err != nil {
			t.Fatal(err)
		}
	}
	after := s.capture.snapshot().Audit
	if before.Baseline != after.Baseline || before.Latest != after.Latest || !hasFinalRfidCounterSnapshot(*s.capture.snapshot()) {
		t.Fatal("external query mutated proof")
	}
	_, err = m.finish("owner", p.job, 1, r.CumulativeBytes, r.CheckpointHash)
	if err != nil {
		t.Fatal(err)
	}
}

func TestConnectorCounterSealedProofDoesNotClearAfterForegroundQueryLoss(t *testing.T) {
	p := &lifecyclePrinter{job: "sealed-query-loss"}
	m, s := lifecycleManager(t, p, 2)
	receipt, err := lifecycleAppend(t, m, p.job, 1, 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	err = s.finalizeCounterLifecycleLocked(2 * time.Second)
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	_ = p.peer.Close()
	select {
	case <-s.capture.done:
	case <-time.After(time.Second):
		t.Fatal("reader did not observe EOF")
	}
	_, err = m.queryContext(context.Background(), "owner", p.job, []byte("~HS\r\n"), time.Second, time.Second)
	if err == nil {
		t.Fatal("closed socket query succeeded")
	}
	r, err := m.poll("owner", p.job)
	if err != nil || !r.CounterFinishRecoverable || r.FaultClearRequested || r.ServiceFault != "" || !hasFinalRfidCounterSnapshot(*r.Capture) || r.Capture.Audit.ValidDelta != 2 {
		t.Fatal("sealed run was cleared or lost its proof", r, err)
	}
	p.mu.Lock()
	events := strings.Join(p.events, "|")
	p.mu.Unlock()
	if strings.Contains(events, "~PP") || strings.Contains(events, "~JA") || p.labels.Load() != 2 || p.dials.Load() != 1 {
		t.Fatal("unexpected physical control/reprint", events)
	}
	// An invalid client checkpoint must not consume or release the safe proof.
	_, err = m.finish("owner", p.job, 1, receipt.CumulativeBytes, strings.Repeat("0", 64))
	requireAPIErrorCode(t, err, "TCP_JOB_CHECKPOINT_CONFLICT")
	f, err := m.finish("owner", p.job, 1, receipt.CumulativeBytes, receipt.CheckpointHash)
	if err != nil || f.State != "finished" || f.Capture.State != "complete" || f.Capture.TransportNote == "" || !hasFinalRfidCounterSnapshot(*f.Capture) {
		t.Fatal("sealed transport query could not finish locally", f, err)
	}
	if _, err = m.open(context.Background(), "owner", p.job+"-next", "simulated", 9100, time.Second, time.Second, time.Minute); err != nil {
		t.Fatal("finished proof left target quarantined", err)
	}
}

func TestConnectorCounterTransportRecoveryRejectsLaterPayloadAndStorageFailure(t *testing.T) {
	for _, kind := range []string{"later-payload", "storage", "partial-frame", "unrelated-error"} {
		t.Run(kind, func(t *testing.T) {
			p := &lifecyclePrinter{job: "recover-guard-" + kind}
			m, s := lifecycleManager(t, p, 2)
			r, err := lifecycleAppend(t, m, p.job, 1, 1, 2)
			if err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			err = s.finalizeCounterLifecycleLocked(2 * time.Second)
			s.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			if kind == "later-payload" {
				r, err = lifecycleAppend(t, m, p.job, 2, 3, 1)
				if err != nil {
					t.Fatal(err)
				}
			}
			if kind == "partial-frame" {
				_, _ = io.WriteString(p.peer, "NWEP|"+p.job+"|3|00")
			}
			_ = p.peer.Close()
			select {
			case <-s.capture.done:
			case <-time.After(time.Second):
				t.Fatal("reader still alive")
			}
			if kind == "unrelated-error" {
				s.mu.Lock()
				_ = s.markUncertainLocked(0, 0, false, "unrelated payload failure", "TCP_JOB_WRITE_FAILED")
				s.mu.Unlock()
			} else {
				_, err = m.queryContext(context.Background(), "owner", p.job, []byte("~HS\r\n"), time.Second, time.Second)
				if err == nil {
					t.Fatal("query unexpectedly succeeded")
				}
			}
			if kind == "storage" {
				path := filepath.Join(t.TempDir(), "not-a-directory")
				if err = os.WriteFile(path, []byte("storage failure"), 0600); err != nil {
					t.Fatal(err)
				}
				s.capture.mu.Lock()
				s.capture.dir = path
				s.capture.mu.Unlock()
			}
			_, err = m.finish("owner", p.job, r.NextSequence-1, r.CumulativeBytes, r.CheckpointHash)
			if kind == "storage" {
				requireAPIErrorCode(t, err, "RFID_CAPTURE_STORE_FAILED")
			} else if kind == "later-payload" {
				requireAPIErrorCode(t, err, "TCP_JOB_SERVICE_FAULT")
			} else {
				requireAPIErrorCode(t, err, "TCP_JOB_UNCERTAIN")
			}
			polled, err := m.poll("owner", p.job)
			if err != nil || polled.CounterFinishRecoverable {
				t.Fatal("unsafe run advertised recoverable", polled, err)
			}
			_, err = m.open(context.Background(), "owner", p.job+"-next", "simulated", 9100, time.Second, time.Second, time.Minute)
			requireAPIErrorCode(t, err, "TCP_JOB_TARGET_QUARANTINED")
		})
	}
}

func TestConnectorCounterAutonomousSealedSocketCloseFinishesAndReleasesTarget(t *testing.T) {
	for _, fault := range []string{"none", "reset", "timeout", "partial_frame", "storage"} {
		t.Run(fault, func(t *testing.T) {
			p := &lifecyclePrinter{job: "sealed-eof-" + strings.ReplaceAll(fault, "_", "-")}
			if fault == "reset" {
				p.readError = &net.OpError{Op: "read", Net: "tcp", Err: syscall.ECONNRESET}
			}
			if fault == "timeout" {
				p.readError = &net.OpError{Op: "read", Net: "tcp", Err: syscall.ETIMEDOUT}
			}
			m, s := lifecycleManager(t, p, 2)
			m.monitorInterval = 20 * time.Millisecond
			r, err := lifecycleAppend(t, m, p.job, 1, 1, 2)
			if err != nil {
				t.Fatal(err)
			}
			deadline := time.Now().Add(3 * time.Second)
			for !hasFinalRfidCounterSnapshot(*s.capture.snapshot()) {
				if time.Now().After(deadline) {
					t.Fatal("autonomous proof missing")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if fault == "partial_frame" {
				_, _ = io.WriteString(p.peer, "NWEP|"+p.job+"|3|00")
			}
			if fault == "storage" {
				s.capture.mu.Lock()
				_ = s.capture.file.Close()
				s.capture.mu.Unlock()
			}
			_ = p.peer.Close()
			select {
			case <-s.capture.done:
			case <-time.After(time.Second):
				t.Fatal("reader did not observe EOF")
			}
			f, err := m.finish("owner", p.job, 1, r.CumulativeBytes, r.CheckpointHash)
			if fault == "none" || fault == "reset" || fault == "timeout" {
				if err != nil || f.State != "finished" || f.Capture.Error != "" || f.Capture.TransportNote == "" || !hasFinalRfidCounterSnapshot(*f.Capture) || f.Capture.Audit.ValidDelta != 2 {
					t.Fatal("sealed EOF became false store failure", f, err)
				}
				if _, err = m.open(context.Background(), "owner", p.job+"-next", "simulated", 9100, time.Second, time.Second, time.Minute); err != nil {
					t.Fatal("completed proof quarantined target", err)
				}
			} else {
				requireAPIErrorCode(t, err, "RFID_CAPTURE_STORE_FAILED")
				_, err = m.open(context.Background(), "owner", p.job+"-next", "simulated", 9100, time.Second, time.Second, time.Minute)
				requireAPIErrorCode(t, err, "TCP_JOB_TARGET_QUARANTINED")
			}
			if p.labels.Load() != 2 {
				t.Fatal("EOF caused label replay")
			}
		})
	}
}
