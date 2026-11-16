//go:build windows

package main

import (
	"syscall"
	"testing"
	"unsafe"
)

func TestRawWindowsNativeLayouts(t *testing.T) {
	// Winspool returns native structs containing pointers; a packing error would
	// misread queue settings or job status. The packaged targets are 64-bit.
	if unsafe.Sizeof(uintptr(0)) != 8 {
		t.Skip("desktop distribution uses Windows amd64/arm64")
	}
	if unsafe.Sizeof(printerInfo2W{}) != 136 || unsafe.Offsetof(printerInfo2W{}.Attributes) != 104 {
		t.Fatal("PRINTER_INFO_2W native layout mismatch")
	}
	if unsafe.Sizeof(jobInfo1W{}) != 96 || unsafe.Offsetof(jobInfo1W{}.Status) != 56 || unsafe.Offsetof(jobInfo1W{}.Submitted) != 76 {
		t.Fatal("JOB_INFO_1W native layout mismatch")
	}
}

func TestRawWindowsMissingJobIsDistinctFromInspectionFailure(t *testing.T) {
	for _, code := range []syscall.Errno{87, 2, 1168} {
		if !rawJobMissingError(code) {
			t.Fatalf("missing job error %d was not recognized", code)
		}
	}
	for _, code := range []syscall.Errno{0, 5, 6, 122, 1722} {
		if rawJobMissingError(code) {
			t.Fatalf("real inspection failure %d was mistaken for an absent job", code)
		}
	}
}
