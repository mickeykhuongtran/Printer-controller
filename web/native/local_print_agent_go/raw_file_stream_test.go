package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"strings"
	"testing"
)

type boundedTestReader struct {
	reader     io.Reader
	maxRequest int
}

func (r *boundedTestReader) Read(p []byte) (int, error) {
	if len(p) > r.maxRequest {
		r.maxRequest = len(p)
	}
	// Exercise reads shorter than the requested buffer as well as short writes.
	if len(p) > 8191 {
		p = p[:8191]
	}
	return r.reader.Read(p)
}

type fakeRawFileSpool struct {
	events    []string
	payload   bytes.Buffer
	writeMax  int
	writeErr  error
	zeroWrite bool
	failAt    string
}

func (s *fakeRawFileSpool) operation(name string) error {
	s.events = append(s.events, name)
	if s.failAt == name {
		return fmt.Errorf("%s failed", name)
	}
	return nil
}

func (s *fakeRawFileSpool) hooks() rawFileSpoolHooks {
	return rawFileSpoolHooks{
		startDocument: func() (uint32, error) { return 42, s.operation("startDocument") },
		startPage:     func() error { return s.operation("startPage") },
		write: func(p []byte) (int, error) {
			s.events = append(s.events, "write")
			if len(p) > s.writeMax {
				s.writeMax = len(p)
			}
			if s.zeroWrite {
				return 0, s.writeErr
			}
			if len(p) > 7331 {
				p = p[:7331]
			}
			n, _ := s.payload.Write(p)
			return n, s.writeErr
		},
		endPage:     func() error { return s.operation("endPage") },
		endDocument: func() error { return s.operation("endDocument") },
		abort:       func() { _ = s.operation("abort") },
	}
}

func countEvent(events []string, name string) int {
	count := 0
	for _, event := range events {
		if event == name {
			count++
		}
	}
	return count
}

func TestRawFileStream2500OrderedRowsSingleJobBoundedReads(t *testing.T) {
	var expected bytes.Buffer
	for sequence := 1; sequence <= 2500; sequence++ {
		fmt.Fprintf(&expected, "^XA^FO10,10^FDROW-%04d-%s^FS^XZ\n", sequence, strings.Repeat("x", 1024))
	}
	reader := &boundedTestReader{reader: bytes.NewReader(expected.Bytes())}
	spool := &fakeRawFileSpool{}
	jobID, written, err := streamRawFileDocument(reader, int64(expected.Len()), func(id uint32) error {
		if id != 42 || spool.payload.Len() != 0 {
			t.Fatal("job ID must be persisted before any bytes are submitted")
		}
		return spool.operation("persistJobID")
	}, spool.hooks())
	if err != nil || jobID != 42 || written != expected.Len() {
		t.Fatalf("job=%d written=%d error=%v", jobID, written, err)
	}
	if !bytes.Equal(spool.payload.Bytes(), expected.Bytes()) {
		t.Fatal("2500 datafeed rows were reordered, omitted, duplicated, or truncated")
	}
	if reader.maxRequest != rawFileReadBufferBytes || spool.writeMax > rawFileReadBufferBytes {
		t.Fatalf("unbounded stream: reader=%d writer=%d", reader.maxRequest, spool.writeMax)
	}
	for _, event := range []string{"startDocument", "persistJobID", "startPage", "endPage", "endDocument"} {
		if countEvent(spool.events, event) != 1 {
			t.Fatalf("expected exactly one %s: %v", event, spool.events)
		}
	}
	if strings.Join(spool.events[:3], ",") != "startDocument,persistJobID,startPage" || countEvent(spool.events, "abort") != 0 {
		t.Fatalf("invalid lifecycle: %v", spool.events)
	}
}

func TestRawFileStreamFailureAlwaysAbortsWithoutCommitting(t *testing.T) {
	for _, stage := range []string{"persistJobID", "startPage", "endPage", "endDocument"} {
		t.Run(stage, func(t *testing.T) {
			spool := &fakeRawFileSpool{failAt: stage}
			_, _, err := streamRawFileDocument(strings.NewReader("^XA^XZ"), 6, func(uint32) error {
				return spool.operation("persistJobID")
			}, spool.hooks())
			var apiErr *apiError
			if !errors.As(err, &apiErr) || countEvent(spool.events, "abort") != 1 {
				t.Fatalf("failure must abort: error=%v events=%v", err, spool.events)
			}
			if stage != "endDocument" && countEvent(spool.events, "endDocument") != 0 {
				t.Fatal("failure committed a spool document")
			}
			beforeWrite := stage == "persistJobID" || stage == "startPage"
			if beforeWrite && (spool.payload.Len() != 0 || apiErr.Outcome != "not_sent") {
				t.Fatalf("pre-write failure submitted bytes: %+v", apiErr)
			}
			if !beforeWrite && (apiErr.Outcome != "possibly_sent" || apiErr.RetrySafety != "unsafe") {
				t.Fatalf("post-write failure must be uncertain: %+v", apiErr)
			}
		})
	}
}

func TestRawFileStreamZeroAndFailedWritesAreUncertain(t *testing.T) {
	for _, tc := range []struct {
		name string
		zero bool
		err  error
	}{
		{"zero", true, nil},
		{"failed-before-count", true, io.ErrClosedPipe},
		{"failed-with-count", false, io.ErrClosedPipe},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spool := &fakeRawFileSpool{zeroWrite: tc.zero, writeErr: tc.err}
			_, written, err := streamRawFileDocument(strings.NewReader("123456"), 6, nil, spool.hooks())
			var apiErr *apiError
			if !errors.As(err, &apiErr) || apiErr.Outcome != "possibly_sent" || apiErr.RetrySafety != "unsafe" || !apiErr.WriteStarted {
				t.Fatalf("write attempt must be uncertain: %+v", err)
			}
			if written != spool.payload.Len() || apiErr.BytesWritten != written || countEvent(spool.events, "abort") != 1 || countEvent(spool.events, "endDocument") != 0 {
				t.Fatalf("bad failure accounting: written=%d error=%v events=%v", written, err, spool.events)
			}
		})
	}
}

func TestRawFileStreamChangedStageAborts(t *testing.T) {
	for _, tc := range []struct {
		name    string
		payload string
		size    int64
	}{
		{"truncated", "123", 4},
		{"grew", "12345", 4},
	} {
		t.Run(tc.name, func(t *testing.T) {
			spool := &fakeRawFileSpool{}
			_, _, err := streamRawFileDocument(strings.NewReader(tc.payload), tc.size, nil, spool.hooks())
			if err == nil || countEvent(spool.events, "abort") != 1 || countEvent(spool.events, "endDocument") != 0 {
				t.Fatalf("stage change was not aborted: %v %v", err, spool.events)
			}
		})
	}
}

func TestRawFileStreamStartFailureAndEmptyInputDoNotWrite(t *testing.T) {
	for _, size := range []int64{0, -1, 6} {
		spool := &fakeRawFileSpool{failAt: "startDocument"}
		_, _, err := streamRawFileDocument(strings.NewReader("123456"), size, nil, spool.hooks())
		if err == nil || spool.payload.Len() != 0 || countEvent(spool.events, "abort") != 0 {
			t.Fatalf("unexpected lifecycle: %v %v", err, spool.events)
		}
	}
}

func TestRawFileQueueRequiresCompleteSpoolingAndSinglePort(t *testing.T) {
	for _, tc := range []struct {
		name       string
		attributes uint32
		port       string
		allowed    bool
	}{
		{"after-last-page", 1, "USB001", true},
		{"while-spooling", 0, "USB001", false},
		{"direct", 2, "USB001", false},
		{"direct-and-queued", 3, "USB001", false},
		{"pooling", 1, "USB001,USB002", false},
		{"unknown-port", 1, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := validateRawFileQueue(tc.attributes, tc.port)
			if (err == nil) != tc.allowed {
				t.Fatalf("allowed=%v error=%v", tc.allowed, err)
			}
		})
	}
}

func TestRawWindowsStatusDoesNotPromisePhysicalCompletion(t *testing.T) {
	for _, status := range []uint32{0x80, 0x1000} {
		if rawWindowsJobState(status) != "spooler_completed" {
			t.Fatal("Windows completion must remain spooler-only telemetry")
		}
	}
	if rawWindowsJobState(0x8) != "spooling" || rawWindowsJobState(0x10) != "printing" || rawWindowsJobState(0x2|0x80) != "error" {
		t.Fatal("Windows status priority is incorrect")
	}
}
