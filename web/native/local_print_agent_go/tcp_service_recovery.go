package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var recoveryHqesPattern = regexp.MustCompile(`(?is)PRINTER\s+STATUS\s+ERRORS:\s*([01])\s+([0-9a-f]{1,8})\s+([0-9a-f]{1,8})\s+WARNINGS:\s*[01]\s+[0-9a-f]{1,8}\s+[0-9a-f]{1,8}`)

func reconcilableStop(reason string) bool {
	return reason == "Operator cancelled" || recoverableServiceFault(reason)
}

func recoverableServiceFault(reason string) bool {
	if reason == "" {
		return false
	}
	for _, part := range strings.Split(reason, "; ") {
		if part != "Media out" && part != "Ribbon out" && part != "Printhead open" {
			return false
		}
	}
	return true
}

func recoveryHealthReady(response string) bool {
	match := recoveryHqesPattern.FindStringSubmatch(response)
	if len(match) != 4 {
		return false
	}
	group2, err2 := strconv.ParseUint(match[2], 16, 32)
	group1, err1 := strconv.ParseUint(match[3], 16, 32)
	return err1 == nil && err2 == nil && group2 == 0 && group1 & ^uint64(0x10000) == 0 &&
		(match[1] == "0" || group1 == 0x10000)
}

func recoveryHostDrained(response string) (drained, paused bool) {
	frames := serviceHsFrames.FindAllStringSubmatch(response, -1)
	if len(frames) != 3 {
		return false, false
	}
	first, second, third := strings.Split(frames[0][1], ","), strings.Split(frames[1][1], ","), strings.Split(frames[2][1], ",")
	if len(first) != 12 || len(second) != 11 || len(third) != 2 {
		return false, false
	}
	// No queued/partial labels and no physical fault. Pause is permitted:
	// fault handling intentionally paused the printer before clearing its FIFO.
	for _, value := range []string{first[1], first[4], first[5], first[6], first[7], first[9], first[10], first[11], second[2], second[3], second[7], second[8]} {
		n, err := strconv.ParseUint(value, 10, 32)
		if err != nil || n != 0 {
			return false, false
		}
	}
	if first[2] != "0" && first[2] != "1" {
		return false, false
	}
	return true, first[2] == "1"
}

func recoveryStatusQuery(conn net.Conn, command string) (string, error) {
	if _, err := io.WriteString(conn, command+"\r\n"); err != nil {
		return "", err
	}
	var response strings.Builder
	buffer := make([]byte, 4096)
	for response.Len() < maxTCPResponseBytes {
		n, err := conn.Read(buffer)
		if n > 0 {
			response.Write(buffer[:n])
			if completeZebraStatusResponse(command, response.String()) {
				return response.String(), nil
			}
		}
		if err != nil {
			return "", err
		}
	}
	return "", errors.New("printer recovery response exceeded its size limit")
}

// A new Print request may release an earlier service-stop quarantine only
// after fresh printer responses prove repair and an empty FIFO. This connection
// sends status/resume controls only; it never replays an old label checkpoint.
func (m *tcpJobManager) recoverServiceFault(parent context.Context, session *tcpJobSession, connectTimeout time.Duration) error {
	session.mu.Lock()
	defer session.mu.Unlock()
	if session.reconciled {
		return nil
	}
	failed := func(message string) error {
		return &apiError{Status: http.StatusConflict, Code: "TCP_JOB_SERVICE_NOT_READY", Message: message,
			Stage: "admission", Outcome: "not_sent", RetrySafety: "safe", JobID: session.jobID}
	}
	if session.conn != nil || !recoverableServiceFault(session.serviceFault) || !session.faultClearRequested {
		return failed("The previous run cannot be recovered automatically. Check the printer buffer before starting a new run.")
	}
	ctx, cancel := context.WithTimeout(parent, min(connectTimeout, 5*time.Second))
	defer cancel()
	conn, _, err := m.dial(ctx, session.host, session.port, min(connectTimeout, 5*time.Second))
	if err != nil {
		return failed("Cannot verify the repaired printer: " + err.Error())
	}
	defer conn.Close()
	deadline := time.Now().Add(5 * time.Second)
	if parentDeadline, ok := ctx.Deadline(); ok && parentDeadline.Before(deadline) {
		deadline = parentDeadline
	}
	if err := conn.SetDeadline(deadline); err != nil {
		return failed("Cannot set the printer recovery timeout.")
	}
	health, err := recoveryStatusQuery(conn, "~HQES")
	if err != nil || !recoveryHealthReady(health) {
		return failed("The printer still reports a fault or cannot be checked. Finish adjusting media/ribbon/head, then press Print again. Saved roll data is retained.")
	}
	host, err := recoveryStatusQuery(conn, "~HS")
	drained, paused := recoveryHostDrained(host)
	if err != nil || !drained {
		return failed("The previous printer queue is not confirmed empty. Clear the printer buffer and press Print again. Saved roll data is retained.")
	}
	if paused {
		if _, err := io.WriteString(conn, "~PS\r\n"); err != nil {
			return failed("The repaired printer could not be resumed. Press Print again after checking its state.")
		}
	}
	session.reconciled = true
	session.reconciliationNote = "Automatic service recovery: fresh ~HQES reported no fault and ~HS confirmed an empty queue before admitting a new run. Earlier physical print totals remain in the retained run audit."
	if session.reservation != nil {
		session.reservation.release()
	}
	return nil
}
