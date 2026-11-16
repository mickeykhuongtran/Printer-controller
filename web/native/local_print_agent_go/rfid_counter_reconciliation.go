package main

import (
	"context"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const rfidCounterSettleInterval = 250 * time.Millisecond

// Proof is deliberately tied to the original connection and append sequence.
// A later empty queue on a new connection cannot establish who printed the
// intervening labels, nor repair a reset odometer or lost capture storage.
type rfidCounterReconciliation struct {
	Method            string              `json:"method"`
	FaultAt           string              `json:"faultAt"`
	QueueCheckedAt    string              `json:"queueCheckedAt"`
	Sequence          int                 `json:"sequence"`
	SubmittedAttempts int                 `json:"submittedAttempts"`
	First             rfidCounterSnapshot `json:"first"`
	Final             rfidCounterSnapshot `json:"final"`
}

func countersNotDecreasing(before, after rfidCounterSnapshot) bool {
	return before.complete() && after.complete() && after.Valid >= before.Valid && after.Void >= before.Void && after.Total >= before.Total
}

func sameCounterValues(a, b rfidCounterSnapshot) bool {
	return a.complete() && b.complete() && a.Valid == b.Valid && a.Void == b.Void && a.Total == b.Total && a.Sequence == b.Sequence
}

func hasReconciledRfidCounters(summary rfidCaptureSummary) bool {
	a, proof, fault := summary.Audit, summary.Audit.CounterReconciliation, summary.ServiceFault
	if proof == nil || fault == nil || summary.Error != "" || !summary.Options.AuditBatchCounters ||
		!fault.ClearRequested || !reconcilableStop(fault.Reason) || proof.FaultAt != fault.At ||
		proof.Method != "same_socket_paused_empty_stable_v1" || a.CounterResetObserved || !a.SubmittedAttemptsKnown ||
		proof.Sequence != a.LastSubmittedSequence || proof.Sequence <= 0 || proof.SubmittedAttempts != a.SubmittedAttempts ||
		proof.SubmittedAttempts <= 0 || proof.SubmittedAttempts > summary.Options.ExpectedLabels ||
		!sameCounterValues(proof.First, proof.Final) || !sameCounterValues(proof.Final, a.Latest) ||
		proof.Final.Sequence != proof.Sequence || !countersNotDecreasing(a.Baseline, proof.Final) {
		return false
	}
	faultAt, e0 := time.Parse(time.RFC3339Nano, fault.At)
	firstAt, e1 := time.Parse(time.RFC3339Nano, proof.First.At)
	finalAt, e2 := time.Parse(time.RFC3339Nano, proof.Final.At)
	queueAt, e3 := time.Parse(time.RFC3339Nano, proof.QueueCheckedAt)
	if e0 != nil || e1 != nil || e2 != nil || e3 != nil || firstAt.Before(faultAt) ||
		finalAt.Sub(firstAt) < rfidCounterSettleInterval || queueAt.Before(finalAt) || a.Latest.At != proof.Final.At {
		return false
	}
	valid, void := proof.Final.Valid-a.Baseline.Valid, proof.Final.Void-a.Baseline.Void
	// The print lifetime odometer is diagnostic: firmware can count VOID/feed
	// differently. RFID attempts must still be plausible for submitted formats.
	return valid <= int64(proof.SubmittedAttempts) && void <= int64(proof.SubmittedAttempts)-valid &&
		int64(summary.UniqueLabels) <= valid && summary.Received <= proof.SubmittedAttempts
}

var submittedCapturePattern = regexp.MustCompile(`\^HV[12],256,NWEP\|([A-Za-z0-9.:-]+)\|([0-9]+)\|`)
var submittedQuantityPattern = regexp.MustCompile(`\^PQ([^\^~\r\n]*)`)

// Only the app's explicit, single-label capture formats establish a physical
// upper bound. Unknown/custom command streams remain usable but cannot obtain
// automatic counter finality. Complete formats may span TCP append chunks.
func (c *rfidCapture) recordSubmittedFormatsLocked(payload []byte) {
	a := &c.summary.Audit
	if c.submittedFormatsInvalid {
		return
	}
	c.submittedFormatTail += string(payload)
	if len(c.submittedFormatTail) > 64*1024*1024 || strings.Contains(c.submittedFormatTail, "^CC") ||
		strings.Contains(c.submittedFormatTail, "~CC") || strings.Contains(c.submittedFormatTail, "^CT") || strings.Contains(c.submittedFormatTail, "~CT") {
		c.submittedFormatsInvalid, a.SubmittedAttemptsKnown, c.submittedFormatTail = true, false, ""
		return
	}
	for {
		start := strings.Index(c.submittedFormatTail, "^XA")
		if start < 0 {
			// Preserve a split command prefix, not graphic-download contents.
			if len(c.submittedFormatTail) > 2 {
				c.submittedFormatTail = c.submittedFormatTail[len(c.submittedFormatTail)-2:]
			}
			return
		}
		c.submittedFormatTail = c.submittedFormatTail[start:]
		end := strings.Index(c.submittedFormatTail, "^XZ")
		if end < 0 {
			return
		}
		format := c.submittedFormatTail[:end+3]
		c.submittedFormatTail = c.submittedFormatTail[end+3:]
		captures := submittedCapturePattern.FindAllStringSubmatch(format, -1)
		quantities := submittedQuantityPattern.FindAllStringSubmatch(format, -1)
		if strings.Count(format, "^XA") != 1 || strings.Contains(format, "^DF") || strings.Contains(format, "^XF") || len(captures) != 1 || len(quantities) != 1 ||
			strings.TrimSpace(quantities[0][1]) != "1" || captures[0][1] != c.summary.JobID {
			c.submittedFormatsInvalid, a.SubmittedAttemptsKnown, c.submittedFormatTail = true, false, ""
			return
		}
		ordinal, err := strconv.Atoi(captures[0][2])
		if err != nil || ordinal != a.SubmittedAttempts+1 || ordinal > c.summary.Options.ExpectedLabels {
			c.submittedFormatsInvalid, a.SubmittedAttemptsKnown, c.submittedFormatTail = true, false, ""
			return
		}
		a.SubmittedAttempts++
		a.SubmittedAttemptsKnown = true
	}
}

// Unlike recoveryHostDrained, the physical service fault may still be present.
// We require an explicit Pause plus empty format/partial/remaining-label fields.
func reconciliationHostStopped(response string) bool {
	frames := serviceHsFrames.FindAllStringSubmatch(response, -1)
	if len(frames) != 3 {
		return false
	}
	first, second, third := strings.Split(frames[0][1], ","), strings.Split(frames[1][1], ","), strings.Split(frames[2][1], ",")
	if len(first) != 12 || len(second) != 11 || len(third) != 2 || first[2] != "1" {
		return false
	}
	for _, value := range []string{first[1], second[2], second[3]} {
		if value != "0" && value != "1" {
			return false
		}
	}
	for _, value := range []string{first[4], first[5], first[6], first[7], first[9], first[10], first[11], second[7], second[8]} {
		n, err := strconv.ParseUint(value, 10, 32)
		if err != nil || n != 0 {
			return false
		}
	}
	return true
}

func (c *rfidCapture) startCounterRound() (rfidCaptureSummary, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	summary := c.summary
	if c.fault != nil || c.closed || c.closing || summary.Error != "" {
		return summary, false
	}
	// A sequence number alone cannot distinguish repeated samples. Clear all
	// three presence flags so each round proves three fresh replies.
	if c.summary.Audit.LifecycleVersion > 0 {
		c.pendingCounter = &rfidCounterSnapshot{Sequence: summary.Audit.LastSubmittedSequence}
		c.pendingCounterBaseline = false
		return summary, true
	}
	c.summary.Audit.Latest = rfidCounterSnapshot{Sequence: summary.Audit.LastSubmittedSequence}
	c.summary.Audit.CountsKnown = false
	return summary, true
}

func (c *rfidCapture) saveCounterReconciliation(proof rfidCounterReconciliation) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fault != nil || c.closed || c.closing || c.summary.Error != "" {
		return false
	}
	c.summary.Audit.CounterReconciliation = &proof
	if !hasReconciledRfidCounters(c.summary) {
		c.summary.Audit.CounterReconciliation = nil
		return false
	}
	if c.summary.Audit.LifecycleVersion > 0 {
		c.summary.Audit.FinalizationStatus, c.summary.Audit.FinalizationReason = "verified", "service_fault_reconciled"
		c.summary.Audit.FinalizedAt = proof.QueueCheckedAt
		c.refreshAuditCountsLocked()
	}
	if err := c.saveLocked(); err != nil {
		c.failLocked(err)
		return false
	}
	return true
}

func (c *rfidCapture) recordCounterRegression() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.summary.Audit.CounterResetObserved = true
	c.summary.Audit.CountsKnown = false
	c.summary.Audit.CounterReconciliation = nil
	if err := c.saveLocked(); err != nil {
		c.failLocked(err)
	}
}

func (session *tcpJobSession) reconcileFaultCountersLocked() {
	if session.conn == nil || session.capture == nil || session.captureOptions == nil || !session.captureOptions.AuditBatchCounters ||
		!reconcilableStop(session.serviceFault) || !session.faultClearRequested || session.state != "open" {
		return
	}
	initial := session.capture.snapshot()
	if hasReconciledRfidCounters(*initial) || initial.Error != "" || !initial.Audit.Baseline.complete() {
		return
	}
	parent := session.monitorContext
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 4*time.Second)
	defer cancel()
	query := func(command string) (tcpJobResult, error) {
		qctx, done := context.WithTimeout(ctx, time.Second)
		defer done()
		return session.queryLocked(qctx, []byte(command+"\r\n"), time.Second, time.Second, false)
	}
	stopped := func() bool {
		result, err := query("~HS")
		return err == nil && reconciliationHostStopped(result.Response)
	}
	// Keep the last earlier snapshot as a regression guard, even when the
	// final two samples look stable after an intervening counter reset.
	previous := initial.Audit.Baseline
	if initial.Audit.Latest.complete() {
		if !countersNotDecreasing(previous, initial.Audit.Latest) {
			session.capture.recordCounterRegression()
			return
		}
		previous = initial.Audit.Latest
	}
	var stable rfidCounterSnapshot
	for round := 0; round < 3; round++ {
		if ctx.Err() != nil || !stopped() {
			return
		}
		if _, okay := session.capture.startCounterRound(); !okay {
			return
		}
		for _, name := range []string{"odometer.rfid.valid_resettable", "odometer.rfid.void_resettable", "odometer.total_label_count"} {
			if _, err := query(`! U1 getvar "` + name + `"`); err != nil {
				return
			}
		}
		summary := session.capture.snapshot()
		current := summary.Audit.Latest
		if !countersNotDecreasing(previous, current) {
			session.capture.recordCounterRegression()
			return
		}
		if !stopped() {
			return
		}
		if round > 0 && sameCounterValues(stable, current) {
			session.capture.saveCounterReconciliation(rfidCounterReconciliation{
				Method: "same_socket_paused_empty_stable_v1", FaultAt: session.serviceFaultAt,
				QueueCheckedAt: time.Now().UTC().Format(time.RFC3339Nano), Sequence: session.nextSequence - 1,
				SubmittedAttempts: summary.Audit.SubmittedAttempts, First: stable, Final: current,
			})
			return
		}
		previous, stable = current, current
		if round < 2 {
			timer := time.NewTimer(rfidCounterSettleInterval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}
}
