"use client";

import {
    DEFAULT_LOCAL_PRINT_AGENT_URL,
    fetchLocalAgentJson,
    LocalPrintAgentHttpError,
    type AgentErrorPayload,
} from "./local-print-agent";
import { resolveTcpExecutionMode } from "./tcp-print";
import type { TcpExecutionMode } from "./storage";
import { type RfidCaptureOptions, type RfidCaptureSummary } from "./rfid-capture";
import { printDelay } from "./print-cancellation";

export type TcpJobState =
    | "connecting"
    | "open"
    | "writing"
    | "finishing"
    | "finished"
    | "aborted"
    | "expired"
    | "failed"
    | "uncertain";

type TcpJobResponse = {
    counterFinishRecoverable?: boolean;
    serviceFault?: string;
    faultClearRequested?: boolean;
    capture?: RfidCaptureSummary;
    host?: string;
    port?: number;
    reconciled?: boolean;
    ok?: boolean;
    error?: string;
    code?: string;
    jobId?: string;
    state?: TcpJobState;
    jobState?: TcpJobState;
    outcome?: "not_sent" | "possibly_sent";
    nextSequence?: number;
    cumulativeBytes?: number;
    bytesWritten?: number;
    payloadSha256?: string;
    checkpointHash?: string;
    deduplicated?: boolean;
    response?: string;
};

export type TcpPrintJobAppendReceipt = {
    bytesWritten: number;
    cumulativeBytes: number;
    nextSequence: number;
    checkpointHash: string;
    deduplicated: boolean;
};

export type TcpPrintJobFinishReceipt = {
    capture?: RfidCaptureSummary;
    cumulativeBytes: number;
    chunksAccepted: number;
    checkpointHash: string;
    state: "finished";
};

export class TcpPrintJobError extends Error {
    readonly serviceFault?: string;
    readonly faultClearRequested?: boolean;
    readonly code: string;
    readonly status?: number;
    readonly state?: TcpJobState;
    readonly outcome: "not_sent" | "possibly_sent";
    readonly execution: "connector" | "server";

    constructor(
        message: string,
        details: {
            serviceFault?: string;
            faultClearRequested?: boolean;
            code?: string;
            status?: number;
            state?: TcpJobState;
            outcome?: "not_sent" | "possibly_sent";
            execution: "connector" | "server";
        },
    ) {
        super(message);
        this.name = "TcpPrintJobError";
        this.serviceFault = details.serviceFault;
        this.faultClearRequested = details.faultClearRequested;
        this.code = details.code ?? "TCP_JOB_REQUEST_FAILED";
        this.status = details.status;
        this.state = details.state;
        this.outcome = details.outcome ?? "possibly_sent";
        this.execution = details.execution;
    }
}

type TcpPrintJobOpenOptions = {
    capture?: RfidCaptureOptions;
    host: string;
    port: number;
    agentUrl?: string;
    executionMode?: TcpExecutionMode;
    connectTimeoutMs?: number;
    writeTimeoutMs?: number;
    idleTimeoutMs?: number;
    jobId?: string;
    onRetry?: (
        action: "open" | "append" | "query" | "poll" | "finish" | "abort" | "reconcile",
        attempt: number,
        maxAttempts: number,
        delayMs: number,
    ) => void;
};

const REQUEST_RETRY_DELAYS_MS = [350, 1_000, 2_000] as const;

function validNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0;
}

function validPositiveInteger(value: unknown): value is number {
    return validNonNegativeInteger(value) && value > 0;
}

function errorPayload(data: TcpJobResponse | null): AgentErrorPayload | undefined {
    if (!data) return undefined;
    return {
        ...data,
        error: data.error,
        code: data.code,
        state: data.state,
        jobState: data.jobState,
        outcome: data.outcome,
        nextSequence: data.nextSequence,
        checkpointHash: data.checkpointHash,
    };
}

function wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
        const chunk = bytes.subarray(
            offset,
            Math.min(offset + chunkSize, bytes.byteLength),
        );
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const source = new Uint8Array(bytes);
    const digest = await crypto.subtle.digest("SHA-256", source);
    return Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")).join("");
}

async function postServerJob(
    body: Record<string, unknown>,
): Promise<TcpJobResponse> {
    let response: Response;
    try {
        response = await fetch("/api/printer/tcp/job", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            cache: "no-store",
        });
    } catch (error) {
        throw new TcpPrintJobError(
            error instanceof Error ? error.message : String(error),
            {
                code: "TCP_JOB_HTTP_REQUEST_FAILED",
                execution: "server",
                outcome: "possibly_sent",
            },
        );
    }

    const data = (await response.json().catch(() => null)) as TcpJobResponse | null;
    if (!response.ok || !data?.ok) {
        const action = typeof body.action === "string" ? body.action : "";
        throw new TcpPrintJobError(
            data?.error || `Persistent TCP job returned HTTP ${response.status}.`,
            {
                code: data?.code ?? "TCP_JOB_HTTP_ERROR",
                status: response.status,
                state: data?.state ?? data?.jobState,
                serviceFault: data?.serviceFault,
                faultClearRequested: data?.faultClearRequested,
                execution: "server",
                outcome:
                    data?.outcome === "not_sent"
                        ? "not_sent"
                        : response.status === 404 && action === "open"
                            ? "not_sent"
                            : "possibly_sent",
            },
        );
    }
    return data;
}

async function postConnectorJob(
    agentUrl: string,
    body: Record<string, unknown>,
): Promise<TcpJobResponse> {
    try {
        const data = await fetchLocalAgentJson<TcpJobResponse>(
            agentUrl || DEFAULT_LOCAL_PRINT_AGENT_URL,
            "/v1/tcp/job",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            },
            // Connector writeTimeout may be 60 s; keep the HTTP envelope
            // longer so a printer applying valid TCP backpressure does not
            // create a false lost-receipt/replay cycle at 50 s.
            { timeoutMs: 90_000 },
        );
        if (!data.ok) {
            throw new LocalPrintAgentHttpError(
                502,
                data.error || "Persistent TCP job was rejected.",
                data.code,
                errorPayload(data),
            );
        }
        return data;
    } catch (error) {
        if (error instanceof LocalPrintAgentHttpError) {
            const payload = error.payload as TcpJobResponse | undefined;
            // A genuine endpoint-missing response from an old connector has
            // no job error code. TCP_JOB_NOT_FOUND after an interrupted append
            // may mean bytes reached the printer before the agent restarted;
            // classifying that 404 as not_sent would invite duplicates.
            const unsupported = (error.status === 404 || error.status === 405)
                && !error.code
                && !payload?.code;
            throw new TcpPrintJobError(
                unsupported
                    ? "The installed local print connector is too old for persistent TCP jobs. Update the connector before printing this batch."
                    : error.message,
                {
                    code: error.code ?? (unsupported
                        ? "TCP_JOB_CONNECTOR_UPDATE_REQUIRED"
                        : "TCP_JOB_CONNECTOR_HTTP_ERROR"),
                    status: error.status,
                    state: payload?.state ?? payload?.jobState,
                    serviceFault: payload?.serviceFault,
                    faultClearRequested: payload?.faultClearRequested,
                    execution: "connector",
                    outcome:
                        payload?.outcome === "not_sent" || unsupported
                            ? "not_sent"
                            : "possibly_sent",
                },
            );
        }
        throw new TcpPrintJobError(
            error instanceof Error ? error.message : String(error),
            {
                code: "TCP_JOB_CONNECTOR_REQUEST_FAILED",
                execution: "connector",
                outcome: "possibly_sent",
            },
        );
    }
}

function isRetryableRequestFailure(error: unknown): boolean {
    if (!(error instanceof TcpPrintJobError)) return true;
    // Every action is keyed by the same job/sequence, so replaying a transient
    // 5xx response cannot append the payload twice. A 4xx response is a
    // definitive validation/checkpoint decision and must stop immediately.
    return error.status === undefined || error.status >= 500;
}

export class TcpPrintJob {
    readonly jobId: string;
    readonly execution: "connector" | "server";

    private readonly agentUrl: string;
    private readonly onRetry?: TcpPrintJobOpenOptions["onRetry"];
    private nextSequence = 1;
    private cumulativeBytes = 0;
    private checkpointHash = "";
    private terminal = false;
    private operationTail: Promise<unknown> = Promise.resolve();
    private appendFailed = false;
    serviceFault = "";
    faultClearRequested = false;
    capture?: RfidCaptureSummary;

    private ordered<T>(operation: () => Promise<T>): Promise<T> {
        const pending = this.operationTail.then(operation).catch((error: unknown) => {
            if (error instanceof TcpPrintJobError && error.serviceFault) {
                this.serviceFault = error.serviceFault;
                this.faultClearRequested = !!error.faultClearRequested;
            }
            throw error;
        });
        this.operationTail = pending.catch(() => undefined);
        return pending;
    }

    static async reconcile(options: {
        jobId: string;
        host: string;
        port: number;
        agentUrl?: string;
        executionMode?: TcpExecutionMode;
        confirmed: boolean;
        note: string;
    }): Promise<void> {
        if (!options.confirmed || options.note.trim().length < 8 || options.note.length > 2000) {
            throw new Error("Confirm the printed/VOID labels and EPCs, and enter an audit note (8–2000 characters).");
        }
        const execution = resolveTcpExecutionMode(options.executionMode);
        const agentUrl = options.agentUrl || DEFAULT_LOCAL_PRINT_AGENT_URL;
        const snapshot = await TcpPrintJob.postWithRetry(execution, agentUrl,
            { action: "poll", jobId: options.jobId }, "poll");
        if (snapshot.jobId !== options.jobId
            || snapshot.host?.toLowerCase() !== options.host.trim().toLowerCase()
            || snapshot.port !== options.port
            || !validPositiveInteger(snapshot.nextSequence)
            || !validNonNegativeInteger(snapshot.cumulativeBytes)
            || !snapshot.checkpointHash) {
            throw new Error("Stopped job does not match this printer or its checkpoint could not be verified. Update the connector if it predates reconciliation support.");
        }
        const response = await TcpPrintJob.postWithRetry(execution, agentUrl, {
            action: "reconcile", jobId: options.jobId,
            confirmed: true, reconciliationNote: options.note.trim(),
            expectedSequence: snapshot.nextSequence - 1,
            expectedBytes: snapshot.cumulativeBytes,
            checkpointHash: snapshot.checkpointHash,
        }, "reconcile");
        if (response.jobId !== options.jobId || response.reconciled !== true) {
            throw new Error("The connector did not confirm reconciliation. No labels were resent.");
        }
    }

    private constructor(
        jobId: string,
        execution: "connector" | "server",
        agentUrl: string,
        response: TcpJobResponse,
        onRetry?: TcpPrintJobOpenOptions["onRetry"],
    ) {
        this.jobId = jobId;
        this.execution = execution;
        this.agentUrl = agentUrl;
        this.onRetry = onRetry;
        this.capture = response.capture;
        if (validPositiveInteger(response.nextSequence)) {
            this.nextSequence = response.nextSequence;
        }
        if (validNonNegativeInteger(response.cumulativeBytes)) {
            this.cumulativeBytes = response.cumulativeBytes;
        }
        this.checkpointHash = response.checkpointHash ?? "";
    }

    static async open(options: TcpPrintJobOpenOptions): Promise<TcpPrintJob> {
        const execution = resolveTcpExecutionMode(options.executionMode);
        if (options.capture && execution !== "connector") {
            throw new Error("RFID session history requires TCP through the local connector. Select Local connector in TCP settings.");
        }
        const jobId = options.jobId ?? crypto.randomUUID();
        const agentUrl = options.agentUrl || DEFAULT_LOCAL_PRINT_AGENT_URL;
        const body = {
            action: "open",
            jobId,
            host: options.host,
            port: options.port,
            connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
            writeTimeoutMs: options.writeTimeoutMs ?? 30_000,
            idleTimeoutMs: options.idleTimeoutMs ?? 5 * 60_000,
            capture: options.capture,
        };
        let response: TcpJobResponse;
        try {
            response = await TcpPrintJob.postWithRetry(
                execution,
                agentUrl,
                body,
                "open",
                options.onRetry,
            );
        } catch (error) {
            if (
                error instanceof TcpPrintJobError
                && error.outcome === "possibly_sent"
            ) {
                try {
                    const polled = await TcpPrintJob.postWithRetry(
                        execution,
                        agentUrl,
                        { action: "poll", jobId },
                        "poll",
                        options.onRetry,
                    );
                    if (polled.jobId === jobId && polled.state === "open") {
                        response = polled;
                    } else {
                        throw error;
                    }
                } catch {
                    throw error;
                }
            } else {
                throw error;
            }
        }
        if (response.jobId !== jobId || response.state !== "open") {
            throw new TcpPrintJobError(
                "Persistent TCP endpoint returned an invalid open receipt.",
                {
                    code: "TCP_JOB_INVALID_OPEN_RECEIPT",
                    state: response.state,
                    execution,
                    outcome: "not_sent",
                },
            );
        }
        if (options.capture && (!response.capture || response.capture.jobId !== jobId
            || response.capture.options.expectedLabels !== options.capture.expectedLabels
            || (options.capture.auditBatchCounters && (!response.capture.options.auditBatchCounters
                || (response.capture.audit?.lifecycleVersion ?? 0) < 1)))) {
            await postConnectorJob(agentUrl, { action: "abort", jobId }).catch(() => undefined);
            throw new Error("Cập nhật connector: phiên bản này chưa xác nhận tự lấy và chốt counter RFID. Chưa gửi dữ liệu tem.");
        }
        return new TcpPrintJob(
            jobId,
            execution,
            agentUrl,
            response,
            options.onRetry,
        );
    }

    private static async postWithRetry(
        execution: "connector" | "server",
        agentUrl: string,
        body: Record<string, unknown>,
        action: "open" | "append" | "query" | "poll" | "finish" | "abort" | "reconcile",
        onRetry?: TcpPrintJobOpenOptions["onRetry"],
    ): Promise<TcpJobResponse> {
        const maxAttempts = REQUEST_RETRY_DELAYS_MS.length + 1;
        for (let attempt = 1; ; attempt += 1) {
            try {
                return execution === "server"
                    ? await postServerJob(body)
                    : await postConnectorJob(agentUrl, body);
            } catch (error) {
                const delayMs = REQUEST_RETRY_DELAYS_MS[attempt - 1];
                // Query responses are not checkpointed/cached. Replaying a
                // raw status command after a lost HTTP response can consume or
                // misassociate stream data, so stop after the first attempt.
                if (action === "query") throw error;
                // Network/timeouts and transient 5xx responses are safe to
                // replay because the action keeps the same job/sequence key.
                // Validation and checkpoint conflicts (4xx) are definitive.
                if (!isRetryableRequestFailure(error) || delayMs === undefined) {
                    throw error;
                }
                onRetry?.(action, attempt + 1, maxAttempts, delayMs);
                await wait(delayMs);
            }
        }
    }

    async append(payload: Uint8Array): Promise<TcpPrintJobAppendReceipt> {
        const snapshot = new Uint8Array(payload);
        return this.ordered(async () => {
            if (this.serviceFault) throw new Error("This run stopped after a printer service fault. Reconcile it before starting a new run; its labels cannot be resumed.");
            if (this.appendFailed) throw new Error("A previous append failed; later chunks were not sent. Abort and reconcile this job.");
            try { return await this.appendOrdered(snapshot); }
            catch (error) { this.appendFailed = true; throw error; }
        });
    }

    private async appendOrdered(payload: Uint8Array): Promise<TcpPrintJobAppendReceipt> {
        if (this.terminal) {
            throw new TcpPrintJobError(
                "Cannot append to a finished or aborted TCP job.",
                {
                    code: "TCP_JOB_TERMINAL",
                    execution: this.execution,
                    outcome: "not_sent",
                },
            );
        }
        if (payload.byteLength < 1) {
            throw new TcpPrintJobError("Cannot append an empty TCP chunk.", {
                code: "TCP_JOB_EMPTY_CHUNK",
                execution: this.execution,
                outcome: "not_sent",
            });
        }

        const sequence = this.nextSequence;
        const payloadSha256 = await sha256Hex(payload);
        let response: TcpJobResponse;
        try {
            response = await TcpPrintJob.postWithRetry(
                this.execution,
                this.agentUrl,
                {
                    action: "append",
                    jobId: this.jobId,
                    sequence,
                    payloadBase64: bytesToBase64(payload),
                    payloadSha256,
                },
                "append",
                this.onRetry,
            );
        } catch (error) {
            if (
                error instanceof TcpPrintJobError
                && error.outcome === "possibly_sent"
            ) {
                try {
                    const polled = await TcpPrintJob.postWithRetry(
                        this.execution,
                        this.agentUrl,
                        { action: "poll", jobId: this.jobId },
                        "poll",
                        this.onRetry,
                    );
                    if (
                        polled.jobId === this.jobId
                        && polled.state === "open"
                        && polled.nextSequence === sequence + 1
                        && polled.cumulativeBytes
                            === this.cumulativeBytes + payload.byteLength
                        && !!polled.checkpointHash
                    ) {
                        response = {
                            ...polled,
                            bytesWritten: payload.byteLength,
                            payloadSha256,
                            deduplicated: true,
                        };
                    } else {
                        throw error;
                    }
                } catch {
                    throw error;
                }
            } else {
                throw error;
            }
        }

        const bytesWritten = response.bytesWritten;
        const nextSequence = response.nextSequence;
        const cumulativeBytes = response.cumulativeBytes;
        const checkpointHash = response.checkpointHash ?? "";
        if (
            response.jobId !== this.jobId
            || response.payloadSha256 !== payloadSha256
            || !validNonNegativeInteger(bytesWritten)
            || bytesWritten !== payload.byteLength
            || !validPositiveInteger(nextSequence)
            || nextSequence !== sequence + 1
            || !validNonNegativeInteger(cumulativeBytes)
            || cumulativeBytes !== this.cumulativeBytes + payload.byteLength
            || !checkpointHash
        ) {
            throw new TcpPrintJobError(
                "Persistent TCP endpoint returned an invalid append receipt; do not resend this chunk automatically.",
                {
                    code: "TCP_JOB_INVALID_APPEND_RECEIPT",
                    state: response.state,
                    execution: this.execution,
                    outcome: "possibly_sent",
                },
            );
        }

        this.nextSequence = nextSequence;
        this.cumulativeBytes = cumulativeBytes;
        this.checkpointHash = checkpointHash;
        this.capture = response.capture ?? this.capture;
        if (response.serviceFault) {
            throw new TcpPrintJobError(`Printer run stopped: ${response.serviceFault}.`, {
                code: "TCP_JOB_SERVICE_FAULT", execution: this.execution, outcome: "possibly_sent",
                serviceFault: response.serviceFault, faultClearRequested: response.faultClearRequested,
            });
        }
        return {
            bytesWritten,
            cumulativeBytes,
            nextSequence,
            checkpointHash,
            deduplicated: response.deduplicated === true,
        };
    }

    /**
     * Writes a non-printing Zebra status command and reads its response on the
     * same persistent 9100 socket. This preserves ordering with the preceding
     * print checkpoint and avoids a competing second printer connection.
     */
    async query(
        command: string,
        options: { readWindowMs?: number; readIdleMs?: number } = {},
    ): Promise<string> {
        return this.ordered(() => this.queryOrdered(command, options));
    }

    private async queryOrdered(command: string, options: { readWindowMs?: number; readIdleMs?: number }): Promise<string> {
        if (this.terminal) {
            throw new TcpPrintJobError("Cannot query a finished or aborted TCP job.", {
                code: "TCP_JOB_TERMINAL",
                execution: this.execution,
                outcome: "not_sent",
            });
        }
        const payload = new TextEncoder().encode(command);
        if (payload.byteLength < 1) {
            throw new TcpPrintJobError("Cannot send an empty TCP status query.", {
                code: "TCP_JOB_QUERY_EMPTY",
                execution: this.execution,
                outcome: "not_sent",
            });
        }
        let response: TcpJobResponse;
        try {
            response = await TcpPrintJob.postWithRetry(
                this.execution,
                this.agentUrl,
                {
                    action: "query",
                    jobId: this.jobId,
                    payloadBase64: bytesToBase64(payload),
                    readWindowMs: options.readWindowMs ?? 8_000,
                    readIdleMs: options.readIdleMs ?? 300,
                },
                "query",
                this.onRetry,
            );
        } catch (error) {
            if (error instanceof TcpPrintJobError) {
                if (error.code === "TCP_JOB_SERVICE_FAULT" || error.code === "TCP_JOB_FAULT_CLEAR_FAILED") {
                    this.serviceFault = error.serviceFault ?? error.message;
                    this.faultClearRequested = !!error.faultClearRequested;
                } else if (error.code?.startsWith("TCP_JOB_QUERY_") || error.code === "RFID_CAPTURE_QUERY_FAILED") {
                    this.serviceFault = "Printer status unavailable. Keep the printer paused and reconcile this run.";
                }
                throw new TcpPrintJobError(error.message, {
                    code: error.code,
                    status: error.status,
                    state: error.state,
                    execution: error.execution,
                    serviceFault: error.serviceFault,
                    faultClearRequested: error.faultClearRequested,
                    // The current print checkpoint may already be committed;
                    // a barrier failure must never tell the operator to resume
                    // from the same labels.
                    outcome: "possibly_sent",
                });
            }
            throw error;
        }
        if (response.jobId !== this.jobId || typeof response.response !== "string") {
            throw new TcpPrintJobError(
                "Persistent TCP endpoint returned an invalid status-query receipt.",
                {
                    code: "TCP_JOB_INVALID_QUERY_RECEIPT",
                    state: response.state,
                    execution: this.execution,
                    outcome: "possibly_sent",
                },
            );
        }
        this.capture = response.capture ?? this.capture;
        if (response.serviceFault) {
            this.serviceFault = response.serviceFault;
            this.faultClearRequested = !!response.faultClearRequested;
            // Counter reads remain possible for the interrupted-run audit, but
            // no later status response may release the print stream again.
            if (command.trim() === "~HQES" || command.trim() === "~HS") {
                throw new TcpPrintJobError(`Printer service fault: ${this.serviceFault}. The run is stopped; pause and buffer clear were ${this.faultClearRequested ? "requested" : "not confirmed"}. Reconcile printed labels before a new run.`, {
                    code: "TCP_JOB_SERVICE_FAULT", execution: this.execution, outcome: "possibly_sent",
                });
            }
        }
        return response.response;
    }

    async finish(): Promise<TcpPrintJobFinishReceipt> {
        return this.ordered(() => this.finishOrdered());
    }

    /** Finish only a complete, checkpoint-matched native proof after a lost
     * foreground status response. This never invents a live status response,
     * resends labels, or opens a printer connection. Native finish revalidates
     * the proof before releasing the transport reservation. */
    async finishFromCounterProof(): Promise<TcpPrintJobFinishReceipt | undefined> {
        return this.ordered(async () => {
            if (this.terminal || this.appendFailed || this.execution !== "connector" || !this.capture?.options.auditBatchCounters
                || this.nextSequence <= 1 || this.cumulativeBytes <= 0) return undefined;
            const expected = this.capture.options.expectedLabels;
            const completeProof = (capture?: RfidCaptureSummary): boolean => {
                const audit = capture?.audit;
                return !!capture && capture.jobId === this.jobId && !capture.error && capture.options.expectedLabels === expected
                    && audit?.lifecycleVersion === 1 && audit.finalizationStatus === "verified" && audit.countsKnown === true
                    && audit.submittedAttemptsKnown === true && audit.submittedAttempts === expected
                    && audit.finalCounterProof?.method === "same_socket_drained_stable_v1"
                    && audit.finalCounterProof.sequence === this.nextSequence - 1
                    && validNonNegativeInteger(audit.validDelta) && validNonNegativeInteger(audit.voidDelta)
                    && audit.validDelta + audit.voidDelta === expected;
            };
            try {
                const snapshot = await TcpPrintJob.postWithRetry(this.execution, this.agentUrl,
                    { action: "poll", jobId: this.jobId }, "poll", this.onRetry);
                if (snapshot.jobId !== this.jobId || snapshot.nextSequence !== this.nextSequence
                    || snapshot.cumulativeBytes !== this.cumulativeBytes || snapshot.checkpointHash !== this.checkpointHash
                    || snapshot.serviceFault || snapshot.faultClearRequested || !completeProof(snapshot.capture)
                    || !(snapshot.state === "open" || snapshot.state === "finished"
                        || snapshot.state === "uncertain" && snapshot.counterFinishRecoverable === true)) return undefined;
                this.capture = snapshot.capture;
                const receipt = await this.finishOrdered();
                if (!completeProof(receipt.capture)) return undefined;
                // queryOrdered may have latched an unavailable-status message.
                // Native finish confirms this run only, not live printer health.
                this.serviceFault = "";
                this.faultClearRequested = false;
                return receipt;
            } catch { return undefined; }
        });
    }

    async sampleRfidCounters(): Promise<void> {
        if (this.terminal || !this.capture?.options.auditBatchCounters) return;
        // A connector-owned session serializes, persists and finalizes its own
        // sample rounds. Browser queries must never overwrite those checkpoints.
        if ((this.capture.audit?.lifecycleVersion ?? 0) >= 1) return;
        for (const name of ["odometer.rfid.valid_resettable", "odometer.rfid.void_resettable", "odometer.total_label_count"]) {
            await this.query(`! U1 getvar "${name}"\r\n`);
        }
    }

    private async finishOrdered(): Promise<TcpPrintJobFinishReceipt> {
        if (this.terminal) {
            throw new TcpPrintJobError("TCP job is already terminal.", {
                code: "TCP_JOB_TERMINAL",
                execution: this.execution,
                outcome: "not_sent",
            });
        }
        const chunksAccepted = this.nextSequence - 1;
        const finishBody = {
            action: "finish",
            jobId: this.jobId,
            expectedSequence: chunksAccepted,
            expectedBytes: this.cumulativeBytes,
            checkpointHash: this.checkpointHash,
        };
        let response: TcpJobResponse;
        try {
            response = await TcpPrintJob.postWithRetry(
                this.execution,
                this.agentUrl,
                finishBody,
                "finish",
                this.onRetry,
            );
        } catch (error) {
            if (
                error instanceof TcpPrintJobError
                && error.outcome === "possibly_sent"
            ) {
                try {
                    const polled = await TcpPrintJob.postWithRetry(
                        this.execution,
                        this.agentUrl,
                        { action: "poll", jobId: this.jobId },
                        "poll",
                        this.onRetry,
                    );
                    if (
                        polled.jobId === this.jobId
                        && polled.state === "finished"
                        && polled.nextSequence === this.nextSequence
                        && polled.cumulativeBytes === this.cumulativeBytes
                        && polled.checkpointHash === this.checkpointHash
                    ) {
                        response = polled;
                    } else {
                        throw error;
                    }
                } catch {
                    throw error;
                }
            } else {
                throw error;
            }
        }
        if (
            response.jobId !== this.jobId
            || response.state !== "finished"
            || response.nextSequence !== this.nextSequence
            || response.cumulativeBytes !== this.cumulativeBytes
            || response.checkpointHash !== this.checkpointHash
        ) {
            throw new TcpPrintJobError(
                "Persistent TCP endpoint returned an invalid finish receipt.",
                {
                    code: "TCP_JOB_INVALID_FINISH_RECEIPT",
                    state: response.state,
                    execution: this.execution,
                    outcome: "possibly_sent",
                },
            );
        }
        this.terminal = true;
        this.capture = response.capture ?? this.capture;
        return {
            capture: this.capture,
            cumulativeBytes: this.cumulativeBytes,
            chunksAccepted,
            checkpointHash: this.checkpointHash,
            state: "finished",
        };
    }

    async abort(): Promise<void> {
        return this.ordered(() => this.abortOrdered());
    }

    private async abortOrdered(): Promise<void> {
        if (this.terminal) return;
        try {
            await TcpPrintJob.postWithRetry(
                this.execution,
                this.agentUrl,
                { action: "abort", jobId: this.jobId },
                "abort",
                this.onRetry,
            );
        } finally {
            this.terminal = true;
        }
    }

    /** Call after the final printer drain, while the receive socket is still open. */
    async waitForCapture(signal?: AbortSignal, timeoutMs = 2_000): Promise<RfidCaptureSummary | undefined> {
        if (!this.capture) return undefined;
        const deadline = Date.now() + timeoutMs;
        let lastReceived = -1;
        let quietSince = Date.now();
        for (;;) {
            signal?.throwIfAborted();
            const result = await this.ordered(() => TcpPrintJob.postWithRetry(this.execution, this.agentUrl,
                { action: "poll", jobId: this.jobId }, "poll", this.onRetry));
            if (!result.capture || result.jobId !== this.jobId) throw new Error("RFID capture receipt is missing.");
            this.capture = result.capture;
            if (result.serviceFault) throw new TcpPrintJobError(`Printer run stopped: ${result.serviceFault}.`, {
                code: "TCP_JOB_SERVICE_FAULT", execution: this.execution, outcome: "possibly_sent",
                serviceFault: result.serviceFault, faultClearRequested: result.faultClearRequested,
            });
            if (this.capture.error) throw new Error(`RFID evidence could not be saved: ${this.capture.error}`);
            if (this.capture.received !== lastReceived) {
                lastReceived = this.capture.received;
                quietSince = Date.now();
            }
            // Called only after the printer drain barrier. A failed inlay may
            // have no ^HV body, and duplicate/read-error evidence must not turn
            // a completed physical run into a locked session. The connector
            // performs a final receive drain and records audit quality on close.
            if (Date.now() >= deadline || Date.now() - quietSince >= 400) {
                return this.capture;
            }
            await printDelay(200, signal);
        }
    }
}
