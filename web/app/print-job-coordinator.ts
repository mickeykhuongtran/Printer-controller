/**
 * Process-local, per-printer FIFO used by browser print/control workflows.
 *
 * The connector remains the final admission authority, but this queue avoids
 * competing jobs from the same web/app instance before they reach it. Object
 * keys are used for Web Serial ports; stable string keys cover TCP and WinSpool.
 */

type QueueKey = string | object;

type QueueEntry = {
    tail: Promise<void>;
    active: boolean;
    waiting: number;
};

type QueueRegistry = {
    strings: Map<string, QueueEntry>;
    objects: WeakMap<object, QueueEntry>;
    activeJobs: number;
};

type GlobalWithPrinterQueues = typeof globalThis & {
    __nextwavesPrinterJobQueues?: QueueRegistry;
};

const globalQueues = globalThis as GlobalWithPrinterQueues;
const registry = globalQueues.__nextwavesPrinterJobQueues
    ?? (globalQueues.__nextwavesPrinterJobQueues = {
        strings: new Map(),
        objects: new WeakMap(),
        activeJobs: 0,
    });
registry.activeJobs ??= 0;

/** Keep the desktop quit/sleep guard active while a durable spool is prepared. */
export function registerPrinterPreparation(): () => void {
    registry.activeJobs += 1;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        registry.activeJobs -= 1;
    };
}

function normalizedPart(value: string): string {
    return value.trim().toLowerCase();
}

export function tcpPrinterQueueKey(host: string, port: number): string {
    return `tcp:${normalizedPart(host)}:${Math.max(1, Math.floor(port))}`;
}

export function windowsPrinterQueueKey(agentUrl: string, printerName: string): string {
    return `winspool:${normalizedPart(agentUrl).replace(/\/+$/, "")}:${normalizedPart(printerName)}`;
}

function entryFor(key: QueueKey): QueueEntry {
    const collection = typeof key === "string" ? registry.strings : registry.objects;
    const existing = collection.get(key as never);
    if (existing) return existing;
    const created: QueueEntry = {
        tail: Promise.resolve(),
        active: false,
        waiting: 0,
    };
    collection.set(key as never, created);
    return created;
}

function deleteIfIdle(key: QueueKey, entry: QueueEntry): void {
    if (entry.active || entry.waiting > 0) return;
    const collection = typeof key === "string" ? registry.strings : registry.objects;
    if (collection.get(key as never) === entry) collection.delete(key as never);
}

/**
 * Runs one complete logical print job exclusively for the selected printer.
 * `onQueued` receives the number of jobs already ahead of this operation.
 */
export async function runExclusivePrinterJob<T>(
    key: QueueKey,
    operation: () => Promise<T>,
    onQueued?: (jobsAhead: number) => void,
    signal?: AbortSignal,
): Promise<T> {
    signal?.throwIfAborted();
    const entry = entryFor(key);
    const jobsAhead = entry.waiting + (entry.active ? 1 : 0);
    entry.waiting += 1;

    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const previous = entry.tail;
    entry.tail = previous.catch(() => undefined).then(() => current);

    if (jobsAhead > 0) onQueued?.(jobsAhead);
    let removeAbortListener = () => {};
    try {
        await new Promise<void>((resolve, reject) => {
            const abort = () => reject(signal!.reason);
            signal?.addEventListener("abort", abort, { once: true });
            removeAbortListener = () => signal?.removeEventListener("abort", abort);
            if (signal?.aborted) abort();
            previous.catch(() => undefined).then(resolve);
        });
    } catch (error) {
        // Release only this waiting slot. Its successor still waits for
        // `previous`; cancelling a queued job cannot overtake the active job.
        entry.waiting -= 1;
        release();
        queueMicrotask(() => deleteIfIdle(key, entry));
        throw error;
    } finally {
        removeAbortListener();
    }
    entry.waiting -= 1;
    entry.active = true;
    registry.activeJobs += 1;

    try {
        return await operation();
    } finally {
        entry.active = false;
        registry.activeJobs = Math.max(0, registry.activeJobs - 1);
        release();
        queueMicrotask(() => deleteIfIdle(key, entry));
    }
}
