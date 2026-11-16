package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRfidFixedReadLengthAndCrashRecovery(t *testing.T) {
	root := t.TempDir()
	c, err := newRfidCapture(root, "owner", "crash-read-session", "printer", 9100, rfidCaptureOptions{ExpectedLabels: 2, ExpectedHexChars: 24, FirstRow: 1, RowStep: 1, Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	c.feed([]byte("NWEP|crash-read-session|1|0011|END\r\n"))
	if s := c.snapshot(); s.InvalidReads != 1 || s.UniqueLabels != 0 {
		t.Fatalf("truncated fixed read accepted: %+v", s)
	}
	// Simulate a crash: close the file without writing a terminal manifest.
	c.file.Close()
	manager := newTCPJobManager()
	defer manager.close()
	manager.captureDir = root
	recorder := httptest.NewRecorder()
	if err := manager.handleCaptureHistory(recorder, httptest.NewRequest("POST", "/", nil), "owner", tcpJobRequest{Action: "capture-list"}); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Sessions []rfidCaptureSummary `json:"sessions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Sessions) != 1 || result.Sessions[0].State != "interrupted" || result.Sessions[0].Received != 1 || result.Sessions[0].UniqueLabels != 0 || result.Sessions[0].InvalidReads != 1 {
		t.Fatalf("bad recovery: %s", recorder.Body.String())
	}
}

func TestCancelHasReservedByteCapacity(t *testing.T) {
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		client, peer := net.Pipe()
		go func() { io.Copy(io.Discard, peer); peer.Close() }()
		return client, "printer", nil
	})
	defer manager.close()
	const jobID = "cancel-at-byte-cap"
	if _, err := manager.open(context.Background(), "owner", jobID, "printer", 9100, time.Second, time.Second, time.Minute); err != nil {
		t.Fatal(err)
	}
	session, _ := manager.lookup("owner", jobID)
	session.mu.Lock()
	session.cumulativeBytes = maxTCPJobBytes
	session.mu.Unlock()
	if _, err := manager.append("owner", jobID, 1, []byte("X"), payloadDigest([]byte("X"))); err == nil {
		t.Fatal("data exceeded byte budget")
	}
	cancel := []byte("~JA\r\n")
	receipt, err := manager.append("owner", jobID, 1, cancel, payloadDigest(cancel))
	if err != nil {
		t.Fatal("Cancel blocked by data limit:", err)
	}
	body, _ := json.Marshal(map[string]any{"action": "finish", "jobId": jobID, "expectedSequence": 1, "expectedBytes": receipt.CumulativeBytes, "checkpointHash": receipt.CheckpointHash})
	server := &appServer{tcpJobs: manager}
	if err := server.handleTCPJob(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/tcp/job", bytes.NewReader(body)), "owner"); err != nil {
		t.Fatal("finish rejected control bytes:", err)
	}
}

func TestRfidFinishRetainsMissingReadbacksWithoutBlockingTopUp(t *testing.T) {
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		client, peer := net.Pipe()
		go func() { io.Copy(io.Discard, peer); peer.Close() }()
		return client, "printer", nil
	})
	defer manager.close()
	manager.captureDir = t.TempDir()
	const id = "missing-final-capture"
	options := &rfidCaptureOptions{ExpectedLabels: 1, FirstRow: 1, RowStep: 1, Bank: "EPC"}
	if _, err := manager.open(context.Background(), "owner", id, "printer", 9100, time.Second, time.Second, time.Minute, options); err != nil {
		t.Fatal(err)
	}
	payload := []byte("^XA^XZ")
	receipt, err := manager.append("owner", id, 1, payload, payloadDigest(payload))
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.finish("owner", id, 1, receipt.CumulativeBytes, receipt.CheckpointHash)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := manager.poll("owner", id)
	if err != nil || snapshot.State != "finished" || snapshot.Capture.State != "incomplete" {
		t.Fatalf("unsafe finish: %+v %v", snapshot, err)
	}
	_, err = manager.open(context.Background(), "owner", "manual-top-up", "printer", 9100, time.Second, time.Second, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
}

func TestRfidFinishCollectsLateDuplicateAndCancelKeepsPartialHistory(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		t.Run(fmt.Sprintf("cancelled=%t", cancelled), func(t *testing.T) {
			var peer net.Conn
			manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
				client, printer := net.Pipe()
				peer = printer
				go func() { io.Copy(io.Discard, printer); printer.Close() }()
				return client, "printer", nil
			})
			defer manager.close()
			manager.captureDir = t.TempDir()
			const id = "finish-readback-race"
			expected := 1
			if cancelled {
				expected = 2
			}
			options := &rfidCaptureOptions{ExpectedLabels: expected, FirstRow: 1, RowStep: 1, Bank: "EPC"}
			if _, err := manager.open(context.Background(), "owner", id, "printer", 9100, time.Second, time.Second, time.Minute, options); err != nil {
				t.Fatal(err)
			}
			payload := []byte("^XA^XZ")
			last, err := manager.append("owner", id, 1, payload, payloadDigest(payload))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := io.WriteString(peer, "NWEP|"+id+"|1|0001|END\r\n"); err != nil {
				t.Fatal(err)
			}
			session, _ := manager.lookup("owner", id)
			deadline := time.Now().Add(time.Second)
			for session.capture.snapshot().UniqueLabels != 1 {
				if time.Now().After(deadline) {
					t.Fatal("initial response not collected")
				}
				time.Sleep(time.Millisecond)
			}
			sequence := 1
			var late chan error
			if cancelled {
				payload = []byte("~JA\r\n")
				sequence = 2
				last, err = manager.append("owner", id, sequence, payload, payloadDigest(payload))
				if err != nil {
					t.Fatal(err)
				}
			} else {
				late = make(chan error, 1)
				go func() {
					// The final count was correct before finish. A delayed duplicate
					// must still be persisted as incomplete evidence.
					for {
						session.capture.mu.Lock()
						closing := session.capture.closing
						session.capture.mu.Unlock()
						if closing {
							break
						}
						time.Sleep(time.Millisecond)
					}
					time.Sleep(50 * time.Millisecond)
					_, err := io.WriteString(peer, "NWEP|"+id+"|1|0001|END\r\n")
					late <- err
				}()
			}
			result, err := manager.finish("owner", id, sequence, last.CumulativeBytes, last.CheckpointHash)
			if cancelled {
				if err != nil || result.State != "finished" || result.Capture.State != "cancelled" || result.Capture.UniqueLabels != 1 {
					t.Fatalf("Cancel lost partial history or failed: %+v %v", result, err)
				}
			} else {
				if err := <-late; err != nil {
					t.Fatal("late response dropped:", err)
				}
				if err != nil || result.State != "finished" {
					t.Fatalf("quality warning blocked completion: %+v %v", result, err)
				}
				s := session.capture.snapshot()
				if s.Received != 2 || s.Issues != 1 || s.State != "incomplete" {
					t.Fatalf("late duplicate lost: %+v", s)
				}
			}
		})
	}
}

func TestRfidCaptureContinuousReaderAndDurableHistory(t *testing.T) {
	const jobID = "rfid-large-session"
	var printer net.Conn
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		client, peer := net.Pipe()
		printer = peer
		return client, "192.168.1.20", nil
	})
	manager.captureDir = t.TempDir()
	defer manager.close()
	options := &rfidCaptureOptions{ExpectedLabels: 3001, FirstRow: 4000, RowStep: -1, Bank: "EPC", TemplateName: "Read EPC text"}
	if _, err := manager.open(context.Background(), "owner", jobID, "printer", 9100, time.Second, time.Second, time.Minute, options); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		defer printer.Close()
		reader := bufio.NewReader(printer)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				done <- nil
				return
			}
			if strings.HasPrefix(line, "LABEL ") {
				var n int
				fmt.Sscanf(line, "LABEL %d", &n)
				response := fmt.Sprintf("NWEP|%s|%d|%024X|END\r\n", jobID, n, n)
				// Split the signature, payload and delimiter across arbitrary reads.
				for _, part := range []string{response[:2], response[2 : len(response)-3], response[len(response)-3:]} {
					if _, err = io.WriteString(printer, part); err != nil {
						done <- err
						return
					}
				}
			} else if strings.TrimSpace(line) == "~HQES" {
				_, err = io.WriteString(printer, "\x02\r\nPRINTER STATUS\r\nERRORS: 0 00000000 00000000\r\nWARNINGS: 0 00000000 00000000\r\n\x03")
				if err != nil {
					done <- err
					return
				}
			}
		}
	}()
	var last tcpJobResult
	for n := 1; n <= 3001; n++ {
		payload := []byte(fmt.Sprintf("LABEL %d\n", n))
		var err error
		last, err = manager.append("owner", jobID, n, payload, payloadDigest(payload))
		if err != nil {
			t.Fatalf("append %d: %v", n, err)
		}
		if n == 1675 {
			q, err := manager.queryContext(context.Background(), "owner", jobID, []byte("~HQES\n"), time.Second, time.Millisecond)
			if err != nil {
				t.Fatal(err)
			}
			if strings.Contains(q.Response, "NWEP") || !strings.Contains(q.Response, "ERRORS") {
				t.Fatalf("mixed status: %q", q.Response)
			}
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		snapshot, _ := manager.poll("owner", jobID)
		if snapshot.Capture.UniqueLabels == 3001 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("missing reads: %+v", snapshot.Capture)
		}
		time.Sleep(time.Millisecond)
	}
	result, err := manager.finish("owner", jobID, 3001, last.CumulativeBytes, last.CheckpointHash)
	if err != nil || result.Capture.State != "complete" || result.Capture.Received != 3001 {
		t.Fatalf("finish: %+v %v", result, err)
	}
	<-done
	f, err := os.Open(filepath.Join(captureDirectory(manager.captureDir, "owner", jobID), "reads.csv"))
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	rows, err := csv.NewReader(f).ReadAll()
	if err != nil || len(rows) != 3002 {
		t.Fatalf("CSV rows=%d, err=%v", len(rows), err)
	}
	for n, row := range rows[1:] {
		if row[1] != fmt.Sprint(n+1) || row[2] != fmt.Sprint(4000-n) || row[4] != fmt.Sprintf("%024X", n+1) || row[6] != "read" {
			t.Fatalf("wrong row: %v", row)
		}
	}
	// A fresh manager must serve the same file without reopening/replaying a job.
	restarted := newTCPJobManager()
	defer restarted.close()
	restarted.captureDir = manager.captureDir
	recorder := httptest.NewRecorder()
	if err := restarted.handleCaptureHistory(recorder, httptest.NewRequest("POST", "/", nil), "owner", tcpJobRequest{Action: "capture-list"}); err != nil {
		t.Fatal(err)
	}
	var history struct {
		Sessions []rfidCaptureSummary `json:"sessions"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &history); err != nil || len(history.Sessions) != 1 || history.Sessions[0].State != "complete" {
		t.Fatalf("history %s, %v", recorder.Body.String(), err)
	}
	denied := httptest.NewRecorder()
	if err := restarted.handleCaptureHistory(denied, httptest.NewRequest("POST", "/", nil), "another-owner", tcpJobRequest{Action: "capture-export", JobID: jobID}); err == nil {
		t.Fatal("cross-owner export allowed")
	}
}

func TestRfidCaptureDoesNotHideDuplicateMissingOrInvalidReads(t *testing.T) {
	for _, tc := range []struct {
		name       string
		ordinals   []int
		values     []string
		wantIssues int
		wantUnique int
	}{
		{"missing", []int{1}, []string{"0001"}, 0, 1},
		{"reprint", []int{1, 1, 2}, []string{"0001", "0001", "0002"}, 1, 2},
		{"same_epc", []int{1, 2}, []string{"0001", "0001"}, 1, 2},
		{"out_of_order", []int{2, 1}, []string{"0002", "0001"}, 1, 2},
		{"void", []int{1, 2}, []string{"VOID", "0002"}, 0, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, err := newRfidCapture(t.TempDir(), "owner", "test-capture", "printer", 9100, rfidCaptureOptions{ExpectedLabels: 2, FirstRow: 1, RowStep: 1, Bank: "EPC"})
			if err != nil {
				t.Fatal(err)
			}
			for i, n := range tc.ordinals {
				c.feed([]byte(fmt.Sprintf("NWEP|test-capture|%d|%s|END\r\n", n, tc.values[i])))
			}
			close(c.done) // No socket in this parser-only test.
			if err := c.close(nil, "finished"); err != nil {
				t.Fatal(err)
			}
			s := c.snapshot()
			if s.State != "incomplete" || s.Issues != tc.wantIssues || s.UniqueLabels != tc.wantUnique || s.Received != len(tc.ordinals) {
				t.Fatalf("unsafe summary: %+v", s)
			}
		})
	}
}

func TestTCPLeaseBlocksInjectionAndSurvivesQuarantineRetention(t *testing.T) {
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		client, peer := net.Pipe()
		go func() { io.Copy(io.Discard, peer); peer.Close() }()
		return client, "192.168.1.10", nil
	})
	defer manager.close()
	const id = "exclusive-large-job"
	if _, err := manager.open(context.Background(), "owner", id, "printer", 9100, time.Second, time.Second, time.Minute); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if release, err := manager.printerQueues.acquire(ctx, tcpPrinterTargetKey("printer", 9100)); err == nil {
		release()
		t.Fatal("another request acquired an active logical job's lease")
	}
	_, handled, err := manager.activeExchange(context.Background(), "printer", 9100, []byte("^XA^FDold label^FS^XZ"), time.Second, time.Millisecond)
	if !handled || err == nil {
		t.Fatal("format injection allowed")
	}
	if _, handled, err = manager.activeExchange(context.Background(), "printer", 9100, []byte("~PS\r\n"), time.Second, time.Millisecond); !handled || err != nil {
		t.Fatalf("Resume deadlocked/failed: %v", err)
	}
	payload := []byte("^XA^XZ")
	receipt, err := manager.append("owner", id, 1, payload, payloadDigest(payload))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.abort("owner", id); err != nil {
		t.Fatal(err)
	}
	session, _ := manager.lookup("owner", id)
	session.mu.Lock()
	session.terminalAt = time.Now().Add(-2 * time.Hour)
	session.mu.Unlock()
	_, err = manager.open(context.Background(), "owner", "replacement-job", "printer", 9100, time.Second, time.Second, time.Minute)
	requireAPIErrorCode(t, err, "TCP_JOB_TARGET_QUARANTINED")
	if _, err = manager.reconcile("owner", id, 1, receipt.CumulativeBytes, receipt.CheckpointHash, "Confirmed empty queue and audited labels"); err != nil {
		t.Fatal(err)
	}
	ctx2, cancel2 := context.WithTimeout(context.Background(), time.Second)
	defer cancel2()
	release, err := manager.printerQueues.acquire(ctx2, tcpPrinterTargetKey("printer", 9100))
	if err != nil {
		t.Fatal("reconciled lease not released:", err)
	}
	release()
}
