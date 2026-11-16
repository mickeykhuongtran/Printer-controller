package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductionCounterReportKeepsMissingFinalRunAndAbsoluteScope(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 2514)
	productionTestRun(t, m, roll, "counter-prior-run", 2004, 0, 2004, map[int]bool{1: true, 2: true, 3: true, 4: true, 5: true}, 5, "finished")
	productionTestManifest(t, m, "counter-prior-run", func(manifest *rfidCaptureManifest) {
		manifest.Summary.Audit.Latest.At = "2026-10-19T03:13:00Z"
	})
	productionTestRun(t, m, roll, "counter-missing-final", 510, 2004, 510, map[int]bool{1: true, 2: true, 3: true, 4: true, 5: true}, 5, "finished")
	productionTestManifest(t, m, "counter-missing-final", func(manifest *rfidCaptureManifest) {
		a := &manifest.Summary.Audit
		a.Baseline = rfidCounterSnapshot{Valid: 2000, Void: 6, Total: 2006, HaveValid: true, HaveVoid: true, HaveTotal: true, At: "2026-10-19T03:15:00Z"}
		a.Latest = rfidCounterSnapshot{}
		a.CountsKnown, a.State = false, "unavailable"
		manifest.Summary.State = "interrupted"
	})
	path := filepath.Join(captureDirectory(m.captureDir, "owner", "counter-missing-final"), "manifest.json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil {
		t.Fatal(err)
	}
	s := v.Summary
	if s.PrinterValidCount != 1999 || s.VoidCount != 5 || s.CapturedEpcCount != 2504 || s.GoodCountKnown || s.CountsComplete {
		t.Fatalf("partial counter fabricated final quantity: %+v", s)
	}
	if len(s.UnreconciledRuns) != 1 || s.UnreconciledRuns[0].RunID != "counter-missing-final" || s.UnreconciledRuns[0].Reason != "final_snapshot_missing" || s.UnreconciledRuns[0].CapturedEpcCount != 505 || s.UnreconciledRuns[0].ExpectedLabels != 510 {
		t.Fatalf("missing run hidden: %+v", s.UnreconciledRuns)
	}
	if s.MachineCounterSnapshot == nil || s.MachineCounterSnapshot.Valid != 2000 || s.MachineCounterSnapshot.Void != 6 || s.MachineCounterSnapshot.Live || s.MachineCounterSnapshot.At != "2026-10-19T03:15:00Z" {
		t.Fatalf("absolute scope lost: %+v", s.MachineCounterSnapshot)
	}
	closeProductionTestRoll(t, m, roll)
	_, first, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	text := first.Body.String()
	for _, expected := range []string{"Observed VALID (partial)", "Counter certainty,UNRECONCILED", "GOOD (quantity),UNKNOWN", "Unreconciled run,counter-missing-final", "expected=510;epc_saved=505", "READ_ERROR is a readback failure, not proof of a VOID label"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("CSV missing %q", expected)
		}
	}
	_, again, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
	if err != nil || !bytes.Equal(first.Body.Bytes(), again.Body.Bytes()) {
		t.Fatal("archive rewritten", err)
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("historical capture altered by inspection/export")
	}
}

func TestProductionMachineSnapshotUsesCompleteRoundTimestamp(t *testing.T) {
	s := productionRollSummary{}
	complete := func(at string, valid int64) rfidCounterSnapshot {
		return rfidCounterSnapshot{Valid: valid, HaveValid: true, HaveVoid: true, HaveTotal: true, At: at}
	}
	updateProductionMachineSnapshot(&s, "newest", complete("2026-10-19T03:18:00Z", 2505))
	updateProductionMachineSnapshot(&s, "older-listed-last", complete("2026-10-19T03:15:00Z", 1999))
	updateProductionMachineSnapshot(&s, "partial", rfidCounterSnapshot{Valid: 9999, HaveValid: true, At: "2026-10-19T03:20:00Z"})
	if s.MachineCounterSnapshot == nil || s.MachineCounterSnapshot.RunID != "newest" || s.MachineCounterSnapshot.Valid != 2505 {
		t.Fatalf("wrong or partial round selected: %+v", s.MachineCounterSnapshot)
	}
}

func TestProductionNotSentAdmissionDoesNotPoisonSuccessfulRetry(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 2)
	productionTestRun(t, m, roll, "rejected-before-payload", 2, 0, 0, nil, 0, "finished")
	productionTestManifest(t, m, "rejected-before-payload", func(manifest *rfidCaptureManifest) {
		manifest.Summary.State = "interrupted"
		manifest.Summary.Audit = rfidBatchAudit{LifecycleVersion: 1, FinalizationStatus: "unresolved", FinalizationReason: "baseline_unverified"}
	})
	productionTestRun(t, m, roll, "successful-retry-same-roll", 2, 10, 2, nil, 0, "finished")
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.CountsComplete || len(v.Summary.NotSentRuns) != 0 || len(v.Summary.UnreconciledRuns) != 1 {
		t.Fatalf("zero readbacks inferred zero physical output: %+v %v", v.Summary, err)
	}
	productionTestManifest(t, m, "rejected-before-payload", func(manifest *rfidCaptureManifest) {
		manifest.Summary.Audit.AdmissionRejection = &rfidAdmissionRejection{Method: "before_first_payload_v1", Outcome: "not_sent", At: "2026-10-19T03:18:00Z", Reason: "baseline_unverified"}
	})
	path := filepath.Join(captureDirectory(m.captureDir, "owner", "rejected-before-payload"), "manifest.json")
	before, _ := os.ReadFile(path)
	v, _, err = productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || !v.Summary.CountsComplete || !v.Summary.GoodCountKnown || !v.Summary.CanFinalize || v.Summary.GoodCount != 2 || v.Summary.CapturedEpcCount != 2 || v.Summary.MissingEpcCount != 0 || len(v.Summary.UnreconciledRuns) != 0 || len(v.Summary.UnknownVoidRuns) != 0 || len(v.Summary.NotSentRuns) != 1 || len(v.Roll.Runs) != 2 {
		t.Fatalf("proven unsent attempt poisoned retry: %+v %v", v.Summary, err)
	}
	if v.Summary.NotSentRuns[0].RequestedLabels != 2 || v.Summary.NotSentRuns[0].RunID != "rejected-before-payload" {
		t.Fatal("failed request disappeared", v.Summary.NotSentRuns)
	}
	closeProductionTestRoll(t, m, roll)
	_, download, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	text := download.Body.String()
	for _, expected := range []string{"Total,2,Valid,2,Void,0", "Counter certainty,VERIFIED", "Not sent run,rejected-before-payload", "requested=2;label_payload_bytes=0;physical_quantity=0"} {
		if !strings.Contains(text, expected) {
			t.Fatalf("CSV missing %q", expected)
		}
	}
	if strings.Contains(text, "Unreconciled run,") {
		t.Fatal("proven no-print request exported as unknown physical count")
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("admission failure history rewritten")
	}
}

func TestProductionCounterReportDoesNotConfuseMissingEPCWithCounterFinality(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 5)
	productionTestRun(t, m, roll, "known-counter-missing-epc", 5, 0, 4, nil, 0, "finished")
	productionTestManifest(t, m, "known-counter-missing-epc", func(manifest *rfidCaptureManifest) {
		manifest.Summary.Audit.Latest.Valid, manifest.Summary.Audit.Latest.Total = 5, 5
		manifest.Summary.Audit.CountsKnown, manifest.Summary.Audit.State = true, "needs_review"
	})
	v, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || len(v.Summary.UnreconciledRuns) != 0 || !v.Summary.CountsComplete || v.Summary.MissingEpcCount != 1 {
		t.Fatalf("EPC capture quality changed counter certainty: %+v %v", v.Summary, err)
	}
	// Upgraded sessions need a durable native proof, even when every numeric
	// counter is present. A missing EPC is a separate quality issue after proof.
	productionTestManifest(t, m, "known-counter-missing-epc", func(manifest *rfidCaptureManifest) {
		a := &manifest.Summary.Audit
		a.LifecycleVersion, a.FinalizationStatus, a.FinalizationReason = 1, "unresolved", "socket_lost"
		a.SubmittedAttemptsKnown, a.SubmittedAttempts = true, 5
	})
	v, _, err = productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || v.Summary.CountsComplete || len(v.Summary.UnreconciledRuns) != 1 || v.Summary.UnreconciledRuns[0].Reason != "socket_lost" {
		t.Fatalf("raw numeric sample certified finality: %+v %v", v.Summary, err)
	}
	active, err := m.inspectProductionRoll("owner", v.Roll, map[string]bool{"known-counter-missing-epc": true})
	if err != nil || active.Summary.CountsComplete || len(active.Summary.UnreconciledRuns) != 1 || active.Summary.CanFinalize {
		t.Fatalf("active unsealed run certified: %+v %v", active.Summary, err)
	}
	productionTestManifest(t, m, "known-counter-missing-epc", func(manifest *rfidCaptureManifest) {
		a := &manifest.Summary.Audit
		a.FinalizationStatus, a.FinalizationReason = "verified", "final_counter_verified"
		a.Latest.At = "2026-10-19T03:18:01Z"
		first := a.Latest
		first.At = "2026-10-19T03:18:00Z"
		a.FinalCounterProof = &rfidFinalCounterProof{Method: "same_socket_drained_stable_v1", Sequence: 1, First: first, Final: a.Latest, QueueCheckedAt: "2026-10-19T03:18:02Z"}
	})
	v, _, err = productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil || !v.Summary.CountsComplete || len(v.Summary.UnreconciledRuns) != 0 || v.Summary.PrinterValidCount != 5 || v.Summary.MissingEpcCount != 1 {
		t.Fatalf("native proof conflated with EPC quality: %+v %v", v.Summary, err)
	}
	active, err = m.inspectProductionRoll("owner", v.Roll, map[string]bool{"known-counter-missing-epc": true})
	if err != nil || !active.Summary.CountsComplete || !active.Summary.PrinterValidKnown || len(active.Summary.UnreconciledRuns) != 0 || len(active.Summary.ActiveRuns) != 1 || active.Summary.CanFinalize {
		t.Fatalf("open transport hid durable native proof or released close blocker: %+v %v", active.Summary, err)
	}
}
