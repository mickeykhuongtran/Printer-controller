import {
    DEFAULT_LOCAL_PRINT_AGENT_URL,
    LocalPrintAgentHttpError,
    fetchLocalAgentJson,
    isLoopbackWebApp,
} from "./local-print-agent";
import { RawSpoolBatch, RawSpoolBatchPendingError, isDefiniteSpoolRejection, type RawSpoolBatchStatus } from "./raw-spool-batch";

export const DEFAULT_WINDOWS_PRINT_AGENT_URL = DEFAULT_LOCAL_PRINT_AGENT_URL;

export type PendingSpoolBatch = { batchId: string; agentUrl: string; printerName: string };
const PENDING_SPOOL_KEY = "zbre.pending-spool-batches.v1";
let pendingSpoolMemory: PendingSpoolBatch[] = [];

function pendingSpoolBatches(): PendingSpoolBatch[] {
    try {
        const stored: unknown = JSON.parse(window.localStorage.getItem(PENDING_SPOOL_KEY) ?? "[]");
        if (Array.isArray(stored)) pendingSpoolMemory = stored.filter((item): item is PendingSpoolBatch =>
            !!item && typeof item.batchId === "string" && typeof item.agentUrl === "string" && typeof item.printerName === "string");
    } catch { /* Connector history remains authoritative when browser storage is unavailable. */ }
    return pendingSpoolMemory;
}

function rememberSpoolBatch(batch: PendingSpoolBatch, remove = false): void {
    pendingSpoolMemory = pendingSpoolBatches().filter((item) => item.batchId !== batch.batchId);
    if (!remove) pendingSpoolMemory.push(batch);
    try { window.localStorage.setItem(PENDING_SPOOL_KEY, JSON.stringify(pendingSpoolMemory)); } catch { /* Keep memory and connector history. */ }
}

function normalizedSpoolTarget(value: string): string {
    return value.trim().replace(/\/+$/, "").toLowerCase();
}

export function listPendingWindowsSpoolBatches(agentUrl: string, printerName?: string): PendingSpoolBatch[] {
    return pendingSpoolBatches().filter((item) => normalizedSpoolTarget(item.agentUrl) === normalizedSpoolTarget(agentUrl)
        && (!printerName || normalizedSpoolTarget(item.printerName) === normalizedSpoolTarget(printerName)))
        .map((item) => ({ batchId: item.batchId, agentUrl: item.agentUrl, printerName: item.printerName }));
}

/** Call only after an explicit operator decision; this never submits or retries a print. */
export async function forgetMissingWindowsSpoolBatch(agentUrl: string, batchId: string): Promise<void> {
    const pending = listPendingWindowsSpoolBatches(agentUrl).find((item) => item.batchId === batchId);
    if (!pending) return;
    const health = await fetchLocalAgentJson<{ capabilities?: Record<string, boolean> }>(agentUrl, "/v1/health", { method: "GET" }, { timeoutMs: 5_000 });
    if (health.capabilities?.rawSpoolBatchV1 !== true) throw new Error("The current connector cannot verify durable batch history.");
    try { await getWindowsSpoolBatch(agentUrl, batchId); }
    catch (error) {
        if (error instanceof LocalPrintAgentHttpError && error.status === 404) {
            rememberSpoolBatch(pending, true);
            return;
        }
        throw error;
    }
    throw new Error("This batch still exists in connector history. Resolve it there before clearing its local record.");
}

export async function getWindowsSpoolBatch(agentUrl: string, batchId: string): Promise<RawSpoolBatchStatus> {
    return fetchLocalAgentJson(agentUrl, "/v1/print/batch", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "status", batchId }),
    }, { timeoutMs: 10_000 });
}

/** Refuse a fresh ID while this browser still has an un-reconciled submission. */
export async function assertNoPendingWindowsSpoolBatch(agentUrl: string, printerName: string): Promise<void> {
    for (const pending of listPendingWindowsSpoolBatches(agentUrl, printerName)) {
        let status: RawSpoolBatchStatus;
        try { status = await getWindowsSpoolBatch(agentUrl, pending.batchId); }
        catch { throw new RawSpoolBatchPendingError(pending.batchId); }
        if (status.state === "spool-accepted" || status.state === "cancelled") rememberSpoolBatch(pending, true);
        else throw new RawSpoolBatchPendingError(pending.batchId, status);
    }
}

/** Capability check occurs before reserving a new durable batch. */
export async function createWindowsSpoolBatch(options: {
    agentUrl: string; batchId: string; printerName: string; documentName: string; totalLabels: number;
    onStatus?: (status: RawSpoolBatchStatus) => void;
}): Promise<RawSpoolBatch> {
    if (!Number.isSafeInteger(options.totalLabels) || options.totalLabels < 1) {
        throw new Error("Batch label count must be a positive safe integer.");
    }
    const health = await fetchLocalAgentJson<{ capabilities?: Record<string, boolean> }>(options.agentUrl, "/v1/health", { method: "GET" }, { timeoutMs: 5_000 });
    if (health.capabilities?.rawSpoolBatchV1 !== true) throw new Error("Update Local Print Connector to 0.5.0 or newer for durable Windows batch printing.");
    rememberSpoolBatch(options);
    return new RawSpoolBatch(
        async (request) => {
            try {
                return await fetchLocalAgentJson(options.agentUrl, "/v1/print/batch", {
                    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
                }, { timeoutMs: 30_000 });
            } catch (error) {
                if (request.action === "begin" && isDefiniteSpoolRejection(error)) rememberSpoolBatch(options, true);
                throw error;
            }
        },
        options,
        (status) => {
            if (status.state === "spool-accepted" || status.state === "cancelled") rememberSpoolBatch(options, true);
            options.onStatus?.(status);
        },
        () => rememberSpoolBatch(options, true),
    );
}

export type WindowsPrinterInfo = {
    name: string;
    isDefault: boolean;
    comment?: string;
    description?: string;
    portName?: string;
    driverName?: string;
};

export type WindowsRawPrintResult = {
    ok: boolean;
    printerName: string;
    documentName: string;
    jobId: number | null;
    bytesWritten: number;
    portName?: string;
    driverName?: string;
    warning?: string;
    batchId?: string;
    sequence?: number;
    nextSequence?: number;
    batchState?: "open" | "finished";
    finalChunk?: boolean;
    deduplicated?: boolean;
    payloadSha256?: string;
};

export type WindowsRawBatchCheckpoint = {
    batchId: string;
    sequence: number;
    finalChunk: boolean;
};

export function windowsPrinterLabel(printer: WindowsPrinterInfo): string {
    const parts = [printer.name];
    if (printer.portName) parts.push(printer.portName);
    if (printer.driverName) parts.push(printer.driverName);
    if (printer.isDefault) parts.push("Default");
    return parts.join(" - ");
}

export function rawZplPrinterWarning(printer: WindowsPrinterInfo | undefined): string | null {
    if (!printer) return null;
    const name = printer.name.toLowerCase();
    const driver = (printer.driverName ?? "").toLowerCase();
    const port = (printer.portName ?? "").toUpperCase();
    if (name.includes("(redirected") || driver.includes("remote desktop easy print") || port.startsWith("TS")) {
        return "This is a Remote Desktop redirected queue. RAW ZPL is usually not passed through; run the print agent on the PC connected to the Zebra printer or install a direct Zebra/Seagull queue.";
    }
    if (
        name.includes("pdf") ||
        name.includes("onenote") ||
        driver.includes("pdf") ||
        driver.includes("xps") ||
        driver.includes("ipp class")
    ) {
        return "This queue is not a raw Zebra queue. Select a Zebra/ZDesigner/Seagull printer queue connected by USB, TCP/IP, or share.";
    }
    if (!name.includes("zebra") && !driver.includes("zebra") && !driver.includes("zdesigner") && !driver.includes("seagull")) {
        return "This queue does not look like a Zebra/ZDesigner/Seagull queue. RAW ZPL may be ignored by the driver or sent to the wrong printer.";
    }
    return null;
}

export function inferWindowsPrinterDpi(printer: WindowsPrinterInfo | undefined): 203 | 300 | 600 | undefined {
    if (!printer) return undefined;
    const text = `${printer.name} ${printer.driverName ?? ""} ${printer.comment ?? ""}`.toLowerCase();
    if (/\b600\s*dpi\b/.test(text) || /\b600\s*dpmm\b/.test(text)) return 600;
    if (/\b300\s*dpi\b/.test(text) || /\b300\s*dpmm\b/.test(text)) return 300;
    if (/\b203\s*dpi\b/.test(text) || /\b200\s*dpi\b/.test(text) || /\b8\s*dots\/mm\b/.test(text)) return 203;
    return undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export async function listWindowsPrinters(
    agentUrl: string,
): Promise<WindowsPrinterInfo[]> {
    let data: { printers: WindowsPrinterInfo[] };
    try {
        data = await fetchLocalAgentJson<{ printers: WindowsPrinterInfo[] }>(
            agentUrl,
            "/v1/printers",
            { method: "GET" },
            { timeoutMs: 5000 },
        );
    } catch (error) {
        if (!(error instanceof LocalPrintAgentHttpError) || error.status !== 404) {
            throw error;
        }
        if (!isLoopbackWebApp()) {
            throw new Error(
                "The old Windows print agent is not allowed from a hosted website. Install and pair the current Local Print Connector.",
            );
        }
        // Compatibility with the original Windows-only print agent.
        data = await fetchLocalAgentJson<{ printers: WindowsPrinterInfo[] }>(
            agentUrl,
            "/printers",
            { method: "GET" },
            { timeoutMs: 5000, includeToken: false },
        );
    }
    return data.printers;
}

export async function sendWindowsRawPrint({
    agentUrl,
    printerName,
    documentName,
    payload,
    batch,
}: {
    agentUrl: string;
    printerName: string;
    documentName: string;
    payload: Uint8Array;
    language?: "zpl";
    batch?: WindowsRawBatchCheckpoint;
}): Promise<WindowsRawPrintResult> {
    const cleanedPrinter = printerName.trim();
    if (!cleanedPrinter) throw new Error("Windows printer name is required.");
    if (payload.byteLength === 0) throw new Error("Print payload is empty.");
    if (batch?.sequence === 1) {
        const health = await fetchLocalAgentJson<{
            capabilities?: Record<string, boolean>;
        }>(
            agentUrl,
            "/v1/health",
            { method: "GET" },
            { timeoutMs: 5_000 },
        );
        if (health.capabilities?.rawBatchLeaseV1 !== true) {
            throw new Error(
                "The installed Local Print Connector does not support atomic RAW batch leases. Update the connector before printing this batch.",
            );
        }
    }

    const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            printerName: cleanedPrinter,
            documentName: documentName.trim() || "Nextwaves label",
            language: "zpl",
            payloadBase64: bytesToBase64(payload),
            ...(batch
                ? {
                    batchId: batch.batchId,
                    sequence: batch.sequence,
                    finalChunk: batch.finalChunk,
                }
                : {}),
        }),
    };
    // WritePrinter is synchronous and may legitimately block while a driver or
    // network-backed queue applies backpressure. A fixed 30 s browser abort can
    // leave an ambiguous job that was actually spooled, so scale the request
    // window with payload size and keep a conservative two-minute floor.
    const timeoutMs = Math.min(
        10 * 60_000,
        Math.max(120_000, Math.ceil(payload.byteLength / (1024 * 1024)) * 30_000),
    );
    try {
        const receipt = await fetchLocalAgentJson<WindowsRawPrintResult>(
            agentUrl,
            "/v1/print",
            init,
            { timeoutMs },
        );
        if (
            batch
            && (
                receipt.batchId !== batch.batchId
                || receipt.sequence !== batch.sequence
                || receipt.nextSequence !== batch.sequence + 1
                || receipt.finalChunk !== batch.finalChunk
                || receipt.batchState !== (batch.finalChunk ? "finished" : "open")
            )
        ) {
            throw new Error(
                "The Local Print Connector returned an invalid RAW batch checkpoint. Do not resend this chunk automatically.",
            );
        }
        return receipt;
    } catch (error) {
        if (!(error instanceof LocalPrintAgentHttpError) || error.status !== 404) {
            throw error;
        }
        if (batch) {
            throw new Error(
                "The installed Local Print Connector does not support atomic RAW batch leases. Update the connector before printing this batch.",
            );
        }
        if (!isLoopbackWebApp()) {
            throw new Error(
                "The old Windows print agent is not allowed from a hosted website. Install and pair the current Local Print Connector.",
            );
        }
        return fetchLocalAgentJson<WindowsRawPrintResult>(
            agentUrl,
            "/print",
            init,
            { timeoutMs, includeToken: false },
        );
    }
}
