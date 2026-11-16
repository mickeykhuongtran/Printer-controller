// Web Serial API wrappers. Browser-only.
// Types are conservatively typed — Web Serial isn't yet in core lib.dom.d.ts.

import {
    DEFAULT_PRINTER_BAUD_RATE,
    normalizePrinterBaudRate,
    type SerialFlowControl,
} from "./storage";

const SERIAL_WRITE_FRAME_BYTES = 4 * 1024;
const SERIAL_OPERATION_TIMEOUT_MS = 120_000;
const SERIAL_ABORT_TIMEOUT_MS = 5_000;

async function bestEffortAbort(
    writer: WritableStreamDefaultWriter<Uint8Array>,
    reason: Error,
): Promise<void> {
    let timer: number | undefined;
    await Promise.race([
        writer.abort(reason).catch(() => undefined),
        new Promise<void>((resolve) => {
            timer = window.setTimeout(resolve, SERIAL_ABORT_TIMEOUT_MS);
        }),
    ]);
    if (timer !== undefined) window.clearTimeout(timer);
}

type SerialPortLike = {
    readable: ReadableStream<Uint8Array> | null;
    writable: WritableStream<Uint8Array> | null;
    open: (options: SerialOpenOptions) => Promise<void>;
    close: () => Promise<void>;
    getInfo?: () => { usbVendorId?: number; usbProductId?: number };
};

type SerialOpenOptions = {
    baudRate: number;
    dataBits?: 7 | 8;
    stopBits?: 1 | 2;
    parity?: "none" | "even" | "odd";
    flowControl?: "none" | "hardware";
    bufferSize?: number;
};

type NavigatorSerial = {
    requestPort: (opts?: { filters?: Array<{ usbVendorId?: number }> }) => Promise<SerialPortLike>;
    getPorts: () => Promise<SerialPortLike[]>;
};

function nav(): NavigatorSerial | null {
    if (typeof navigator === "undefined") return null;
    const s = (navigator as unknown as { serial?: NavigatorSerial }).serial;
    return s ?? null;
}

export function isWebSerialSupported(): boolean {
    return nav() !== null;
}

export type SelectedPort = {
    port: SerialPortLike;
    label: string;
};

export type ConnectedPort = SelectedPort;

function describePort(port: SerialPortLike): string {
    const info = port.getInfo?.();
    if (info && (info.usbVendorId || info.usbProductId)) {
        const v = info.usbVendorId?.toString(16).padStart(4, "0") ?? "????";
        const p = info.usbProductId?.toString(16).padStart(4, "0") ?? "????";
        return `USB ${v}:${p}`;
    }
    return "Serial port";
}

export async function selectPort(): Promise<SelectedPort> {
    const s = nav();
    if (!s) throw new Error("Web Serial is not supported in this browser.");
    const port = await s.requestPort();
    const selected = { port, label: describePort(port) };
    console.log("[print/webserial] port selected:", selected.label);
    return selected;
}

export async function openSelectedPort(
    selected: SelectedPort,
    baudRate = DEFAULT_PRINTER_BAUD_RATE,
    flowControl: SerialFlowControl = "none",
): Promise<ConnectedPort> {
    const safeBaudRate = normalizePrinterBaudRate(baudRate);
    console.log("[print/webserial] openSelectedPort — baudRate:", safeBaudRate);
    await selected.port.open({
        baudRate: safeBaudRate,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flowControl,
        bufferSize: 64 * 1024,
    });
    console.log(
        "[print/webserial] port opened — readable:",
        !!selected.port.readable,
        "writable:",
        !!selected.port.writable,
    );
    return selected;
}

export async function requestAndOpen(
    baudRate = DEFAULT_PRINTER_BAUD_RATE,
    flowControl: SerialFlowControl = "none",
): Promise<ConnectedPort> {
    const selected = await selectPort();
    return openSelectedPort(selected, baudRate, flowControl);
}

type SerialReadSubscriber = {
    onChunk: (chunk: Uint8Array) => void;
    onError: (error: unknown) => void;
};

type SerialReadState = {
    reader: ReadableStreamDefaultReader<Uint8Array>;
    subscribers: Set<SerialReadSubscriber>;
    closed: boolean;
    task: Promise<void>;
};

const serialReadStates = new WeakMap<SerialPortLike, SerialReadState>();
const serialOperationTails = new WeakMap<SerialPortLike, Promise<void>>();

async function runSerialOperation<T>(
    port: SerialPortLike,
    operation: () => Promise<T>,
): Promise<T> {
    const previous = serialOperationTails.get(port) ?? Promise.resolve();
    let releaseCurrent!: () => void;
    const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
    });
    serialOperationTails.set(
        port,
        previous.catch(() => undefined).then(() => current),
    );
    await previous.catch(() => undefined);
    try {
        return await operation();
    } finally {
        releaseCurrent();
    }
}

async function writeBytesUnlocked(
    connected: ConnectedPort,
    bytes: Uint8Array,
): Promise<number> {
    console.log(
        "[print/webserial] sendBytes start — port:",
        connected.label,
        "· bytes:",
        bytes.byteLength,
    );
    const writable = connected.port.writable;
    if (!writable) {
        console.error("[print/webserial] sendBytes: port not writable", {
            port: connected.label,
            readable: connected.port.readable,
            writable: connected.port.writable,
        });
        throw new Error("Port is not writable. Reconnect.");
    }
    const writer = writable.getWriter();
    const t0 = performance.now();
    try {
        for (let offset = 0; offset < bytes.byteLength; offset += SERIAL_WRITE_FRAME_BYTES) {
            const frame = bytes.subarray(
                offset,
                Math.min(offset + SERIAL_WRITE_FRAME_BYTES, bytes.byteLength),
            );
            const timeoutError = new Error(
                `COM write made no progress for ${SERIAL_OPERATION_TIMEOUT_MS / 1000} seconds; `
                + "the current label window has an unknown outcome. Reconnect the COM port before continuing.",
            );
            let timer: number | undefined;
            try {
                await Promise.race([
                    writer.ready.then(() => writer.write(frame)),
                    new Promise<never>((_, reject) => {
                        timer = window.setTimeout(
                            () => reject(timeoutError),
                            SERIAL_OPERATION_TIMEOUT_MS,
                        );
                    }),
                ]);
            } catch (error) {
                if (error === timeoutError) {
                    await bestEffortAbort(writer, timeoutError);
                }
                throw error;
            } finally {
                if (timer !== undefined) window.clearTimeout(timer);
            }
        }
        const dt = (performance.now() - t0).toFixed(1);
        console.log(
            "[print/webserial] sendBytes done — wrote",
            bytes.byteLength,
            "bytes in",
            dt,
            "ms",
        );
        return bytes.byteLength;
    } catch (err) {
        console.error("[print/webserial] sendBytes write failed:", err);
        throw err;
    } finally {
        writer.releaseLock();
    }
}

export async function sendBytes(connected: ConnectedPort, bytes: Uint8Array): Promise<number> {
    return runSerialOperation(connected.port, () => writeBytesUnlocked(connected, bytes));
}

function encodeSerialText(text: string): Uint8Array {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const withTrailing = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
    const crlf = withTrailing.replace(/\n/g, "\r\n");
    const out = new Uint8Array(crlf.length);
    for (let i = 0; i < crlf.length; i += 1) {
        const code = crlf.charCodeAt(i);
        out[i] = code > 0xff ? 0x3f : code;
    }
    return out;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
    const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

export async function sendTextAndRead(
    connected: ConnectedPort,
    text: string,
    readWindowMs = 3500,
    readIdleMs = 250,
): Promise<string> {
    return runSerialOperation(connected.port, async () => {
        if (!connected.port.writable) {
            throw new Error("Port is not writable. Reconnect.");
        }
        const readState = ensureSerialReadState(connected);
        const chunks: Uint8Array[] = [];
        const totalWindow = Math.max(250, Math.round(readWindowMs));
        const idleWindow = Math.max(25, Math.min(totalWindow, Math.round(readIdleMs)));

        return new Promise<string>((resolve, reject) => {
            let idleTimeoutId: number | undefined;
            let settled = false;

            const cleanup = () => {
                readState.subscribers.delete(subscriber);
                window.clearTimeout(totalTimeoutId);
                if (idleTimeoutId !== undefined) window.clearTimeout(idleTimeoutId);
            };
            const finish = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(new TextDecoder("iso-8859-1").decode(concatBytes(chunks)));
            };
            const fail = (error: unknown) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(error);
            };
            const subscriber: SerialReadSubscriber = {
                onChunk: (chunk) => {
                    chunks.push(chunk);
                    if (idleTimeoutId !== undefined) window.clearTimeout(idleTimeoutId);
                    idleTimeoutId = window.setTimeout(finish, idleWindow);
                },
                onError: fail,
            };

            readState.subscribers.add(subscriber);
            const totalTimeoutId = window.setTimeout(finish, totalWindow);
            void writeBytesUnlocked(connected, encodeSerialText(text)).catch(fail);
        });
    });
}

export async function disconnect(connected: ConnectedPort): Promise<void> {
    await runSerialOperation(connected.port, async () => {
        const readState = serialReadStates.get(connected.port);
        if (readState) {
            readState.closed = true;
            await readState.reader.cancel().catch(() => undefined);
            await readState.task.catch(() => undefined);
            serialReadStates.delete(connected.port);
        }
        // Closing SerialPort directly aborts its writable stream. Close the
        // stream first so the OS/UART has a chance to drain queued tail bytes.
        const writable = connected.port.writable;
        let drainError: unknown;
        if (writable) {
            const writer = writable.getWriter();
            try {
                let timer: number | undefined;
                const timeoutError = new Error(
                    "Timed out draining the COM transmit buffer before close.",
                );
                try {
                    await Promise.race([
                        writer.ready.then(() => writer.close()),
                        new Promise<never>((_, reject) => {
                            timer = window.setTimeout(
                                () => reject(timeoutError),
                                SERIAL_OPERATION_TIMEOUT_MS,
                            );
                        }),
                    ]);
                } catch (error) {
                    if (error === timeoutError) {
                        await bestEffortAbort(writer, timeoutError);
                    }
                    drainError = error;
                } finally {
                    if (timer !== undefined) window.clearTimeout(timer);
                }
            } finally {
                writer.releaseLock();
            }
        }
        try {
            await connected.port.close();
        } catch {
            // already closed
        }
        if (drainError) throw drainError;
    });
}

function ensureSerialReadState(connected: ConnectedPort): SerialReadState {
    const existing = serialReadStates.get(connected.port);
    if (existing && !existing.closed) return existing;

    const readable = connected.port.readable;
    if (!readable) throw new Error("Port is not readable. Reconnect.");
    const reader = readable.getReader();
    const state: SerialReadState = {
        reader,
        subscribers: new Set(),
        closed: false,
        task: Promise.resolve(),
    };
    serialReadStates.set(connected.port, state);
    state.task = (async () => {
        try {
            while (!state.closed) {
                const result = await reader.read();
                if (result.done) break;
                if (!result.value || result.value.byteLength === 0) continue;
                for (const subscriber of state.subscribers) {
                    subscriber.onChunk(result.value);
                }
            }
        } catch (error) {
            if (!state.closed) {
                for (const subscriber of state.subscribers) {
                    subscriber.onError(error);
                }
            }
        } finally {
            state.closed = true;
            reader.releaseLock();
            serialReadStates.delete(connected.port);
        }
    })();
    return state;
}
