/** Intentional cancellation is distinct from a printer Pause or an I/O failure. */
export class PrintCancelledError extends Error {
    constructor() {
        super("The operator cancelled this print batch.");
        this.name = "PrintCancelledError";
    }
}

export class PrintCancellation {
    private readonly controller = new AbortController();
    private accepting = true;
    get signal(): AbortSignal { return this.controller.signal; }
    request(): boolean {
        if (!this.accepting || this.signal.aborted) return false;
        this.controller.abort(new PrintCancelledError());
        return true;
    }
    /** Close the cancel race before committing the final transport receipt. */
    seal(): void {
        this.signal.throwIfAborted();
        this.accepting = false;
    }
}

export function printDelay(ms: number, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal!.reason); };
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", abort, { once: true });
    });
}
