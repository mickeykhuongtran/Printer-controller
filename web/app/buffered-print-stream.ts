/** Render ahead while one consumer sends/checks the printer, with bounded memory.
 * At most maxChunks/maxBytes are queued, plus one item being rendered and sent.
 * Stop on either failure, await the in-flight operation, and never replay items.
 */
export async function deliverBufferedPrintStream<T extends { payload: Uint8Array }>(
    source: AsyncIterable<T>,
    consume: (item: T) => Promise<void>,
    { maxChunks = 4, maxBytes = 1024 * 1024, abortSignal }: {
        maxChunks?: number; maxBytes?: number; abortSignal?: AbortSignal;
    } = {},
): Promise<void> {
    if (!Number.isInteger(maxChunks) || maxChunks < 1 || !Number.isFinite(maxBytes) || maxBytes < 1) {
        throw new Error("Print lookahead limits must be positive.");
    }
    const queue: T[] = [];
    let queuedBytes = 0, stopped = false, done = false, primed = false;
    let failure: { error: unknown } | undefined;
    let signal!: () => void;
    const newSignal = () => new Promise<void>((resolve) => { signal = resolve; });
    let changed = newSignal();
    const notify = () => { signal(); changed = newSignal(); };
    const abort = () => {
        stopped = true;
        failure = { error: abortSignal!.reason };
        notify();
    };
    abortSignal?.throwIfAborted();
    abortSignal?.addEventListener("abort", abort, { once: true });
    const full = () => queue.length >= maxChunks || queuedBytes >= maxBytes;
    const producer = (async () => {
        try {
            for await (const item of source) {
                abortSignal?.throwIfAborted();
                while (!stopped && (full() || (queue.length > 0 && queuedBytes + item.payload.byteLength > maxBytes))) {
                    primed = true;
                    notify();
                    await changed;
                }
                if (stopped) break;
                queue.push(item);
                queuedBytes += item.payload.byteLength;
                if (full()) primed = true;
                notify();
            }
        } catch (error) {
            failure = { error };
        } finally {
            done = true;
            notify();
        }
    })();
    try {
        while (true) {
            abortSignal?.throwIfAborted();
            if (failure) throw failure.error;
            if ((!primed && !done) || (!queue.length && !done)) {
                await changed;
                continue;
            }
            const item = queue.shift();
            if (!item) break;
            queuedBytes -= item.payload.byteLength;
            notify();
            await consume(item);
        }
    } finally {
        stopped = true;
        notify();
        await producer;
        abortSignal?.removeEventListener("abort", abort);
        queue.length = 0;
    }
}
