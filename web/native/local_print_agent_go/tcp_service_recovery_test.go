package main

import (
	"bufio"
	"context"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func recoveryHS(queued string) string {
	return "\x02000,0,1,0251," + queued + ",0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,1,2,6,0,00000000,1,001\x03\r\n\x021234,1\x03\r\n"
}

func TestServiceRecoveryRequiresFreshFaultFreeEmptyQueue(t *testing.T) {
	for _, tc := range []struct {
		name, health, host string
		wantReady          bool
	}{
		{"repaired_paused", serviceHqes("00010000"), recoveryHS("000"), true},
		{"still_open", serviceHqes("00010004"), recoveryHS("000"), false},
		{"old_formats_remain", serviceHqes("00010000"), recoveryHS("019"), false},
		{"malformed_empty", serviceHqes("00010000"), "\x02broken\x03\r\n\x02broken\x03\r\n\x02broken\x03\r\n", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			events := []string{}
			resumed := make(chan struct{}, 1)
			dials := 0
			m := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
				dials++
				client, peer := net.Pipe()
				go func() {
					defer peer.Close()
					scanner := bufio.NewScanner(peer)
					for scanner.Scan() {
						command := scanner.Text()
						mu.Lock()
						events = append(events, command)
						mu.Unlock()
						if command == "~PS" {
							resumed <- struct{}{}
						}
						if command == "~HQES" {
							io.WriteString(peer, tc.health)
						}
						if command == "~HS" {
							io.WriteString(peer, tc.host)
						}
					}
				}()
				return client, "simulated", nil
			})
			defer m.close()
			old := &tcpJobSession{owner: "owner", jobID: "service-old", host: "simulated", port: 9100, state: "uncertain", serviceFault: "Printhead open", faultClearRequested: true, cumulativeBytes: 100, nextSequence: 2, terminalAt: time.Now()}
			m.jobs[tcpJobMapKey(old.owner, old.jobID)] = old
			_, err := m.open(context.Background(), "owner", "service-next", "simulated", 9100, time.Second, time.Second, time.Minute)
			if tc.wantReady {
				if err != nil || !old.reconciled || dials != 2 {
					t.Fatalf("new run not admitted after verified repair: %v old=%+v dials=%d", err, old, dials)
				}
				select {
				case <-resumed:
				case <-time.After(time.Second):
					t.Fatal("verified paused printer was not resumed")
				}
			} else {
				requireAPIErrorCode(t, err, "TCP_JOB_SERVICE_NOT_READY")
				if old.reconciled || dials != 1 {
					t.Fatal("unverified queue released")
				}
			}
			mu.Lock()
			got := strings.Join(events, "|")
			mu.Unlock()
			if tc.wantReady && got != "~HQES|~HS|~PS" {
				t.Fatal("recovery must never replay labels", got)
			}
			if !tc.wantReady && strings.Contains(got, "~PS") {
				t.Fatal("unverified printer resumed", got)
			}
		})
	}
}
