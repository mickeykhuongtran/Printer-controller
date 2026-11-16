package main

import (
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"
)

// These are read-only SGD counters. Never reset a production printer's counters.
func rfidCounterName(command string) string {
	switch strings.TrimSpace(command) {
	case `! U1 getvar "odometer.rfid.valid_resettable"`:
		return "valid"
	case `! U1 getvar "odometer.rfid.void_resettable"`:
		return "void"
	case `! U1 getvar "odometer.total_label_count"`:
		return "total"
	}
	return ""
}
func completeRfidCounterResponse(command, response string) bool {
	if rfidCounterName(command) == "" {
		return false
	}
	text := strings.TrimSpace(response)
	// A previous quoted reply's CR/LF can arrive after the next query starts.
	// Whitespace alone must never complete the next counter response.
	return strings.Contains(strings.TrimLeft(response, " \t\r\n"), "\n") || (len(text) >= 2 && text[0] == '"' && text[len(text)-1] == '"')
}

type rfidCounterSnapshot struct {
	Valid     int64  `json:"valid"`
	Void      int64  `json:"void"`
	Total     int64  `json:"total"`
	HaveValid bool   `json:"haveValid"`
	HaveVoid  bool   `json:"haveVoid"`
	HaveTotal bool   `json:"haveTotal"`
	Sequence  int    `json:"sequence"`
	At        string `json:"at"`
}

func (s rfidCounterSnapshot) complete() bool { return s.HaveValid && s.HaveVoid && s.HaveTotal }

type rfidBatchAudit struct {
	LifecycleVersion       int                        `json:"lifecycleVersion,omitempty"`
	FinalizationStatus     string                     `json:"finalizationStatus,omitempty"`
	FinalizationReason     string                     `json:"finalizationReason,omitempty"`
	FinalizationNote       string                     `json:"finalizationNote,omitempty"`
	LastSampleAt           string                     `json:"lastSampleAt,omitempty"`
	FinalizedAt            string                     `json:"finalizedAt,omitempty"`
	CounterSampleCount     int                        `json:"counterSampleCount,omitempty"`
	FinalCounterProof      *rfidFinalCounterProof     `json:"finalCounterProof,omitempty"`
	AdmissionRejection     *rfidAdmissionRejection    `json:"admissionRejection,omitempty"`
	CounterResetObserved   bool                       `json:"counterResetObserved,omitempty"`
	CounterReconciliation  *rfidCounterReconciliation `json:"counterReconciliation,omitempty"`
	SubmittedAttempts      int                        `json:"submittedAttempts,omitempty"`
	SubmittedAttemptsKnown bool                       `json:"submittedAttemptsKnown,omitempty"`
	State                  string                     `json:"state"`
	CountsKnown            bool                       `json:"countsKnown"`
	Note                   string                     `json:"note,omitempty"`
	Baseline               rfidCounterSnapshot        `json:"baseline"`
	Latest                 rfidCounterSnapshot        `json:"latest"`
	LastSubmittedSequence  int                        `json:"lastSubmittedSequence"`
	ValidDelta             int64                      `json:"validDelta"`
	VoidDelta              int64                      `json:"voidDelta"`
	TotalDelta             int64                      `json:"totalDelta"`
}

func (c *rfidCapture) recordCounter(command, response string, payloadBytes int64, sequence int) error {
	name := rfidCounterName(command)
	if name == "" {
		return nil
	}
	text := strings.TrimSpace(response)
	if strings.HasPrefix(text, `"`) && strings.HasSuffix(text, `"`) {
		text = text[1 : len(text)-1]
	}
	count, err := strconv.ParseInt(text, 10, 64)
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.summary.Audit.LifecycleVersion > 0 {
		return c.recordLifecycleCounterLocked(name, count, err)
	}
	if err != nil || count < 0 {
		c.summary.Audit.State = "unavailable"
		c.summary.Audit.Note = "Printer did not return a valid numeric " + name + " counter. No count was inferred."
		_ = c.saveLocked()
		return errors.New(c.summary.Audit.Note)
	}
	target := &c.summary.Audit.Latest
	if payloadBytes == 0 {
		target = &c.summary.Audit.Baseline
	} else {
		prior := c.counterHighWater
		if !prior.HaveValid {
			prior.Valid, prior.HaveValid = c.summary.Audit.Baseline.Valid, c.summary.Audit.Baseline.HaveValid
		}
		if !prior.HaveVoid {
			prior.Void, prior.HaveVoid = c.summary.Audit.Baseline.Void, c.summary.Audit.Baseline.HaveVoid
		}
		if !prior.HaveTotal {
			prior.Total, prior.HaveTotal = c.summary.Audit.Baseline.Total, c.summary.Audit.Baseline.HaveTotal
		}
		if (name == "valid" && prior.HaveValid && count < prior.Valid) ||
			(name == "void" && prior.HaveVoid && count < prior.Void) ||
			(name == "total" && prior.HaveTotal && count < prior.Total) {
			c.summary.Audit.CounterResetObserved = true
			c.summary.Audit.CounterReconciliation = nil
		}
		switch name {
		case "valid":
			prior.Valid, prior.HaveValid = max(prior.Valid, count), true
		case "void":
			prior.Void, prior.HaveVoid = max(prior.Void, count), true
		case "total":
			prior.Total, prior.HaveTotal = max(prior.Total, count), true
		}
		c.counterHighWater = prior
	}
	if target.Sequence != sequence {
		*target = rfidCounterSnapshot{Sequence: sequence}
	}
	switch name {
	case "valid":
		target.Valid, target.HaveValid = count, true
	case "void":
		target.Void, target.HaveVoid = count, true
	case "total":
		target.Total, target.HaveTotal = count, true
	}
	target.At = time.Now().UTC().Format(time.RFC3339Nano)
	c.summary.Audit.State = "sampling"
	if target.complete() {
		c.refreshAuditCountsLocked()
		return c.saveLocked()
	}
	return nil
}
func (c *rfidCapture) submitted(sequence int, payload []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recordSubmittedFormatsLocked(payload)
	c.summary.Audit.CounterReconciliation = nil
	c.summary.Audit.LastSubmittedSequence = sequence
	c.summary.Audit.CountsKnown = false
	if c.summary.Audit.LifecycleVersion > 0 {
		c.invalidateCounterFinalityLocked()
		if err := c.saveLocked(); err != nil {
			c.failLocked(err)
		}
	}
}
func (c *rfidCapture) refreshAuditCountsLocked() {
	a := &c.summary.Audit
	a.CountsKnown = a.Baseline.complete() && a.Latest.complete() && a.Latest.Sequence == a.LastSubmittedSequence &&
		!a.CounterResetObserved && a.Latest.Valid >= a.Baseline.Valid && a.Latest.Void >= a.Baseline.Void && a.Latest.Total >= a.Baseline.Total
	if a.CountsKnown {
		a.ValidDelta, a.VoidDelta, a.TotalDelta = a.Latest.Valid-a.Baseline.Valid, a.Latest.Void-a.Baseline.Void, a.Latest.Total-a.Baseline.Total
	}
	if a.LifecycleVersion > 0 {
		a.CountsKnown = a.CountsKnown && hasFinalRfidCounterSnapshot(c.summary)
	}
}
func (c *rfidCapture) finalizeAuditLocked(terminal string) {
	a := &c.summary.Audit
	c.refreshAuditCountsLocked()
	if !c.summary.Options.AuditBatchCounters {
		a.State, a.Note = "not_recorded", "This session has readbacks only; printer counters were not collected."
		return
	}
	if a.LifecycleVersion > 0 {
		if hasReconciledRfidCounters(c.summary) {
			a.FinalizationStatus, a.FinalizationReason = "verified", "service_fault_reconciled"
			a.FinalizationNote = "The original socket confirmed pause, clear, an empty queue and stable counters."
			a.FinalizedAt = a.CounterReconciliation.QueueCheckedAt
		} else if !hasFinalRfidCounterSnapshot(c.summary) {
			if a.FinalizationStatus != "unresolved" {
				c.unresolvedCounterLocked("session_"+terminal, "Session ended without a verified final counter boundary.")
			}
			a.State, a.Note, a.CountsKnown = "unavailable", a.FinalizationNote, false
			if terminal == "finished" {
				c.summary.State = "incomplete"
			}
			return
		}
	}
	if !a.Baseline.complete() || !a.Latest.complete() || a.Latest.Sequence != a.LastSubmittedSequence {
		a.State, a.Note = "unavailable", "A complete before/after counter pair is missing. Printing and VOID totals are unverified."
	} else if a.CounterResetObserved || a.Latest.Valid < a.Baseline.Valid || a.Latest.Void < a.Baseline.Void || a.Latest.Total < a.Baseline.Total {
		a.State, a.Note = "counter_reset", "A printer counter decreased during the session; do not infer a VOID or good-label count."
	} else {
		a.ValidDelta, a.VoidDelta, a.TotalDelta = a.Latest.Valid-a.Baseline.Valid, a.Latest.Void-a.Baseline.Void, a.Latest.Total-a.Baseline.Total
		a.State, a.Note = "needs_review", "Totals are a snapshot of this endpoint. Check interrupted work, missing/duplicate readbacks or counter mismatch."
		if hasReconciledRfidCounters(c.summary) {
			a.State, a.Note = "reconciled", "Stopped service-fault run: the same socket requested pause/clear, then confirmed an empty paused queue and stable printer counters. Unprinted formats were cancelled; missing EPCs and individual VOID positions are not inferred."
			return
		}
		if terminal == "finished" && c.summary.State == "complete" &&
			a.ValidDelta+a.VoidDelta == int64(c.summary.Options.ExpectedLabels) && a.ValidDelta == int64(c.summary.UniqueLabels) &&
			c.summary.Received <= c.summary.Options.ExpectedLabels && int64(c.summary.InvalidReads) <= a.VoidDelta {
			a.State, a.Note = "matched", "RFID valid + VOID counters match the requested physical attempts and all valid EPCs were saved. VOID is a batch total; individual missing EPCs and positions are not inferred."
			// The lifetime print counter is a separate odometer, not the RFID
			// attempt count. Preserve it for diagnostics without misclassifying
			// a verified RFID batch when firmware counts VOID differently.
			if a.TotalDelta != a.ValidDelta+a.VoidDelta {
				a.Note += " The lifetime print odometer differs from RFID attempts."
			}
		}
	}
	if terminal == "finished" && a.State != "matched" {
		c.summary.State = "incomplete"
	}
}

// Raw reads stay append-only. This separate report combines evidence without
// assigning aggregate VOID counts to invented EPCs or source rows.
func exportRfidResultReport(output io.Writer, input io.Reader, summary rfidCaptureSummary) error {
	writer := csv.NewWriter(output)
	header := []string{"job_id", "ordinal", "source_row", "bank", "data_hex", "host_time", "result", "record_type", "quantity", "host_utc_offset", "received_at_utc", "session_state", "batch_validation", "printer_valid_delta", "printer_void_delta", "printer_total_delta", "evidence", "detail"}
	if err := writer.Write(header); err != nil {
		return err
	}
	audit := summary.Audit
	state := audit.State
	if state == "" {
		state = "not_recorded"
	}
	countsKnown := !audit.CounterResetObserved && audit.Baseline.complete() && audit.Latest.complete() && audit.Latest.Sequence == audit.LastSubmittedSequence && audit.Latest.Valid >= audit.Baseline.Valid && audit.Latest.Void >= audit.Baseline.Void && audit.Latest.Total >= audit.Baseline.Total
	if audit.LifecycleVersion > 0 {
		countsKnown = countsKnown && hasFinalRfidCounterSnapshot(summary)
	}
	valid, void, total := "", "", ""
	if countsKnown {
		valid = strconv.FormatInt(audit.Latest.Valid-audit.Baseline.Valid, 10)
		void = strconv.FormatInt(audit.Latest.Void-audit.Baseline.Void, 10)
		total = strconv.FormatInt(audit.Latest.Total-audit.Baseline.Total, 10)
	}
	write := func(ordinal, source, data, stamp, result, kind, quantity, evidence, detail string) error {
		hostTime, offset := "", ""
		if parsed, err := time.Parse(time.RFC3339Nano, stamp); err == nil {
			local := parsed.In(time.Local)
			hostTime, offset = local.Format("2006-01-02 15:04:05.000"), local.Format("-07:00")
		}
		return writer.Write([]string{summary.JobID, ordinal, source, summary.Options.Bank, data, hostTime, result, kind, quantity, offset, stamp, summary.State, state, valid, void, total, evidence, detail})
	}
	reader := csv.NewReader(input)
	reader.FieldsPerRecord = -1
	_, err := reader.Read()
	if err != nil && err != io.EOF {
		return err
	}
	seen := map[int]bool{}
	for {
		row, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil { // Preserve a visible uncertainty marker for a crash-truncated row.
			if err := write("", "", "", "", "TRUNCATED_RECORD", "report_issue", "", "host_csv", "A raw CSV record could not be recovered."); err != nil {
				return err
			}
			break
		}
		if len(row) < 7 {
			if err := write("", "", "", "", "TRUNCATED_RECORD", "report_issue", "", "host_csv", "A raw CSV record has missing fields."); err != nil {
				return err
			}
			continue
		}
		n, _ := strconv.Atoi(row[1])
		if n > 0 {
			seen[n] = true
		}
		result := strings.ToUpper(row[6])
		writeMode := summary.Options.OperationMode == "write" || summary.Options.OperationMode == "read_write"
		if result == "READ" {
			result = "READ_OK"
			if writeMode {
				result = "WRITE_UNVERIFIED"
				if validProductionRead(row, summary) {
					result = "WRITE_OK"
				}
			}
		}
		if result == "INVALID_READ" {
			result = "RFID_READ_ERROR"
		}
		detail := row[6]
		if writeMode && len(row) == 8 {
			detail = "write;" + detail + ";expected=" + row[7]
		}
		if err := write(row[1], row[2], row[4], row[5], result, "readback", "1", "printer_host_verification", detail); err != nil {
			return err
		}
	}
	// Missing ranges are compressed: no massive allocation if a huge job was cancelled.
	missingStart := 0
	flushMissing := func(end int) error {
		if missingStart == 0 {
			return nil
		}
		source := summary.Options.FirstRow + (missingStart-1)*summary.Options.RowStep
		err := write(strconv.Itoa(missingStart), strconv.Itoa(source), "", "", "NO_READBACK", "missing_range", strconv.Itoa(end-missingStart+1), "host_observation", fmt.Sprintf("No response for ordinals %d-%d. This does not prove VOID or that these labels were not printed.", missingStart, end))
		missingStart = 0
		return err
	}
	// Sort only received ordinals, then report gaps in O(received), not O(expected).
	ordinals := make([]int, 0, len(seen))
	for n := range seen {
		if n <= summary.Options.ExpectedLabels {
			ordinals = append(ordinals, n)
		}
	}
	sort.Ints(ordinals)
	next := 1
	for _, n := range ordinals {
		if n > next {
			missingStart = next
			if err := flushMissing(n - 1); err != nil {
				return err
			}
		}
		next = n + 1
	}
	if next <= summary.Options.ExpectedLabels {
		missingStart = next
		if err := flushMissing(summary.Options.ExpectedLabels); err != nil {
			return err
		}
	}
	stamp := audit.Latest.At
	if stamp == "" {
		stamp = summary.CreatedAt
	}
	voidResult := "VOID_TOTAL_UNVERIFIED"
	if countsKnown {
		voidResult = "VOID_TOTAL"
	}
	voidDetail := "Aggregate only; individual VOID EPCs, source rows and exact event times are not identified."
	if summary.State != "complete" && !hasReconciledRfidCounters(summary) {
		voidDetail += " This session is not complete: counts are a snapshot and the printer may have processed more labels afterwards."
	}
	if err := write("", "", "", stamp, voidResult, "batch_void_total", void, "printer_counter_delta", voidDetail); err != nil {
		return err
	}
	if err := write("", "", "", stamp, strings.ToUpper(state), "session_summary", strconv.Itoa(summary.Options.ExpectedLabels), "host_readbacks_and_printer_counters", audit.Note); err != nil {
		return err
	}
	writer.Flush()
	return writer.Error()
}
func markRfidCrashInterrupted(summary *rfidCaptureSummary) {
	sealed := summary.Audit.LifecycleVersion > 0 && hasFinalRfidCounterSnapshot(*summary)
	summary.State = "interrupted"
	summary.Error = "Connector stopped before this session was closed; CSV contains the responses saved before interruption."
	if sealed {
		summary.Audit.Note = "The connector stopped after committing the final counter proof. Saved physical totals remain verified; inspect raw EPC completeness separately."
		return
	}
	// A persisted sampling snapshot might precede later, unsaved submissions.
	// Retain it in the original manifest, but never advertise it as a final count.
	summary.Audit.State, summary.Audit.Note = "unavailable", "Connector stopped without a final checkpoint. Printer totals are unverified."
	summary.Audit.CountsKnown = false
	summary.Audit.CounterReconciliation = nil
	if summary.Audit.LifecycleVersion > 0 {
		summary.Audit.FinalCounterProof = nil
		summary.Audit.FinalizationStatus, summary.Audit.FinalizationReason = "unresolved", "connector_stopped"
		summary.Audit.FinalizationNote = summary.Audit.Note
	} else {
		summary.Audit.Latest = rfidCounterSnapshot{}
	}
}
