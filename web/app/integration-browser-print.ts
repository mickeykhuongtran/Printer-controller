import { randomUUID } from "node:crypto";

import type { TemplateValues } from "./integration";
import type {
    LabelDoc,
    PrinterDpi,
    ZebraRfidModel,
} from "./types";

export type BrowserPrintJobPayload = {
    id: string;
    createdAt: string;
    doc: LabelDoc;
    values: TemplateValues;
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

export type BrowserPrintCompletion = {
    ok: boolean;
    jobId?: string;
    bytes?: number;
    rfidEpc?: string;
    print?: unknown;
    error?: string;
    detail?: unknown;
};

export type BrowserPrintHistoryEntry = {
    id: string;
    createdAt: string;
    updatedAt: string;
    status: "queued" | "claimed" | "accepted" | "error" | "timeout";
    documentName: string;
    printerName: string;
    templateName: string;
    modelId: ZebraRfidModel;
    dpi: PrinterDpi;
    claimedBy?: string;
    bytes?: number;
    error?: string;
};

export type QueuedBrowserPrintJob = {
    jobId: string;
    completion: Promise<BrowserPrintCompletion>;
};

type BrowserPrintJob = BrowserPrintJobPayload & {
    status: "queued" | "claimed";
    claimedBy?: string;
    resolve: (completion: BrowserPrintCompletion) => void;
    claimTimeoutMs: number;
    claimTimeout?: ReturnType<typeof setTimeout>;
};

type JobWaiter = {
    clientId: string;
    resolve: (job: BrowserPrintJobPayload | null) => void;
    timeout: ReturnType<typeof setTimeout>;
    signal?: AbortSignal;
    onAbort?: () => void;
};

type BrowserPrintQueueState = {
    queue: BrowserPrintJob[];
    jobs: Map<string, BrowserPrintJob>;
    waiters: JobWaiter[];
    clients: Map<string, number>;
    activePrinters: Map<string, string>;
    recent: BrowserPrintHistoryEntry[];
    terminal: Map<string, BrowserPrintHistoryEntry>;
};

type QueueGlobal = typeof globalThis & {
    __nextwavesBrowserPrintQueue?: BrowserPrintQueueState;
};

const DEFAULT_CLAIM_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_WAIT_MS = 25_000;
const CLIENT_STALE_MS = 45_000;
const MAX_ACTIVE_AND_QUEUED_JOBS = 5_000;

export class BrowserPrintQueueFullError extends Error {
    readonly code = "BROWSER_PRINT_QUEUE_FULL";

    constructor() {
        super(
            `Browser print queue is full (${MAX_ACTIVE_AND_QUEUED_JOBS} jobs). `
            + "Wait for the listener to drain the backlog before retrying.",
        );
        this.name = "BrowserPrintQueueFullError";
    }
}

function state(): BrowserPrintQueueState {
    const globalState = globalThis as QueueGlobal;
    if (!globalState.__nextwavesBrowserPrintQueue) {
        globalState.__nextwavesBrowserPrintQueue = {
            queue: [],
            jobs: new Map(),
            waiters: [],
            clients: new Map(),
            activePrinters: new Map(),
            recent: [],
            terminal: new Map(),
        };
    }
    // Preserve queued work across Next development hot reloads while allowing
    // older in-memory state created before per-printer leasing to migrate.
    globalState.__nextwavesBrowserPrintQueue.activePrinters ??= new Map();
    globalState.__nextwavesBrowserPrintQueue.terminal ??= new Map();
    return globalState.__nextwavesBrowserPrintQueue;
}

function upsertHistory(
    job: BrowserPrintJob,
    patch: Partial<BrowserPrintHistoryEntry>,
): BrowserPrintHistoryEntry {
    const s = state();
    const idx = s.recent.findIndex((entry) => entry.id === job.id);
    const existing = idx >= 0 ? s.recent[idx] : undefined;
    const entry: BrowserPrintHistoryEntry = {
        id: job.id,
        createdAt: job.createdAt,
        updatedAt: new Date().toISOString(),
        status: "queued",
        documentName: job.documentName,
        printerName: job.printerName,
        templateName: job.templateName,
        modelId: job.modelId,
        dpi: job.dpi,
        ...existing,
        ...patch,
    };
    if (idx >= 0) s.recent.splice(idx, 1);
    s.recent.unshift(entry);
    s.recent = s.recent.slice(0, 20);
    return entry;
}

function cleanupClients(now = Date.now()): void {
    const s = state();
    for (const [clientId, lastSeen] of s.clients) {
        if (now - lastSeen > CLIENT_STALE_MS) s.clients.delete(clientId);
    }
}

function publicJob(job: BrowserPrintJob): BrowserPrintJobPayload {
    return {
        id: job.id,
        createdAt: job.createdAt,
        doc: job.doc,
        values: job.values,
        printerName: job.printerName,
        agentUrl: job.agentUrl,
        documentName: job.documentName,
        templateId: job.templateId,
        templateName: job.templateName,
        rfidEpc: job.rfidEpc,
        modelId: job.modelId,
        targetPrinterModel: job.targetPrinterModel,
        dpi: job.dpi,
    };
}

function physicalPrinterKey(job: Pick<BrowserPrintJobPayload, "agentUrl" | "printerName">): string {
    return `${job.agentUrl.trim().toLowerCase().replace(/\/+$/, "")}\0${job.printerName.trim().toLowerCase()}`;
}

function eligibleQueuedJobIndex(): number {
    const s = state();
    return s.queue.findIndex((job) => !s.activePrinters.has(physicalPrinterKey(job)));
}

function claimJob(job: BrowserPrintJob, clientId: string): BrowserPrintJobPayload {
    const s = state();
    const printerKey = physicalPrinterKey(job);
    if (s.activePrinters.has(printerKey)) {
        throw new Error("Internal print coordinator error: printer is already leased.");
    }
    job.status = "claimed";
    job.claimedBy = clientId;
    s.activePrinters.set(printerKey, job.id);
    job.claimTimeout = setTimeout(() => {
        completeBrowserPrintJob(job.id, {
            ok: false,
            error:
                "Browser print listener lease expired while the job was in flight. "
                + "The physical result is uncertain; this job was not automatically reprinted.",
        });
    }, job.claimTimeoutMs);
    upsertHistory(job, { status: "claimed", claimedBy: clientId });
    return publicJob(job);
}

function dispatchQueuedJobs(): void {
    const s = state();
    while (s.waiters.length > 0) {
        const queueIndex = eligibleQueuedJobIndex();
        if (queueIndex < 0) return;
        const waiter = s.waiters.shift();
        if (!waiter) return;
        clearTimeout(waiter.timeout);
        if (waiter.signal && waiter.onAbort) {
            waiter.signal.removeEventListener("abort", waiter.onAbort);
        }
        if (waiter.signal?.aborted) {
            waiter.resolve(null);
            continue;
        }
        const [job] = s.queue.splice(queueIndex, 1);
        touchBrowserPrintClient(waiter.clientId);
        waiter.resolve(claimJob(job, waiter.clientId));
    }
}

export function activeBrowserPrintListeners(): number {
    cleanupClients();
    return state().clients.size;
}

export function browserPrintStatus(): {
    queued: number;
    inFlight: number;
    listeners: number;
    recent: BrowserPrintHistoryEntry[];
} {
    cleanupClients();
    const s = state();
    let inFlight = 0;
    for (const job of s.jobs.values()) {
        if (job.status === "claimed") inFlight += 1;
    }
    return {
        queued: s.queue.length,
        inFlight,
        listeners: s.clients.size,
        recent: s.recent,
    };
}

export function browserPrintJobStatus(jobId: string): BrowserPrintHistoryEntry | null {
    const cleaned = jobId.trim();
    if (!cleaned) return null;
    const s = state();
    const active = s.jobs.get(cleaned);
    if (active) {
        return s.recent.find((entry) => entry.id === cleaned) ?? {
            id: active.id,
            createdAt: active.createdAt,
            updatedAt: active.createdAt,
            status: active.status,
            documentName: active.documentName,
            printerName: active.printerName,
            templateName: active.templateName,
            modelId: active.modelId,
            dpi: active.dpi,
            claimedBy: active.claimedBy,
        };
    }
    return s.terminal.get(cleaned) ?? null;
}

export function touchBrowserPrintClient(clientId: string): void {
    const trimmed = clientId.trim();
    if (!trimmed) return;
    cleanupClients();
    state().clients.set(trimmed, Date.now());
}

export async function takeBrowserPrintJob(
    clientId: string,
    waitMs = DEFAULT_WAIT_MS,
    signal?: AbortSignal,
): Promise<BrowserPrintJobPayload | null> {
    const trimmedClientId = clientId.trim() || "browser-listener";
    touchBrowserPrintClient(trimmedClientId);

    const s = state();
    if (signal?.aborted) return null;
    const queueIndex = eligibleQueuedJobIndex();
    if (queueIndex >= 0) {
        const [queued] = s.queue.splice(queueIndex, 1);
        return claimJob(queued, trimmedClientId);
    }

    const clampedWait = Math.max(1_000, Math.min(30_000, Math.floor(waitMs)));
    return new Promise((resolve) => {
        const waiter: JobWaiter = {
            clientId: trimmedClientId,
            resolve,
            timeout: setTimeout(() => {
                const idx = s.waiters.indexOf(waiter);
                if (idx >= 0) s.waiters.splice(idx, 1);
                if (signal && waiter.onAbort) {
                    signal.removeEventListener("abort", waiter.onAbort);
                }
                touchBrowserPrintClient(trimmedClientId);
                resolve(null);
            }, clampedWait),
            signal,
        };
        if (signal) {
            waiter.onAbort = () => {
                const idx = s.waiters.indexOf(waiter);
                if (idx >= 0) s.waiters.splice(idx, 1);
                clearTimeout(waiter.timeout);
                resolve(null);
            };
            signal.addEventListener("abort", waiter.onAbort, { once: true });
        }
        s.waiters.push(waiter);
        // A printer may have become free between the initial lookup and waiter
        // registration. Dispatch once more to close that race.
        dispatchQueuedJobs();
    });
}

export function completeBrowserPrintJob(
    jobId: string,
    completion: BrowserPrintCompletion,
): boolean {
    const s = state();
    const job = s.jobs.get(jobId);
    if (!job) return s.terminal.has(jobId);
    if (job.claimTimeout) clearTimeout(job.claimTimeout);
    s.jobs.delete(jobId);
    const queuedIdx = s.queue.findIndex((queued) => queued.id === jobId);
    if (queuedIdx >= 0) s.queue.splice(queuedIdx, 1);
    const printerKey = physicalPrinterKey(job);
    if (s.activePrinters.get(printerKey) === jobId) {
        s.activePrinters.delete(printerKey);
    }
    const terminalEntry = upsertHistory(job, {
        status: completion.ok ? "accepted" : completion.error?.includes("Timed out") ? "timeout" : "error",
        bytes: completion.bytes,
        error: completion.error,
    });
    s.terminal.set(jobId, terminalEntry);
    while (s.terminal.size > MAX_ACTIVE_AND_QUEUED_JOBS) {
        const oldest = s.terminal.keys().next().value as string | undefined;
        if (!oldest) break;
        s.terminal.delete(oldest);
    }
    job.resolve({ ...completion, jobId });
    dispatchQueuedJobs();
    return true;
}

export function queueBrowserPrintJob(
    input: Omit<BrowserPrintJobPayload, "id" | "createdAt">,
    claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS,
): QueuedBrowserPrintJob {
    const s = state();
    if (s.jobs.size >= MAX_ACTIVE_AND_QUEUED_JOBS) {
        throw new BrowserPrintQueueFullError();
    }
    const id = randomUUID();
    const safeClaimTimeout = Math.max(
        60_000,
        Math.min(2 * 60 * 60_000, Math.floor(claimTimeoutMs)),
    );

    const completion = new Promise<BrowserPrintCompletion>((resolve) => {
        const job: BrowserPrintJob = {
            ...input,
            id,
            createdAt: new Date().toISOString(),
            status: "queued",
            resolve,
            claimTimeoutMs: safeClaimTimeout,
        };
        s.jobs.set(id, job);
        upsertHistory(job, { status: "queued" });
        s.queue.push(job);
        dispatchQueuedJobs();
    });
    return { jobId: id, completion };
}

export function enqueueBrowserPrintJob(
    input: Omit<BrowserPrintJobPayload, "id" | "createdAt">,
    claimTimeoutMs = DEFAULT_CLAIM_TIMEOUT_MS,
): Promise<BrowserPrintCompletion> {
    return queueBrowserPrintJob(input, claimTimeoutMs).completion;
}
