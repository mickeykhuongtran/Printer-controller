import { type TemplateValues } from "@/integration";
import { randomUUID } from "node:crypto";
import {
    resolvePrinterAliasConfig,
    resolvePrinterNameAlias,
} from "@/printer-routing";
import {
    applyPrinterTargetMetadata,
    printerDpiFromUnknown,
    printerQueueDpiMismatch,
    resolvePrinterTargetMetadata,
    zebraPrinterModelFromUnknown,
} from "@/printer-target";
import {
    ServerPrinterQueueFullError,
    serverWindowsPrinterKey,
    withServerPrinterQueue,
} from "@/server-printer-queue";
import { stageServerRawSpoolBatch } from "@/server-raw-print";
import { RawSpoolBatchPendingError } from "@/raw-spool-batch";
import {
    cleanString,
    isRecord,
    jsonResponse,
    optionsResponse,
} from "../../../_common";
import {
    profileSummary,
    readProfile,
} from "../../../_profiles";

export const runtime = "nodejs";

const DEFAULT_AGENT_URL = "http://127.0.0.1:17917";

type RouteContext = {
    params: Promise<{ profileId: string }>;
};

export function OPTIONS(): Response {
    return optionsResponse();
}

function normalizeAgentUrl(url: string): string {
    return (url || DEFAULT_AGENT_URL).trim().replace(/\/+$/, "") || DEFAULT_AGENT_URL;
}

function requestCopies(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number") return value;
    if (typeof value === "string") return Number(value.trim());
    return Number.NaN;
}

export async function POST(req: Request, context: RouteContext): Promise<Response> {
    try {
        const { profileId } = await context.params;
        const profile = await readProfile(profileId);
        if (!profile) {
            return jsonResponse({ ok: false, error: `Profile "${profileId}" was not found.` }, 404);
        }

        const body = await req.json();
        if (!isRecord(body)) {
            return jsonResponse({ ok: false, error: "JSON body must be an object." }, 400);
        }

        const requestedPrinterName = cleanString(body.printerName);
        if (!requestedPrinterName) {
            return jsonResponse({ ok: false, error: "printerName is required." }, 400);
        }

        const agentUrl = normalizeAgentUrl(cleanString(body.agentUrl, DEFAULT_AGENT_URL));
        const aliasConfig = await resolvePrinterAliasConfig(requestedPrinterName);
        const printerName = await resolvePrinterNameAlias(requestedPrinterName, agentUrl);
        const rawModel = cleanString(body.modelId ?? body.targetPrinterModel ?? body.printerModel);
        const explicitModel = rawModel ? zebraPrinterModelFromUnknown(rawModel) : undefined;
        if (rawModel && !explicitModel) {
            return jsonResponse(
                { ok: false, error: `Unsupported Zebra printer model "${rawModel}".` },
                400,
            );
        }
        const rawDpi = body.dpi ?? body.printerDpi;
        const hasExplicitDpi = rawDpi !== undefined && rawDpi !== null && rawDpi !== "";
        const explicitDpi = hasExplicitDpi ? printerDpiFromUnknown(rawDpi) : undefined;
        if (hasExplicitDpi && !explicitDpi) {
            return jsonResponse(
                { ok: false, error: `Unsupported printer DPI "${String(rawDpi)}". Use 203, 300, or 600.` },
                400,
            );
        }

        let printerTarget;
        try {
            const modelId = aliasConfig?.modelId
                ?? aliasConfig?.targetPrinterModel
                ?? explicitModel;
            printerTarget = resolvePrinterTargetMetadata(profile.template, {
                modelId,
                targetPrinterModel: modelId,
                dpi: aliasConfig?.dpi ?? explicitDpi,
            });
        } catch (err) {
            return jsonResponse(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                400,
            );
        }
        const queueMismatch = printerQueueDpiMismatch(printerName, printerTarget.dpi);
        if (queueMismatch) {
            return jsonResponse(
                {
                    ok: false,
                    code: "PRINTER_DPI_MISMATCH",
                    error: queueMismatch.message,
                    printerTarget,
                    queueDpi: queueMismatch.queueDpi,
                },
                409,
            );
        }

        const values = isRecord(body.values) ? (body.values as TemplateValues) : {};
        const copies = requestCopies(body.copies);
        const targetedTemplate = applyPrinterTargetMetadata(profile.template, printerTarget);

        const documentName = cleanString(
            body.documentName,
            `${profile.name || "Nextwaves label"} API`,
        );

        const nativeResult = await withServerPrinterQueue(
            serverWindowsPrinterKey(agentUrl, printerName),
            () => stageServerRawSpoolBatch({
                agentUrl, printerName, documentName,
                batchId: cleanString(body.batchId) || req.headers.get("Idempotency-Key")?.trim() || randomUUID(),
                template: targetedTemplate, values, copies,
            }),
            req.signal,
        );

        return jsonResponse({
            ok: true,
            language: "zpl",
            profile: profileSummary(profile),
            printerTarget,
            bytes: nativeResult.bytes,
            chunks: nativeResult.chunks,
            print: {
                delivery: "spool-accepted",
                verification: "not-physical",
                batchId: nativeResult.status.batchId,
                jobIds: [nativeResult.status.jobId],
            },
        });
    } catch (err) {
        if (err instanceof RawSpoolBatchPendingError) {
            return jsonResponse({ ok: true, pending: true, batchId: err.batchId, print: { delivery: err.status?.state ?? "unknown", verification: "not-physical", jobId: err.status?.jobId ?? null }, error: err.message }, 202);
        }
        if (err instanceof ServerPrinterQueueFullError) {
            return jsonResponse(
                { ok: false, code: err.code, error: err.message },
                429,
                { "Retry-After": "5" },
            );
        }
        return jsonResponse(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            err instanceof RangeError ? 400 : 500,
        );
    }
}
