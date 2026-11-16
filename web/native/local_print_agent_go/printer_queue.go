package main

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
)

const maxQueuedOperationsPerPrinter = 2048

type printerQueueReservation struct {
	queue    *printerTargetQueue
	key      string
	ready    chan struct{}
	released bool
}

// Admission order is fixed under the mutex, before a goroutine starts waiting.
// Staged RAW batches reserve a place before rendering/upload begins.
type printerTargetQueue struct {
	mu      sync.Mutex
	entries map[string][]*printerQueueReservation
}

func newPrinterTargetQueue() *printerTargetQueue {
	return &printerTargetQueue{entries: make(map[string][]*printerQueueReservation)}
}

func tcpPrinterTargetKey(host string, port int) string {
	return fmt.Sprintf("tcp:%s:%d", strings.ToLower(strings.TrimSpace(host)), port)
}

func spoolPrinterTargetKey(printerName string) string {
	return "winspool:" + strings.ToLower(strings.TrimSpace(printerName))
}

func (q *printerTargetQueue) reserve(key string) (*printerQueueReservation, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.entries[key]) >= maxQueuedOperationsPerPrinter {
		return nil, &apiError{Status: http.StatusTooManyRequests, Code: "PRINTER_QUEUE_FULL", Message: fmt.Sprintf("Printer queue is full (%d operations); retry after it drains.", maxQueuedOperationsPerPrinter)}
	}
	r := &printerQueueReservation{queue: q, key: key, ready: make(chan struct{})}
	q.entries[key] = append(q.entries[key], r)
	if len(q.entries[key]) == 1 {
		close(r.ready)
	}
	return r, nil
}

func (r *printerQueueReservation) release() {
	q := r.queue
	q.mu.Lock()
	defer q.mu.Unlock()
	if r.released {
		return
	}
	r.released = true
	entries := q.entries[r.key]
	for i, candidate := range entries {
		if candidate != r {
			continue
		}
		if i > 0 {
			close(r.ready)
		}
		entries = append(entries[:i], entries[i+1:]...)
		if len(entries) == 0 {
			delete(q.entries, r.key)
		} else {
			q.entries[r.key] = entries
			if i == 0 {
				close(entries[0].ready)
			}
		}
		return
	}
}

func (q *printerTargetQueue) acquire(ctx context.Context, key string) (func(), error) {
	if ctx.Err() != nil {
		return nil, printerQueueCancelled()
	}
	r, err := q.reserve(key)
	if err != nil {
		return nil, err
	}
	select {
	case <-r.ready:
		if ctx.Err() == nil {
			return r.release, nil
		}
	case <-ctx.Done():
	}
	r.release()
	return nil, printerQueueCancelled()
}

func printerQueueCancelled() error {
	return &apiError{Status: http.StatusRequestTimeout, Code: "PRINTER_QUEUE_WAIT_CANCELLED", Message: "Printer queue wait was cancelled before any bytes were sent."}
}

func (q *printerTargetQueue) stats() (targets, active, waiting int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	targets = len(q.entries)
	for _, entries := range q.entries {
		if len(entries) > 0 {
			active++
			waiting += len(entries) - 1
		}
	}
	return
}
