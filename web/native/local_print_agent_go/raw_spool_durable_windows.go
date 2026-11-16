//go:build windows

package main

import (
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var procRawSpoolMoveFileExW = syscall.NewLazyDLL("kernel32.dll").NewProc("MoveFileExW")

// Callers sync and close the temporary file first. WRITE_THROUGH waits for the
// move to reach the disk instead of using os.Rename's unflushed metadata move.
func durableReplaceRawSpoolFile(source, destination string) error {
	from, err := rawSpoolWindowsPath(source)
	if err != nil {
		return err
	}
	to, err := rawSpoolWindowsPath(destination)
	if err != nil {
		return err
	}
	const movefileReplaceExisting = 0x1
	const movefileWriteThrough = 0x8
	// A concurrent history reader or scanner can briefly hold the destination
	// without FILE_SHARE_DELETE. Retry only the atomic rename of the same
	// already-synced file; never repeat printer payloads or discard old evidence.
	deadline := time.Now().Add(500 * time.Millisecond)
	delay := 2 * time.Millisecond
	for {
		result, _, callErr := procRawSpoolMoveFileExW.Call(uintptr(unsafe.Pointer(from)), uintptr(unsafe.Pointer(to)), movefileReplaceExisting|movefileWriteThrough)
		if result != 0 {
			return nil
		}
		transient := callErr == syscall.ERROR_ACCESS_DENIED || callErr == syscall.Errno(32) || callErr == syscall.Errno(33)
		if !transient || !time.Now().Add(delay).Before(deadline) {
			return windowsCallError("MoveFileExW durable RAW spool replace", callErr)
		}
		time.Sleep(delay)
		delay = min(delay*2, 32*time.Millisecond)
	}
}

func rawSpoolWindowsPath(path string) (*uint16, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	// Batch IDs plus the per-user data path can exceed legacy MAX_PATH.
	if !strings.HasPrefix(abs, `\\?\`) {
		if strings.HasPrefix(abs, `\\`) {
			abs = `\\?\UNC\` + strings.TrimPrefix(abs, `\\`)
		} else {
			abs = `\\?\` + abs
		}
	}
	return syscall.UTF16PtrFromString(abs)
}

func syncRawSpoolDirectory(dir string) error {
	name, err := rawSpoolWindowsPath(dir)
	if err != nil {
		return err
	}
	// Directory handles need BACKUP_SEMANTICS. FlushFileBuffers requires write
	// access; a read-only os.Open directory handle cannot establish this barrier.
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return fmt.Errorf("open RAW spool directory for metadata flush: %w", err)
	}
	defer syscall.CloseHandle(handle)
	if err = syscall.FlushFileBuffers(handle); err != nil {
		return fmt.Errorf("flush RAW spool directory metadata: %w", err)
	}
	return nil
}
