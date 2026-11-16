package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

const productionTestFingerprint = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"

func productionCall(t *testing.T, m *tcpJobManager, owner, action string, p productionRollRequest) (productionRollView, *httptest.ResponseRecorder, error) {
	t.Helper()
	w := httptest.NewRecorder()
	err := m.handleProductionRoll(w, httptest.NewRequest("POST", "/tcp-job", nil), owner, tcpJobRequest{Action: action, Production: &p})
	var v productionRollView
	if err == nil && action != "roll-export" {
		if e := json.Unmarshal(w.Body.Bytes(), &v); e != nil {
			t.Fatal(e)
		}
	}
	return v, w, err
}
func createProductionTestRoll(t *testing.T, m *tcpJobManager, target int) productionRoll {
	t.Helper()
	v, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{TargetLabels: target, TemplateName: "Approved", TemplateFingerprint: productionTestFingerprint})
	if err != nil {
		t.Fatal(err)
	}
	if v.Roll.JobID != "" || v.Roll.Operator != "" || v.Roll.RollNumber != 0 {
		t.Fatal("metadata populated before export")
	}
	return v.Roll
}
func productionTestRun(t *testing.T, m *tcpJobManager, roll productionRoll, id string, expected, start, readCount int, invalid map[int]bool, void int64, terminal string) {
	t.Helper()
	c, err := newRfidCapture(m.captureDir, "owner", id, "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateName: roll.TemplateName, TemplateFingerprint: roll.TemplateFingerprint, ExpectedLabels: expected, FirstRow: 1, RowStep: 1, Bank: "EPC", AuditBatchCounters: true})
	if err != nil {
		t.Fatal(err)
	}
	valid := 0
	for i := 1; i <= readCount; i++ {
		value := fmt.Sprintf("%08X", start+i)
		if invalid[i] {
			value = ""
		} else {
			valid++
		}
		c.feed([]byte(fmt.Sprintf("NWEP|%s|%d|%s|END\r\n", id, i, value)))
	}
	c.mu.Lock()
	c.summary.Audit = rfidBatchAudit{State: "sampling", LastSubmittedSequence: 1, Baseline: rfidCounterSnapshot{HaveValid: true, HaveVoid: true, HaveTotal: true}, Latest: rfidCounterSnapshot{HaveValid: true, HaveVoid: true, HaveTotal: true, Sequence: 1, Valid: int64(valid), Void: void, Total: int64(valid) + void, At: time.Now().UTC().Format(time.RFC3339Nano)}}
	c.mu.Unlock()
	if terminal != "finished" {
		c.recordServiceFault("head_open", time.Now().UTC().Format(time.RFC3339Nano), true)
	}
	close(c.done)
	if err := c.close(nil, terminal); err != nil {
		t.Fatal(err)
	}
}
func closeProductionTestRoll(t *testing.T, m *tcpJobManager, roll productionRoll) {
	t.Helper()
	if _, _, err := productionCall(t, m, "owner", "roll-close", productionRollRequest{RollID: roll.RollID}); err != nil {
		t.Fatal(err)
	}
}
func resumeProductionTestRoll(t *testing.T, m *tcpJobManager, roll productionRoll) productionRoll {
	t.Helper()
	v, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{RollID: roll.RollID, TemplateFingerprint: productionTestFingerprint})
	if err != nil {
		t.Fatal(err)
	}
	return v.Roll
}
func productionExportRequest(roll productionRoll) productionRollRequest {
	return productionRollRequest{RollID: roll.RollID, Operator: "Phước", JobID: "JOB-001", RollNumber: 3}
}
func productionCSVRows(t *testing.T, plain []byte) [][]string {
	t.Helper()
	r := csv.NewReader(strings.NewReader(strings.TrimPrefix(string(plain), "\ufeff")))
	rows, err := r.ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		if len(row) != 7 {
			t.Fatal("unexpected columns", row)
		}
	}
	return rows
}
func TestProductionRoll2500AttemptsThenReplacementRemainOneExport(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 2500)
	productionTestRun(t, m, roll, "production-run-1", 2500, 0, 2500, map[int]bool{273: true, 1450: true}, 2, "finished")
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.ValidCount != 2498 || v.Summary.VoidCount != 2 || v.Summary.TotalCount != 2500 || !v.Summary.CountsComplete || !v.Summary.CanFinalize {
		t.Fatalf("VOID blocked: %+v %v", v.Summary, err)
	}
	if next := resumeProductionTestRoll(t, m, roll); next.RollID != roll.RollID {
		t.Fatal("replacement split roll")
	}
	productionTestRun(t, m, roll, "production-run-2", 2, 2500, 2, nil, 0, "finished")
	files, err := os.ReadDir(productionDirectory(m.captureDir, "owner", roll.RollID))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 || files[0].Name() != "roll.json" {
		t.Fatal("export emitted automatically")
	}
	closeProductionTestRoll(t, m, roll)
	before := time.Now()
	_, download, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	if download.Header().Get("Content-Type") != "text/csv; charset=utf-8" || !strings.Contains(download.Header().Get("Content-Disposition"), ".csv") || !bytes.HasPrefix(download.Body.Bytes(), []byte("\ufeff")) {
		t.Fatal("export must be a directly readable UTF-8 CSV")
	}
	rows := productionCSVRows(t, download.Body.Bytes())
	if rows[0][1] != "Phước" || rows[2][1] != "JOB-001" || rows[3][1] != "3" || strings.Join(rows[4][:6], ",") != "Total,2502,Valid,2500,Void,2" {
		t.Fatal(rows[:5])
	}
	header, valid, failed, observed, voidTotal := false, 0, 0, 0, false
	for _, row := range rows {
		if row[0] == "ordinal" {
			header = true
			if strings.Join(row, ",") != "ordinal,host_time,bank,value,result,received_time,detail" {
				t.Fatal(row)
			}
			continue
		}
		if !header {
			continue
		}
		if row[0] != "" {
			observed++
			if row[0] != strconv.Itoa(observed) || row[6] != "read" || row[1] == "" || row[5] == "" {
				t.Fatal("bad record", row)
			}
		}
		if row[4] == "READ_OK" {
			valid++
		}
		if row[4] == "READ_ERROR" {
			failed++
			if row[3] != "" {
				t.Fatal("invented EPC")
			}
		}
		if row[4] == "VOID_TOTAL:2" {
			voidTotal = row[0] == "" && row[3] == ""
		}
	}
	if observed != 2502 || valid != 2500 || failed != 2 || !voidTotal {
		t.Fatalf("records %d %d %d %t", observed, valid, failed, voidTotal)
	}
	v, _, err = productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Roll.State != "closed" {
		t.Fatal("not closed", err)
	}
	stamp, err := time.Parse(time.RFC3339Nano, v.Roll.ExportedAt)
	if err != nil || stamp.Before(before) || stamp.After(time.Now()) {
		t.Fatal("wrong export time")
	}
	_, retry, err := productionCall(t, m, "owner", "roll-export", productionRollRequest{RollID: roll.RollID})
	if err != nil || !bytes.Equal(retry.Body.Bytes(), download.Body.Bytes()) {
		t.Fatal("non-idempotent export", err)
	}
	if next := createProductionTestRoll(t, m, 2500); next.RollID == roll.RollID {
		t.Fatal("next roll not created")
	}
	if _, _, err := productionCall(t, m, "other", "roll-get", productionRollRequest{RollID: roll.RollID}); err == nil {
		t.Fatal("cross-owner leak")
	}
}
func TestProductionRollServiceFaultAndRestartRetainAllRuns(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 2500)
	productionTestRun(t, m, roll, "interrupted-run", 2500, 0, 5, map[int]bool{3: true}, 1, "aborted")
	restarted := newTCPJobManager()
	restarted.captureDir = m.captureDir
	if resumed := resumeProductionTestRoll(t, restarted, roll); resumed.RollID != roll.RollID {
		t.Fatal("restart split roll")
	}
	productionTestRun(t, restarted, roll, "replacement-run", 3, 5, 3, nil, 0, "finished")
	v, _, err := productionCall(t, restarted, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || len(v.Roll.Runs) != 2 || v.Summary.ValidCount != 7 || v.Summary.VoidCount != 1 || v.Summary.CountsComplete || v.Summary.PrinterValidKnown || v.Summary.GoodCountKnown || !v.Summary.CanFinalize {
		t.Fatalf("interruption lost/blocked history %+v %v", v, err)
	}
	closeProductionTestRoll(t, restarted, roll)
	_, download, err := productionCall(t, restarted, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, row := range productionCSVRows(t, download.Body.Bytes()) {
		if row[4] == "VOID_OBSERVED:1" && row[0] == "" && row[3] == "" {
			found = true
		}
	}
	if !found {
		t.Fatal("lost interrupted VOID lower bound")
	}
}

type disconnectedProductionResponse struct{ header http.Header }

func (w *disconnectedProductionResponse) Header() http.Header { return w.header }
func (w *disconnectedProductionResponse) WriteHeader(int)     {}
func (w *disconnectedProductionResponse) Write([]byte) (int, error) {
	return 0, errors.New("download connection lost")
}
func TestProductionRollFailedDownloadRetryDoesNotReopen(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 2)
	productionTestRun(t, m, roll, "before-disconnect", 1, 0, 1, nil, 0, "finished")
	closeProductionTestRoll(t, m, roll)
	p := productionExportRequest(roll)
	err := m.handleProductionRoll(&disconnectedProductionResponse{header: http.Header{}}, httptest.NewRequest("POST", "/tcp-job", nil), "owner", tcpJobRequest{Action: "roll-export", Production: &p})
	if err == nil || !strings.Contains(err.Error(), "connection lost") {
		t.Fatal(err)
	}
	pending, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
	if err != nil || pending.State != "closed" {
		t.Fatal("failed download changed closure", err)
	}
	if err := registerProductionRun(m.captureDir, "owner", "after-disconnect", "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, Bank: "EPC"}); err == nil {
		t.Fatal("failed download reopened roll for later print")
	}
	_, download, err := productionCall(t, m, "owner", "roll-export", p)
	if err != nil {
		t.Fatal(err)
	}
	if rows := productionCSVRows(t, download.Body.Bytes()); rows[4][3] != "1" {
		t.Fatal("retry changed closed snapshot")
	}
	closed, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(productionDirectory(m.captureDir, "owner", roll.RollID), closed.ExportFileName), []byte("modified"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := productionCall(t, m, "owner", "roll-export", productionRollRequest{RollID: roll.RollID}); err == nil {
		t.Fatal("modified export replaced")
	}
}
func TestProductionRollFailedExportStorageDoesNotReopenOrBlockNewRoll(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "storage-run", 1, 0, 1, nil, 0, "finished")
	closeProductionTestRoll(t, m, roll)
	receipt := filepath.Join(productionDirectory(m.captureDir, "owner", roll.RollID), "final-export.json")
	if err := os.Mkdir(receipt, 0700); err != nil {
		t.Fatal(err)
	}
	if _, _, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll)); err == nil {
		t.Fatal("storage failure ignored")
	}
	pending, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
	if err != nil || pending.State != "closed" {
		t.Fatal("storage failure changed closure", err)
	}
	next := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, next, "storage-replacement", 1, 1, 1, nil, 0, "finished")
	if err := os.Remove(receipt); err != nil {
		t.Fatal(err)
	}
	if _, _, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll)); err != nil {
		t.Fatal(err)
	}
}
func TestProductionRollActivePrintAndMetadataValidation(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	c, err := newRfidCapture(m.captureDir, "owner", "active-run", "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, ExpectedLabels: 1, FirstRow: 1, RowStep: 1, Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll)); err == nil {
		t.Fatal("active print exported")
	}
	c.feed([]byte("NWEP|active-run|1|0001|END\r\n"))
	close(c.done)
	if err := c.close(nil, "finished"); err != nil {
		t.Fatal(err)
	}
	closeProductionTestRoll(t, m, roll)
	for _, p := range []productionRollRequest{{RollID: roll.RollID}, {RollID: roll.RollID, Operator: "A", JobID: "J"}, {RollID: roll.RollID, Operator: "A", JobID: "J\nBAD", RollNumber: 1}} {
		if _, _, err := productionCall(t, m, "owner", "roll-export", p); err == nil {
			t.Fatal("invalid metadata accepted")
		}
	}
	if _, _, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll)); err != nil {
		t.Fatal("unknown counters blocked honest export", err)
	}
}
func TestProductionCSVFormulaCells(t *testing.T) {
	view := productionRollView{Roll: productionRoll{JobID: "=1+1", Operator: "@cmd", RollNumber: 1, FinalizedAt: "2026-10-18T05:00:00Z"}, Rows: []productionRow{{RollOrdinal: 1, Bank: "EPC", Result: "invalid_read", ReceivedAt: "2026-10-18T04:00:00Z"}}}
	var out bytes.Buffer
	if err := writeProductionCSV(&out, view, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "'@cmd") || !strings.Contains(out.String(), "'=1+1") || !strings.Contains(out.String(), ",EPC,,READ_ERROR,") {
		t.Fatal(out.String())
	}
}

func TestProductionRollLegacyArchiveCanDownloadWithoutRawEvidence(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	roll.State = "finalized"
	roll.Operator = "Legacy operator"
	roll.JobID = "LEGACY-JOB"
	roll.RollNumber = 1
	roll.ExportFileName = "legacy-original.csv"
	roll.FinalizedAt = "2026-10-16T05:00:00Z"
	roll.Runs = []productionRun{{RunID: "missing-old-run"}}
	if err := saveProductionRoll(m.captureDir, "owner", roll); err != nil {
		t.Fatal(err)
	}
	original := []byte("original,unchanged\r\nold,report\r\n")
	digest := sha256.Sum256(original)
	dir := productionDirectory(m.captureDir, "owner", roll.RollID)
	if err := os.WriteFile(filepath.Join(dir, roll.ExportFileName), original, 0600); err != nil {
		t.Fatal(err)
	}
	receipt, _ := json.Marshal(map[string]string{"fileName": roll.ExportFileName, "sha256": hex.EncodeToString(digest[:]), "exportedAt": roll.FinalizedAt})
	if err := os.WriteFile(filepath.Join(dir, "final-export.json"), receipt, 0600); err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(dir, "roll.json")
	manifestBefore, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	manifestBefore = append([]byte("\n  "), manifestBefore...)
	if err := os.WriteFile(manifestPath, manifestBefore, 0600); err != nil {
		t.Fatal(err)
	}
	_, download, err := productionCall(t, m, "owner", "roll-export", productionRollRequest{RollID: roll.RollID})
	if err != nil || !bytes.Equal(download.Body.Bytes(), original) || download.Header().Get("Content-Type") != "text/csv; charset=utf-8" {
		t.Fatal("legacy archived CSV was changed or blocked", err)
	}
	manifestAfter, _ := os.ReadFile(manifestPath)
	receiptAfter, _ := os.ReadFile(filepath.Join(dir, "final-export.json"))
	if !bytes.Equal(manifestBefore, manifestAfter) || !bytes.Equal(receipt, receiptAfter) {
		t.Fatal("legacy manifest or receipt was rewritten")
	}
}
func TestProductionRollFailedDownloadExactRetryKeepsArchiveBytes(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "retry-run", 1, 0, 1, nil, 0, "finished")
	closeProductionTestRoll(t, m, roll)
	p := productionExportRequest(roll)
	err := m.handleProductionRoll(&disconnectedProductionResponse{header: http.Header{}}, httptest.NewRequest("POST", "/tcp-job", nil), "owner", tcpJobRequest{Action: "roll-export", Production: &p})
	if err == nil {
		t.Fatal("download failure hidden")
	}
	receiptData, err := os.ReadFile(filepath.Join(productionDirectory(m.captureDir, "owner", roll.RollID), "final-export.json"))
	if err != nil {
		t.Fatal(err)
	}
	var receipt productionExportReceipt
	if err := json.Unmarshal(receiptData, &receipt); err != nil {
		t.Fatal(err)
	}
	first, err := os.ReadFile(filepath.Join(productionDirectory(m.captureDir, "owner", roll.RollID), receipt.FileName))
	if err != nil {
		t.Fatal(err)
	}
	_, retry, err := productionCall(t, m, "owner", "roll-export", p)
	if err != nil || !bytes.Equal(first, retry.Body.Bytes()) {
		t.Fatal("retry changed saved CSV snapshot bytes", err)
	}
}
func TestProductionExportFilenamePreservesUTF8(t *testing.T) {
	name := productionExportFileName(productionRoll{JobID: strings.Repeat("ượ", 100), FinalizedAt: "2026-10-18T05:00:00Z", RollNumber: 1})
	if !utf8.ValidString(name) || strings.ContainsAny(name, "/\\") {
		t.Fatal("invalid filename", name)
	}
}
