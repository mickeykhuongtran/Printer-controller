package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTCPFailureBeforeWriteIsSafeToRetry(t *testing.T) {
	err := tcpFailure(
		http.StatusGatewayTimeout,
		"connect timeout",
		"TCP_CONNECT_TIMEOUT",
		"connect",
		0,
		false,
		false,
	)
	var apiErr *apiError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type = %T, want *apiError", err)
	}
	if apiErr.Outcome != "not_sent" ||
		apiErr.RetrySafety != "safe" ||
		apiErr.BytesWritten != 0 ||
		apiErr.WriteStarted ||
		apiErr.WriteCompleted {
		t.Fatalf("unexpected pre-write metadata: %+v", apiErr)
	}
}

func TestTCPFailureAfterWriteStartsIsNeverSafeToRetry(t *testing.T) {
	err := tcpFailure(
		http.StatusGatewayTimeout,
		"write timeout",
		"TCP_WRITE_TIMEOUT",
		"write",
		32768,
		true,
		false,
	)
	var apiErr *apiError
	if !errors.As(err, &apiErr) {
		t.Fatalf("error type = %T, want *apiError", err)
	}
	if apiErr.Outcome != "possibly_sent" ||
		apiErr.RetrySafety != "unsafe" ||
		apiErr.BytesWritten != 32768 ||
		!apiErr.WriteStarted ||
		apiErr.WriteCompleted {
		t.Fatalf("unexpected partial-write metadata: %+v", apiErr)
	}
}

func TestTCPFailureMetadataIsSerialized(t *testing.T) {
	server, _ := testServer(t)
	recorder := httptest.NewRecorder()
	server.writeError(recorder, tcpFailure(
		http.StatusBadGateway,
		"connect failed",
		"TCP_CONNECT_FAILED",
		"connect",
		0,
		false,
		false,
	))
	if recorder.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", recorder.Code, http.StatusBadGateway)
	}
	var payload struct {
		OK             bool   `json:"ok"`
		Code           string `json:"code"`
		Stage          string `json:"stage"`
		Outcome        string `json:"outcome"`
		RetrySafety    string `json:"retrySafety"`
		BytesWritten   int    `json:"bytesWritten"`
		WriteStarted   bool   `json:"writeStarted"`
		WriteCompleted bool   `json:"writeCompleted"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.OK ||
		payload.Code != "TCP_CONNECT_FAILED" ||
		payload.Stage != "connect" ||
		payload.Outcome != "not_sent" ||
		payload.RetrySafety != "safe" ||
		payload.BytesWritten != 0 ||
		payload.WriteStarted ||
		payload.WriteCompleted {
		t.Fatalf("unexpected JSON metadata: %+v", payload)
	}
}
