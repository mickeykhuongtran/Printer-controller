package main

import "io"

// The operator uploads a standard CSV directly. CSV has no password feature;
// the archived original and its SHA-256 receipt remain in the local ledger.
func productionExportExtension() string   { return ".csv" }
func productionExportContentType() string { return "text/csv; charset=utf-8" }

func writeProductionExport(output io.Writer, view productionRollView, provisional bool) error {
	return writeProductionCSV(output, view, provisional)
}
