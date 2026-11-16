const LOOPBACK_CONNECTOR_URL = "http://127.0.0.1:17917";
const CONFIGURED_CONNECTOR_URL =
    process.env.NEXT_PUBLIC_PRINT_CONNECTOR_URL?.trim() ?? "";

function ipv4Parts(host: string): number[] | null {
    const parts = host.split(".");
    if (parts.length !== 4) return null;
    const values = parts.map((part) => Number(part));
    if (
        values.some(
            (value, index) =>
                !Number.isInteger(value)
                || value < 0
                || value > 255
                || String(value) !== parts[index],
        )
    ) {
        return null;
    }
    return values;
}

function isLoopbackHost(host: string): boolean {
    if (host === "localhost" || host === "::1") return true;
    const parts = ipv4Parts(host);
    return parts !== null && parts[0] === 127;
}

function isPrivateSiteHost(host: string): boolean {
    const parts = ipv4Parts(host);
    if (!parts) return false;
    return parts[0] === 10
        || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168);
}

function configuredHttpsOrigin(): string {
    if (!CONFIGURED_CONNECTOR_URL) return "";
    try {
        const parsed = new URL(CONFIGURED_CONNECTOR_URL);
        if (
            parsed.protocol !== "https:"
            || parsed.username
            || parsed.password
            || (parsed.pathname !== "" && parsed.pathname !== "/")
            || parsed.search
            || parsed.hash
        ) {
            return "";
        }
        return parsed.origin;
    } catch {
        return "";
    }
}

const CONFIGURED_HTTPS_ORIGIN = configuredHttpsOrigin();

function parseConnectorUrl(url: string): URL {
    const trimmed = url.trim().replace(/\/+$/, "");
    const candidate = trimmed || LOOPBACK_CONNECTOR_URL;
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error("Local connector URL is invalid.");
    }
    const host = parsed.hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
    const localAddress = isLoopbackHost(host) || isPrivateSiteHost(host);
    const configuredTlsGateway =
        parsed.protocol === "https:"
        && CONFIGURED_HTTPS_ORIGIN !== ""
        && parsed.origin === CONFIGURED_HTTPS_ORIGIN;
    if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        || (!localAddress && !configuredTlsGateway)
        || parsed.username
        || parsed.password
        || (parsed.pathname !== "" && parsed.pathname !== "/")
        || parsed.search
        || parsed.hash
    ) {
        throw new Error(
            "Connector URL must use loopback/private IP, or the configured HTTPS site gateway.",
        );
    }
    // The connector binds and validates one exact IP literal. Canonicalize
    // the convenient localhost spelling to its default IPv4 loopback address.
    if (host === "localhost" && parsed.protocol === "http:") {
        parsed.hostname = "127.0.0.1";
    }
    return parsed;
}

export function normalizePrintConnectorUrl(url: string): string {
    return parseConnectorUrl(url).origin;
}

export function isLoopbackPrintConnectorUrl(url: string): boolean {
    const parsed = parseConnectorUrl(url);
    const host = parsed.hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
    return isLoopbackHost(host);
}

export const DEFAULT_PRINT_CONNECTOR_URL = (() => {
    try {
        return normalizePrintConnectorUrl(
            CONFIGURED_CONNECTOR_URL || LOOPBACK_CONNECTOR_URL,
        );
    } catch {
        return LOOPBACK_CONNECTOR_URL;
    }
})();
