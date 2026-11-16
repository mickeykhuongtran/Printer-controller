package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

// Legacy transport-only fakes do not implement Zebra status commands. Monitor
// tests construct the production manager and opt into its real polling loop.
func newTCPJobManagerWithDial(dial tcpJobDialFunc) *tcpJobManager {
	m := newTCPJobManagerWithDialAndQueue(dial, newPrinterTargetQueue())
	m.monitorInterval = 0
	return m
}

func TestTCPJobReconciliationRequiresAuditAndNeverReplays(t *testing.T) {
	dials := 0
	manager := newTCPJobManagerWithDial(func(_ context.Context, _ string, _ int, _ time.Duration) (net.Conn, string, error) {
		dials++
		client, peer := net.Pipe()
		go func() { _, _ = io.Copy(io.Discard, peer); _ = peer.Close() }()
		return client, "192.168.50.50", nil
	})
	defer manager.close()
	const owner, jobID = "reconcile-owner", "reconcile-job"
	_, err := manager.open(context.Background(), owner, jobID, "printer", 9100, time.Second, time.Second, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	_, err = manager.reconcile(owner, jobID, 0, 0, tcpJobSeed(jobID), "Physical audit")
	requireAPIErrorCode(t, err, "TCP_JOB_RECONCILE_STATE")
	payload := []byte("^XA^FDONE^FS^XZ")
	receipt, err := manager.append(owner, jobID, 1, payload, payloadDigest(payload))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = manager.abort(owner, jobID); err != nil {
		t.Fatal(err)
	}
	_, err = manager.open(context.Background(), owner, "next-job", "printer", 9100, time.Second, time.Second, time.Minute)
	requireAPIErrorCode(t, err, "TCP_JOB_TARGET_QUARANTINED")
	_, err = manager.reconcile("other-owner", jobID, 1, receipt.CumulativeBytes, receipt.CheckpointHash, "Physical audit")
	requireAPIErrorCode(t, err, "TCP_JOB_NOT_FOUND")
	_, err = manager.reconcile(owner, jobID, 2, receipt.CumulativeBytes, receipt.CheckpointHash, "Physical audit")
	requireAPIErrorCode(t, err, "TCP_JOB_RECONCILE_CHECKPOINT")
	server := &appServer{tcpJobs: manager}
	body := map[string]any{"action": "reconcile", "jobId": jobID, "expectedSequence": 1,
		"expectedBytes": receipt.CumulativeBytes, "checkpointHash": receipt.CheckpointHash,
		"reconciliationNote": "Verified rows, EPCs and empty buffer", "confirmed": false}
	invoke := func() error {
		encoded, _ := json.Marshal(body)
		return server.handleTCPJob(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/tcp/job", bytes.NewReader(encoded)), owner)
	}
	if err := invoke(); err == nil {
		t.Fatal("unconfirmed audit was accepted")
	}
	body["confirmed"] = true
	if err := invoke(); err != nil {
		t.Fatal(err)
	}
	if err := invoke(); err != nil {
		t.Fatal("idempotent audit failed:", err)
	}
	audited, err := manager.poll(owner, jobID)
	if err != nil || !audited.Reconciled || audited.State != "uncertain" || audited.CumulativeBytes != receipt.CumulativeBytes {
		t.Fatalf("audit lost evidence: %+v %v", audited, err)
	}
	if dials != 1 {
		t.Fatal("reconciliation opened a printer connection")
	}
	_, err = manager.open(context.Background(), owner, "next-job", "printer", 9100, time.Second, time.Second, time.Minute)
	if err != nil {
		t.Fatal("audited target remains quarantined:", err)
	}
	if dials != 2 {
		t.Fatal("new job did not get its own socket")
	}
}

func payloadDigest(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

func requireAPIErrorCode(t *testing.T, err error, code string) *apiError {
	t.Helper()
	var apiErr *apiError
	if !errors.As(err, &apiErr) {
		t.Fatalf("expected *apiError %s, got %T: %v", code, err, err)
	}
	if apiErr.Code != code {
		t.Fatalf("expected code %s, got %s: %v", code, apiErr.Code, err)
	}
	return apiErr
}

func TestTCPJobCheckpointCanonicalVector(t *testing.T) {
	const jobID = "go-persistent-test"
	const expectedSeed = "be5040a81326f6318eb3e28a172cdad2acb284251cdd114f57d71cc69c815997"
	const expectedPayloadHash = "267d3b81a9dcd937f3b46a17a57fc0ca2133373389336861142673a73fc17bc6"
	const expectedCheckpoint = "03a52539a5991e55b73465089fac5e1a6c155a08f4003f70afe8d68aa323e8e0"

	if actual := tcpJobSeed(jobID); actual != expectedSeed {
		t.Fatalf("canonical seed mismatch: got %s", actual)
	}
	if actual := nextTCPJobCheckpoint(
		expectedSeed,
		1,
		len("FIRST"),
		expectedPayloadHash,
	); actual != expectedCheckpoint {
		t.Fatalf("canonical checkpoint mismatch: got %s", actual)
	}
}

func TestTCPJobOneSocketIdempotencyAndFinish(t *testing.T) {
	var dialCount int
	var received bytes.Buffer
	var copyWait sync.WaitGroup
	var serverConn net.Conn
	manager := newTCPJobManagerWithDial(func(
		_ context.Context,
		_ string,
		_ int,
		_ time.Duration,
	) (net.Conn, string, error) {
		dialCount++
		client, server := net.Pipe()
		serverConn = server
		copyWait.Add(1)
		go func() {
			defer copyWait.Done()
			_, _ = io.Copy(&received, server)
			_ = server.Close()
		}()
		return client, "192.168.50.50", nil
	})
	defer func() {
		if serverConn != nil {
			_ = serverConn.Close()
		}
	}()

	const owner = "test-owner"
	const jobID = "go-persistent-test"
	opened, err := manager.open(
		context.Background(),
		owner,
		jobID,
		"192.168.50.50",
		9100,
		time.Second,
		time.Second,
		time.Minute,
	)
	if err != nil {
		t.Fatalf("open failed: %v", err)
	}
	if opened.State != "open" || opened.NextSequence != 1 {
		t.Fatalf("unexpected open receipt: %+v", opened)
	}

	first := []byte("FIRST")
	firstHash := payloadDigest(first)
	firstReceipt, err := manager.append(owner, jobID, 1, first, firstHash)
	if err != nil {
		t.Fatalf("first append failed: %v", err)
	}
	if firstReceipt.BytesWritten != len(first) || firstReceipt.NextSequence != 2 {
		t.Fatalf("unexpected first receipt: %+v", firstReceipt)
	}
	if firstReceipt.CheckpointHash !=
		"03a52539a5991e55b73465089fac5e1a6c155a08f4003f70afe8d68aa323e8e0" {
		t.Fatalf("unexpected canonical checkpoint: %s", firstReceipt.CheckpointHash)
	}

	duplicate, err := manager.append(owner, jobID, 1, first, firstHash)
	if err != nil {
		t.Fatalf("duplicate append failed: %v", err)
	}
	if !duplicate.Deduplicated || duplicate.CumulativeBytes != int64(len(first)) {
		t.Fatalf("duplicate was not deduplicated: %+v", duplicate)
	}

	_, err = manager.append(owner, jobID, 1, []byte("changed"), payloadDigest([]byte("changed")))
	requireAPIErrorCode(t, err, "TCP_JOB_CHECKPOINT_CONFLICT")
	_, err = manager.append(owner, jobID, 3, []byte("gap"), payloadDigest([]byte("gap")))
	requireAPIErrorCode(t, err, "TCP_JOB_SEQUENCE_GAP")

	second := []byte("-SECOND")
	secondReceipt, err := manager.append(
		owner,
		jobID,
		2,
		second,
		payloadDigest(second),
	)
	if err != nil {
		t.Fatalf("second append failed: %v", err)
	}
	expectedBytes := int64(len(first) + len(second))
	finished, err := manager.finish(
		owner,
		jobID,
		2,
		expectedBytes,
		secondReceipt.CheckpointHash,
	)
	if err != nil {
		t.Fatalf("finish failed: %v", err)
	}
	if finished.State != "finished" || finished.CumulativeBytes != expectedBytes {
		t.Fatalf("unexpected finish receipt: %+v", finished)
	}
	finishedAgain, err := manager.finish(
		owner,
		jobID,
		2,
		expectedBytes,
		secondReceipt.CheckpointHash,
	)
	if err != nil || !finishedAgain.Deduplicated {
		t.Fatalf("finish must be idempotent: %+v, %v", finishedAgain, err)
	}

	copyWait.Wait()
	if dialCount != 1 {
		t.Fatalf("expected one persistent printer connection, got %d", dialCount)
	}
	if actual, expected := received.String(), string(first)+string(second); actual != expected {
		t.Fatalf("printer bytes mismatch: got %q, expected %q", actual, expected)
	}
}

func TestTCPJobStatusQueryUsesSamePersistentSocket(t *testing.T) {
	const owner = "query-owner"
	const jobID = "same-socket-query"
	const statusCommand = "! U1 getvar \"zpl.system_status\"\r\n"
	const statusResponse = "0,0,00000000,00000000,0,00000000,00000000\r\n"
	var dialCount int
	manager := newTCPJobManagerWithDial(func(
		_ context.Context,
		_ string,
		_ int,
		_ time.Duration,
	) (net.Conn, string, error) {
		dialCount++
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			expected := []byte("^XA^XZ" + statusCommand)
			received := make([]byte, len(expected))
			_, _ = io.ReadFull(server, received)
			if bytes.Equal(received, expected) {
				_, _ = server.Write([]byte(statusResponse))
			}
		}()
		return client, "192.168.50.50", nil
	})
	defer manager.close()

	_, err := manager.open(
		context.Background(), owner, jobID, "192.168.50.50", 9100,
		time.Second, time.Second, time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	payload := []byte("^XA^XZ")
	if _, err = manager.append(owner, jobID, 1, payload, payloadDigest(payload)); err != nil {
		t.Fatal(err)
	}
	result, err := manager.queryContext(
		context.Background(), owner, jobID, []byte(statusCommand),
		time.Second, 25*time.Millisecond,
	)
	if err != nil {
		t.Fatal(err)
	}
	if result.Response != statusResponse {
		t.Fatalf("status response = %q, want %q", result.Response, statusResponse)
	}
	if result.CumulativeBytes != int64(len(payload)) || result.NextSequence != 2 {
		t.Fatalf("status query changed print checkpoint: %+v", result)
	}
	if dialCount != 1 {
		t.Fatalf("status query opened %d sockets, want 1", dialCount)
	}
}

func TestTCPJobRejectsSecondSocketForSamePrinter(t *testing.T) {
	var peers []net.Conn
	manager := newTCPJobManagerWithDial(func(
		_ context.Context,
		_ string,
		_ int,
		_ time.Duration,
	) (net.Conn, string, error) {
		client, server := net.Pipe()
		peers = append(peers, server)
		return client, "192.168.50.50", nil
	})
	defer func() {
		manager.close()
		for _, peer := range peers {
			_ = peer.Close()
		}
	}()

	if _, err := manager.open(
		context.Background(), "owner-a", "target-owner-a",
		"printer-a", 9100, time.Second, time.Second, time.Minute,
	); err != nil {
		t.Fatal(err)
	}
	_, err := manager.open(
		context.Background(), "owner-b", "target-owner-b",
		"printer-a", 9100, time.Second, time.Second, time.Minute,
	)
	apiErr := requireAPIErrorCode(t, err, "TCP_JOB_TARGET_BUSY")
	if apiErr.Outcome != "not_sent" || apiErr.WriteStarted {
		t.Fatalf("busy target must be a safe admission failure: %+v", apiErr)
	}
}

type partialWriteConn struct {
	closed bool
}

func (connection *partialWriteConn) Read(_ []byte) (int, error) {
	return 0, io.EOF
}

func (connection *partialWriteConn) Write(payload []byte) (int, error) {
	count := 2
	if len(payload) < count {
		count = len(payload)
	}
	return count, errors.New("injected partial write")
}

func (connection *partialWriteConn) Close() error {
	connection.closed = true
	return nil
}

func (connection *partialWriteConn) LocalAddr() net.Addr {
	return testNetAddr("local")
}

func (connection *partialWriteConn) RemoteAddr() net.Addr {
	return testNetAddr("remote")
}

func (connection *partialWriteConn) SetDeadline(_ time.Time) error {
	return nil
}

func (connection *partialWriteConn) SetReadDeadline(_ time.Time) error {
	return nil
}

func (connection *partialWriteConn) SetWriteDeadline(_ time.Time) error {
	return nil
}

type testNetAddr string

func (address testNetAddr) Network() string {
	return "tcp"
}

func (address testNetAddr) String() string {
	return string(address)
}

func TestTCPJobPartialWriteBecomesUncertain(t *testing.T) {
	connection := &partialWriteConn{}
	dialCount := 0
	manager := newTCPJobManagerWithDial(func(
		_ context.Context,
		_ string,
		_ int,
		_ time.Duration,
	) (net.Conn, string, error) {
		dialCount++
		return connection, "192.168.50.50", nil
	})
	defer manager.close()
	const owner = "test-owner"
	const jobID = "partial-write-test"
	_, err := manager.open(
		context.Background(),
		owner,
		jobID,
		"192.168.50.50",
		9100,
		time.Second,
		time.Second,
		time.Minute,
	)
	if err != nil {
		t.Fatalf("open failed: %v", err)
	}

	payload := []byte("payload")
	_, err = manager.append(owner, jobID, 1, payload, payloadDigest(payload))
	apiErr := requireAPIErrorCode(t, err, "TCP_JOB_WRITE_FAILED")
	if apiErr.JobState != "uncertain" ||
		apiErr.Outcome != "possibly_sent" ||
		apiErr.RetrySafety != "unsafe" ||
		apiErr.BytesWritten != 2 {
		t.Fatalf("partial write classification is unsafe: %+v", apiErr)
	}
	if !connection.closed {
		t.Fatal("uncertain session must close its printer socket")
	}

	_, err = manager.append(owner, jobID, 1, payload, payloadDigest(payload))
	apiErr = requireAPIErrorCode(t, err, "TCP_JOB_UNCERTAIN")
	if apiErr.Outcome != "possibly_sent" || apiErr.RetrySafety != "unsafe" {
		t.Fatalf("uncertain replay must remain blocked: %+v", apiErr)
	}
	_, err = manager.open(
		context.Background(), owner, jobID, "192.168.50.50", 9100,
		time.Second, time.Second, time.Minute,
	)
	apiErr = requireAPIErrorCode(t, err, "TCP_JOB_UNCERTAIN")
	if apiErr.Outcome != "possibly_sent" || apiErr.RetrySafety != "unsafe" {
		t.Fatalf("uncertain open replay must remain unsafe: %+v", apiErr)
	}

	_, err = manager.open(
		context.Background(),
		"other-owner",
		"replacement-job",
		"192.168.50.50",
		9100,
		time.Second,
		time.Second,
		time.Minute,
	)
	apiErr = requireAPIErrorCode(t, err, "TCP_JOB_TARGET_QUARANTINED")
	if apiErr.Outcome != "possibly_sent" ||
		apiErr.RetrySafety != "unsafe" ||
		apiErr.WriteStarted {
		t.Fatalf("quarantined target classification is unsafe: %+v", apiErr)
	}
	if dialCount != 1 {
		t.Fatalf("quarantined replacement opened a printer socket; dial count = %d", dialCount)
	}
}

func TestTCPJobExpiredCommittedTargetRemainsQuarantined(t *testing.T) {
	dialCount := 0
	manager := newTCPJobManagerWithDial(func(
		_ context.Context,
		_ string,
		_ int,
		_ time.Duration,
	) (net.Conn, string, error) {
		dialCount++
		client, server := net.Pipe()
		go func() {
			defer server.Close()
			_, _ = io.Copy(io.Discard, server)
		}()
		return client, "192.168.50.60", nil
	})
	defer manager.close()

	const owner = "expired-owner"
	const jobID = "expired-committed-job"
	if _, err := manager.open(
		context.Background(), owner, jobID, "printer-expired", 9100,
		time.Second, time.Second, time.Minute,
	); err != nil {
		t.Fatal(err)
	}
	payload := []byte("^XA^XZ")
	if _, err := manager.append(owner, jobID, 1, payload, payloadDigest(payload)); err != nil {
		t.Fatal(err)
	}

	session, err := manager.lookup(owner, jobID)
	if err != nil {
		t.Fatal(err)
	}
	session.mu.Lock()
	session.stopIdleTimerLocked()
	session.idleTimeout = time.Nanosecond
	session.lastActivity = time.Now().Add(-time.Second)
	session.mu.Unlock()
	session.expireIfIdle()
	_, err = manager.open(
		context.Background(), owner, jobID, "printer-expired", 9100,
		time.Second, time.Second, time.Minute,
	)
	apiErr := requireAPIErrorCode(t, err, "TCP_JOB_EXPIRED")
	if apiErr.Outcome != "possibly_sent" || apiErr.RetrySafety != "unsafe" {
		t.Fatalf("expired committed open replay must remain unsafe: %+v", apiErr)
	}

	_, err = manager.open(
		context.Background(), "replacement-owner", "replacement-expired-job",
		"printer-expired", 9100, time.Second, time.Second, time.Minute,
	)
	apiErr = requireAPIErrorCode(t, err, "TCP_JOB_TARGET_QUARANTINED")
	if apiErr.Outcome != "possibly_sent" || apiErr.RetrySafety != "unsafe" {
		t.Fatalf("expired committed target classification is unsafe: %+v", apiErr)
	}
	if dialCount != 1 {
		t.Fatalf("expired-target replacement opened a socket; dial count = %d", dialCount)
	}
}
