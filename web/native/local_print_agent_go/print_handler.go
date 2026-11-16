package main

import (
	"net/http"
	"strings"
)

type rawPrintRequest struct {
	PrinterName   string `json:"printerName"`
	DocumentName  string `json:"documentName"`
	Language      string `json:"language"`
	PayloadBase64 string `json:"payloadBase64"`
	BatchID       string `json:"batchId"`
	Sequence      int    `json:"sequence"`
	FinalChunk    bool   `json:"finalChunk"`
}

func (s *appServer) handleRawPrint(writer http.ResponseWriter, request *http.Request) error {
	// Legacy callers must not bypass an unhealthy durable store whose prior
	// printer reservations could not be safely recovered.
	if err := s.rawSpoolBatches.availability(); err != nil {
		return err
	}
	var body rawPrintRequest
	if err := decodeJSON(writer, request, &body); err != nil {
		return err
	}
	printerName := cleanText(body.PrinterName, "", 260, false)
	if printerName == "" {
		return badRequest("printerName is required.")
	}
	if strings.ContainsRune(printerName, '\x00') {
		return badRequest("printerName contains an invalid NUL character.")
	}
	documentName := cleanText(body.DocumentName, "Nextwaves label", 160, true)
	if strings.ContainsRune(documentName, '\x00') {
		return badRequest("documentName contains an invalid NUL character.")
	}
	payload, err := decodeBase64Payload(strings.TrimSpace(body.PayloadBase64))
	if err != nil {
		if strings.TrimSpace(body.PayloadBase64) == "" {
			return badRequest("payloadBase64 is required.")
		}
		return err
	}
	if platformSpoolerAvailable() && !s.allowNonZebraQueues {
		printers, listErr := listPlatformPrinters()
		if listErr != nil {
			return listErr
		}
		var selected *PrinterInfo
		for index := range printers {
			if strings.EqualFold(printers[index].Name, printerName) {
				selected = &printers[index]
				break
			}
		}
		if selected == nil {
			return forbidden("Windows RAW printing is restricted to an installed Zebra queue.")
		}
		if !isTrustedZebraQueue(selected) {
			return forbidden(
				"Windows RAW printing is restricted to Zebra/ZDesigner/Seagull queues; use --allow-non-zebra-queues only on a trusted workstation.",
			)
		}
	}
	target := spoolPrinterTargetKey(printerName)
	var result RawPrintResult
	if strings.TrimSpace(body.BatchID) != "" {
		result, err = s.rawBatches.submit(
			request.Context(),
			strings.TrimSpace(body.BatchID),
			target,
			printerName,
			body.Sequence,
			body.FinalChunk,
			payload,
			func() (RawPrintResult, error) {
				return printPlatformRaw(printerName, documentName, payload)
			},
		)
	} else {
		if body.Sequence != 0 || body.FinalChunk {
			return badRequest("batchId is required when sequence/finalChunk is provided.")
		}
		var release func()
		release, err = s.printerQueues.acquire(request.Context(), target)
		if err == nil {
			defer release()
			result, err = printPlatformRaw(printerName, documentName, payload)
		}
	}
	if err != nil {
		return err
	}
	s.writeJSON(writer, http.StatusOK, result)
	return nil
}
