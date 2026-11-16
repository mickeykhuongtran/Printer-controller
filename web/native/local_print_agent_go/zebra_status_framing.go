package main

import "strings"

// The printer frames HQES once and HS three times. Idle timeout remains the
// fallback for unframed/legacy replies; the client still validates all fields.
func completeZebraStatusResponse(command string, response string) bool {
	frames := 0
	switch strings.TrimSpace(command) {
	case "~HQES":
		frames = 1
	case "~HS":
		frames = 3
	default:
		return false
	}
	for frame := 0; frame < frames; frame++ {
		response = strings.TrimLeft(response, " \t\r\n")
		if !strings.HasPrefix(response, "\x02") {
			return false
		}
		end := strings.IndexByte(response[1:], '\x03')
		if end < 0 {
			return false
		}
		end++
		if strings.Contains(response[1:end], "\x02") {
			return false
		}
		offset := end + 1
		if frames == 3 {
			if !strings.HasPrefix(response[offset:], "\r\n") {
				return false
			}
			offset += 2
		}
		response = response[offset:]
	}
	return strings.TrimSpace(response) == ""
}
