package main

import (
	"context"
	"net/http"
	"strings"
	"time"
)

// Control requests must use the current job's socket. A second connection can
// otherwise inject an old format between chunks, or deadlock Resume behind Pause.
func (m *tcpJobManager) activeExchange(ctx context.Context, host string, port int, payload []byte, window, idle time.Duration) (tcpExchangeResult, bool, error) {
	if m == nil {
		return tcpExchangeResult{}, false, nil
	}
	m.mu.Lock()
	sessions := make([]*tcpJobSession, 0, len(m.jobs))
	for _, s := range m.jobs {
		sessions = append(sessions, s)
	}
	m.mu.Unlock()
	command := strings.TrimSpace(string(payload))
	var active *tcpJobSession
	for _, s := range sessions {
		if !strings.EqualFold(s.host, host) || s.port != port {
			continue
		}
		s.mu.Lock()
		match := strings.EqualFold(s.host, host) && s.port == port
		quarantined := !s.reconciled && (s.state == "uncertain" || (s.state == "expired" && s.cumulativeBytes > 0))
		owns := s.state == "opening" || s.state == "open"
		s.mu.Unlock()
		if match && quarantined {
			if command == "~HS" || command == "~HQES" {
				// Quarantine blocks printing, not diagnostics. Never release its
				// reservation or send any mutating command on this read-only probe.
				probeCtx, cancel := context.WithTimeout(ctx, 4*time.Second)
				defer cancel()
				conn, address, err := m.dial(probeCtx, host, port, 2*time.Second)
				if err != nil {
					return tcpExchangeResult{}, true, err
				}
				defer conn.Close()
				deadline, _ := probeCtx.Deadline()
				if err = conn.SetDeadline(deadline); err != nil {
					return tcpExchangeResult{}, true, err
				}
				response, err := recoveryStatusQuery(conn, command)
				return tcpExchangeResult{bytesWritten: len(command) + 2, response: response, resolvedAddress: address}, true, err
			}
			return tcpExchangeResult{}, true, &apiError{Status: http.StatusConflict, Code: "TCP_JOB_TARGET_QUARANTINED", Message: "Reconcile the stopped TCP job before sending other printer commands."}
		}
		if match && owns {
			active = s
			break
		}
	}
	if active == nil {
		return tcpExchangeResult{}, false, nil
	}
	if command == "~HS" || command == "~HQES" {
		result, err := m.queryContext(ctx, active.owner, active.jobID, payload, window, idle)
		return tcpExchangeResult{bytesWritten: result.BytesWritten, response: result.Response, resolvedAddress: result.ResolvedAddress}, true, err
	}
	if command != "~PP" && command != "~PS" {
		return tcpExchangeResult{}, true, &apiError{Status: http.StatusConflict, Code: "TCP_JOB_TARGET_BUSY", Message: "This printer has an active TCP job. Only Status, Pause and Resume are allowed; use Cancel batch to clear that job."}
	}
	active.mu.Lock()
	defer active.mu.Unlock()
	if active.state != "open" || active.conn == nil {
		return tcpExchangeResult{}, true, jobStateErrorLocked(active, 0)
	}
	if command == "~PS" && active.serviceFault != "" {
		return tcpExchangeResult{}, true, jobErrorLocked(active, http.StatusConflict, "TCP_JOB_SERVICE_FAULT", "Resume is disabled after a media/ribbon/head fault. Reconcile this stopped run and start a new run.", 0)
	}
	written := 0
	for written < len(payload) {
		if err := active.conn.SetWriteDeadline(time.Now().Add(active.writeTimeout)); err != nil {
			return tcpExchangeResult{}, true, active.markUncertainLocked(0, written, written > 0, err.Error(), "TCP_JOB_CONTROL_FAILED")
		}
		n, err := active.conn.Write(payload[written:])
		written += n
		if err != nil || n == 0 {
			return tcpExchangeResult{}, true, active.markUncertainLocked(0, written, true, "Printer control write failed.", "TCP_JOB_CONTROL_FAILED")
		}
	}
	_ = active.conn.SetWriteDeadline(time.Time{})
	active.touchLocked()
	return tcpExchangeResult{bytesWritten: written, resolvedAddress: active.resolvedAddress}, true, nil
}
