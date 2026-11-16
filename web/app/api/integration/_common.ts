import type { LabelDoc } from "@/types";

export const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Idempotency-Key, X-Requested-With",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
};

export function jsonResponse(
    data: unknown,
    status = 200,
    additionalHeaders?: HeadersInit,
): Response {
    const headers = new Headers(corsHeaders);
    if (additionalHeaders) {
        new Headers(additionalHeaders).forEach((value, key) => headers.set(key, value));
    }
    return Response.json(data, { status, headers });
}

export function optionsResponse(): Response {
    return new Response(null, { status: 204, headers: corsHeaders });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export function isLabelDoc(value: unknown): value is LabelDoc {
    if (!isRecord(value)) return false;
    return (
        typeof value.id === "string"
        && typeof value.name === "string"
        && Array.isArray(value.elements)
        && isRecord(value.settings)
    );
}

export function parseTemplate(value: unknown): LabelDoc | null {
    if (isLabelDoc(value)) return value;
    if (typeof value !== "string") return null;
    try {
        const parsed = JSON.parse(value);
        return isLabelDoc(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function cleanString(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value.trim() : fallback;
}
