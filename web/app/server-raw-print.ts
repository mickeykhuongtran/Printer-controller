import { RawSpoolBatch, type RawSpoolBatchStatus } from "./raw-spool-batch";
import type { LabelDoc } from "./types";
import { applyTemplateValues, type TemplateValues } from "./integration";
import { iteratePrintBatchChunks } from "./print-batch";
import { validateSpoolHexRows } from "./raw-spool-preflight";
import { preflightLabelForPrinter } from "./dpi-preflight";
import { buildZpl, encodeZpl } from "./zpl";

export type ServerRawPrintReceipt = {
    ok: boolean;
    printerName: string;
    documentName: string;
    jobId: number | null;
    bytesWritten: number;
    warning?: string;
    batchId?: string;
    sequence?: number;
    nextSequence?: number;
    batchState?: "open" | "finished";
    finalChunk?: boolean;
    deduplicated?: boolean;
};

export type ServerRawBatchCheckpoint = {
    batchId: string;
    sequence: number;
    finalChunk: boolean;
};

function payloadBase64(payload: Uint8Array): string {
    return Buffer.from(payload).toString("base64");
}

function messageFromAgentBody(body: unknown, status: number): string {
    if (
        body
        && typeof body === "object"
        && "error" in body
        && typeof body.error === "string"
    ) {
        return body.error;
    }
    return `Local print connector returned HTTP ${status}.`;
}

async function postRaw(
    endpoint: string,
    requestBody: string,
    timeoutMs: number,
): Promise<{ response: Response; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: requestBody,
            cache: "no-store",
            signal: controller.signal,
        });
        return { response, body: await response.json().catch(() => null) };
    } finally {
        clearTimeout(timer);
    }
}

/** Prepare complete label formats on connector disk, then commit one Windows job. */
export async function stageServerRawSpoolBatch(options: {
    agentUrl: string; printerName: string; documentName: string; batchId: string;
    template: LabelDoc; values: TemplateValues; copies?: number;
}): Promise<{ status: RawSpoolBatchStatus; chunks: number; bytes: number }> {
    const template = structuredClone(options.template);
    const values = structuredClone(options.values);
    const totalLabels = options.copies ?? template.settings.copies ?? 1;
    const base = options.agentUrl.trim().replace(/\/+$/, "");
    const healthResponse = await fetch(`${base}/v1/health`, { cache: "no-store", signal: AbortSignal.timeout(5_000) });
    const health = await healthResponse.json() as { capabilities?: Record<string, boolean> };
    if (!healthResponse.ok || health.capabilities?.rawSpoolBatchV1 !== true) {
        throw new Error("Update Local Print Connector to 0.5.0 or newer for durable Windows batch printing.");
    }
    const batch = new RawSpoolBatch(async (request) => {
        const result = await postRaw(`${base}/v1/print/batch`, JSON.stringify(request), 30_000);
        if (!result.response.ok) throw Object.assign(new Error(messageFromAgentBody(result.body, result.response.status)), { status: result.response.status });
        return result.body as RawSpoolBatchStatus;
    }, { batchId: options.batchId, printerName: options.printerName, documentName: options.documentName, totalLabels });
    try {
        await batch.begin();
        const applied = applyTemplateValues(template, values, { copies: totalLabels });
        validateSpoolHexRows(applied, 0, totalLabels);
        const ranges = iteratePrintBatchChunks(totalLabels, 25);
        let bytes = 0;
        for (const range of ranges) {
            for (let index = range.startIndex; index < range.endIndexExclusive; index += 1) {
                const errors = preflightLabelForPrinter(applied, { copyIndex: index }).filter((issue) => issue.severity === "error");
                if (errors.length) throw new Error(`Data row ${index + 1}: ${errors.map((issue) => issue.message).join(" ")}`);
            }
            const chunkDoc = { ...applied, settings: { ...applied.settings, copies: range.quantity } };
            const payload = encodeZpl(buildZpl(chunkDoc, range.startIndex));
            await batch.append(payload, range.quantity);
            bytes += payload.byteLength;
        }
        const status = await batch.commit();
        return { status, chunks: Math.ceil(totalLabels / 25), bytes };
    } catch (error) {
        await batch.cancelPreparation();
        throw error;
    }
}

/** Server-side RAW submission with v1 connector semantics and byte receipt. */
export async function sendServerRawPrint(options: {
    agentUrl: string;
    printerName: string;
    documentName: string;
    payload: Uint8Array;
    batch?: ServerRawBatchCheckpoint;
}): Promise<ServerRawPrintReceipt> {
    if (options.payload.byteLength < 1) throw new Error("Print payload is empty.");
    const base = options.agentUrl.trim().replace(/\/+$/, "");
    if (options.batch?.sequence === 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5_000);
        try {
            const response = await fetch(`${base}/v1/health`, {
                cache: "no-store",
                signal: controller.signal,
            });
            const health = await response.json().catch(() => null) as {
                capabilities?: Record<string, boolean>;
            } | null;
            if (!response.ok || health?.capabilities?.rawBatchLeaseV1 !== true) {
                throw new Error(
                    "The Local Print Connector must be updated before an atomic RAW batch can be submitted.",
                );
            }
        } finally {
            clearTimeout(timer);
        }
    }
    const requestBody = JSON.stringify({
        printerName: options.printerName.trim(),
        documentName: options.documentName.trim() || "Nextwaves label",
        language: "zpl",
        payloadBase64: payloadBase64(options.payload),
        ...(options.batch
            ? {
                batchId: options.batch.batchId,
                sequence: options.batch.sequence,
                finalChunk: options.batch.finalChunk,
            }
            : {}),
    });
    const timeoutMs = Math.min(
        10 * 60_000,
        Math.max(120_000, Math.ceil(options.payload.byteLength / (1024 * 1024)) * 30_000),
    );

    let result = await postRaw(`${base}/v1/print`, requestBody, timeoutMs);
    // Compatibility only for the original Windows Python agent. The bundled
    // Go connector and all hosted workflows use /v1/print.
    if (
        !options.batch
        && result.response.status === 404
        && /^https?:\/\/(?:localhost|127(?:\.\d{1,3}){3})(?::\d+)?$/i.test(base)
    ) {
        result = await postRaw(`${base}/print`, requestBody, timeoutMs);
    }
    if (!result.response.ok) {
        throw new Error(messageFromAgentBody(result.body, result.response.status));
    }
    const receipt = result.body as Partial<ServerRawPrintReceipt> | null;
    if (
        !receipt
        || receipt.ok !== true
        || !Number.isSafeInteger(receipt.bytesWritten)
        || receipt.bytesWritten !== options.payload.byteLength
        || (
            options.batch
            && (
                receipt.batchId !== options.batch.batchId
                || receipt.sequence !== options.batch.sequence
                || receipt.nextSequence !== options.batch.sequence + 1
                || receipt.finalChunk !== options.batch.finalChunk
                || receipt.batchState !== (options.batch.finalChunk ? "finished" : "open")
            )
        )
    ) {
        throw new Error(
            `Invalid RAW spool receipt: accepted ${String(receipt?.bytesWritten)} `
            + `of ${options.payload.byteLength} bytes.`,
        );
    }
    return receipt as ServerRawPrintReceipt;
}
