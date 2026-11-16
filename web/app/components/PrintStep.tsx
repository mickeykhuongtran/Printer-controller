"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import {
    Plug,
    PlugZap,
    Printer,
    Download,
    FileJson,
    FileText,
    Loader2,
    Save,
    AlertCircle,
    CheckCircle2,
    Info,
    ChevronLeft,
    ChevronRight,
    UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { LabelDoc, LabelElement, LabelSettings } from "../types";
import { PrintFidelityPreview } from "./PrintFidelityPreview";
import { ZplPreview } from "./ZplPreview";
import {
    copyCountFor,
    resolveDynamicValue,
    formatSerial,
    hasPerCopyPrintData,
    hasUserDataRows,
    variablesForCopy,
} from "../label-data";
import {
    buildFullPageStoredGraphicDownloadZpl,
    buildFullPageStoredGraphicRecallZpl,
    buildFullPageZpl,
    buildStoredGraphicDeleteZpl,
    buildZplSourcePreview,
    encodeZpl,
} from "../zpl";
import {
    downloadFile,
    downloadFileParts,
    exportToJson,
    type PrinterSettings,
} from "../storage";
import { renderLabelToBitmap } from "../full-page-raster";
import { normalizeZebraPrinterAlignment } from "../zebra-printer-alignment";
import { evaluateCellForDisplay } from "../data-feed";
import { rfidPayloadForPreview, rfidSourceName, zebraRfidFixedReadByteCount } from "../rfid";
import { sendBytes, sendTextAndRead } from "../webserial";
import {
    inferWindowsPrinterDpi,
    listWindowsPrinters,
    rawZplPrinterWarning,
    createWindowsSpoolBatch,
    assertNoPendingWindowsSpoolBatch,
    type WindowsPrinterInfo,
} from "../windows-raw-print";
import { TcpJobReconciliation, useTcpJobRecovery } from "./TcpJobReconciliation";
import WindowsSpoolJobsPanel from "./WindowsSpoolJobsPanel";
import { PrintPrinterPicker } from "./PrintPrinterPicker";
import { validateSpoolHexRows } from "../raw-spool-preflight";
import { printRowIndexAt, selectPrintRowRange } from "../print-row-range";
import { RawSpoolBatchPendingError } from "../raw-spool-batch";
import { isSafeTcpRetry } from "../tcp-print";
import { TcpPrintJob, TcpPrintJobError, type TcpPrintJobFinishReceipt } from "../tcp-print-job";
import { PdfExportFrame, type PdfExportRange } from "../pdf-export";
import { track } from "../lib/analytics";
import {
    compatiblePrinterDpi,
    maxPrintSpeedIps,
    zebraPrinterModelProfile,
} from "../printer-models";
import { preflightLabelForPrinter } from "../dpi-preflight";
import { printerTransportCapabilities } from "../printer-transport";
import { useSerialSession } from "../serial-session";
import {
    MAX_PRINT_BATCH_QUANTITY,
    assertCompletePrintWrite,
    assertPrintBatchQuantity,
    iteratePrintBatchChunks,
} from "../print-batch";
import {
    registerPrinterPreparation,
    runExclusivePrinterJob,
    tcpPrinterQueueKey,
    windowsPrinterQueueKey,
} from "../print-job-coordinator";
import { waitForZebraDrainBarrier, ZebraDrainError } from "../zebra-drain-barrier";
import { deliverBufferedPrintStream } from "../buffered-print-stream";
import { PrintCancellation } from "../print-cancellation";
import { cancelTcpPrinterBuffer } from "../tcp-job-cancel";
import { fleetRequest, stageFleetChunk, isFleetActive, fleetStatusNames, fleetNotice } from "../fleet-spool";
import { productionTemplateContent } from "../production-roll";
import { useFleetSnapshot, useProductionRollSelection } from "../fleet-store";
import { FleetJobControls } from "./FleetJobControls";
import { ProductionRollPanel } from "./ProductionRollPanel";
import { prepareProductionRoll, productionCaptureWarnings, productionOperationMode, type ProductionPrintContext } from "../production-roll";

interface Props {
    switchingPrinter?: boolean;
    doc: LabelDoc;
    printerSettings: PrinterSettings;
    onUpdatePrinterSettings: (patch: Partial<PrinterSettings>) => void;
    onUpdateSettings: (patch: Partial<LabelSettings>) => void;
    onSaveCurrent: () => LabelDoc;
    onBusyChange?: (busy: boolean) => void;
}

type Status = { text: string; detail?: string; kind: "info" | "ok" | "error" };
type PrintChunkMeta = {
    chunkNumber: number;
    totalChunks: number;
    labelFrom: number;
    labelTo: number;
    finalChunk: boolean;
};
type PrintChunkReceipt = {
    bytesWritten?: number;
    stagedBytes?: number;
    warning?: string;
};
type PreparedPrintChunk = { payload: Uint8Array; meta: PrintChunkMeta };
class PrintPreparationError extends Error {
    constructor(readonly meta: PrintChunkMeta, readonly original: unknown) {
        super(errorDetail(original));
    }
}
type PrintJobSummary = {
    bytesWritten: number;
    chunksAccepted: number;
    totalChunks: number;
    warnings: string[];
};

const HOST_PRINT_CHUNK_TARGET_BYTES = 512 * 1024;
const TCP_PRINT_CHUNK_TARGET_BYTES = 256 * 1024;
const TCP_PRINT_CHUNK_HARD_MAX_BYTES = 8 * 1024 * 1024;
const SERIAL_PRINT_CHUNK_TARGET_BYTES = 32 * 1024;
const STATIC_REPEAT_WINDOW_LABELS = 100;
const MAX_ZPL_DOWNLOAD_ESTIMATE_BYTES = 64 * 1024 * 1024;
const ZEBRA_STATUS_READ_WINDOW_MS = 8_000;
const ZEBRA_STATUS_READ_IDLE_MS = 1_000;
const MAX_BROWSER_PRINT_LABELS = 250;

function errorDetail(err: unknown): string {
    return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function defaultRfidPayload(elements: LabelElement[]): string {
    for (const el of elements) {
        if (el.kind === "qr" || el.kind === "barcode" || el.kind === "datamatrix") return el.data;
        if (el.kind === "text") return el.text;
    }
    return "";
}

function estimatedExpandedLabelBytes(settings: LabelSettings): number {
    const dpi = settings.dpi ?? 203;
    const widthDots = Math.max(1, Math.ceil((settings.widthMm / 25.4) * dpi));
    const heightDots = Math.max(1, Math.ceil((settings.heightMm / 25.4) * dpi));
    return Math.ceil(widthDots / 8) * heightDots * 2 + 16 * 1024;
}

// A conservative software lookahead budget, not a claim about free printer RAM.
function tcpBufferedFormatBudget(settings: LabelSettings): number {
    return Math.max(1, Math.min(40, Math.floor(2 * 1024 * 1024 / estimatedExpandedLabelBytes(settings))));
}

function dynamicChunkLabelLimit(settings: LabelSettings, tcp: boolean): number {
    const limit = settings.rfid.enabled || settings.rfid.readEnabled ? 10 : 25;
    return tcp ? Math.min(limit, tcpBufferedFormatBudget(settings)) : limit;
}

function concatPrintPayloads(parts: readonly Uint8Array[], totalBytes: number): Uint8Array {
    const output = new Uint8Array(totalBytes);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function chunkOrdinal(meta: PrintChunkMeta): string {
    return meta.totalChunks > 0
        ? `${meta.chunkNumber}/${meta.totalChunks}`
        : String(meta.chunkNumber);
}

export function PrintStep({ switchingPrinter = false,
    doc,
    printerSettings,
    onUpdatePrinterSettings,
    onUpdateSettings,
    onSaveCurrent,
    onBusyChange,
}: Props) {
    const {
        supported,
        selectedPort,
        connection,
        action: serialAction,
        selectPort: selectSerialPort,
        connect: connectSerialPort,
        disconnect: disconnectSerialPort,
    } = useSerialSession();
    const [busy, setBusy] = useState(false);
    const [rfidHistoryRevision, setRfidHistoryRevision] = useState(0);
    const [productionContext, setProductionContext] = useState<ProductionPrintContext | null>(null);
    const { rollId: selectedProductionRollId, select: selectProductionRoll } = useProductionRollSelection(printerSettings.printAgentUrl, printerSettings.tcpHost, printerSettings.tcpPort);
    const [printerPaused, setPrinterPaused] = useState(false);
    const [tcpCancellation, setTcpCancellation] = useState<PrintCancellation | null>(null);
    const [tcpCancelRequested, setTcpCancelRequested] = useState(false);
    const { jobId: stoppedTcpJobId, kind: stoppedTcpKind, remember: setStoppedTcpJobId } = useTcpJobRecovery(printerSettings);
    const printOperationRef = useRef(false);
    const [status, setStatus] = useState<Status>({ text: "", kind: "info" });
    const [lastFleetJobId, setLastFleetJobId] = useState("");
    const [windowsPrinters, setWindowsPrinters] = useState<WindowsPrinterInfo[]>([]);
    const [printerListLoading, setPrinterListLoading] = useState(false);
    const windowsPrintersUrlRef = useRef("");
    const [printerListRevision, setPrinterListRevision] = useState(0);
    const [previewWidth, setPreviewWidth] = useState(720);
    const [previewSelection, setPreviewSelection] = useState({ key: "", index: 0 });
    const [viewMode, setViewMode] = useState<"single" | "roll">("single");
    const previewColumnRef = useRef<HTMLDivElement | null>(null);
    const [columnWidth, setColumnWidth] = useState(720);

    useEffect(() => {
        const el = previewColumnRef.current;
        if (!el) return;
        const update = () => setColumnWidth(el.clientWidth);
        update();
        const obs = new ResizeObserver(update);
        obs.observe(el);
        return () => obs.disconnect();
    }, []);
    const hasDataFeed = hasUserDataRows(doc);
    const totalRows = hasDataFeed
        ? Math.max(1, doc.dataFeed?.rows.length ?? 1)
        : Math.max(1, Math.floor(doc.settings.copies));
    const [rangeMode, setRangeMode] = useState<"all" | "first" | "range">("all");
    const [firstN, setFirstN] = useState<number>(Math.max(1, doc.settings.copies));
    const [rangeFrom, setRangeFrom] = useState<number>(1);
    const [rangeTo, setRangeTo] = useState<number>(Math.max(1, doc.settings.copies));
    const [pdfRange, setPdfRange] = useState<PdfExportRange | null>(null);

    const acquirePrintOperation = (): boolean => {
        if (printOperationRef.current) {
            setStatus({
                text: "A print or ZPL export operation is already running.",
                kind: "error",
            });
            return false;
        }
        printOperationRef.current = true;
        onBusyChange?.(true);
        setPrinterPaused(false);
        return true;
    };

    const releasePrintOperation = () => {
        printOperationRef.current = false;
        onBusyChange?.(false);
    };

    const selectedFeedRange = useMemo(() => {
        if (!hasDataFeed) return selectPrintRowRange(1);
        if (rangeMode === "first") {
            return selectPrintRowRange(totalRows, 1, firstN);
        }
        return rangeMode === "range"
            ? selectPrintRowRange(totalRows, rangeFrom, rangeTo)
            : selectPrintRowRange(totalRows);
    }, [
        firstN,
        hasDataFeed,
        rangeFrom,
        rangeMode,
        rangeTo,
        totalRows,
    ]);
    const startRowIdx = selectedFeedRange.fromIdx;
    const rowStep = hasDataFeed ? selectedFeedRange.step : 1;
    const previewRangeKey = hasDataFeed
        ? `${selectedFeedRange.fromIdx}:${selectedFeedRange.toIdx}`
        : "copies";
    const previewIndex = previewSelection.key === previewRangeKey
        ? previewSelection.index
        : startRowIdx;
    const setPreviewIndex = (index: number) => setPreviewSelection({ key: previewRangeKey, index });
    // This is the atomic print quantity for the currently selected range.
    // Do not wait for the persistence effect below before starting a job.
    const selectedQuantity = hasDataFeed
        ? selectedFeedRange.quantity
        : doc.settings.copies;

    useEffect(() => {
        if (!hasDataFeed) return;
        const copies = selectedQuantity;
        if (copies !== doc.settings.copies) {
            onUpdateSettings({ copies });
        }
    }, [
        hasDataFeed,
        selectedQuantity,
        doc.settings.copies,
        onUpdateSettings,
    ]);

    const quantityIsValid =
        Number.isSafeInteger(selectedQuantity)
        && selectedQuantity >= 1
        && selectedQuantity <= MAX_PRINT_BATCH_QUANTITY;
    const rfidOperationEnabled = !!doc.settings.rfid.enabled || !!doc.settings.rfid.readEnabled;
    const productionOpen = !!productionContext?.hasCapturedRuns;
    const productionBound = !!productionContext?.rollId;
    useEffect(() => {
        if (productionBound && rfidOperationEnabled && !doc.settings.rfid.captureToHost) {
            onUpdateSettings({ rfid: { ...doc.settings.rfid, captureToHost: true } });
        }
    }, [productionBound, rfidOperationEnabled, doc.settings.rfid, onUpdateSettings]);
    const captureEnabled = rfidOperationEnabled && (!!doc.settings.rfid.captureToHost || productionBound);
    const productionMode = printerSettings.connectionMode === "tcp" && captureEnabled;
    const productionBlockReason = productionBound && (!rfidOperationEnabled || printerSettings.connectionMode !== "tcp")
        ? "Đóng cuộn hiện tại trước khi đổi template hoặc kết nối."
        : printerSettings.connectionMode !== "tcp" && !productionBound ? "" : !productionContext ? "Đang tải dữ liệu cuộn…"
        : productionContext.blocked ? productionContext.reason : "";
    const captureTransportBlocked = captureEnabled && printerSettings.connectionMode !== "tcp";
    const fleetSnapshot = useFleetSnapshot(printerSettings.printAgentUrl);
    const fleetJob = fleetSnapshot?.jobs.find(j => j.host === printerSettings.tcpHost && j.port === printerSettings.tcpPort);
    const displayStatus: Status = fleetJob?.jobId === lastFleetJobId && (!busy || fleetJob.state === "not_sent" || fleetJob.state === "needs_review")
        ? fleetNotice(fleetJob, fleetSnapshot.stale) : status;
    const fleetBlocked = !!fleetJob && (isFleetActive(fleetJob) || fleetJob.state === "needs_review");
    const printIsBlocked = fleetBlocked || switchingPrinter || !quantityIsValid || captureTransportBlocked || !!productionBlockReason;
    const staticRepeatSafe =
        !hasDataFeed
        && !hasPerCopyPrintData(doc);

    const copyCount = hasDataFeed ? selectedQuantity : copyCountFor(doc);
    const printerAlignment = useMemo(
        () => normalizeZebraPrinterAlignment({
            labelTopDots: printerSettings.labelTopDots,
            leftPositionDots: printerSettings.leftPositionDots,
        }),
        [printerSettings.labelTopDots, printerSettings.leftPositionDots],
    );
    const jobAlignment = printerSettings.embedAlignmentInJobs
        ? printerAlignment
        : undefined;
    const tearOffOverrideDots =
        printerSettings.embedTearOffInJobs
        && typeof printerSettings.tearOffDots === "number"
        ? printerSettings.tearOffDots
        : undefined;
    const sourcePreview = useMemo(
        () => buildZplSourcePreview(
            doc.settings,
            copyCount,
            jobAlignment,
            tearOffOverrideDots,
        ),
        [copyCount, doc.settings, jobAlignment, tearOffOverrideDots],
    );
    // Elements that extend past the label's printable area — these get cut off
    // by the printer (or fall onto the next label entirely).
    const outOfBounds = useMemo(() => {
        const w = doc.settings.widthMm;
        const h = doc.settings.heightMm;
        return doc.elements
            .map((el) => {
                const x0 = Math.min(el.pos.x, el.pos.x + el.size.w);
                const y0 = Math.min(el.pos.y, el.pos.y + el.size.h);
                const x1 = Math.max(el.pos.x, el.pos.x + el.size.w);
                const y1 = Math.max(el.pos.y, el.pos.y + el.size.h);
                return {
                    el,
                    overflowLeft: Math.max(0, -x0),
                    overflowTop: Math.max(0, -y0),
                    overflowRight: Math.max(0, x1 - w),
                    overflowBottom: Math.max(0, y1 - h),
                };
            })
            .filter((item) =>
                item.overflowLeft > 0.001
                || item.overflowTop > 0.001
                || item.overflowRight > 0.001
                || item.overflowBottom > 0.001
            );
    }, [doc]);
    const previewClampMin = hasDataFeed ? Math.min(selectedFeedRange.fromIdx, selectedFeedRange.toIdx) : 0;
    const previewClampMax = hasDataFeed
        ? Math.max(selectedFeedRange.fromIdx, selectedFeedRange.toIdx)
        : Math.max(0, copyCount - 1);
    const previewStartIndex = hasDataFeed ? selectedFeedRange.fromIdx : 0;
    const safePreviewIndex = previewIndex >= previewClampMin && previewIndex <= previewClampMax
        ? previewIndex
        : previewStartIndex;
    const previewPrintWarnings = useMemo(
        () => preflightLabelForPrinter(doc, { copyIndex: safePreviewIndex })
            .filter((issue) => issue.severity === "warning"),
        [doc, safePreviewIndex],
    );
    const selectedWindowsPrinter = useMemo(
        () => windowsPrinters.find((printer) => printer.name === printerSettings.printerName),
        [printerSettings.printerName, windowsPrinters],
    );
    const selectedPrinterWarning = useMemo(
        () => rawZplPrinterWarning(selectedWindowsPrinter),
        [selectedWindowsPrinter],
    );
    const selectedPrinterDpi = useMemo(
        () => inferWindowsPrinterDpi(
            selectedWindowsPrinter ?? {
                name: printerSettings.printerName,
                isDefault: false,
            },
        ),
        [printerSettings.printerName, selectedWindowsPrinter],
    );
    const windowsQueueDpiMismatch =
        printerSettings.connectionMode === "windowsRaw" &&
        selectedPrinterDpi !== undefined &&
        selectedPrinterDpi !== doc.settings.dpi;
    const canAdoptWindowsQueueDpi =
        selectedPrinterDpi !== undefined &&
        compatiblePrinterDpi(
            doc.settings.targetPrinterModel ?? doc.settings.rfid.zebraModel,
            selectedPrinterDpi,
        ) === selectedPrinterDpi;
    const targetPrinterProfile = zebraPrinterModelProfile(
        doc.settings.targetPrinterModel ?? doc.settings.rfid.zebraModel,
    );
    const transport = printerTransportCapabilities(printerSettings.connectionMode);
    const transportTarget =
        printerSettings.connectionMode === "tcp"
            ? `${printerSettings.tcpHost.trim() || "Not configured"}:${printerSettings.tcpPort}`
            : printerSettings.connectionMode === "windowsRaw"
                ? printerSettings.printerName.trim() || "No Windows queue selected"
                : `${printerSettings.baudRate} baud`;
    const modelMaxPrintSpeed = maxPrintSpeedIps(
        targetPrinterProfile.id,
        doc.settings.dpi,
    );
    const targetMaxPrintSpeed = modelMaxPrintSpeed ?? 14;

    useEffect(() => {
        const requestedSpeed = Number.isFinite(doc.settings.speed)
            ? Math.round(doc.settings.speed)
            : Math.min(4, targetMaxPrintSpeed);
        const safeSpeed = Math.max(
            1,
            Math.min(targetMaxPrintSpeed, requestedSpeed),
        );
        if (safeSpeed !== doc.settings.speed) {
            onUpdateSettings({ speed: safeSpeed });
        }
    }, [doc.settings.speed, onUpdateSettings, targetMaxPrintSpeed]);

    // Recalculate a sensible preview size based on viewport.
    useEffect(() => {
        const compute = () => {
            const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
            const vh = typeof window !== "undefined" ? window.innerHeight : 800;
            const maxW = Math.min(960, Math.floor(vw * 0.55));
            const maxH = Math.floor(vh * 0.7);
            const aspect = doc.settings.widthMm / doc.settings.heightMm;
            const widthFromHeight = Math.floor(maxH * aspect);
            setPreviewWidth(Math.max(280, Math.min(maxW, widthFromHeight)));
        };
        compute();
        window.addEventListener("resize", compute);
        return () => window.removeEventListener("resize", compute);
    }, [doc.settings.widthMm, doc.settings.heightMm]);

    const onSelectPort = async () => {
        try {
            const selected = await selectSerialPort();
            setStatus({ text: `Port selected - ${selected.label}`, kind: "info" });
        } catch (err) {
            const cancelled = err instanceof DOMException && err.name === "NotFoundError";
            setStatus({
                text: cancelled
                    ? "Port selection cancelled."
                    : err instanceof Error
                        ? err.message
                        : "Could not select a serial port.",
                kind: cancelled ? "info" : "error",
            });
        }
    };

    const onConnect = async () => {
        if (!selectedPort) {
            setStatus({ text: "Select a COM port first.", kind: "error" });
            return;
        }
        track("printer_connect_attempt");
        try {
            console.log("[print] onConnect clicked");
            const conn = await connectSerialPort(
                printerSettings.baudRate,
                printerSettings.serialFlowControl,
            );
            console.log("[print] onConnect success:", conn.label);
            track("printer_connect_success", {
                label: conn.label,
                baudRate: printerSettings.baudRate,
                language: "zpl",
            });
            setStatus({
                text:
                    `Connected - ${conn.label} @ ${printerSettings.baudRate} baud `
                    + `(${printerSettings.serialFlowControl === "hardware" ? "RTS/CTS" : "no handshake"})`,
                kind: "ok",
            });
        } catch (err) {
            console.error("[print] onConnect failed:", err);
            track("printer_connect_failed", {
                message: err instanceof Error ? err.message : String(err),
            });
            setStatus({
                text: err instanceof Error ? err.message : "Could not connect",
                kind: "error",
            });
        }
    };

    const onDisconnect = async () => {
        if (!connection) return;
        track("printer_disconnect");
        await disconnectSerialPort();
        setStatus({ text: "Disconnected", kind: "info" });
    };

    const assertPrintPreflight = (sourceDoc: LabelDoc, copyIndex?: number) => {
        const issues = preflightLabelForPrinter(sourceDoc, { copyIndex });
        const blockingIssues = issues.filter(
            (issue) => issue.severity === "error",
        );
        if (blockingIssues.length > 0) {
            throw new Error(
                `Print blocked by target-printer preflight: ${blockingIssues
                    .map((issue) => issue.message)
                    .join(" ")}`,
            );
        }

        if (
            printerSettings.connectionMode === "windowsRaw"
            && selectedPrinterDpi !== undefined
            && selectedPrinterDpi !== sourceDoc.settings.dpi
        ) {
            throw new Error(
                `DPI mismatch: this template is ${sourceDoc.settings.dpi} dpi, but the selected Windows queue appears to be ${selectedPrinterDpi} dpi. Resolve the mismatch before printing.`,
            );
        }
        return issues.filter((issue) => issue.severity === "warning");
    };

    // Build one Zebra ZPL job per copy. Canvas rasterization is asynchronous.
    const buildPrintBytes = async (
        sourceDoc: LabelDoc = doc,
        options: {
            nativeResolvedRfidReadFields?: boolean;
            capture?: { jobId: string; ordinal: number };
            startRowIdxOverride?: number;
            copyCountOverride?: number;
            onWarnings?: (issues: ReturnType<typeof assertPrintPreflight>, copyIndex: number) => void;
        } = {},
    ): Promise<Uint8Array> => {
        assertPrintPreflight(sourceDoc);
        // Never silently compile at a resolution different from the one shown
        // in the editor/preview. A detected queue mismatch is surfaced above.
        const docForPrint: LabelDoc = sourceDoc;

        const copies = Math.floor(
            options.copyCountOverride ?? docForPrint.settings.copies,
        );
        assertPrintBatchQuantity(copies);
        const jobs: string[] = [];
        const serial = docForPrint.settings.serial;
        const baseCopyIndex = options.startRowIdxOverride ?? startRowIdx;
        for (let i = 0; i < copies; i += 1) {
            const copyIndex = baseCopyIndex + i * rowStep;
            const rowWarnings = assertPrintPreflight(docForPrint, copyIndex);
            options.onWarnings?.(rowWarnings, copyIndex);
            const fullPage = await renderLabelToBitmap(docForPrint, copyIndex, {
                skipRfidReadDynamicElements: !!docForPrint.settings.rfid.readEnabled,
                skipResolvedRfidReadDynamicElements: !!options.nativeResolvedRfidReadFields,
            });
            if (!fullPage) {
                throw new Error("ZPL rasterization failed (no canvas?)");
            }
            const sn = serial.enabled
                ? formatSerial(serial.start + copyIndex * serial.step, serial.pad, serial.prefix)
                : "";
            const vars = variablesForCopy(docForPrint, copyIndex);
            const rfidData = resolveDynamicValue(
                docForPrint.settings.rfid.data || sn || defaultRfidPayload(docForPrint.elements),
                docForPrint.settings.rfid.fieldName,
                sn,
                vars,
            );
            jobs.push(buildFullPageZpl(docForPrint.settings, fullPage, 1, {
                rfidData,
                capture: options.capture ? { ...options.capture, ordinal: options.capture.ordinal + i } : undefined,
                elements: docForPrint.elements,
                sn,
                vars,
                emitResolvedRfidReadFields: !!options.nativeResolvedRfidReadFields,
                alignment: jobAlignment,
                tearOffOverrideDots,
            }));
        }
        return encodeZpl(jobs.join(""));
    };

    /**
     * Builds and delivers a bounded stream of payloads. A successful receipt
     * means the bytes were accepted by the connector/port, not that every
     * physical label has finished printing.
     */
    const runPrintJob = async (
        sendChunk: (
            payload: Uint8Array,
            meta: PrintChunkMeta,
        ) => Promise<PrintChunkReceipt>,
        options: { sourceDoc?: LabelDoc; staging?: boolean; hostSpool?: boolean; buffered?: boolean; signal?: AbortSignal; captureJobId?: string } = {},
    ): Promise<PrintJobSummary> => {
        const printDoc = options.sourceDoc ?? structuredClone(doc);
        if ((printDoc.settings.rfid.enabled || printDoc.settings.rfid.readEnabled) && printDoc.settings.rfid.captureToHost && !options.captureJobId) {
            throw new Error("RFID CSV capture requires live TCP printing through the local connector. Disable the CSV option for other transports or ZPL export.");
        }
        options.signal?.throwIfAborted();
        const quantity = Math.floor(selectedQuantity);
        assertPrintBatchQuantity(quantity);

        assertPrintPreflight(printDoc);
        let bytesWritten = 0;
        let chunksAccepted = 0;
        const warnings: string[] = [];
        const rowsWithWarnings = new Set<number>();
        let totalChunksPlanned = 0;
        let acceptedFrom: number | undefined;
        let acceptedTo: number | undefined;

        const preparationFailure = (
            meta: PrintChunkMeta,
            err: unknown,
        ): Error => {
            const accepted =
                chunksAccepted > 0
                    ? `${chunksAccepted} earlier chunk(s) were ${options.staging ? "staged only; nothing has been submitted to Windows" : "already accepted"}. `
                    : "";
            return new Error(
                `Stopped before sending chunk ${chunkOrdinal(meta)} `
                + `(labels ${meta.labelFrom}–${meta.labelTo}). `
                + accepted
                + `The current chunk was not sent. `
                + (options.buffered && acceptedFrom !== undefined
                    ? `Physical completion of all submitted labels ${acceptedFrom}–${acceptedTo} is unverified; reconcile printed/VOID labels before starting another range. `
                    : "")
                + (options.buffered
                    ? `Prepared chunks still in the application were discarded without sending. First unsent label: ${acceptedTo === undefined ? (hasDataFeed ? startRowIdx + 1 : 1) : acceptedTo + (staticRepeatSafe ? 1 : rowStep)}. `
                    : "")
                + errorDetail(err),
            );
        };

        const deliver = async (payload: Uint8Array, meta: PrintChunkMeta) => {
            options.signal?.throwIfAborted();
            setStatus({
                text:
                    options.hostSpool ? `Đang lưu trên host: tem ${meta.labelFrom}–${meta.labelTo}…` : `${options.staging ? "Preparing" : "Sending"} labels ${meta.labelFrom}–${meta.labelTo}…`,
                kind: "info",
            });
            try {
                const receipt = await sendChunk(payload, meta);
                const acceptedBytes = options.staging ? receipt.stagedBytes : receipt.bytesWritten;
                assertCompletePrintWrite(payload.byteLength, acceptedBytes ?? -1);
                bytesWritten += acceptedBytes ?? 0;
                chunksAccepted += 1;
                acceptedFrom ??= meta.labelFrom;
                acceptedTo = meta.labelTo;
                if (receipt.warning) warnings.push(receipt.warning);
            } catch (err) {
                if (options.hostSpool) throw err;
                if (options.staging) {
                    throw new Error(`Preparation stopped at labels ${meta.labelFrom}–${meta.labelTo}. No Windows spool submission has been committed. ${errorDetail(err)}`);
                }
                const accepted =
                    chunksAccepted > 0
                        ? `${chunksAccepted} earlier chunk(s) were transport-accepted. `
                            + (options.buffered
                                ? `Physical completion of earlier labels ${acceptedFrom}–${acceptedTo} is also unverified. `
                                : "")
                        : "";
                if (err instanceof ZebraDrainError) {
                    throw new Error(
                        `Chunk ${chunkOrdinal(meta)} (labels ${meta.labelFrom}–${meta.labelTo}) `
                        + `was transport-accepted (${err.bytesWritten} bytes), but physical completion is unverified. `
                        + accepted
                        + "Later chunks were not sent. Reconcile printed/VOID labels before creating a new print range. "
                        + errorDetail(err),
                    );
                }
                if (isSafeTcpRetry(err)) {
                    throw new Error(
                        `Chunk ${chunkOrdinal(meta)} `
                        + `(labels ${meta.labelFrom}–${meta.labelTo}) was not sent `
                        + `after ${err.attempts} attempt(s). `
                        + accepted
                        + (options.buffered && chunksAccepted > 0
                            ? "Reconcile all earlier submitted labels before starting another range. "
                            : `It is safe to resume from label ${meta.labelFrom}; do not resend the earlier labels. `)
                        + errorDetail(err),
                    );
                }
                if (
                    err instanceof TcpPrintJobError
                    && err.outcome === "not_sent"
                ) {
                    throw new TcpPrintJobError(
                        `Chunk ${chunkOrdinal(meta)} `
                        + `(labels ${meta.labelFrom}–${meta.labelTo}) was not sent. `
                        + accepted
                        + errorDetail(err),
                        { ...err, execution: err.execution, outcome: chunksAccepted === 0 ? "not_sent" : "possibly_sent" },
                    );
                }
                throw new Error(
                    `Chunk ${chunkOrdinal(meta)} `
                    + `(labels ${meta.labelFrom}–${meta.labelTo}) has an unknown outcome. `
                    + accepted
                    + "Do not automatically resend it; reconcile the printed/VOID tags first. "
                    + errorDetail(err),
                );
            }
        };

        const prepareChunks = async function* (): AsyncGenerator<PreparedPrintChunk> {
            options.signal?.throwIfAborted();
            if (staticRepeatSafe) {
                if (assertPrintPreflight(printDoc, 0).length > 0) rowsWithWarnings.add(0);
                // Retain printer-side ^PQ efficiency, but bound each repeat window
                // so status/backpressure and failure reporting have useful label
                // checkpoints during a 1,000/2,500-label run.
                const repeatWindows = iteratePrintBatchChunks(
                    quantity,
                    STATIC_REPEAT_WINDOW_LABELS,
                );
                totalChunksPlanned = Math.ceil(quantity / STATIC_REPEAT_WINDOW_LABELS);
                setStatus({
                    text:
                        `Rendering one static format for ${quantity} labels `
                        + `(${Math.ceil(quantity / STATIC_REPEAT_WINDOW_LABELS)} printer windows)…`,
                    kind: "info",
                });
                const fullPage = await renderLabelToBitmap(printDoc, 0);
                options.signal?.throwIfAborted();
                if (!fullPage) {
                    throw new Error("Static label rasterization failed (no canvas?).");
                }
                const graphicName = `NW${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
                for (const window of repeatWindows) {
                    options.signal?.throwIfAborted();
                    let zpl = window.chunkNumber === 1
                        ? buildFullPageStoredGraphicDownloadZpl(fullPage, graphicName)
                        : "";
                    zpl += buildFullPageStoredGraphicRecallZpl(
                        printDoc.settings,
                        graphicName,
                        window.quantity,
                        {
                            alignment: jobAlignment,
                            tearOffOverrideDots,
                        },
                    );
                    if (window.chunkNumber === Math.ceil(quantity / STATIC_REPEAT_WINDOW_LABELS)) {
                        zpl += buildStoredGraphicDeleteZpl(graphicName);
                    }
                    yield { payload: encodeZpl(zpl), meta: {
                        chunkNumber: window.chunkNumber,
                        totalChunks: Math.ceil(quantity / STATIC_REPEAT_WINDOW_LABELS),
                        labelFrom: window.startIndex + 1,
                        labelTo: window.endIndexExclusive,
                        finalChunk: window.chunkNumber === Math.ceil(quantity / STATIC_REPEAT_WINDOW_LABELS),
                    } };
                }
            } else {
                const targetBytes =
                    printerSettings.connectionMode === "tcp"
                        ? TCP_PRINT_CHUNK_TARGET_BYTES
                        : printerSettings.connectionMode === "webserial"
                            ? SERIAL_PRINT_CHUNK_TARGET_BYTES
                            : HOST_PRINT_CHUNK_TARGET_BYTES;
                const hardMaxBytes =
                    printerSettings.connectionMode === "tcp"
                        ? TCP_PRINT_CHUNK_HARD_MAX_BYTES
                        : Math.max(targetBytes, HOST_PRINT_CHUNK_TARGET_BYTES);
                // Checkpoints bound each write; TCP can queue several without draining.
                const maxLabelsPerChunk = dynamicChunkLabelLimit(
                    printDoc.settings, printerSettings.connectionMode === "tcp",
                );
                const firstLabelNumber = hasDataFeed ? startRowIdx + 1 : 1;
                const labelNumberAt = (offset: number) => firstLabelNumber + offset * rowStep;
                let pendingParts: Uint8Array[] = [];
                let pendingBytes = 0;
                let pendingStartOffset = 0;
                let pendingLabelCount = 0;

                const takePending = (finalChunk: boolean): PreparedPrintChunk => {
                    totalChunksPlanned += 1;
                    const meta: PrintChunkMeta = {
                        chunkNumber: totalChunksPlanned,
                        // The stream is intentionally rendered and delivered
                        // incrementally, so the final chunk count is not guessed.
                        totalChunks: 0,
                        labelFrom: labelNumberAt(pendingStartOffset),
                        labelTo: labelNumberAt(pendingStartOffset + pendingLabelCount - 1),
                        finalChunk,
                    };
                    const chunk = { payload: concatPrintPayloads(pendingParts, pendingBytes), meta };
                    pendingParts = [];
                    pendingBytes = 0;
                    pendingLabelCount = 0;
                    return chunk;
                };

                for (let offset = 0; offset < quantity; offset += 1) {
                    options.signal?.throwIfAborted();
                    const labelNumber = labelNumberAt(offset);
                    if (!options.buffered) setStatus({
                        text:
                            `Preparing labels: ${offset + 1} of ${quantity}…`,
                        kind: "info",
                    });
                    let labelPayload: Uint8Array;
                    try {
                        labelPayload = await buildPrintBytes(printDoc, {
                            startRowIdxOverride: startRowIdx + offset * rowStep,
                            copyCountOverride: 1,
                            capture: options.captureJobId ? { jobId: options.captureJobId, ordinal: offset + 1 } : undefined,
                            onWarnings: (issues, copyIndex) => {
                                if (issues.length > 0) rowsWithWarnings.add(copyIndex);
                            },
                        });
                    } catch (err) {
                        const unsentStartOffset = pendingLabelCount > 0
                            ? pendingStartOffset
                            : offset;
                        throw new PrintPreparationError({
                            chunkNumber: totalChunksPlanned + 1,
                            totalChunks: 0,
                            labelFrom: labelNumberAt(unsentStartOffset),
                            labelTo: labelNumber,
                            finalChunk: false,
                        }, err);
                    }
                    if (labelPayload.byteLength > hardMaxBytes) {
                        throw new PrintPreparationError({
                            chunkNumber: totalChunksPlanned + 1,
                            totalChunks: 0,
                            labelFrom: labelNumber,
                            labelTo: labelNumber,
                            finalChunk: false,
                        }, new Error(
                            `One rendered label is ${labelPayload.byteLength} bytes, `
                            + `above the ${hardMaxBytes}-byte transport safety limit.`,
                        ));
                    }

                    if (
                        pendingLabelCount > 0
                        && (
                            pendingBytes + labelPayload.byteLength > targetBytes
                            || pendingLabelCount >= maxLabelsPerChunk
                        )
                    ) {
                        yield takePending(false);
                    }
                    if (pendingLabelCount === 0) pendingStartOffset = offset;
                    pendingParts.push(labelPayload);
                    pendingBytes += labelPayload.byteLength;
                    pendingLabelCount += 1;

                    if (
                        pendingBytes >= targetBytes
                        || pendingLabelCount >= maxLabelsPerChunk
                    ) {
                        yield takePending(offset === quantity - 1);
                    }
                }
                if (pendingLabelCount > 0) yield takePending(true);
            }
        };

        try {
            if (options.buffered) {
                setStatus({ text: "Preparing labels for continuous TCP printing…", kind: "info" });
                await deliverBufferedPrintStream(prepareChunks(), ({ payload, meta }) => deliver(payload, meta), { abortSignal: options.signal });
            } else {
                for await (const { payload, meta } of prepareChunks()) await deliver(payload, meta);
            }
        } catch (error) {
            if (error instanceof PrintPreparationError) throw preparationFailure(error.meta, error.original);
            throw error;
        }

        if (rowsWithWarnings.size > 0) {
            warnings.push(
                `Print warnings were allowed for ${staticRepeatSafe ? quantity : rowsWithWarnings.size} label(s). ` +
                "Verify barcode/QR scanning on real tags and adjust manual size if needed.",
            );
        }
        return {
            bytesWritten,
            chunksAccepted,
            totalChunks: totalChunksPlanned,
            warnings,
        };
    };

    useEffect(() => {
        if (printerSettings.connectionMode !== "windowsRaw") return;
        const connectorUrl = printerSettings.printAgentUrl.trim();
        if (windowsPrintersUrlRef.current === connectorUrl) return;
        windowsPrintersUrlRef.current = "";
        setWindowsPrinters([]);
        let disposed = false;
        const loadQueues = async () => {
            try {
                setPrinterListLoading(true);
                const printers = await listWindowsPrinters(printerSettings.printAgentUrl);
                if (disposed) return;
                setWindowsPrinters(printers);
                windowsPrintersUrlRef.current = connectorUrl;
            } catch (err) {
                if (disposed) return;
                windowsPrintersUrlRef.current = "";
                setStatus({
                    text: `Local print agent unavailable - ${errorDetail(err)}`,
                    kind: "error",
                });
            } finally {
                if (!disposed) setPrinterListLoading(false);
            }
        };
        void loadQueues();
        return () => { disposed = true; };
    }, [
        printerSettings.connectionMode,
        printerSettings.printAgentUrl,
        printerListRevision,
    ]);

    const verifyPrinterBarrier = async (
        query: (command: string) => Promise<string>,
        meta: PrintChunkMeta,
        bytesWritten: number,
        maxBufferedFormats?: number,
        signal?: AbortSignal,
    ): Promise<string | undefined> => {
        try {
            return await waitForZebraDrainBarrier(query, {
                signal,
                maxBufferedFormats,
                onStateChange: (state) => {
                    setPrinterPaused(state === "paused");
                    setStatus({
                        text: state === "paused"
                            ? `Printer paused — waiting for Resume on the printer. Labels ${meta.labelFrom}–${meta.labelTo} have been sent; remaining labels are held.`
                            : state === "buffering"
                                ? `Streaming labels ${meta.labelFrom}–${meta.labelTo}; checking printer buffer capacity…`
                                : `Waiting for the printer to finish submitted labels ${meta.labelFrom}–${meta.labelTo}…`,
                        kind: "info",
                    });
                },
            });
        } catch (error) {
            throw new ZebraDrainError(bytesWritten, error);
        }
    };

    const onWindowsRawPrint = async () => {
        if (!printerSettings.printerName.trim()) {
            setStatus({ text: "Enter a Windows printer name first.", kind: "error" });
            return;
        }
        if (!acquirePrintOperation()) return;
        track("print_started", {
            copies: selectedQuantity,
            mode: "windows-raw",
            language: "zpl",
        });
        try {
            setBusy(true);
            const snapshot = structuredClone(doc);
            const target = { ...printerSettings };
            const rawBatchId = crypto.randomUUID();
            const summary = await runExclusivePrinterJob(
                windowsPrinterQueueKey(target.printAgentUrl, target.printerName),
                async () => {
                    await assertNoPendingWindowsSpoolBatch(target.printAgentUrl, target.printerName);
                    const batch = await createWindowsSpoolBatch({
                        agentUrl: target.printAgentUrl,
                        printerName: target.printerName,
                        documentName: snapshot.name || "Nextwaves label",
                        batchId: rawBatchId,
                        totalLabels: selectedQuantity,
                        onStatus: (state) => {
                            if (state.state !== "staging") setStatus({
                                text: "Adding labels to the Windows print queue…",
                                kind: "info",
                            });
                        },
                    });
                    try {
                        await batch.begin();
                        validateSpoolHexRows(snapshot, startRowIdx, selectedQuantity, rowStep);
                        const prepared = await runPrintJob(async (payload, meta) => {
                            await batch.append(payload, Math.abs(meta.labelTo - meta.labelFrom) + 1);
                            return { stagedBytes: payload.byteLength };
                        }, { sourceDoc: snapshot, staging: true });
                        await batch.commit();
                        return prepared;
                    } catch (error) {
                        await batch.cancelPreparation();
                        throw error;
                    }
                },
                (jobsAhead) => setStatus({
                    text: `Queued behind ${jobsAhead} job(s) for ${target.printerName}.`,
                    kind: "info",
                }),
            );
            track("print_succeeded", {
                bytes: summary.bytesWritten,
                copies: selectedQuantity,
                language: "zpl",
            });
            setStatus({
                text:
                    `Queued ${selectedQuantity} labels for ${printerSettings.printerName}. Windows will send them to the printer in order.`
                    + (summary.warnings.length > 0
                        ? ` Warning: ${summary.warnings.join(" ")}`
                        : ""),
                kind: summary.warnings.length > 0 ? "info" : "ok",
            });
        } catch (err) {
            const detail = errorDetail(err);
            track("print_failed", { message: detail });
            setStatus({
                text: err instanceof RawSpoolBatchPendingError
                    ? "An earlier job needs attention. Open Print history below."
                    : "Could not queue the labels. Check the printer connection and Print history below.",
                detail,
                kind: err instanceof RawSpoolBatchPendingError ? "info" : "error",
            });
        } finally {
            releasePrintOperation();
            setBusy(false);
        }
    };

    const onTcpPrint = async () => {
        if (printIsBlocked) {
            setStatus({ text: productionBlockReason || "Check the quantity and RFID capture connection before printing.", kind: "error" });
            return;
        }
        if (!printerSettings.tcpHost.trim()) {
            setStatus({ text: "Enter the Zebra printer IP address first.", kind: "error" });
            return;
        }
        if (!acquirePrintOperation()) return;
        setLastFleetJobId("");
        const releasePreparation = registerPrinterPreparation();
        track("print_started", {
            copies: selectedQuantity,
            mode: "tcp",
            language: "zpl",
        });
        let tcpJob: TcpPrintJob | undefined;
        let productionRun: Awaited<ReturnType<typeof prepareProductionRoll>> | undefined;
        const printDoc = structuredClone(doc);
        // A template loaded with capture disabled must not switch off logging
        // in the middle of an already open roll.
        if (captureEnabled) printDoc.settings.rfid.captureToHost = true;
        const captureBank = printDoc.settings.rfid.enabled ? "EPC" : printDoc.settings.rfid.readBank ?? "EPC";
        const captureJobId = captureEnabled ? crypto.randomUUID() : undefined;
        let labelTransferStarted = false;
        let labelsTransportAccepted = false;
        const cancellation = new PrintCancellation();
        const signal = cancellation.signal;
        setTcpCancellation(cancellation);
        setTcpCancelRequested(false);
        try {
            setBusy(true);
            if (productionMode) {
                productionRun = await prepareProductionRoll(printerSettings.printAgentUrl, printDoc, selectedQuantity,
                    { host: printerSettings.tcpHost, port: printerSettings.tcpPort }, productionContext?.rollId);
                selectProductionRoll(productionRun.roll.rollId);
                signal.throwIfAborted();
            }
            if (captureEnabled && captureJobId && productionRun && printerSettings.tcpExecutionMode !== "server") {
                const agent = printerSettings.printAgentUrl;
                let receipt = await fleetRequest(agent, "spool-create", {
                    jobId: captureJobId, host: printerSettings.tcpHost, port: printerSettings.tcpPort,
                    windowLabels: Math.min(20, tcpBufferedFormatBudget(printDoc.settings)),
                    capture: {
                        productionRollId: productionRun.roll.rollId,
                        templateFingerprint: productionRun.runIdentity.templateFingerprint,
                        allowTemplateRevision: true, configurationSnapshot: productionTemplateContent(printDoc),
                        requireZeroBaseline: productionRun.roll.runs.length === 0,
                        auditBatchCounters: true, operationMode: productionOperationMode(printDoc),
                        expectedLabels: selectedQuantity, firstRow: startRowIdx + 1, rowStep,
                        bank: captureBank, templateName: printDoc.name,
                        expectedHexChars: printDoc.settings.rfid.enabled || captureBank === "EPC" && (printDoc.settings.rfid.zebraEpcReadMode ?? "pc") === "pc"
                            ? 0 : zebraRfidFixedReadByteCount(printDoc.settings.rfid) * 2,
                    },
                });
                setLastFleetJobId(captureJobId);
                let chunks = 0;
                let commitAttempted = false;
                try {
                    setStatus({ text: "Đang chuẩn bị tem đầu tiên…", kind: "info" });
                    await runPrintJob(async payload => {
                        signal.throwIfAborted();
                        receipt = await stageFleetChunk(agent, captureJobId, ++chunks, payload);
                        if (chunks === 1) {
                            signal.throwIfAborted();
                            await fleetRequest(agent, "spool-start", { jobId: captureJobId });
                            window.dispatchEvent(new Event("zbre-fleet-refresh"));
                        }
                        return { bytesWritten: payload.length };
                    }, { sourceDoc: printDoc, hostSpool: true, buffered: true, signal, captureJobId });
                    signal.throwIfAborted();
                    // Seal the producer's exact manifest. A lost seal receipt is
                    // not permission to replay a chunk or start a second run.
                    cancellation.seal(); setTcpCancellation(null); commitAttempted = true;
                    receipt = await fleetRequest(agent, "spool-commit", { jobId: captureJobId,
                        expectedSequence: chunks, expectedBytes: receipt.job.bytes, checkpointHash: receipt.job.checkpoint });
                    setStatus(fleetNotice(receipt.job, false));
                } catch (error) {
                    if (!commitAttempted) {
                        await fleetRequest(agent, "spool-cancel", { jobId: captureJobId }).catch(() => undefined);
                    }
                    setStatus({ text: signal.aborted ? "Đã yêu cầu dừng lượt. Theo dõi kết quả tại bảng máy in."
                        : "Lượt in cần kiểm tra. Xem trạng thái máy và số tem đã in trước khi gửi tiếp.", detail: errorDetail(error), kind: signal.aborted ? "info" : "error" });
                }
                window.dispatchEvent(new Event("zbre-fleet-refresh"));
                return;
            }
            const outcome = await runExclusivePrinterJob(
                tcpPrinterQueueKey(
                    printerSettings.tcpHost,
                    printerSettings.tcpPort,
                ),
                async () => {
                    try {
                        signal.throwIfAborted();
                        let activeExecution = "";
                        let submittedRange: PrintChunkMeta | undefined;
                        let recoveredFinish: TcpPrintJobFinishReceipt | undefined;
                        const recoverCompletedRun = async (): Promise<boolean> => {
                            if (!captureEnabled || !tcpJob || signal.aborted) return false;
                            // This path is called only after the final payload.
                            // Seal the same cancel boundary used by normal finish.
                            cancellation.seal();
                            setTcpCancellation(null);
                            recoveredFinish = await tcpJob.finishFromCounterProof();
                            return !!recoveredFinish;
                        };
                        const activeSummary = await runPrintJob(async (payload, meta) => {
                            signal.throwIfAborted();
                            if (!tcpJob) {
                                tcpJob = await TcpPrintJob.open({
                                    jobId: captureJobId,
                                    capture: captureEnabled ? {
                                        ...(productionRun ? {
                                            productionRollId: productionRun.roll.rollId,
                                            templateFingerprint: productionRun.runIdentity.templateFingerprint,
                                            allowTemplateRevision: true, configurationSnapshot: productionTemplateContent(printDoc),
                                        } : {}),
                                        auditBatchCounters: true,
                                        operationMode: productionOperationMode(printDoc),
                                        expectedLabels: selectedQuantity, firstRow: startRowIdx + 1, rowStep,
                                        bank: captureBank, templateName: printDoc.name,
                                        expectedHexChars: printDoc.settings.rfid.enabled || captureBank === "EPC" && (printDoc.settings.rfid.zebraEpcReadMode ?? "pc") === "pc"
                                            ? 0 : zebraRfidFixedReadByteCount(printDoc.settings.rfid) * 2,
                                    } : undefined,
                                    host: printerSettings.tcpHost,
                                    port: printerSettings.tcpPort,
                                    agentUrl: printerSettings.printAgentUrl,
                                    executionMode: printerSettings.tcpExecutionMode,
                                    connectTimeoutMs: 10_000,
                                    writeTimeoutMs: 60_000,
                                    idleTimeoutMs: 10 * 60_000,
                                    onRetry: (
                                        action,
                                        attempt,
                                        maxAttempts,
                                        delayMs,
                                    ) => {
                                        if (signal.aborted) return;
                                        setStatus({
                                            text:
                                                `Persistent TCP ${action} response was interrupted `
                                                + `at chunk ${chunkOrdinal(meta)}. Retrying the same `
                                                + `job/checkpoint ${attempt}/${maxAttempts} in `
                                                + `${Math.ceil(delayMs / 1000)} s…`,
                                            kind: "info",
                                        });
                                    },
                                });
                                if (stoppedTcpKind === "service-fault") setStoppedTcpJobId("");
                                if (captureEnabled) {
                                    setStatus({ text: "Connector đang kiểm tra máy và lưu số đếm đầu lượt…", kind: "info" });
                                    await waitForZebraDrainBarrier((command) => tcpJob!.query(command), { signal });
                                }
                            }
                            signal.throwIfAborted();
                            // Rendering may take time after the preceding chunk's
                            // barrier. Check again before admitting any new labels,
                            // including while the printer is paused for service.
                            await waitForZebraDrainBarrier((command) => tcpJob!.query(command), {
                                signal,
                                maxBufferedFormats: staticRepeatSafe ? 1 : Math.max(0,
                                    tcpBufferedFormatBudget(doc.settings) - dynamicChunkLabelLimit(doc.settings, true)),
                                onStateChange: (state) => {
                                    setPrinterPaused(state === "paused");
                                    if (state === "paused") setStatus({
                                        text: "Printer paused. The next chunk is held; head / media / ribbon faults will stop and clear this run.",
                                        kind: "info",
                                    });
                                },
                            });
                            signal.throwIfAborted();
                            labelTransferStarted = true;
                            const result = await tcpJob.append(payload);
                            labelsTransportAccepted = true;
                            signal.throwIfAborted();
                            submittedRange = { ...meta, labelFrom: submittedRange?.labelFrom ?? meta.labelFrom };
                            activeExecution =
                                tcpJob.execution === "connector"
                                    ? "local connector"
                                    : "local Next server";
                            let warning: string | undefined;
                            try { warning = await verifyPrinterBarrier(
                                (command) => tcpJob!.query(command, {
                                    readWindowMs: ZEBRA_STATUS_READ_WINDOW_MS,
                                    readIdleMs: ZEBRA_STATUS_READ_IDLE_MS,
                                }),
                                submittedRange,
                                result.bytesWritten,
                                // Reserve room for the next complete chunk. Static
                                // ^PQ windows occupy one format regardless of copies.
                                staticRepeatSafe ? 1 : Math.max(0,
                                    tcpBufferedFormatBudget(doc.settings) - dynamicChunkLabelLimit(doc.settings, true)),
                                signal,
                            ); } catch (error) {
                                if (!meta.finalChunk || !await recoverCompletedRun()) throw error;
                                warning = "Mất phản hồi trạng thái sau khi connector đã chốt đủ counter. Đã hoàn tất lượt bằng bằng chứng đã lưu; kết nối máy hiện tại chưa được xác nhận.";
                            }
                            return { bytesWritten: result.bytesWritten, warning };
                        }, { sourceDoc: printDoc, buffered: true, signal, captureJobId });
                        signal.throwIfAborted();
                        if (!tcpJob) {
                            throw new Error("Persistent TCP job did not open.");
                        }
                        if (submittedRange && !recoveredFinish) {
                            try {
                                const warning = await verifyPrinterBarrier(
                                    (command) => tcpJob!.query(command, {
                                        readWindowMs: ZEBRA_STATUS_READ_WINDOW_MS,
                                        readIdleMs: ZEBRA_STATUS_READ_IDLE_MS,
                                    }), submittedRange, activeSummary.bytesWritten, undefined, signal,
                                );
                                if (warning) activeSummary.warnings.push(warning);
                            } catch (error) {
                                if (!await recoverCompletedRun()) throw new Error(`All labels ${submittedRange.labelFrom}–${submittedRange.labelTo} were transport-accepted, but physical completion is unverified. Reconcile printed/VOID labels before creating a new range. ${errorDetail(error)}`);
                                activeSummary.warnings.push("Mất phản hồi trạng thái sau khi connector đã chốt đủ counter. Lượt đã hoàn tất; kết nối máy hiện tại chưa được xác nhận.");
                            }
                        }
                        if (captureEnabled && !recoveredFinish) {
                            try {
                                setStatus({ text: "Connector đang thu phản hồi và chốt số đếm cuối lượt…", kind: "info" });
                                await tcpJob.waitForCapture(signal);
                            } catch (error) {
                                if (!await recoverCompletedRun()) throw error;
                                activeSummary.warnings.push("Lượt đã hoàn tất theo counter đã lưu trên connector; kết nối máy hiện tại chưa được xác nhận.");
                            }
                        }
                        cancellation.seal();
                        setTcpCancellation(null);
                        const finishReceipt = recoveredFinish ?? await tcpJob.finish();
                        if (captureEnabled) {
                            if (!finishReceipt.capture) throw new Error("RFID session final receipt is missing.");
                            activeSummary.warnings.push(...productionCaptureWarnings(finishReceipt.capture));
                        }
                        if (
                            finishReceipt.cumulativeBytes !== activeSummary.bytesWritten
                            || finishReceipt.chunksAccepted !== activeSummary.chunksAccepted
                        ) {
                            throw new Error(
                                "Persistent TCP finish checkpoint did not match the rendered batch.",
                            );
                        }
                        return {
                            cancelled: false as const,
                            summary: activeSummary,
                            execution: activeExecution,
                            tcpJobId: tcpJob.jobId,
                        };
                    } catch (error) {
                        // runPrintJob has joined its producer AND the current
                        // consumer. No label append can follow the clear command.
                        if (signal.aborted && !tcpJob?.serviceFault) {
                            if (!tcpJob) return { cancelled: true as const, paused: false };
                            try {
                                if (!labelTransferStarted) {
                                    await tcpJob.abort();
                                    return { cancelled: true as const, paused: false };
                                }
                                setStatus({ text: "Clearing the printer buffer… Keep the printer paused.", kind: "info" });
                                const cleared = await cancelTcpPrinterBuffer(tcpJob);
                                return { cancelled: true as const, paused: cleared.paused };
                            } catch (cancelError) {
                                await tcpJob.abort().catch(() => undefined);
                                throw cancelError;
                            }
                        }
                        if (tcpJob) {
                            await tcpJob.abort().catch(() => undefined);
                        }
                        throw error;
                    }
                },
                (jobsAhead) => setStatus({
                    text:
                        `Queued behind ${jobsAhead} job(s) for `
                        + `${printerSettings.tcpHost}:${printerSettings.tcpPort}.`,
                    kind: "info",
                }),
                signal,
            );

            if (outcome.cancelled) {
                setStoppedTcpJobId("");
                setStatus({
                    text: labelTransferStarted
                        ? "Batch cancelled. Unsent labels were discarded and the printer buffer is empty. Select a new range when ready."
                            + (outcome.paused ? " The printer is still paused." : "")
                        : "Batch cancelled before sending labels. Select a new range when ready.",
                    kind: "info",
                });
                track("print_cancelled", { mode: "tcp", bufferCleared: labelTransferStarted });
                return;
            }
            const { summary, execution, tcpJobId } = outcome;
            track("print_succeeded", {
                bytes: summary.bytesWritten,
                copies: selectedQuantity,
                language: "zpl",
            });
            setStatus({
                text:
                    `Sent ${selectedQuantity} labels to ${printerSettings.tcpHost}.`
                    + (captureEnabled ? ` Saved ${tcpJob?.capture?.uniqueLabels ?? 0} ${captureBank} ${printDoc.settings.rfid.enabled ? "write verifications" : "reads"}.` : "")
                    + (summary.warnings.length ? ` Warning: ${summary.warnings.join(" ")}` : ""),
                detail:
                    `Transport accepted ${summary.chunksAccepted}/${summary.totalChunks} TCP `
                    + `checkpoint(s) over one persistent socket through ${execution} to `
                    + `${printerSettings.tcpHost}:${printerSettings.tcpPort} `
                    + `(${summary.bytesWritten} bytes, job ${tcpJobId})`
                    + (captureEnabled && tcpJob?.capture?.audit?.finalizationStatus === "verified"
                        ? ". Connector đã xác nhận số đếm cuối của lượt; đây không phải kiểm tra kết nối máy hiện tại."
                        : ". Bytes sent does not confirm physical completion.")
                    + (summary.warnings.length ? ` Warning: ${summary.warnings.join(" ")}` : ""),
                kind: summary.warnings.length ? "info" : "ok",
            });
        } catch (err) {
            if (signal.aborted && !tcpJob && !labelTransferStarted) {
                setStatus({ text: "Batch cancelled before sending labels. Select a new range when ready.", kind: "info" });
                return;
            }
            if (tcpJob) {
                setStoppedTcpJobId(tcpJob.jobId, /Media out|Ribbon out|Printhead open/i.test(tcpJob.serviceFault)
                    ? "service-fault" : signal.aborted ? "cancelled" : "interrupted");
                try {
                    await tcpJob.abort();
                } catch {
                    // Keep the original failure. The session will also expire
                    // server-side; already accepted printer bytes cannot be
                    // withdrawn by an abort.
                }
            }
            const detail = errorDetail(err);
            track("print_failed", { message: detail });
            const noLabelsSent = !labelTransferStarted || (!labelsTransportAccepted && err instanceof TcpPrintJobError && err.outcome === "not_sent");
            setStatus({
                text:
                    noLabelsSent
                        ? "Chưa gửi lệnh in. Xem lý do bên dưới và xử lý hồ sơ cuộn hoặc kết nối trước khi thử lại."
                        : tcpJob?.serviceFault && /Media out|Ribbon out|Printhead open/i.test(tcpJob.serviceFault)
                        ? "Printer stopped: check media, ribbon and printhead. Check retained labels and GOOD before printing the remaining quantity."
                        : tcpJob?.serviceFault
                        ? "A printer fault or lost status stopped this run. "
                            + (tcpJob.faultClearRequested ? "Pause and buffer clear were requested. " : "Pause / buffer clear could not be confirmed. ")
                            + "Do not resume the old run. Keep the printer paused, clear and inspect remaining labels, then reconcile below."
                        : signal.aborted
                        ? "Sending stopped, but the printer buffer could not be confirmed empty. Keep the printer paused, hold CANCEL (X) for two seconds, then close the stopped job below."
                        : "Printing was interrupted. Check the last printed label before continuing.",
                detail:
                    `TCP print failed${tcpJob ? ` [job ${tcpJob.jobId}]` : ""} `
                    + `- ${detail}`,
                kind: "error",
            });
        } finally {
            releasePreparation();
            setTcpCancellation(null);
            setTcpCancelRequested(false);
            setRfidHistoryRevision((value) => value + 1);
            setPrinterPaused(false);
            releasePrintOperation();
            setBusy(false);
        }
    };

    const onPrint = async () => {
        console.log("[print] onPrint clicked — connection:", connection?.label ?? "(none)");
        if (!connection) {
            setStatus({ text: "Connect a printer first.", kind: "error" });
            return;
        }
        if (!acquirePrintOperation()) return;
        track("print_started", {
            copies: selectedQuantity,
            mode: "zpl-full",
            language: "zpl",
        });
        try {
            setBusy(true);
            console.log("[print] connection state — readable:", !!connection.port.readable, "writable:", !!connection.port.writable);
            const summary = await runExclusivePrinterJob(
                connection.port,
                () => runPrintJob(async (payload, meta) => {
                    const bytesWritten = await sendBytes(connection, payload);
                    const warning = await verifyPrinterBarrier(
                        (command) => sendTextAndRead(connection, command,
                            ZEBRA_STATUS_READ_WINDOW_MS, ZEBRA_STATUS_READ_IDLE_MS),
                        meta,
                        bytesWritten,
                    );
                    return { bytesWritten, warning };
                }),
                (jobsAhead) => setStatus({
                    text: `Queued behind ${jobsAhead} COM job(s) for ${connection.label}.`,
                    kind: "info",
                }),
            );
            console.log("[print] onPrint success — sent", summary.bytesWritten, "bytes");
            track("print_succeeded", {
                bytes: summary.bytesWritten,
                copies: selectedQuantity,
                language: "zpl",
            });
            setStatus({
                text:
                    `Sent ${summary.chunksAccepted}/${summary.totalChunks} COM `
                    + `chunk(s), ${summary.bytesWritten} bytes `
                    + `(${selectedQuantity} ${selectedQuantity === 1 ? "label" : "labels"})`
                    + ". Bytes sent does not confirm physical completion."
                    + (summary.warnings.length ? ` Warning: ${summary.warnings.join(" ")}` : ""),
                kind: summary.warnings.length ? "info" : "ok",
            });
        } catch (err) {
            const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
            console.error("[print] onPrint failed:", detail);
            track("print_failed", { message: detail });
            setStatus({
                text: `Print failed - ${detail} (check console for details)`,
                kind: "error",
            });
        } finally {
            releasePrintOperation();
            setBusy(false);
        }
    };

    const onDownload = async () => {
        const estimatedBytes = staticRepeatSafe
            ? estimatedExpandedLabelBytes(doc.settings)
            : estimatedExpandedLabelBytes(doc.settings) * selectedQuantity;
        if (estimatedBytes > MAX_ZPL_DOWNLOAD_ESTIMATE_BYTES) {
            setStatus({
                text:
                    "This dynamic .zpl export is estimated to exceed 64 MiB. "
                    + "Print it through TCP/IP, COM, or Windows RAW so chunks "
                    + "can be streamed without exhausting browser memory.",
                kind: "error",
            });
            return;
        }
        if (!acquirePrintOperation()) return;
        try {
            setBusy(true);
            const chunks: Uint8Array[] = [];
            const summary = await runPrintJob(async (payload) => {
                chunks.push(payload);
                return { bytesWritten: payload.byteLength };
            });
            const filename = `${doc.name.replace(/\s+/g, "_")}.zpl`;
            downloadFileParts(filename, chunks, "application/octet-stream");
            track("zpl_downloaded", {
                filename,
                bytes: summary.bytesWritten,
                language: "zpl",
            });
            setStatus({
                text:
                    `Downloaded ${filename} (${summary.totalChunks} chunk(s), `
                    + `${summary.bytesWritten} bytes)`
                    + (summary.warnings.length ? ` Warning: ${summary.warnings.join(" ")}` : ""),
                kind: summary.warnings.length ? "info" : "ok",
            });
        } catch (err) {
            setStatus({
                text: err instanceof Error ? err.message : "Download failed",
                kind: "error",
            });
        } finally {
            releasePrintOperation();
            setBusy(false);
        }
    };

    const onExportPdf = () => {
        if (!quantityIsValid) {
            setStatus({
                text: "Enter a positive whole number of labels.",
                kind: "error",
            });
            return;
        }
        if (selectedQuantity > MAX_BROWSER_PRINT_LABELS) {
            setStatus({
                text:
                    `Browser print is limited to ${MAX_BROWSER_PRINT_LABELS} labels `
                    + "to avoid freezing the page. Use TCP/IP, COM, or Windows RAW "
                    + "for larger lots.",
                kind: "error",
            });
            return;
        }
        const hasFeed = hasDataFeed;
        let next: PdfExportRange;
        if (hasFeed) {
            next = {
                kind: "feed",
                fromIdx: selectedFeedRange.fromIdx,
                toIdx: selectedFeedRange.toIdx,
            };
        } else {
            next = { kind: "copies", count: selectedQuantity };
        }
        const count =
            next.kind === "feed" ? Math.abs(next.toIdx - next.fromIdx) + 1 : next.count;
        track("pdf_export_started", { count, mode: hasFeed ? "feed" : "copies" });
        setPdfRange(next);
        setStatus({
            text: `Preparing PDF (${count} ${count === 1 ? "label" : "labels"})…`,
            kind: "info",
        });
    };

    const onDownloadJson = () => {
        const safeName =
            (doc.name || "label-template")
                .replace(/[^A-Za-z0-9_\-]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .toLowerCase() || "label-template";
        track("template_exported", {
            template_id: doc.id,
            template_name: doc.name,
            filename: `${safeName}.nwl`,
        });
        downloadFile(`${safeName}.nwl`, exportToJson(doc), "application/json");
        setStatus({ text: `Downloaded ${safeName}.nwl`, kind: "ok" });
    };

    const onSaveTemplate = () => {
        const saved = onSaveCurrent();
        setStatus({ text: `Saved "${saved.name}" to your templates`, kind: "ok" });
    };

    const onPublishApiProfile = async () => {
        try {
            setBusy(true);
            const saved = onSaveCurrent();
            const res = await fetch("/api/integration/profiles", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    profileId: saved.id,
                    name: saved.name,
                    template: saved,
                    overwrite: true,
                }),
                cache: "no-store",
            });
            const json = (await res.json().catch(() => null)) as
                | {
                      ok?: boolean;
                      error?: string;
                      profile?: { profileId?: string };
                      endpoints?: { print?: string };
                  }
                | null;
            if (!res.ok || !json?.ok) {
                throw new Error(json?.error || `Publish failed with HTTP ${res.status}`);
            }
            const profileId = json.profile?.profileId || saved.id;
            const endpoint = json.endpoints?.print || `/api/integration/profiles/${profileId}/print`;
            const origin = typeof window !== "undefined" ? window.location.origin : "";
            setStatus({
                text: `Published API profile "${profileId}". Customer print endpoint: ${origin}${endpoint}`,
                kind: "ok",
            });
        } catch (err) {
            setStatus({
                text: err instanceof Error ? err.message : "Publish API profile failed",
                kind: "error",
            });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex-1 overflow-auto bg-muted/30">
            <div className="max-w-7xl mx-auto px-6 py-8">
                <div className="mb-6">
                    <div className="flex items-center gap-3 flex-wrap">
                        <h2 className="text-2xl font-semibold tracking-tight">Ready to print</h2>
                        {doc.settings.rfid.enabled ? (
                            <span
                                className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-mono font-semibold bg-muted text-muted-foreground border"
                                title={`RFID encoding ON · ${doc.settings.rfid.epcBits}-bit EPC · format ${doc.settings.rfid.format}`}
                            >
                                RFID ENCODE
                            </span>
                        ) : (
                            <span
                                className="inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-mono font-semibold bg-muted text-muted-foreground border"
                                title="RFID encoding is off - labels will print without writing to the chip"
                            >
                                {doc.settings.rfid.readEnabled ? "RFID READ" : "NON-RFID"}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">
                        Review the label, choose a range, and send the ZPL II job.
                    </p>
                </div>

                {outOfBounds.length > 0 && (
                    <div className="mb-4 space-y-2">
                        {outOfBounds.length > 0 && (
                            <div className="flex items-start gap-2 rounded-md border border-amber-300/60 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-700/50 px-3 py-2 text-sm">
                                <AlertCircle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
                                <div>
                                    <div className="font-medium text-amber-900 dark:text-amber-200">
                                        {outOfBounds.length} element{outOfBounds.length === 1 ? "" : "s"} extend past the label
                                    </div>
                                    <ul className="mt-1 text-xs text-amber-800 dark:text-amber-300 space-y-0.5">
                                        {outOfBounds.map(({
                                            el,
                                            overflowLeft,
                                            overflowTop,
                                            overflowRight,
                                            overflowBottom,
                                        }) => (
                                            <li key={el.id} className="font-mono">
                                                {el.kind} ({el.id.slice(0, 8)}…)
                                                {overflowLeft > 0.001 ? ` · ${overflowLeft.toFixed(1)}mm left` : ""}
                                                {overflowTop > 0.001 ? ` · ${overflowTop.toFixed(1)}mm above` : ""}
                                                {overflowRight > 0.001 ? ` · ${overflowRight.toFixed(1)}mm right` : ""}
                                                {overflowBottom > 0.001 ? ` · ${overflowBottom.toFixed(1)}mm below` : ""}
                                            </li>
                                        ))}
                                    </ul>
                                    <p className="mt-1 text-xs text-amber-800/80 dark:text-amber-300/80">
                                        Printing remains available when the frame still overlaps the label, so
                                        you can calibrate data-dependent RFID-read fields. Bitmap content is clipped
                                        to the label canvas; native RFID text, barcode, or QR output may extend based
                                        on the value read from the tag. Preserve barcode/QR quiet zones for reliable scanning.
                                    </p>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">
                    {/* Big preview */}
                    <div ref={previewColumnRef}>
                        <div className="flex items-center justify-end mb-2 gap-1">
                            <Button
                                size="sm"
                                variant={viewMode === "single" ? "default" : "outline"}
                                onClick={() => setViewMode("single")}
                            >
                                Single
                            </Button>
                            <Button
                                size="sm"
                                variant={viewMode === "roll" ? "default" : "outline"}
                                onClick={() => setViewMode("roll")}
                                disabled={copyCount < 2}
                                title={copyCount < 2 ? "Increase Copies to see roll view" : undefined}
                            >
                                Roll ({copyCount})
                            </Button>
                        </div>
                        {viewMode === "single" ? (
                            <div
                                className="rounded-[12px] border border-border bg-card text-card-foreground shadow-sm p-6 flex items-center justify-center overflow-auto"
                                data-testid="print-preview-card"
                            >
                                <SinglePreview
                                    doc={doc}
                                    copyIndex={safePreviewIndex}
                                    displayWidthPx={previewWidth}
                                />
                            </div>
                        ) : (
                            <RollPreview
                                doc={doc}
                                copyCount={copyCount}
                                startCopyIndex={hasDataFeed ? selectedFeedRange.fromIdx : 0}
                                copyStep={rowStep}
                                maxWidthPx={columnWidth}
                            />
                        )}

                        {viewMode === "single" && (() => {
                            const hasFeed = hasDataFeed;
                            if (hasFeed) {
                                return (
                                    <div className="mt-3">
                                        <RowsTable
                                            key={previewRangeKey}
                                            doc={doc}
                                            fromIdx={selectedFeedRange.fromIdx}
                                            toIdx={selectedFeedRange.toIdx}
                                            currentIdx={safePreviewIndex}
                                            onSelect={setPreviewIndex}
                                        />
                                    </div>
                                );
                            }
                            if (copyCount > 1) {
                                return (
                                    <CopyPaginator
                                        copyCount={copyCount}
                                        index={safePreviewIndex}
                                        onChange={setPreviewIndex}
                                        doc={doc}
                                    />
                                );
                            }
                            return null;
                        })()}

                        <div className="flex items-center justify-between mt-3 text-xs font-mono text-muted-foreground px-1">
                            <span>
                                {doc.settings.widthMm}×{doc.settings.heightMm} mm @{" "}
                                {doc.settings.dpi} dpi
                                {copyCount > 1 && (
                                    hasDataFeed
                                        ? ` · Row ${safePreviewIndex + 1} · `
                                            + `${(safePreviewIndex - selectedFeedRange.fromIdx) * rowStep + 1}`
                                            + ` of ${copyCount} selected`
                                        : ` · Copy ${safePreviewIndex + 1} of ${copyCount}`
                                )}
                            </span>
                            <span>
                                {doc.elements.length} elements · {sourcePreview.length} chars
                            </span>
                        </div>
                        <div className="mt-4">
                            <ZplPreview zpl={sourcePreview} defaultOpen={false} />
                        </div>
                    </div>

                    {/* Print card */}
                    <div
                        className="rounded-[12px] border border-border bg-card text-card-foreground shadow-sm p-5 space-y-5 sticky top-4"
                        data-testid="print-settings-card"
                    >
                        <div className="space-y-2">
                            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                                Print job
                            </h3>
                            <PrintPrinterPicker settings={printerSettings}
                                onChange={(patch) => {
                                    if (patch.connectionMode && connection) void disconnectSerialPort();
                                    setStatus({ text: "", kind: "info" });
                                    onUpdatePrinterSettings(patch);
                                }} printers={windowsPrinters} loading={printerListLoading}
                                disabled={busy || serialAction !== null}
                                onRefresh={() => { windowsPrintersUrlRef.current = ""; setPrinterListRevision((value) => value + 1); }} />
                            <div className="rounded-lg border border-border bg-muted/35 px-3 py-2.5 text-xs">
                                <div className="flex items-center justify-between gap-3">
                                    <span className="font-semibold text-foreground">
                                        {targetPrinterProfile.label} · {doc.settings.dpi} dpi
                                    </span>
                                    <span className="font-mono text-muted-foreground">
                                        {doc.settings.widthMm}×{doc.settings.heightMm} mm
                                    </span>
                                </div>
                                <div className="mt-1 flex items-center gap-2 text-muted-foreground">
                                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                                    <span className="font-medium text-foreground">{transport.label}</span>
                                    <span className="min-w-0 truncate font-mono">{transportTarget}</span>
                                    <span className="ml-auto shrink-0">ZPL II</span>
                                </div>
                            </div>
                            {previewPrintWarnings.length > 0 && (
                                <div
                                    role="status"
                                    data-testid="print-calibration-warnings"
                                    className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200"
                                >
                                    <div className="flex items-start gap-2">
                                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                        <div className="min-w-0 space-y-2">
                                            <p className="font-semibold">Print warnings</p>
                                            <p>
                                                {hasDataFeed ? `Preview row ${safePreviewIndex + 1}. ` : ""}
                                                Test 1–3 labels and check barcode readability.
                                            </p>
                                            <details>
                                                <summary className="cursor-pointer font-medium">
                                                    Warning details ({previewPrintWarnings.length})
                                                </summary>
                                                <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-auto pl-4">
                                                    {previewPrintWarnings.map((issue) => (
                                                        <li key={`${issue.code}:${issue.elementId ?? "label"}`}>
                                                            {issue.elementId && <span className="font-medium">{issue.elementId}: </span>}
                                                            {issue.message}
                                                        </li>
                                                    ))}
                                                </ul>
                                            </details>
                                        </div>
                                    </div>
                                </div>
                            )}
                            {windowsQueueDpiMismatch && (
                                <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                                    <div className="flex items-start gap-2">
                                        <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                        <div className="space-y-2">
                                            <p className="leading-relaxed">
                                                DPI mismatch: template is {doc.settings.dpi} dpi; the
                                                selected Windows queue appears to be {selectedPrinterDpi} dpi.
                                                Printing is blocked to prevent a physically mis-scaled label.
                                            </p>
                                            {canAdoptWindowsQueueDpi && selectedPrinterDpi && (
                                                <Button
                                                    type="button"
                                                    size="sm"
                                                    variant="outline"
                                                    className="h-8 border-amber-500/50 bg-background"
                                                    onClick={() =>
                                                        onUpdateSettings({ dpi: selectedPrinterDpi })
                                                    }
                                                >
                                                    Use {selectedPrinterDpi} dpi for template
                                                </Button>
                                            )}
                                            {!canAdoptWindowsQueueDpi && (
                                                <p className="text-[11px] leading-snug">
                                                    This DPI is not valid for the selected target model. Choose
                                                    the correct model or Windows queue in Edit.
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}
                            {busy && printerPaused && (
                                <div role="status" data-testid="printer-pause-notice"
                                    className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                                    <p className="font-semibold">{tcpCancelRequested ? "Cancelling batch" : "Printer paused"}</p>
                                    {tcpCancelRequested
                                        ? <p>Keep the printer paused until cancellation finishes. The remaining labels will not be resumed.</p>
                                        : <>
                                            <p>To continue this batch, press PAUSE / Resume on the printer.</p>
                                            {printerSettings.connectionMode === "tcp" && <p className="mt-1">To discard the remaining labels, use Cancel batch below, including if you already held CANCEL (X) on the printer.</p>}
                                        </>}
                                </div>
                            )}
                            {printerSettings.connectionMode === "webserial" ? (
                                <div className="space-y-2">
                                    <div
                                        className={cn(
                                            "flex min-h-14 items-center justify-center rounded-lg border px-3 py-2 text-center text-xs",
                                            connection
                                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                                : "border-border bg-muted/25",
                                        )}
                                    >
                                        {connection ? (
                                            <div className="flex min-w-0 items-center gap-2 font-mono">
                                                <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
                                                <span className="truncate">
                                                    Connected · {connection.label} · {printerSettings.baudRate} baud
                                                </span>
                                            </div>
                                        ) : selectedPort ? (
                                            <div className="min-w-0">
                                                <div className="font-medium text-foreground">Port selected</div>
                                                <div className="truncate font-mono text-muted-foreground">
                                                    {selectedPort.label}
                                                </div>
                                            </div>
                                        ) : (
                                            <span className="text-muted-foreground">No port selected</span>
                                        )}
                                    </div>

                                    {!connection && (
                                        <div className="grid grid-cols-2 gap-2">
                                            <Button
                                                onClick={onSelectPort}
                                                disabled={!supported || busy || serialAction !== null}
                                                className="h-10"
                                                variant="outline"
                                            >
                                                {serialAction === "select" ? (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                ) : (
                                                    <Plug className="h-4 w-4" />
                                                )}
                                                Select Port
                                            </Button>
                                            <Button
                                                onClick={onConnect}
                                                disabled={
                                                    !supported
                                                    || busy
                                                    || serialAction !== null
                                                    || !selectedPort
                                                }
                                                className="h-10"
                                            >
                                                {serialAction === "connect" && (
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                )}
                                                Connect
                                            </Button>
                                        </div>
                                    )}

                                    <Button
                                        onClick={onPrint}
                                        disabled={
                                             !supported
                                             || !connection
                                             || busy
                                             || printIsBlocked
                                             || serialAction !== null
                                        }
                                        className="w-full h-11 text-base"
                                    >
                                        {busy ? (
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                        ) : (
                                            <Printer className="w-5 h-5" />
                                        )}
                                        <span className="ml-2">Print {selectedQuantity} {selectedQuantity === 1 ? "label" : "labels"}</span>
                                    </Button>
                                    {connection && (
                                        <Button
                                            variant="ghost"
                                            onClick={onDisconnect}
                                            disabled={busy || serialAction !== null}
                                            size="sm"
                                            className="w-full text-muted-foreground"
                                        >
                                            <PlugZap className="w-4 h-4" />
                                            Disconnect
                                        </Button>
                                    )}
                                    {!supported && (
                                        <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                                            COM printing requires Web Serial in Chrome or Edge over HTTPS / localhost.
                                        </div>
                                    )}
                                </div>
                            ) : printerSettings.connectionMode === "tcp" ? (
                                <div className="space-y-3">
                                    {fleetJob && <div data-testid="selected-fleet-job" className="rounded border p-3 text-xs space-y-2">
                                        <p className="font-medium">{printerSettings.tcpHost} · {fleetSnapshot?.stale ? "Mất kết nối theo dõi" : fleetJob.cancelRequested && isFleetActive(fleetJob) ? "Đang dừng…" : fleetStatusNames[fleetJob.state]}</p>
                                        {isFleetActive(fleetJob) && <p>Lượt {fleetJob.capture?.expectedLabels.toLocaleString()} tem được quản lý trên host; tối đa {fleetJob.windowLabels || 20} tem chờ xử lý.</p>}
                                        <FleetJobControls key={fleetJob.jobId} job={fleetJob} agent={printerSettings.printAgentUrl} stale={fleetSnapshot?.stale} />
                                        {fleetJob.error && <details><summary>Chi tiết lượt in</summary><p>{fleetJob.error}</p></details>}
                                    </div>}
                                    {!printerSettings.tcpHost.trim() && (
                                        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                                            TCP/IP is not configured. Update Target printer in Edit.
                                        </p>
                                    )}
                                    <Button
                                        onClick={onTcpPrint}
                                        disabled={
                                            busy
                                            || printIsBlocked
                                            || !printerSettings.tcpHost.trim()
                                            || (!!stoppedTcpJobId && stoppedTcpKind !== "service-fault")
                                        }
                                        className="w-full h-11 text-base"
                                    >
                                        {busy ? (
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                        ) : (
                                            <Printer className="w-5 h-5" />
                                        )}
                                        <span className="ml-2">Print {selectedQuantity} {selectedQuantity === 1 ? "label" : "labels"}</span>
                                    </Button>
                                    {busy && tcpCancellation && (
                                        <div className="space-y-1">
                                            <Button variant="outline" className="w-full" disabled={tcpCancelRequested}
                                                onClick={() => {
                                                    if (!tcpCancellation.request()) return;
                                                    setTcpCancelRequested(true);
                                                    setStatus({ text: "Cancelling batch… Waiting for the current transfer to stop, then clearing the printer buffer.", kind: "info" });
                                                }}>
                                                {tcpCancelRequested ? "Cancelling batch…" : "Cancel batch"}
                                            </Button>
                                            <p className="text-xs text-muted-foreground">Stops unsent labels and clears the printer buffer. Already printed labels remain printed.</p>
                                        </div>
                                    )}
                                    <TcpJobReconciliation
                                        key={`${stoppedTcpJobId}:${printerSettings.tcpHost}:${printerSettings.tcpPort}:${printerSettings.printAgentUrl}:${printerSettings.tcpExecutionMode}`}
                                        settings={printerSettings} stoppedJobId={stoppedTcpJobId} disabled={busy}
                                        kind={stoppedTcpKind}
                                        onResolved={() => {
                                            setStoppedTcpJobId("");
                                            setStatus({ text: "Đã giải phóng khóa phiên truyền; lịch sử vẫn được giữ. Thao tác này không xác nhận số đếm cuộn. Kiểm tra Lượt chưa đối soát và tem thực tế trước khi chọn phạm vi in mới.", kind: "info" });
                                        }}
                                    />
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    {!printerSettings.printerName.trim() && (
                                        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                                            Select a Windows printer above.
                                        </p>
                                    )}
                                    {printerListLoading && (
                                        <p className="text-[11px] text-muted-foreground">Checking the selected Windows queue…</p>
                                    )}
                                    {selectedPrinterWarning && (
                                        <p className="rounded border border-amber-500/35 bg-amber-500/10 px-2 py-1.5 text-[11px] leading-snug text-amber-800 dark:text-amber-200">
                                            {selectedPrinterWarning}
                                        </p>
                                    )}
                                    <Button
                                        onClick={onWindowsRawPrint}
                                        disabled={
                                             busy
                                             || printIsBlocked
                                             || !printerSettings.printerName.trim()
                                            || printerListLoading
                                            || !selectedWindowsPrinter
                                            || windowsQueueDpiMismatch
                                        }
                                        className="w-full h-11 text-base"
                                    >
                                        {busy ? (
                                            <Loader2 className="w-5 h-5 animate-spin" />
                                        ) : (
                                            <Printer className="w-5 h-5" />
                                        )}
                                        <span className="ml-2">Print {selectedQuantity} {selectedQuantity === 1 ? "label" : "labels"}</span>
                                    </Button>
                                </div>
                            )}
                        </div>

                        <Separator />

                        <div>
                            <h3 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                                {hasDataFeed ? "Print range" : "Lot quantity"}
                            </h3>
                            <div className="space-y-3">
                                {hasDataFeed ? (
                                    <div className="space-y-2">
                                        <div className="grid grid-cols-3 gap-1">
                                            <Button
                                                size="sm"
                                                variant={rangeMode === "all" ? "default" : "outline"}
                                                onClick={() => setRangeMode("all")}
                                            >
                                                All
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant={rangeMode === "first" ? "default" : "outline"}
                                                onClick={() => setRangeMode("first")}
                                            >
                                                First N
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant={rangeMode === "range" ? "default" : "outline"}
                                                onClick={() => setRangeMode("range")}
                                            >
                                                From–To
                                            </Button>
                                        </div>
                                        {rangeMode === "all" && (
                                            <p className="text-[11px] text-muted-foreground">
                                                All {totalRows} {totalRows === 1 ? "label" : "labels"}
                                            </p>
                                        )}
                                        {rangeMode === "first" && (
                                            <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                                                <NumField
                                                    label="First"
                                                    value={firstN}
                                                    min={1}
                                                    max={totalRows}
                                                    onChange={(n) => setFirstN(Math.max(1, Math.min(n, totalRows)))}
                                                />
                                                <span className="text-[11px] text-muted-foreground pb-2.5">of {totalRows}</span>
                                            </div>
                                        )}
                                        {rangeMode === "range" && (
                                            <>
                                                <div className="grid grid-cols-2 gap-2">
                                                    <NumField
                                                        label="From"
                                                        value={rangeFrom}
                                                        min={1}
                                                        max={totalRows}
                                                        onChange={(n) => setRangeFrom(Math.max(1, Math.min(n, totalRows)))}
                                                    />
                                                    <NumField
                                                        label="To"
                                                        value={rangeTo}
                                                        min={1}
                                                        max={totalRows}
                                                        onChange={(n) => setRangeTo(Math.max(1, Math.min(n, totalRows)))}
                                                    />
                                                </div>
                                                <p className="text-[11px] text-muted-foreground" data-testid="print-range-summary">
                                                    Rows {selectedFeedRange.fromIdx + 1} → {selectedFeedRange.toIdx + 1}
                                                    {" · "}{selectedQuantity} {selectedQuantity === 1 ? "label" : "labels"}
                                                    {" · "}{rowStep === -1 ? "Descending" : "Ascending"}
                                                </p>
                                            </>
                                        )}
                                    </div>
                                ) : (
                                    <NumField
                                        label="Labels"
                                        value={doc.settings.copies}
                                        min={1}
                                        max={MAX_PRINT_BATCH_QUANTITY}
                                        onChange={(copies) =>
                                            onUpdateSettings({
                                                copies: Math.max(
                                                    1,
                                                    Math.min(
                                                        MAX_PRINT_BATCH_QUANTITY,
                                                        Math.floor(copies),
                                                    ),
                                                ),
                                            })
                                        }
                                    />
                                )}

                                {!quantityIsValid && (
                                    <p className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300">
                                        Enter a positive whole number of labels.
                                    </p>
                                )}

                            </div>
                        </div>

                        <Separator />

                        <details className="group rounded-lg border border-border bg-muted/20">
                            <summary className="cursor-pointer select-none px-3 py-2.5 text-xs font-semibold text-muted-foreground marker:text-muted-foreground">
                                More actions
                            </summary>
                            <div className="space-y-2 border-t border-border p-3">
                                <Button
                                    variant="outline"
                                    onClick={onExportPdf}
                                    disabled={
                                        pdfRange !== null
                                        || busy
                                        || printIsBlocked
                                        || doc.settings.rfid.enabled
                                        || selectedQuantity > MAX_BROWSER_PRINT_LABELS
                                    }
                                    className="w-full h-10"
                                >
                                    {pdfRange !== null ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <FileText className="w-4 h-4" />
                                    )}
                                    Print via browser
                                </Button>
                                {doc.settings.rfid.enabled && (
                                    <p className="text-[11px] leading-snug text-muted-foreground">
                                        RFID requires the ZPL II connection.
                                    </p>
                                )}
                                {!doc.settings.rfid.enabled
                                    && selectedQuantity > MAX_BROWSER_PRINT_LABELS && (
                                    <p className="text-[11px] leading-snug text-muted-foreground">
                                        Browser print is limited to {MAX_BROWSER_PRINT_LABELS} labels.
                                        Use TCP/IP, COM or Windows RAW for larger lots.
                                    </p>
                                )}
                                <Button
                                    variant="outline"
                                    onClick={onDownload}
                                    disabled={busy || printIsBlocked}
                                    className="w-full h-10"
                                >
                                    <Download className="w-4 h-4" />
                                    Download .zpl
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={onDownloadJson}
                                    className="w-full h-10"
                                >
                                    <FileJson className="w-4 h-4" />
                                    Export template (.nwl)
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={onSaveTemplate}
                                    className="w-full h-10"
                                >
                                    <Save className="w-4 h-4" />
                                    Save template
                                </Button>
                                <Button
                                    variant="outline"
                                    onClick={onPublishApiProfile}
                                    disabled={busy}
                                    className="w-full h-10"
                                >
                                    {busy ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <UploadCloud className="w-4 h-4" />
                                    )}
                                    Publish API profile
                                </Button>
                            </div>
                        </details>

                        {captureTransportBlocked && <p className="text-xs text-destructive">Lưu CSV cần kết nối TCP qua local connector.</p>}
                        {(rfidOperationEnabled || productionOpen) && <label className="flex items-start gap-2 text-sm">
                            <input aria-label="Save roll CSV" type="checkbox" checked={captureEnabled || productionBound} disabled={busy || productionBound}
                                onChange={(event) => onUpdateSettings({ rfid: { ...doc.settings.rfid, captureToHost: event.target.checked } })} />
                            <span>Lưu dữ liệu / xuất CSV{productionBound && <small className="block text-muted-foreground">Đóng cuộn trước khi tắt lưu dữ liệu. CSV có thể xuất sau.</small>}</span>
                        </label>}
                        <ProductionRollPanel
                            key={`${printerSettings.printAgentUrl}:${printerSettings.tcpHost}:${printerSettings.tcpPort}`}
                            agentUrl={printerSettings.printAgentUrl} busy={busy}
                            doc={doc} printerHost={printerSettings.tcpHost} printerPort={printerSettings.tcpPort}
                            recordingEnabled={captureEnabled}
                            selectedRollId={selectedProductionRollId} onSelectRoll={selectProductionRoll}
                            revision={rfidHistoryRevision} onContextChange={setProductionContext}
                        />
                        {captureEnabled && doc.settings.rfid.enabled && productionContext?.hasCapturedRuns && <p className="text-xs text-amber-700 dark:text-amber-300">In bù: chọn đúng dòng EPC lỗi.</p>}
                        {productionBlockReason && <p className="text-xs text-destructive">{productionBlockReason}</p>}
                        {displayStatus.text && (
                            <div
                                className={cn(
                                    "rounded-md px-3 py-2 text-xs font-medium flex items-start gap-2",
                                    displayStatus.kind === "ok" &&
                                        "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
                                    displayStatus.kind === "error" &&
                                        "bg-destructive/10 text-destructive",
                                    displayStatus.kind === "info" &&
                                        "bg-muted text-muted-foreground",
                                )}
                            >
                                {displayStatus.kind === "ok" && (
                                    <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                )}
                                {displayStatus.kind === "error" && (
                                    <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                )}
                                {displayStatus.kind === "info" && (
                                    <Info className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                                )}
                                <div className="min-w-0 space-y-2">
                                    <p>{displayStatus.text}</p>
                                    {displayStatus.detail && <details>
                                        <summary className="cursor-pointer">Technical details</summary>
                                        <p className="mt-2 break-words font-normal">{displayStatus.detail}</p>
                                    </details>}
                                </div>
                            </div>
                        )}
                        {printerSettings.connectionMode === "windowsRaw" && <WindowsSpoolJobsPanel agentUrl={printerSettings.printAgentUrl} printerName={printerSettings.printerName} />}
                    </div>
                </div>
            </div>
            {pdfRange !== null && (
                <PdfExportFrame
                    doc={doc}
                    range={pdfRange}
                    headWidthMm={printerSettings.headWidthMm}
                    hAlign={printerSettings.hAlign}
                    fileName={(doc.name || "label") + ".pdf"}
                    onDone={() => {
                        const count =
                            pdfRange.kind === "feed"
                                ? Math.abs(pdfRange.toIdx - pdfRange.fromIdx) + 1
                                : pdfRange.count;
                        track("pdf_export_completed", { count });
                        setPdfRange(null);
                    }}
                />
            )}
        </div>
    );
}

function SinglePreview({
    doc,
    copyIndex,
    displayWidthPx,
}: {
    doc: LabelDoc;
    copyIndex: number;
    displayWidthPx: number;
}) {
    const displayHeightPx =
        displayWidthPx *
        (doc.settings.heightMm / Math.max(1, doc.settings.widthMm));

    return (
        <PrintFidelityPreview
            doc={doc}
            copyIndex={copyIndex}
            displayWidthPx={displayWidthPx}
            displayHeightPx={displayHeightPx}
        />
    );
}

function CopyPaginator({
    copyCount,
    index,
    onChange,
    doc,
}: {
    copyCount: number;
    index: number;
    onChange: (n: number) => void;
    doc: LabelDoc;
}) {
    const s = doc.settings.serial;
    const labelFor = (i: number) => {
        if (!s.enabled) return `${i + 1}`;
        const n = s.start + i * s.step;
        return `${s.prefix}${String(n).padStart(Math.max(1, s.pad), "0")}`;
    };
    // Show up to 12 chips inline; collapse with ... if more
    const maxChips = 10;
    const indices: number[] = [];
    if (copyCount <= maxChips) {
        for (let i = 0; i < copyCount; i += 1) indices.push(i);
    } else {
        const half = Math.floor(maxChips / 2) - 1;
        const start = Math.max(0, index - half);
        const end = Math.min(copyCount - 1, start + maxChips - 1);
        for (let i = start; i <= end; i += 1) indices.push(i);
        if (start > 0) indices.unshift(-1);
        if (end < copyCount - 1) indices.push(-2);
    }

    return (
        <div className="mt-3 flex items-center gap-1 overflow-x-auto">
            <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                disabled={index === 0}
                onClick={() => onChange(Math.max(0, index - 1))}
            >
                <ChevronLeft className="w-4 h-4" />
            </Button>
            <div className="flex items-center gap-1 px-1 flex-1 overflow-x-auto">
                {indices.map((i, k) =>
                    i < 0 ? (
                        <span
                            key={`gap${k}`}
                            className="px-2 text-xs text-muted-foreground"
                        >
                            …
                        </span>
                    ) : (
                        <button
                            key={i}
                            onClick={() => onChange(i)}
                            className={cn(
                                "h-8 px-2.5 rounded-md text-xs font-mono transition-colors whitespace-nowrap",
                                i === index
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted hover:bg-muted/70 text-foreground",
                            )}
                            title={`Copy ${i + 1}`}
                        >
                            {labelFor(i)}
                        </button>
                    ),
                )}
            </div>
            <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                disabled={index === copyCount - 1}
                onClick={() => onChange(Math.min(copyCount - 1, index + 1))}
            >
                <ChevronRight className="w-4 h-4" />
            </Button>
        </div>
    );
}

function RowsTable({
    doc,
    fromIdx,
    toIdx,
    currentIdx,
    onSelect,
}: {
    doc: LabelDoc;
    fromIdx: number;
    toIdx: number;
    currentIdx: number;
    onSelect: (idx: number) => void;
}) {
    const cols = doc.dataFeed?.columns ?? [];
    const range = selectPrintRowRange(doc.dataFeed?.rows.length ?? 0, fromIdx + 1, toIdx + 1);
    const rowHeight = 32;
    const overscan = 6;
    const maxHeight = 360;
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [containerH, setContainerH] = useState(maxHeight);

    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        const update = () => setContainerH(el.clientHeight);
        update();
        const obs = new ResizeObserver(update);
        obs.observe(el);
        return () => obs.disconnect();
    }, []);

    const totalH = range.quantity * rowHeight;
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const end = Math.min(
        range.quantity,
        Math.ceil((scrollTop + containerH) / rowHeight) + overscan,
    );
    const slice = Array.from({ length: Math.max(0, end - start) }, (_, i) => {
        const absIdx = printRowIndexAt(range, start + i);
        return { row: doc.dataFeed!.rows[absIdx], absIdx };
    });
    const gridCols = `60px repeat(${Math.max(1, cols.length)}, minmax(80px, 1fr))`;
    const rfid = doc.settings.rfid;
    const rfidSource = rfid.enabled
        ? rfidSourceName(rfid.data) ?? rfid.fieldName
        : undefined;
    const isRfidSourceColumn = (name: string) =>
        !!rfidSource && name.toLowerCase() === rfidSource.toLowerCase();

    return (
        <div
            className="rounded-[10px] border border-border bg-card text-card-foreground overflow-hidden"
            data-testid="print-data-rows"
        >
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-black/[0.06] dark:border-white/[0.06] bg-black/[0.02] dark:bg-white/[0.04] text-[11px] text-muted-foreground">
                <span>{range.quantity} {range.quantity === 1 ? "row" : "rows"} selected</span>
                <span>Click a row to preview</span>
            </div>
            <div
                className="grid border-b border-black/[0.06] dark:border-white/[0.06] text-[10px] uppercase tracking-wider text-muted-foreground bg-black/[0.02] dark:bg-white/[0.04]"
                style={{ gridTemplateColumns: gridCols }}
            >
                <div className="px-2 py-1.5">#</div>
                {cols.map((c) => (
                    <div key={c.id} className="px-2 py-1.5 truncate">
                        {c.name}
                    </div>
                ))}
            </div>
            <div
                ref={scrollRef}
                onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
                className="overflow-auto"
                style={{ maxHeight }}
            >
                <div style={{ height: totalH, position: "relative" }}>
                    {slice.map(({ row, absIdx }, i) => {
                        const localIdx = start + i;
                        const isActive = absIdx === currentIdx;
                        return (
                            <div
                                key={row.id}
                                data-row-index={absIdx}
                                onClick={() => onSelect(absIdx)}
                                className={cn(
                                    "absolute inset-x-0 grid items-center cursor-pointer text-xs font-mono border-b border-black/[0.04] dark:border-white/[0.04] last:border-b-0 hover:bg-accent",
                                    isActive && "bg-primary/10 ring-1 ring-primary/40",
                                )}
                                style={{
                                    top: localIdx * rowHeight,
                                    height: rowHeight,
                                    gridTemplateColumns: gridCols,
                                }}
                            >
                                <div className="px-2 truncate text-muted-foreground">
                                    {absIdx + 1}
                                </div>
                                {cols.map((c) => {
                                    const cell = doc.dataFeed
                                        ? evaluateCellForDisplay(doc.dataFeed, absIdx, c.id)
                                        : { display: row.cells[c.id] ?? "" };
                                    let display = cell.display;
                                    if (rfid.enabled && isRfidSourceColumn(c.name)) {
                                        display = rfidPayloadForPreview(rfid, display);
                                    }
                                    return (
                                        <div key={c.id} className="px-2 truncate">
                                            {display}
                                        </div>
                                    );
                                })}
                            </div>
                        );
                    })}
                </div>
            </div>
        </div>
    );
}

const ROLL_PREVIEW_MAX_BACKING_PIXELS = 160_000;

function RollPreview({
    doc,
    copyCount,
    startCopyIndex,
    copyStep,
    maxWidthPx,
}: {
    doc: LabelDoc;
    copyCount: number;
    startCopyIndex: number;
    copyStep: 1 | -1;
    maxWidthPx: number;
}) {
    const previewCount = Math.min(copyCount, 50);
    const fitCount = Math.min(previewCount, 3);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const dragRef = useRef<{
        active: boolean;
        startX: number;
        startScrollLeft: number;
    }>({ active: false, startX: 0, startScrollLeft: 0 });
    // Each label is rotated 90° on the roll, so its on-screen footprint is
    // heightMm wide × widthMm tall (the printer's feed direction is the design's
    // "height" axis).
    const rotatedLabelWmm = doc.settings.heightMm;
    const totalMm =
        fitCount * rotatedLabelWmm +
        Math.max(0, fitCount - 1) * doc.settings.gapMm;
    const padPx = 24; // matches p-6 outer padding
    const rollPxPerMm = Math.max(1, (maxWidthPx - padPx * 2) / Math.max(1, totalMm));
    const labelWPx = doc.settings.widthMm * rollPxPerMm;
    const labelHPx = doc.settings.heightMm * rollPxPerMm;
    const gapPx = Math.max(4, doc.settings.gapMm * rollPxPerMm);
    const rollContentPx =
        previewCount * labelHPx + Math.max(0, previewCount - 1) * gapPx + padPx * 2;
    const items = useMemo(
        () =>
            Array.from(
                { length: previewCount },
                (_, index) => startCopyIndex + index * copyStep,
            ),
        [previewCount, startCopyIndex, copyStep],
    );
    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        const el = scrollRef.current;
        if (!el) return;
        dragRef.current = {
            active: true,
            startX: event.clientX,
            startScrollLeft: el.scrollLeft,
        };
        el.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        const el = scrollRef.current;
        const drag = dragRef.current;
        if (!el || !drag.active) return;
        el.scrollLeft = drag.startScrollLeft - (event.clientX - drag.startX);
    };
    const stopDrag = (event: PointerEvent<HTMLDivElement>) => {
        const el = scrollRef.current;
        dragRef.current.active = false;
        try {
            el?.releasePointerCapture(event.pointerId);
        } catch {
            /* pointer was already released */
        }
    };

    return (
        <div
            className="relative rounded-[12px] ring-1 ring-black/[0.08] dark:ring-white/10 shadow-sm overflow-hidden bg-zinc-200/70 dark:bg-zinc-800/70"
            style={{ maxWidth: maxWidthPx, width: "100%" }}
        >
            <div
                ref={scrollRef}
                className="overflow-x-auto overflow-y-hidden cursor-grab active:cursor-grabbing"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={stopDrag}
                onPointerCancel={stopDrag}
            >
                <div
                    className="flex items-center p-6 select-none"
                    style={{ width: rollContentPx, boxSizing: "border-box" }}
                >
                    {items.map((copyIndex, idx) => (
                        <div key={copyIndex} className="flex items-center shrink-0">
                            <div
                                className="relative shrink-0"
                                style={{ width: labelHPx, height: labelWPx }}
                            >
                                <div
                                    style={{
                                        position: "absolute",
                                        top: 0,
                                        left: 0,
                                        width: labelWPx,
                                        height: labelHPx,
                                        transform: `translate(${labelHPx}px, 0) rotate(90deg)`,
                                        transformOrigin: "top left",
                                    }}
                                >
                                    <PrintFidelityPreview
                                        doc={doc}
                                        copyIndex={copyIndex}
                                        displayWidthPx={labelWPx}
                                        displayHeightPx={labelHPx}
                                        maxBackingPixels={ROLL_PREVIEW_MAX_BACKING_PIXELS}
                                    />
                                </div>
                                <div className="absolute bottom-1 left-1 rounded bg-background/75 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                                    {copyIndex + 1}
                                </div>
                            </div>
                            {idx < items.length - 1 && (
                                <div
                                    className="shrink-0 self-stretch border-l border-dashed border-black/[0.16] dark:border-white/[0.16]"
                                    style={{ width: gapPx, height: labelWPx }}
                                />
                            )}
                        </div>
                    ))}
                </div>
            </div>
            <div className="absolute inset-y-0 left-0 w-10 pointer-events-none bg-gradient-to-r from-zinc-200 dark:from-zinc-800 to-transparent" />
            <div className="absolute inset-y-0 right-0 w-10 pointer-events-none bg-gradient-to-l from-zinc-200 dark:from-zinc-800 to-transparent" />
            <div className="absolute bottom-2 right-3 text-[10px] uppercase tracking-wider text-muted-foreground bg-background/70 backdrop-blur px-2 py-0.5 rounded">
                {previewCount < copyCount ? `${previewCount} of ${copyCount}` : copyCount} on roll
                {startCopyIndex > 0 ? ` · starts at row ${startCopyIndex + 1}` : ""}
                {" · "}{doc.settings.gapMm} mm gap
            </div>
        </div>
    );
}

function NumField({
    label,
    value,
    onChange,
    min,
    max,
    step,
}: {
    label: string;
    value: number;
    onChange: (n: number) => void;
    min?: number;
    max?: number;
    step?: number;
}) {
    return (
        <div className="space-y-1">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {label}
            </Label>
            <Input
                type="number"
                aria-label={label}
                value={Number.isFinite(value) ? value : 0}
                min={min}
                max={max}
                step={step}
                onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) onChange(n);
                }}
                className="h-9"
            />
        </div>
    );
}
