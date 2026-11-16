import { createHash, randomUUID } from "node:crypto";
import net from "node:net";
import { hasCompleteZebraStatusResponse } from "../../../../zebra-status-framing";
import {
    serverTcpPrinterKey,
    withServerPrinterQueue,
} from "../../../../server-printer-queue";

const MAX_APPEND_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_JOB_BYTES = 1024 * 1024 * 1024;
const MAX_JOB_SEQUENCE = Number.MAX_SAFE_INTEGER - 1;
const MAX_ACTIVE_JOBS = 4;
const MAX_RETAINED_JOBS = 512;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const TERMINAL_RETENTION_MS = 60 * 60_000;
const FINISH_CLOSE_WAIT_MS = 2_000;
const MAX_QUERY_RESPONSE_BYTES = 4 * 1024 * 1024;

type TcpJobState =
    | "connecting"
    | "open"
    | "finishing"
    | "finished"
    | "aborted"
    | "expired"
    | "failed"
    | "uncertain";

type TcpJobAction = "open" | "append" | "query" | "poll" | "finish" | "abort" | "reconcile";

type TcpJobRequest = {
    confirmed?: unknown;
    reconciliationNote?: unknown;
    action?: unknown;
    jobId?: unknown;
    host?: unknown;
    port?: unknown;
    connectTimeoutMs?: unknown;
    writeTimeoutMs?: unknown;
    idleTimeoutMs?: unknown;
    sequence?: unknown;
    payloadBase64?: unknown;
    payloadSha256?: unknown;
    readWindowMs?: unknown;
    readIdleMs?: unknown;
    expectedSequence?: unknown;
    expectedBytes?: unknown;
    checkpointHash?: unknown;
};

type AppendReceipt = {
    sequence: number;
    bytesWritten: number;
    cumulativeBytes: number;
    payloadSha256: string;
    checkpointHash: string;
};

type FinishExpectation = {
    expectedSequence: number;
    expectedBytes: number;
    checkpointHash: string;
};

type JobFailure = {
    code: string;
    message: string;
    outcome: "not_sent" | "possibly_sent";
    retrySafety: "safe" | "unsafe";
};

type TcpJobSession = {
    reconciled?: boolean;
    reconciliationNote?: string;
    jobId: string;
    host: string;
    port: number;
    socket: net.Socket;
    state: TcpJobState;
    nextSequence: number;
    cumulativeBytes: number;
    checkpointHash: string;
    receipts: Map<number, AppendReceipt>;
    writeTimeoutMs: number;
    idleTimeoutMs: number;
    createdAt: number;
    lastActivityAt: number;
    idleTimer?: NodeJS.Timeout;
    terminalTimer?: NodeJS.Timeout;
    failure?: JobFailure;
    finishExpectation?: FinishExpectation;
    writeInProgress: boolean;
    operationTail: Promise<void>;
    connectPromise: Promise<void>;
};

type JobStore = {
    sessions: Map<string, TcpJobSession>;
};

type GlobalWithTcpJobs = typeof globalThis & {
    __zbreTcpJobStore?: JobStore;
};

const globalJobs = globalThis as GlobalWithTcpJobs;
const store: JobStore =
    globalJobs.__zbreTcpJobStore
    ?? (globalJobs.__zbreTcpJobStore = { sessions: new Map() });

class TcpJobHttpError extends Error {
    status: number;
    code: string;
    session?: TcpJobSession;
    outcome?: "not_sent" | "possibly_sent";
    retrySafety?: "safe" | "unsafe";

    constructor(options: {
        status: number;
        code: string;
        message: string;
        session?: TcpJobSession;
        outcome?: "not_sent" | "possibly_sent";
        retrySafety?: "safe" | "unsafe";
    }) {
        super(options.message);
        this.name = "TcpJobHttpError";
        this.status = options.status;
        this.code = options.code;
        this.session = options.session;
        this.outcome = options.outcome;
        this.retrySafety = options.retrySafety;
    }
}

function jsonResponse(data: unknown, status = 200): Response {
    return Response.json(data, {
        status,
        headers: {
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    });
}

function isLoopbackHostname(value: string): boolean {
    const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function serverTcpEnabled(request: Request): boolean {
    if (
        process.env.VERCEL === "1"
        || (process.env.NEXTWAVES_DEPLOYMENT_MODE ?? "").trim().toLowerCase() === "cloud"
    ) {
        return false;
    }
    const configured = (process.env.NEXTWAVES_SERVER_TCP ?? "").trim().toLowerCase();
    if (configured === "enabled" || configured === "true" || configured === "1") {
        return true;
    }
    if (configured === "disabled" || configured === "false" || configured === "0") {
        return false;
    }
    if (process.env.NODE_ENV === "production") return false;
    try {
        return isLoopbackHostname(new URL(request.url).hostname);
    } catch {
        return false;
    }
}

function cleanJobId(value: unknown): string {
    if (typeof value !== "string") {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_ID_REQUIRED",
            message: "jobId is required.",
        });
    }
    const jobId = value.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(jobId)) {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_ID_INVALID",
            message:
                "jobId must be 1-128 characters using letters, digits, dot, underscore, colon, or hyphen.",
        });
    }
    return jobId;
}

function cleanHost(value: unknown): string {
    if (typeof value !== "string") {
        throw new TcpJobHttpError({
            status: 400,
            code: "TCP_HOST_REQUIRED",
            message: "host is required.",
        });
    }
    const raw = value.trim();
    const host = raw.startsWith("[") && raw.endsWith("]")
        ? raw.slice(1, -1)
        : raw;
    const isIp = net.isIP(host) !== 0;
    const isHostname =
        host.length > 0
        && host.length <= 253
        && host.split(".").every(
            (label) =>
                label.length > 0
                && label.length <= 63
                && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label),
        );
    if (!isIp && !isHostname) {
        throw new TcpJobHttpError({
            status: 400,
            code: "TCP_HOST_INVALID",
            message: "host must be a valid IPv4, IPv6, or DNS hostname.",
        });
    }
    return host;
}

function cleanPort(value: unknown): number {
    if (
        typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value < 1
        || value > 65535
    ) {
        throw new TcpJobHttpError({
            status: 400,
            code: "TCP_PORT_INVALID",
            message: "port must be an integer from 1 to 65535.",
        });
    }
    return value;
}

function allowedServerTcpPorts(): Set<number> {
    const configured = (process.env.NEXTWAVES_SERVER_TCP_PORTS ?? "9100")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65535);
    return new Set(configured.length > 0 ? configured : [9100]);
}

function normalizeAllowedHost(value: string): string {
    const trimmed = value.trim().toLowerCase();
    return trimmed.startsWith("[") && trimmed.endsWith("]")
        ? trimmed.slice(1, -1)
        : trimmed;
}

function serverTcpHostAllowed(host: string): boolean {
    const configured = (process.env.NEXTWAVES_SERVER_TCP_HOSTS ?? "")
        .split(",")
        .map(normalizeAllowedHost)
        .filter(Boolean);
    return configured.length === 0 || configured.includes(host.toLowerCase());
}

function cleanMs(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
    field: string,
): number {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_TIMEOUT_INVALID",
            message: `${field} must be a finite number.`,
        });
    }
    return Math.max(min, Math.min(max, Math.round(value)));
}

function cleanSequence(value: unknown, field = "sequence", minimum = 1): number {
    if (
        typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value < minimum
        || value > MAX_JOB_SEQUENCE
    ) {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_SEQUENCE_INVALID",
            message:
                `${field} must be a safe integer from ${minimum} `
                + `to ${MAX_JOB_SEQUENCE}.`,
        });
    }
    return value;
}

function cleanExpectedBytes(value: unknown): number {
    if (
        typeof value !== "number"
        || !Number.isSafeInteger(value)
        || value < 0
    ) {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_EXPECTED_BYTES_INVALID",
            message: "expectedBytes must be a non-negative safe integer.",
        });
    }
    return value;
}

function cleanSha256(value: unknown, field: string): string {
    if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value.trim())) {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_SHA256_INVALID",
            message: `${field} must be a 64-character hexadecimal SHA-256 digest.`,
        });
    }
    return value.trim().toLowerCase();
}

function decodePayload(value: unknown): Buffer {
    if (typeof value !== "string" || value.length === 0) {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_PAYLOAD_REQUIRED",
            message: "payloadBase64 is required.",
        });
    }
    if (
        value.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
    ) {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_PAYLOAD_BASE64_INVALID",
            message: "payloadBase64 must be canonical Base64.",
        });
    }
    const payload = Buffer.from(value, "base64");
    if (payload.byteLength === 0) {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_PAYLOAD_EMPTY",
            message: "Print payload is empty.",
        });
    }
    if (payload.byteLength > MAX_APPEND_PAYLOAD_BYTES) {
        throw new TcpJobHttpError({
            status: 413,
            code: "JOB_PAYLOAD_TOO_LARGE",
            message: `Print payload exceeds ${MAX_APPEND_PAYLOAD_BYTES} bytes.`,
        });
    }
    return payload;
}

function sha256Hex(value: Buffer | string): string {
    return createHash("sha256").update(value).digest("hex");
}

/**
 * Checkpoint chain v1:
 *   H0 = SHA256(UTF8("zbre-tcp-job-v1\\0" + jobId))
 *   Hn = SHA256(H(n-1)[32 raw bytes] || sequence[uint64-be]
 *               || payloadSha256[32 raw bytes] || payloadLength[uint64-be])
 *
 * Sequence numbers start at one. Hex digests in requests and responses are
 * lowercase; comparisons accept either case.
 */
function initialCheckpointHash(jobId: string): string {
    return sha256Hex(`zbre-tcp-job-v1\0${jobId}`);
}

function nextCheckpointHash(
    previousHash: string,
    sequence: number,
    payloadSha256: string,
    payloadLength: number,
): string {
    const sequenceBytes = Buffer.allocUnsafe(8);
    sequenceBytes.writeBigUInt64BE(BigInt(sequence));
    const lengthBytes = Buffer.allocUnsafe(8);
    lengthBytes.writeBigUInt64BE(BigInt(payloadLength));
    return sha256Hex(Buffer.concat([
        Buffer.from(previousHash, "hex"),
        sequenceBytes,
        Buffer.from(payloadSha256, "hex"),
        lengthBytes,
    ]));
}

function clearTimer(timer: NodeJS.Timeout | undefined): void {
    if (timer) clearTimeout(timer);
}

function scheduleTerminalRemoval(session: TcpJobSession): void {
    clearTimer(session.idleTimer);
    clearTimer(session.terminalTimer);
    session.terminalTimer = setTimeout(() => {
        if (!session.reconciled && (session.state === "uncertain"
            || (session.state === "expired" && session.cumulativeBytes > 0))) return;
        if (store.sessions.get(session.jobId) === session) {
            store.sessions.delete(session.jobId);
        }
        if (!session.socket.destroyed) session.socket.destroy();
    }, TERMINAL_RETENTION_MS);
    session.terminalTimer.unref?.();
}

function setFailure(
    session: TcpJobSession,
    failure: JobFailure,
): void {
    if (
        session.state === "finished"
        || session.state === "aborted"
        || session.state === "expired"
        || session.state === "failed"
        || session.state === "uncertain"
    ) {
        return;
    }
    session.failure = failure;
    session.state = failure.outcome === "possibly_sent" ? "uncertain" : "failed";
    clearTimer(session.idleTimer);
    if (!session.socket.destroyed) session.socket.destroy();
    scheduleTerminalRemoval(session);
}

function expireIdleSession(session: TcpJobSession): void {
    if (session.state !== "open") return;
    const possiblySent = session.writeInProgress || session.nextSequence > 1;
    session.failure = {
        code: "JOB_IDLE_TIMEOUT",
        message: `TCP job was aborted after ${session.idleTimeoutMs} ms without activity.`,
        outcome: possiblySent ? "possibly_sent" : "not_sent",
        retrySafety: possiblySent ? "unsafe" : "safe",
    };
    session.state = "expired";
    if (!session.socket.destroyed) session.socket.destroy();
    scheduleTerminalRemoval(session);
}

function touchSession(session: TcpJobSession): void {
    session.lastActivityAt = Date.now();
    clearTimer(session.idleTimer);
    if (session.state !== "open") return;
    session.idleTimer = setTimeout(
        () => expireIdleSession(session),
        session.idleTimeoutMs,
    );
    session.idleTimer.unref?.();
}

function sessionSnapshot(
    session: TcpJobSession,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        ok: true,
        jobId: session.jobId,
        host: session.host,
        port: session.port,
        reconciled: session.reconciled === true,
        reconciliationNote: session.reconciliationNote,
        state: session.state,
        nextSequence: session.nextSequence,
        cumulativeBytes: session.cumulativeBytes,
        checkpointHash: session.checkpointHash,
        ...(session.failure
            ? {
                failure: {
                    code: session.failure.code,
                    message: session.failure.message,
                    outcome: session.failure.outcome,
                    retrySafety: session.failure.retrySafety,
                },
            }
            : {}),
        ...extra,
    };
}

function errorResponse(error: unknown): Response {
    if (error instanceof TcpJobHttpError) {
        const session = error.session;
        return jsonResponse({
            ok: false,
            error: error.message,
            code: error.code,
            ...(session
                ? {
                    jobId: session.jobId,
                    state: session.state,
                    nextSequence: session.nextSequence,
                    cumulativeBytes: session.cumulativeBytes,
                    checkpointHash: session.checkpointHash,
                }
                : {}),
            ...(error.outcome ? { outcome: error.outcome } : {}),
            ...(error.retrySafety ? { retrySafety: error.retrySafety } : {}),
        }, error.status);
    }
    return jsonResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: "JOB_INTERNAL_ERROR",
    }, 500);
}

function requireSession(jobId: string): TcpJobSession {
    const session = store.sessions.get(jobId);
    if (!session) {
        throw new TcpJobHttpError({
            status: 404,
            code: "JOB_NOT_FOUND",
            message: `TCP job ${jobId} was not found or its receipt expired.`,
        });
    }
    return session;
}

async function withSessionLock<T>(
    session: TcpJobSession,
    operation: () => Promise<T> | T,
): Promise<T> {
    const previous = session.operationTail;
    let release: (() => void) | undefined;
    session.operationTail = new Promise<void>((resolve) => {
        release = resolve;
    });
    session.lastActivityAt = Date.now();
    clearTimer(session.idleTimer);
    await previous.catch(() => undefined);
    // A previous operation may have armed a fresh idle timer in its finally
    // block while this request was waiting for the per-job lock.
    clearTimer(session.idleTimer);
    try {
        return await operation();
    } finally {
        touchSession(session);
        release?.();
    }
}

function activeJobCount(): number {
    let count = 0;
    for (const session of store.sessions.values()) {
        if (
            session.state === "connecting"
            || session.state === "open"
            || session.state === "finishing"
        ) {
            count += 1;
        }
    }
    return count;
}

function connectSocket(
    session: TcpJobSession,
    connectTimeoutMs: number,
): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: TcpJobHttpError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            session.socket.off("connect", onConnect);
            session.socket.off("error", onError);
            session.socket.off("close", onClose);
            if (error) reject(error);
            else resolve();
        };
        const onConnect = () => {
            if (session.state === "aborted") {
                finish(new TcpJobHttpError({
                    status: 409,
                    code: "JOB_ABORTED",
                    message: `TCP job ${session.jobId} was aborted while connecting.`,
                    session,
                    outcome: "not_sent",
                    retrySafety: "safe",
                }));
                return;
            }
            session.socket.setNoDelay(true);
            session.socket.setKeepAlive(true, 5_000);
            session.state = "open";
            touchSession(session);
            finish();
        };
        const onError = (error: NodeJS.ErrnoException) => {
            const failure: JobFailure = {
                code:
                    error.code === "ETIMEDOUT"
                        ? "TCP_CONNECT_TIMEOUT"
                        : "TCP_CONNECT_FAILED",
                message: error.message,
                outcome: "not_sent",
                retrySafety: "safe",
            };
            setFailure(session, failure);
            finish(new TcpJobHttpError({
                status: error.code === "ETIMEDOUT" ? 504 : 502,
                code: failure.code,
                message: failure.message,
                session,
                outcome: failure.outcome,
                retrySafety: failure.retrySafety,
            }));
        };
        const onClose = () => {
            const aborted = session.state === "aborted";
            const failure: JobFailure = {
                code: aborted ? "JOB_ABORTED" : "TCP_CONNECT_CLOSED",
                message: aborted
                    ? `TCP job ${session.jobId} was aborted while connecting.`
                    : `TCP connection to ${session.host}:${session.port} closed while connecting.`,
                outcome: "not_sent",
                retrySafety: "safe",
            };
            if (!aborted) setFailure(session, failure);
            finish(new TcpJobHttpError({
                status: aborted ? 409 : 502,
                code: failure.code,
                message: failure.message,
                session,
                outcome: failure.outcome,
                retrySafety: failure.retrySafety,
            }));
        };
        const timer = setTimeout(() => {
            const failure: JobFailure = {
                code: "TCP_CONNECT_TIMEOUT",
                message: `TCP connect timeout to ${session.host}:${session.port}.`,
                outcome: "not_sent",
                retrySafety: "safe",
            };
            setFailure(session, failure);
            finish(new TcpJobHttpError({
                status: 504,
                code: failure.code,
                message: failure.message,
                session,
                outcome: failure.outcome,
                retrySafety: failure.retrySafety,
            }));
        }, connectTimeoutMs);
        timer.unref?.();
        session.socket.once("connect", onConnect);
        session.socket.once("error", onError);
        session.socket.once("close", onClose);
        try {
            session.socket.connect(session.port, session.host);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const failure: JobFailure = {
                code: "TCP_CONNECT_FAILED",
                message: detail,
                outcome: "not_sent",
                retrySafety: "safe",
            };
            setFailure(session, failure);
            finish(new TcpJobHttpError({
                status: 502,
                code: failure.code,
                message: failure.message,
                session,
                outcome: failure.outcome,
                retrySafety: failure.retrySafety,
            }));
        }
    });
}

function createSession(options: {
    jobId: string;
    host: string;
    port: number;
    connectTimeoutMs: number;
    writeTimeoutMs: number;
    idleTimeoutMs: number;
}): TcpJobSession {
    const socket = new net.Socket();
    const session = {
        jobId: options.jobId,
        host: options.host,
        port: options.port,
        socket,
        state: "connecting" as TcpJobState,
        nextSequence: 1,
        cumulativeBytes: 0,
        checkpointHash: initialCheckpointHash(options.jobId),
        receipts: new Map<number, AppendReceipt>(),
        writeTimeoutMs: options.writeTimeoutMs,
        idleTimeoutMs: options.idleTimeoutMs,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        writeInProgress: false,
        operationTail: Promise.resolve(),
        connectPromise: Promise.resolve(),
    } satisfies TcpJobSession;

    socket.on("error", (error: NodeJS.ErrnoException) => {
        if (session.state === "connecting") return;
        const possiblySent = session.writeInProgress || session.nextSequence > 1;
        setFailure(session, {
            code: error.code === "ETIMEDOUT" ? "TCP_WRITE_TIMEOUT" : "TCP_CONNECTION_FAILED",
            message: error.message,
            outcome: possiblySent ? "possibly_sent" : "not_sent",
            retrySafety: possiblySent ? "unsafe" : "safe",
        });
    });
    socket.on("close", () => {
        if (
            session.state === "finishing"
            ||
            session.state === "finished"
            || session.state === "aborted"
            || session.state === "expired"
            || session.state === "failed"
            || session.state === "uncertain"
        ) {
            return;
        }
        const possiblySent = session.writeInProgress || session.nextSequence > 1;
        setFailure(session, {
            code: "TCP_CONNECTION_CLOSED",
            message: `TCP connection to ${session.host}:${session.port} closed before the job finished.`,
            outcome: possiblySent ? "possibly_sent" : "not_sent",
            retrySafety: possiblySent ? "unsafe" : "safe",
        });
    });
    // Zebra status/readback data is not part of the append receipt contract.
    // Consume it so an unexpected response cannot stall the persistent socket.
    socket.on("data", () => undefined);

    session.connectPromise = connectSocket(session, options.connectTimeoutMs);
    touchSession(session);
    return session;
}

async function handleOpen(body: TcpJobRequest): Promise<Response> {
    const jobId = cleanJobId(body.jobId);
    const host = cleanHost(body.host);
    const port = cleanPort(body.port);
    if (!serverTcpHostAllowed(host)) {
        throw new TcpJobHttpError({
            status: 403,
            code: "TCP_HOST_NOT_ALLOWED",
            message: `TCP host ${host} is not allowed by this local server.`,
        });
    }
    if (!allowedServerTcpPorts().has(port)) {
        throw new TcpJobHttpError({
            status: 403,
            code: "TCP_PORT_NOT_ALLOWED",
            message: `TCP port ${port} is not allowed by this local server.`,
        });
    }
    const connectTimeoutMs = cleanMs(
        body.connectTimeoutMs,
        DEFAULT_CONNECT_TIMEOUT_MS,
        500,
        30_000,
        "connectTimeoutMs",
    );
    const writeTimeoutMs = cleanMs(
        body.writeTimeoutMs,
        DEFAULT_WRITE_TIMEOUT_MS,
        500,
        120_000,
        "writeTimeoutMs",
    );
    const idleTimeoutMs = cleanMs(
        body.idleTimeoutMs,
        DEFAULT_IDLE_TIMEOUT_MS,
        5_000,
        30 * 60_000,
        "idleTimeoutMs",
    );

    const existing = store.sessions.get(jobId);
    if (existing) {
        if (existing.host !== host || existing.port !== port) {
            throw new TcpJobHttpError({
                status: 409,
                code: "JOB_OPEN_CONFLICT",
                message:
                    `jobId ${jobId} is already bound to `
                    + `${existing.host}:${existing.port}.`,
                session: existing,
            });
        }
        await existing.connectPromise;
        return withSessionLock(existing, () => {
            if (existing.state === "connecting" || existing.state === "open") {
                return jsonResponse(sessionSnapshot(existing, { deduplicated: true }));
            }
            const possiblySent = existing.cumulativeBytes > 0
                || existing.state === "uncertain";
            throw new TcpJobHttpError({
                status: existing.state === "expired" ? 410 : 409,
                code: existing.state === "uncertain"
                    ? "TCP_JOB_UNCERTAIN"
                    : existing.state === "expired"
                        ? "TCP_JOB_EXPIRED"
                        : "TCP_JOB_TERMINAL",
                message:
                    `TCP job ${jobId} is ${existing.state} and cannot be reopened. `
                    + (possiblySent
                        ? "Printer bytes may already have been accepted; do not recreate or resend this job."
                        : "Create a new job only after confirming no bytes were sent."),
                session: existing,
                outcome: possiblySent ? "possibly_sent" : "not_sent",
                retrySafety: possiblySent ? "unsafe" : "safe",
            });
        });
    }
    if (activeJobCount() >= MAX_ACTIVE_JOBS) {
        throw new TcpJobHttpError({
            status: 503,
            code: "JOB_CAPACITY_EXCEEDED",
            message: `This process already has ${MAX_ACTIVE_JOBS} active TCP jobs.`,
        });
    }
    for (const active of store.sessions.values()) {
        const sameTarget = active.jobId !== jobId
            && active.host.toLowerCase() === host.toLowerCase()
            && active.port === port;
        if (!sameTarget) continue;
        if (
            !active.reconciled && (active.state === "uncertain"
            || (active.state === "expired" && active.cumulativeBytes > 0))
        ) {
            throw new TcpJobHttpError({
                status: 409,
                code: "TCP_JOB_TARGET_QUARANTINED",
                message:
                    "This printer target is quarantined after an earlier job had an unknown outcome; "
                    + "reconcile the printed/VOID labels before retrying after the retained record expires.",
                session: active,
                outcome: "possibly_sent",
                retrySafety: "unsafe",
            });
        }
        if (active.state === "connecting" || active.state === "open") {
            throw new TcpJobHttpError({
                status: 429,
                code: "TCP_JOB_TARGET_BUSY",
                message:
                    "Another persistent TCP job already owns this printer target; "
                    + "queue the logical job and retry after it finishes.",
                outcome: "not_sent",
                retrySafety: "safe",
            });
        }
    }
    if (store.sessions.size >= MAX_RETAINED_JOBS) {
        throw new TcpJobHttpError({
            status: 429,
            code: "JOB_RECORD_CAPACITY_EXCEEDED",
            message:
                `This process is retaining ${MAX_RETAINED_JOBS} TCP job receipts; `
                + "retry after older receipts expire.",
        });
    }

    const session = createSession({
        jobId,
        host,
        port,
        connectTimeoutMs,
        writeTimeoutMs,
        idleTimeoutMs,
    });
    store.sessions.set(jobId, session);
    try {
        await session.connectPromise;
    } catch (error) {
        // A failed connect is proven not-sent. Remove that tombstone so the
        // client's idempotent open retry may establish a fresh socket with the
        // same jobId.
        if (
            store.sessions.get(jobId) === session
            && session.failure?.outcome === "not_sent"
            && session.nextSequence === 1
        ) {
            clearTimer(session.terminalTimer);
            store.sessions.delete(jobId);
        }
        throw error;
    }
    return jsonResponse(sessionSnapshot(session));
}

function assertOpenForAppend(session: TcpJobSession): void {
    if (session.state !== "open") {
        throw new TcpJobHttpError({
            status: 409,
            code: "JOB_NOT_OPEN",
            message: `TCP job ${session.jobId} is ${session.state}, not open.`,
            session,
            outcome: session.failure?.outcome,
            retrySafety: session.failure?.retrySafety,
        });
    }
    if (session.socket.destroyed || !session.socket.writable) {
        setFailure(session, {
            code: "TCP_CONNECTION_CLOSED",
            message: `TCP connection to ${session.host}:${session.port} is not writable.`,
            outcome: session.nextSequence > 1 ? "possibly_sent" : "not_sent",
            retrySafety: session.nextSequence > 1 ? "unsafe" : "safe",
        });
        throw new TcpJobHttpError({
            status: 502,
            code: "TCP_CONNECTION_CLOSED",
            message: `TCP connection to ${session.host}:${session.port} is not writable.`,
            session,
            outcome: session.failure?.outcome,
            retrySafety: session.failure?.retrySafety,
        });
    }
}

function writePayload(session: TcpJobSession, payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let writeStarted = false;
        const finish = (error?: TcpJobHttpError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => {
            const failure: JobFailure = {
                code: "TCP_WRITE_TIMEOUT",
                message: `TCP write timeout to ${session.host}:${session.port}.`,
                outcome: writeStarted ? "possibly_sent" : "not_sent",
                retrySafety: writeStarted ? "unsafe" : "safe",
            };
            setFailure(session, failure);
            finish(new TcpJobHttpError({
                status: 504,
                code: failure.code,
                message: failure.message,
                session,
                outcome: failure.outcome,
                retrySafety: failure.retrySafety,
            }));
        }, session.writeTimeoutMs);
        timer.unref?.();

        try {
            writeStarted = true;
            session.writeInProgress = true;
            session.socket.write(payload, (error) => {
                if (error) {
                    const systemError = error as NodeJS.ErrnoException;
                    const failure: JobFailure = {
                        code:
                            systemError.code === "ETIMEDOUT"
                                ? "TCP_WRITE_TIMEOUT"
                                : "TCP_WRITE_FAILED",
                        message: error.message,
                        outcome: "possibly_sent",
                        retrySafety: "unsafe",
                    };
                    setFailure(session, failure);
                    finish(new TcpJobHttpError({
                        status: systemError.code === "ETIMEDOUT" ? 504 : 502,
                        code: failure.code,
                        message: failure.message,
                        session,
                        outcome: failure.outcome,
                        retrySafety: failure.retrySafety,
                    }));
                    return;
                }
                session.writeInProgress = false;
                finish();
            });
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const failure: JobFailure = {
                code: "TCP_WRITE_FAILED",
                message: detail,
                outcome: writeStarted ? "possibly_sent" : "not_sent",
                retrySafety: writeStarted ? "unsafe" : "safe",
            };
            setFailure(session, failure);
            finish(new TcpJobHttpError({
                status: 502,
                code: failure.code,
                message: failure.message,
                session,
                outcome: failure.outcome,
                retrySafety: failure.retrySafety,
            }));
        }
    });
}

async function handleAppend(body: TcpJobRequest): Promise<Response> {
    const jobId = cleanJobId(body.jobId);
    const sequence = cleanSequence(body.sequence);
    const payloadSha256 = cleanSha256(body.payloadSha256, "payloadSha256");
    const payload = decodePayload(body.payloadBase64);
    const computedSha256 = sha256Hex(payload);
    if (computedSha256 !== payloadSha256) {
        throw new TcpJobHttpError({
            status: 400,
            code: "JOB_PAYLOAD_HASH_MISMATCH",
            message:
                `payloadSha256 ${payloadSha256} does not match decoded payload `
                + `${computedSha256}.`,
        });
    }
    const session = requireSession(jobId);

    return withSessionLock(session, async () => {
        if (sequence < session.nextSequence) {
            const receipt = session.receipts.get(sequence);
            if (receipt?.payloadSha256 === payloadSha256) {
                return jsonResponse(sessionSnapshot(session, {
                    sequence,
                    bytesWritten: receipt.bytesWritten,
                    payloadSha256: receipt.payloadSha256,
                    checkpointHash: receipt.checkpointHash,
                    deduplicated: true,
                }));
            }
            throw new TcpJobHttpError({
                status: 409,
                code: "JOB_SEQUENCE_CONFLICT",
                message:
                    `Sequence ${sequence} was already accepted with a different `
                    + "payload SHA-256.",
                session,
            });
        }
        if (sequence > session.nextSequence) {
            throw new TcpJobHttpError({
                status: 409,
                code: "JOB_SEQUENCE_GAP",
                message:
                    `Expected sequence ${session.nextSequence}, received ${sequence}.`,
                session,
            });
        }
        assertOpenForAppend(session);
        const isCancel = payload.byteLength <= 64 && payload.toString("ascii").trim() === "~JA";
        if (session.cumulativeBytes + payload.byteLength > MAX_JOB_BYTES + (isCancel ? 64 * 1024 : 0)) {
            throw new TcpJobHttpError({
                status: 413,
                code: "JOB_BYTES_EXCEEDED",
                message: `TCP job exceeds ${MAX_JOB_BYTES} cumulative bytes.`,
                session,
            });
        }

        await withServerPrinterQueue(
            serverTcpPrinterKey(session.host, session.port),
            () => writePayload(session, payload),
        );
        if (session.state !== "open" || session.failure) {
            throw new TcpJobHttpError({
                status: 502,
                code: session.failure?.code ?? "TCP_WRITE_FAILED",
                message:
                    session.failure?.message
                    ?? `TCP connection to ${session.host}:${session.port} failed during append.`,
                session,
                outcome: session.failure?.outcome ?? "possibly_sent",
                retrySafety: session.failure?.retrySafety ?? "unsafe",
            });
        }
        const checkpointHash = nextCheckpointHash(
            session.checkpointHash,
            sequence,
            payloadSha256,
            payload.byteLength,
        );
        const receipt: AppendReceipt = {
            sequence,
            bytesWritten: payload.byteLength,
            cumulativeBytes: session.cumulativeBytes + payload.byteLength,
            payloadSha256,
            checkpointHash,
        };
        session.receipts.set(sequence, receipt);
        session.nextSequence += 1;
        session.cumulativeBytes = receipt.cumulativeBytes;
        session.checkpointHash = checkpointHash;
        touchSession(session);
        return jsonResponse(sessionSnapshot(session, {
            sequence,
            bytesWritten: receipt.bytesWritten,
            payloadSha256,
            checkpointHash,
        }));
    });
}

function queryPayload(
    session: TcpJobSession,
    payload: Buffer,
    readWindowMs: number,
    readIdleMs: number,
): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let settled = false;
        let idleTimer: NodeJS.Timeout | undefined;

        const cleanup = () => {
            clearTimeout(totalTimer);
            clearTimer(idleTimer);
            session.socket.off("data", onData);
            session.socket.off("close", onClose);
        };
        const finish = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(Buffer.concat(chunks, bytes).toString("latin1"));
        };
        const fail = (code: string, message: string, status = 502) => {
            if (settled) return;
            settled = true;
            cleanup();
            const possiblySent = session.nextSequence > 1;
            const failure: JobFailure = {
                code,
                message,
                outcome: possiblySent ? "possibly_sent" : "not_sent",
                retrySafety: possiblySent ? "unsafe" : "safe",
            };
            setFailure(session, failure);
            reject(new TcpJobHttpError({
                status,
                code,
                message,
                session,
                outcome: failure.outcome,
                retrySafety: failure.retrySafety,
            }));
        };
        const onData = (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > MAX_QUERY_RESPONSE_BYTES) {
                fail(
                    "TCP_QUERY_RESPONSE_TOO_LARGE",
                    `Printer status response exceeded ${MAX_QUERY_RESPONSE_BYTES} bytes.`,
                );
                return;
            }
            chunks.push(Buffer.from(chunk));
            if (hasCompleteZebraStatusResponse(payload.toString("latin1"), Buffer.concat(chunks, bytes).toString("latin1"))) {
                finish();
                return;
            }
            clearTimer(idleTimer);
            idleTimer = setTimeout(finish, readIdleMs);
            idleTimer.unref?.();
        };
        const onClose = () => fail(
            "TCP_QUERY_CONNECTION_CLOSED",
            "Printer closed the persistent TCP socket before returning status.",
        );
        const totalTimer = setTimeout(() => {
            if (bytes > 0) {
                finish();
                return;
            }
            fail(
                "TCP_QUERY_TIMEOUT",
                "Zebra printer did not return status before the query timeout.",
                504,
            );
        }, readWindowMs);
        totalTimer.unref?.();

        session.socket.on("data", onData);
        session.socket.once("close", onClose);
        void writePayload(session, payload).catch((error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        });
    });
}

async function handleQuery(body: TcpJobRequest): Promise<Response> {
    const jobId = cleanJobId(body.jobId);
    const payload = decodePayload(body.payloadBase64);
    const queryText = payload.toString("latin1").replace(/\r?\n/g, "\n").trim();
    if (
        queryText !== "! U1 getvar \"zpl.system_status\""
        && queryText !== "~HQES"
        && queryText !== "~HS"
    ) {
        throw new TcpJobHttpError({
            status: 400,
            code: "TCP_QUERY_NOT_ALLOWED",
            message: "Persistent TCP query only accepts Zebra status commands.",
        });
    }
    const readWindowMs = cleanMs(body.readWindowMs, 8_000, 250, 30_000, "readWindowMs");
    const readIdleMs = cleanMs(body.readIdleMs, 300, 25, readWindowMs, "readIdleMs");
    const session = requireSession(jobId);

    return withSessionLock(session, async () => {
        assertOpenForAppend(session);
        const response = await withServerPrinterQueue(
            serverTcpPrinterKey(session.host, session.port),
            () => queryPayload(session, payload, readWindowMs, readIdleMs),
        );
        return jsonResponse(sessionSnapshot(session, {
            bytesWritten: payload.byteLength,
            response,
        }));
    });
}

async function handlePoll(body: TcpJobRequest): Promise<Response> {
    const jobId = cleanJobId(body.jobId);
    const session = requireSession(jobId);
    return withSessionLock(session, () => jsonResponse(sessionSnapshot(session)));
}

function finishSocket(session: TcpJobSession): Promise<void> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (error?: TcpJobHttpError) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            session.socket.off("error", onError);
            if (error) reject(error);
            else resolve();
        };
        const onError = (error: NodeJS.ErrnoException) => {
            const failure: JobFailure = {
                code: "TCP_FINISH_FAILED",
                message: error.message,
                outcome: session.nextSequence > 1 ? "possibly_sent" : "not_sent",
                retrySafety: session.nextSequence > 1 ? "unsafe" : "safe",
            };
            setFailure(session, failure);
            finish(new TcpJobHttpError({
                status: 502,
                code: failure.code,
                message: failure.message,
                session,
                outcome: failure.outcome,
                retrySafety: failure.retrySafety,
            }));
        };
        const timer = setTimeout(() => {
            // All append callbacks have completed before finish starts. A
            // printer that keeps the half-closed connection open must not hold
            // the HTTP request forever.
            finish();
        }, FINISH_CLOSE_WAIT_MS);
        timer.unref?.();
        session.socket.once("error", onError);
        try {
            session.socket.end(() => finish());
        } catch (error) {
            onError(error as NodeJS.ErrnoException);
        }
    });
}

function sameFinishExpectation(
    left: FinishExpectation | undefined,
    right: FinishExpectation,
): boolean {
    return !!left
        && left.expectedSequence === right.expectedSequence
        && left.expectedBytes === right.expectedBytes
        && left.checkpointHash === right.checkpointHash;
}

async function handleFinish(body: TcpJobRequest): Promise<Response> {
    const jobId = cleanJobId(body.jobId);
    const expectation: FinishExpectation = {
        expectedSequence: cleanSequence(body.expectedSequence, "expectedSequence", 0),
        expectedBytes: cleanExpectedBytes(body.expectedBytes),
        checkpointHash: cleanSha256(body.checkpointHash, "checkpointHash"),
    };
    const session = requireSession(jobId);

    return withSessionLock(session, async () => {
        if (session.state === "finished") {
            if (!sameFinishExpectation(session.finishExpectation, expectation)) {
                throw new TcpJobHttpError({
                    status: 409,
                    code: "JOB_FINISH_CONFLICT",
                    message: "This job was already finished with different checkpoints.",
                    session,
                });
            }
            return jsonResponse(sessionSnapshot(session, { deduplicated: true }));
        }
        if (session.state !== "open") {
            throw new TcpJobHttpError({
                status: 409,
                code: "JOB_NOT_OPEN",
                message: `TCP job ${jobId} is ${session.state}, not open.`,
                session,
                outcome: session.failure?.outcome,
                retrySafety: session.failure?.retrySafety,
            });
        }
        const actualLastSequence = session.nextSequence - 1;
        if (expectation.expectedSequence !== actualLastSequence) {
            throw new TcpJobHttpError({
                status: 409,
                code: "JOB_FINISH_SEQUENCE_MISMATCH",
                message:
                    `Finish expectedSequence ${expectation.expectedSequence} does not `
                    + `match last accepted sequence ${actualLastSequence}.`,
                session,
            });
        }
        if (expectation.expectedBytes !== session.cumulativeBytes) {
            throw new TcpJobHttpError({
                status: 409,
                code: "JOB_FINISH_BYTES_MISMATCH",
                message:
                    `Finish expectedBytes ${expectation.expectedBytes} does not `
                    + `match ${session.cumulativeBytes}.`,
                session,
            });
        }
        if (expectation.checkpointHash !== session.checkpointHash) {
            throw new TcpJobHttpError({
                status: 409,
                code: "JOB_FINISH_CHECKPOINT_MISMATCH",
                message: "Finish checkpointHash does not match the latest append receipt.",
                session,
            });
        }
        if (session.nextSequence === 1) {
            throw new TcpJobHttpError({
                status: 409,
                code: "JOB_EMPTY",
                message: "Cannot finish a TCP job with no accepted append.",
                session,
            });
        }

        session.finishExpectation = expectation;
        session.state = "finishing";
        clearTimer(session.idleTimer);
        await finishSocket(session);
        if (session.failure) {
            throw new TcpJobHttpError({
                status: 502,
                code: session.failure?.code ?? "TCP_FINISH_FAILED",
                message: session.failure?.message ?? "TCP job finish failed.",
                session,
                outcome: session.failure?.outcome,
                retrySafety: session.failure?.retrySafety,
            });
        }
        session.state = "finished";
        if (!session.socket.destroyed) session.socket.destroy();
        scheduleTerminalRemoval(session);
        return jsonResponse(sessionSnapshot(session));
    });
}

async function handleAbort(body: TcpJobRequest): Promise<Response> {
    const jobId = cleanJobId(body.jobId);
    const session = requireSession(jobId);
    return withSessionLock(session, () => {
        if (
            session.state === "aborted"
            || session.state === "uncertain"
            || session.state === "expired"
            || session.state === "failed"
        ) {
            return jsonResponse(sessionSnapshot(session, { deduplicated: true }));
        }
        if (session.state === "finished") {
            throw new TcpJobHttpError({
                status: 409,
                code: "JOB_ALREADY_FINISHED",
                message: `TCP job ${jobId} is already finished.`,
                session,
            });
        }
        const possiblySent = session.nextSequence > 1;
        session.state = possiblySent ? "uncertain" : "aborted";
        session.failure = {
            code: possiblySent ? "JOB_ABORTED_AFTER_WRITE" : "JOB_ABORTED",
            message: possiblySent
                ? "TCP job was stopped after printer bytes were accepted; physical outcome is uncertain."
                : "TCP job was aborted before any print checkpoint was accepted.",
            outcome: possiblySent ? "possibly_sent" : "not_sent",
            retrySafety: possiblySent ? "unsafe" : "safe",
        };
        clearTimer(session.idleTimer);
        if (!session.socket.destroyed) session.socket.destroy();
        scheduleTerminalRemoval(session);
        return jsonResponse(sessionSnapshot(session));
    });
}

async function handleReconcile(body: TcpJobRequest): Promise<Response> {
    const session = requireSession(cleanJobId(body.jobId));
    const note = typeof body.reconciliationNote === "string" ? body.reconciliationNote.trim() : "";
    if (body.confirmed !== true || note.length < 8 || note.length > 2000) {
        throw new TcpJobHttpError({ status: 400, code: "JOB_RECONCILE_CONFIRMATION", message: "Confirm physical label/EPC reconciliation and provide a note (8-2000 characters)." });
    }
    return withSessionLock(session, () => {
        if (!["uncertain", "expired", "failed", "aborted"].includes(session.state)) {
            throw new TcpJobHttpError({ status: 409, code: "JOB_RECONCILE_STATE", message: "Only a stopped TCP job can be reconciled.", session });
        }
        if (body.expectedSequence !== session.nextSequence - 1
            || body.expectedBytes !== session.cumulativeBytes
            || body.checkpointHash !== session.checkpointHash) {
            throw new TcpJobHttpError({ status: 409, code: "JOB_RECONCILE_CHECKPOINT", message: "Reconciliation checkpoint changed; read the job again before confirming.", session });
        }
        if (!session.reconciled) {
            session.reconciled = true;
            session.reconciliationNote = note;
        }
        return jsonResponse({ ...sessionSnapshot(session), reconciled: true, reconciliationNote: session.reconciliationNote });
    });
}

function cleanAction(value: unknown): TcpJobAction {
    if (
        value === "open"
        || value === "append"
        || value === "query"
        || value === "poll"
        || value === "finish"
        || value === "abort"
        || value === "reconcile"
    ) {
        return value;
    }
    throw new TcpJobHttpError({
        status: 400,
        code: "JOB_ACTION_INVALID",
        message: "action must be open, append, query, poll, finish, abort, or reconcile.",
    });
}

export async function handleTcpJobPost(request: Request): Promise<Response> {
    if (!serverTcpEnabled(request)) {
        return jsonResponse({
            ok: false,
            error:
                "Server-side TCP is disabled on hosted deployments. "
                + "Run and pair the local print connector instead.",
            code: "SERVER_TCP_DISABLED",
        }, 403);
    }
    let body: TcpJobRequest;
    try {
        body = (await request.json()) as TcpJobRequest;
    } catch {
        return jsonResponse({
            ok: false,
            error: "Request body must be valid JSON.",
            code: "JOB_JSON_INVALID",
        }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return jsonResponse({
            ok: false,
            error: "Request JSON must be an object.",
            code: "JOB_JSON_INVALID",
        }, 400);
    }
    try {
        switch (cleanAction(body.action)) {
            case "open":
                return await handleOpen(body);
            case "append":
                return await handleAppend(body);
            case "query":
                return await handleQuery(body);
            case "poll":
                return await handlePoll(body);
            case "finish":
                return await handleFinish(body);
            case "abort":
                return await handleAbort(body);
            case "reconcile":
                return await handleReconcile(body);
        }
    } catch (error) {
        return errorResponse(error);
    }
}

export function createTcpJobId(): string {
    return randomUUID();
}

export function resetTcpJobSessionsForTests(): void {
    for (const session of store.sessions.values()) {
        clearTimer(session.idleTimer);
        clearTimer(session.terminalTimer);
        if (!session.socket.destroyed) session.socket.destroy();
    }
    store.sessions.clear();
}
