"use client";

import {
    DEFAULT_PRINT_CONNECTOR_URL,
    isLoopbackPrintConnectorUrl,
    normalizePrintConnectorUrl,
} from "./print-connector-config";

export const DEFAULT_LOCAL_PRINT_AGENT_URL = DEFAULT_PRINT_CONNECTOR_URL;

const AGENT_TOKEN_STORAGE_PREFIX = "zbre.print.agent-token.v1";
const agentMemoryTokens = new Map<string, string>();

type LocalAddressRequestInit = RequestInit & {
    targetAddressSpace?: "local" | "loopback";
};

export type AgentErrorPayload = {
    error?: unknown;
    detail?: unknown;
    code?: unknown;
    stage?: unknown;
    outcome?: unknown;
    retrySafety?: unknown;
    bytesWritten?: unknown;
    writeStarted?: unknown;
    writeCompleted?: unknown;
    jobId?: unknown;
    sequence?: unknown;
    state?: unknown;
    jobState?: unknown;
    nextSequence?: unknown;
    checkpointState?: unknown;
    checkpointHash?: unknown;
};

export type LocalPrintAgentHealth = {
    ok: boolean;
    name?: string;
    version?: string;
    platform?: string;
    arch?: string;
    architecture?: string;
    paired?: boolean;
    pairingRequired?: boolean;
    capabilities?: string[] | Record<string, boolean>;
    win32print?: boolean;
    windowsRaw?: boolean;
    tcp?: boolean;
    host?: string;
    listenAddress?: string;
    siteMode?: boolean;
    requireOriginToken?: boolean;
    port?: number;
};

export class LocalPrintAgentHttpError extends Error {
    status: number;
    code?: string;
    payload?: AgentErrorPayload;

    constructor(
        status: number,
        message: string,
        code?: string,
        payload?: AgentErrorPayload,
    ) {
        super(message);
        this.name = "LocalPrintAgentHttpError";
        this.status = status;
        this.code = code;
        this.payload = payload;
    }
}

export function normalizeLocalAgentUrl(url: string): string {
    return normalizePrintConnectorUrl(url);
}

export function isLoopbackWebApp(): boolean {
    if (typeof window === "undefined") return false;
    const host = window.location.hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function agentTokenStorageKey(agentUrl: string): string {
    return `${AGENT_TOKEN_STORAGE_PREFIX}:${normalizeLocalAgentUrl(agentUrl).toLowerCase()}`;
}

export function loadLocalAgentToken(agentUrl: string): string {
    if (typeof window === "undefined") return "";
    const key = agentTokenStorageKey(agentUrl);
    try {
        const persisted = window.localStorage.getItem(key)?.trim() ?? "";
        if (persisted) {
            agentMemoryTokens.set(key, persisted);
            return persisted;
        }
    } catch {
        // Fall back to memory for locked-down/private browser profiles.
    }
    return agentMemoryTokens.get(key) ?? "";
}

export function saveLocalAgentToken(agentUrl: string, token: string): boolean {
    if (typeof window === "undefined") return false;
    const key = agentTokenStorageKey(agentUrl);
    const cleaned = token.trim();
    if (cleaned) {
        agentMemoryTokens.set(key, cleaned);
    } else {
        agentMemoryTokens.delete(key);
    }
    try {
        if (cleaned) {
            window.localStorage.setItem(key, cleaned);
        } else {
            window.localStorage.removeItem(key);
        }
        return (window.localStorage.getItem(key)?.trim() ?? "") === cleaned;
    } catch {
        // The in-memory token keeps the current tab usable, but it will need
        // pairing again after a reload.
        return false;
    }
}

function errorMessage(status: number, payload: AgentErrorPayload | null): string {
    if (typeof payload?.error === "string" && payload.error.trim()) {
        return payload.error.trim();
    }
    if (typeof payload?.detail === "string" && payload.detail.trim()) {
        return payload.detail.trim();
    }
    if (status === 401 || status === 403) {
        return "Local print agent authorization failed. Open Printer setup and pair this website with the agent.";
    }
    return `Local print agent returned HTTP ${status}.`;
}

export async function fetchLocalAgentJson<T>(
    agentUrl: string,
    path: string,
    init: RequestInit = {},
    options: {
        timeoutMs?: number;
        includeToken?: boolean;
        responseType?: "json" | "blob";
    } = {},
): Promise<T> {
    if (typeof window === "undefined") {
        throw new Error("The local print agent can only be called from a browser.");
    }

    const base = normalizeLocalAgentUrl(agentUrl);
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? 5000;
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    const headers = new Headers(init.headers);
    // The new connector deliberately keeps localhost-origin workflows
    // tokenless for compatibility with the original local deployment. Avoid
    // sending a persisted Authorization header there because the legacy
    // Windows-only agent does not allow that header in its CORS preflight.
    if (
        options.includeToken !== false
        && (!isLoopbackWebApp() || !isLoopbackPrintConnectorUrl(base))
    ) {
        const token = loadLocalAgentToken(base);
        if (token) headers.set("Authorization", `Bearer ${token}`);
    }

    const requestInit: LocalAddressRequestInit = {
        ...init,
        headers,
        signal: controller.signal,
        cache: "no-store",
        // Chrome's Local Network Access implementation uses this hint for
        // public HTTPS origins that call a loopback HTTP connector.
        targetAddressSpace: isLoopbackPrintConnectorUrl(base)
            ? "loopback"
            : "local",
    };

    try {
        const response = await fetch(`${base}${path}`, requestInit);
        if (response.ok && options.responseType === "blob") return await response.blob() as T;
        const json = (await response.json().catch(() => null)) as (T & AgentErrorPayload) | null;
        if (!response.ok) {
            const code = typeof json?.code === "string" ? json.code : undefined;
            throw new LocalPrintAgentHttpError(
                response.status,
                errorMessage(response.status, json),
                code,
                json ?? undefined,
            );
        }
        if (json === null) {
            throw new Error("Empty response from local print agent.");
        }
        return json;
    } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
            throw new Error("Local print agent did not respond in time.");
        }
        if (error instanceof TypeError) {
            throw new Error(
                "Could not reach the local print connector. Start it, allow Local Network Access in the browser, then pair this website.",
            );
        }
        throw error;
    } finally {
        window.clearTimeout(timer);
    }
}

export async function getLocalPrintAgentHealth(
    agentUrl = DEFAULT_LOCAL_PRINT_AGENT_URL,
): Promise<LocalPrintAgentHealth> {
    try {
        return await fetchLocalAgentJson<LocalPrintAgentHealth>(
            agentUrl,
            "/v1/health",
            { method: "GET" },
            { timeoutMs: 3000, includeToken: false },
        );
    } catch (error) {
        if (!(error instanceof LocalPrintAgentHttpError) || error.status !== 404) {
            throw error;
        }
        // Compatibility with the original Windows-only agent.
        return fetchLocalAgentJson<LocalPrintAgentHealth>(
            agentUrl,
            "/health",
            { method: "GET" },
            { timeoutMs: 3000, includeToken: false },
        );
    }
}

export async function pairLocalPrintAgent(
    agentUrl: string,
    pairingCode: string,
): Promise<{ ok: boolean; token: string; origin?: string; persisted: boolean }> {
    const code = pairingCode.trim();
    if (!code) throw new Error("Enter the pairing code shown by the local print agent.");

    const result = await fetchLocalAgentJson<{
        ok: boolean;
        token?: string;
        origin?: string;
    }>(
        agentUrl,
        "/v1/pair",
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code }),
        },
        { timeoutMs: 5000, includeToken: false },
    );
    const token = result.token?.trim() ?? "";
    if (!result.ok || !token) {
        throw new Error("The local print agent did not return a pairing token.");
    }
    const persisted = saveLocalAgentToken(agentUrl, token);
    return { ok: true, token, origin: result.origin, persisted };
}
