package main

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestPrinterTargetQueueSerializesSameTarget(t *testing.T) {
	queue := newPrinterTargetQueue()
	var active int32
	var maximum int32
	var completed int32
	start := make(chan struct{})
	var group sync.WaitGroup

	for index := 0; index < 100; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			<-start
			release, err := queue.acquire(context.Background(), "tcp:printer-a:9100")
			if err != nil {
				t.Errorf("acquire: %v", err)
				return
			}
			current := atomic.AddInt32(&active, 1)
			for {
				observed := atomic.LoadInt32(&maximum)
				if current <= observed || atomic.CompareAndSwapInt32(&maximum, observed, current) {
					break
				}
			}
			time.Sleep(100 * time.Microsecond)
			atomic.AddInt32(&active, -1)
			atomic.AddInt32(&completed, 1)
			release()
		}()
	}
	close(start)
	group.Wait()

	if got := atomic.LoadInt32(&maximum); got != 1 {
		t.Fatalf("maximum same-target concurrency = %d, want 1", got)
	}
	if got := atomic.LoadInt32(&completed); got != 100 {
		t.Fatalf("completed = %d, want 100", got)
	}
	targets, activeCount, waiting := queue.stats()
	if targets != 0 || activeCount != 0 || waiting != 0 {
		t.Fatalf("queue leaked state: targets=%d active=%d waiting=%d", targets, activeCount, waiting)
	}
}

func TestPrinterTargetQueueKeepsDifferentTargetsParallel(t *testing.T) {
	queue := newPrinterTargetQueue()
	releaseA, err := queue.acquire(context.Background(), "tcp:printer-a:9100")
	if err != nil {
		t.Fatal(err)
	}
	defer releaseA()

	acquiredB := make(chan func(), 1)
	go func() {
		releaseB, acquireErr := queue.acquire(context.Background(), "tcp:printer-b:9100")
		if acquireErr == nil {
			acquiredB <- releaseB
		}
	}()

	select {
	case releaseB := <-acquiredB:
		releaseB()
	case <-time.After(time.Second):
		t.Fatal("different printer was incorrectly blocked")
	}
}

func TestPrinterTargetQueueCancellationIsNotSent(t *testing.T) {
	queue := newPrinterTargetQueue()
	release, err := queue.acquire(context.Background(), "winspool:zebra")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := queue.acquire(ctx, "winspool:zebra"); err == nil {
		t.Fatal("cancelled waiter unexpectedly acquired printer")
	}
	release()
}
