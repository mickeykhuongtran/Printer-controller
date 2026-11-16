//go:build !windows

package main

func platformSpoolerAvailable() bool {
	return false
}

func listPlatformPrinters() ([]PrinterInfo, error) {
	// macOS and Linux use /v1/tcp/exchange. Returning an empty compatible list
	// lets the common UI remain usable without pretending a RAW spooler exists.
	return []PrinterInfo{}, nil
}

func printPlatformRaw(printerName, documentName string, payload []byte) (RawPrintResult, error) {
	return RawPrintResult{}, &apiError{
		Status:  501,
		Message: "Windows RAW printing is only available on Windows; use TCP/IP on this platform.",
	}
}

func printPlatformRawFile(printerName, documentName, filePath string, onStarted func(uint32) error) (RawPrintResult, error) {
	return printPlatformRaw(printerName, documentName, nil)
}

func inspectPlatformRawJob(printerName string, jobID uint32) (RawJobStatus, error) {
	return RawJobStatus{}, &apiError{Status: 501, Message: "Windows spooler job inspection is only available on Windows."}
}

func validatePlatformRawQueue(printerName string) error {
	return &apiError{Status: 501, Message: "Windows RAW queue validation is only available on Windows."}
}
