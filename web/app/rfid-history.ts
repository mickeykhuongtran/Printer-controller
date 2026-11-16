"use client";

import { fetchLocalAgentJson } from "./local-print-agent";
import type { RfidCaptureSummary } from "./rfid-capture";

export function listRfidSessions(agentUrl: string, offset = 0): Promise<{ sessions: RfidCaptureSummary[]; total: number }> {
    return fetchLocalAgentJson(agentUrl, "/v1/tcp/job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "capture-list", historyOffset: offset }),
    }, { timeoutMs: 30_000 });
}

async function sessionFileName(session: RfidCaptureSummary): Promise<string> {
    // Use the session start in local time, never the time of the download.
    const started = new Date(session.createdAt);
    const pad = (value: number) => String(value).padStart(2, "0");
    const timestamp = Number.isNaN(started.getTime()) ? "unknown-time"
        : `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}`
            + `_${pad(started.getHours())}-${pad(started.getMinutes())}-${pad(started.getSeconds())}`;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(session.jobId)));
    const shortId = Array.from(digest.slice(0, 6), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const bank = session.options.bank === "TID" ? "tid" : "epc";
    const operation = session.options.operationMode === "write" || session.options.operationMode === "read_write" ? "Write" : "Read";
    return `${timestamp}_${bank}_${operation}_${shortId}.csv`;
}

export async function downloadRfidSession(agentUrl: string, session: RfidCaptureSummary): Promise<void> {
    const fileName = await sessionFileName(session);
    const blob = await fetchLocalAgentJson<Blob>(agentUrl, "/v1/tcp/job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "capture-export", jobId: session.jobId }),
    }, { timeoutMs: 60_000, responseType: "blob" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url; link.download = fileName;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
