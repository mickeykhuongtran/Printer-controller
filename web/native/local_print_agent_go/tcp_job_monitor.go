package main

import (
	"context"
	"time"
)

// Runs in the connector, not in an HTTP request or browser lifetime. Every
// command takes the same session mutex as append/query/control. In capture
// mode the existing continuous reader alone reads the socket and demultiplexes
// RFID records from these status replies; the monitor never creates a socket.
func (m *tcpJobManager) startMonitorLocked(session *tcpJobSession) {
	if m.monitorInterval <= 0 || session.monitorDone != nil || session.cancelled || session.state != "open" {
		return
	}
	ctx, cancel := context.WithCancel(m.lifetime)
	session.monitorCancel = cancel
	session.monitorContext = ctx
	session.monitorDone = make(chan struct{})
	interval, timeout := m.monitorInterval, m.monitorTimeout
	if timeout <= 0 {
		timeout = 2 * time.Second
	}
	go func() {
		defer close(session.monitorDone)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if !session.monitorTick(ctx, timeout) {
					return
				}
			}
		}
	}()
}

func (session *tcpJobSession) stopMonitorLocked() {
	if session.monitorCancel != nil {
		session.monitorCancel()
	}
}

func (session *tcpJobSession) monitorTick(lifetime context.Context, timeout time.Duration) bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	if lifetime.Err() != nil || session.state != "open" || session.conn == nil || session.cancelled {
		return false
	}
	// Once all intended formats have a durable final proof, further polling
	// cannot improve that boundary and must not turn later transport loss into
	// an unnecessary pause/clear. The owner can still retrieve/finish its receipt.
	if session.capture != nil && hasFinalRfidCounterSnapshot(*session.capture.snapshot()) {
		return true
	}
	query := func(command string) (tcpJobResult, error) {
		// Start the response timeout after acquiring the command lock: rendering
		// or a legitimate preceding write must not consume this response budget.
		ctx, cancel := context.WithTimeout(lifetime, timeout)
		defer cancel()
		return session.queryLocked(ctx, []byte(command), timeout, timeout, false)
	}
	if session.serviceFault == "" {
		result, err := query("~HQES\r\n")
		if err != nil {
			return false
		}
		if !completeZebraStatusResponse("~HQES", result.Response) || !recoveryHqesPattern.MatchString(result.Response) {
			session.markUncertainLocked(0, 0, true, "Background printer monitor received an invalid ~HQES response.", "TCP_JOB_QUERY_INVALID_RESPONSE")
			return false
		}
	}
	if session.serviceFault == "" {
		// An isolated RFID VOID, ordinary operator Pause or other non-service
		// status is not a head/media/ribbon fault and never causes a cancel here.
		if err := session.counterCheckpointLocked(lifetime); err != nil {
			return false
		}
		if session.lifecycleEnabled() {
			s := session.capture.snapshot()
			if !hasFinalRfidCounterSnapshot(*s) && s.Audit.SubmittedAttemptsKnown && s.Audit.SubmittedAttempts == s.Options.ExpectedLabels {
				// The connector may seal evidence even if the browser disappeared.
				// A busy queue is merely deferred; normal finish has the longer budget.
				empty, err := session.lifecycleQueueEmptyLocked(lifetime)
				if err != nil {
					return false
				}
				if empty {
					_ = session.finalizeCounterLifecycleLocked(4 * time.Second)
				}
			}
		}
		return true
	}
	// The common abort path seals counter evidence before closing this socket.
	_, _ = session.abortLocked()
	return false
}
