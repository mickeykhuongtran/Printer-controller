import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
    readPrinterRoutingConfig,
    resolvePrinterAliasConfig,
    resolvePrinterNameAlias,
    type PrinterAliasConfig,
} from "@/printer-routing";
import {
    applyPrinterTargetMetadata,
    printerDpiFromUnknown,
    printerQueueDpiMismatch,
    resolvePrinterTargetMetadata,
    zebraPrinterModelFromUnknown,
    type PrinterTargetInput,
} from "@/printer-target";
import {
    applyTemplateValues,
    type TemplateValues,
} from "@/integration";
import {
    BrowserPrintQueueFullError,
    queueBrowserPrintJob,
} from "@/integration-browser-print";
import { hasPerCopyPrintData } from "@/label-data";
import { assertPrintBatchQuantity } from "@/print-batch";
import {
    ServerPrinterQueueFullError,
    serverWindowsPrinterKey,
    withServerPrinterQueue,
} from "@/server-printer-queue";
import { stageServerRawSpoolBatch } from "@/server-raw-print";
import { RawSpoolBatchPendingError } from "@/raw-spool-batch";
import type { LabelDoc } from "@/types";
import {
    cleanString,
    isRecord,
    jsonResponse,
    optionsResponse,
    parseTemplate,
} from "../_common";
import {
    listProfiles,
    profileSummary,
    readProfile,
    type IntegrationProfile,
} from "../_profiles";

export const runtime = "nodejs";

const DEFAULT_AGENT_URL = "http://127.0.0.1:17917";
const DEFAULT_PROFILE_ID =
    process.env.NEXTWAVES_DEFAULT_PROFILE_ID
    || "";
const DEFAULT_PRINTER_NAME = process.env.NEXTWAVES_DEFAULT_PRINTER_NAME || "";
const DEFAULT_RENDER_MODE =
    process.env.NEXTWAVES_PRINT_RENDER_MODE
    || "browser-listener";
const DEFAULT_TEMPLATE_PATH =
    process.env.NEXTWAVES_DEFAULT_TEMPLATE_PATH
    || "";
const TEMPLATE_ROOT = process.env.NEXTWAVES_TEMPLATE_ROOT?.trim()
    ? path.resolve(process.env.NEXTWAVES_TEMPLATE_ROOT)
    : path.join(process.cwd(), "template");

export function OPTIONS(): Response {
    return optionsResponse();
}

function normalizeAgentUrl(url: string): string {
    return (url || DEFAULT_AGENT_URL).trim().replace(/\/+$/, "") || DEFAULT_AGENT_URL;
}

function firstString(body: Record<string, unknown>, keys: string[], fallback = ""): string {
    for (const key of keys) {
        const value = cleanString(body[key]);
        if (value) return value;
    }
    return fallback;
}

async function resolvePrinterName(body: Record<string, unknown>, agentUrl: string): Promise<string> {
    const requested = firstString(
        body,
        ["printerName", "Printer_Name", "printer_name", "PrinterName"],
        DEFAULT_PRINTER_NAME,
    );
    return resolvePrinterNameAlias(requested, agentUrl);
}

async function requestAgentUrl(body: Record<string, unknown>): Promise<string> {
    const explicit = firstString(body, ["agentUrl", "Agent_Url", "agent_url"]);
    if (explicit) return normalizeAgentUrl(explicit);

    const config = await readPrinterRoutingConfig();
    return normalizeAgentUrl(
        config.agentUrl
        || process.env.NEXTWAVES_PRINT_AGENT_URL
        || DEFAULT_AGENT_URL,
    );
}

function requestCopies(body: Record<string, unknown>): number | undefined {
    const raw = body.copies ?? body.Copies ?? body.Quantity ?? body.quantity;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string") {
        const parsed = Number(raw);
        if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
}

function requestRenderMode(body: Record<string, unknown>): "browser-listener" | "native" {
    const raw = firstString(
        body,
        ["renderMode", "Render_Mode", "render_mode", "printRenderMode"],
        DEFAULT_RENDER_MODE,
    )
        .toLowerCase()
        .replace(/[_\s]+/g, "-");
    if (raw === "native" || raw === "zpl" || raw === "server-native") return "native";
    return "browser-listener";
}

function requestWaitForCompletion(body: Record<string, unknown>): boolean {
    const raw = body.waitForCompletion ?? body.Wait_For_Completion ?? body.wait_for_completion;
    if (typeof raw === "boolean") return raw;
    if (typeof raw === "number") return raw === 1;
    if (typeof raw === "string") {
        const normalized = raw.trim().toLowerCase();
        return normalized === "1" || normalized === "true" || normalized === "yes";
    }
    return false;
}

function requestValues(body: Record<string, unknown>): TemplateValues {
    if (isRecord(body.values)) return body.values as TemplateValues;
    if (isRecord(body.fields)) return body.fields as TemplateValues;
    if (isRecord(body.data)) return body.data as TemplateValues;
    return {};
}

function requestCompletionWaitMs(body: Record<string, unknown>): number {
    const raw = body.waitTimeoutMs ?? body.Wait_Timeout_Ms ?? body.wait_timeout_ms;
    const numeric = typeof raw === "number" ? raw : Number(raw ?? 30_000);
    if (!Number.isFinite(numeric)) return 30_000;
    return Math.max(1_000, Math.min(50_000, Math.floor(numeric)));
}

function documentNameFor(
    body: Record<string, unknown>,
    template: LabelDoc,
    values: TemplateValues,
): string {
    const explicit = cleanString(body.documentName);
    if (explicit) return explicit;
    const parts = [
        cleanString(values.label_name ?? values.name ?? values.field_1),
        cleanString(values.sku ?? values.code ?? values.field_2),
        cleanString(values.serial ?? values.field_rfid ?? values.rfid_id),
    ].filter(Boolean);
    return parts.join(" ").slice(0, 160) || `${template.name || "Nextwaves label"} API`;
}

async function resolveProfile(body: Record<string, unknown>): Promise<IntegrationProfile | null> {
    const requested = firstString(
        body,
        ["profileId", "Profile_Id", "profile_id", "templateProfileId"],
        DEFAULT_PROFILE_ID,
    );
    if (requested) return readProfile(requested);

    const profiles = await listProfiles();
    if (profiles.length !== 1) return null;
    return readProfile(profiles[0].profileId);
}

function requestedPrinterAlias(body: Record<string, unknown>): string {
    return firstString(
        body,
        ["printerName", "Printer_Name", "printer_name", "PrinterName"],
        DEFAULT_PRINTER_NAME,
    );
}

function requestPrinterTarget(
    body: Record<string, unknown>,
    aliasConfig: PrinterAliasConfig | null,
): PrinterTargetInput {
    const requestedModel = firstString(
        body,
        ["modelId", "targetPrinterModel", "printerModel", "Printer_Model", "printer_model"],
    );
    const explicitModel = requestedModel
        ? zebraPrinterModelFromUnknown(requestedModel)
        : undefined;
    if (requestedModel && !explicitModel) {
        throw new Error(`Unsupported Zebra printer model "${requestedModel}".`);
    }

    const rawDpi = body.dpi
        ?? body.DPI
        ?? body.printerDpi
        ?? body.Printer_Dpi
        ?? body.printer_dpi;
    const hasExplicitDpi = rawDpi !== undefined && rawDpi !== null && rawDpi !== "";
    const explicitDpi = hasExplicitDpi ? printerDpiFromUnknown(rawDpi) : undefined;
    if (hasExplicitDpi && !explicitDpi) {
        throw new Error(`Unsupported printer DPI "${String(rawDpi)}". Use 203, 300, or 600.`);
    }

    // An alias represents a physical route, so its metadata takes precedence
    // over request/template defaults. Direct queue calls can provide model/DPI.
    const modelId = aliasConfig?.modelId
        ?? aliasConfig?.targetPrinterModel
        ?? explicitModel;
    return {
        modelId,
        targetPrinterModel: modelId,
        dpi: aliasConfig?.dpi ?? explicitDpi,
    };
}

function resolveTemplatePath(templatePath: string): string {
    const requested = templatePath.trim();
    if (path.isAbsolute(requested)) {
        throw new Error("Absolute template paths are not allowed.");
    }
    const relative = requested.replace(/^template[\\/]+/i, "");
    const resolved = path.resolve(TEMPLATE_ROOT, relative);
    const insideRoot =
        resolved === TEMPLATE_ROOT ||
        resolved.startsWith(`${TEMPLATE_ROOT}${path.sep}`);
    if (!insideRoot) {
        throw new Error(
            `Template path must stay inside the project template directory (${TEMPLATE_ROOT}).`,
        );
    }
    return resolved;
}

async function readTemplateFile(templatePath: string): Promise<LabelDoc | null> {
    if (!templatePath) return null;
    try {
        const raw = await fs.readFile(resolveTemplatePath(templatePath), "utf8");
        return parseTemplate(raw);
    } catch {
        return null;
    }
}

async function readConfiguredTemplate(
    body: Record<string, unknown>,
    aliasConfig: PrinterAliasConfig | null,
): Promise<LabelDoc | null> {
    const explicitPath = firstString(body, ["templatePath", "Template_Path", "template_path"]);
    if (explicitPath) return readTemplateFile(explicitPath);

    const aliasTemplatePath = cleanString(aliasConfig?.templatePath);
    if (aliasTemplatePath) return readTemplateFile(aliasTemplatePath);

    return readTemplateFile(DEFAULT_TEMPLATE_PATH);
}

export async function POST(req: Request): Promise<Response> {
    try {
        const body = await req.json();
        if (!isRecord(body)) {
            return jsonResponse({ ok: false, error: "JSON body must be an object." }, 400);
        }

        const requestedAlias = requestedPrinterAlias(body);
        const aliasConfig = requestedAlias
            ? await resolvePrinterAliasConfig(requestedAlias)
            : null;

        let template = parseTemplate(body.template);
        let profile: IntegrationProfile | null = null;
        let mode: "one-shot" | "profile" | "template-path" = template ? "one-shot" : "profile";
        if (!template) {
            profile = await resolveProfile(body);
            template = profile?.template ?? null;
        }
        if (!template) {
            template = await readConfiguredTemplate(body, aliasConfig);
            if (template) mode = "template-path";
        }
        if (!template) {
            return jsonResponse(
                {
                    ok: false,
                    error:
                        "template or integration profile is required. Send template, send profileId, set NEXTWAVES_DEFAULT_PROFILE_ID, publish exactly one profile, set templatePath, configure a templatePath for the printer alias, or set NEXTWAVES_DEFAULT_TEMPLATE_PATH.",
                },
                400,
            );
        }

        if ((template.settings.rfid.enabled || template.settings.rfid.readEnabled) && template.settings.rfid.captureToHost) {
            return jsonResponse({ ok: false, error: "This template requires per-label RFID session capture. Print it from the TCP Print screen through the local connector; Windows/integration printing cannot collect these readbacks.", code: "RFID_CAPTURE_TCP_REQUIRED" }, 400);
        }
        const agentUrl = await requestAgentUrl(body);
        const printerName = await resolvePrinterName(body, agentUrl);
        if (!printerName) {
            return jsonResponse(
                {
                    ok: false,
                    error:
                        "printerName is required. Send printerName or set NEXTWAVES_DEFAULT_PRINTER_NAME.",
                },
                400,
            );
        }

        let printerTarget;
        try {
            printerTarget = resolvePrinterTargetMetadata(
                template,
                requestPrinterTarget(body, aliasConfig),
            );
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
        template = applyPrinterTargetMetadata(template, printerTarget);

        const values = requestValues(body);
        const copies = requestCopies(body);
        try {
            assertPrintBatchQuantity(copies ?? template.settings.copies ?? 1);
        } catch (err) {
            return jsonResponse(
                { ok: false, error: err instanceof Error ? err.message : String(err) },
                400,
            );
        }
        const renderMode = requestRenderMode(body);
        const documentName = documentNameFor(body, template, values);
        const rfidEpc = cleanString(
            values.rfid_epc_encode
            ?? values.rfid_id
            ?? values.field_rfid
            ?? values.rfid
            ?? values.epc,
        );

        if (renderMode === "browser-listener") {
            const appliedDoc = applyTemplateValues(template, values, { copies });
            if (
                appliedDoc.settings.copies > 1
                && hasPerCopyPrintData(appliedDoc)
            ) {
                return jsonResponse(
                    {
                        ok: false,
                        error:
                            "The browser print listener cannot safely repeat a dynamic serial, multi-row, or RFID-encode template. Use the interactive Print step for chunked batch printing, or request native mode when the template supports native ZPL.",
                    },
                    422,
                );
            }
            const queued = queueBrowserPrintJob({
                doc: appliedDoc,
                values,
                printerName,
                agentUrl,
                documentName,
                templateId: template.id,
                templateName: template.name,
                rfidEpc,
                modelId: printerTarget.modelId,
                targetPrinterModel: printerTarget.targetPrinterModel,
                dpi: printerTarget.dpi,
            });

            if (!requestWaitForCompletion(body)) {
                return jsonResponse({
                    ok: true,
                    language: "zpl",
                    mode,
                    renderMode,
                    status: "queued",
                    templateId: template.id,
                    templateName: template.name,
                    profile: profile ? profileSummary(profile) : undefined,
                    printerTarget,
                    rfidEpc,
                    jobId: queued.jobId,
                    statusUrl:
                        `/api/integration/browser-print/status?jobId=${encodeURIComponent(queued.jobId)}`,
                }, 202);
            }

            let waitTimer: ReturnType<typeof setTimeout> | undefined;
            const waitResult = await Promise.race([
                queued.completion.then((result) => ({ completed: true as const, result })),
                new Promise<{ completed: false }>((resolve) => {
                    waitTimer = setTimeout(
                        () => resolve({ completed: false }),
                        requestCompletionWaitMs(body),
                    );
                    waitTimer.unref?.();
                }),
            ]);
            if (waitTimer) clearTimeout(waitTimer);
            if (!waitResult.completed) {
                return jsonResponse({
                    ok: true,
                    language: "zpl",
                    mode,
                    renderMode,
                    status: "queued-or-in-flight",
                    templateId: template.id,
                    templateName: template.name,
                    printerTarget,
                    rfidEpc,
                    jobId: queued.jobId,
                    statusUrl:
                        `/api/integration/browser-print/status?jobId=${encodeURIComponent(queued.jobId)}`,
                }, 202);
            }
            const result = waitResult.result;

            if (!result.ok) {
                return jsonResponse(
                    {
                        ok: false,
                        error: result.error || "Browser print listener failed.",
                        detail: result.detail,
                        language: "zpl",
                        mode,
                        renderMode,
                        templateId: template.id,
                        templateName: template.name,
                        printerTarget,
                        rfidEpc,
                    },
                    result.error?.includes("Timed out") ? 504 : 502,
                );
            }

            return jsonResponse({
                ok: true,
                language: "zpl",
                mode,
                renderMode,
                templateId: template.id,
                templateName: template.name,
                profile: profile ? profileSummary(profile) : undefined,
                printerTarget,
                rfidEpc: result.rfidEpc || rfidEpc,
                bytes: result.bytes,
                jobId: result.jobId,
                print: result.print,
            });
        }

        const nativeResult = await withServerPrinterQueue(
            serverWindowsPrinterKey(agentUrl, printerName),
            () => stageServerRawSpoolBatch({
                agentUrl, printerName, documentName,
                batchId: cleanString(body.batchId) || req.headers.get("Idempotency-Key")?.trim() || randomUUID(),
                template: template, values, copies,
            }),
            req.signal,
        );

        return jsonResponse({
            ok: true,
            language: "zpl",
            mode,
            renderMode,
            templateId: template.id,
            templateName: template.name,
            profile: profile ? profileSummary(profile) : undefined,
            printerTarget,
            rfidEpc,
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
        if (err instanceof BrowserPrintQueueFullError) {
            return jsonResponse(
                { ok: false, code: err.code, error: err.message },
                429,
                { "Retry-After": "5" },
            );
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
            500,
        );
    }
}
