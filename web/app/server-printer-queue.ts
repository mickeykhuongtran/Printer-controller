type ServerQueueEntry = {
    tail: Promise<void>;
    active: boolean;
    waiting: number;
};

type ServerQueueStore = {
    entries: Map<string, ServerQueueEntry>;
};

type GlobalWithServerPrinterQueues = typeof globalThis & {
    __nextwavesServerPrinterQueues?: ServerQueueStore;
};

const globalQueues = globalThis as GlobalWithServerPrinterQueues;
const store = globalQueues.__nextwavesServerPrinterQueues
    ?? (globalQueues.__nextwavesServerPrinterQueues = { entries: new Map() });
const MAX_OPERATIONS_PER_PRINTER = 2_048;

export class ServerPrinterQueueFullError extends Error {
    readonly code = "SERVER_PRINTER_QUEUE_FULL";

    constructor() {
        super(`Printer queue is full (${MAX_OPERATIONS_PER_PRINTER} operations).`);
        this.name = "ServerPrinterQueueFullError";
    }
}

export function serverPrinterQueueStatus(): {
    targets: number;
    active: number;
    waiting: number;
} {
    let active = 0;
    let waiting = 0;
    for (const entry of store.entries.values()) {
        if (entry.active) active += 1;
        waiting += entry.waiting;
    }
    return { targets: store.entries.size, active, waiting };
}

export function serverTcpPrinterKey(host: string, port: number): string {
    return `tcp:${host.trim().toLowerCase()}:${Math.max(1, Math.floor(port))}`;
}

export function serverWindowsPrinterKey(agentUrl: string, printerName: string): string {
    return `winspool:${agentUrl.trim().toLowerCase().replace(/\/+$/, "")}:${printerName.trim().toLowerCase()}`;
}

/** FIFO, concurrency one per printer target; unrelated printers stay parallel. */
export async function withServerPrinterQueue<T>(
    key: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
): Promise<T> {
    let entry = store.entries.get(key);
    if (!entry) {
        entry = { tail: Promise.resolve(), active: false, waiting: 0 };
        store.entries.set(key, entry);
    }
    if (entry.waiting + (entry.active ? 1 : 0) >= MAX_OPERATIONS_PER_PRINTER) {
        throw new ServerPrinterQueueFullError();
    }
    entry.waiting += 1;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
        release = resolve;
    });
    const previous = entry.tail;
    entry.tail = previous.catch(() => undefined).then(() => current);
    await previous.catch(() => undefined);
    entry.waiting -= 1;
    if (signal?.aborted) {
        release();
        queueMicrotask(() => {
            if (!entry?.active && entry?.waiting === 0 && store.entries.get(key) === entry) {
                store.entries.delete(key);
            }
        });
        throw new Error("Print request was cancelled while queued; no bytes were sent.");
    }
    entry.active = true;
    try {
        return await operation();
    } finally {
        entry.active = false;
        release();
        if (entry.waiting === 0) {
            queueMicrotask(() => {
                if (!entry?.active && entry?.waiting === 0 && store.entries.get(key) === entry) {
                    store.entries.delete(key);
                }
            });
        }
    }
}
