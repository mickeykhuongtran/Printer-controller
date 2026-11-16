package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestProductionHistoryClearRestorePersistsAndPreservesEvidence(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	m.captureDir = t.TempDir()
	roll := createProductionTestRoll(t, m, 2)
	productionTestRun(t, m, roll, "history-evidence", 2, 0, 2, nil, 0, "finished")
	closeProductionTestRoll(t, m, roll)
	_, export, err := productionCall(t, m, "owner", "roll-export", productionExportRequest(roll))
	if err != nil {
		t.Fatal(err)
	}
	rawPath := filepath.Join(captureDirectory(m.captureDir, "owner", "history-evidence"), "reads.csv")
	raw, err := os.ReadFile(rawPath)
	if err != nil {
		t.Fatal(err)
	}
	ids := productionRollRequest{RollIDs: []string{roll.RollID, roll.RollID}}
	if _, _, err = productionCall(t, m, "owner", "roll-history-clear", ids); err != nil {
		t.Fatal(err)
	}
	cleared, err := readProductionHistoryState(m.captureDir, "owner", roll.RollID)
	if err != nil || cleared == "" {
		t.Fatalf("clear not durable: %+v %v", cleared, err)
	}
	if _, _, err = productionCall(t, m, "owner", "roll-history-clear", ids); err != nil {
		t.Fatal(err)
	}
	again, _ := readProductionHistoryState(m.captureDir, "owner", roll.RollID)
	if again != cleared {
		t.Fatal("clear retry mutated history")
	}
	restarted := newTCPJobManager()
	defer restarted.close()
	restarted.captureDir = m.captureDir
	listed, err := listProductionRolls(restarted.captureDir, "owner")
	if err != nil || len(listed) != 1 || listed[0].HistoryClearedAt == "" {
		t.Fatal("clear lost after restart", err)
	}
	_, download, err := productionCall(t, restarted, "owner", "roll-export", productionRollRequest{RollID: roll.RollID})
	if err != nil || !bytes.Equal(export.Body.Bytes(), download.Body.Bytes()) {
		t.Fatal("clear changed CSV", err)
	}
	if _, _, err = productionCall(t, restarted, "owner", "roll-history-restore", ids); err != nil {
		t.Fatal(err)
	}
	restored, _ := readProductionHistoryState(m.captureDir, "owner", roll.RollID)
	if restored != "" {
		t.Fatal("restore changed lifecycle")
	}
	after, err := os.ReadFile(rawPath)
	if err != nil || !bytes.Equal(raw, after) {
		t.Fatal("clear/restore changed raw EPC evidence", err)
	}
}

func TestProductionHistoryClearRejectsOpenForeignAndInvalidBatch(t *testing.T) {
	m := newTCPJobManager()
	defer m.close()
	m.captureDir = t.TempDir()
	closed := createProductionTestRoll(t, m, 1)
	closeProductionTestRoll(t, m, closed)
	open := createProductionTestRoll(t, m, 1)
	for _, ids := range [][]string{nil, {closed.RollID, open.RollID}, {closed.RollID, "missing"}, {"../outside"}} {
		if _, _, err := productionCall(t, m, "owner", "roll-history-clear", productionRollRequest{RollIDs: ids}); err == nil {
			t.Fatalf("accepted invalid batch: %v", ids)
		}
		stored, _ := readProductionHistoryState(m.captureDir, "owner", closed.RollID)
		if stored != "" {
			t.Fatal("partially cleared a rejected selection")
		}
	}
	if _, _, err := productionCall(t, m, "other", "roll-history-clear", productionRollRequest{RollIDs: []string{closed.RollID}}); err == nil {
		t.Fatal("another owner cleared history")
	}
	if _, _, err := productionCall(t, m, "owner", "roll-history-clear", productionRollRequest{RollIDs: []string{closed.RollID}}); err != nil {
		t.Fatal(err)
	}
	stored, _ := readProductionRoll(m.captureDir, "owner", open.RollID)
	if stored.HistoryClearedAt != "" || stored.State != "open" {
		t.Fatal("clear changed the open roll")
	}
}
