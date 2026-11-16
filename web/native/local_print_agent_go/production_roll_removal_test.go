package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func productionWriteTestRoll(t *testing.T, m *tcpJobManager) productionRoll {
	t.Helper()
	v, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{TemplateFingerprint: productionTestFingerprint, PrinterHost: "192.0.2.1", PrinterPort: 9100, OperationMode: "write", Bank: "EPC", TargetLabels: 3})
	if err != nil {
		t.Fatal(err)
	}
	return v.Roll
}

func productionWriteRun(t *testing.T, m *tcpJobManager, roll productionRoll, id string, expected int, source int, actual []string, valid, void int64) {
	t.Helper()
	c, err := newRfidCapture(m.captureDir, "owner", id, "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, OperationMode: "write", Bank: "EPC", ExpectedLabels: expected, FirstRow: source, RowStep: 1, AuditBatchCounters: true})
	if err != nil {
		t.Fatal(err)
	}
	for index, value := range actual {
		c.feed([]byte(fmt.Sprintf("NWEP|%s|%d|W|%04X|%s|END\r\n", id, index+1, source+index, value)))
	}
	c.mu.Lock()
	c.summary.Audit = rfidBatchAudit{State: "sampling", LastSubmittedSequence: 1, Baseline: rfidCounterSnapshot{HaveValid: true, HaveVoid: true, HaveTotal: true}, Latest: rfidCounterSnapshot{HaveValid: true, HaveVoid: true, HaveTotal: true, Sequence: 1, Valid: valid, Void: void, Total: valid + void, At: time.Now().UTC().Format(time.RFC3339Nano)}}
	c.mu.Unlock()
	close(c.done)
	if err := c.close(nil, "finished"); err != nil {
		t.Fatal(err)
	}
}

func productionSaveRemoval(t *testing.T, m *tcpJobManager, roll productionRoll, good, rejected int64) (productionRollView, error) {
	t.Helper()
	v, _, err := productionCall(t, m, "owner", "roll-adjust", productionRollRequest{RollID: roll.RollID, RemovedGoodCount: &good, RemovedRejectedCount: &rejected})
	return v, err
}

func TestProductionWriteRejectRemovalNeverDeductsGoodTwice(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := productionWriteTestRoll(t, m)
	productionWriteRun(t, m, roll, "write-reject", 3, 1, []string{"0001", "9999", "0003"}, 3, 0)
	v, err := productionSaveRemoval(t, m, roll, 0, 1)
	if err != nil || v.Summary.GoodCount != 2 || !v.Summary.GoodCountKnown || v.Summary.RemovedRejectedCount != 1 || v.Summary.WriteMismatchCount != 1 || v.Summary.WriteUnverifiedCount != 0 || v.Summary.RemovableRejectedCount != 1 {
		t.Fatalf("reject reduced GOOD or hid evidence: %+v %v", v.Summary, err)
	}
	revision := v.Roll.Revision
	v, err = productionSaveRemoval(t, m, roll, 0, 1)
	if err != nil || v.Roll.Revision != revision || len(v.Roll.RemovalAdjustments) != 1 {
		t.Fatal("repeat save applied increment twice", err)
	}
	productionWriteRun(t, m, roll, "write-replacement", 1, 2, []string{"0002"}, 1, 0)
	v, _, err = productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.GoodCount != 3 || !v.Summary.GoodCountKnown || v.Summary.WriteMismatchCount != 1 {
		t.Fatalf("topup did not preserve exact GOOD and prior mismatch: %+v %v", v.Summary, err)
	}
	v, err = productionSaveRemoval(t, m, roll, 1, 1)
	if err != nil || v.Summary.GoodCount != 2 || v.Summary.RemovedValidCount != 2 || v.Summary.RemovedGoodCount != 1 {
		t.Fatalf("GOOD removal wrong: %+v %v", v.Summary, err)
	}
	closeProductionTestRoll(t, m, roll)
	_, output, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	matched, rejected := 0, 0
	for _, row := range productionCSVRows(t, output.Body.Bytes()) {
		if strings.HasPrefix(row[4], "WRITE_OK") {
			matched++
		}
		if row[4] == "WRITE_MISMATCH" {
			rejected++
		}
		if row[0] == "EPC saved" && (row[1] != "3" || row[2] != "Removed GOOD" || row[3] != "1" || row[5] != "2") {
			t.Fatalf("wrong CSV GOOD totals: %v", row)
		}
		if row[0] == "Removed rejected" && (row[1] != "1" || row[3] != "1" || row[5] != "0") {
			t.Fatalf("wrong CSV reject totals: %v", row)
		}
	}
	if matched != 3 || rejected != 1 {
		t.Fatal("removal erased raw print history")
	}
}

func TestProductionRemovalBoundsAreAtomicAndUseObservedLabels(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := productionWriteTestRoll(t, m)
	// Only three attempts are observed although a 2500-label job was requested.
	productionWriteRun(t, m, roll, "partial-removal", 2500, 1, []string{"0001", "9999", "0003"}, 3, 0)
	for _, pair := range [][2]int64{{-1, 0}, {0, -1}, {3, 0}, {0, 2}, {0, 2498}, {9007199254740991, 1}} {
		if _, err := productionSaveRemoval(t, m, roll, pair[0], pair[1]); err == nil {
			t.Fatalf("accepted invalid removal %v", pair)
		}
	}
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || len(v.Roll.RemovalAdjustments) != 0 || v.Summary.RemovedValidCount != 0 {
		t.Fatal("failed validation mutated ledger")
	}
	zero := int64(0)
	if _, _, err := productionCall(t, m, "owner", "roll-adjust", productionRollRequest{RollID: roll.RollID, RemovedGoodCount: &zero}); err == nil {
		t.Fatal("accepted partial classification")
	}
	if _, _, err := productionCall(t, m, "owner", "roll-adjust", productionRollRequest{RollID: roll.RollID, RemovedValidCount: &zero}); err == nil {
		t.Fatal("accepted ambiguous write legacy field")
	}
}

func TestProductionRejectedRemovalCannotResolveMissingWriteResponse(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := productionWriteTestRoll(t, m)
	productionWriteRun(t, m, roll, "missing-write", 3, 1, []string{"0001", "0002"}, 3, 0)
	v, err := productionSaveRemoval(t, m, roll, 0, 1)
	if err != nil || v.Summary.GoodCount != 2 || v.Summary.GoodCountKnown || v.Summary.WriteMismatchCount != 0 || v.Summary.WriteUnverifiedCount != 1 {
		t.Fatalf("physical removal invented verification: %+v %v", v.Summary, err)
	}
	productionWriteRun(t, m, roll, "missing-write-topup", 1, 3, []string{"0003"}, 1, 0)
	v, _, err = productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.GoodCountKnown || v.Summary.WriteUnverifiedCount != 1 {
		t.Fatal("topup hid missing original evidence")
	}
}

func TestProductionLegacyRemovalClassificationAndFrozenArchive(t *testing.T) {
	for _, mode := range []string{"read", "write"} {
		t.Run(mode, func(t *testing.T) {
			m := newTCPJobManager()
			m.captureDir = t.TempDir()
			var roll productionRoll
			if mode == "write" {
				roll = productionWriteTestRoll(t, m)
				productionWriteRun(t, m, roll, "legacy-remove", 3, 1, []string{"0001", "9999", "0003"}, 3, 0)
			} else {
				roll = createProductionTestRoll(t, m, 3)
				productionTestRun(t, m, roll, "legacy-remove", 3, 0, 3, nil, 0, "finished")
			}
			old, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
			if err != nil {
				t.Fatal(err)
			}
			old.RemovalAccountingVersion, old.RemovedValidCount, old.RemovedGoodCount, old.RemovedRejectedCount = 0, 1, 0, 0
			if err := saveProductionRoll(m.captureDir, "owner", old); err != nil {
				t.Fatal(err)
			}
			v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
			if err != nil {
				t.Fatal(err)
			}
			if mode == "read" {
				if v.Summary.GoodCount != 2 || !v.Summary.GoodCountKnown || v.Summary.RemovedGoodCount != 1 || v.Summary.RemovalReviewRequired {
					t.Fatalf("safe read migration failed: %+v", v.Summary)
				}
			} else {
				if v.Summary.GoodCount != 2 || v.Summary.GoodCountKnown || !v.Summary.RemovalReviewRequired || v.Summary.CanFinalize {
					t.Fatalf("legacy removal silently interpreted: %+v", v.Summary)
				}
				v, err = productionSaveRemoval(t, m, roll, 0, 1)
				if err != nil || v.Summary.RemovalReviewRequired || !v.Summary.GoodCountKnown || v.Summary.GoodCount != 2 {
					t.Fatal("explicit migration failed", err)
				}
			}
			closeProductionTestRoll(t, m, roll)
			_, first, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
			if err != nil {
				t.Fatal(err)
			}
			closeProductionTestRoll(t, m, roll)
			_, again, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
			if err != nil || first.Body.String() != again.Body.String() {
				t.Fatal("archive changed on download", err)
			}
		})
	}
}

func TestProductionRemovalBlockedDuringActiveRun(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := productionWriteTestRoll(t, m)
	c, err := newRfidCapture(m.captureDir, "owner", "active-remove", "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, OperationMode: "write", Bank: "EPC", ExpectedLabels: 1, FirstRow: 1, RowStep: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { close(c.done); _ = c.close(nil, "aborted") }()
	if _, err := productionSaveRemoval(t, m, roll, 0, 0); err == nil {
		t.Fatal("active removal accepted")
	}
}

func TestProductionCounterContradictionsAndCorruptEvidenceStayProvisional(t *testing.T) {
	for _, problem := range []string{"reset", "reset-then-growth", "negative-baseline", "too-many", "corrupt"} {
		t.Run(problem, func(t *testing.T) {
			m := newTCPJobManager()
			m.captureDir = t.TempDir()
			roll := productionWriteTestRoll(t, m)
			productionWriteRun(t, m, roll, "invalid-counter", 2, 1, []string{"0001", "0002"}, 2, 0)
			productionTestManifest(t, m, "invalid-counter", func(manifest *rfidCaptureManifest) {
				switch problem {
				case "reset":
					manifest.Summary.Audit.Baseline.Valid = 3
					manifest.Summary.Audit.State = "counter_reset"
				case "reset-then-growth":
					manifest.Summary.Audit.CounterResetObserved = true
				case "negative-baseline":
					manifest.Summary.Audit.Baseline.Valid = -1
				case "too-many":
					manifest.Summary.Audit.Latest.Valid = 4
					manifest.Summary.Audit.Latest.Total = 4
				}
			})
			if problem == "corrupt" {
				path := filepath.Join(captureDirectory(m.captureDir, "owner", "invalid-counter"), "reads.csv")
				f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
				if err != nil {
					t.Fatal(err)
				}
				_, _ = f.WriteString("broken\n")
				_ = f.Close()
			}
			v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
			if err != nil || v.Summary.GoodCountKnown || v.Summary.CountsComplete || v.Summary.PrinterValidKnown {
				t.Fatalf("invalid evidence finalized: %+v %v", v.Summary, err)
			}
		})
	}
}

func TestProductionReconciledPartialRunAndTopupKeepFinalCounts(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 2500)
	productionTestRun(t, m, roll, "partial-with-proof", 2500, 0, 1250, map[int]bool{273: true, 1000: true}, 2, "aborted")
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.GoodCountKnown || v.Summary.CountsComplete {
		t.Fatal("unsettled interruption falsely finalized", err)
	}
	productionTestManifest(t, m, "partial-with-proof", func(manifest *rfidCaptureManifest) {
		s := &manifest.Summary
		base := time.Now().UTC().Add(-time.Second)
		s.ServiceFault = &rfidServiceFault{Reason: "Printhead open", ClearRequested: true, At: base.Format(time.RFC3339Nano)}
		first := s.Audit.Latest
		first.At = base.Add(time.Millisecond).Format(time.RFC3339Nano)
		final := first
		final.At = base.Add(300 * time.Millisecond).Format(time.RFC3339Nano)
		s.Audit.Latest = final
		s.Audit.State, s.Audit.CountsKnown = "reconciled", true
		s.Audit.SubmittedAttempts, s.Audit.SubmittedAttemptsKnown = 2500, true
		s.Audit.CounterReconciliation = &rfidCounterReconciliation{Method: "same_socket_paused_empty_stable_v1", FaultAt: s.ServiceFault.At, QueueCheckedAt: base.Add(301 * time.Millisecond).Format(time.RFC3339Nano), Sequence: 1, SubmittedAttempts: 2500, First: first, Final: final}
		if !hasReconciledRfidCounters(*s) {
			t.Fatal("invalid test proof")
		}
	})
	restarted := newTCPJobManager()
	restarted.captureDir = m.captureDir
	v, _, err = productionCall(t, restarted, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || !v.Summary.GoodCountKnown || !v.Summary.CountsComplete || v.Summary.GoodCount != 1248 || v.Summary.VoidCount != 2 {
		t.Fatalf("durable stopped count still provisional: %+v %v", v.Summary, err)
	}
	productionTestRun(t, restarted, roll, "partial-proof-topup", 1252, 1250, 1252, nil, 0, "finished")
	v, _, err = productionCall(t, restarted, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || !v.Summary.GoodCountKnown || !v.Summary.CountsComplete || v.Summary.GoodCount != 2500 || v.Summary.TotalCount != 2502 || len(v.Roll.Runs) != 2 {
		t.Fatalf("topup lost finality or roll continuity: %+v %v", v.Summary, err)
	}
	productionTestManifest(t, restarted, "partial-with-proof", func(manifest *rfidCaptureManifest) { manifest.Summary.Audit.CounterReconciliation.Sequence++ })
	v, _, err = productionCall(t, restarted, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.GoodCountKnown || v.Summary.CountsComplete {
		t.Fatal("invalid durable proof accepted", err)
	}
}

func TestProductionCancelledSnapshotNeedsSettledOrFullyAccountedCounts(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 10)
	productionTestRun(t, m, roll, "cancelled-partial", 10, 0, 3, nil, 0, "cancelled")
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.CountsComplete || v.Summary.GoodCountKnown {
		t.Fatal("cancelled snapshot inferred finality without queue proof", err)
	}
}

func TestProductionLegacyUnknownModeRemovalWaitsForIdentity(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 3)
	productionTestRun(t, m, roll, "legacy-unknown-mode", 3, 0, 3, nil, 0, "finished")
	old, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
	if err != nil {
		t.Fatal(err)
	}
	old.OperationMode, old.IdentityProvenance, old.RemovalAccountingVersion = "", "", 0
	old.RemovedValidCount, old.RemovedGoodCount = 1, 0
	if err := saveProductionRoll(m.captureDir, "owner", old); err != nil {
		t.Fatal(err)
	}
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || !v.Summary.RemovalReviewRequired || v.Summary.GoodCountKnown {
		t.Fatal("unknown legacy mode assumed read", err)
	}
	v, _, err = productionCall(t, m, "owner", "roll-create", productionRollRequest{RollID: roll.RollID, TemplateFingerprint: productionTestFingerprint, PrinterHost: "192.0.2.1", PrinterPort: 9100, OperationMode: "read", Bank: "EPC"})
	if err != nil || v.Summary.RemovalReviewRequired || !v.Summary.GoodCountKnown || v.Summary.RemovedGoodCount != 1 || v.Summary.GoodCount != 2 {
		t.Fatalf("bound legacy read removal not migrated: %+v %v", v.Summary, err)
	}
}

func TestProductionReadbacksAboveNativeValidRemainProvisional(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 3)
	productionTestRun(t, m, roll, "read-counter-conflict", 3, 0, 3, nil, 0, "finished")
	productionTestManifest(t, m, "read-counter-conflict", func(manifest *rfidCaptureManifest) {
		s := &manifest.Summary
		s.State, s.Audit.State = "incomplete", "needs_review"
		s.Audit.Latest.Valid, s.Audit.Latest.Void = 2, 1
		s.Audit.ValidDelta, s.Audit.VoidDelta = 2, 1
	})
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.CapturedEpcCount != 3 || v.Summary.GoodCount != 2 || v.Summary.GoodCountKnown || v.Summary.CountsComplete || v.Summary.PrinterValidKnown {
		t.Fatalf("contradictory readbacks finalized: %+v %v", v.Summary, err)
	}
}
