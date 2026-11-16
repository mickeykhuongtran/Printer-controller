import { takeBrowserPrintJob } from "@/integration-browser-print";
import { cleanString, jsonResponse, optionsResponse } from "../../_common";

export const runtime = "nodejs";

export function OPTIONS(): Response {
    return optionsResponse();
}

export async function GET(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const clientId = cleanString(url.searchParams.get("clientId")) || "browser-listener";
    const waitMs = Number(url.searchParams.get("waitMs") || "25000");
    const job = await takeBrowserPrintJob(
        clientId,
        Number.isFinite(waitMs) ? waitMs : 25000,
        req.signal,
    );
    if (!job) return new Response(null, { status: 204 });
    return jsonResponse({ ok: true, job });
}
