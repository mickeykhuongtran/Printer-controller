//go:build windows

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func TestDurableReplaceSurvivesTransientReaderAndPreservesLockedEvidence(t *testing.T) {
	for _, release := range []bool{true, false} {
		t.Run(map[bool]string{true: "temporary_reader", false: "persistent_lock"}[release], func(t *testing.T) {
			dir := t.TempDir()
			destination := filepath.Join(dir, "manifest.json")
			if err := os.WriteFile(destination, []byte("previous durable evidence"), 0600); err != nil {
				t.Fatal(err)
			}
			name, err := syscall.UTF16PtrFromString(destination)
			if err != nil {
				t.Fatal(err)
			}
			handle, err := syscall.CreateFile(name, syscall.GENERIC_READ, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE, nil, syscall.OPEN_EXISTING, 0, 0)
			if err != nil {
				t.Fatal(err)
			}
			closed := make(chan struct{})
			if release {
				go func() { time.Sleep(60 * time.Millisecond); syscall.CloseHandle(handle); close(closed) }()
			}
			started := time.Now()
			err = writeRawSpoolAtomic(destination, []byte("new durable evidence"))
			if release {
				<-closed
			} else {
				syscall.CloseHandle(handle)
			}
			if time.Since(started) > 2*time.Second {
				t.Fatal("replace retry was not bounded")
			}
			data, readErr := os.ReadFile(destination)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if release && (err != nil || string(data) != "new durable evidence") {
				t.Fatal("temporary read lock interrupted capture", err, string(data))
			}
			if !release && (err == nil || string(data) != "previous durable evidence") {
				t.Fatal("persistent failure did not preserve old evidence", err, string(data))
			}
		})
	}
}
