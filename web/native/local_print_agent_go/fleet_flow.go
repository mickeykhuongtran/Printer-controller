package main

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

func fleetProvenUnsent(r *tcpJobResult) bool {
	return r != nil && r.State == "aborted" && r.NextSequence == 1 && r.CumulativeBytes == 0 && r.Capture != nil && r.Capture.Error == "" && hasUnsentRfidAdmission(*r.Capture)
}

// ~HS is a capacity gate, not an instruction to drain after every chunk.
// Counter evidence below additionally covers bytes not parsed into formats yet.
func fleetHostCapacity(response string, next, limit int) (bool, bool, error) {
	frames := serviceHsFrames.FindAllStringSubmatch(response, -1)
	if len(frames) != 3 {
		return false, false, fmt.Errorf("Invalid printer host status")
	}
	f, s := strings.Split(frames[0][1], ","), strings.Split(frames[1][1], ",")
	if len(f) != 12 || len(s) != 11 {
		return false, false, fmt.Errorf("Invalid printer host status fields")
	}
	n := make([]int, len(f))
	for i, value := range f {
		v, err := strconv.Atoi(value)
		if err != nil || v < 0 {
			return false, false, fmt.Errorf("Invalid numeric host status")
		}
		n[i] = v
	}
	remaining, err := strconv.Atoi(s[8])
	if err != nil || remaining < 0 {
		return false, false, fmt.Errorf("Invalid remaining-label status")
	}
	if n[1] != 0 || n[6] != 0 || n[10] != 0 || n[11] != 0 || s[2] != "0" || s[3] != "0" {
		return false, n[2] != 0, fmt.Errorf("Printer reports media, head, ribbon, temperature or RAM fault")
	}
	return n[5] == 0 && n[7] == 0 && n[4]+next <= limit && remaining <= limit, n[2] != 0, nil
}

func fleetAttemptCapacity(c *rfidCaptureSummary, next, limit int) bool {
	if c == nil || c.Error != "" || c.Audit.CounterResetObserved || !c.Audit.SubmittedAttemptsKnown {
		return false
	}
	a := c.Audit
	latest := a.Latest
	if !latest.complete() {
		latest = a.Baseline
	}
	if !countersNotDecreasing(a.Baseline, latest) {
		return false
	}
	done := latest.Valid - a.Baseline.Valid + latest.Void - a.Baseline.Void
	return done >= 0 && done <= int64(a.SubmittedAttempts) && int64(a.SubmittedAttempts+next)-done <= int64(limit)
}

func (m *tcpJobManager) fleetCounterSample(owner, id string) (tcpJobResult, error) {
	s, err := m.lookup(owner, id)
	if err != nil {
		return tcpJobResult{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != "open" || s.capture == nil {
		return tcpJobResult{}, jobStateErrorLocked(s, 0)
	}
	if _, err = s.sampleCounterRoundLocked(context.Background(), false); err != nil {
		return tcpJobResult{}, err
	}
	r := s.resultLocked()
	a := r.Capture.Audit
	if a.CounterResetObserved || !countersNotDecreasing(a.Baseline, a.Latest) || a.Latest.Valid-a.Baseline.Valid+a.Latest.Void-a.Baseline.Void > int64(a.SubmittedAttempts) {
		return r, fmt.Errorf("Printer counters changed outside this run; stop and reconcile before continuing")
	}
	return r, nil
}

func (m *tcpJobManager) fleetVerifyBaseline(owner, id string) error {
	s, err := m.lookup(owner, id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state != "open" {
		return jobStateErrorLocked(s, 0)
	}
	return s.ensureCounterBaselineLocked()
}
