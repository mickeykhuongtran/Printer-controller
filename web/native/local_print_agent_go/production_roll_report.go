package main

import (
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type productionRow struct {
	RecordID        string   `json:"recordId"`
	Notes           []string `json:"notes,omitempty"`
	RunID           string   `json:"runId"`
	RunOrdinal      int      `json:"runOrdinal"`
	SourceRow       int      `json:"sourceRow"`
	EPC             string   `json:"epc"`
	Bank            string   `json:"bank"`
	ReceivedAt      string   `json:"receivedAt"`
	Result          string   `json:"result"`
	Disposition     string   `json:"disposition"`
	RollOrdinal     int      `json:"rollOrdinal"`
	Reason          string   `json:"reason"`
	SourceRollID    string   `json:"sourceRollId"`
	MaterialLot     string   `json:"materialLot"`
	OperationMode   string   `json:"operationMode"`
	ExpectedHex     string   `json:"expectedHex,omitempty"`
	physicalAttempt bool
}
type productionRollSummary struct {
	MachineCounterSnapshot   *productionMachineCounterSnapshot `json:"machineCounterSnapshot,omitempty"`
	UnreconciledRuns         []productionUnreconciledRun       `json:"unreconciledRuns"`
	NotSentRuns              []productionNotSentRun            `json:"notSentRuns"`
	PrinterValidCount        int64                             `json:"printerValidCount"`
	PrinterValidKnown        bool                              `json:"printerValidKnown"`
	CapturedEpcCount         int64                             `json:"capturedEpcCount"`
	CapturedReadbackCount    int64                             `json:"capturedReadbackCount"`
	MissingEpcCount          int64                             `json:"missingEpcCount"`
	RemovedValidCount        int64                             `json:"removedValidCount"`
	RemovedGoodCount         int64                             `json:"removedGoodCount"`
	RemovedRejectedCount     int64                             `json:"removedRejectedCount"`
	RemovalAccountingVersion int                               `json:"removalAccountingVersion"`
	RemovalReviewRequired    bool                              `json:"removalReviewRequired"`
	RemovableGoodCount       int64                             `json:"removableGoodCount"`
	RemovableRejectedCount   int64                             `json:"removableRejectedCount"`
	GoodCount                int64                             `json:"goodCount"`
	GoodCountKnown           bool                              `json:"goodCountKnown"`
	WriteVerificationIssues  int                               `json:"writeVerificationIssues"`
	WriteMismatchCount       int                               `json:"writeMismatchCount"`
	WriteUnverifiedCount     int64                             `json:"writeUnverifiedCount"`
	ValidCount               int64                             `json:"validCount"`
	VoidCount                int64                             `json:"voidCount"`
	TotalCount               int64                             `json:"totalCount"`
	CountsComplete           bool                              `json:"countsComplete"`
	RetainedCount            int                               `json:"retainedCount"`
	ExcludedCount            int                               `json:"excludedCount"`
	DuplicateEPCs            []string                          `json:"duplicateEpcs"`
	DuplicateSourceRows      []int                             `json:"duplicateSourceRows"`
	ConflictingRollIDs       []string                          `json:"conflictingRollIds"`
	UnresolvedRecords        int                               `json:"unresolvedRecords"`
	ActiveRuns               []string                          `json:"activeRuns"`
	UnreviewedRuns           []string                          `json:"unreviewedRuns"`
	UnknownVoidRuns          []string                          `json:"unknownVoidRuns"`
	VoidTotalKnown           int64                             `json:"voidTotalKnown"`
	CanFinalize              bool                              `json:"canFinalize"`
	Blockers                 []string                          `json:"blockers"`
}

// Absolute counters and per-roll deltas describe different scopes. This is a
// saved complete sample, never a live query or a new attribution to old work.
type productionMachineCounterSnapshot struct {
	RunID  string `json:"runId"`
	At     string `json:"at"`
	Valid  int64  `json:"valid"`
	Void   int64  `json:"void"`
	Total  int64  `json:"total"`
	Source string `json:"source"`
	Live   bool   `json:"live"`
}
type productionUnreconciledRun struct {
	RunID                   string `json:"runId"`
	RegisteredAt            string `json:"registeredAt"`
	State                   string `json:"state"`
	Reason                  string `json:"reason"`
	Detail                  string `json:"detail,omitempty"`
	ExpectedLabels          int    `json:"expectedLabels"`
	CapturedEpcCount        int64  `json:"capturedEpcCount"`
	CapturedReadbackCount   int64  `json:"capturedReadbackCount"`
	LastSnapshotAt          string `json:"lastSnapshotAt,omitempty"`
	ObservedValidCount      int64  `json:"observedValidCount"`
	ObservedVoidCount       int64  `json:"observedVoidCount"`
	ObservedCountsAvailable bool   `json:"observedCountsAvailable"`
}

func updateProductionMachineSnapshot(s *productionRollSummary, runID string, snapshots ...rfidCounterSnapshot) {
	for _, snapshot := range snapshots {
		at, err := time.Parse(time.RFC3339Nano, snapshot.At)
		if err != nil || !snapshot.complete() || snapshot.Valid < 0 || snapshot.Void < 0 || snapshot.Total < 0 {
			continue
		}
		if s.MachineCounterSnapshot != nil {
			previous, _ := time.Parse(time.RFC3339Nano, s.MachineCounterSnapshot.At)
			if !at.After(previous) {
				continue
			}
		}
		s.MachineCounterSnapshot = &productionMachineCounterSnapshot{RunID: runID, At: snapshot.At, Valid: snapshot.Valid, Void: snapshot.Void, Total: snapshot.Total, Source: "stored_session_snapshot", Live: false}
	}
}

func productionCounterReason(summary rfidCaptureSummary, active bool) string {
	a := summary.Audit
	if a.LifecycleVersion >= 1 && !active && a.FinalizationStatus == "unresolved" && a.FinalizationReason != "" && !a.CounterResetObserved && a.State != "counter_reset" {
		return a.FinalizationReason
	}
	switch {
	case active:
		return "run_active"
	case a.CounterResetObserved || a.State == "counter_reset":
		return "counter_reset"
	case !summary.Options.AuditBatchCounters:
		return "legacy_counters_not_recorded"
	case !a.Baseline.complete():
		return "baseline_missing"
	case !a.Latest.complete() || a.Latest.Sequence != a.LastSubmittedSequence:
		return "final_snapshot_missing"
	case summary.State == "interrupted" || summary.State == "cancelled":
		return "run_interrupted"
	default:
		return "counter_totals_unverified"
	}
}

type productionNotSentRun struct {
	RunID           string `json:"runId"`
	RegisteredAt    string `json:"registeredAt"`
	Reason          string `json:"reason"`
	Detail          string `json:"detail,omitempty"`
	RequestedLabels int    `json:"requestedLabels"`
}

type productionRollView struct {
	OK             bool                  `json:"ok"`
	ExportFileName string                `json:"exportFileName"`
	Roll           productionRoll        `json:"roll"`
	Summary        productionRollSummary `json:"summary"`
	Rows           []productionRow       `json:"rows"`
	runEvidence    map[string]productionRunEvidence
}
type productionRunEvidence struct {
	summary   rfidCaptureSummary
	hash      string
	rows      []productionRow
	corrupt   bool
	voidKnown bool
	voidCount int64
}

func validProductionRead(row []string, summary rfidCaptureSummary) bool {
	if (len(row) != 7 && len(row) != 8) || row[0] != summary.JobID || row[3] != summary.Options.Bank {
		return false
	}
	n, err := strconv.Atoi(row[1])
	if err != nil || n < 1 || n > summary.Options.ExpectedLabels {
		return false
	}
	source, err := strconv.ParseInt(row[2], 10, 64)
	if err != nil || source != int64(summary.Options.FirstRow)+int64(n-1)*int64(summary.Options.RowStep) {
		return false
	}
	data, err := hex.DecodeString(row[4])
	if err != nil || len(data) == 0 || len(row[4]) > 256 {
		return false
	}
	if summary.Options.ExpectedHexChars > 0 && len(row[4]) != summary.Options.ExpectedHexChars {
		return false
	}
	if productionOperationMode(summary.Options.OperationMode) != "read" {
		if len(row) != 8 || row[7] == "" || len(row[7]) > 256 {
			return false
		}
		expected, err := hex.DecodeString(row[7])
		if err != nil || len(expected) == 0 || !strings.EqualFold(row[4], row[7]) {
			return false
		}
	}
	// Gaps and repeated EPC values remain usable readbacks, without claiming that
	// their report sequence is a physical position on the roll.
	for _, result := range strings.Split(row[6], ";") {
		if result != "read" && result != "duplicate_data" && result != "out_of_order" {
			return false
		}
	}
	return true
}

func validProductionWriteMismatch(row []string, summary rfidCaptureSummary) bool {
	if len(row) != 8 || productionOperationMode(summary.Options.OperationMode) == "read" || row[0] != summary.JobID || row[3] != summary.Options.Bank {
		return false
	}
	n, err := strconv.Atoi(row[1])
	if err != nil || n < 1 || n > summary.Options.ExpectedLabels {
		return false
	}
	source, err := strconv.ParseInt(row[2], 10, 64)
	if err != nil || source != int64(summary.Options.FirstRow)+int64(n-1)*int64(summary.Options.RowStep) {
		return false
	}
	actual, actualErr := hex.DecodeString(row[4])
	expected, expectedErr := hex.DecodeString(row[7])
	if actualErr != nil || expectedErr != nil || len(actual) == 0 || len(expected) == 0 || len(row[4]) > 256 || len(row[7]) > 256 || strings.EqualFold(row[4], row[7]) {
		return false
	}
	mismatch := false
	for _, token := range strings.Split(row[6], ";") {
		if token == "write_mismatch" {
			mismatch = true
		} else if token != "out_of_order" {
			return false
		}
	}
	return mismatch
}

func loadProductionRun(root, owner string, run productionRun) (productionRunEvidence, error) {
	e := productionRunEvidence{rows: []productionRow{}}
	dir := captureDirectory(root, owner, run.RunID)
	b, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
	if err != nil {
		return e, err
	}
	var manifest rfidCaptureManifest
	if json.Unmarshal(b, &manifest) != nil || manifest.Owner != owner || manifest.Summary.JobID != run.RunID {
		return e, fmt.Errorf("invalid run manifest")
	}
	e.summary = manifest.Summary
	f, err := os.Open(filepath.Join(dir, "reads.csv"))
	if err != nil {
		return e, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return e, err
	}
	if info.Size() > maxCaptureFileBytes {
		return e, fmt.Errorf("run evidence exceeds its size budget")
	}
	hash := sha256.New()
	reader := csv.NewReader(io.TeeReader(io.LimitReader(f, info.Size()), hash))
	reader.FieldsPerRecord = -1
	header, err := reader.Read()
	if err != nil {
		return e, err
	}
	headerText := strings.Join(header, ",")
	if headerText != "job_id,ordinal,source_row,bank,data_hex,received_at_utc,result" && headerText != "job_id,ordinal,source_row,bank,data_hex,received_at_utc,result,expected_hex" {
		return e, fmt.Errorf("invalid run CSV header")
	}
	for {
		raw, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil || len(raw) != len(header) {
			e.corrupt = true
			break
		}
		if len(e.rows) >= 1000000 {
			return e, fmt.Errorf("run exceeds the 1000000-record budget")
		}
		n, _ := strconv.Atoi(raw[1])
		source, _ := strconv.Atoi(raw[2])
		row := productionRow{RecordID: fmt.Sprintf("%s:%d", run.RunID, len(e.rows)+1), RunID: run.RunID, RunOrdinal: n, SourceRow: source, EPC: strings.ToUpper(raw[4]), Bank: raw[3], ReceivedAt: raw[5], Result: raw[6], Disposition: "unresolved", SourceRollID: run.SourceRollID, MaterialLot: run.MaterialLot, OperationMode: productionOperationMode(e.summary.Options.OperationMode)}
		row.physicalAttempt = raw[0] == e.summary.JobID && raw[3] == e.summary.Options.Bank && n > 0 && n <= e.summary.Options.ExpectedLabels && source == e.summary.Options.FirstRow+(n-1)*e.summary.Options.RowStep && !strings.Contains(raw[6], "unexpected_")
		if len(raw) == 8 {
			row.ExpectedHex = strings.ToUpper(raw[7])
		}
		if validProductionRead(raw, e.summary) {
			row.Disposition = "retained"
		} else if validProductionWriteMismatch(raw, e.summary) {
			row.Disposition = "rejected"
		}
		// Legacy reviews stay in the manifest but do not hide history records.
		e.rows = append(e.rows, row)
	}
	e.hash = hex.EncodeToString(hash.Sum(nil))
	return e, nil
}

// Interrupted snapshots retain the VOID observed so far. An unknown final
// count must never erase this lower bound or become an assumed zero.
func productionVoidSnapshot(summary rfidCaptureSummary) (int64, bool) {
	a := summary.Audit
	usable := a.Baseline.HaveVoid && a.Latest.HaveVoid && a.Baseline.Void >= 0 && a.Latest.Void >= a.Baseline.Void && a.State != "counter_reset" && !a.CounterResetObserved
	if !usable {
		return 0, false
	}
	complete := a.Baseline.complete() && a.Latest.complete() && a.Baseline.Valid >= 0 && a.Baseline.Total >= 0 && a.Latest.Sequence == a.LastSubmittedSequence && a.Latest.Valid >= a.Baseline.Valid && a.Latest.Total >= a.Baseline.Total
	terminalCounts := summary.State == "complete" || hasReconciledRfidCounters(summary)
	// A fully finished physical run can have a missing/mismatched EPC readback.
	// Preserve exact printer counter certainty separately from that data-quality
	// failure; interrupted/capturing runs remain observed lower bounds.
	if (summary.State == "incomplete" || summary.State == "cancelled") && a.CountsKnown && a.State == "needs_review" && a.Latest.Valid-a.Baseline.Valid+a.Latest.Void-a.Baseline.Void == int64(summary.Options.ExpectedLabels) {
		terminalCounts = true
	}
	complete = complete && terminalCounts && a.State != "unavailable" && a.Latest.Valid-a.Baseline.Valid+a.Latest.Void-a.Baseline.Void <= int64(summary.Options.ExpectedLabels)
	if a.LifecycleVersion >= 1 {
		// New sessions require the connector's durable drain/stability proof.
		// A successful HTTP response or readback count alone is not finality.
		complete = a.Baseline.complete() && a.Latest.complete() && hasFinalRfidCounterSnapshot(summary)
	}
	return a.Latest.Void - a.Baseline.Void, complete
}

func (m *tcpJobManager) inspectProductionRoll(owner string, roll productionRoll, active map[string]bool) (productionRollView, error) {
	normalizeProductionRemovals(&roll)
	legacyFinalized := roll.State == "finalized" && roll.RemovalAccountingVersion < 2
	if legacyFinalized {
		// A closed report is a historical snapshot. Preserve its original
		// deduction arithmetic in the viewer; its archived CSV is never rewritten.
		roll.RemovedGoodCount, roll.RemovedRejectedCount = roll.RemovedValidCount, 0
	}
	view := productionRollView{OK: true, Roll: roll, Rows: []productionRow{}, runEvidence: map[string]productionRunEvidence{}, Summary: productionRollSummary{UnreconciledRuns: []productionUnreconciledRun{}, DuplicateEPCs: []string{}, DuplicateSourceRows: []int{}, ConflictingRollIDs: []string{}, ActiveRuns: []string{}, UnreviewedRuns: []string{}, UnknownVoidRuns: []string{}, Blockers: []string{}, CountsComplete: true, PrinterValidKnown: true, RemovedValidCount: roll.RemovedValidCount, RemovedGoodCount: roll.RemovedGoodCount, RemovedRejectedCount: roll.RemovedRejectedCount, RemovalAccountingVersion: roll.RemovalAccountingVersion, RemovalReviewRequired: roll.RemovalReviewRequired}}
	view.ExportFileName = roll.ExportFileName
	s := &view.Summary
	s.NotSentRuns = []productionNotSentRun{}
	epcs := map[string]int{}
	unverifiedActive := false
	for _, run := range roll.Runs {
		e, err := loadProductionRun(m.captureDir, owner, run)
		if err != nil {
			s.Blockers = append(s.Blockers, "Evidence unavailable for run "+run.RunID)
			s.UnreconciledRuns = append(s.UnreconciledRuns, productionUnreconciledRun{RunID: run.RunID, RegisteredAt: run.RegisteredAt, State: "unavailable", Reason: "evidence_unavailable", Detail: err.Error()})
			s.CountsComplete, s.PrinterValidKnown = false, false
			continue
		}
		// Capture the saved readings before marking a crashed process. Crash
		// invalidation must not present a historical sample as a final count.
		updateProductionMachineSnapshot(s, run.RunID, e.summary.Audit.Baseline, e.summary.Audit.Latest)
		isActive := active[run.RunID]
		if e.summary.State == "capturing" {
			created, _ := time.Parse(time.RFC3339Nano, e.summary.CreatedAt)
			if !created.Before(productionProcessStartedAt) {
				isActive = true
			}
			if !isActive {
				markRfidCrashInterrupted(&e.summary)
			}
		}
		if isActive {
			s.ActiveRuns = append(s.ActiveRuns, run.RunID)
		}
		if e.corrupt {
			s.Blockers = append(s.Blockers, "Truncated or malformed CSV evidence for run "+run.RunID)
			s.CountsComplete, s.PrinterValidKnown = false, false
		}
		if e.summary.Options.ProductionRollID != roll.RollID {
			s.Blockers = append(s.Blockers, "Run/roll identity mismatch: "+run.RunID)
			s.CountsComplete, s.PrinterValidKnown = false, false
		}
		if !isActive && !e.corrupt && len(e.rows) == 0 && e.summary.Options.ProductionRollID == roll.RollID && hasUnsentRfidAdmission(e.summary) {
			// This is a durable admission fact, not a guessed zero from absent
			// readbacks. Keep the failed request visible without demanding final
			// printer counters for labels that were demonstrably never sent.
			s.NotSentRuns = append(s.NotSentRuns, productionNotSentRun{RunID: run.RunID, RegisteredAt: run.RegisteredAt, Reason: e.summary.Audit.AdmissionRejection.Reason, Detail: e.summary.Audit.FinalizationNote, RequestedLabels: e.summary.Options.ExpectedLabels})
			view.runEvidence[run.RunID] = e
			continue
		}
		e.voidCount, e.voidKnown = productionVoidSnapshot(e.summary)
		activeUnsealed := isActive && !(e.summary.Audit.LifecycleVersion >= 1 && hasFinalRfidCounterSnapshot(e.summary))
		unverifiedActive = unverifiedActive || activeUnsealed
		if e.voidCount > 9007199254740991-s.VoidTotalKnown {
			return view, productionError("VOID count exceeds the supported reporting range.")
		}
		s.VoidTotalKnown += e.voidCount
		if !e.voidKnown {
			s.UnknownVoidRuns = append(s.UnknownVoidRuns, run.RunID)
			s.CountsComplete = false
			s.PrinterValidKnown = false
		}
		seen := map[int]bool{}
		runValid := int64(0)
		runEPC := int64(0)
		runWriteIssues, runVoidReadErrors, runMismatches := 0, 0, 0
		runOtherIssues := int64(0)
		observedOrdinals := map[int]bool{}
		legacyWrite := e.summary.Options.OperationMode == "" && productionOperationMode(roll.OperationMode) != "read"
		isWrite := productionOperationMode(e.summary.Options.OperationMode) != "read" || legacyWrite
		for i := range e.rows {
			row := &e.rows[i]
			if row.physicalAttempt {
				observedOrdinals[row.RunOrdinal] = true
			}
			if legacyWrite {
				// A legacy plain readback cannot certify a write after migration.
				row.OperationMode = roll.OperationMode
				row.Disposition, row.Result = "unresolved", "write_unverified"
			}
			if row.Disposition == "retained" && !seen[row.RunOrdinal] {
				seen[row.RunOrdinal] = true
				runValid++
				s.RetainedCount++
				if row.Bank == "EPC" {
					runEPC++
					epcs[row.EPC]++
				}
			} else {
				s.UnresolvedRecords++
				if isWrite {
					runWriteIssues++
					if row.Disposition == "rejected" && !seen[row.RunOrdinal] {
						seen[row.RunOrdinal] = true
						runMismatches++
					} else if row.Result == "invalid_read" && !seen[row.RunOrdinal] {
						seen[row.RunOrdinal] = true
						runVoidReadErrors++
					} else {
						runOtherIssues++
					}
				}
			}
			// This is record sequence, never an inferred physical tag position.
			row.Notes = productionNotesForRecord(roll.Notes, row.RecordID)
			row.RollOrdinal = len(view.Rows) + 1
			view.Rows = append(view.Rows, *row)
		}
		s.CapturedReadbackCount += runValid
		s.CapturedEpcCount += runEPC
		a := e.summary.Audit
		measured := int64(0)
		if a.Baseline.HaveValid && a.Latest.HaveValid && a.Baseline.Valid >= 0 && a.Latest.Valid >= a.Baseline.Valid && a.State != "counter_reset" && !a.CounterResetObserved {
			measured = a.Latest.Valid - a.Baseline.Valid
		} else {
			s.PrinterValidKnown = false
			s.CountsComplete = false
		}
		if measured > 9007199254740991-s.PrinterValidCount {
			return view, productionError("VALID count exceeds the supported reporting range.")
		}
		s.PrinterValidCount += measured
		if !isWrite && runValid > measured {
			// Missing readbacks do not change an exact native quantity, but more
			// successful label responses than native VALID contradict that evidence.
			s.CountsComplete, s.PrinterValidKnown = false, false
		}
		if !e.voidKnown || activeUnsealed || e.corrupt || e.summary.Options.ProductionRollID != roll.RollID || (!isWrite && runValid > measured) {
			reason := productionCounterReason(e.summary, isActive)
			if e.corrupt {
				reason = "evidence_corrupt"
			} else if e.summary.Options.ProductionRollID != roll.RollID {
				reason = "roll_identity_mismatch"
			} else if !isWrite && runValid > measured {
				// Missing final samples commonly have more saved EPCs than the
				// last observed delta; preserve that specific diagnosis. A sealed
				// counter proof contradicting raw evidence is an attribution fault.
				if e.voidKnown {
					reason = "counter_attribution_conflict"
				}
			}
			detail := a.Note
			if a.FinalizationNote != "" {
				detail = a.FinalizationNote
			}
			observed := a.Baseline.complete() && a.Latest.complete() && !a.CounterResetObserved && a.State != "counter_reset" && a.Latest.Valid >= a.Baseline.Valid && a.Latest.Void >= a.Baseline.Void && a.Latest.Total >= a.Baseline.Total
			s.UnreconciledRuns = append(s.UnreconciledRuns, productionUnreconciledRun{RunID: run.RunID, RegisteredAt: run.RegisteredAt, State: e.summary.State, Reason: reason, Detail: detail, ExpectedLabels: e.summary.Options.ExpectedLabels, CapturedEpcCount: runEPC, CapturedReadbackCount: runValid, LastSnapshotAt: a.Latest.At, ObservedValidCount: measured, ObservedVoidCount: e.voidCount, ObservedCountsAvailable: observed})
		}
		if e.summary.Options.Bank == "EPC" && measured > runEPC {
			s.MissingEpcCount += measured - runEPC
		}
		if isWrite {
			// A matched run may have ordinary VOID attempts with empty readback.
			// When every native VALID has a matching verified EPC and the final
			// VOID count covers those invalid reads, they do not leave a GOOD
			// verification gap. This establishes totals, never per-VOID identity.
			if e.voidKnown && measured == runEPC+int64(runMismatches) && int64(runVoidReadErrors) <= e.voidCount {
				runWriteIssues -= runVoidReadErrors
			} else {
				runOtherIssues += int64(runVoidReadErrors)
			}
			s.WriteVerificationIssues += runWriteIssues
			s.WriteMismatchCount += runMismatches
			classifiedValid := runEPC + int64(runMismatches)
			// A definite mismatch is a known reject, not missing verification.
			// Missing responses, duplicate frames and contradictory counters stay
			// unresolved even when the operator removes a physical rejected label.
			s.WriteUnverifiedCount += max(runOtherIssues, max(measured-classifiedValid, classifiedValid-measured))
			s.GoodCount += min(measured, runEPC)
			observedAttempts := int64(len(observedOrdinals))
			if measured+e.voidCount <= int64(e.summary.Options.ExpectedLabels) {
				observedAttempts = max(observedAttempts, measured+e.voidCount)
			}
			s.RemovableRejectedCount += max(int64(0), observedAttempts-runEPC)
		} else {
			s.GoodCount += measured
		}
		view.runEvidence[run.RunID] = e
		if len(view.Rows) > 1000000 {
			return view, productionError("Roll evidence exceeds the 1000000-record reporting budget.")
		}
	}
	for epc, n := range epcs {
		if n > 1 {
			s.DuplicateEPCs = append(s.DuplicateEPCs, epc)
		}
	}
	sort.Strings(s.DuplicateEPCs)
	s.VoidCount = s.VoidTotalKnown
	s.ValidCount = s.PrinterValidCount
	s.TotalCount = s.ValidCount + s.VoidCount
	beforeRemoval := s.GoodCount
	s.RemovableGoodCount = beforeRemoval
	s.GoodCount = max(int64(0), beforeRemoval-roll.RemovedGoodCount)
	s.GoodCountKnown = s.CountsComplete && s.PrinterValidKnown && roll.RemovedGoodCount <= beforeRemoval && roll.RemovedRejectedCount <= s.RemovableRejectedCount && s.WriteUnverifiedCount == 0 && !roll.RemovalReviewRequired
	if legacyFinalized && productionOperationMode(roll.OperationMode) != "read" && (s.WriteVerificationIssues > 0 || s.MissingEpcCount > 0) {
		s.GoodCountKnown = false
	}
	if len(roll.Runs) == 0 {
		s.PrinterValidKnown, s.GoodCountKnown = false, false
	}
	if len(s.ActiveRuns) > 0 {
		// Transport lifetime and a durably sealed physical boundary are separate.
		// Closing/export still waits for the session; a lost browser must not
		// hide counters already certified by the connector in the background.
		if unverifiedActive {
			s.CountsComplete, s.PrinterValidKnown, s.GoodCountKnown = false, false, false
		}
		s.Blockers = append(s.Blockers, "Printing is still active; finish or stop the current run before export.")
	}
	if len(roll.Runs) == 0 {
		s.Blockers = append(s.Blockers, "This roll has no print records yet.")
	}
	if roll.RemovalReviewRequired && roll.State == "open" {
		s.Blockers = append(s.Blockers, "Classify the legacy removed quantity into GOOD and rejected labels before export.")
	}
	s.CanFinalize = len(s.Blockers) == 0 && roll.State == "open"
	return view, nil
}

func productionCSVText(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if len(trimmed) > 0 && strings.ContainsRune("=+-@", rune(trimmed[0])) {
		return "'" + value
	}
	return value
}

func productionHostTime(stamp string) string {
	if at, err := time.Parse(time.RFC3339Nano, stamp); err == nil {
		return at.In(time.Local).Format("2006-01-02 15:04:05.000 -07:00")
	}
	return ""
}

func writeProductionCSV(output io.Writer, view productionRollView, provisional bool) error {
	if _, err := io.WriteString(output, "\ufeff"); err != nil {
		return err
	}
	w := csv.NewWriter(output)
	write := func(values ...string) error {
		row := make([]string, 7)
		copy(row, values)
		for i := range row {
			row[i] = productionCSVText(row[i])
		}
		return w.Write(row)
	}
	at := view.Roll.ExportedAt
	if at == "" {
		at = view.Roll.FinalizedAt
	}
	if at == "" {
		at = time.Now().UTC().Format(time.RFC3339Nano)
	}
	totalLabel, validLabel, voidLabel, certainty := "Total", "Valid", "Void", "VERIFIED"
	if !view.Summary.CountsComplete {
		totalLabel, validLabel, voidLabel, certainty = "Observed total (partial)", "Observed VALID (partial)", "Observed VOID (partial)", "UNRECONCILED"
	}
	good := "UNKNOWN"
	if view.Summary.GoodCountKnown {
		good = strconv.FormatInt(view.Summary.GoodCount, 10)
	}
	for _, row := range [][]string{
		{"Người vận hành", view.Roll.Operator},
		{"Thời gian", productionHostTime(at)},
		{"job_id", view.Roll.JobID},
		{"Thứ tự cuộn", strconv.Itoa(view.Roll.RollNumber)},
		{totalLabel, strconv.FormatInt(view.Summary.TotalCount, 10), validLabel, strconv.FormatInt(view.Summary.ValidCount, 10), voidLabel, strconv.FormatInt(view.Summary.VoidCount, 10)},
		{"roll_id", view.Roll.RollID},
		{"printer_ip", productionCSVPrinterIP(view.Roll)},
		{"EPC saved", strconv.FormatInt(view.Summary.CapturedEpcCount, 10), "Removed GOOD", strconv.FormatInt(view.Summary.RemovedGoodCount, 10), "GOOD (quantity)", good},
		{"Removed rejected", strconv.FormatInt(view.Summary.RemovedRejectedCount, 10), "Write mismatches", strconv.Itoa(view.Summary.WriteMismatchCount), "Unverified writes", strconv.FormatInt(view.Summary.WriteUnverifiedCount, 10)},
		{"Operation", productionOperationMode(view.Roll.OperationMode), "Bank", view.Roll.Bank},
		{"Counter certainty", certainty, "Unreconciled runs", strconv.Itoa(len(view.Summary.UnreconciledRuns)), "Counter scope", "sum of per-run deltas"},
		{"Ghi chú", "READ_ERROR is a readback failure, not proof of a VOID label. EPC records and machine counters are separate evidence."},
	} {
		if err := write(row...); err != nil {
			return err
		}
	}
	if snapshot := view.Summary.MachineCounterSnapshot; snapshot != nil {
		if err := write("Stored machine snapshot", snapshot.At, "VALID absolute", strconv.FormatInt(snapshot.Valid, 10), "VOID absolute", strconv.FormatInt(snapshot.Void, 10), "not live; may include other lots"); err != nil {
			return err
		}
	}
	for _, run := range view.Summary.UnreconciledRuns {
		if err := write("Unreconciled run", run.RunID, run.RegisteredAt, run.Reason, fmt.Sprintf("expected=%d;epc_saved=%d;readbacks=%d;observed_counts_available=%t;observed_valid=%d;observed_void=%d", run.ExpectedLabels, run.CapturedEpcCount, run.CapturedReadbackCount, run.ObservedCountsAvailable, run.ObservedValidCount, run.ObservedVoidCount), run.LastSnapshotAt, run.Detail); err != nil {
			return err
		}
	}
	for _, run := range view.Summary.NotSentRuns {
		if err := write("Not sent run", run.RunID, run.RegisteredAt, run.Reason, fmt.Sprintf("requested=%d;label_payload_bytes=0;physical_quantity=0", run.RequestedLabels), "admission rejected before first label payload", run.Detail); err != nil {
			return err
		}
	}
	if !view.Summary.CountsComplete {
		if err := write("Ghi chú", "Số đếm là dữ liệu đã ghi nhận; một số lần in bị gián đoạn hoặc thiếu số đếm cuối từ máy in."); err != nil {
			return err
		}
	}
	if view.Summary.MissingEpcCount > 0 {
		if err := write("Ghi chú", fmt.Sprintf("Printer VALID includes %d records without a verified EPC in this file.", view.Summary.MissingEpcCount)); err != nil {
			return err
		}
	}
	if !view.Summary.GoodCountKnown {
		if err := write("Ghi chú", "GOOD is a provisional quantity; printer counts, write verification or removal classification are incomplete."); err != nil {
			return err
		}
	}
	if view.Summary.RemovedValidCount > 0 {
		if err := write("Ghi chú", "Removed GOOD reduces GOOD once. Removed rejected does not reduce GOOD. Removal quantities do not identify the EPCs physically removed."); err != nil {
			return err
		}
	}
	if view.Summary.RemovalReviewRequired {
		if err := write("Unclassified removed", strconv.FormatInt(view.Summary.RemovedValidCount, 10), "GOOD quantity", "UNKNOWN"); err != nil {
			return err
		}
		if err := write("Ghi chú", "Legacy removed labels were not classified as GOOD or rejected. The saved total is retained without guessing a final GOOD quantity."); err != nil {
			return err
		}
	}
	for _, warning := range append(append([]string{}, view.Roll.IdentityWarnings...), view.Roll.CloseWarnings...) {
		if err := write("Ghi chú", warning); err != nil {
			return err
		}
	}
	if err := write(); err != nil {
		return err
	}
	if err := write("ordinal", "host_time", "bank", "value", "result", "received_time", "detail"); err != nil {
		return err
	}
	for _, row := range view.Rows {
		result, detail := productionCSVResult(row, view.Summary.DuplicateEPCs)
		for _, note := range row.Notes {
			detail += ";note=" + note
		}
		if err := write(strconv.Itoa(row.RollOrdinal), productionHostTime(row.ReceivedAt), row.Bank, row.EPC, result, row.ReceivedAt, detail); err != nil {
			return err
		}
	}
	for _, note := range view.Roll.Notes {
		if note.Incident {
			if err := write("", productionHostTime(note.At), view.Roll.Bank, "", "INCIDENT", note.At, "anchor="+strings.Join(note.RecordIDs, ",")+";note="+note.Text); err != nil {
				return err
			}
		}
	}
	// Counters only provide totals: leave EPC and ordinal blank for this record.
	// Neither an invalid read nor a missing response alone proves a VOID label.
	for _, run := range view.Roll.Runs {
		e, ok := view.runEvidence[run.RunID]
		if !ok || e.voidCount == 0 {
			continue
		}
		result := "VOID_TOTAL:" + strconv.FormatInt(e.voidCount, 10)
		if !e.voidKnown {
			result = "VOID_OBSERVED:" + strconv.FormatInt(e.voidCount, 10)
		}
		stamp := e.summary.Audit.Latest.At
		detail := "read"
		if productionOperationMode(e.summary.Options.OperationMode) != "read" {
			detail = "write"
		}
		if err := write("", productionHostTime(stamp), e.summary.Options.Bank, "", result, stamp, detail); err != nil {
			return err
		}
	}
	w.Flush()
	return w.Error()
}

func productionCSVResult(row productionRow, duplicateEPCs []string) (string, string) {
	isWrite := productionOperationMode(row.OperationMode) != "read"
	operation, detail := "READ", "read"
	if isWrite {
		operation, detail = "WRITE", fmt.Sprintf("write;source_row=%d", row.SourceRow)
	}
	result := strings.ToUpper(row.Result)
	if row.Disposition == "retained" {
		result = operation + "_OK"
		for _, warning := range strings.Split(row.Result, ";") {
			if warning != "" && warning != "read" {
				result += ";" + strings.ToUpper(warning)
			}
		}
		if row.Bank == "EPC" {
			for _, duplicate := range duplicateEPCs {
				if duplicate == row.EPC {
					result += ";DUPLICATE_EPC"
					break
				}
			}
		}
	} else if row.Result == "invalid_read" {
		result = operation + "_READ_ERROR"
		if !isWrite {
			result = "READ_ERROR"
		}
	} else if isWrite && (row.Result == "read" || row.Result == "") {
		result = "WRITE_UNVERIFIED"
	}
	if isWrite && row.Disposition != "retained" && row.ExpectedHex != "" {
		detail += ";expected=" + row.ExpectedHex
	}
	return result, detail
}

func productionExportFileName(roll productionRoll) string {
	if roll.ExportFileName != "" {
		return roll.ExportFileName
	}
	id := strings.Map(func(r rune) rune {
		if r < 32 || strings.ContainsRune("<>:\"/\\|?*", r) {
			return '_'
		}
		return r
	}, roll.JobID)
	id = strings.Trim(id, ". ")
	if characters := []rune(id); len(characters) > 96 {
		id = string(characters[:96])
	}
	if id == "" {
		id = roll.RollID
	}
	stamp := roll.ExportedAt
	if stamp == "" {
		stamp = roll.FinalizedAt
	}
	if stamp == "" {
		stamp = roll.CreatedAt
	}
	at, _ := time.Parse(time.RFC3339Nano, stamp)
	suffix := ""
	if roll.State == "closed" {
		identity := sha256.Sum256([]byte(roll.RollID))
		suffix = "_" + hex.EncodeToString(identity[:4])
	}
	return fmt.Sprintf("%s_roll-%02d_%s%s%s", id, roll.RollNumber, at.In(time.Local).Format("2006-01-02_15-04-05"), suffix, productionExportExtension())
}

type productionExportReceipt struct {
	FileName   string         `json:"fileName"`
	SHA256     string         `json:"sha256"`
	ExportedAt string         `json:"exportedAt"`
	Roll       productionRoll `json:"roll"`
}

func (m *tcpJobManager) exportProductionRoll(w http.ResponseWriter, owner string, view productionRollView, provisional bool) error {
	dir := productionDirectory(m.captureDir, owner, view.Roll.RollID)
	receiptPath := filepath.Join(dir, "final-export.json")
	var receipt productionExportReceipt
	reuse := false
	if b, err := os.ReadFile(receiptPath); err == nil {
		if json.Unmarshal(b, &receipt) != nil {
			return productionError("The saved export receipt is unreadable.")
		}
		// Connector 0.7 archived plain CSV with only filename/hash/timestamp.
		// Re-download those original bytes; never rewrite a closed legacy report.
		if receipt.Roll.RollID == "" && view.Roll.State == "finalized" && receipt.FileName == view.Roll.ExportFileName && strings.HasSuffix(strings.ToLower(receipt.FileName), ".csv") {
			receipt.Roll = view.Roll
		}
		reuse = receipt.Roll.RollID == view.Roll.RollID && receipt.Roll.Revision == view.Roll.Revision &&
			((receipt.Roll.State == "closed" && view.Roll.State == "closed") ||
				(receipt.Roll.State == "finalized" && view.Roll.State == "finalized" && receipt.Roll.JobID == view.Roll.JobID && receipt.Roll.Operator == view.Roll.Operator && receipt.Roll.RollNumber == view.Roll.RollNumber))
		if !reuse {
			return productionError("The saved export receipt does not match the closed roll; recover the original archive before downloading again.")
		}
		if reuse {
			if receipt.FileName == "" || receipt.FileName != filepath.Base(receipt.FileName) {
				return productionError("Invalid export archive filename.")
			}
			f, err := os.Open(filepath.Join(dir, receipt.FileName))
			if err != nil {
				return err
			}
			h := sha256.New()
			_, err = io.Copy(h, f)
			_ = f.Close()
			if err != nil {
				return err
			}
			if hex.EncodeToString(h.Sum(nil)) != receipt.SHA256 {
				return productionError("The saved export archive changed; recover the original before exporting again.")
			}
			view.Roll = receipt.Roll
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	if !reuse {
		current, err := readProductionRoll(m.captureDir, owner, view.Roll.RollID)
		if err != nil {
			return err
		}
		if current.State == "finalized" || current.ExportedAt != "" {
			return productionError("The saved export receipt is missing or does not match the roll.")
		}
		if current.State != "closed" || view.Roll.State != "closed" || view.Roll.ExportedAt == "" {
			return productionError("Close this roll and supply export metadata before creating its CSV archive.")
		}
		name := productionExportFileName(view.Roll)
		f, err := os.CreateTemp(dir, "export-*.tmp")
		if err != nil {
			return err
		}
		temporary := f.Name()
		defer os.Remove(temporary)
		hash := sha256.New()
		if err = writeProductionExport(io.MultiWriter(f, hash), view, false); err == nil {
			err = f.Sync()
		}
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if err := durableReplaceRawSpoolFile(temporary, filepath.Join(dir, name)); err != nil {
			return err
		}
		receipt = productionExportReceipt{FileName: name, SHA256: hex.EncodeToString(hash.Sum(nil)), ExportedAt: view.Roll.ExportedAt, Roll: view.Roll}
		b, err := json.MarshalIndent(receipt, "", "  ")
		if err != nil {
			return err
		}
		if err := writeRawSpoolAtomic(receiptPath, b); err != nil {
			return err
		}
	}
	// Persist archived metadata before delivery. A failed download can only
	// re-download these bytes and never reopens or re-exports the closed roll.
	// Historical finalized manifests remain untouched, including old schemas.
	if receipt.Roll.State == "closed" {
		current, err := readProductionRoll(m.captureDir, owner, view.Roll.RollID)
		if err != nil {
			return err
		}
		before, _ := json.Marshal(current)
		after, _ := json.Marshal(receipt.Roll)
		if string(before) != string(after) {
			if err := saveProductionRoll(m.captureDir, owner, receipt.Roll); err != nil {
				return err
			}
		}
	}
	input, err := os.Open(filepath.Join(dir, receipt.FileName))
	if err != nil {
		return err
	}
	defer input.Close()
	contentType := productionExportContentType()
	if strings.HasSuffix(strings.ToLower(receipt.FileName), ".csv") {
		contentType = "text/csv; charset=utf-8"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", receipt.FileName))
	w.Header().Set("X-Content-SHA256", receipt.SHA256)
	if _, err := io.Copy(w, input); err != nil {
		return err
	}
	return nil
}
