/** Durable preparation is separate from Windows spool submission. */
export type RawSpoolBatchState = "staging" | "queued" | "spooling" | "spool-accepted" | "failed" | "uncertain" | "cancelled";

export type RawSpoolBatchStatus = {
    ok: boolean;
    batchId: string;
    state: RawSpoolBatchState;
    nextSequence: number;
    stagedBytes: number;
    stagedLabels: number;
    totalLabels: number;
    jobId: number | null;
    printerName?: string;
    documentName?: string;
    error?: string;
    recoveryRequired?: boolean;
};

export type RawSpoolBatchTransport = (request: Record<string, unknown>) => Promise<RawSpoolBatchStatus>;

export function isDefiniteSpoolRejection(error: unknown): boolean {
    const status = (error as { status?: unknown } | null)?.status;
    return typeof status === "number" && status >= 400 && status < 500 && status !== 408 && status !== 409;
}

export class RawSpoolBatchPendingError extends Error {
    constructor(public readonly batchId: string, public readonly status?: RawSpoolBatchStatus) {
        super(`Batch ${batchId} is retained by the connector${status ? ` (${status.state})` : ""}. Check its status in Windows spool jobs; do not submit it again as a new batch.`);
        this.name = "RawSpoolBatchPendingError";
    }
}

export function spoolPayloadBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

/** All mutating retries use exactly the same ID, sequence and payload. */
export class RawSpoolBatch {
    private sequence = 1;
    private bytes = 0;
    private labels = 0;
    private begun = false;
    private preparationMayExist = false;
    private commitAttempted = false;
    private latest?: RawSpoolBatchStatus;

    constructor(
        private readonly transport: RawSpoolBatchTransport,
        readonly options: { batchId: string; printerName: string; documentName: string; totalLabels: number },
        private readonly onStatus?: (status: RawSpoolBatchStatus) => void,
        private readonly onBeginRejected?: () => void,
    ) {}

    private async classifyBeginFailure(error: unknown): Promise<void> {
        if ((error as { status?: number } | null)?.status === 409) {
            try { await this.request("status"); }
            catch (statusError) {
                if ((statusError as { status?: number } | null)?.status === 404) {
                    this.preparationMayExist = false;
                    this.onBeginRejected?.();
                    throw error;
                }
                throw new RawSpoolBatchPendingError(this.options.batchId, this.latest);
            }
            this.commitAttempted = true;
            throw new RawSpoolBatchPendingError(this.options.batchId, this.latest);
        }
        if (isDefiniteSpoolRejection(error)) {
            this.preparationMayExist = false;
            this.onBeginRejected?.();
            throw error;
        }
    }

    private async request(action: string, fields: Record<string, unknown> = {}): Promise<RawSpoolBatchStatus> {
        const result = await this.transport({ action, batchId: this.options.batchId, ...fields });
        if (!result || result.ok !== true || result.batchId !== this.options.batchId
            || !["staging", "queued", "spooling", "spool-accepted", "failed", "uncertain", "cancelled"].includes(result.state)
            || !Number.isSafeInteger(result.nextSequence) || result.nextSequence < 1
            || !Number.isSafeInteger(result.stagedBytes) || result.stagedBytes < 0
            || !Number.isSafeInteger(result.stagedLabels) || result.stagedLabels < 0
            || result.totalLabels !== this.options.totalLabels) {
            throw new Error("Invalid durable spool batch response.");
        }
        this.latest = result;
        this.onStatus?.(result);
        return result;
    }

    async begin(): Promise<RawSpoolBatchStatus> {
        if (!Number.isSafeInteger(this.options.totalLabels) || this.options.totalLabels < 1) {
            throw new Error("Batch label count must be a positive safe integer.");
        }
        const { printerName, documentName, totalLabels } = this.options;
        let status: RawSpoolBatchStatus;
        this.preparationMayExist = true;
        try {
            status = await this.request("begin", { printerName, documentName, totalLabels });
        } catch (error) {
            await this.classifyBeginFailure(error);
            // A lost begin response must not allocate a second queue reservation.
            try { status = await this.request("begin", { printerName, documentName, totalLabels }); }
            catch (retryError) {
                await this.classifyBeginFailure(retryError);
                throw new RawSpoolBatchPendingError(this.options.batchId, this.latest);
            }
        }
        if (status.state !== "staging" || status.nextSequence !== 1 || status.stagedBytes !== 0) {
            this.commitAttempted = true; // Existing work requires an explicit recovery decision.
            throw new RawSpoolBatchPendingError(this.options.batchId, status);
        }
        this.begun = true;
        return status;
    }

    async append(payload: Uint8Array, labelCount: number): Promise<RawSpoolBatchStatus> {
        if (!this.begun || this.commitAttempted) throw new Error("Batch is not accepting staged chunks.");
        if (!payload.byteLength || !Number.isSafeInteger(labelCount) || labelCount < 1
            || this.labels + labelCount > this.options.totalLabels) throw new Error("Invalid staged chunk totals.");
        const fields = { sequence: this.sequence, labelCount, payloadBase64: spoolPayloadBase64(payload) };
        let status: RawSpoolBatchStatus;
        try { status = await this.request("append", fields); }
        catch { status = await this.request("append", fields); }
        if (status.state !== "staging" || status.nextSequence !== this.sequence + 1
            || status.stagedBytes !== this.bytes + payload.byteLength
            || status.stagedLabels !== this.labels + labelCount) {
            throw new Error("Staged chunk checkpoint does not match its exact byte and label totals.");
        }
        this.sequence += 1;
        this.bytes += payload.byteLength;
        this.labels += labelCount;
        return status;
    }

    async commit(options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<RawSpoolBatchStatus> {
        if (!this.begun || this.labels !== this.options.totalLabels) throw new Error("Cannot commit an incomplete label batch.");
        this.commitAttempted = true;
        const fields = { totalChunks: this.sequence - 1, totalBytes: this.bytes };
        try { await this.request("commit", fields); }
        catch {
            // commit is idempotent: a timeout never causes a new spool job.
            try { await this.request("commit", fields); }
            catch { /* Query the same durable batch below. */ }
        }
        const deadline = Date.now() + (options.timeoutMs ?? 120_000);
        const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
        for (;;) {
            try { await this.request("status"); } catch { /* Retain the last known status while disconnected. */ }
            const status = this.latest;
            if (status?.state === "spool-accepted") {
                if (status.stagedBytes !== this.bytes || status.stagedLabels !== this.labels
                    || !Number.isSafeInteger(status.jobId) || (status.jobId ?? 0) < 1) {
                    throw new RawSpoolBatchPendingError(this.options.batchId, status);
                }
                return status;
            }
            if (status?.state === "failed" || status?.state === "uncertain" || status?.state === "cancelled" || status?.recoveryRequired) {
                throw new RawSpoolBatchPendingError(this.options.batchId, status);
            }
            if (Date.now() >= deadline) throw new RawSpoolBatchPendingError(this.options.batchId, status);
            await sleep(options.pollMs ?? 1_000);
        }
    }

    /** Preparation errors cannot print; cancellation releases the reserved lane. */
    async cancelPreparation(): Promise<void> {
        if (this.commitAttempted || !this.preparationMayExist) return;
        try { await this.request("cancel"); }
        catch { throw new RawSpoolBatchPendingError(this.options.batchId, this.latest); }
    }
}
