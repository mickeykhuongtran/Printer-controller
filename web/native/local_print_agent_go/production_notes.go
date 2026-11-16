package main

import (
	"reflect"
	"strings"
	"time"
	"unicode/utf8"
)

func productionCSVPrinterIP(roll productionRoll) string {
	if roll.PrinterHost == "" {
		return "UNKNOWN"
	}
	return roll.PrinterHost
}

func productionNotesForRecord(notes []productionRowNote, id string) []string {
	var result []string
	for _, note := range notes {
		if !note.Incident {
			for _, key := range note.RecordIDs {
				if key == id {
					result = append(result, note.Text)
					break
				}
			}
		}
	}
	return result
}

// Notes are append-only annotations. Raw evidence and counter accounting never change.
func applyProductionNote(root, owner string, view *productionRollView, p productionRollRequest) error {
	p.Note = strings.TrimSpace(p.Note)
	if !validTCPJobID(p.NoteID) || p.Note == "" || utf8.RuneCountInString(p.Note) > 240 || strings.ContainsAny(p.Note, "\x00\r\n") || len(p.RecordIDs) > 500 {
		return badRequest("Enter a short note (1–240 characters) and a valid note ID.")
	}
	for _, old := range view.Roll.Notes {
		if old.ID == p.NoteID {
			if old.Text != p.Note || old.Incident != p.Incident || !reflect.DeepEqual(old.RecordIDs, p.RecordIDs) {
				return productionError("This note ID already has different content.")
			}
			return nil
		}
	}
	if view.Roll.State != "open" {
		return productionError("Notes must be applied before closing the roll; archived CSV is immutable.")
	}
	if len(p.RecordIDs) == 0 && !p.Incident {
		return badRequest("Select at least one saved row.")
	}
	existing := map[string]bool{}
	for _, row := range view.Rows {
		existing[row.RecordID] = true
	}
	for _, id := range p.RecordIDs {
		if !existing[id] {
			return productionError("A selected record does not belong to this roll. Reload before applying.")
		}
	}
	view.Roll.Notes = append(view.Roll.Notes, productionRowNote{ID: p.NoteID, Text: p.Note, RecordIDs: p.RecordIDs, Incident: p.Incident, At: time.Now().UTC().Format(time.RFC3339Nano)})
	view.Roll.Revision++
	if err := saveProductionRoll(root, owner, view.Roll); err != nil {
		return err
	}
	for i := range view.Rows {
		view.Rows[i].Notes = productionNotesForRecord(view.Roll.Notes, view.Rows[i].RecordID)
	}
	return nil
}
