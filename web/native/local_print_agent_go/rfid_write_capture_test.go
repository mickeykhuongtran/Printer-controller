package main

import (
	"encoding/csv"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteCaptureRequiresMatchingEvidenceAndPersistsExpectedBytes(t *testing.T) {
	for _, mode := range []string{"write", "read_write"} {
		t.Run(mode, func(t *testing.T) {
			c, err := newRfidCapture(t.TempDir(), "owner", "verified-write-job", "printer", 9100,
				rfidCaptureOptions{OperationMode: mode, Bank: "EPC", ExpectedLabels: 5, FirstRow: 20, RowStep: 1})
			if err != nil {
				t.Fatal(err)
			}
			defer c.file.Close()
			frames := []string{
				"1|W|0001|0001", // exact match, including leading zeros
				"2|W|0002|0003", // readable tag with wrong contents is not write success
				"3|0003",        // legacy read-only proof cannot prove a write
				"4|W|0004|",     // physical VOID may return no data
				"5|W|0001|0001", // matching duplicated EPC kept with warning
			}
			for _, frame := range frames {
				c.feed([]byte("NWEP|verified-write-job|" + frame + "|END\r\n"))
			}
			got := c.snapshot()
			if got.UniqueLabels != 2 || got.InvalidReads != 3 || got.Received != 5 || got.Issues != 3 {
				t.Fatalf("incorrect verified totals: %+v", got)
			}
			data, err := os.ReadFile(filepath.Join(c.dir, "reads.csv"))
			if err != nil {
				t.Fatal(err)
			}
			rows, err := csv.NewReader(strings.NewReader(string(data))).ReadAll()
			if err != nil {
				t.Fatal(err)
			}
			if len(rows[0]) != 8 || rows[0][7] != "expected_hex" || rows[2][7] != "0002" || rows[2][4] != "0003" || rows[2][6] != "write_mismatch" || rows[3][6] != "write_unverified" {
				t.Fatalf("write evidence lost: %s", data)
			}
			for i := 1; i < len(rows); i++ {
				want := i == 1 || i == 5
				if validProductionRead(rows[i], *got) != want {
					t.Fatalf("row%d verified incorrectly: %v", i, rows[i])
				}
			}
		})
	}
}

func TestWriteFrameCannotMasqueradeAsReadAndModeValidation(t *testing.T) {
	c, err := newRfidCapture(t.TempDir(), "owner", "read-mode-only", "printer", 9100,
		rfidCaptureOptions{Bank: "EPC", ExpectedLabels: 1, FirstRow: 1, RowStep: 1})
	if err != nil {
		t.Fatal(err)
	}
	defer c.file.Close()
	c.feed([]byte("NWEP|read-mode-only|1|W|0011|0011|END\r\n"))
	if got := c.snapshot(); got.UniqueLabels != 0 || got.Issues != 1 {
		t.Fatalf("mixed operation accepted: %+v", got)
	}
	o := rfidCaptureOptions{OperationMode: "write", Bank: "TID", ExpectedLabels: 1, FirstRow: 1, RowStep: 1}
	if validateCaptureOptions(&o) == nil {
		t.Fatal("write verification accepted TID")
	}
}
