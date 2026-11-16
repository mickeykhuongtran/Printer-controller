import {
    isZebraHostStatusDrained,
    parseZebraHostStatus,
    parseZebraHqesStatus,
    ZEBRA_HOST_STATUS_COMMAND,
    ZEBRA_HQES_STATUS_COMMAND,
} from "./zebra-printer-status";
import { printDelay } from "./print-cancellation";

export type ZebraDrainState = "paused" | "draining" | "buffering";

type DrainOptions = {
    /** Omit for final drain. Otherwise release while the bounded queue has room. */
    maxBufferedFormats?: number;
    signal?: AbortSignal;
    onStateChange?: (state: ZebraDrainState) => void;
    timeoutMs?: number;
    pollIntervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
};

/** A payload was accepted, but its subsequent status check failed. */
export class ZebraDrainError extends Error {
    constructor(readonly bytesWritten: number, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = "ZebraDrainError";
    }
}

/**
 * Wait for queue headroom (streaming) or an empty queue (final drain).
 * Use the same transport after a chunk has been written. Operator pause
 * holds the job and its FIFO position; it never retries the label payload.
 * Successful status queries also keep the persistent connector session alive.
 */
export async function waitForZebraDrainBarrier(
    query: (command: string) => Promise<string>,
    options: DrainOptions = {},
): Promise<string | undefined> {
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const streaming = options.maxBufferedFormats !== undefined;
    if (streaming && (!Number.isInteger(options.maxBufferedFormats) || options.maxBufferedFormats! < 0)) {
        throw new Error("Buffered format limit must be a non-negative integer.");
    }
    const pollIntervalMs = options.pollIntervalMs ?? (streaming ? 100 : 250);
    const now = options.now ?? (() => performance.now());
    const sleep = options.sleep ?? ((ms) => printDelay(ms, options.signal));
    const warnings = new Set<string>();
    let lastDiagnosis = "No successful ~HQES response yet";
    let activeElapsedMs = 0;
    let lastSample = now();
    let previousState: ZebraDrainState | undefined;

    while (true) {
        options.signal?.throwIfAborted();
        // ~HS can be silent on hard faults. Diagnose with ~HQES first on
        // every poll, including while the operator has paused the printer.
        let health: ReturnType<typeof parseZebraHqesStatus>;
        try {
            health = parseZebraHqesStatus(await query(ZEBRA_HQES_STATUS_COMMAND));
        } catch (error) {
            throw new Error(`Zebra ~HQES health query failed; last successful diagnosis (${lastDiagnosis}): ${String(error)}`);
        }
        options.signal?.throwIfAborted();
        lastDiagnosis = health.reasons.join("; ");
        if (health.level === "error") {
            throw new Error(`Zebra status barrier stopped the next chunk: ${lastDiagnosis}`);
        }
        health.warnings.forEach((warning) => warnings.add(warning));

        let host: ReturnType<typeof parseZebraHostStatus> | undefined;
        if (!health.paused) {
            try {
                host = parseZebraHostStatus(await query(ZEBRA_HOST_STATUS_COMMAND));
            } catch (error) {
                throw new Error(`Zebra ~HS drain query failed after the last ~HQES diagnosis (${lastDiagnosis}): ${String(error)}`);
            }
            options.signal?.throwIfAborted();
            const faults = [
                host.paperOut ? "Media out" : "",
                host.diagnosticMode ? "Diagnostic mode is active" : "",
                host.corruptRam ? "Corrupt RAM" : "",
                host.underTemperature ? "Printhead under temperature" : "",
                host.overTemperature ? "Printhead over temperature" : "",
                host.headUp ? "Printhead open" : "",
                host.ribbonOut ? "Ribbon out" : "",
            ].filter(Boolean);
            if (faults.length) {
                throw new Error(`Zebra status barrier stopped the next chunk: ${faults.join("; ")}`);
            }
        }

        const state: ZebraDrainState = health.paused || host?.paused ? "paused" : streaming ? "buffering" : "draining";
        const sampledAt = now();
        // Exclude intervals touching a confirmed pause, including the first
        // resumed poll. Repeated pauses do not reset accumulated active time.
        if (state !== "paused" && previousState !== "paused") {
            activeElapsedMs += Math.max(0, sampledAt - lastSample);
        }
        lastSample = sampledAt;
        if (state !== previousState) options.onStateChange?.(state);
        previousState = state;

        if (state !== "paused" && host) {
            const ready = streaming
                ? !host.bufferFull && !host.partialFormat && host.formatsInReceiveBuffer <= options.maxBufferedFormats!
                : isZebraHostStatusDrained(host);
            if (ready) {
                return warnings.size ? `Zebra warning: ${[...warnings].join("; ")}` : undefined;
            }
            if (activeElapsedMs >= timeoutMs) {
                throw new Error(`Zebra drain barrier timed out after ${Math.floor(timeoutMs / 60_000)} active minutes (operator pauses excluded; formats=${host.formatsInReceiveBuffer}, bufferFull=${Number(host.bufferFull)}, partialFormat=${Number(host.partialFormat)}, labelsRemaining=${host.labelsRemaining}, labelWaiting=${Number(host.labelWaiting)}; lastHQES=${lastDiagnosis}).`);
            }
        }
        await sleep(state === "paused" ? Math.max(1_000, pollIntervalMs) : pollIntervalMs);
    }
}
