import net from "node:net";
import {
    serverTcpPrinterKey,
    withServerPrinterQueue,
} from "../../../server-printer-queue";

export const runtime = "nodejs";

const MAX_TCP_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_TCP_RESPONSE_BYTES = 4 * 1024 * 1024;

type TcpRequest = {
    host?: unknown;
    port?: unknown;
    text?: unknown;
    payloadBase64?: unknown;
    readWindowMs?: unknown;
    readIdleMs?: unknown;
    closeWaitMs?: unknown;
    connectTimeoutMs?: unknown;
    writeTimeoutMs?: unknown;
};

type TcpFailureStage = "connect" | "write" | "read" | "close";
type TcpDeliveryOutcome = "not_sent" | "possibly_sent";
type TcpRetrySafety = "safe" | "unsafe";

class TcpExchangeError extends Error {
    status: number;
    code: string;
    stage: TcpFailureStage;
    outcome: TcpDeliveryOutcome;
    retrySafety: TcpRetrySafety;
    bytesWritten: number;
    writeStarted: boolean;
    writeCompleted: boolean;

    constructor(options: {
        message: string;
        status: number;
        code: string;
        stage: TcpFailureStage;
        bytesWritten: number;
        writeStarted: boolean;
        writeCompleted: boolean;
    }) {
        super(options.message);
        this.name = "TcpExchangeError";
        this.status = options.status;
        this.code = options.code;
        this.stage = options.stage;
        this.bytesWritten = options.bytesWritten;
        this.writeStarted = options.writeStarted;
        this.writeCompleted = options.writeCompleted;
        this.outcome = options.writeStarted ? "possibly_sent" : "not_sent";
        this.retrySafety = options.writeStarted ? "unsafe" : "safe";
    }
}

function jsonResponse(data: unknown, status = 200): Response {
    return Response.json(data, { status });
}

function isLoopbackHostname(value: string): boolean {
    const host = value.trim().toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function serverTcpEnabled(request: Request): boolean {
    // A hosted function must never become a raw TCP proxy, even if an
    // environment variable is accidentally copied from a local deployment.
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
    // Development keeps the original localhost behavior. Production
    // standalone mode is enabled explicitly by scripts/start-8888.cjs only
    // when that server binds to loopback.
    if (process.env.NODE_ENV === "production") return false;
    try {
        return isLoopbackHostname(new URL(request.url).hostname);
    } catch {
        return false;
    }
}

function cleanHost(value: unknown): string {
    if (typeof value !== "string") return "";
    return value.trim();
}

function cleanPort(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 9100;
    const port = Math.round(value);
    return port >= 1 && port <= 65535 ? port : 9100;
}

function allowedServerTcpPorts(): Set<number> {
    const configured = (process.env.NEXTWAVES_SERVER_TCP_PORTS ?? "9100")
        .split(",")
        .map((value) => Number(value.trim()))
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 65535);
    return new Set(configured.length ? configured : [9100]);
}

function serverTcpHostAllowed(host: string): boolean {
    const configured = (process.env.NEXTWAVES_SERVER_TCP_HOSTS ?? "")
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean);
    return configured.length === 0 || configured.includes(host.trim().toLowerCase());
}

function cleanMs(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function payloadBytes(body: TcpRequest): Buffer {
    let payload: Buffer;
    if (typeof body.payloadBase64 === "string" && body.payloadBase64.trim()) {
        payload = Buffer.from(body.payloadBase64, "base64");
    } else if (typeof body.text === "string") {
        const normalized = body.text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        const withTrailing = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
        payload = Buffer.from(withTrailing.replace(/\n/g, "\r\n"), "latin1");
    } else {
        throw new Error("text or payloadBase64 is required.");
    }
    if (payload.byteLength === 0) throw new Error("Print payload is empty.");
    if (payload.byteLength > MAX_TCP_PAYLOAD_BYTES) {
        throw new Error(`Print payload exceeds ${MAX_TCP_PAYLOAD_BYTES} bytes.`);
    }
    return payload;
}

function exchangeTcp(options: {
    host: string;
    port: number;
    payload: Buffer;
    readWindowMs: number;
    readIdleMs: number;
    closeWaitMs: number;
    connectTimeoutMs: number;
    writeTimeoutMs: number;
}): Promise<{ bytesWritten: number; response: string }> {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        const chunks: Buffer[] = [];
        let responseByteCount = 0;
        let settled = false;
        let connected = false;
        let writeStarted = false;
        let writeCompleted = false;
        let readTimer: NodeJS.Timeout | undefined;
        let closeTimer: NodeJS.Timeout | undefined;
        let writeTimer: NodeJS.Timeout | undefined;
        const connectTimer: NodeJS.Timeout = setTimeout(() => {
            fail(tcpFailure(
                `TCP connect timeout to ${options.host}:${options.port}`,
                "TCP_CONNECT_TIMEOUT",
                "connect",
                504,
            ));
        }, options.connectTimeoutMs);

        const clearTimers = () => {
            if (readTimer) clearTimeout(readTimer);
            if (connectTimer) clearTimeout(connectTimer);
            if (closeTimer) clearTimeout(closeTimer);
            if (writeTimer) clearTimeout(writeTimer);
        };

        const cleanup = () => {
            clearTimers();
            socket.removeAllListeners();
            socket.destroy();
        };

        const scheduleFinish = (delayMs: number) => {
            if (readTimer) clearTimeout(readTimer);
            readTimer = setTimeout(finish, delayMs);
        };

        const finish = () => {
            if (settled) return;
            if (!writeCompleted) {
                fail(tcpFailure(
                    `TCP connection closed before the complete payload was written to ${options.host}:${options.port}.`,
                    "TCP_CLOSED_DURING_WRITE",
                    connected ? "write" : "connect",
                    502,
                ));
                return;
            }
            settled = true;
            const response = Buffer.concat(chunks).toString("latin1");
            clearTimers();
            socket.removeAllListeners();

            if (socket.destroyed) {
                resolve({ bytesWritten: options.payload.byteLength, response });
                return;
            }

            let resolved = false;
            const resolveAfterClose = () => {
                if (resolved) return;
                resolved = true;
                if (closeTimer) clearTimeout(closeTimer);
                socket.removeAllListeners();
                resolve({ bytesWritten: options.payload.byteLength, response });
            };

            socket.once("close", resolveAfterClose);
            socket.once("error", resolveAfterClose);
            closeTimer = setTimeout(() => {
                socket.destroy();
                resolveAfterClose();
            }, options.closeWaitMs);
            socket.end();
        };

        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        const bytesAttempted = () => {
            if (!writeStarted) return 0;
            return Math.max(
                0,
                Math.min(options.payload.byteLength, socket.bytesWritten),
            );
        };

        const tcpFailure = (
            message: string,
            code: string,
            stage: TcpFailureStage,
            status: number,
        ) => new TcpExchangeError({
            message,
            code,
            stage,
            status,
            bytesWritten: bytesAttempted(),
            writeStarted,
            writeCompleted,
        });

        socket.on("data", (chunk) => {
            if (responseByteCount + chunk.byteLength > MAX_TCP_RESPONSE_BYTES) {
                fail(tcpFailure(
                    `Printer response exceeds ${MAX_TCP_RESPONSE_BYTES} bytes.`,
                    "TCP_RESPONSE_TOO_LARGE",
                    "read",
                    502,
                ));
                return;
            }
            chunks.push(chunk);
            responseByteCount += chunk.byteLength;
            scheduleFinish(options.readIdleMs);
        });
        socket.on("error", (error: NodeJS.ErrnoException) => {
            const stage: TcpFailureStage = !connected
                ? "connect"
                : writeCompleted
                    ? "read"
                    : "write";
            const semanticCode = !connected
                ? error.code === "ETIMEDOUT"
                    ? "TCP_CONNECT_TIMEOUT"
                    : "TCP_CONNECT_FAILED"
                : writeCompleted
                    ? "TCP_READ_FAILED"
                    : error.code === "ETIMEDOUT"
                        ? "TCP_WRITE_TIMEOUT"
                        : "TCP_WRITE_FAILED";
            fail(tcpFailure(
                error.message,
                semanticCode,
                stage,
                error.code === "ETIMEDOUT" ? 504 : 502,
            ));
        });
        socket.on("close", () => {
            if (settled) return;
            if (writeCompleted) {
                finish();
                return;
            }
            fail(tcpFailure(
                `TCP connection closed before the complete payload was written to ${options.host}:${options.port}.`,
                "TCP_CLOSED_DURING_WRITE",
                connected ? "write" : "close",
                502,
            ));
        });

        socket.connect(options.port, options.host, () => {
            if (connectTimer) clearTimeout(connectTimer);
            connected = true;
            socket.setNoDelay(true);
            socket.setKeepAlive(true, 5_000);
            writeStarted = true;
            writeTimer = setTimeout(() => {
                fail(tcpFailure(
                    `TCP write timeout to ${options.host}:${options.port}.`,
                    "TCP_WRITE_TIMEOUT",
                    "write",
                    504,
                ));
            }, options.writeTimeoutMs);
            try {
                socket.write(options.payload, (error) => {
                    if (writeTimer) clearTimeout(writeTimer);
                    if (error) {
                        const systemError = error as NodeJS.ErrnoException;
                        fail(tcpFailure(
                            error.message,
                            systemError.code === "ETIMEDOUT"
                                ? "TCP_WRITE_TIMEOUT"
                                : "TCP_WRITE_FAILED",
                            "write",
                            systemError.code === "ETIMEDOUT" ? 504 : 502,
                        ));
                        return;
                    }
                    writeCompleted = true;
                    if (options.readWindowMs <= 0) {
                        finish();
                        return;
                    }
                    scheduleFinish(options.readWindowMs);
                });
            } catch (error) {
                const detail = error instanceof Error ? error : new Error(String(error));
                fail(tcpFailure(
                    detail.message,
                    "TCP_WRITE_FAILED",
                    "write",
                    502,
                ));
            }
        });
    });
}

export async function POST(request: Request): Promise<Response> {
    if (!serverTcpEnabled(request)) {
        return jsonResponse(
            {
                ok: false,
                error:
                    "Server-side TCP is disabled on hosted deployments. Run and pair the local print connector, then select TCP execution: Local connector.",
            },
            403,
        );
    }
    try {
        const body = (await request.json().catch(() => ({}))) as TcpRequest;
        const host = cleanHost(body.host);
        if (!host) return jsonResponse({ ok: false, error: "host is required." }, 400);
        if (!serverTcpHostAllowed(host)) {
            return jsonResponse(
                { ok: false, error: `TCP host ${host} is not allowed by this local server.` },
                403,
            );
        }
        const port = cleanPort(body.port);
        if (!allowedServerTcpPorts().has(port)) {
            return jsonResponse(
                { ok: false, error: `TCP port ${port} is not allowed by this local server.` },
                403,
            );
        }

        const result = await withServerPrinterQueue(
            serverTcpPrinterKey(host, port),
            () => exchangeTcp({
                host,
                port,
                payload: payloadBytes(body),
                readWindowMs: cleanMs(body.readWindowMs, 250, 0, 30000),
                readIdleMs: cleanMs(body.readIdleMs, 250, 25, 30000),
                closeWaitMs: cleanMs(body.closeWaitMs, 750, 50, 30000),
                connectTimeoutMs: cleanMs(body.connectTimeoutMs, 5000, 500, 30000),
                writeTimeoutMs: cleanMs(body.writeTimeoutMs, 30000, 500, 120000),
            }),
        );

        return jsonResponse({ ok: true, ...result });
    } catch (error) {
        if (error instanceof TcpExchangeError) {
            return jsonResponse({
                ok: false,
                error: error.message,
                code: error.code,
                stage: error.stage,
                outcome: error.outcome,
                retrySafety: error.retrySafety,
                bytesWritten: error.bytesWritten,
                writeStarted: error.writeStarted,
                writeCompleted: error.writeCompleted,
            }, error.status);
        }
        return jsonResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        }, 500);
    }
}
