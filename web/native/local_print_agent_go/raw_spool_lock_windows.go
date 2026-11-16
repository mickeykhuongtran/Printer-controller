//go:build windows

package main

import (
	"fmt"
	"syscall"
)

// Zero sharing grants one process ownership. Windows releases the handle on
// a crash, so the durable manifests remain recoverable without a stale lock.
func lockRawSpoolStore(path string) (func() error, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, fmt.Errorf("RAW spool state is locked/unavailable: %w", err)
	}
	return func() error { return syscall.CloseHandle(handle) }, nil
}
