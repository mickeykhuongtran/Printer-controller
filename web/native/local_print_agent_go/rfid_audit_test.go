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

var auditQueries = []string{
	`! U1 getvar "odometer.rfid.valid_resettable"` + "\r\n",
	`! U1 getvar "odometer.rfid.void_resettable"` + "\r\n",
	`! U1 getvar "odometer.total_label_count"` + "\r\n",
}

func TestRfidCounterFramingIgnoresPreviousLineEnding(t *testing.T) {
	for _, response := range []string{"", "\r\n", " \r\n", `"12`, "\r\n\"12"} {
		if completeRfidCounterResponse(auditQueries[0], response) {
			t.Fatalf("incomplete counter accepted: %q", response)
		}
	}
	for _, response := range []string{`"123"`, "123\r\n", "\r\n\"123\"\r\n", `"?"`} {
		if !completeRfidCounterResponse(auditQueries[0], response) {
			t.Fatalf("complete counter not recognized: %q", response)
		}
	}
}

func TestRfidBatchCountersGateSubmissionAndPersistAggregateVoid(t *testing.T) {
	const id = "aggregate-void-test"
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		client, peer := net.Pipe()
		go func() {
			defer peer.Close()
			values := map[string]int{"valid": 100, "void": 7, "total": 110}
			scanner := bufio.NewScanner(peer)
			for scanner.Scan() {
				if scanner.Text() == "~HS" {
					io.WriteString(peer, recoveryHS("000"))
				} else if scanner.Text() == "~HQES" {
					io.WriteString(peer, strings.Replace(serviceHqes("00000000"), "ERRORS: 1", "ERRORS: 0", 1))
				} else if scanner.Text() == "^XZ" && values["valid"] == 100 {
					values["valid"] += 2
					values["void"] += 3
					values["total"] += 5
					io.WriteString(peer, "NWEP|"+id+"|1|0001|END\r\nNWEP|"+id+"|2|0002|END\r\n")
				} else if name := rfidCounterName(scanner.Text()); name != "" {
					// A quoted SGD response is complete even without CR/LF; split it.
					io.WriteString(peer, "\"")
					fmt.Fprintf(peer, "%d\"", values[name])
				}
			}
		}()
		return client, "printer", nil
	})
	defer manager.close()
	manager.captureDir = t.TempDir()
	options := &rfidCaptureOptions{ExpectedLabels: 5, FirstRow: 10, RowStep: -1, Bank: "EPC", AuditBatchCounters: true}
	if _, err := manager.open(context.Background(), "owner", id, "printer", 9100, time.Second, time.Second, time.Minute, options); err != nil {
		t.Fatal(err)
	}
	var formats strings.Builder
	for n := 1; n <= 5; n++ {
		formats.WriteString(reconciliationFormat(id, n))
	}
	payload := []byte(formats.String())
	receipt, err := manager.append("owner", id, 1, payload, payloadDigest(payload))
	if err != nil {
		t.Fatal(err)
	}
	result, err := manager.finish("owner", id, 1, receipt.CumulativeBytes, receipt.CheckpointHash)
	if err != nil {
		t.Fatal(err)
	}
	if result.Capture.State != "complete" || result.Capture.Audit.State != "matched" || result.Capture.Audit.VoidDelta != 3 {
		t.Fatalf("incorrect audit: %+v", result.Capture)
	}
	if _, err := os.Stat(filepath.Join(captureDirectory(manager.captureDir, "owner", id), rfidCaptureFileName(*result.Capture))); !os.IsNotExist(err) {
		t.Fatal("Human-readable report must not be generated before an explicit export")
	}
	exported := httptest.NewRecorder()
	if err := manager.handleCaptureHistory(exported, httptest.NewRequest("POST", "/", nil), "owner", tcpJobRequest{Action: "capture-export", JobID: id}); err != nil {
		t.Fatal(err)
	}
	data := exported.Body.Bytes()
	rows, err := csv.NewReader(bytes.NewReader(data)).ReadAll()
	if err != nil || len(rows) != 6 {
		t.Fatalf("invalid report %s: %v", data, err)
	}
	if rows[1][6] != "READ_OK" || rows[2][2] != "9" || rows[3][6] != "NO_READBACK" || rows[4][6] != "VOID_TOTAL" || rows[4][8] != "3" || rows[5][6] != "MATCHED" {
		t.Fatal(rows)
	}
	for _, index := range []int{1, 2, 4} {
		if rows[4][index] != "" {
			t.Fatal("aggregate VOID invented per-tag identity", rows[4])
		}
	}
}

func TestRfidAuditNeverCompletesUnverifiedTotals(t *testing.T) {
	base := rfidCounterSnapshot{Valid: 10, Void: 5, Total: 15, HaveValid: true, HaveVoid: true, HaveTotal: true}
	end := rfidCounterSnapshot{Valid: 12, Void: 6, Total: 18, HaveValid: true, HaveVoid: true, HaveTotal: true, Sequence: 2}
	for _, tc := range []struct {
		name, state string
		change      func(*rfidCapture)
	}{
		{"missing_final", "unavailable", func(c *rfidCapture) { c.summary.Audit.Latest.HaveVoid = false }},
		{"stale_final", "unavailable", func(c *rfidCapture) { c.summary.Audit.LastSubmittedSequence++ }},
		{"reset", "counter_reset", func(c *rfidCapture) { c.summary.Audit.Latest.Void = 0 }},
		{"read_only_counter_unchanged", "needs_review", func(c *rfidCapture) { c.summary.Audit.Latest.Valid = 10 }},
		{"other_job_labels", "needs_review", func(c *rfidCapture) { c.summary.Audit.Latest.Total = 99 }},
		{"duplicate_read", "needs_review", func(c *rfidCapture) { c.summary.State = "incomplete" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := &rfidCapture{summary: rfidCaptureSummary{State: "complete", Options: rfidCaptureOptions{ExpectedLabels: 2, AuditBatchCounters: true}, Audit: rfidBatchAudit{Baseline: base, Latest: end, LastSubmittedSequence: 2}}}
			tc.change(c)
			c.finalizeAuditLocked("finished")
			if c.summary.State != "incomplete" || c.summary.Audit.State != tc.state {
				t.Fatalf("false pass: %+v", c.summary)
			}
		})
	}
}

func TestRfidReportLocalTimeAndMissingAreNotVoid(t *testing.T) {
	old := time.Local
	time.Local = time.FixedZone("ICT", 7*3600)
	defer func() { time.Local = old }()
	summary := rfidCaptureSummary{JobID: "time-test", State: "interrupted", Options: rfidCaptureOptions{ExpectedLabels: 5, FirstRow: 9, RowStep: -1, Bank: "EPC"}}
	raw := "job_id,ordinal,source_row,bank,data_hex,received_at_utc,result\n" +
		"time-test,1,9,EPC,0001,2026-10-14T02:44:00.6128408Z,read\n" +
		"time-test,2,8,EPC,,2026-10-14T02:44:01Z,invalid_read\n" +
		"broken,tail\n"
	var output bytes.Buffer
	if err := exportRfidResultReport(&output, strings.NewReader(raw), summary); err != nil {
		t.Fatal(err)
	}
	rows, err := csv.NewReader(&output).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if rows[1][5] != "2026-10-14 09:44:00.612" || rows[1][9] != "+07:00" || rows[1][10] != "2026-10-14T02:44:00.6128408Z" {
		t.Fatal("wrong time", rows[1])
	}
	if rows[2][6] != "RFID_READ_ERROR" || rows[3][6] != "TRUNCATED_RECORD" {
		t.Fatal(rows)
	}
	if rows[4][6] != "NO_READBACK" || rows[4][1] != "3" || rows[4][8] != "3" || rows[5][6] != "VOID_TOTAL_UNVERIFIED" || rows[5][8] != "" {
		t.Fatal("missing was inferred as VOID", rows)
	}
}

func TestRfidCrashWithSavedCountersDoesNotDoubleCount(t *testing.T) {
	root := t.TempDir()
	const id = "crashed-after-snapshot"
	c, err := newRfidCapture(root, "owner", id, "printer", 9100, rfidCaptureOptions{ExpectedLabels: 2, FirstRow: 1, RowStep: 1, Bank: "EPC", AuditBatchCounters: true})
	if err != nil {
		t.Fatal(err)
	}
	c.feed([]byte("NWEP|" + id + "|1|0001|END\r\n"))
	for _, command := range auditQueries {
		if err := c.recordCounter(command, `"10"`, 1, 1); err != nil {
			t.Fatal(err)
		}
	}
	c.feed([]byte("NWEP|" + id + "|2|0002|END\r\n"))
	c.file.Close() // No terminal manifest: simulate process loss.
	m := newTCPJobManager()
	defer m.close()
	m.captureDir = root
	list := httptest.NewRecorder()
	if err := m.handleCaptureHistory(list, httptest.NewRequest("POST", "/", nil), "owner", tcpJobRequest{Action: "capture-list"}); err != nil {
		t.Fatal(err)
	}
	var history struct {
		Sessions []rfidCaptureSummary `json:"sessions"`
	}
	if err := json.Unmarshal(list.Body.Bytes(), &history); err != nil {
		t.Fatal(err)
	}
	if len(history.Sessions) != 1 || history.Sessions[0].Received != 2 || history.Sessions[0].UniqueLabels != 2 || history.Sessions[0].Audit.State != "unavailable" {
		t.Fatal(list.Body.String())
	}
	export := httptest.NewRecorder()
	if err := m.handleCaptureHistory(export, httptest.NewRequest("POST", "/", nil), "owner", tcpJobRequest{Action: "capture-export", JobID: id}); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(export.Body.String(), ",interrupted,unavailable,") || !strings.Contains(export.Body.String(), ",VOID_TOTAL_UNVERIFIED,") {
		t.Fatal(export.Body.String())
	}
}

func TestRfidUnsupportedCounterCannotBecomeZero(t *testing.T) {
	c, err := newRfidCapture(t.TempDir(), "owner", "unsupported-counter", "printer", 9100, rfidCaptureOptions{ExpectedLabels: 1, FirstRow: 1, RowStep: 1, Bank: "EPC", AuditBatchCounters: true})
	if err != nil {
		t.Fatal(err)
	}
	defer c.file.Close()
	if err := c.recordCounter(auditQueries[0], `"?"`, 0, 0); err == nil || c.snapshot().Audit.Baseline.HaveValid {
		t.Fatal("unsupported counter treated as zero")
	}
}

func TestRfidCloseDoesNotRequireAnAutomaticPresentationReport(t *testing.T) {
	c, err := newRfidCapture(t.TempDir(), "owner", "report-disk-failure", "printer", 9100, rfidCaptureOptions{ExpectedLabels: 1, FirstRow: 1, RowStep: 1, Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	c.feed([]byte("NWEP|report-disk-failure|1|0001|END\r\n"))
	// A presentation-report destination must not be touched by capture close.
	if err := os.Mkdir(filepath.Join(c.dir, rfidCaptureFileName(*c.snapshot())), 0700); err != nil {
		t.Fatal(err)
	}
	close(c.done)
	if err := c.close(nil, "finished"); err != nil {
		t.Fatal(err)
	}
	if s := c.snapshot(); s.State != "complete" || s.Error != "" {
		t.Fatalf("raw evidence collection should complete without presentation CSV: %+v", s)
	}
}

func TestRfidContinuousPhysicalAttemptsAcrossVoidAndMissingResponse(t *testing.T) {
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		client, peer := net.Pipe()
		go func() { defer peer.Close(); io.Copy(io.Discard, peer) }()
		return client, "simulated", nil
	})
	defer manager.close()
	manager.captureDir = t.TempDir()
	const owner, id = "owner", "physical-attempts-2500"
	_, err := manager.open(context.Background(), owner, id, "simulated", 9100, time.Second, time.Second, time.Minute,
		&rfidCaptureOptions{ExpectedLabels: 2500, FirstRow: 1, RowStep: 1, Bank: "EPC", AuditBatchCounters: true})
	if err != nil {
		t.Fatal(err)
	}
	session, _ := manager.lookup(owner, id)
	c := session.capture
	// This fixture exercises legacy imported audit/readback compatibility.
	c.summary.Audit.LifecycleVersion = 0
	for _, command := range auditQueries {
		if err := c.recordCounter(command, `"0"`, 0, 0); err != nil {
			t.Fatal(err)
		}
	}
	var receipt tcpJobResult
	for chunk := 1; chunk <= 250; chunk++ {
		payload := []byte(fmt.Sprintf("CHUNK%d\n", chunk))
		receipt, err = manager.append(owner, id, chunk, payload, payloadDigest(payload))
		if err != nil {
			t.Fatalf("physical stream stopped at chunk %d: %v", chunk, err)
		}
		for ordinal := (chunk-1)*10 + 1; ordinal <= chunk*10; ordinal++ {
			if ordinal == 1250 {
				continue
			} // Some firmware emits no ^HV on VOID.
			data := fmt.Sprintf("%08X", ordinal)
			if ordinal == 273 {
				data = ""
			} // Other firmware emits an empty failed read.
			c.feed([]byte(fmt.Sprintf("NWEP|%s|%d|%s|END\r\n", id, ordinal, data)))
		}
	}
	for index, value := range []string{`"2498"`, `"2"`, `"2498"`} {
		if err := c.recordCounter(auditQueries[index], value, receipt.CumulativeBytes, 250); err != nil {
			t.Fatal(err)
		}
	}
	finished, err := manager.finish(owner, id, 250, receipt.CumulativeBytes, receipt.CheckpointHash)
	if err != nil {
		t.Fatal(err)
	}
	s := finished.Capture
	if s.State != "complete" || s.Audit.State != "matched" || s.UniqueLabels != 2498 || s.InvalidReads != 1 || s.Issues != 0 || s.Audit.VoidDelta != 2 {
		t.Fatalf("valid+VOID batch did not finish: %+v", s)
	}
	if _, err := manager.open(context.Background(), owner, "physical-top-up-2", "simulated", 9100, time.Second, time.Second, time.Minute); err != nil {
		t.Fatal("completed VOID batch blocked manual top-up", err)
	}
}

func TestRfidQualityWarningsDoNotStopOrQuarantinePhysicalJob(t *testing.T) {
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		client, peer := net.Pipe()
		go func() { defer peer.Close(); io.Copy(io.Discard, peer) }()
		return client, "simulated", nil
	})
	defer manager.close()
	manager.captureDir = t.TempDir()
	const owner, id = "owner", "quality-warning-run"
	_, err := manager.open(context.Background(), owner, id, "simulated", 9100, time.Second, time.Second, time.Minute,
		&rfidCaptureOptions{ExpectedLabels: 3, FirstRow: 1, RowStep: 1, Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	session, _ := manager.lookup(owner, id)
	session.capture.feed([]byte("NWEP|" + id + "|1|0001|END\r\nNWEP|" + id + "|1|0001|END\r\nNWEP|" + id + "|2|0001|END\r\n"))
	payload := []byte("NEXT\n")
	receipt, err := manager.append(owner, id, 1, payload, payloadDigest(payload))
	if err != nil {
		t.Fatal("readback warning stopped subsequent labels", err)
	}
	finished, err := manager.finish(owner, id, 1, receipt.CumulativeBytes, receipt.CheckpointHash)
	if err != nil || finished.Capture.State != "incomplete" || finished.Capture.Issues != 2 {
		t.Fatalf("warning evidence lost or job quarantined: %+v %v", finished, err)
	}
	if _, err := manager.open(context.Background(), owner, "after-quality-warning", "simulated", 9100, time.Second, time.Second, time.Minute); err != nil {
		t.Fatal(err)
	}
}
