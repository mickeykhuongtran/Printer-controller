import { isZebraHostStatusDrained, parseZebraHostStatus, ZEBRA_HOST_STATUS_COMMAND } from "./zebra-printer-status";
import { printDelay } from "./print-cancellation";

type CancelSession = {
    append: (payload: Uint8Array) => Promise<unknown>;
    query: (command: string, options: { readWindowMs: number; readIdleMs: number }) => Promise<string>;
    finish: () => Promise<unknown>;
    sampleRfidCounters?: () => Promise<void>;
};

/** Caller must first stop its producer and await every in-flight label write.
 * ~JA follows those bytes on the SAME socket, so late label writes cannot refill
 * the buffer after it is cleared. It is checkpointed like other ordered writes.
 * A printer Pause is preserved: cancellation never sends Resume (~PS).
 */
export async function cancelTcpPrinterBuffer(job: CancelSession, options: {
    timeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
} = {}): Promise<{ paused: boolean }> {
    await job.append(new TextEncoder().encode("~JA\r\n"));
    const now = options.now ?? (() => performance.now());
    const sleep = options.sleep ?? printDelay;
    const deadline = now() + (options.timeoutMs ?? 20_000);
    let emptySamples = 0;
    while (now() < deadline) {
        // ~HS is needed even during Pause: ordinary printing intentionally
        // holds on Pause, whereas Cancel must verify an empty queue while paused.
        const status = parseZebraHostStatus(await job.query(ZEBRA_HOST_STATUS_COMMAND, {
            readWindowMs: 4_000, readIdleMs: 300,
        }));
        emptySamples = isZebraHostStatusDrained(status) ? emptySamples + 1 : 0;
        if (emptySamples >= 2) {
            // finish closes the checkpointed transport, not a claim that the
            // original label count printed. The caller reports CANCELLED.
            await job.sampleRfidCounters?.();
            await job.finish();
            return { paused: status.paused };
        }
        await sleep(200);
    }
    throw new Error("The printer has not confirmed an empty buffer after Cancel. Keep it paused and hold CANCEL (X) for two seconds after sending has stopped.");
}
