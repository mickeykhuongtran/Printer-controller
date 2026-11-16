package main

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func serviceHqes(bits string) string {
	return "\x02\r\nPRINTER STATUS\r\nERRORS: 1 00000000 " + bits + "\r\nWARNINGS: 0 00000000 00000000\r\n\x03\r\n"
}

func TestServiceFaultDetectionExcludesOrdinaryPause(t *testing.T) {
	for _, tc := range []struct{ bits, want string }{
		{"00010000", ""}, {"00010004", "Printhead open"}, {"00000002", "Ribbon out"},
		{"00000001", "Media out"}, {"00000007", "Media out; Ribbon out; Printhead open"},
		{"00000010", ""},
	} {
		if got := zebraServiceFault("~HQES", serviceHqes(tc.bits)); got != tc.want {
			t.Fatalf("%s: got %q want %q", tc.bits, got, tc.want)
		}
	}
	hs := "\x02000,1,1,0251,003,0,0,0,000,0,0,0\x03\r\n\x02000,0,1,1,1,2,6,0,00000003,1,001\x03\r\n\x021234,1\x03\r\n"
	if got := zebraServiceFault("~HS", hs); got != "Media out; Ribbon out; Printhead open" {
		t.Fatal(got)
	}
	if got := zebraServiceFault("~HS", hs[:len(hs)-10]); got != "" {
		t.Fatal("truncated status triggered latch")
	}
}

func TestServiceFaultClearsOnceOnSameSocketThenBlocksPayloadResumeAndFinish(t *testing.T) {
	for _, capture := range []bool{false, true} {
		t.Run(fmt.Sprint("capture=", capture), func(t *testing.T) {
			var mu sync.Mutex
			events := []string{}
			dials := 0
			manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
				dials++
				client, peer := net.Pipe()
				go func() {
					defer peer.Close()
					reader := bufio.NewReader(peer)
					for {
						line, err := reader.ReadString('\n')
						if err != nil {
							return
						}
						line = strings.TrimSpace(line)
						mu.Lock()
						events = append(events, line)
						mu.Unlock()
						if line == "~HQES" {
							_, _ = io.WriteString(peer, serviceHqes("00010004"))
						}
					}
				}()
				return client, "simulated", nil
			})
			defer manager.close()
			manager.captureDir = t.TempDir()
			var opts *rfidCaptureOptions
			if capture {
				opts = &rfidCaptureOptions{ExpectedLabels: 10, FirstRow: 1, RowStep: 1, Bank: "EPC"}
			}
			const owner, jobID = "fault-owner", "fault-test-job"
			if _, err := manager.open(context.Background(), owner, jobID, "simulated", 9100, time.Second, time.Second, time.Minute, opts); err != nil {
				t.Fatal(err)
			}
			payload := []byte("^XA^FDONE^FS^XZ\r\n")
			receipt, err := manager.append(owner, jobID, 1, payload, payloadDigest(payload))
			if err != nil {
				t.Fatal(err)
			}
			fault, err := manager.queryContext(context.Background(), owner, jobID, []byte("~HQES\r\n"), time.Second, time.Millisecond)
			if err != nil || fault.ServiceFault != "Printhead open" || !fault.FaultClearRequested {
				t.Fatalf("fault=%+v error=%v", fault, err)
			}
			if _, err := manager.queryContext(context.Background(), owner, jobID, []byte("~HQES\r\n"), time.Second, time.Millisecond); err != nil {
				t.Fatal(err)
			}
			_, err = manager.append(owner, jobID, 2, payload, payloadDigest(payload))
			requireAPIErrorCode(t, err, "TCP_JOB_SERVICE_FAULT")
			_, used, err := manager.activeExchange(context.Background(), "simulated", 9100, []byte("~PS\r\n"), time.Second, time.Millisecond)
			if !used {
				t.Fatal("Resume escaped the active job socket")
			}
			requireAPIErrorCode(t, err, "TCP_JOB_SERVICE_FAULT")
			_, err = manager.finish(owner, jobID, 1, receipt.CumulativeBytes, receipt.CheckpointHash)
			requireAPIErrorCode(t, err, "TCP_JOB_SERVICE_FAULT")
			stopped, err := manager.abort(owner, jobID)
			if err != nil || stopped.State != "uncertain" {
				t.Fatalf("%+v %v", stopped, err)
			}
			_, err = manager.open(context.Background(), owner, "next-fault-job", "simulated", 9100, time.Second, time.Second, time.Minute)
			requireAPIErrorCode(t, err, "TCP_JOB_SERVICE_NOT_READY")
			mu.Lock()
			got := strings.Join(events, "|")
			mu.Unlock()
			if got != "^XA^FDONE^FS^XZ|~HQES|~PP|~JA|~HQES|~HQES" {
				t.Fatal("unexpected printer bytes: ", got)
			}
			if dials != 2 {
				t.Fatal("the new Print request must make exactly one read-only repair probe")
			}
		})
	}
}

func TestServiceFaultFailedClearRemainsQuarantined(t *testing.T) {
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		client, peer := net.Pipe()
		go func() {
			defer peer.Close()
			r := bufio.NewReader(peer)
			_, _ = r.ReadString('\n') // label payload
			_, _ = r.ReadString('\n') // ~HQES
			_, _ = io.WriteString(peer, serviceHqes("00000002"))
			// Close before reading ~PP/~JA: never claim an empty buffer.
		}()
		return client, "simulated", nil
	})
	defer manager.close()
	_, err := manager.open(context.Background(), "owner", "failed-clear", "simulated", 9100, time.Second, time.Second, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("LABEL\r\n")
	if _, err = manager.append("owner", "failed-clear", 1, payload, payloadDigest(payload)); err != nil {
		t.Fatal(err)
	}
	_, err = manager.queryContext(context.Background(), "owner", "failed-clear", []byte("~HQES\r\n"), time.Second, time.Millisecond)
	requireAPIErrorCode(t, err, "TCP_JOB_FAULT_CLEAR_FAILED")
	stopped, err := manager.poll("owner", "failed-clear")
	if err != nil || stopped.State != "uncertain" || stopped.FaultClearRequested {
		t.Fatalf("%+v %v", stopped, err)
	}
}

func TestStatusLossAfterLabelsRequestsClearBeforeClosing(t *testing.T) {
	for _, capture := range []bool{false, true} {
		t.Run(fmt.Sprint("capture=", capture), func(t *testing.T) {
			done := make(chan string, 1)
			manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
				client, peer := net.Pipe()
				go func() {
					defer peer.Close()
					r := bufio.NewReader(peer)
					events := []string{}
					for {
						line, err := r.ReadString('\n')
						if err != nil {
							done <- strings.Join(events, "|")
							return
						}
						events = append(events, strings.TrimSpace(line))
						// A service error may cause ~HS to stay silent.
					}
				}()
				return client, "simulated", nil
			})
			defer manager.close()
			manager.captureDir = t.TempDir()
			var opts *rfidCaptureOptions
			if capture {
				opts = &rfidCaptureOptions{ExpectedLabels: 10, FirstRow: 1, RowStep: 1, Bank: "EPC"}
			}
			const id = "status-lost-run"
			_, err := manager.open(context.Background(), "owner", id, "simulated", 9100, time.Second, time.Second, time.Minute, opts)
			if err != nil {
				t.Fatal(err)
			}
			payload := []byte("LABEL\r\n")
			if _, err = manager.append("owner", id, 1, payload, payloadDigest(payload)); err != nil {
				t.Fatal(err)
			}
			if _, err = manager.queryContext(context.Background(), "owner", id, []byte("~HS\r\n"), 50*time.Millisecond, time.Millisecond); err == nil {
				t.Fatal("silent status was accepted")
			}
			s, err := manager.poll("owner", id)
			if err != nil || s.State != "uncertain" || s.ServiceFault == "" || !s.FaultClearRequested {
				t.Fatalf("%+v %v", s, err)
			}
			if got := <-done; got != "LABEL|~HS|~PP|~JA" {
				t.Fatal(got)
			}
		})
	}
}
