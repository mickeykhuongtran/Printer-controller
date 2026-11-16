package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func productionTestManifest(t *testing.T, m *tcpJobManager, id string, edit func(*rfidCaptureManifest)) {
	t.Helper()
	path := filepath.Join(captureDirectory(m.captureDir, "owner", id), "manifest.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var manifest rfidCaptureManifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	edit(&manifest)
	data, err = json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeRawSpoolAtomic(path, data); err != nil {
		t.Fatal(err)
	}
}

func TestProductionSeparatesNativeCountsCapturedEPCAndRemovedQuantity(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 5)
	productionTestRun(t, m, roll, "counter-gap-run", 5, 0, 4, nil, 0, "finished")
	productionTestManifest(t, m, "counter-gap-run", func(manifest *rfidCaptureManifest) {
		manifest.Summary.Audit.Latest.Valid = 5
		manifest.Summary.Audit.Latest.Total = 5
		manifest.Summary.Audit.ValidDelta = 5
		manifest.Summary.Audit.TotalDelta = 5
		manifest.Summary.Audit.CountsKnown = true
		manifest.Summary.Audit.State = "needs_review"
	})
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.PrinterValidCount != 5 || v.Summary.CapturedEpcCount != 4 || v.Summary.MissingEpcCount != 1 || v.Summary.GoodCount != 5 || !v.Summary.GoodCountKnown || !v.Summary.CountsComplete || !v.Summary.PrinterValidKnown {
		t.Fatalf("counts conflated: %+v %v", v.Summary, err)
	}
	removed := int64(2)
	v, _, err = productionCall(t, m, "owner", "roll-adjust", productionRollRequest{RollID: roll.RollID, RemovedValidCount: &removed})
	if err != nil || v.Summary.GoodCount != 3 || v.Roll.RemovedValidCount != 2 || len(v.Roll.RemovalAdjustments) != 1 {
		t.Fatalf("removed quantity not durable: %+v %v", v, err)
	}
	restarted := newTCPJobManager()
	restarted.captureDir = m.captureDir
	productionTestRun(t, restarted, roll, "quantity-replacement", 2, 5, 2, nil, 0, "finished")
	v, _, err = productionCall(t, restarted, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.PrinterValidCount != 7 || v.Summary.CapturedEpcCount != 6 || v.Summary.GoodCount != 5 || v.Summary.RemovedValidCount != 2 {
		t.Fatalf("replacement/restart reset quantities: %+v %v", v.Summary, err)
	}
	closeProductionTestRoll(t, restarted, roll)
	_, download, err := productionCall(t, restarted, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	rows := productionCSVRows(t, download.Body.Bytes())
	readbacks, quantity, identifier, gap := 0, false, false, false
	for _, row := range rows {
		if row[4] == "READ_OK" {
			readbacks++
		}
		if row[0] == "EPC saved" {
			quantity = row[1] == "6" && row[3] == "2" && row[5] == "5"
		}
		if row[0] == "roll_id" {
			identifier = row[1] == roll.RollID
		}
		if strings.Contains(row[1], "1 records without a verified EPC") {
			gap = true
		}
	}
	if readbacks != 6 || !quantity || !identifier || !gap {
		t.Fatal("CSV hid removal/EPC uncertainty or guessed excluded EPCs")
	}
	if _, _, err := productionCall(t, restarted, "owner", "roll-adjust", productionRollRequest{RollID: roll.RollID, RemovedValidCount: &removed}); err == nil {
		t.Fatal("closed quantity changed")
	}
}

func TestProductionMissingNativeCounterDoesNotBecomeCapturedEPCCount(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "counter-missing", 1, 0, 1, nil, 0, "finished")
	productionTestManifest(t, m, "counter-missing", func(manifest *rfidCaptureManifest) { manifest.Summary.Audit = rfidBatchAudit{} })
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.PrinterValidCount != 0 || v.Summary.CapturedEpcCount != 1 || v.Summary.PrinterValidKnown || v.Summary.GoodCountKnown {
		t.Fatalf("readback substituted for unknown printer count: %+v %v", v.Summary, err)
	}
	invalid := int64(-1)
	if _, _, err := productionCall(t, m, "owner", "roll-adjust", productionRollRequest{RollID: roll.RollID, RemovedValidCount: &invalid}); err == nil {
		t.Fatal("negative removed quantity accepted")
	}
}

func TestProductionIdentityMismatchRejectedBeforeRunRegistration(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "identity-first", 1, 0, 1, nil, 0, "finished")
	for index, p := range []productionRollRequest{
		{PrinterHost: "192.0.2.2", PrinterPort: 9100}, {PrinterHost: "192.0.2.1", PrinterPort: 9101}, {TemplateFingerprint: strings.Repeat("f", 64)}, {OperationMode: "write", Bank: "EPC"}, {OperationMode: "read", Bank: "TID"},
	} {
		opts := rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, TemplateName: roll.TemplateName, ExpectedLabels: 1, FirstRow: 1, RowStep: 1, OperationMode: "read", Bank: "EPC"}
		host, port := "192.0.2.1", 9100
		if p.PrinterHost != "" {
			host, port = p.PrinterHost, p.PrinterPort
		}
		if p.TemplateFingerprint != "" {
			opts.TemplateFingerprint = p.TemplateFingerprint
		}
		if p.OperationMode != "" {
			opts.OperationMode = p.OperationMode
		}
		if p.Bank != "" {
			opts.Bank = p.Bank
		}
		if _, err := newRfidCapture(m.captureDir, "owner", fmt.Sprintf("identity-rejected-%d", index), host, port, opts); err == nil {
			t.Fatalf("identity mismatch admitted: %+v", p)
		}
		p.RollID = roll.RollID
		if _, _, err := productionCall(t, m, "owner", "roll-create", p); err == nil {
			t.Fatalf("prepare silently changed identity: %+v", p)
		}
	}
	saved, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
	if err != nil || len(saved.Runs) != 1 || saved.State != "open" {
		t.Fatal("rejected identities changed roll", err)
	}
	all, err := listProductionRolls(m.captureDir, "owner")
	if err != nil || len(all) != 1 {
		t.Fatal("mismatch auto-created another roll", err)
	}
}

func TestProductionLegacyIdentityMigrationPreservesRollAndUncertainty(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "legacy-identity", 1, 0, 1, nil, 0, "finished")
	legacy, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
	if err != nil {
		t.Fatal(err)
	}
	legacy.IdentityProvenance, legacy.OperationMode, legacy.Bank = "", "", ""
	if err := saveProductionRoll(m.captureDir, "owner", legacy); err != nil {
		t.Fatal(err)
	}
	p := productionRollRequest{RollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, PrinterHost: "192.0.2.1", PrinterPort: 9100, OperationMode: "read", Bank: "EPC"}
	v, _, err := productionCall(t, m, "owner", "roll-create", p)
	if err != nil || v.Roll.RollID != roll.RollID || v.Roll.IdentityProvenance != "legacy_unverified" || len(v.Roll.IdentityWarnings) == 0 {
		t.Fatalf("legacy evidence overstated/split: %+v %v", v.Roll, err)
	}
	legacy.IdentityProvenance = ""
	if err := saveProductionRoll(m.captureDir, "owner", legacy); err != nil {
		t.Fatal(err)
	}
	productionTestManifest(t, m, "legacy-identity", func(manifest *rfidCaptureManifest) { manifest.Summary.Host = "192.0.2.2" })
	if _, _, err := productionCall(t, m, "owner", "roll-create", p); err == nil {
		t.Fatal("known legacy endpoint conflict ignored")
	}
	closeProductionTestRoll(t, m, roll)
	if _, _, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll)); err != nil {
		t.Fatal("legacy evidence must remain exportable", err)
	}
}

func TestProductionUncapturedAndCrossOwnerJobsCannotBypassOpenRoll(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	if err := validateProductionJobIdentity(m.captureDir, "owner", "192.0.2.1", 9100, nil); err != nil {
		t.Fatal("empty draft reserved printer", err)
	}
	productionTestRun(t, m, roll, "protected-printer", 1, 0, 1, nil, 0, "finished")
	for _, capture := range []*rfidCaptureOptions{nil, {}, {ProductionRollID: "other-roll"}} {
		if err := validateProductionJobIdentity(m.captureDir, "owner", "192.0.2.1", 9100, capture); err == nil {
			t.Fatal("uncaptured/mismatched job bypassed pending roll")
		}
	}
	if err := validateProductionJobIdentity(m.captureDir, "other-owner", "192.0.2.1", 9100, &rfidCaptureOptions{ProductionRollID: roll.RollID}); err == nil || strings.Contains(err.Error(), roll.RollID) {
		t.Fatal("cross-owner bypass or information disclosure", err)
	}
	if err := validateProductionJobIdentity(m.captureDir, "owner", "192.0.2.1", 9100, &rfidCaptureOptions{ProductionRollID: roll.RollID}); err != nil {
		t.Fatal("legitimate continuation blocked", err)
	}
	if err := validateProductionJobIdentity(m.captureDir, "owner", "192.0.2.2", 9100, nil); err != nil {
		t.Fatal("unrelated printer blocked", err)
	}
	closeProductionTestRoll(t, m, roll)
	if _, _, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll)); err != nil {
		t.Fatal(err)
	}
	if err := validateProductionJobIdentity(m.captureDir, "owner", "192.0.2.1", 9100, nil); err != nil {
		t.Fatal("closed roll still reserved printer", err)
	}
}

func TestProductionWriteMismatchNeverBecomesVerifiedGood(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	v, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{TemplateFingerprint: productionTestFingerprint, PrinterHost: "192.0.2.1", PrinterPort: 9100, OperationMode: "write", Bank: "EPC", TargetLabels: 3})
	if err != nil {
		t.Fatal(err)
	}
	roll := v.Roll
	c, err := newRfidCapture(m.captureDir, "owner", "verified-write", "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, OperationMode: "write", Bank: "EPC", ExpectedLabels: 3, FirstRow: 10, RowStep: 1, AuditBatchCounters: true})
	if err != nil {
		t.Fatal(err)
	}
	c.feed([]byte("NWEP|verified-write|1|W|0001|0001|END\r\nNWEP|verified-write|2|W|0002|0003|END\r\nNWEP|verified-write|3|0004|END\r\n"))
	c.mu.Lock()
	c.summary.Audit = rfidBatchAudit{State: "sampling", LastSubmittedSequence: 1, Baseline: rfidCounterSnapshot{HaveValid: true, HaveVoid: true, HaveTotal: true}, Latest: rfidCounterSnapshot{HaveValid: true, HaveVoid: true, HaveTotal: true, Sequence: 1, Valid: 3, Total: 3, At: time.Now().UTC().Format(time.RFC3339Nano)}}
	c.mu.Unlock()
	close(c.done)
	if err := c.close(nil, "finished"); err != nil {
		t.Fatal(err)
	}
	v, _, err = productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.PrinterValidCount != 3 || v.Summary.CapturedEpcCount != 1 || v.Summary.GoodCount != 1 || v.Summary.GoodCountKnown || v.Summary.WriteVerificationIssues != 2 || v.Summary.MissingEpcCount != 2 {
		t.Fatalf("write mismatch inflated GOOD: %+v %v", v.Summary, err)
	}
	closeProductionTestRoll(t, m, roll)
	_, download, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	verified, mismatch, unknown := false, false, false
	for _, row := range productionCSVRows(t, download.Body.Bytes()) {
		if row[4] == "WRITE_OK" {
			verified = row[6] == "write;source_row=10"
		}
		if row[4] == "WRITE_MISMATCH" {
			mismatch = row[3] == "0003" && row[6] == "write;source_row=11;expected=0002"
		}
		if row[4] == "WRITE_UNVERIFIED" {
			unknown = row[6] == "write;source_row=12"
		}
	}
	if !verified || !mismatch || !unknown {
		t.Fatal("write evidence missing or mislabeled")
	}
}

func TestProductionMatchedWriteVOIDDoesNotMakeVerifiedGoodUnknown(t *testing.T) {
	for _, tc := range []struct {
		name, actual            string
		nativeValid, nativeVoid int64
		wantKnown               bool
		wantIssues              int
	}{
		{name: "void-empty", actual: "", nativeValid: 2, nativeVoid: 1, wantKnown: true, wantIssues: 0},
		{name: "wrong-epc", actual: "9999", nativeValid: 3, nativeVoid: 0, wantKnown: true, wantIssues: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := newTCPJobManager()
			m.captureDir = t.TempDir()
			v, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{TemplateFingerprint: productionTestFingerprint, PrinterHost: "192.0.2.1", PrinterPort: 9100, OperationMode: "write", Bank: "EPC", TargetLabels: 3})
			if err != nil {
				t.Fatal(err)
			}
			roll := v.Roll
			c, err := newRfidCapture(m.captureDir, "owner", "write-void-case", "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, OperationMode: "write", Bank: "EPC", ExpectedLabels: 3, FirstRow: 1, RowStep: 1, AuditBatchCounters: true})
			if err != nil {
				t.Fatal(err)
			}
			c.feed([]byte("NWEP|write-void-case|1|W|0001|0001|END\r\nNWEP|write-void-case|2|W|0002|" + tc.actual + "|END\r\nNWEP|write-void-case|3|W|0003|0003|END\r\n"))
			c.mu.Lock()
			c.summary.Audit = rfidBatchAudit{State: "sampling", LastSubmittedSequence: 1, Baseline: rfidCounterSnapshot{HaveValid: true, HaveVoid: true, HaveTotal: true}, Latest: rfidCounterSnapshot{HaveValid: true, HaveVoid: true, HaveTotal: true, Sequence: 1, Valid: tc.nativeValid, Void: tc.nativeVoid, Total: 3, At: time.Now().UTC().Format(time.RFC3339Nano)}}
			c.mu.Unlock()
			close(c.done)
			if err := c.close(nil, "finished"); err != nil {
				t.Fatal(err)
			}
			v, _, err = productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
			if err != nil || v.Summary.GoodCount != 2 || v.Summary.CapturedEpcCount != 2 || v.Summary.PrinterValidCount != tc.nativeValid || v.Summary.VoidCount != tc.nativeVoid || v.Summary.GoodCountKnown != tc.wantKnown || v.Summary.WriteVerificationIssues != tc.wantIssues {
				t.Fatalf("wrong write/VOID classification: %+v %v", v.Summary, err)
			}
			closeProductionTestRoll(t, m, roll)
			_, download, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
			if err != nil {
				t.Fatal(err)
			}
			errorRecord := false
			for _, row := range productionCSVRows(t, download.Body.Bytes()) {
				if row[4] == "WRITE_READ_ERROR" || row[4] == "WRITE_MISMATCH" {
					errorRecord = true
				}
			}
			if !errorRecord {
				t.Fatal("VOID accounting erased failed write readback evidence")
			}
		})
	}
}

func TestProductionCSVRetainsDataQualityWarnings(t *testing.T) {
	row := productionRow{Disposition: "retained", Result: "out_of_order;duplicate_data", EPC: "0001", Bank: "EPC", OperationMode: "read"}
	result, detail := productionCSVResult(row, []string{"0001"})
	if result != "READ_OK;OUT_OF_ORDER;DUPLICATE_DATA;DUPLICATE_EPC" || detail != "read" {
		t.Fatal(result, detail)
	}
	row.OperationMode = "read_write"
	row.SourceRow = 7
	result, detail = productionCSVResult(row, nil)
	if result != "WRITE_OK;OUT_OF_ORDER;DUPLICATE_DATA" || detail != "write;source_row=7" {
		t.Fatal(result, detail)
	}
}

func TestProductionConcurrentOwnersCannotRegisterSamePrinter(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	owners := []string{"owner-a", "owner-b"}
	rolls := make([]productionRoll, 2)
	for index, owner := range owners {
		v, _, err := productionCall(t, m, owner, "roll-create", productionRollRequest{TemplateFingerprint: productionTestFingerprint, PrinterHost: "192.0.2.1", PrinterPort: 9100, OperationMode: "read", Bank: "EPC", TargetLabels: 1})
		if err != nil {
			t.Fatal(err)
		}
		rolls[index] = v.Roll
	}
	start, results := make(chan struct{}), make(chan bool, 2)
	for index, owner := range owners {
		go func(index int, owner string) {
			<-start
			c, err := newRfidCapture(m.captureDir, owner, fmt.Sprintf("concurrent-%d", index), "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: rolls[index].RollID, TemplateFingerprint: productionTestFingerprint, OperationMode: "read", Bank: "EPC", ExpectedLabels: 1, FirstRow: 1, RowStep: 1})
			if err == nil {
				close(c.done)
				_ = c.close(nil, "aborted")
			}
			results <- err == nil
		}(index, owner)
	}
	close(start)
	accepted := 0
	for range owners {
		if <-results {
			accepted++
		}
	}
	if accepted != 1 {
		t.Fatalf("%d owners registered the same physical printer", accepted)
	}
}

func TestProductionLegacyReadbackCannotCertifyMigratedWrite(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "legacy-write-readback", 1, 0, 1, nil, 0, "finished")
	legacy, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
	if err != nil {
		t.Fatal(err)
	}
	legacy.IdentityProvenance, legacy.OperationMode, legacy.Bank = "", "", ""
	if err := saveProductionRoll(m.captureDir, "owner", legacy); err != nil {
		t.Fatal(err)
	}
	v, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{RollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, PrinterHost: "192.0.2.1", PrinterPort: 9100, OperationMode: "write", Bank: "EPC"})
	if err != nil {
		t.Fatal("upgrade should preserve unfinished physical roll", err)
	}
	if v.Roll.IdentityProvenance != "legacy_unverified" || v.Summary.PrinterValidCount != 1 || v.Summary.CapturedEpcCount != 0 || v.Summary.GoodCount != 0 || v.Summary.GoodCountKnown || v.Rows[0].Result != "write_unverified" {
		t.Fatalf("legacy readback falsely certified write: %+v", v)
	}
}

func TestProductionEmptyDraftCanRebindAfterFailedPreparation(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	first, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{TemplateFingerprint: productionTestFingerprint, PrinterHost: "192.0.2.1", PrinterPort: 9100, OperationMode: "read", Bank: "TID"})
	if err != nil {
		t.Fatal(err)
	}
	changed := productionRollRequest{RollID: first.Roll.RollID, TemplateFingerprint: strings.Repeat("f", 64), PrinterHost: "192.0.2.2", PrinterPort: 9101, OperationMode: "write", Bank: "EPC"}
	v, _, err := productionCall(t, m, "owner", "roll-create", changed)
	if err != nil || v.Roll.RollID != first.Roll.RollID || v.Roll.TemplateFingerprint != changed.TemplateFingerprint || v.Roll.PrinterHost != changed.PrinterHost || v.Roll.PrinterPort != 9101 || v.Roll.OperationMode != "write" || v.Roll.Bank != "EPC" {
		t.Fatalf("empty draft trapped correction: %+v %v", v.Roll, err)
	}
	c, err := newRfidCapture(m.captureDir, "owner", "first-rebound-run", changed.PrinterHost, changed.PrinterPort, rfidCaptureOptions{ProductionRollID: v.Roll.RollID, TemplateFingerprint: changed.TemplateFingerprint, OperationMode: "write", Bank: "EPC", ExpectedLabels: 1, FirstRow: 1, RowStep: 1})
	if err != nil {
		t.Fatal(err)
	}
	close(c.done)
	if err := c.close(nil, "aborted"); err != nil {
		t.Fatal(err)
	}
	changed.OperationMode = "read"
	if _, _, err := productionCall(t, m, "owner", "roll-create", changed); err == nil {
		t.Fatal("registered roll identity rebound")
	}
}

func TestProductionQueuedUncapturedAdmissionRechecksNewlyBoundRoll(t *testing.T) {
	var dials atomic.Int32
	queue := newPrinterTargetQueue()
	m := newTCPJobManagerWithDialAndQueue(func(context.Context, string, int, time.Duration) (net.Conn, string, error) {
		dials.Add(1)
		return nil, "", errors.New("unexpected printer dial")
	}, queue)
	m.captureDir = t.TempDir()
	defer m.close()
	reservation, err := queue.reserve(tcpPrinterTargetKey("192.0.2.1", 9100))
	if err != nil {
		t.Fatal(err)
	}
	defer reservation.release()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	opened := make(chan error, 1)
	go func() {
		_, err := m.open(ctx, "queued-owner", "queued-uncaptured", "192.0.2.1", 9100, time.Second, time.Second, time.Minute)
		opened <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		_, _, waiting := queue.stats()
		if waiting == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("uncaptured admission did not reach reserved queue")
		}
		time.Sleep(time.Millisecond)
	}
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "preceding-captured-run", 1, 0, 1, nil, 0, "finished")
	reservation.release()
	select {
	case err := <-opened:
		if err == nil || !strings.Contains(err.Error(), "open roll") || dials.Load() != 0 {
			t.Fatal("queued admission bypassed late binding", err, dials.Load())
		}
	case <-ctx.Done():
		t.Fatal("queued admission did not finish")
	}
}
