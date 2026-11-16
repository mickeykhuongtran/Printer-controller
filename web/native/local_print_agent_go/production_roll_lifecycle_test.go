package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestProductionClosePreservesHistoryWithoutExportAndNewLotReusesBusinessID(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "previous-lot-run", 1, 0, 1, nil, 0, "finished")
	rawDir := captureDirectory(m.captureDir, "owner", "previous-lot-run")
	manifest, _ := os.ReadFile(filepath.Join(rawDir, "manifest.json"))
	csv, _ := os.ReadFile(filepath.Join(rawDir, "reads.csv"))
	if _, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{PrinterHost: "192.0.2.1", PrinterPort: 9100}); err == nil {
		t.Fatal("silently resumed old lot")
	}
	if _, _, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll)); err == nil {
		t.Fatal("open roll exported")
	}
	closed, _, err := productionCall(t, m, "owner", "roll-close", productionRollRequest{RollID: roll.RollID, ClosedBy: "Operator", Note: "Previous lot ended"})
	if err != nil || closed.Roll.State != "closed" || closed.Roll.ClosedAt == "" || closed.Roll.ClosedBy != "Operator" || closed.Roll.CloseNote != "Previous lot ended" {
		t.Fatalf("close metadata %+v %v", closed.Roll, err)
	}
	if closed.Roll.ExportFileName != "" || closed.ExportFileName != "" || closed.Roll.ExportedAt != "" {
		t.Fatal("close fabricated export")
	}
	files, err := os.ReadDir(productionDirectory(m.captureDir, "owner", roll.RollID))
	if err != nil || len(files) != 1 || files[0].Name() != "roll.json" {
		t.Fatal("close generated export", files, err)
	}
	firstClosed, _ := os.ReadFile(filepath.Join(productionDirectory(m.captureDir, "owner", roll.RollID), "roll.json"))
	_, _, err = productionCall(t, m, "owner", "roll-close", productionRollRequest{RollID: roll.RollID, ClosedBy: "Changed", Note: "Changed"})
	if err != nil {
		t.Fatal(err)
	}
	againClosed, _ := os.ReadFile(filepath.Join(productionDirectory(m.captureDir, "owner", roll.RollID), "roll.json"))
	if !bytes.Equal(firstClosed, againClosed) {
		t.Fatal("repeat close changed history")
	}
	restarted := newTCPJobManager()
	defer restarted.close()
	restarted.captureDir = m.captureDir
	view, _, err := productionCall(t, restarted, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || view.Roll.State != "closed" || len(view.Roll.Runs) != 1 {
		t.Fatal("closure not durable", err)
	}
	next := createProductionTestRoll(t, restarted, 1)
	if next.RollID == roll.RollID {
		t.Fatal("new lot reused history identity")
	}
	productionTestRun(t, restarted, next, "next-lot-run", 1, 1, 1, nil, 0, "finished")
	closeProductionTestRoll(t, restarted, next)
	_, first, err := productionCall(t, restarted, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	_, second, err := productionCall(t, restarted, "owner", "roll-export", productionExportRequest(next))
	if err != nil {
		t.Fatal("duplicate business ID blocked", err)
	}
	if first.Header().Get("Content-Disposition") == second.Header().Get("Content-Disposition") {
		t.Fatal("different rolls have colliding export filenames")
	}
	_, retry, err := productionCall(t, restarted, "owner", "roll-export", productionRollRequest{RollID: roll.RollID, JobID: "changed", Operator: "changed", RollNumber: 99})
	if err != nil || !bytes.Equal(first.Body.Bytes(), retry.Body.Bytes()) {
		t.Fatal("repeat export changed metadata or bytes", err)
	}
	afterManifest, _ := os.ReadFile(filepath.Join(rawDir, "manifest.json"))
	afterCSV, _ := os.ReadFile(filepath.Join(rawDir, "reads.csv"))
	if !bytes.Equal(manifest, afterManifest) || !bytes.Equal(csv, afterCSV) {
		t.Fatal("close/export/new lot modified raw evidence")
	}
	if err := registerProductionRun(m.captureDir, "owner", "late-run", "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, Bank: "EPC"}); err == nil {
		t.Fatal("closed roll accepted late registration")
	}
}

func TestProductionAdmissionConflictReportsNotSentBeforeDial(t *testing.T) {
	var dials atomic.Int32
	m := newTCPJobManagerWithDialAndQueue(func(context.Context, string, int, time.Duration) (net.Conn, string, error) {
		dials.Add(1)
		return nil, "", errors.New("test dial")
	}, nil)
	defer m.close()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "admission-old-run", 1, 0, 1, nil, 0, "finished")
	_, err := m.open(context.Background(), "owner", "new-print-job", "192.0.2.1", 9100, time.Second, time.Second, time.Minute)
	if err == nil || dials.Load() != 0 {
		t.Fatal("blocked print dialed", err, dials.Load())
	}
	response := httptest.NewRecorder()
	(&appServer{}).writeError(response, err)
	var payload map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["code"] != "PRODUCTION_ROLL_CONFLICT" || payload["stage"] != "admission" || payload["outcome"] != "not_sent" || payload["retrySafety"] != "safe" || payload["bytesWritten"] != float64(0) || payload["writeStarted"] != false {
		t.Fatal("incorrect public admission outcome", payload)
	}
	closeProductionTestRoll(t, m, roll)
	_, err = m.open(context.Background(), "owner", "after-close-job", "192.0.2.1", 9100, time.Second, time.Second, time.Minute)
	if err == nil || err.Error() != "test dial" || dials.Load() != 1 {
		t.Fatal("close did not release logical binding", err, dials.Load())
	}
	_, err = m.open(context.Background(), "owner", "closed-capture-job", "192.0.2.1", 9100, time.Second, time.Second, time.Minute, &rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, Bank: "EPC", ExpectedLabels: 1, FirstRow: 1, RowStep: 1})
	if err == nil || dials.Load() != 1 {
		t.Fatal("closed capture reached dial", err, dials.Load())
	}
	// Closing a lot does not resolve the independent physical-print quarantine.
	session := &tcpJobSession{owner: "owner", jobID: "uncertain-old-job", host: "192.0.2.1", port: 9100, state: "uncertain", cumulativeBytes: 10, nextSequence: 2}
	m.mu.Lock()
	m.jobs[tcpJobMapKey(session.owner, session.jobID)] = session
	m.mu.Unlock()
	_, err = m.open(context.Background(), "owner", "quarantined-new-job", "192.0.2.1", 9100, time.Second, time.Second, time.Minute)
	var apiErr *apiError
	if !errors.As(err, &apiErr) || apiErr.Code != "TCP_JOB_TARGET_QUARANTINED" || apiErr.Outcome != "possibly_sent" || dials.Load() != 1 {
		t.Fatal("close removed uncertainty", err, dials.Load())
	}
}

func TestProductionCloseRejectsQueuedJobBeforeRunRegistration(t *testing.T) {
	queue := newPrinterTargetQueue()
	var dials atomic.Int32
	m := newTCPJobManagerWithDialAndQueue(func(context.Context, string, int, time.Duration) (net.Conn, string, error) {
		dials.Add(1)
		return nil, "", errors.New("test dial")
	}, queue)
	defer m.close()
	m.captureDir = t.TempDir()
	v, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{PrinterHost: "192.0.2.1", PrinterPort: 9100, TemplateFingerprint: productionTestFingerprint, OperationMode: "read", Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	reservation, err := queue.reserve(tcpPrinterTargetKey("192.0.2.1", 9100))
	if err != nil {
		t.Fatal(err)
	}
	defer reservation.release()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := m.open(ctx, "owner", "queued-close-run", "192.0.2.1", 9100, time.Second, time.Second, time.Minute, &rfidCaptureOptions{ProductionRollID: v.Roll.RollID, TemplateFingerprint: productionTestFingerprint, Bank: "EPC", ExpectedLabels: 1, FirstRow: 1, RowStep: 1})
		done <- err
	}()
	deadline := time.Now().Add(3 * time.Second)
	for !m.productionActiveRuns("owner")["roll:"+v.Roll.RollID] {
		if time.Now().After(deadline) {
			t.Fatal("job did not queue")
		}
		time.Sleep(time.Millisecond)
	}
	if _, _, err := productionCall(t, m, "owner", "roll-close", productionRollRequest{RollID: v.Roll.RollID}); err == nil {
		t.Fatal("closed queued job")
	}
	saved, err := readProductionRoll(m.captureDir, "owner", v.Roll.RollID)
	if err != nil || saved.State != "open" || len(saved.Runs) != 0 || dials.Load() != 0 {
		t.Fatal("queued close changed state", saved, err)
	}
	cancel()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("queue did not cancel")
	}
	closeProductionTestRoll(t, m, v.Roll)
}

func TestProductionCloseAndRegistrationAreSerialized(t *testing.T) {
	for i := 0; i < 12; i++ {
		m := newTCPJobManager()
		m.captureDir = t.TempDir()
		roll := createProductionTestRoll(t, m, 1)
		start := make(chan struct{})
		registered := make(chan *rfidCapture, 1)
		closed := make(chan error, 1)
		go func() {
			<-start
			c, _ := newRfidCapture(m.captureDir, "owner", "racing-run", "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, Bank: "EPC", ExpectedLabels: 1, FirstRow: 1, RowStep: 1})
			registered <- c
		}()
		go func() {
			<-start
			w := httptest.NewRecorder()
			p := productionRollRequest{RollID: roll.RollID}
			closed <- m.handleProductionRoll(w, httptest.NewRequest("POST", "/tcp-job", nil), "owner", tcpJobRequest{Action: "roll-close", Production: &p})
		}()
		close(start)
		c := <-registered
		closeErr := <-closed
		saved, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
		if err != nil {
			t.Fatal(err)
		}
		if c != nil {
			if closeErr == nil || saved.State != "open" || len(saved.Runs) != 1 {
				t.Fatal("close accepted live registered run", closeErr, saved)
			}
			close(c.done)
			_ = c.close(nil, "aborted")
		} else if closeErr != nil || saved.State != "closed" || len(saved.Runs) != 0 {
			t.Fatal("late registration changed closed history", closeErr, saved)
		}
		m.close()
	}
}

func TestProductionCloseCorruptEvidenceRetainsWarningsAndBytes(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "corrupt-old-run", 1, 0, 1, nil, 0, "finished")
	path := filepath.Join(captureDirectory(m.captureDir, "owner", "corrupt-old-run"), "reads.csv")
	corrupt := []byte("job_id,ordinal,source_row,bank,data_hex,received_at_utc,result\n\"truncated")
	if err := os.WriteFile(path, corrupt, 0600); err != nil {
		t.Fatal(err)
	}
	view, _, err := productionCall(t, m, "owner", "roll-close", productionRollRequest{RollID: roll.RollID})
	if err != nil || view.Roll.State != "closed" || view.Summary.CountsComplete || view.Summary.GoodCountKnown || len(view.Roll.CloseWarnings) == 0 || len(view.Summary.Blockers) == 0 {
		t.Fatal("corrupt close hid uncertainty", view, err)
	}
	if _, _, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll)); err == nil {
		t.Fatal("corrupt evidence exported as complete")
	}
	actual, _ := os.ReadFile(path)
	if !bytes.Equal(actual, corrupt) {
		t.Fatal("corrupt evidence was rewritten")
	}
	next := createProductionTestRoll(t, m, 1)
	if next.RollID == roll.RollID {
		t.Fatal("corrupt closed lot not released")
	}
}

func TestProductionClosedLegacyRemovalExportsUnclassifiedEvidence(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	m.captureDir = t.TempDir()
	roll := productionWriteTestRoll(t, m)
	productionWriteRun(t, m, roll, "legacy-unclassified", 3, 1, []string{"0001", "9999", "0003"}, 3, 0)
	saved, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
	if err != nil {
		t.Fatal(err)
	}
	saved.RemovalAccountingVersion = 0
	saved.RemovedValidCount = 1
	if err := saveProductionRoll(m.captureDir, "owner", saved); err != nil {
		t.Fatal(err)
	}
	closeProductionTestRoll(t, m, roll)
	_, output, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal("closed legacy classification stranded export", err)
	}
	if !strings.Contains(output.Body.String(), "Unclassified removed,1,GOOD quantity,UNKNOWN") {
		t.Fatal("legacy total or uncertainty omitted")
	}
	view, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || view.Summary.GoodCountKnown || !view.Summary.RemovalReviewRequired {
		t.Fatal("closed legacy removal certified", view, err)
	}
}
