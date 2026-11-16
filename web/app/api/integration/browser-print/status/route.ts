import {
    browserPrintJobStatus,
    browserPrintStatus,
    touchBrowserPrintClient,
} from "@/integration-browser-print";
import { serverPrinterQueueStatus } from "@/server-printer-queue";
import { cleanString, jsonResponse, optionsResponse } from "../../_common";

export const runtime = "nodejs";

export function OPTIONS(): Response {
    return optionsResponse();
}

export function GET(req: Request): Response {
    const url = new URL(req.url);
    const clientId = cleanString(url.searchParams.get("clientId"));
    if (clientId) touchBrowserPrintClient(clientId);
    const jobId = cleanString(url.searchParams.get("jobId"));
    if (jobId) {
        const job = browserPrintJobStatus(jobId);
        if (!job) return jsonResponse({ ok: false, error: "Print job was not found." }, 404);
        return jsonResponse({ ok: true, job });
    }
    return jsonResponse({
        ok: true,
        ...browserPrintStatus(),
        serverQueue: serverPrinterQueueStatus(),
    });
}
