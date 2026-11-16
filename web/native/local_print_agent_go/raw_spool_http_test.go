package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newRawSpoolHTTPTestServer(t *testing.T) *appServer {
	t.Helper()
	listen, err := parseListenAddress("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	server := newAppServer(serverConfig{ListenAddress: listen, Port: 17917, RawSpoolStateDir: t.TempDir(), AllowNonZebraQueues: true})
	t.Cleanup(server.tcpJobs.close)
	t.Cleanup(server.rawSpoolBatches.close)
	server.rawQueueValidator = func(string) error { return nil }
	server.rawSpoolBatches.spool = func(string, string, string, func(uint32) error) (RawPrintResult, error) {
		return RawPrintResult{}, errors.New("unexpected spool attempt in admission-only test")
	}
	return server
}

func rawSpoolHTTPTestRequest(t *testing.T, server *appServer, path string, body any, wantCode int) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:17917"+path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "http://localhost:18888")
	response := httptest.NewRecorder()
	server.ServeHTTP(response, req)
	if response.Code != wantCode {
		t.Fatalf("path=%s got HTTP %d, want %d: %s", path, response.Code, wantCode, response.Body.String())
	}
	return response
}

func TestRawSpoolHTTPRejectsQueueBeforeCreatingStagingData(t *testing.T) {
	server := newRawSpoolHTTPTestServer(t)
	validated := 0
	server.rawQueueValidator = func(string) error {
		validated++
		return &apiError{Status: 409, Code: "RAW_QUEUE_SPOOLING_REQUIRED", Message: "Queue must spool the complete document."}
	}
	rawSpoolHTTPTestRequest(t, server, "/v1/print/batch", rawSpoolBatchRequest{
		Action: "begin", BatchID: "reject-invalid-queue", PrinterName: "Zebra test", DocumentName: "No hardware", TotalLabels: 2500,
	}, 409)
	if validated != 1 {
		t.Fatalf("validator called %d times", validated)
	}
	if len(server.rawSpoolBatches.batches) != 0 {
		t.Fatal("invalid queue reserved a batch before its settings were checked")
	}
	entries, err := os.ReadDir(server.rawSpoolBatches.dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.Name() != "store.lock" {
			t.Fatalf("invalid queue left staging data: %s", entry.Name())
		}
	}
}

func TestRawSpoolHTTPUnhealthyStoreBlocksLegacyBeforeValidation(t *testing.T) {
	server := newRawSpoolHTTPTestServer(t)
	server.rawSpoolBatches.mu.Lock()
	server.rawSpoolBatches.fault = errors.New("corrupt recovered checkpoint")
	server.rawSpoolBatches.mu.Unlock()
	// An empty legacy request cannot reach OpenPrinter even if the early guard
	// regresses; it would return 400. The required 503 proves fail-closed order.
	response := rawSpoolHTTPTestRequest(t, server, "/v1/print", map[string]any{}, 503)
	if !strings.Contains(response.Body.String(), "RAW_SPOOL_STORE_UNHEALTHY") {
		t.Fatalf("store fault was not surfaced: %s", response.Body.String())
	}
}

func TestRawSpoolHTTPArchiveListRetainsBatchIdentity(t *testing.T) {
	server := newRawSpoolHTTPTestServer(t)
	begin := rawSpoolBatchRequest{Action: "begin", BatchID: "archive-http-batch", PrinterName: "Zebra test", DocumentName: "No hardware", TotalLabels: 1}
	rawSpoolHTTPTestRequest(t, server, "/v1/print/batch", begin, 200)
	rawSpoolHTTPTestRequest(t, server, "/v1/print/batch", rawSpoolBatchRequest{Action: "archive", BatchID: begin.BatchID}, 409)
	rawSpoolHTTPTestRequest(t, server, "/v1/print/batch", rawSpoolBatchRequest{Action: "cancel", BatchID: begin.BatchID}, 200)
	rawSpoolHTTPTestRequest(t, server, "/v1/print/batch", rawSpoolBatchRequest{Action: "archive", BatchID: begin.BatchID}, 200)
	response := rawSpoolHTTPTestRequest(t, server, "/v1/print/batch", rawSpoolBatchRequest{Action: "list"}, 200)
	var listing struct {
		Batches []rawSpoolBatchResult `json:"batches"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &listing); err != nil || len(listing.Batches) != 0 {
		t.Fatalf("archived record remained in active history: %s %v", response.Body.String(), err)
	}
	response = rawSpoolHTTPTestRequest(t, server, "/v1/print/batch", begin, 200)
	var replay rawSpoolBatchResult
	if err := json.Unmarshal(response.Body.Bytes(), &replay); err != nil || !replay.Archived || replay.State != "cancelled" {
		t.Fatalf("archived batch ID admitted fresh work: %s %v", response.Body.String(), err)
	}
	_, active, waiting := server.printerQueues.stats()
	if active != 0 || waiting != 0 {
		t.Fatalf("archive/replay left a lane reserved: active=%d waiting=%d", active, waiting)
	}
}

func TestRawSpoolHTTPCheckpointAndCancelledClientStillOneJob(t *testing.T) {
	listen, err := parseListenAddress("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	server := newAppServer(serverConfig{
		ListenAddress: listen, Port: 17917, RawSpoolStateDir: t.TempDir(), AllowNonZebraQueues: true,
	})
	t.Cleanup(server.tcpJobs.close)
	t.Cleanup(server.rawSpoolBatches.close)
	// Everything beneath the HTTP protocol is real except Windows APIs.
	server.rawQueueValidator = func(string) error { return nil }
	var calls atomic.Int32
	allowSpool := make(chan struct{})
	var released atomic.Bool
	release := func() {
		if released.CompareAndSwap(false, true) {
			close(allowSpool)
		}
	}
	t.Cleanup(release)
	const id = "http-batch-0001"
	const printer = "Zebra test queue"
	const title = "Same template title"
	first, second := []byte("^XA^FDROW-0001^FS^XZ\n"), []byte("^XA^FDROW-0002^FS^XZ\n")
	expected := append(append([]byte{}, first...), second...)
	server.rawSpoolBatches.spool = func(gotPrinter, document, path string, onStarted func(uint32) error) (RawPrintResult, error) {
		calls.Add(1)
		if gotPrinter != printer || !strings.Contains(document, id) {
			return RawPrintResult{}, fmt.Errorf("spool identity was not bound to printer and batch")
		}
		if err := onStarted(77); err != nil {
			return RawPrintResult{}, err
		}
		<-allowSpool
		payload, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(payload, expected) {
			return RawPrintResult{}, fmt.Errorf("ordered staged payload mismatch: %v", err)
		}
		jobID := uint32(77)
		return RawPrintResult{OK: true, JobID: &jobID, BytesWritten: len(payload)}, nil
	}
	server.rawSpoolBatches.inspect = func(string, uint32) (RawJobStatus, error) {
		return RawJobStatus{JobID: 77, Exists: true, DocumentName: rawSpoolDocumentName(title, id), State: "spooler_completed"}, nil
	}
	request := func(ctx context.Context, origin string, body rawSpoolBatchRequest, wantCode int) rawSpoolBatchResult {
		t.Helper()
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:17917/v1/print/batch", bytes.NewReader(data)).WithContext(ctx)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", origin)
		response := httptest.NewRecorder()
		server.ServeHTTP(response, req)
		if response.Code != wantCode {
			t.Fatalf("action=%s got HTTP %d, want %d: %s", body.Action, response.Code, wantCode, response.Body.String())
		}
		var result rawSpoolBatchResult
		if wantCode == http.StatusOK {
			if err = json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
		}
		return result
	}
	ctx := context.Background()
	const owner = "http://localhost:18888"
	begin := rawSpoolBatchRequest{Action: "begin", BatchID: id, PrinterName: printer, DocumentName: title, TotalLabels: 2}
	if result := request(ctx, owner, begin, 200); result.State != "staging" || result.NextSequence != 1 {
		t.Fatalf("unexpected begin receipt: %+v", result)
	}
	appendFirst := rawSpoolBatchRequest{Action: "append", BatchID: id, Sequence: 1, LabelCount: 1, PayloadBase64: base64.StdEncoding.EncodeToString(first)}
	request(ctx, owner, appendFirst, 200)
	if replay := request(ctx, owner, appendFirst, 200); replay.NextSequence != 2 || replay.StagedLabels != 1 {
		t.Fatalf("HTTP retry duplicated accepted upload: %+v", replay)
	}
	changed := appendFirst
	changed.PayloadBase64 = base64.StdEncoding.EncodeToString([]byte("changed"))
	request(ctx, owner, changed, 409)
	request(ctx, "http://127.0.0.1:18888", rawSpoolBatchRequest{Action: "status", BatchID: id}, 404)
	request(ctx, owner, rawSpoolBatchRequest{Action: "append", BatchID: id, Sequence: 2, LabelCount: 1, PayloadBase64: base64.StdEncoding.EncodeToString(second)}, 200)
	if calls.Load() != 0 {
		t.Fatal("begin/append sent data to the spooler")
	}
	client, cancel := context.WithCancel(ctx)
	commit := rawSpoolBatchRequest{Action: "commit", BatchID: id, TotalChunks: 2, TotalBytes: int64(len(expected))}
	request(client, owner, commit, 200)
	cancel() // Losing the HTTP client must not truncate the connector-owned job.
	release()
	var status rawSpoolBatchResult
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		status = request(ctx, owner, rawSpoolBatchRequest{Action: "status", BatchID: id}, 200)
		if status.State == "spool-accepted" {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if status.State != "spool-accepted" || status.JobID == nil || *status.JobID != 77 || calls.Load() != 1 {
		t.Fatalf("connector did not finish exactly one spool submission: status=%+v calls=%d", status, calls.Load())
	}
	if status.SpoolStatus == nil || status.SpoolStatus.State != "spooler_completed" || status.SpoolStatus.PhysicalCompletionConfirmed {
		t.Fatalf("spooler telemetry was promoted to physical completion: %+v", status.SpoolStatus)
	}
	request(ctx, owner, commit, 200)
	request(ctx, owner, begin, 200)
	if calls.Load() != 1 {
		t.Fatal("completed begin/commit replay submitted another spool job")
	}
}
