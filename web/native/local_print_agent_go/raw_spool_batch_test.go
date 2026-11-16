package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const spoolTestOwner = "https://print.example.com"

func testRawSpoolManager(t *testing.T, dir string, spool rawFileSpooler) *rawSpoolBatchManager {
	t.Helper()
	if dir == "" {
		dir = t.TempDir()
	}
	if spool == nil {
		spool = func(_, _, path string, started func(uint32) error) (RawPrintResult, error) {
			data, err := os.ReadFile(path)
			if err != nil {
				return RawPrintResult{}, err
			}
			if err = started(77); err != nil {
				return RawPrintResult{}, err
			}
			return RawPrintResult{OK: true, BytesWritten: len(data)}, nil
		}
	}
	m := newRawSpoolBatchManager(dir, newPrinterTargetQueue(), spool, func(printer string, id uint32) (RawJobStatus, error) {
		return RawJobStatus{PrinterName: printer, JobID: id, Exists: false, State: "missing"}, nil
	})
	t.Cleanup(m.close)
	if healthy, _ := m.stats(); !healthy {
		t.Fatalf("new manager: %v", m.fault)
	}
	return m
}

func stageRawSpoolTest(t *testing.T, m *rawSpoolBatchManager, id string, payload []byte) {
	t.Helper()
	if _, err := m.begin(spoolTestOwner, id, "Zebra test", "Test", 1); err != nil {
		t.Fatal(err)
	}
	if _, err := m.append(spoolTestOwner, id, 1, 1, payload); err != nil {
		t.Fatal(err)
	}
}

func waitRawSpoolState(t *testing.T, m *rawSpoolBatchManager, id, state string) rawSpoolBatchResult {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		result, err := m.status(spoolTestOwner, id)
		if err != nil {
			t.Fatal(err)
		}
		if result.State == state {
			return result
		}
		time.Sleep(time.Millisecond)
	}
	result, err := m.status(spoolTestOwner, id)
	t.Fatalf("waiting for %s, got %+v / %v", state, result, err)
	return rawSpoolBatchResult{}
}

func TestRawSpool2500RowsOneImmutableJob(t *testing.T) {
	var calls atomic.Int32
	expected := bytes.Buffer{}
	for row := 1; row <= 2500; row++ {
		fmt.Fprintf(&expected, "^XA^FDrow-%04d epc-%024X^FS^PQ1^XZ\n", row, row)
	}
	wanted := append([]byte(nil), expected.Bytes()...)
	m := testRawSpoolManager(t, "", func(printer, document, path string, started func(uint32) error) (RawPrintResult, error) {
		calls.Add(1)
		if printer != "Zebra test" || !strings.Contains(document, "[NW:ordered_batch_2500]") {
			return RawPrintResult{}, errors.New("missing fixed queue/batch identity")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return RawPrintResult{}, err
		}
		if !bytes.Equal(data, wanted) {
			return RawPrintResult{}, errors.New("ordered immutable payload differs")
		}
		if err = started(88); err != nil {
			return RawPrintResult{}, err
		}
		return RawPrintResult{OK: true, BytesWritten: len(data)}, nil
	})
	if _, err := m.begin(spoolTestOwner, "ordered_batch_2500", "Zebra test", "Test", 2500); err != nil {
		t.Fatal(err)
	}
	lines := bytes.SplitAfter(wanted, []byte{'\n'})
	for chunk := 0; chunk < 250; chunk++ {
		data := bytes.Join(lines[chunk*10:(chunk+1)*10], nil)
		receipt, err := m.append(spoolTestOwner, "ordered_batch_2500", chunk+1, 10, data)
		if err != nil {
			t.Fatal(err)
		}
		if receipt.StagedLabels != (chunk+1)*10 || receipt.NextSequence != chunk+2 {
			t.Fatalf("bad checkpoint: %+v", receipt)
		}
		if calls.Load() != 0 {
			t.Fatal("staging called printer")
		}
	}
	if _, err := m.commit(spoolTestOwner, "ordered_batch_2500", 250, int64(len(wanted))); err != nil {
		t.Fatal(err)
	}
	receipt := waitRawSpoolState(t, m, "ordered_batch_2500", "spool-accepted")
	if receipt.JobID == nil || *receipt.JobID != 88 || receipt.StagedLabels != 2500 || calls.Load() != 1 {
		t.Fatalf("receipt %+v calls %d", receipt, calls.Load())
	}
	if _, err := m.commit(spoolTestOwner, "ordered_batch_2500", 250, int64(len(wanted))); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("commit retry duplicated spool job")
	}
}

func TestRawSpool50000RowsOneImmutableJob(t *testing.T) {
	var calls atomic.Int32
	expected := bytes.Buffer{}
	for row := 1; row <= 50000; row++ {
		fmt.Fprintf(&expected, "^XA^FDrow-%04d epc-%024X^FS^PQ1^XZ\n", row, row)
	}
	wanted := append([]byte(nil), expected.Bytes()...)
	m := testRawSpoolManager(t, "", func(printer, document, path string, started func(uint32) error) (RawPrintResult, error) {
		calls.Add(1)
		if printer != "Zebra test" || !strings.Contains(document, "[NW:ordered_batch_50000]") {
			return RawPrintResult{}, errors.New("missing fixed queue/batch identity")
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return RawPrintResult{}, err
		}
		if !bytes.Equal(data, wanted) {
			return RawPrintResult{}, errors.New("ordered immutable payload differs")
		}
		if err = started(88); err != nil {
			return RawPrintResult{}, err
		}
		return RawPrintResult{OK: true, BytesWritten: len(data)}, nil
	})
	if _, err := m.begin(spoolTestOwner, "ordered_batch_50000", "Zebra test", "Test", 50000); err != nil {
		t.Fatal(err)
	}
	lines := bytes.SplitAfter(wanted, []byte{'\n'})
	for chunk := 0; chunk < 500; chunk++ {
		data := bytes.Join(lines[chunk*100:(chunk+1)*100], nil)
		receipt, err := m.append(spoolTestOwner, "ordered_batch_50000", chunk+1, 100, data)
		if err != nil {
			t.Fatal(err)
		}
		if receipt.StagedLabels != (chunk+1)*100 || receipt.NextSequence != chunk+2 {
			t.Fatalf("bad checkpoint: %+v", receipt)
		}
		if calls.Load() != 0 {
			t.Fatal("staging called printer")
		}
	}
	if _, err := m.commit(spoolTestOwner, "ordered_batch_50000", 500, int64(len(wanted))); err != nil {
		t.Fatal(err)
	}
	receipt := waitRawSpoolState(t, m, "ordered_batch_50000", "spool-accepted")
	if receipt.JobID == nil || *receipt.JobID != 88 || receipt.StagedLabels != 50000 || calls.Load() != 1 {
		t.Fatalf("receipt %+v calls %d", receipt, calls.Load())
	}
	if _, err := m.commit(spoolTestOwner, "ordered_batch_50000", 500, int64(len(wanted))); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal("commit retry duplicated spool job")
	}
}

func TestRawSpoolReservationBeforeUploadAndCancel(t *testing.T) {
	calls := make(chan string, 4)
	m := testRawSpoolManager(t, "", func(_, document, path string, started func(uint32) error) (RawPrintResult, error) {
		data, _ := os.ReadFile(path)
		calls <- document
		if err := started(1); err != nil {
			return RawPrintResult{}, err
		}
		return RawPrintResult{OK: true, BytesWritten: len(data)}, nil
	})
	if _, err := m.begin(spoolTestOwner, "reserved_first", "Zebra test", "A", 1); err != nil {
		t.Fatal(err)
	}
	stageRawSpoolTest(t, m, "reserved_second", []byte("B"))
	if _, err := m.commit(spoolTestOwner, "reserved_second", 1, 1); err != nil {
		t.Fatal(err)
	}
	select {
	case <-calls:
		t.Fatal("second batch overtook first still rendering")
	case <-time.After(25 * time.Millisecond):
	}
	if _, err := m.cancel(spoolTestOwner, "reserved_first"); err != nil {
		t.Fatal(err)
	}
	waitRawSpoolState(t, m, "reserved_second", "spool-accepted")
	if document := <-calls; !strings.Contains(document, "reserved_second") {
		t.Fatal(document)
	}
	if _, err := m.begin(spoolTestOwner, "reservation_c", "Zebra test", "C", 1); err != nil {
		t.Fatal(err)
	}
	stageRawSpoolTest(t, m, "reservation_d", []byte("D"))
	if _, err := m.commit(spoolTestOwner, "reservation_d", 1, 1); err != nil {
		t.Fatal(err)
	}
	if _, err := m.cancel(spoolTestOwner, "reservation_d"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.cancel(spoolTestOwner, "reservation_c"); err != nil {
		t.Fatal(err)
	}
	m.close() // a cancelled waiting worker must wake rather than leak.
}

func TestRawSpoolAppendAndCommitValidation(t *testing.T) {
	m := testRawSpoolManager(t, "", nil)
	stageRawSpoolTest(t, m, "append_retries", []byte("^XA^XZ"))
	if _, err := m.append(spoolTestOwner, "append_retries", 1, 1, []byte("^XA^XZ")); err != nil {
		t.Fatal(err)
	}
	if _, err := m.append(spoolTestOwner, "append_retries", 1, 1, []byte("different")); err == nil {
		t.Fatal("changed bytes accepted")
	}
	if _, err := m.append(spoolTestOwner, "append_retries", 1, 2, []byte("^XA^XZ")); err == nil {
		t.Fatal("changed label count accepted")
	}
	if _, err := m.append(spoolTestOwner, "append_retries", 3, 1, []byte("gap")); err == nil {
		t.Fatal("sequence gap accepted")
	}
	if _, err := m.commit(spoolTestOwner, "append_retries", 1, 123); err == nil {
		t.Fatal("incorrect total bytes accepted")
	}
	if _, err := m.begin(spoolTestOwner, "append_retries", "Other queue", "Test", 1); err == nil {
		t.Fatal("queue mutation accepted")
	}
	if _, err := m.status("https://other.example", "append_retries"); err == nil {
		t.Fatal("another owner can inspect")
	}
	if _, err := m.begin(spoolTestOwner, "large_batch_labels", "Zebra test", "Test", 50_000); err != nil {
		t.Fatal("large batch rejected:", err)
	}
	if _, err := m.begin(spoolTestOwner, "invalid_label_count", "Zebra test", "Test", 0); err == nil {
		t.Fatal("invalid quantity accepted")
	}
	if _, err := m.cancel(spoolTestOwner, "append_retries"); err != nil {
		t.Fatal(err)
	}
	if _, err := m.append(spoolTestOwner, "append_retries", 2, 1, []byte("late")); err == nil {
		t.Fatal("cancelled batch appended")
	}
}

func TestRawSpoolRecoveryDoesNotAutoSubmitQueued(t *testing.T) {
	dir := t.TempDir()
	var calls atomic.Int32
	fake := func(_, _, path string, started func(uint32) error) (RawPrintResult, error) {
		calls.Add(1)
		data, _ := os.ReadFile(path)
		if err := started(2); err != nil {
			return RawPrintResult{}, err
		}
		return RawPrintResult{OK: true, BytesWritten: len(data)}, nil
	}
	m := testRawSpoolManager(t, dir, fake)
	if _, err := m.begin(spoolTestOwner, "recovery_blocker", "Zebra test", "A", 1); err != nil {
		t.Fatal(err)
	}
	stageRawSpoolTest(t, m, "recover_queued", []byte("B"))
	if _, err := m.commit(spoolTestOwner, "recover_queued", 1, 1); err != nil {
		t.Fatal(err)
	}
	m.close()
	recovered := testRawSpoolManager(t, dir, fake)
	result, err := recovered.status(spoolTestOwner, "recover_queued")
	if err != nil || result.State != "queued" || !result.RecoveryRequired {
		t.Fatalf("recovery %+v %v", result, err)
	}
	if _, err = recovered.cancel(spoolTestOwner, "recovery_blocker"); err != nil {
		t.Fatal(err)
	}
	time.Sleep(20 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("restart automatically submitted queued job")
	}
	if _, err = recovered.commit(spoolTestOwner, "recover_queued", 1, 1); err != nil {
		t.Fatal(err)
	}
	waitRawSpoolState(t, recovered, "recover_queued", "spool-accepted")
	if calls.Load() != 1 {
		t.Fatal("explicit recovery must submit once")
	}
}

func TestRawSpoolRestartSpoolingBecomesUncertainAndBlocksLane(t *testing.T) {
	dir := t.TempDir()
	m := testRawSpoolManager(t, dir, nil)
	stageRawSpoolTest(t, m, "recover_uncertain", []byte("A"))
	m.mu.Lock()
	b := m.batches["recover_uncertain"]
	b.manifest.State = "spooling"
	job := uint32(91)
	b.manifest.JobID = &job
	if err := m.saveLocked(b); err != nil {
		t.Fatal(err)
	}
	m.mu.Unlock()
	m.close()
	var calls atomic.Int32
	recovered := testRawSpoolManager(t, dir, func(_, _, path string, started func(uint32) error) (RawPrintResult, error) {
		calls.Add(1)
		data, _ := os.ReadFile(path)
		if err := started(92); err != nil {
			return RawPrintResult{}, err
		}
		return RawPrintResult{OK: true, BytesWritten: len(data)}, nil
	})
	result, err := recovered.status(spoolTestOwner, "recover_uncertain")
	if err != nil || result.State != "uncertain" {
		t.Fatalf("recovery %+v %v", result, err)
	}
	stageRawSpoolTest(t, recovered, "after_uncertain", []byte("B"))
	if _, err = recovered.commit(spoolTestOwner, "after_uncertain", 1, 1); err != nil {
		t.Fatal(err)
	}
	if _, err = recovered.cancel(spoolTestOwner, "recover_uncertain"); err == nil {
		t.Fatal("uncertain cancelled as unsent")
	}
	if _, err = recovered.reconcile(spoolTestOwner, "recover_uncertain", "do-not-reprint", false); err == nil {
		t.Fatal("missing operator acknowledgement accepted")
	}
	time.Sleep(20 * time.Millisecond)
	if calls.Load() != 0 {
		t.Fatal("uncertain lane released automatically")
	}
	recovered.inspect = func(printer string, id uint32) (RawJobStatus, error) {
		return RawJobStatus{Exists: true, PrinterName: printer, JobID: id, DocumentName: rawSpoolDocumentName("Test", "recover_uncertain"), State: "printing"}, nil
	}
	if _, err = recovered.reconcile(spoolTestOwner, "recover_uncertain", "do-not-reprint", true); err == nil {
		t.Fatal("active Windows job released")
	}
	recovered.inspect = func(string, uint32) (RawJobStatus, error) { return RawJobStatus{Exists: false}, nil }
	if _, err = recovered.reconcile(spoolTestOwner, "recover_uncertain", "do-not-reprint", true); err != nil {
		t.Fatal(err)
	}
	waitRawSpoolState(t, recovered, "after_uncertain", "spool-accepted")
	if calls.Load() != 1 {
		t.Fatal("uncertain job was reprinted")
	}
}

func TestRawSpoolFailureAfterStartedIsUncertain(t *testing.T) {
	m := testRawSpoolManager(t, "", func(_, _, _ string, started func(uint32) error) (RawPrintResult, error) {
		if err := started(44); err != nil {
			return RawPrintResult{}, err
		}
		return RawPrintResult{}, errors.New("driver failed")
	})
	stageRawSpoolTest(t, m, "failed_after_start", []byte("A"))
	if _, err := m.commit(spoolTestOwner, "failed_after_start", 1, 1); err != nil {
		t.Fatal(err)
	}
	result := waitRawSpoolState(t, m, "failed_after_start", "uncertain")
	if result.JobID == nil || *result.JobID != 44 {
		t.Fatal("job identity not persisted")
	}
	if _, err := m.commit(spoolTestOwner, "failed_after_start", 1, 1); err != nil {
		t.Fatal(err)
	}
}

func TestRawSpoolDefinitelyUnsentFailureReleasesLane(t *testing.T) {
	var calls atomic.Int32
	m := testRawSpoolManager(t, "", func(_, _, path string, started func(uint32) error) (RawPrintResult, error) {
		if calls.Add(1) == 1 {
			return RawPrintResult{}, errors.New("queue preflight rejected")
		}
		data, _ := os.ReadFile(path)
		if err := started(2); err != nil {
			return RawPrintResult{}, err
		}
		return RawPrintResult{OK: true, BytesWritten: len(data)}, nil
	})
	stageRawSpoolTest(t, m, "unsent_failure", []byte("A"))
	if _, err := m.commit(spoolTestOwner, "unsent_failure", 1, 1); err != nil {
		t.Fatal(err)
	}
	waitRawSpoolState(t, m, "unsent_failure", "failed")
	stageRawSpoolTest(t, m, "after_unsent_failure", []byte("B"))
	if _, err := m.commit(spoolTestOwner, "after_unsent_failure", 1, 1); err != nil {
		t.Fatal(err)
	}
	waitRawSpoolState(t, m, "after_unsent_failure", "spool-accepted")
}

func TestRawSpoolStagingCrashOrphanIsSafeToReupload(t *testing.T) {
	dir := t.TempDir()
	m := testRawSpoolManager(t, dir, nil)
	if _, err := m.begin(spoolTestOwner, "orphan_staging", "Zebra test", "Test", 1); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(m.chunkPath("orphan_staging", 1), []byte("uncommitted"), 0600); err != nil {
		t.Fatal(err)
	}
	empty := filepath.Join(dir, "begin_crash_dir")
	if err := os.Mkdir(empty, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(empty, ".write-test.tmp"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	m.close()
	recovered := testRawSpoolManager(t, dir, nil)
	if _, err := os.Stat(empty); !os.IsNotExist(err) {
		t.Fatal("unaccepted begin directory not reclaimed")
	}
	if _, err := recovered.append(spoolTestOwner, "orphan_staging", 1, 1, []byte("committed")); err != nil {
		t.Fatal(err)
	}
}

func TestRawSpoolCorruptReferencedChunkFailsClosed(t *testing.T) {
	dir := t.TempDir()
	m := testRawSpoolManager(t, dir, nil)
	stageRawSpoolTest(t, m, "corrupt_payload", []byte("correct"))
	m.close()
	if err := os.WriteFile(filepath.Join(dir, "corrupt_payload", "chunk-000001.zpl"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	recovered := newRawSpoolBatchManager(dir, newPrinterTargetQueue(), nil, nil)
	defer recovered.close()
	if healthy, _ := recovered.stats(); healthy {
		t.Fatal("corrupted state enabled printing")
	}
	if _, err := recovered.begin(spoolTestOwner, "after_corruption", "Zebra test", "Test", 1); err == nil {
		t.Fatal("unhealthy store admitted job")
	}
}

func TestRawSpoolArchiveRetainsNoReprintTombstone(t *testing.T) {
	dir := t.TempDir()
	m := testRawSpoolManager(t, dir, nil)
	stageRawSpoolTest(t, m, "archive_finished", []byte("A"))
	if _, err := m.commit(spoolTestOwner, "archive_finished", 1, 1); err != nil {
		t.Fatal(err)
	}
	waitRawSpoolState(t, m, "archive_finished", "spool-accepted")
	receipt, err := m.archive(spoolTestOwner, "archive_finished")
	if err != nil || !receipt.Archived || receipt.NextSequence != 2 {
		t.Fatalf("archive %+v %v", receipt, err)
	}
	list, err := m.list(spoolTestOwner)
	if err != nil || len(list) != 0 {
		t.Fatal("archive remains listed")
	}
	m.close()
	recovered := testRawSpoolManager(t, dir, nil)
	receipt, err = recovered.begin(spoolTestOwner, "archive_finished", "Zebra test", "Test", 1)
	if err != nil || receipt.State != "spool-accepted" || !receipt.Archived {
		t.Fatalf("batchId reused after archive: %+v %v", receipt, err)
	}
}

func TestRawSpoolExclusiveStoreLock(t *testing.T) {
	dir := t.TempDir()
	m := testRawSpoolManager(t, dir, nil)
	other := newRawSpoolBatchManager(dir, newPrinterTargetQueue(), nil, nil)
	defer other.close()
	if healthy, _ := other.stats(); healthy {
		t.Fatal("two connectors acquired one durable store")
	}
	m.close()
}

func TestRawSpoolHTTPAuthorizationOwnershipAndNoPrintBeforeCommit(t *testing.T) {
	server, pairing := testServerConfigured(t, "127.0.0.1", true)
	server.allowNonZebraQueues = true
	server.rawQueueValidator = func(string) error { return nil }
	var calls atomic.Int32
	server.rawSpoolBatches.spool = func(_, _, path string, started func(uint32) error) (RawPrintResult, error) {
		calls.Add(1)
		data, _ := os.ReadFile(path)
		if err := started(99); err != nil {
			return RawPrintResult{}, err
		}
		return RawPrintResult{OK: true, BytesWritten: len(data)}, nil
	}
	if err := pairing.store.add(spoolTestOwner, "token-one", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := pairing.store.add("https://other.example", "token-two", time.Now()); err != nil {
		t.Fatal(err)
	}
	post := func(origin, token string, body any) *httptest.ResponseRecorder {
		data, _ := json.Marshal(body)
		request := httptest.NewRequest(http.MethodPost, "http://127.0.0.1:17917/v1/print/batch", bytes.NewReader(data))
		request.Header.Set("Content-Type", "application/json")
		if origin != "" {
			request.Header.Set("Origin", origin)
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response := httptest.NewRecorder()
		server.ServeHTTP(response, request)
		return response
	}
	begin := rawSpoolBatchRequest{Action: "begin", BatchID: "http_batch_test", PrinterName: "Zebra test", DocumentName: "HTTP", TotalLabels: 1}
	if r := post("", "", begin); r.Code != 403 {
		t.Fatalf("origin bypass %d", r.Code)
	}
	if r := post(spoolTestOwner, "wrong", begin); r.Code != 401 {
		t.Fatalf("token bypass %d", r.Code)
	}
	if r := post(spoolTestOwner, "token-one", begin); r.Code != 200 {
		t.Fatalf("begin %d %s", r.Code, r.Body)
	}
	if r := post("https://other.example", "token-two", rawSpoolBatchRequest{Action: "status", BatchID: begin.BatchID}); r.Code != 404 {
		t.Fatalf("owner bypass %d", r.Code)
	}
	appendBody := rawSpoolBatchRequest{Action: "append", BatchID: begin.BatchID, Sequence: 1, LabelCount: 1, PayloadBase64: base64.StdEncoding.EncodeToString([]byte("ABC"))}
	if r := post(spoolTestOwner, "token-one", appendBody); r.Code != 200 {
		t.Fatalf("append %d %s", r.Code, r.Body)
	}
	if calls.Load() != 0 {
		t.Fatal("begin/append called printer")
	}
	if r := post(spoolTestOwner, "token-one", rawSpoolBatchRequest{Action: "commit", BatchID: begin.BatchID, TotalChunks: 1, TotalBytes: 3}); r.Code != 200 {
		t.Fatalf("commit %d %s", r.Code, r.Body)
	}
	waitRawSpoolState(t, server.rawSpoolBatches, begin.BatchID, "spool-accepted")
}
