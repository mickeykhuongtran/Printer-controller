"use client";

import {
    DEFAULT_LOCAL_PRINT_AGENT_URL,
    fetchLocalAgentJson,
    isLoopbackWebApp,
    LocalPrintAgentHttpError,
    type AgentErrorPayload,
} from "./local-print-agent";
import type { TcpExecutionMode } from "./storage";

export type TcpFailureStage =
    | "resolve"
    | "connect"
    | "write"
    | "read"
    | "close"
    | "request"
    | "unknown";
export type TcpDeliveryOutcome = "not_sent" | "possibly_sent";
export type TcpRetrySafety = "safe" | "unsafe";

export type TcpPrintResult = {
    bytesWritten: number;
    response: string;
    execution: "connector" | "server";
};

type TcpResponse = {
    ok?: boolean;
    bytesWritten?: number;
    response?: string;
    error?: string;
    code?: string;
    stage?: TcpFailureStage;
    outcome?: TcpDeliveryOutcome;
    retrySafety?: TcpRetrySafety;
    writeStarted?: boolean;
    writeCompleted?: boolean;
};

type TcpFailureDetails = {
    code?: string;
    stage?: TcpFailureStage;
    outcome?: TcpDeliveryOutcome;
    retrySafety?: TcpRetrySafety;
    bytesWritten?: number;
    writeStarted?: boolean;
    writeCompleted?: boolean;
    status?: number;
    execution?: "connector" | "server";
    attempts?: number;
};

export class TcpTransportError extends Error {
    code: string;
    stage: TcpFailureStage;
    outcome: TcpDeliveryOutcome;
    retrySafety: TcpRetrySafety;
    bytesWritten: number;
    writeStarted: boolean;
    writeCompleted: boolean;
    status?: number;
    execution?: "connector" | "server";
    attempts: number;

    constructor(message: string, details: TcpFailureDetails = {}) {
        super(message);
        this.name = "TcpTransportError";
        this.code = details.code ?? "TCP_REQUEST_FAILED";
        this.stage = details.stage ?? "unknown";
        this.outcome = details.outcome ?? "possibly_sent";
        this.retrySafety = details.retrySafety ?? "unsafe";
        this.bytesWritten = details.bytesWritten ?? 0;
        this.writeStarted = details.writeStarted ?? false;
        this.writeCompleted = details.writeCompleted ?? false;
        this.status = details.status;
        this.execution = details.execution;
        this.attempts = details.attempts ?? 1;
    }
}

export function isSafeTcpRetry(error: unknown): error is TcpTransportError {
    return (
        error instanceof TcpTransportError
        && error.retrySafety === "safe"
        && error.outcome === "not_sent"
        && !error.writeStarted
        && error.bytesWritten === 0
    );
}

function validStage(value: unknown): value is TcpFailureStage {
    return (
        value === "resolve"
        || value === "connect"
        || value === "write"
        || value === "read"
        || value === "close"
        || value === "request"
        || value === "unknown"
    );
}

function validOutcome(value: unknown): value is TcpDeliveryOutcome {
    return value === "not_sent" || value === "possibly_sent";
}

function validRetrySafety(value: unknown): value is TcpRetrySafety {
    return value === "safe" || value === "unsafe";
}

function finiteNonNegativeInteger(value: unknown): number | undefined {
    return typeof value === "number"
        && Number.isSafeInteger(value)
        && value >= 0
        ? value
        : undefined;
}

function transportErrorFromPayload(
    message: string,
    payload: TcpResponse | AgentErrorPayload | null,
    fallback: TcpFailureDetails,
): TcpTransportError {
    return new TcpTransportError(message, {
        code: typeof payload?.code === "string" ? payload.code : fallback.code,
        stage: validStage(payload?.stage) ? payload.stage : fallback.stage,
        outcome: validOutcome(payload?.outcome) ? payload.outcome : fallback.outcome,
        retrySafety: validRetrySafety(payload?.retrySafety)
            ? payload.retrySafety
            : fallback.retrySafety,
        bytesWritten:
            finiteNonNegativeInteger(payload?.bytesWritten)
            ?? fallback.bytesWritten,
        writeStarted: typeof payload?.writeStarted === "boolean"
            ? payload.writeStarted
            : fallback.writeStarted,
        writeCompleted: typeof payload?.writeCompleted === "boolean"
            ? payload.writeCompleted
            : fallback.writeCompleted,
        status: fallback.status,
        execution: fallback.execution,
    });
}

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.byteLength; i += chunkSize) {
        const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.byteLength));
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

const BUILD_TCP_EXECUTION = process.env.NEXT_PUBLIC_TCP_EXECUTION;

export function resolveTcpExecutionMode(
    requested: TcpExecutionMode = "auto",
): "connector" | "server" {
    // A build-time deployment policy is authoritative. In particular, a
    // stale localStorage value of "server" must not make a Vercel browser call
    // the disabled cloud TCP route.
    if (BUILD_TCP_EXECUTION === "connector" || BUILD_TCP_EXECUTION === "server") {
        return BUILD_TCP_EXECUTION;
    }
    if (requested !== "auto") return requested;
    // Preserve the original local standalone behavior. Hosted deployments
    // use the loopback connector because their server cannot route to the
    // user's private printer subnet.
    return isLoopbackWebApp() ? "server" : "connector";
}

async function postServerTcp(body: Record<string, unknown>): Promise<TcpPrintResult> {
    let response: Response;
    try {
        response = await fetch("/api/printer/tcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            cache: "no-store",
        });
    } catch (error) {
        throw new TcpTransportError(
            error instanceof Error ? error.message : String(error),
            {
                code: "TCP_HTTP_REQUEST_FAILED",
                stage: "request",
                outcome: "possibly_sent",
                retrySafety: "unsafe",
                execution: "server",
            },
        );
    }
    const data = (await response.json().catch(() => null)) as TcpResponse | null;
    if (!response.ok || !data?.ok) {
        throw transportErrorFromPayload(
            data?.error || `TCP printer request failed with HTTP ${response.status}`,
            data,
            {
                code: "TCP_HTTP_ERROR",
                stage: "request",
                outcome: "possibly_sent",
                retrySafety: "unsafe",
                status: response.status,
                execution: "server",
            },
        );
    }
    return {
        bytesWritten: data.bytesWritten ?? 0,
        response: data.response ?? "",
        execution: "server",
    };
}

async function postConnectorTcp(
    agentUrl: string,
    body: Record<string, unknown>,
): Promise<TcpPrintResult> {
    let data: TcpResponse;
    try {
        data = await fetchLocalAgentJson<TcpResponse>(
            agentUrl || DEFAULT_LOCAL_PRINT_AGENT_URL,
            "/v1/tcp/exchange",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            },
            // The connector caps a TCP exchange at 45 s; stay slightly above it
            // so its precise write-timeout response reaches the UI.
            { timeoutMs: 50_000 },
        );
    } catch (error) {
        if (error instanceof LocalPrintAgentHttpError) {
            throw transportErrorFromPayload(error.message, error.payload ?? null, {
                code: error.code ?? "TCP_CONNECTOR_HTTP_ERROR",
                stage: "request",
                outcome: "possibly_sent",
                retrySafety: "unsafe",
                status: error.status,
                execution: "connector",
            });
        }
        throw new TcpTransportError(
            error instanceof Error ? error.message : String(error),
            {
                code: "TCP_CONNECTOR_REQUEST_FAILED",
                stage: "request",
                outcome: "possibly_sent",
                retrySafety: "unsafe",
                execution: "connector",
            },
        );
    }
    if (!data.ok) {
        throw transportErrorFromPayload(
            data.error || "TCP request was rejected by the local print agent.",
            data,
            {
                code: "TCP_CONNECTOR_REJECTED",
                stage: "request",
                outcome: "possibly_sent",
                retrySafety: "unsafe",
                execution: "connector",
            },
        );
    }
    return {
        bytesWritten: data.bytesWritten ?? 0,
        response: data.response ?? "",
        execution: "connector",
    };
}

function postTcp(options: {
    body: Record<string, unknown>;
    agentUrl?: string;
    executionMode?: TcpExecutionMode;
}): Promise<TcpPrintResult> {
    const execution = resolveTcpExecutionMode(options.executionMode);
    if (execution === "server") return postServerTcp(options.body);
    return postConnectorTcp(
        options.agentUrl || DEFAULT_LOCAL_PRINT_AGENT_URL,
        options.body,
    );
}

export type SendTcpBytesOptions = {
    host: string;
    port: number;
    payload: Uint8Array;
    agentUrl?: string;
    executionMode?: TcpExecutionMode;
    readWindowMs?: number;
    readIdleMs?: number;
    closeWaitMs?: number;
    connectTimeoutMs?: number;
    writeTimeoutMs?: number;
};

export function sendTcpBytes(options: SendTcpBytesOptions): Promise<TcpPrintResult> {
    return postTcp({
        agentUrl: options.agentUrl,
        executionMode: options.executionMode,
        body: {
            host: options.host,
            port: options.port,
            payloadBase64: toBase64(options.payload),
            readWindowMs: options.readWindowMs ?? 0,
            readIdleMs: options.readIdleMs ?? 100,
            closeWaitMs: options.closeWaitMs ?? 750,
            // Zebra may apply backpressure while ingesting a large raster.
            // Give a print write longer than the connector's 5 s query default.
            connectTimeoutMs: options.connectTimeoutMs ?? 30_000,
            writeTimeoutMs: options.writeTimeoutMs ?? 30_000,
        },
    });
}

const DEFAULT_SAFE_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000] as const;

export type SafeTcpRetryOptions = {
    retryDelaysMs?: readonly number[];
    onRetry?: (
        nextAttempt: number,
        maxAttempts: number,
        delayMs: number,
        error: TcpTransportError,
    ) => void | Promise<void>;
    sleep?: (delayMs: number) => Promise<void>;
};

function wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

/**
 * Retries only failures that the server/connector proved happened before any
 * byte was offered to the printer socket. Ambiguous failures are returned
 * immediately so callers never create duplicate labels by retrying blindly.
 */
export async function sendTcpBytesWithSafeRetry(
    options: SendTcpBytesOptions,
    retryOptions: SafeTcpRetryOptions = {},
): Promise<TcpPrintResult> {
    const delays = retryOptions.retryDelaysMs ?? DEFAULT_SAFE_RETRY_DELAYS_MS;
    const sleep = retryOptions.sleep ?? wait;
    const maxAttempts = delays.length + 1;

    for (let attempt = 1; ; attempt += 1) {
        try {
            return await sendTcpBytes(options);
        } catch (error) {
            if (error instanceof TcpTransportError) {
                error.attempts = attempt;
            }
            const retryDelay = delays[attempt - 1];
            if (
                !isSafeTcpRetry(error)
                || retryDelay === undefined
                || !Number.isFinite(retryDelay)
                || retryDelay < 0
            ) {
                throw error;
            }
            await retryOptions.onRetry?.(
                attempt + 1,
                maxAttempts,
                retryDelay,
                error,
            );
            await sleep(retryDelay);
        }
    }
}

export function sendTcpTextAndRead(options: {
    host: string;
    port: number;
    text: string;
    agentUrl?: string;
    executionMode?: TcpExecutionMode;
    readWindowMs?: number;
    readIdleMs?: number;
    closeWaitMs?: number;
}): Promise<TcpPrintResult> {
    return postTcp({
        agentUrl: options.agentUrl,
        executionMode: options.executionMode,
        body: {
            host: options.host,
            port: options.port,
            text: options.text,
            readWindowMs: options.readWindowMs ?? 3500,
            readIdleMs: options.readIdleMs ?? 250,
            closeWaitMs: options.closeWaitMs ?? 750,
        },
    });
}
