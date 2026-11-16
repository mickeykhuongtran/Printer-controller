import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

function enabled(value: string | undefined): boolean {
    const normalized = (value ?? "").trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "enabled";
}

function cloudDeployment(): boolean {
    return process.env.VERCEL === "1"
        || (process.env.NEXTWAVES_DEPLOYMENT_MODE ?? "").trim().toLowerCase() === "cloud";
}

function bearerToken(request: NextRequest): string {
    const authorization = request.headers.get("authorization") ?? "";
    return authorization.replace(/^Bearer\s+/i, "").trim();
}

function allowedOrigin(request: NextRequest): boolean {
    const origin = request.headers.get("origin");
    if (!origin) return true;
    const configured = (process.env.NEXTWAVES_INTEGRATION_ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    return configured.length === 0 || configured.includes(origin);
}

export function proxy(request: NextRequest): NextResponse {
    // The legacy integration endpoints use process memory/local files and are
    // not a durable Vercel queue. Keep them available for the original local
    // standalone deployment, but make cloud exposure an explicit opt-in.
    const integrationEnabled = !cloudDeployment()
        || enabled(process.env.NEXTWAVES_ENABLE_INTEGRATION_API);
    if (!integrationEnabled) {
        return NextResponse.json(
            {
                ok: false,
                error:
                    "The legacy integration API is disabled in cloud mode. Interactive COM, USB-B and TCP printing remains available through the browser/local connector.",
            },
            { status: 503 },
        );
    }

    const expectedToken = process.env.NEXTWAVES_INTEGRATION_API_KEY?.trim() ?? "";
    if (cloudDeployment() && !expectedToken) {
        return NextResponse.json(
            {
                ok: false,
                error:
                    "Cloud integration API is enabled but NEXTWAVES_INTEGRATION_API_KEY is not configured.",
            },
            { status: 503 },
        );
    }

    if (!allowedOrigin(request)) {
        return NextResponse.json(
            { ok: false, error: "Origin is not allowed for the integration API." },
            { status: 403 },
        );
    }

    if (expectedToken && request.method !== "OPTIONS" && bearerToken(request) !== expectedToken) {
        return NextResponse.json(
            { ok: false, error: "Missing or invalid integration API bearer token." },
            { status: 401 },
        );
    }

    return NextResponse.next();
}

export const config = {
    matcher: ["/api/integration/:path*", "/print"],
};
