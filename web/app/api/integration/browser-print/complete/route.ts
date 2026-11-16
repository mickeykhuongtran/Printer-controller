import { completeBrowserPrintJob } from "@/integration-browser-print";
import { cleanString, isRecord, jsonResponse, optionsResponse } from "../../_common";

export const runtime = "nodejs";

export function OPTIONS(): Response {
    return optionsResponse();
}

export async function POST(req: Request): Promise<Response> {
    const body = await req.json().catch(() => null);
    if (!isRecord(body)) {
        return jsonResponse({ ok: false, error: "JSON body must be an object." }, 400);
    }

    const jobId = cleanString(body.jobId);
    if (!jobId) return jsonResponse({ ok: false, error: "jobId is required." }, 400);

    const ok = completeBrowserPrintJob(jobId, {
        ok: body.ok === true,
        bytes: typeof body.bytes === "number" ? body.bytes : undefined,
        rfidEpc: cleanString(body.rfidEpc),
        print: body.print,
        error: cleanString(body.error),
        detail: body.detail,
    });
    if (!ok) return jsonResponse({ ok: false, error: "Print job was not found." }, 404);

    return jsonResponse({ ok: true });
}
