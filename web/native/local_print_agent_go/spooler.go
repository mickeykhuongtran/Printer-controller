package main

import (
	"strings"
)

type PrinterInfo struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Comment     string `json:"comment"`
	PortName    string `json:"portName"`
	DriverName  string `json:"driverName"`
	IsDefault   bool   `json:"isDefault"`
}

type RawPrintResult struct {
	OK            bool    `json:"ok"`
	PrinterName   string  `json:"printerName"`
	DocumentName  string  `json:"documentName"`
	JobID         *uint32 `json:"jobId"`
	BytesWritten  int     `json:"bytesWritten"`
	PortName      string  `json:"portName"`
	DriverName    string  `json:"driverName"`
	Warning       string  `json:"warning"`
	BatchID       string  `json:"batchId,omitempty"`
	Sequence      int     `json:"sequence,omitempty"`
	NextSequence  int     `json:"nextSequence,omitempty"`
	BatchState    string  `json:"batchState,omitempty"`
	FinalChunk    bool    `json:"finalChunk"`
	Deduplicated  bool    `json:"deduplicated,omitempty"`
	PayloadSHA256 string  `json:"payloadSha256,omitempty"`
}

// RawJobStatus describes Windows spooler telemetry only. A missing job, a
// printed/complete flag, and PagesPrinted are not physical label/EPC receipts.
type RawJobStatus struct {
	JobID                       uint32 `json:"jobId"`
	Exists                      bool   `json:"exists"`
	PrinterName                 string `json:"printerName"`
	DocumentName                string `json:"documentName"`
	Status                      uint32 `json:"status"`
	StatusText                  string `json:"statusText"`
	State                       string `json:"state"`
	PagesPrinted                uint32 `json:"pagesPrinted"`
	TotalPages                  uint32 `json:"totalPages"`
	PhysicalCompletionConfirmed bool   `json:"physicalCompletionConfirmed"`
}

func cleanText(value, fallback string, maximum int, collapseWhitespace bool) string {
	value = strings.TrimSpace(value)
	if collapseWhitespace {
		value = strings.Join(strings.Fields(value), " ")
	}
	if value == "" {
		value = fallback
	}
	runes := []rune(value)
	if len(runes) > maximum {
		value = string(runes[:maximum])
	}
	return value
}

func rawZPLWarning(printer *PrinterInfo) string {
	if printer == nil {
		return ""
	}
	name := strings.ToLower(printer.Name)
	driver := strings.ToLower(printer.DriverName)
	port := strings.ToUpper(printer.PortName)
	switch {
	case strings.Contains(name, "(redirected") ||
		strings.Contains(driver, "remote desktop easy print") ||
		strings.HasPrefix(port, "TS"):
		return "Remote Desktop redirected printer queue; RAW ZPL may not reach the physical Zebra printer."
	case strings.Contains(name, "pdf") ||
		strings.Contains(name, "onenote") ||
		strings.Contains(driver, "pdf") ||
		strings.Contains(driver, "xps") ||
		strings.Contains(driver, "ipp class"):
		return "Printer queue is not a raw Zebra queue."
	case !strings.Contains(name, "zebra") &&
		!strings.Contains(driver, "zebra") &&
		!strings.Contains(driver, "zdesigner") &&
		!strings.Contains(driver, "seagull"):
		return "Printer queue does not look like Zebra/ZDesigner/Seagull."
	default:
		return ""
	}
}

func isTrustedZebraQueue(printer *PrinterInfo) bool {
	if printer == nil {
		return false
	}
	name := strings.ToLower(printer.Name)
	driver := strings.ToLower(printer.DriverName)
	port := strings.ToUpper(printer.PortName)
	if strings.Contains(name, "(redirected") ||
		strings.Contains(driver, "remote desktop easy print") ||
		strings.HasPrefix(port, "TS") ||
		strings.Contains(name, "pdf") ||
		strings.Contains(name, "onenote") ||
		strings.Contains(driver, "pdf") ||
		strings.Contains(driver, "xps") ||
		strings.Contains(driver, "ipp class") {
		return false
	}
	return strings.Contains(name, "zebra") ||
		strings.Contains(driver, "zebra") ||
		strings.Contains(driver, "zdesigner") ||
		strings.Contains(driver, "seagull")
}
