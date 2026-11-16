"use client";
import { fetchLocalAgentJson } from "./local-print-agent";
import type { RfidCaptureOptions, RfidCaptureSummary } from "./rfid-capture";

export type FleetJob = {
    cancelRequested?: boolean; windowLabels?: number; streaming?: boolean; inputComplete?: boolean;
    jobId: string; host: string; port: number; state: string; createdAt: string; error?: string; paused?: boolean; rollValidBefore?: number; rollVoidBefore?: number;
    capture?: RfidCaptureOptions; bytes: number; checkpoint: string;
    receipt?: { state: string; capture?: RfidCaptureSummary; serviceFault?: string; faultClearRequested?: boolean };
};
export type FleetSnapshot = { jobs: FleetJob[]; stale: boolean };
export const fleetStatusNames: Record<string, string> = { staging: "Đang chuẩn bị trên host", queued: "Chờ in", printing: "Đang in", done: "Xong lượt · chờ đối soát", cancelled: "Đã dừng lượt", not_sent: "Chưa gửi tem", needs_review: "Cần kiểm tra", reviewed: "Đã đối soát" };
export function fleetNotice(job: FleetJob, stale: boolean): { text: string; kind: "info" | "ok" | "error" } {
    if (stale) return { text: "Mất kết nối theo dõi. Kiểm tra bảng máy in trước khi gửi lại.", kind: "error" };
    if (job.state === "not_sent" || job.state === "needs_review") return { text: job.error || fleetStatusNames[job.state], kind: "error" };
    if (job.cancelRequested && isFleetActive(job)) return { text: "Đang dừng cấp tem và kiểm tra hàng đợi máy in…", kind: "info" };
    if (job.state === "printing") return { text: job.paused ? "Máy đang tạm dừng. Bấm Tiếp tục khi đã sẵn sàng." : "Host đang cấp tem theo sức chứa máy. Có thể Tạm dừng hoặc Cancel batch.", kind: "info" };
    return { text: fleetStatusNames[job.state] || job.state, kind: job.state === "done" ? "ok" : "info" };
}
export async function fleetRequest<T = { ok: boolean; job: FleetJob }>(agent: string, action: string, data: Record<string, unknown> = {}): Promise<T> {
    return fetchLocalAgentJson<T>(agent, "/v1/tcp/job", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...data }) }, { timeoutMs: 30_000 });
}
export async function stageFleetChunk(agent: string, jobId: string, sequence: number, payload: Uint8Array) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", payload.slice().buffer));
    const payloadSha256 = Array.from(digest, b => b.toString(16).padStart(2, "0")).join("");
    let binary = "";
    for (let i = 0; i < payload.length; i += 32768) binary += String.fromCharCode(...payload.subarray(i, i + 32768));
    // Retries are safe: connector binds each sequence to its content hash.
    const data = { jobId, sequence, payloadSha256, payloadBase64: btoa(binary) };
    try { return await fleetRequest(agent, "spool-append", data); }
    catch { return fleetRequest(agent, "spool-append", data); }
}
export const isFleetActive = (job: FleetJob) => job.state === "queued" || job.state === "printing";
