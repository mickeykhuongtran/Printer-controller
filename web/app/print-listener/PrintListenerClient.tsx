"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, Loader2, Printer, Settings2, XCircle } from "lucide-react";

import {
    formatSerial,
    hasPerCopyPrintData,
    resolveDynamicValue,
    variablesForCopy,
} from "../label-data";
import {
    buildFullPageStoredGraphicDownloadZpl,
    buildFullPageStoredGraphicRecallZpl,
    buildFullPageZpl,
    buildStoredGraphicDeleteZpl,
    encodeZpl,
} from "../zpl";
import { renderLabelToBitmap } from "../full-page-raster";
import {
    applyPrinterTargetMetadata,
    printerQueueDpiMismatch,
    resolvePrinterTargetMetadata,
} from "../printer-target";
import type {
    LabelDoc,
    LabelElement,
    PrinterDpi,
    ZebraRfidModel,
} from "../types";
import { assertNoPendingWindowsSpoolBatch, createWindowsSpoolBatch } from "../windows-raw-print";
import { validateSpoolHexRows } from "../raw-spool-preflight";
import { runExclusivePrinterJob, windowsPrinterQueueKey } from "../print-job-coordinator";
import { RawSpoolBatchPendingError } from "../raw-spool-batch";
import {
    assertPrintBatchQuantity,
    iteratePrintBatchChunks,
} from "../print-batch";
import { preflightLabelForPrinter } from "../dpi-preflight";

const STATIC_LISTENER_WINDOW_LABELS = 100;
const RFID_LISTENER_WINDOW_LABELS = 25;
const COMPLETE_RETRY_DELAYS_MS = [250, 750, 2_000, 5_000] as const;

type BrowserPrintJobPayload = {
    id: string;
    createdAt: string;
    doc: LabelDoc;
    values?: Record<string, string | number | boolean | null | undefined>;
    printerName: string;
    agentUrl: string;
    documentName: string;
    templateId: string;
    templateName: string;
    rfidEpc: string;
    modelId: ZebraRfidModel;
    targetPrinterModel: ZebraRfidModel;
    dpi: PrinterDpi;
};

type BrowserPrintJobResponse = {
    ok: boolean;
    job?: BrowserPrintJobPayload;
    error?: string;
};

type LogEntry = {
    id: string;
    at: string;
    kind: "info" | "ok" | "error";
    text: string;
};

function makeClientId(): string {
    const storageKey = "nextwaves.printListener.clientId";
    const existing = window.localStorage.getItem(storageKey);
    if (existing) return existing;
    const next =
        typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `listener_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    window.localStorage.setItem(storageKey, next);
    return next;
}

function messageFromError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function defaultRfidPayload(elements: LabelElement[]): string {
    for (const el of elements) {
        if (el.kind === "qr" || el.kind === "barcode" || el.kind === "datamatrix") return el.data;
        if (el.kind === "text") return el.text;
    }
    return "";
}

function rfidReadFieldName(doc: LabelDoc): string | null {
    if (!doc.settings.rfid.readEnabled) return null;
    const fieldName = (doc.settings.rfid.readFieldName ?? "rfid_read")
        .trim()
        .replace(/^\{|\}$/g, "");
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName) ? fieldName : null;
}

function docWithResolvedRfidRead(doc: LabelDoc, epc: string): LabelDoc {
    const value = epc.trim();
    const fieldName = rfidReadFieldName(doc);
    if (!value || !fieldName) return doc;

    const feed = doc.dataFeed;
    const columns = [...(feed?.columns ?? [])];
    let column = columns.find((item) => item.name.toLowerCase() === fieldName.toLowerCase());
    if (!column) {
        column = {
            id: `rfid_read_${fieldName}`,
            name: fieldName,
        };
        columns.push(column);
    }

    const sourceRows = feed?.rows.length ? feed.rows : [{ id: "rfid_read_row_1", cells: {} }];
    const rows = sourceRows.map((row) => ({
        ...row,
        cells: {
            ...row.cells,
            [column.id]: value,
        },
    }));

    return {
        ...doc,
        dataFeed: {
            columns,
            rows,
        },
    };
}

async function completeJob(
    jobId: string,
    completion: {
        ok: boolean;
        bytes?: number;
        rfidEpc?: string;
        print?: unknown;
        error?: string;
        detail?: unknown;
    },
): Promise<void> {
    const response = await fetch("/api/integration/browser-print/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId, ...completion }),
        cache: "no-store",
    });
    if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error || `Complete job HTTP ${response.status}`);
    }
}

async function completeJobWithRetry(
    jobId: string,
    completion: Parameters<typeof completeJob>[1],
): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= COMPLETE_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            await completeJob(jobId, completion);
            return;
        } catch (error) {
            lastError = error;
            const delay = COMPLETE_RETRY_DELAYS_MS[attempt];
            if (delay === undefined) break;
            await new Promise((resolve) => window.setTimeout(resolve, delay));
        }
    }
    throw lastError;
}

async function printBrowserBitmapJob(job: BrowserPrintJobPayload): Promise<{
    bytes: number;
    rfidEpc: string;
    print: unknown;
}> {
    if ((job.doc.settings.rfid.enabled || job.doc.settings.rfid.readEnabled) && job.doc.settings.rfid.captureToHost) {
        throw new Error("This template requires live TCP RFID capture; the Windows browser listener cannot collect per-label readbacks.");
    }
    const resolvedDoc = docWithResolvedRfidRead(structuredClone(job.doc), job.rfidEpc);
    const printerTarget = resolvePrinterTargetMetadata(resolvedDoc, {
        modelId: job.modelId,
        targetPrinterModel: job.targetPrinterModel,
        dpi: job.dpi,
    });
    const queueMismatch = printerQueueDpiMismatch(job.printerName, printerTarget.dpi);
    if (queueMismatch) throw new Error(queueMismatch.message);
    const doc = applyPrinterTargetMetadata(resolvedDoc, printerTarget);
    const copies = Math.floor(doc.settings.copies);
    assertPrintBatchQuantity(copies);
    await assertNoPendingWindowsSpoolBatch(job.agentUrl, job.printerName);
    const batch = await createWindowsSpoolBatch({
        agentUrl: job.agentUrl, batchId: job.id, printerName: job.printerName,
        documentName: job.documentName, totalLabels: copies,
    });
    try {
        await batch.begin();
        validateSpoolHexRows(doc, 0, copies);
        if (document.fonts?.ready) await document.fonts.ready;

        const blockingSymbolIssues = preflightLabelForPrinter(doc, { copyIndex: 0 })
            .filter((issue) => issue.severity === "error");
        if (blockingSymbolIssues.length > 0) {
            throw new Error(
                `Print blocked by symbol preflight: ${blockingSymbolIssues
                    .map((issue) => issue.message)
                    .join(" ")}`,
            );
        }
        if (
            copies > 1
            && hasPerCopyPrintData(doc)
        ) {
            throw new Error(
                "The browser print listener cannot safely repeat a dynamic serial, multi-row, or RFID-encode template. Use the interactive Print step, which expands and chunks every label.",
            );
        }
        const serial = doc.settings.serial;
        const sn = serial.enabled
            ? formatSerial(serial.start, serial.pad, serial.prefix)
            : "";
        const vars = variablesForCopy(doc, 0);
        const rfidPayload = resolveDynamicValue(
            doc.settings.rfid.data || sn || defaultRfidPayload(doc.elements),
            doc.settings.rfid.fieldName,
            sn,
            vars,
        );
        const fullPage = await renderLabelToBitmap(doc, 0, {
            skipRfidReadDynamicElements: !!doc.settings.rfid.readEnabled,
        });
        if (!fullPage) throw new Error("Browser bitmap render failed.");

        const maxWindowLabels = doc.settings.rfid.enabled || doc.settings.rfid.readEnabled
            ? RFID_LISTENER_WINDOW_LABELS
            : STATIC_LISTENER_WINDOW_LABELS;
        const windows = iteratePrintBatchChunks(copies, maxWindowLabels);
        const useStoredGraphic = Math.ceil(copies / maxWindowLabels) > 1
            && !doc.settings.rfid.enabled
            && !doc.settings.rfid.readEnabled;
        const graphicName = `NW${job.id.replace(/[^A-Za-z0-9]/g, "").slice(0, 6)}`;
        let totalBytes = 0;
        for (const printWindow of windows) {
            let zpl: string;
            if (useStoredGraphic) {
                zpl = printWindow.chunkNumber === 1
                    ? buildFullPageStoredGraphicDownloadZpl(fullPage, graphicName)
                    : "";
                zpl += buildFullPageStoredGraphicRecallZpl(
                    doc.settings,
                    graphicName,
                    printWindow.quantity,
                );
                if (printWindow.chunkNumber === Math.ceil(copies / maxWindowLabels)) {
                    zpl += buildStoredGraphicDeleteZpl(graphicName);
                }
            } else {
                zpl = buildFullPageZpl(
                    doc.settings,
                    fullPage,
                    printWindow.quantity,
                    {
                        rfidData: rfidPayload,
                        elements: doc.elements,
                        sn,
                        vars,
                    },
                );
            }
            const payload = encodeZpl(zpl);
            await batch.append(payload, printWindow.quantity);
            totalBytes += payload.byteLength;
        }

        const receipt = await batch.commit();
        return {
            bytes: totalBytes,
            rfidEpc: job.rfidEpc || rfidPayload,
            print: {
                delivery: "spool-accepted",
                verification: "not-physical",
                chunks: Math.ceil(copies / maxWindowLabels),
                batchId: job.id,
                jobId: receipt.jobId,
            },
        };
    } catch (error) {
        await batch.cancelPreparation();
        throw error;
    }
}

export function PrintListenerClient() {
    const [clientId] = useState(() =>
        typeof window === "undefined" ? "" : makeClientId(),
    );
    const [running, setRunning] = useState(true);
    const [status, setStatus] = useState("Starting listener");
    const [lastJob, setLastJob] = useState<BrowserPrintJobPayload | null>(null);
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const runningRef = useRef(true);

    const shortClientId = useMemo(
        () => (clientId ? clientId.slice(0, 8) : "pending"),
        [clientId],
    );

    function pushLog(kind: LogEntry["kind"], text: string): void {
        setLogs((prev) =>
            [
                {
                    id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
                    at: new Date().toLocaleTimeString(),
                    kind,
                    text,
                },
                ...prev,
            ].slice(0, 12),
        );
    }

    useEffect(() => {
        runningRef.current = running;
    }, [running]);

    useEffect(() => {
        if (!clientId) return;
        const id = clientId;
        let stopped = false;
        let activeRequest: AbortController | null = null;

        async function loop(): Promise<void> {
            while (!stopped) {
                if (!runningRef.current) {
                    setStatus("Paused");
                    await new Promise((resolve) => window.setTimeout(resolve, 750));
                    continue;
                }

                try {
                    setStatus("Listening");
                    activeRequest = new AbortController();
                    const response = await fetch(
                        `/api/integration/browser-print/jobs?clientId=${encodeURIComponent(id)}&waitMs=25000`,
                        { cache: "no-store", signal: activeRequest.signal },
                    );
                    activeRequest = null;

                    if (response.status === 204) continue;
                    const data = (await response.json()) as BrowserPrintJobResponse;
                    if (!response.ok || !data.ok || !data.job) {
                        throw new Error(data.error || `Listener HTTP ${response.status}`);
                    }

                    const job = data.job;
                    setLastJob(job);
                    setStatus(`Printing ${job.documentName}`);
                    pushLog("info", `Job ${job.id.slice(0, 8)} received`);

                    let result: Awaited<ReturnType<typeof printBrowserBitmapJob>>;
                    try {
                        result = await runExclusivePrinterJob(
                            windowsPrinterQueueKey(job.agentUrl, job.printerName),
                            () => printBrowserBitmapJob(job),
                        );
                    } catch (err) {
                        const message = messageFromError(err);
                        await completeJobWithRetry(job.id, {
                            ok: false,
                            error: message,
                            ...(err instanceof RawSpoolBatchPendingError ? { print: { batchId: err.batchId, delivery: err.status?.state ?? "unknown", verification: "not-physical" } } : {}),
                        }).catch(() => undefined);
                        pushLog("error", message);
                        continue;
                    }

                    // Once RAW submission succeeds, never downgrade it to a
                    // failed/not-sent completion merely because the completion
                    // acknowledgement was interrupted. Replaying the physical
                    // job here could duplicate labels.
                    try {
                        await completeJobWithRetry(job.id, { ok: true, ...result });
                        pushLog(
                            "ok",
                            `Spool accepted ${result.bytes.toLocaleString()} bytes`,
                        );
                    } catch (error) {
                        pushLog(
                            "error",
                            "RAW data was spool-accepted, but completion acknowledgement failed. "
                            + "Physical outcome is uncertain; do not resend automatically. "
                            + messageFromError(error),
                        );
                    }
                } catch (err) {
                    pushLog("error", messageFromError(err));
                    await new Promise((resolve) => window.setTimeout(resolve, 2000));
                }
            }
        }

        void loop();
        return () => {
            stopped = true;
            activeRequest?.abort();
        };
    }, [clientId]);

    return (
        <main className="min-h-screen bg-background px-6 py-6 text-foreground">
            <div className="mx-auto flex max-w-5xl flex-col gap-4">
                <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-3">
                                <Printer className="h-6 w-6" />
                                <h1 className="text-2xl font-semibold">Print Listener</h1>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">
                                Client {shortClientId} | full bitmap | RFID enabled
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <a
                                href="/printer-config"
                                className="inline-flex h-10 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
                            >
                                <Settings2 className="h-4 w-4" />
                                Config
                            </a>
                            <button
                                type="button"
                                onClick={() => setRunning((value) => !value)}
                                className="h-10 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent"
                            >
                                {running ? "Pause" : "Resume"}
                            </button>
                        </div>
                    </div>
                    <div className="mt-5 grid gap-3 md:grid-cols-3">
                        <div className="rounded-md border border-border bg-background p-4">
                            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                                {running ? (
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                ) : (
                                    <Activity className="h-4 w-4" />
                                )}
                                Status
                            </div>
                            <div className="mt-2 text-base font-semibold">{status}</div>
                        </div>
                        <div className="rounded-md border border-border bg-background p-4">
                            <div className="text-sm text-muted-foreground">Printer</div>
                            <div className="mt-2 truncate text-base font-semibold">
                                {lastJob?.printerName || "Waiting for job"}
                            </div>
                            {lastJob ? (
                                <div className="mt-1 text-xs text-muted-foreground">
                                    {lastJob.targetPrinterModel} · {lastJob.dpi} dpi
                                </div>
                            ) : null}
                        </div>
                        <div className="rounded-md border border-border bg-background p-4">
                            <div className="text-sm text-muted-foreground">Template</div>
                            <div className="mt-2 truncate text-base font-semibold">
                                {lastJob?.templateName || "Waiting for job"}
                            </div>
                        </div>
                    </div>
                </section>

                <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
                    <h2 className="text-lg font-semibold">Activity</h2>
                    <div className="mt-4 divide-y divide-border rounded-md border border-border bg-background">
                        {logs.length === 0 ? (
                            <div className="p-4 text-sm text-muted-foreground">No print jobs yet.</div>
                        ) : (
                            logs.map((log) => (
                                <div key={log.id} className="flex items-start gap-3 p-3 text-sm">
                                    {log.kind === "ok" ? (
                                        <CheckCircle2 className="mt-0.5 h-4 w-4 text-green-600" />
                                    ) : log.kind === "error" ? (
                                        <XCircle className="mt-0.5 h-4 w-4 text-red-600" />
                                    ) : (
                                        <Activity className="mt-0.5 h-4 w-4 text-muted-foreground" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                        <div className="break-words">{log.text}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">{log.at}</div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </div>
        </main>
    );
}
