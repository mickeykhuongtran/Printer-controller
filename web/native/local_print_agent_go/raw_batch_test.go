package main

import (
	"context"
	"net/http"
	"testing"
	"time"
)

func TestRawBatchKeepsTargetLeaseAndDeduplicatesSequence(t *testing.T) {
	queues := newPrinterTargetQueue()
	manager := newRawBatchManager(queues)
	target := spoolPrinterTargetKey("ZDesigner ZT411")
	spoolCalls := 0
	spool := func(payloadBytes int) func() (RawPrintResult, error) {
		return func() (RawPrintResult, error) {
			spoolCalls++
			return RawPrintResult{OK: true, BytesWritten: payloadBytes}, nil
		}
	}

	first, err := manager.submit(
		context.Background(),
		"batch_test_0001",
		target,
		"ZDesigner ZT411",
		1,
		false,
		[]byte("^XA^PQ25^XZ"),
		spool(12),
	)
	if err != nil {
		t.Fatalf("submit first RAW checkpoint: %v", err)
	}
	if first.BatchState != "open" || first.NextSequence != 2 {
		t.Fatalf("unexpected first receipt: %+v", first)
	}

	waitContext, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := queues.acquire(waitContext, target); err == nil {
		t.Fatal("another operation acquired the target before the RAW batch finished")
	}

	deduplicated, err := manager.submit(
		context.Background(),
		"batch_test_0001",
		target,
		"ZDesigner ZT411",
		1,
		false,
		[]byte("^XA^PQ25^XZ"),
		spool(12),
	)
	if err != nil {
		t.Fatalf("replay first RAW checkpoint: %v", err)
	}
	if !deduplicated.Deduplicated || spoolCalls != 1 {
		t.Fatalf("replayed checkpoint was spooled again: receipt=%+v calls=%d", deduplicated, spoolCalls)
	}

	finished, err := manager.submit(
		context.Background(),
		"batch_test_0001",
		target,
		"ZDesigner ZT411",
		2,
		true,
		[]byte("^XA^PQ25^XZ"),
		spool(12),
	)
	if err != nil {
		t.Fatalf("finish RAW batch: %v", err)
	}
	if finished.BatchState != "finished" || spoolCalls != 2 {
		t.Fatalf("unexpected final receipt: %+v calls=%d", finished, spoolCalls)
	}

	release, err := queues.acquire(context.Background(), target)
	if err != nil {
		t.Fatalf("target lease was not released after final checkpoint: %v", err)
	}
	release()
}

func TestRawBatchQuarantinesTargetAfterPossiblySentFailure(t *testing.T) {
	queues := newPrinterTargetQueue()
	manager := newRawBatchManager(queues)
	target := spoolPrinterTargetKey("ZDesigner ZT411")

	_, err := manager.submit(
		context.Background(),
		"batch_test_0002",
		target,
		"ZDesigner ZT411",
		1,
		false,
		[]byte("^XA^GFpartial"),
		func() (RawPrintResult, error) {
			return RawPrintResult{}, &apiError{
				Status:       http.StatusBadGateway,
				Code:         "RAW_WRITE_FAILED",
				Message:      "partial write",
				Outcome:      "possibly_sent",
				WriteStarted: true,
			}
		},
	)
	if err == nil {
		t.Fatal("expected ambiguous RAW write failure")
	}

	waitContext, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := queues.acquire(waitContext, target); err == nil {
		t.Fatal("uncertain RAW target was released without a reconciliation window")
	}
	open, uncertain, _ := manager.stats()
	if open != 0 || uncertain != 1 {
		t.Fatalf("unexpected RAW batch stats: open=%d uncertain=%d", open, uncertain)
	}
}
