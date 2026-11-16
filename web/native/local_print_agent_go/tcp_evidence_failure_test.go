package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func awaitCaptureEvidence(t *testing.T, c *rfidCapture, matches func(rfidCaptureSummary) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if matches(*c.snapshot()) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("capture did not reach expected state: %+v", c.snapshot())
		}
		time.Sleep(time.Millisecond)
	}
}

func TestCaptureStorageFailureStopsBufferedPrintBeforeDisconnect(t *testing.T) {
	for _, trigger := range []string{"background", "query", "append"} {
		t.Run(trigger, func(t *testing.T) {
			p := &monitoredPrinter{jobID: "capture-disk-failure", capture: true}
			m := monitorTestManager(t, p)
			m.monitorInterval = time.Hour
			if trigger == "background" {
				m.monitorInterval = 200 * time.Millisecond
			}
			_, err := m.open(context.Background(), "owner", p.jobID, "simulated", 9100, time.Second, time.Second, time.Minute,
				&rfidCaptureOptions{ExpectedLabels: 20, FirstRow: 1, RowStep: 1, Bank: "EPC"})
			if err != nil {
				t.Fatal(err)
			}
			s, _ := m.lookup("owner", p.jobID)
			first := []byte("LABEL 1\n")
			if _, err := m.append("owner", p.jobID, 1, first, payloadDigest(first)); err != nil {
				t.Fatal(err)
			}
			awaitCaptureEvidence(t, s.capture, func(c rfidCaptureSummary) bool { return c.Received == 1 })
			// Force the actual durable CSV write to fail after one saved record.
			s.capture.mu.Lock()
			err = s.capture.file.Close()
			s.capture.mu.Unlock()
			if err != nil {
				t.Fatal(err)
			}
			second := []byte("LABEL 2\n")
			_, err = m.append("owner", p.jobID, 2, second, payloadDigest(second))
			// A synchronously observed disk failure may quarantine this append
			// before the later background/query/append trigger sees it.
			earlyFailure := err != nil
			if earlyFailure {
				requireAPIErrorCode(t, err, "RFID_CAPTURE_STORE_FAILED")
			}
			awaitCaptureEvidence(t, s.capture, func(c rfidCaptureSummary) bool { return c.Error != "" })
			if !earlyFailure {
				switch trigger {
				case "query":
					_, err = m.queryContext(context.Background(), "owner", p.jobID, []byte("~HQES\r\n"), time.Second, time.Millisecond)
					requireAPIErrorCode(t, err, "RFID_CAPTURE_FAILED")
				case "append":
					_, err = m.append("owner", p.jobID, 3, first, payloadDigest(first))
					requireAPIErrorCode(t, err, "RFID_CAPTURE_FAILED")
				}
			}
			awaitMonitor(t, s)
			result, err := m.poll("owner", p.jobID)
			if err != nil || result.State != "uncertain" || !result.FaultClearRequested || result.ServiceFault != "RFID evidence unavailable after label submission" || result.Capture.State != "interrupted" {
				t.Fatalf("capture failure did not clear/quarantine: %+v, %v", result, err)
			}
			expectedCheckpoint := nextTCPJobCheckpoint(nextTCPJobCheckpoint(tcpJobSeed(p.jobID), 1, len(first), payloadDigest(first)), 2, len(second), payloadDigest(second))
			if result.CumulativeBytes != int64(len(first)+len(second)) || result.CheckpointHash != expectedCheckpoint || result.NextSequence != 3 || result.Capture.Error == "" {
				t.Fatalf("failure lost submitted checkpoint/evidence: %+v", result)
			}
			_, err = m.open(context.Background(), "owner", "after-storage-failure", "simulated", 9100, time.Second, time.Second, time.Minute)
			requireAPIErrorCode(t, err, "TCP_JOB_TARGET_QUARANTINED")
			if _, err := m.abort("owner", p.jobID); err != nil {
				t.Fatal(err)
			}
			p.mu.Lock()
			events := strings.Join(p.events, "|")
			p.mu.Unlock()
			if strings.Count(events, "~PP") != 1 || strings.Count(events, "~JA") != 1 || strings.Count(events, "LABEL") != 2 || p.dials.Load() != 1 {
				t.Fatal("failed capture replayed labels or did not clear once", events)
			}
			data, err := os.ReadFile(filepath.Join(s.capture.dir, "reads.csv"))
			if err != nil || !strings.Contains(string(data), ",00000001,") || strings.Contains(string(data), ",00000002,") {
				t.Fatalf("earlier durable evidence changed: %q, %v", data, err)
			}
		})
	}
}

func TestCounterEvidenceFailureClearsOnlyAfterLabelSubmission(t *testing.T) {
	for _, submitted := range []bool{false, true} {
		t.Run(fmt.Sprintf("submitted=%t", submitted), func(t *testing.T) {
			events := make(chan string, 1)
			m := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
				client, peer := net.Pipe()
				go func() {
					defer peer.Close()
					var commands []string
					scanner := bufio.NewScanner(peer)
					for scanner.Scan() {
						command := scanner.Text()
						commands = append(commands, command)
						if rfidCounterName(command) != "" {
							_, _ = io.WriteString(peer, "\"invalid\"\r\n")
						}
					}
					events <- strings.Join(commands, "|")
				}()
				return client, "simulated", nil
			})
			t.Cleanup(m.close)
			m.monitorInterval = 0
			m.captureDir = t.TempDir()
			const id = "counter-evidence-failure"
			_, err := m.open(context.Background(), "owner", id, "simulated", 9100, time.Second, time.Second, time.Minute,
				&rfidCaptureOptions{ExpectedLabels: 10, FirstRow: 1, RowStep: 1, Bank: "EPC"})
			if err != nil {
				t.Fatal(err)
			}
			if submitted {
				payload := []byte("LABEL\n")
				if _, err := m.append("owner", id, 1, payload, payloadDigest(payload)); err != nil {
					t.Fatal(err)
				}
			}
			_, err = m.queryContext(context.Background(), "owner", id, []byte(auditQueries[0]), time.Second, time.Millisecond)
			requireAPIErrorCode(t, err, "RFID_COUNTER_FAILED")
			result, err := m.poll("owner", id)
			if err != nil || result.State != "uncertain" || result.FaultClearRequested != submitted {
				t.Fatalf("counter failure state: %+v, %v", result, err)
			}
			got := <-events
			if strings.Contains(got, "~PP") != submitted || strings.Contains(got, "~JA") != submitted {
				t.Fatal("counter failure controls do not match submitted state", got)
			}
		})
	}
}

func TestCaptureEvidenceClearWithUnavailableOutputIsBounded(t *testing.T) {
	for _, output := range []string{"blocked", "closed"} {
		t.Run(output, func(t *testing.T) {
			readLabel := make(chan struct{})
			release := make(chan struct{})
			t.Cleanup(func() { close(release) })
			m := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
				client, peer := net.Pipe()
				go func() {
					defer peer.Close()
					_, _ = bufio.NewReader(peer).ReadString('\n')
					if output == "closed" {
						_ = peer.Close()
					}
					close(readLabel)
					<-release
				}()
				return client, "simulated", nil
			})
			t.Cleanup(m.close)
			m.monitorInterval = 0
			m.captureDir = t.TempDir()
			const id = "unavailable-output"
			_, err := m.open(context.Background(), "owner", id, "simulated", 9100, time.Second, 50*time.Millisecond, time.Minute,
				&rfidCaptureOptions{ExpectedLabels: 10, FirstRow: 1, RowStep: 1, Bank: "EPC"})
			if err != nil {
				t.Fatal(err)
			}
			payload := []byte("LABEL\n")
			start := time.Now()
			_, err = m.append("owner", id, 1, payload, payloadDigest(payload))
			earlyFailure := err != nil
			if earlyFailure {
				requireAPIErrorCode(t, err, "RFID_CAPTURE_STORE_FAILED")
			}
			<-readLabel
			s, _ := m.lookup("owner", id)
			if !earlyFailure {
				s.capture.mu.Lock()
				_ = s.capture.file.Close()
				s.capture.mu.Unlock()
				s.capture.feed([]byte("NWEP|" + id + "|1|0001|END\r\n"))
				_, err = m.queryContext(context.Background(), "owner", id, []byte("~HQES\r\n"), time.Second, time.Millisecond)
				requireAPIErrorCode(t, err, "RFID_CAPTURE_FAILED")
			}
			if time.Since(start) > time.Second {
				t.Fatal("clear attempt ignored output deadline")
			}
			result, err := m.poll("owner", id)
			if err != nil || result.State != "uncertain" || result.FaultClearRequested || result.ServiceFault == "" || result.CumulativeBytes != int64(len(payload)) || result.NextSequence != 2 {
				t.Fatalf("unavailable output claimed successful clear: %+v, %v", result, err)
			}
		})
	}
}

func TestCaptureFinalStoreFailureOnClosedSocketRemainsUncertain(t *testing.T) {
	p := &monitoredPrinter{jobID: "final-store-failure", capture: true}
	m := monitorTestManager(t, p)
	m.monitorInterval = 0
	_, err := m.open(context.Background(), "owner", p.jobID, "simulated", 9100, time.Second, 50*time.Millisecond, time.Minute,
		&rfidCaptureOptions{ExpectedLabels: 1, FirstRow: 1, RowStep: 1, Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("LABEL 1\n")
	receipt, err := m.append("owner", p.jobID, 1, payload, payloadDigest(payload))
	if err != nil {
		t.Fatal(err)
	}
	s, _ := m.lookup("owner", p.jobID)
	awaitCaptureEvidence(t, s.capture, func(c rfidCaptureSummary) bool { return c.Received == 1 })
	s.capture.mu.Lock()
	_ = s.capture.file.Close()
	s.capture.mu.Unlock()
	start := time.Now()
	_, err = m.finish("owner", p.jobID, 1, receipt.CumulativeBytes, receipt.CheckpointHash)
	requireAPIErrorCode(t, err, "RFID_CAPTURE_STORE_FAILED")
	if time.Since(start) > time.Second {
		t.Fatal("final-store failure hung on the already closed socket")
	}
	result, err := m.poll("owner", p.jobID)
	if err != nil || result.State != "uncertain" || result.FaultClearRequested || result.Capture.State == "complete" || result.Capture.Error == "" {
		t.Fatalf("failed final store claimed complete evidence/clear: %+v, %v", result, err)
	}
}
