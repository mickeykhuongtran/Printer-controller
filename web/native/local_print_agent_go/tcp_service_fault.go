package main

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

var serviceHqesPattern = regexp.MustCompile(`(?is)PRINTER\s+STATUS\s+ERRORS:\s*[01]\s+[0-9a-f]{1,8}\s+([0-9a-f]{1,8})\s+WARNINGS:`)
var serviceHsFrames = regexp.MustCompile("\x02([^\x02\x03]*)\x03\r\n")

// Only documented service bits trigger this latch. A simple operator Pause
// remains resumable; Pause + head open still terminates the run.
func zebraServiceFault(command, response string) string {
	var media, ribbon, head bool
	switch strings.TrimSpace(command) {
	case "~HQES":
		match := serviceHqesPattern.FindStringSubmatch(response)
		if len(match) != 2 {
			return ""
		}
		bits, err := strconv.ParseUint(match[1], 16, 32)
		if err != nil {
			return ""
		}
		media, ribbon, head = bits&1 != 0, bits&2 != 0, bits&4 != 0
	case "~HS":
		frames := serviceHsFrames.FindAllStringSubmatch(response, -1)
		if len(frames) != 3 {
			return ""
		}
		first, second := strings.Split(frames[0][1], ","), strings.Split(frames[1][1], ",")
		if len(first) != 12 || len(second) != 11 {
			return ""
		}
		media, ribbon, head = first[1] == "1", second[3] == "1", second[2] == "1"
	default:
		return ""
	}
	reasons := []string{}
	if media {
		reasons = append(reasons, "Media out")
	}
	if ribbon {
		reasons = append(reasons, "Ribbon out")
	}
	if head {
		reasons = append(reasons, "Printhead open")
	}
	return strings.Join(reasons, "; ")
}

// session.mu serializes this operation behind any in-flight append and before
// the next append/control. These bytes do not alter the label checkpoint chain.
// A successful write proves only transport acceptance, not an empty printer.
func (session *tcpJobSession) latchServiceFaultLocked(command, response string) error {
	if session.serviceFault != "" {
		return nil
	}
	reason := zebraServiceFault(command, response)
	if reason == "" {
		return nil
	}
	if !session.requestFaultClearLocked(reason) {
		return session.markUncertainLocked(0, 0, true, "Service fault detected; pause/clear write could not be confirmed. Keep the printer paused and clear it physically.", "TCP_JOB_FAULT_CLEAR_FAILED")
	}
	return nil
}

// Best effort, bounded control write. It never reconnects or retries label data.
func (session *tcpJobSession) requestFaultClearLocked(reason string) bool {
	session.serviceFault = reason
	session.serviceFaultAt = time.Now().UTC().Format(time.RFC3339Nano)
	if session.capture != nil {
		session.capture.recordServiceFault(reason, session.serviceFaultAt, false)
	}
	payload := []byte("~PP\r\n~JA\r\n")
	written := 0
	deadline := time.Now().Add(min(session.writeTimeout, 2*time.Second))
	for written < len(payload) {
		if session.conn == nil {
			return false
		}
		if err := session.conn.SetWriteDeadline(deadline); err != nil {
			return false
		}
		n, err := session.conn.Write(payload[written:])
		written += n
		if err != nil || n == 0 {
			return false
		}
	}
	_ = session.conn.SetWriteDeadline(time.Time{})
	session.faultClearRequested = true
	if session.capture != nil {
		session.capture.recordServiceFault(reason, session.serviceFaultAt, true)
	}
	return true
}
