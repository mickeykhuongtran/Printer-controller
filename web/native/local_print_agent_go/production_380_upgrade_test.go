package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRollNotesStableRowsIPAndImmutableArchive(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	defer m.close()
	roll := createProductionTestRoll(t, m, 3)
	productionTestRun(t, m, roll, "notes-run-01", 3, 0, 3, nil, 0, "finished")
	view, _, err := productionCall(t, m, "owner", "roll-get", productionRollRequest{RollID: roll.RollID})
	if err != nil {
		t.Fatal(err)
	}
	id := view.Rows[1].RecordID
	note := productionRollRequest{RollID: roll.RollID, NoteID: "note-unique-01", RecordIDs: []string{id}, Note: "Đã kiểm tra, giữ lại"}
	after, _, err := productionCall(t, m, "owner", "roll-note", note)
	if err != nil {
		t.Fatal(err)
	}
	retry, _, err := productionCall(t, m, "owner", "roll-note", note)
	if err != nil || len(retry.Roll.Notes) != 1 || retry.Roll.Revision != after.Roll.Revision {
		t.Fatal("note retry changed evidence", err)
	}
	if retry.Summary.ValidCount != view.Summary.ValidCount || retry.Summary.VoidCount != view.Summary.VoidCount || retry.Rows[1].EPC != view.Rows[1].EPC {
		t.Fatal("note altered counters or EPC")
	}
	invalid := note
	invalid.NoteID = "note-invalid-id"
	invalid.RecordIDs = []string{"other-run:2"}
	if _, _, err = productionCall(t, m, "owner", "roll-note", invalid); err == nil {
		t.Fatal("cross-roll annotation accepted")
	}
	incident := note
	incident.NoteID = "incident-unique"
	incident.Incident = true
	incident.Note = "Chỉnh giấy; mất khoảng 2 tem, chưa xác định EPC"
	if _, _, err = productionCall(t, m, "owner", "roll-note", incident); err != nil {
		t.Fatal(err)
	}
	closeProductionTestRoll(t, m, roll)
	_, w, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	csv := w.Body.Bytes()
	if !strings.Contains(string(csv), "printer_ip,192.0.2.1") || !strings.Contains(string(csv), "note=Đã kiểm tra") || !strings.Contains(string(csv), "INCIDENT") {
		t.Fatal("CSV missing IP/notes/incident", string(csv))
	}
	productionCSVRows(t, csv)
	if _, _, err := productionCall(t, m, "owner", "roll-note", productionRollRequest{RollID: roll.RollID, NoteID: "late-note-01", Note: "Late mutation", RecordIDs: []string{id}}); err == nil {
		t.Fatal("archived note accepted")
	}
	_, again, err := productionCall(t, m, "owner", "roll-export", productionRollRequest{RollID: roll.RollID})
	if err != nil || !bytes.Equal(csv, again.Body.Bytes()) {
		t.Fatal("archived bytes changed", err)
	}
	raw, err := os.ReadFile(filepath.Join(captureDirectory(m.captureDir, "owner", "notes-run-01"), "reads.csv"))
	if err != nil || bytes.Contains(raw, []byte("Đã kiểm tra")) {
		t.Fatal("raw evidence rewritten")
	}
}

func TestRollTemplateRevisionKeepsEarlierIdentity(t *testing.T) {
	m := newTCPJobManager()
	m.captureDir = t.TempDir()
	defer m.close()
	roll := createProductionTestRoll(t, m, 1)
	productionTestRun(t, m, roll, "revision-old", 1, 0, 1, nil, 0, "finished")
	snapshot := `{"speed":4,"darkness":12,"x":0.5}`
	fingerprint := payloadDigest([]byte(snapshot))
	_, _, err := productionCall(t, m, "owner", "roll-create", productionRollRequest{RollID: roll.RollID, PrinterHost: "192.0.2.1", PrinterPort: 9100, OperationMode: "read", Bank: "EPC", TemplateFingerprint: fingerprint, AllowTemplateRevision: true})
	if err != nil {
		t.Fatal(err)
	}
	c, err := newRfidCapture(m.captureDir, "owner", "revision-new", "192.0.2.1", 9100, rfidCaptureOptions{ProductionRollID: roll.RollID, TemplateFingerprint: fingerprint, ConfigurationSnapshot: snapshot, AllowTemplateRevision: true, ExpectedLabels: 1, FirstRow: 1, RowStep: 1, Bank: "EPC"})
	if err != nil {
		t.Fatal(err)
	}
	c.feed([]byte("NWEP|revision-new|1|AABBCCDD|END\r\n"))
	close(c.done)
	if err := c.close(nil, "finished"); err != nil {
		t.Fatal(err)
	}
	saved, err := readProductionRoll(m.captureDir, "owner", roll.RollID)
	if err != nil {
		t.Fatal(err)
	}
	if len(saved.Runs) != 2 || saved.TemplateFingerprint != productionTestFingerprint || saved.Runs[0].TemplateFingerprint != productionTestFingerprint || saved.Runs[1].TemplateFingerprint != fingerprint || saved.Runs[1].ConfigurationRevision != 2 {
		t.Fatal("revision lost old identity", saved)
	}
	options := c.summary.Options
	options.ConfigurationSnapshot = `{"speed":9}`
	if err := validateCaptureOptions(&options); err == nil {
		t.Fatal("mutated snapshot accepted")
	}
	_, _, err = productionCall(t, m, "owner", "roll-create", productionRollRequest{RollID: roll.RollID, PrinterHost: "192.0.2.2", PrinterPort: 9100, OperationMode: "read", Bank: "EPC", TemplateFingerprint: fingerprint, AllowTemplateRevision: true})
	if err == nil {
		t.Fatal("revision moved roll to different printer")
	}
}
