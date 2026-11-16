package main

import (
	"fmt"
	"io"
	"strings"
)

const rawFileReadBufferBytes = 512 * 1024

// The staged-file path must use a single spool document. These hooks keep the
// lifecycle and partial-write handling testable without opening a printer.
type rawFileSpoolHooks struct {
	startDocument func() (uint32, error)
	startPage     func() error
	write         func([]byte) (int, error)
	endPage       func() error
	endDocument   func() error
	abort         func()
}

func streamRawFileDocument(reader io.Reader, expectedBytes int64, onStarted func(uint32) error, hooks rawFileSpoolHooks) (jobID uint32, bytesWritten int, err error) {
	if expectedBytes <= 0 || uint64(expectedBytes) > uint64(^uint(0)>>1) {
		return 0, 0, badRequest("The staged RAW file must be non-empty and fit the platform byte counter.")
	}
	jobID, err = hooks.startDocument()
	if err != nil {
		return 0, 0, rawFileFailure("RAW_START_DOCUMENT_FAILED", err, 0, false, false)
	}
	if jobID == 0 {
		return 0, 0, rawFileFailure("RAW_START_DOCUMENT_FAILED", fmt.Errorf("StartDocPrinter returned no job ID"), 0, false, false)
	}
	committed := false
	defer func() {
		if !committed {
			// Never EndDoc on a failure: that can commit a truncated document.
			hooks.abort()
		}
	}()
	if onStarted != nil {
		if err = onStarted(jobID); err != nil {
			return jobID, 0, rawFileFailure("RAW_JOB_ID_PERSIST_FAILED", err, 0, false, false)
		}
	}
	if err = hooks.startPage(); err != nil {
		return jobID, 0, rawFileFailure("RAW_START_PAGE_FAILED", err, 0, false, false)
	}
	buffer := make([]byte, rawFileReadBufferBytes)
	writeAttempted := false
	remaining := expectedBytes
	for remaining > 0 {
		readSize := int64(len(buffer))
		if remaining < readSize {
			readSize = remaining
		}
		n, readErr := io.ReadFull(reader, buffer[:int(readSize)])
		// A truncated or unreadable stage must not submit even its partial tail.
		if readErr != nil {
			return jobID, bytesWritten, rawFileFailure("RAW_FILE_READ_FAILED", readErr, bytesWritten, writeAttempted, false)
		}
		for offset := 0; offset < n; {
			writeAttempted = true
			written, writeErr := hooks.write(buffer[offset:n])
			if written < 0 || written > n-offset {
				return jobID, bytesWritten, rawFileFailure("RAW_WRITE_INVALID_COUNT", fmt.Errorf("WritePrinter returned an invalid byte count"), bytesWritten, true, false)
			}
			offset += written
			bytesWritten += written
			if writeErr != nil {
				return jobID, bytesWritten, rawFileFailure("RAW_WRITE_FAILED", writeErr, bytesWritten, true, false)
			}
			if written == 0 {
				return jobID, bytesWritten, rawFileFailure("RAW_WRITE_ZERO", io.ErrNoProgress, bytesWritten, true, false)
			}
		}
		remaining -= int64(n)
	}
	// Reject a stage that grew while being read. The manager owns immutable
	// staged files; this check also prevents silent truncation if that changes.
	var extra [1]byte
	if n, readErr := io.ReadFull(reader, extra[:]); n != 0 || readErr != io.EOF {
		if readErr == nil {
			readErr = fmt.Errorf("The staged RAW file grew during spooling")
		}
		return jobID, bytesWritten, rawFileFailure("RAW_FILE_CHANGED", readErr, bytesWritten, writeAttempted, false)
	}
	if err = hooks.endPage(); err != nil {
		return jobID, bytesWritten, rawFileFailure("RAW_END_PAGE_FAILED", err, bytesWritten, writeAttempted, true)
	}
	if err = hooks.endDocument(); err != nil {
		return jobID, bytesWritten, rawFileFailure("RAW_END_DOCUMENT_FAILED", err, bytesWritten, writeAttempted, true)
	}
	committed = true
	return jobID, bytesWritten, nil
}

func rawFileFailure(code string, cause error, written int, attempted, completed bool) error {
	outcome, retrySafety := "not_sent", "safe"
	if attempted {
		// Even a failed WritePrinter with zero reported bytes can be ambiguous.
		outcome, retrySafety = "possibly_sent", "unsafe"
	}
	return &apiError{
		Status: 502, Code: code, Stage: "spool", Message: fmt.Sprintf("%s after %d bytes", cause, written),
		Outcome: outcome, RetrySafety: retrySafety, BytesWritten: written,
		WriteStarted: attempted, WriteCompleted: completed,
	}
}

func validateRawFileQueue(attributes uint32, portName string) error {
	const printerAttributeQueued = 0x00000001
	const printerAttributeDirect = 0x00000002
	if attributes&printerAttributeDirect != 0 || attributes&printerAttributeQueued == 0 {
		return &apiError{
			Status: 409, Code: "RAW_QUEUE_SPOOLING_REQUIRED", Stage: "preflight", Outcome: "not_sent", RetrySafety: "safe",
			Message: "Windows printer Advanced settings must use 'Spool print documents' and 'Start printing after last page is spooled' for a staged batch. No printer settings were changed.",
		}
	}
	if strings.TrimSpace(portName) == "" || strings.Contains(portName, ",") {
		return &apiError{
			Status: 409, Code: "RAW_QUEUE_POOLING_UNSUPPORTED", Stage: "preflight", Outcome: "not_sent", RetrySafety: "safe",
			Message: "A staged batch requires one Windows printer port with printer pooling disabled. No printer settings were changed.",
		}
	}
	return nil
}

func rawWindowsJobState(status uint32) string {
	switch {
	case status&(0x00000004|0x00000100) != 0: // DELETING or DELETED
		return "deleting"
	case status&(0x00000002|0x00000020|0x00000040|0x00000200|0x00000400) != 0:
		return "error"
	case status&0x00000001 != 0:
		return "paused"
	case status&0x00000008 != 0:
		return "spooling"
	case status&0x00000010 != 0:
		return "printing"
	case status&(0x00000080|0x00001000) != 0: // PRINTED or COMPLETE, no TrueEndOfJob guarantee
		return "spooler_completed"
	default:
		return "queued"
	}
}
