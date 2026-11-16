"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { fleetRequest, isFleetActive, type FleetJob } from "../fleet-spool";
import { fetchLocalAgentJson } from "../local-print-agent";

export function FleetJobControls({ job, agent, stale = false }: { job: FleetJob; agent: string; stale?: boolean }) {
    const [working, setWorking] = useState(false), [error, setError] = useState("");
    const [review, setReview] = useState(false), [note, setNote] = useState("");
    const act = async (action: string) => {
        setWorking(true); setError("");
        try {
            if (action === "pause" || action === "resume") {
                await fetchLocalAgentJson(agent, "/v1/tcp/exchange", { method: "POST", headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ host: job.host, port: job.port, payloadBase64: btoa(action === "pause" ? "~PP\r\n" : "~PS\r\n"), readWindowMs: 0 }) }, { timeoutMs: 15_000 });
            } else await fleetRequest(agent, action, { jobId: job.jobId, confirmed: true, reconciliationNote: note.trim() });
            if (action === "spool-reconcile") { setReview(false); setNote(""); }
            window.dispatchEvent(new Event("zbre-fleet-refresh"));
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setWorking(false); }
    };
    return <div className="space-y-2">
        {isFleetActive(job) && <div className="flex flex-wrap gap-1 pt-1">
            <Button size="sm" variant="outline" disabled={working || stale || job.state !== "printing" || job.cancelRequested} onClick={() => void act("pause")}>Tạm dừng</Button>
            <Button size="sm" variant="outline" disabled={working || stale || job.state !== "printing" || job.cancelRequested} onClick={() => void act("resume")}>Tiếp tục</Button>
            <Button size="sm" variant="destructive" disabled={working || stale || job.cancelRequested} onClick={() => void act("spool-cancel")}>{job.cancelRequested ? "Đang dừng…" : "Cancel batch"}</Button>
        </div>}
        {job.state === "needs_review" && <>
            <p>Lượt trước đã dừng; cần kiểm tra tem và hàng đợi trước khi in tiếp.</p>
            <Button size="sm" variant="outline" disabled={working || stale} onClick={() => setReview(true)}>Đối soát lượt dừng</Button>
        </>}
        {review && job.state === "needs_review" && <div className="rounded border p-2 space-y-2">
            <p>Kiểm tra máy đã dừng, hàng đợi đã xóa và tem đã in. Xác nhận này giữ nguyên CSV, không in lại lượt cũ.</p>
            <input aria-label="Stopped run review" maxLength={500} className="rounded border px-2 w-full bg-background" value={note} placeholder="Ghi ngắn kết quả kiểm tra thực tế" onChange={e => setNote(e.target.value)} />
            <div className="flex gap-2"><Button size="sm" disabled={note.trim().length < 8 || working || stale} onClick={() => void act("spool-reconcile")}>Xác nhận đã kiểm tra</Button><Button size="sm" variant="outline" onClick={() => setReview(false)}>Để sau</Button></div>
        </div>}
        {error && <p role="alert" className="text-destructive">{error}</p>}
    </div>;
}
