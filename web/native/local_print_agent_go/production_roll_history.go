package main

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type productionHistoryState struct {
	ClearedAt string `json:"clearedAt,omitempty"`
}

func readProductionHistoryState(root, owner, id string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(productionDirectory(root, owner, id), "history.json"))
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	var state productionHistoryState
	if err = json.Unmarshal(raw, &state); err != nil {
		return "", err
	}
	return state.ClearedAt, nil
}

// Caller holds admission and roll locks. Clearing is durable list management;
// evidence remains available to exports and cross-roll reconciliation.
func (m *tcpJobManager) updateProductionRollHistory(w http.ResponseWriter, owner string, ids []string, clear bool, active map[string]bool) error {
	if len(ids) == 0 || len(ids) > 10000 {
		return badRequest("Select between 1 and 10000 roll records.")
	}
	rolls := make([]productionRoll, 0, len(ids))
	seen := make(map[string]bool, len(ids))
	// Validate the entire selection before changing any manifest.
	for _, id := range ids {
		if id == "" || len(id) > 96 {
			return badRequest("Invalid rollId.")
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		roll, err := readProductionRoll(m.captureDir, owner, id)
		if err != nil {
			return err
		}
		roll.HistoryClearedAt, err = readProductionHistoryState(m.captureDir, owner, id)
		if err != nil {
			return err
		}
		if roll.State != "closed" && roll.State != "finalized" {
			return productionError("Close the roll before clearing its history.")
		}
		if active["roll:"+id] {
			return productionError("This roll still has an active print job.")
		}
		for _, run := range roll.Runs {
			if active[run.RunID] {
				return productionError("This roll still has an active print run.")
			}
		}
		rolls = append(rolls, roll)
	}
	now := time.Now().UTC().Format(time.RFC3339Nano)
	updated := make([]string, 0, len(rolls))
	for _, roll := range rolls {
		if (roll.HistoryClearedAt != "") != clear {
			roll.HistoryClearedAt = ""
			if clear {
				roll.HistoryClearedAt = now
			}
			// Display metadata is separate from the immutable roll/export revision.
			data, err := json.Marshal(productionHistoryState{ClearedAt: roll.HistoryClearedAt})
			if err != nil {
				return err
			}
			if err := writeRawSpoolAtomic(filepath.Join(productionDirectory(m.captureDir, owner, roll.RollID), "history.json"), data); err != nil {
				return err
			}
		}
		updated = append(updated, roll.RollID)
	}
	w.Header().Set("Content-Type", "application/json")
	return json.NewEncoder(w).Encode(map[string]any{"ok": true, "updatedRollIds": updated})
}
