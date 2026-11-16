package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const rfidCounterCheckpointInterval = 2 * time.Second
const rfidCounterFinishTimeout = 45 * time.Second

type rfidFinalCounterProof struct {
	Method         string              `json:"method"`
	Sequence       int                 `json:"sequence"`
	First          rfidCounterSnapshot `json:"first"`
	Final          rfidCounterSnapshot `json:"final"`
	QueueCheckedAt string              `json:"queueCheckedAt"`
}

// A rejected attempt is attributable zero only when the connector records this
// control-flow proof before any label payload. Empty raw CSV alone is no proof.
type rfidAdmissionRejection struct {
	Method  string `json:"method"`
	Outcome string `json:"outcome"`
	At      string `json:"at"`
	Reason  string `json:"reason"`
}

func hasUnsentRfidAdmission(summary rfidCaptureSummary) bool {
	a, p := summary.Audit, summary.Audit.AdmissionRejection
	if a.LifecycleVersion != 1 || p == nil || p.Method != "before_first_payload_v1" || p.Outcome != "not_sent" || (p.Reason != "baseline_unverified" && p.Reason != "stopped_before_payload") || a.LastSubmittedSequence != 0 || a.SubmittedAttempts != 0 || summary.Received != 0 {
		return false
	}
	_, err := time.Parse(time.RFC3339Nano, p.At)
	return err == nil
}

func sealedCounterQueryTransportCode(code string) bool {
	switch code {
	case "TCP_JOB_QUERY_WRITE_FAILED", "TCP_JOB_QUERY_WRITE_ZERO", "TCP_JOB_QUERY_WRITE_TIMEOUT", "TCP_JOB_QUERY_READ_FAILED", "TCP_JOB_QUERY_TIMEOUT", "RFID_CAPTURE_QUERY_FAILED":
		return true
	}
	return false
}

func (c *rfidCapture) sealedCounterFinishSafe() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.sealedCounterFinishSafeLocked()
}

func (c *rfidCapture) sealedCounterFinishSafeLocked() bool {
	return c.fault == nil && len(c.pending) == 0 && c.summary.Error == "" && c.summary.Audit.FinalCounterProof != nil && hasFinalRfidCounterSnapshot(c.summary)
}

func (session *tcpJobSession) canRecoverSealedTransportLocked() bool {
	if session.state != "uncertain" || !session.sealedTransportFailure || session.serviceFault != "" || session.cancelled || session.capture == nil || !session.capture.sealedCounterFinishSafe() {
		return false
	}
	s := session.capture.snapshot()
	r, ok := session.receipts[session.nextSequence-1]
	return ok && session.cumulativeBytes > 0 && r.checkpoint == session.checkpointHash && s.Audit.LastSubmittedSequence == session.nextSequence-1
}

// A failed live query cannot invalidate a completed physical run. Only this
// proven provenance may complete its local receipt, never a general uncertain
// append, service stop, corrupt capture or later payload attempt.
func (c *rfidCapture) finishSealedTransportReceipt() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.sealedCounterFinishSafeLocked() {
		return errors.New("Final counter proof is no longer sufficient to complete this receipt")
	}
	c.summary.TransportNote = "A later printer status query lost its connection after the final counter proof was saved. This receipt was completed locally without replay or reconnect."
	c.summary.State = "complete"
	if c.summary.Issues > 0 {
		c.summary.State = "incomplete"
	}
	c.finalizeAuditLocked("finished")
	if err := c.saveLocked(); err != nil {
		c.failLocked(err)
		return err
	}
	return nil
}

// Finality certifies the physical aggregate, independently of EPC completeness.
// Old manifests never gain this proof merely by being read by newer software.
func hasFinalRfidCounterSnapshot(summary rfidCaptureSummary) bool {
	if hasReconciledRfidCounters(summary) {
		return true
	}
	a, p := summary.Audit, summary.Audit.FinalCounterProof
	if a.LifecycleVersion != 1 || a.FinalizationStatus != "verified" || p == nil ||
		p.Method != "same_socket_drained_stable_v1" || a.CounterResetObserved ||
		p.Sequence != a.LastSubmittedSequence || p.Sequence <= 0 ||
		!sameCounterValues(p.First, p.Final) || !sameCounterValues(p.Final, a.Latest) ||
		a.Latest.At != p.Final.At || !countersNotDecreasing(a.Baseline, p.Final) {
		return false
	}
	if !a.SubmittedAttemptsKnown || a.SubmittedAttempts < 1 || a.SubmittedAttempts != summary.Options.ExpectedLabels {
		return false
	}
	valid, void := p.Final.Valid-a.Baseline.Valid, p.Final.Void-a.Baseline.Void
	if valid > int64(a.SubmittedAttempts) || void != int64(a.SubmittedAttempts)-valid || int64(summary.UniqueLabels) > valid || summary.Received > a.SubmittedAttempts {
		return false
	}
	first, e1 := time.Parse(time.RFC3339Nano, p.First.At)
	final, e2 := time.Parse(time.RFC3339Nano, p.Final.At)
	queue, e3 := time.Parse(time.RFC3339Nano, p.QueueCheckedAt)
	return e1 == nil && e2 == nil && e3 == nil && final.Sub(first) >= rfidCounterSettleInterval && !queue.Before(final)
}

func (c *rfidCapture) enableCounterLifecycle() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.summary.Options.AuditBatchCounters {
		return nil
	}
	c.summary.Audit.LifecycleVersion = 1
	c.invalidateCounterFinalityLocked()
	return c.saveLocked()
}

func (c *rfidCapture) invalidateCounterFinalityLocked() {
	a := &c.summary.Audit
	a.FinalCounterProof, a.CountsKnown = nil, false
	a.FinalizationStatus, a.FinalizationReason, a.FinalizationNote, a.FinalizedAt = "collecting", "awaiting_final_counter", "The connector has not yet confirmed the final printer counter boundary.", ""
}

func (c *rfidCapture) unresolvedCounterLocked(reason, note string) {
	if c.summary.Audit.LifecycleVersion == 0 {
		return
	}
	a := &c.summary.Audit
	a.FinalCounterProof, a.CountsKnown = nil, false
	a.FinalizationStatus, a.FinalizationReason, a.FinalizationNote = "unresolved", reason, note
	a.FinalizedAt = time.Now().UTC().Format(time.RFC3339Nano)
}

func (c *rfidCapture) unresolvedCounter(reason, note string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.unresolvedCounterLocked(reason, note)
	if err := c.saveLocked(); err != nil {
		c.failLocked(err)
	}
}

// Never mix sequential SGD replies from different rounds. Failed rounds leave
// the last complete durable observation intact; browser queries are read-only.
func (c *rfidCapture) recordLifecycleCounterLocked(name string, count int64, parseErr error) error {
	if c.pendingCounter == nil {
		return nil
	}
	if parseErr != nil || count < 0 {
		c.unresolvedCounterLocked("counter_sample_failed", "Printer returned an invalid numeric "+name+" counter; the previous complete sample is retained.")
		_ = c.saveLocked()
		return errors.New(c.summary.Audit.FinalizationNote)
	}
	s := c.pendingCounter
	switch name {
	case "valid":
		s.Valid, s.HaveValid = count, true
	case "void":
		s.Void, s.HaveVoid = count, true
	case "total":
		s.Total, s.HaveTotal = count, true
	}
	if !s.complete() {
		return nil
	}
	s.At = time.Now().UTC().Format(time.RFC3339Nano)
	a := &c.summary.Audit
	previous := a.Latest
	if !previous.complete() {
		previous = a.Baseline
	}
	if previous.complete() && !countersNotDecreasing(previous, *s) {
		a.CounterResetObserved = true
		a.CounterReconciliation = nil
		c.unresolvedCounterLocked("counter_reset", "A counter decreased. Earlier samples are retained; this run requires reconciliation.")
	}
	if c.pendingCounterBaseline {
		a.Baseline = *s
	} else {
		a.Latest = *s
	}
	a.LastSampleAt, a.CounterSampleCount = s.At, a.CounterSampleCount+1
	a.State = "sampling"
	c.pendingCounter = nil
	c.refreshAuditCountsLocked()
	if err := c.saveLocked(); err != nil {
		c.failLocked(err)
		return err
	}
	return nil
}

func (c *rfidCapture) beginLifecycleCounterRound(baseline bool) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.fault != nil || c.closed || c.closing || c.summary.Error != "" {
		return false
	}
	c.pendingCounter = &rfidCounterSnapshot{Sequence: c.summary.Audit.LastSubmittedSequence}
	c.pendingCounterBaseline = baseline
	return true
}

func (session *tcpJobSession) lifecycleEnabled() bool {
	return session.capture != nil && session.captureOptions != nil && session.captureOptions.AuditBatchCounters && session.capture.snapshot().Audit.LifecycleVersion == 1
}

func (session *tcpJobSession) lifecycleQueryLocked(ctx context.Context, command string) (tcpJobResult, error) {
	qctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return session.queryLocked(qctx, []byte(command+"\r\n"), 2*time.Second, 2*time.Second, false)
}

func (session *tcpJobSession) sampleCounterRoundLocked(ctx context.Context, baseline bool) (rfidCounterSnapshot, error) {
	if !session.capture.beginLifecycleCounterRound(baseline) {
		return rfidCounterSnapshot{}, errors.New("RFID capture is unavailable")
	}
	for _, name := range []string{"odometer.rfid.valid_resettable", "odometer.rfid.void_resettable", "odometer.total_label_count"} {
		if _, err := session.lifecycleQueryLocked(ctx, `! U1 getvar "`+name+`"`); err != nil {
			return rfidCounterSnapshot{}, err
		}
	}
	s := session.capture.snapshot()
	if baseline {
		return s.Audit.Baseline, nil
	}
	return s.Audit.Latest, nil
}

func (session *tcpJobSession) lifecycleQueueEmptyLocked(ctx context.Context) (bool, error) {
	r, err := session.lifecycleQueryLocked(ctx, "~HS")
	if err != nil {
		return false, err
	}
	if !completeZebraStatusResponse("~HS", r.Response) {
		return false, session.markUncertainLocked(0, 0, false, "Invalid host status while confirming counter boundary.", "TCP_JOB_QUERY_INVALID_RESPONSE")
	}
	drained, _ := recoveryHostDrained(r.Response)
	return drained, nil
}

func waitCounterSettle(ctx context.Context) error {
	timer := time.NewTimer(rfidCounterSettleInterval)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// Initial labels remain unsent unless an empty queue brackets two stable rounds.
func (session *tcpJobSession) ensureCounterBaselineLocked() error {
	if !session.lifecycleEnabled() || session.cumulativeBytes != 0 {
		return nil
	}
	if session.capture.snapshot().Audit.Baseline.complete() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	var previous rfidCounterSnapshot
	for round := 0; round < 3; round++ {
		empty, err := session.lifecycleQueueEmptyLocked(ctx)
		if err != nil {
			return session.baselineAdmissionError(err)
		}
		if !empty {
			return session.baselineAdmissionError(errors.New("The printer queue is not empty; the new run has not been sent."))
		}
		current, err := session.sampleCounterRoundLocked(ctx, true)
		if err != nil {
			return session.baselineAdmissionError(err)
		}
		empty, err = session.lifecycleQueueEmptyLocked(ctx)
		if err != nil {
			return session.baselineAdmissionError(err)
		}
		if empty && round > 0 && sameCounterValues(previous, current) && !session.capture.snapshot().Audit.CounterResetObserved {
			if session.capture.snapshot().Options.RequireZeroBaseline && (current.Valid != 0 || current.Void != 0) {
				return session.baselineAdmissionError(fmt.Errorf("Chưa gửi tem: hồ sơ đang là cuộn mới, nhưng máy trả về VALID %d, VOID %d. Nếu đang in dở, chọn tiếp tục đúng cuộn cũ. Chỉ reset counter về 0 khi thực sự bắt đầu cuộn mới, sau khi căn giấy/calibration.", current.Valid, current.Void))
			}
			return nil
		}
		previous = current
		if err := waitCounterSettle(ctx); err != nil {
			break
		}
	}
	return session.baselineAdmissionError(errors.New("The printer counters did not stabilize before printing; no labels were sent."))
}

func (session *tcpJobSession) baselineAdmissionError(cause error) error {
	session.capture.unresolvedCounter("baseline_unverified", cause.Error())
	// This path is reached only by ensureCounterBaselineLocked, before the
	// first label Write. Query bytes are read-only control traffic: a failed
	// baseline must not strand the target as though labels might have printed.
	// Never use this release path for any previously committed label payload.
	if session.cumulativeBytes != 0 || session.nextSequence != 1 {
		return session.markUncertainLocked(0, 0, false, cause.Error(), "RFID_BASELINE_UNVERIFIED")
	}
	c := session.capture
	c.mu.Lock()
	c.summary.Audit.AdmissionRejection = &rfidAdmissionRejection{Method: "before_first_payload_v1", Outcome: "not_sent", At: time.Now().UTC().Format(time.RFC3339Nano), Reason: "baseline_unverified"}
	if err := c.saveLocked(); err != nil {
		c.failLocked(err)
	}
	c.mu.Unlock()
	session.stopIdleTimerLocked()
	session.stopMonitorLocked()
	if session.conn != nil {
		_ = session.capture.close(session.conn, "interrupted")
		_ = session.conn.Close()
		session.conn = nil
	}
	session.state = "aborted"
	session.terminalAt = time.Now()
	if session.reservation != nil {
		session.reservation.release()
	}
	return &apiError{Status: http.StatusConflict, Code: "RFID_BASELINE_UNVERIFIED", Message: cause.Error(), Stage: "admission", Outcome: "not_sent", RetrySafety: "safe", JobID: session.jobID, JobState: session.state}
}

// Runs on the original socket and is independent of HTTP/browser cancellation.
// A timeout is unresolved evidence, never an instruction to resend label bytes.
func (session *tcpJobSession) finalizeCounterLifecycleLocked(timeout time.Duration) error {
	if !session.lifecycleEnabled() {
		return nil
	}
	if hasFinalRfidCounterSnapshot(*session.capture.snapshot()) {
		return nil
	}
	c := session.capture
	c.mu.Lock()
	formatComplete := c.summary.Audit.SubmittedAttemptsKnown && strings.TrimSpace(c.submittedFormatTail) == ""
	c.mu.Unlock()
	if !formatComplete {
		session.capture.unresolvedCounter("submitted_formats_unverified", "The submitted capture formats are incomplete or their physical attempt count cannot be verified.")
		return errors.New("Submitted format boundary is unverified")
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	var previous rfidCounterSnapshot
	for ctx.Err() == nil {
		empty, err := session.lifecycleQueueEmptyLocked(ctx)
		if err != nil {
			return err
		}
		if session.serviceFault != "" {
			session.reconcileFaultCountersLocked()
			return errors.New("Service fault interrupted counter finalization")
		}
		if empty {
			current, err := session.sampleCounterRoundLocked(ctx, false)
			if err != nil {
				return err
			}
			empty, err = session.lifecycleQueueEmptyLocked(ctx)
			if err != nil {
				return err
			}
			s := session.capture.snapshot()
			if s.Audit.CounterResetObserved {
				session.capture.unresolvedCounter("counter_reset", "A printer counter decreased during this run. Complete samples are retained, but cannot certify the run totals.")
				return errors.New("Printer counter reset observed")
			}
			if empty && sameCounterValues(previous, current) {
				c := session.capture
				c.mu.Lock()
				a := &c.summary.Audit
				a.FinalizationStatus, a.FinalizationReason, a.FinalizationNote = "verified", "final_counter_verified", "The original socket confirmed an empty queue and two fresh stable counter rounds."
				a.FinalizedAt = time.Now().UTC().Format(time.RFC3339Nano)
				a.FinalCounterProof = &rfidFinalCounterProof{Method: "same_socket_drained_stable_v1", Sequence: session.nextSequence - 1, First: previous, Final: current, QueueCheckedAt: a.FinalizedAt}
				if !hasFinalRfidCounterSnapshot(c.summary) {
					c.unresolvedCounterLocked("counter_attribution_conflict", "Stable printer counters conflict with submitted formats or saved readbacks. The machine observations are retained, but cannot certify this run.")
				}
				c.refreshAuditCountsLocked()
				err = c.saveLocked()
				if err != nil {
					c.failLocked(err)
				}
				c.mu.Unlock()
				return err
			}
			if empty {
				previous = current
			} else {
				previous = rfidCounterSnapshot{}
			}
		} else {
			previous = rfidCounterSnapshot{}
		}
		if err := waitCounterSettle(ctx); err != nil {
			break
		}
	}
	session.capture.unresolvedCounter("drain_timeout", fmt.Sprintf("Could not confirm an empty queue and stable final counters within %s. Retained EPCs and prior complete counter samples; do not infer a final run count.", timeout))
	return errors.New("Printer drain/final counter confirmation timed out")
}

func (session *tcpJobSession) counterCheckpointLocked(ctx context.Context) error {
	if !session.lifecycleEnabled() || session.cumulativeBytes == 0 {
		return nil
	}
	c := session.capture
	c.mu.Lock()
	s := c.summary
	// Never insert SGD into a partially transmitted ^XA...^XZ format.
	boundary := strings.TrimSpace(c.submittedFormatTail) == "" && !c.submittedFormatsInvalid
	c.mu.Unlock()
	if !boundary || hasFinalRfidCounterSnapshot(s) {
		return nil
	}
	last, _ := time.Parse(time.RFC3339Nano, s.Audit.LastSampleAt)
	if time.Since(last) < rfidCounterCheckpointInterval {
		return nil
	}
	_, err := session.sampleCounterRoundLocked(ctx, false)
	return err
}
