//go:build windows

package main

import (
	"fmt"
	"os"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"unsafe"
)

const (
	printerEnumLocal        = 0x00000002
	printerEnumConnections  = 0x00000004
	errorInsufficientBuffer = syscall.Errno(122)
)

var (
	winspoolDLL            = syscall.NewLazyDLL("winspool.drv")
	procEnumPrintersW      = winspoolDLL.NewProc("EnumPrintersW")
	procGetDefaultPrinterW = winspoolDLL.NewProc("GetDefaultPrinterW")
	procGetPrinterW        = winspoolDLL.NewProc("GetPrinterW")
	procGetJobW            = winspoolDLL.NewProc("GetJobW")
	procOpenPrinterW       = winspoolDLL.NewProc("OpenPrinterW")
	procClosePrinter       = winspoolDLL.NewProc("ClosePrinter")
	procAbortPrinter       = winspoolDLL.NewProc("AbortPrinter")
	procStartDocPrinterW   = winspoolDLL.NewProc("StartDocPrinterW")
	procEndDocPrinter      = winspoolDLL.NewProc("EndDocPrinter")
	procStartPagePrinter   = winspoolDLL.NewProc("StartPagePrinter")
	procEndPagePrinter     = winspoolDLL.NewProc("EndPagePrinter")
	procWritePrinter       = winspoolDLL.NewProc("WritePrinter")
)

type printerInfo2W struct {
	ServerName         *uint16
	PrinterName        *uint16
	ShareName          *uint16
	PortName           *uint16
	DriverName         *uint16
	Comment            *uint16
	Location           *uint16
	DevMode            unsafe.Pointer
	SepFile            *uint16
	PrintProcessor     *uint16
	Datatype           *uint16
	Parameters         *uint16
	SecurityDescriptor unsafe.Pointer
	Attributes         uint32
	Priority           uint32
	DefaultPriority    uint32
	StartTime          uint32
	UntilTime          uint32
	Status             uint32
	Jobs               uint32
	AveragePPM         uint32
}

type docInfo1W struct {
	DocName    *uint16
	OutputFile *uint16
	Datatype   *uint16
}

type jobInfo1W struct {
	JobID        uint32
	PrinterName  *uint16
	MachineName  *uint16
	UserName     *uint16
	Document     *uint16
	Datatype     *uint16
	StatusText   *uint16
	Status       uint32
	Priority     uint32
	Position     uint32
	TotalPages   uint32
	PagesPrinted uint32
	Submitted    [8]uint16 // SYSTEMTIME
}

func platformSpoolerAvailable() bool {
	return true
}

func listPlatformPrinters() ([]PrinterInfo, error) {
	flags := uintptr(printerEnumLocal | printerEnumConnections)
	var needed uint32
	var returned uint32
	_, _, firstErr := procEnumPrintersW.Call(
		flags,
		0,
		2,
		0,
		0,
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if needed == 0 {
		if errno, ok := firstErr.(syscall.Errno); ok && errno != 0 && errno != errorInsufficientBuffer {
			return nil, windowsCallError("EnumPrintersW", firstErr)
		}
		return []PrinterInfo{}, nil
	}
	buffer := make([]byte, needed)
	success, _, callErr := procEnumPrintersW.Call(
		flags,
		0,
		2,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)),
	)
	if success == 0 {
		return nil, windowsCallError("EnumPrintersW", callErr)
	}

	defaultPrinter := getDefaultPrinterName()
	rows := unsafe.Slice((*printerInfo2W)(unsafe.Pointer(&buffer[0])), int(returned))
	printers := make([]PrinterInfo, 0, len(rows))
	for _, row := range rows {
		name := utf16PointerString(row.PrinterName)
		if name == "" {
			continue
		}
		printers = append(printers, PrinterInfo{
			Name:        name,
			Description: utf16PointerString(row.ShareName),
			Comment:     utf16PointerString(row.Comment),
			PortName:    utf16PointerString(row.PortName),
			DriverName:  utf16PointerString(row.DriverName),
			IsDefault:   defaultPrinter != "" && strings.EqualFold(defaultPrinter, name),
		})
	}
	sort.Slice(printers, func(left, right int) bool {
		if printers[left].IsDefault != printers[right].IsDefault {
			return printers[left].IsDefault
		}
		return strings.ToLower(printers[left].Name) < strings.ToLower(printers[right].Name)
	})
	return printers, nil
}

func getDefaultPrinterName() string {
	var needed uint32
	_, _, _ = procGetDefaultPrinterW.Call(0, uintptr(unsafe.Pointer(&needed)))
	if needed == 0 {
		return ""
	}
	buffer := make([]uint16, needed)
	success, _, _ := procGetDefaultPrinterW.Call(
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(unsafe.Pointer(&needed)),
	)
	if success == 0 {
		return ""
	}
	return syscall.UTF16ToString(buffer)
}

func printPlatformRaw(printerName, documentName string, payload []byte) (RawPrintResult, error) {
	printerNameUTF16, err := syscall.UTF16PtrFromString(printerName)
	if err != nil {
		return RawPrintResult{}, badRequest("printerName contains invalid characters.")
	}
	documentNameUTF16, err := syscall.UTF16PtrFromString(documentName)
	if err != nil {
		return RawPrintResult{}, badRequest("documentName contains invalid characters.")
	}
	rawDatatype, _ := syscall.UTF16PtrFromString("RAW")

	var handle uintptr
	success, _, callErr := procOpenPrinterW.Call(
		uintptr(unsafe.Pointer(printerNameUTF16)),
		uintptr(unsafe.Pointer(&handle)),
		0,
	)
	if success == 0 {
		return RawPrintResult{}, &apiError{Status: 502, Message: windowsCallError("OpenPrinterW", callErr).Error()}
	}
	defer procClosePrinter.Call(handle)

	document := docInfo1W{
		DocName:  documentNameUTF16,
		Datatype: rawDatatype,
	}
	jobValue, _, callErr := procStartDocPrinterW.Call(handle, 1, uintptr(unsafe.Pointer(&document)))
	if jobValue == 0 {
		return RawPrintResult{}, &apiError{Status: 502, Message: windowsCallError("StartDocPrinterW", callErr).Error()}
	}
	documentStarted := true
	defer func() {
		if documentStarted {
			// EndDoc can commit a truncated RAW stream. Abort the spool document
			// on every non-success path; already transmitted printer bytes still
			// remain an uncertain physical outcome and are reported as such.
			_, _, _ = procAbortPrinter.Call(handle)
		}
	}()

	success, _, callErr = procStartPagePrinter.Call(handle)
	if success == 0 {
		return RawPrintResult{}, &apiError{Status: 502, Message: windowsCallError("StartPagePrinter", callErr).Error()}
	}
	totalWritten := 0
	for totalWritten < len(payload) {
		var written uint32
		success, _, callErr = procWritePrinter.Call(
			handle,
			uintptr(unsafe.Pointer(&payload[totalWritten])),
			uintptr(len(payload)-totalWritten),
			uintptr(unsafe.Pointer(&written)),
		)
		totalWritten += int(written)
		if success == 0 {
			return RawPrintResult{}, &apiError{
				Status:         502,
				Message:        fmt.Sprintf("%s after %d bytes", windowsCallError("WritePrinter", callErr), totalWritten),
				Code:           "RAW_WRITE_FAILED",
				Stage:          "spool",
				Outcome:        "possibly_sent",
				RetrySafety:    "unsafe",
				BytesWritten:   totalWritten,
				WriteStarted:   totalWritten > 0,
				WriteCompleted: false,
			}
		}
		if written == 0 {
			return RawPrintResult{}, &apiError{
				Status:         502,
				Message:        "WritePrinter accepted zero bytes.",
				Code:           "RAW_WRITE_ZERO",
				Stage:          "spool",
				Outcome:        "possibly_sent",
				RetrySafety:    "unsafe",
				BytesWritten:   totalWritten,
				WriteStarted:   totalWritten > 0,
				WriteCompleted: false,
			}
		}
	}

	if success, _, callErr = procEndPagePrinter.Call(handle); success == 0 {
		return RawPrintResult{}, &apiError{
			Status:         502,
			Message:        windowsCallError("EndPagePrinter", callErr).Error(),
			Code:           "RAW_END_PAGE_FAILED",
			Stage:          "spool",
			Outcome:        "possibly_sent",
			RetrySafety:    "unsafe",
			BytesWritten:   totalWritten,
			WriteStarted:   true,
			WriteCompleted: true,
		}
	}
	if success, _, callErr = procEndDocPrinter.Call(handle); success == 0 {
		return RawPrintResult{}, &apiError{
			Status:         502,
			Message:        windowsCallError("EndDocPrinter", callErr).Error(),
			Code:           "RAW_END_DOCUMENT_FAILED",
			Stage:          "spool",
			Outcome:        "possibly_sent",
			RetrySafety:    "unsafe",
			BytesWritten:   totalWritten,
			WriteStarted:   true,
			WriteCompleted: true,
		}
	}
	documentStarted = false

	var selected *PrinterInfo
	printers, listErr := listPlatformPrinters()
	if listErr == nil {
		for index := range printers {
			if strings.EqualFold(printers[index].Name, printerName) {
				selected = &printers[index]
				break
			}
		}
	}
	jobID := uint32(jobValue)
	result := RawPrintResult{
		OK:           true,
		PrinterName:  printerName,
		DocumentName: documentName,
		JobID:        &jobID,
		BytesWritten: totalWritten,
		Warning:      rawZPLWarning(selected),
	}
	if selected != nil {
		result.PortName = selected.PortName
		result.DriverName = selected.DriverName
	}
	return result, nil
}

// printPlatformRawFile submits one complete staged batch as one RAW spool job.
// It never buffers the batch in memory and never changes Windows queue settings.
func printPlatformRawFile(printerName, documentName, filePath string, onStarted func(uint32) error) (RawPrintResult, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return RawPrintResult{}, rawFileFailure("RAW_FILE_OPEN_FAILED", err, 0, false, false)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return RawPrintResult{}, rawFileFailure("RAW_FILE_STAT_FAILED", err, 0, false, false)
	}
	if !info.Mode().IsRegular() || info.Size() <= 0 || uint64(info.Size()) > uint64(^uint(0)>>1) {
		return RawPrintResult{}, badRequest("The staged RAW file must be a non-empty regular file and fit the platform byte counter.")
	}
	documentNameUTF16, err := syscall.UTF16PtrFromString(documentName)
	if err != nil {
		return RawPrintResult{}, badRequest("documentName contains invalid characters.")
	}
	handle, err := openRawPrinterHandle(printerName)
	if err != nil {
		return RawPrintResult{}, err
	}
	defer procClosePrinter.Call(handle)
	selected, attributes, err := inspectRawPrinterHandle(handle)
	if err != nil {
		return RawPrintResult{}, err
	}
	if err = validateRawFileQueue(attributes, selected.PortName); err != nil {
		return RawPrintResult{}, err
	}
	rawDatatype, _ := syscall.UTF16PtrFromString("RAW")
	document := docInfo1W{DocName: documentNameUTF16, Datatype: rawDatatype}
	hooks := rawFileSpoolHooks{
		startDocument: func() (uint32, error) {
			value, _, callErr := procStartDocPrinterW.Call(handle, 1, uintptr(unsafe.Pointer(&document)))
			if value == 0 {
				return 0, windowsCallError("StartDocPrinterW", callErr)
			}
			return uint32(value), nil
		},
		startPage: func() error { return rawPrinterOperation(procStartPagePrinter, handle, "StartPagePrinter") },
		write: func(payload []byte) (int, error) {
			var written uint32
			success, _, callErr := procWritePrinter.Call(handle, uintptr(unsafe.Pointer(&payload[0])), uintptr(len(payload)), uintptr(unsafe.Pointer(&written)))
			if success == 0 {
				return int(written), windowsCallError("WritePrinter", callErr)
			}
			return int(written), nil
		},
		endPage:     func() error { return rawPrinterOperation(procEndPagePrinter, handle, "EndPagePrinter") },
		endDocument: func() error { return rawPrinterOperation(procEndDocPrinter, handle, "EndDocPrinter") },
		abort:       func() { _, _, _ = procAbortPrinter.Call(handle) },
	}
	jobID, written, err := streamRawFileDocument(file, info.Size(), onStarted, hooks)
	result := RawPrintResult{
		OK: err == nil, PrinterName: printerName, DocumentName: documentName,
		BytesWritten: written, PortName: selected.PortName, DriverName: selected.DriverName,
		Warning: rawZPLWarning(&selected),
	}
	if jobID != 0 {
		result.JobID = &jobID
	}
	return result, err
}

func openRawPrinterHandle(printerName string) (uintptr, error) {
	printerNameUTF16, err := syscall.UTF16PtrFromString(printerName)
	if err != nil || strings.TrimSpace(printerName) == "" {
		return 0, badRequest("printerName is empty or contains invalid characters.")
	}
	var handle uintptr
	success, _, callErr := procOpenPrinterW.Call(uintptr(unsafe.Pointer(printerNameUTF16)), uintptr(unsafe.Pointer(&handle)), 0)
	if success == 0 {
		return 0, rawFileFailure("RAW_OPEN_PRINTER_FAILED", windowsCallError("OpenPrinterW", callErr), 0, false, false)
	}
	return handle, nil
}

// validatePlatformRawQueue is read-only and lets batch BEGIN reject unsuitable
// queue settings before the client renders and uploads a large label batch.
func validatePlatformRawQueue(printerName string) error {
	handle, err := openRawPrinterHandle(printerName)
	if err != nil {
		return err
	}
	defer procClosePrinter.Call(handle)
	printer, attributes, err := inspectRawPrinterHandle(handle)
	if err != nil {
		return err
	}
	return validateRawFileQueue(attributes, printer.PortName)
}

func rawPrinterOperation(proc *syscall.LazyProc, handle uintptr, operation string) error {
	success, _, callErr := proc.Call(handle)
	if success == 0 {
		return windowsCallError(operation, callErr)
	}
	return nil
}

func inspectRawPrinterHandle(handle uintptr) (PrinterInfo, uint32, error) {
	var needed uint32
	_, _, callErr := procGetPrinterW.Call(handle, 2, 0, 0, uintptr(unsafe.Pointer(&needed)))
	for attempt := 0; attempt < 3; attempt++ {
		if callErr != errorInsufficientBuffer || needed < uint32(unsafe.Sizeof(printerInfo2W{})) || needed > 16*1024*1024 {
			return PrinterInfo{}, 0, rawFileFailure("RAW_QUEUE_INSPECT_FAILED", windowsCallError("GetPrinterW", callErr), 0, false, false)
		}
		buffer := make([]byte, needed)
		success, _, nextErr := procGetPrinterW.Call(handle, 2, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), uintptr(unsafe.Pointer(&needed)))
		if success != 0 {
			row := (*printerInfo2W)(unsafe.Pointer(&buffer[0]))
			printer := PrinterInfo{
				Name: utf16PointerString(row.PrinterName), PortName: utf16PointerString(row.PortName),
				DriverName: utf16PointerString(row.DriverName),
			}
			attributes := row.Attributes
			runtime.KeepAlive(buffer)
			return printer, attributes, nil
		}
		callErr = nextErr
	}
	return PrinterInfo{}, 0, rawFileFailure("RAW_QUEUE_INSPECT_FAILED", fmt.Errorf("Windows printer settings changed repeatedly during preflight"), 0, false, false)
}

func inspectPlatformRawJob(printerName string, jobID uint32) (RawJobStatus, error) {
	if jobID == 0 {
		return RawJobStatus{}, badRequest("jobID must be non-zero.")
	}
	handle, err := openRawPrinterHandle(printerName)
	if err != nil {
		return RawJobStatus{}, err
	}
	defer procClosePrinter.Call(handle)
	missing := RawJobStatus{JobID: jobID, PrinterName: printerName, State: "missing"}
	var needed uint32
	_, _, callErr := procGetJobW.Call(handle, uintptr(jobID), 1, 0, 0, uintptr(unsafe.Pointer(&needed)))
	for attempt := 0; attempt < 3; attempt++ {
		if rawJobMissingError(callErr) {
			return missing, nil
		}
		if callErr != errorInsufficientBuffer || needed < uint32(unsafe.Sizeof(jobInfo1W{})) || needed > 16*1024*1024 {
			return RawJobStatus{}, rawFileFailure("RAW_JOB_INSPECT_FAILED", windowsCallError("GetJobW", callErr), 0, false, false)
		}
		buffer := make([]byte, needed)
		success, _, nextErr := procGetJobW.Call(handle, uintptr(jobID), 1, uintptr(unsafe.Pointer(&buffer[0])), uintptr(len(buffer)), uintptr(unsafe.Pointer(&needed)))
		if success != 0 {
			row := (*jobInfo1W)(unsafe.Pointer(&buffer[0]))
			status := RawJobStatus{
				JobID: row.JobID, Exists: true, PrinterName: utf16PointerString(row.PrinterName),
				DocumentName: utf16PointerString(row.Document), Status: row.Status,
				StatusText: utf16PointerString(row.StatusText), State: rawWindowsJobState(row.Status),
				PagesPrinted: row.PagesPrinted, TotalPages: row.TotalPages,
				// Even JOB_STATUS_PRINTED may just mean bytes reached the port.
				PhysicalCompletionConfirmed: false,
			}
			runtime.KeepAlive(buffer)
			return status, nil
		}
		callErr = nextErr
	}
	if rawJobMissingError(callErr) {
		return missing, nil
	}
	return RawJobStatus{}, rawFileFailure("RAW_JOB_INSPECT_FAILED", windowsCallError("GetJobW", callErr), 0, false, false)
}

func rawJobMissingError(err error) bool {
	// With a valid handle, a fixed level and a nonzero job ID, Windows returns
	// INVALID_PARAMETER for an ID that no longer exists. This is NOT completion.
	return err == syscall.Errno(87) || err == syscall.Errno(2) || err == syscall.Errno(1168)
}

func utf16PointerString(pointer *uint16) string {
	if pointer == nil {
		return ""
	}
	values := make([]uint16, 0, 128)
	for index := uintptr(0); index < 32768; index++ {
		value := *(*uint16)(unsafe.Add(unsafe.Pointer(pointer), index*2))
		if value == 0 {
			break
		}
		values = append(values, value)
	}
	return syscall.UTF16ToString(values)
}

func windowsCallError(operation string, err error) error {
	if errno, ok := err.(syscall.Errno); !ok || errno == 0 {
		return fmt.Errorf("%s failed", operation)
	}
	return fmt.Errorf("%s failed: %w", operation, err)
}
