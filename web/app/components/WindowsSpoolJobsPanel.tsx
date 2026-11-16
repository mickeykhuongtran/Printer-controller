"use client";

import { useCallback, useEffect, useState } from "react";
import { fetchLocalAgentJson, LocalPrintAgentHttpError } from "../local-print-agent";
import { forgetMissingWindowsSpoolBatch, listPendingWindowsSpoolBatches } from "../windows-raw-print";

type Batch = {
    batchId: string;
    printerName: string;
    documentName: string;
    totalLabels: number;
    stagedLabels: number;
    stagedBytes: number;
    nextSequence: number;
    state: string;
    jobId: number | null;
    error?: string;
    recoveryRequired?: boolean;
    updatedAt?: string;
    spoolStatus?: { state?: string; statusText?: string; exists?: boolean };
};

const stateLabels: Record<string, string> = {
    staging: "Preparing labels",
    queued: "Waiting to submit",
    spooling: "Submitting to Windows",
    "spool-accepted": "Accepted by Windows",
    failed: "Submission failed",
    uncertain: "Printing interrupted",
    cancelled: "Closed without reprinting",
};

export default function WindowsSpoolJobsPanel({ agentUrl, printerName }: {
    agentUrl: string;
    printerName: string;
}) {
    const [batches, setBatches] = useState<Batch[]>([]);
    const [localRequests, setLocalRequests] = useState<string[]>([]);
    const [error, setError] = useState("");
    const [busy, setBusy] = useState("");
    const [revision, setRevision] = useState(0);

    const post = useCallback(<T,>(body: Record<string, unknown>) => fetchLocalAgentJson<T>(
        agentUrl, "/v1/print/batch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        }, { timeoutMs: 8_000 },
    ), [agentUrl]);

    useEffect(() => {
        if (!agentUrl.trim() || !printerName.trim()) return;
        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const refresh = async () => {
            try {
                const result = await post<{ ok: boolean; batches: Batch[] }>({ action: "list" });
                if (!result.ok || !Array.isArray(result.batches)) throw new Error("Invalid batch history response.");
                const missing: string[] = [];
                // Archived history is omitted from list, but a locally pending
                // batch must remain reachable until the operator resolves it.
                for (const pending of listPendingWindowsSpoolBatches(agentUrl, printerName)) {
                    if (result.batches.some((batch) => batch.batchId === pending.batchId)) continue;
                    try {
                        const saved = await post<Batch & { ok: boolean }>({ action: "status", batchId: pending.batchId });
                        if (!saved.ok) throw new Error("Invalid saved batch response.");
                        result.batches.push(saved);
                    } catch (cause) {
                        if (cause instanceof LocalPrintAgentHttpError && cause.status === 404) missing.push(pending.batchId);
                        else throw cause;
                    }
                }
                if (!disposed) {
                    const filtered = result.batches.filter((batch) =>
                        batch.printerName.trim().toLowerCase() === printerName.trim().toLowerCase(),
                    ).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
                    setBatches((previous) => filtered.map((batch) => ({
                        ...batch,
                        spoolStatus: batch.spoolStatus ?? previous.find((entry) =>
                            entry.batchId === batch.batchId && entry.jobId === batch.jobId)?.spoolStatus,
                    })));
                    setLocalRequests(missing);
                    setError("");
                }
            } catch (cause) {
                if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
                if (!disposed) timer = setTimeout(refresh, 5_000);
            }
        };
        void refresh();
        return () => { disposed = true; clearTimeout(timer); };
    }, [post, printerName, revision, agentUrl]);

    const act = async (batch: Batch, action: "status" | "cancel" | "reconcile" | "commit" | "archive") => {
        setBusy(batch.batchId);
        setError("");
        try {
            const result = await post<Batch & { ok: boolean }>({
                action, batchId: batch.batchId,
                ...(action === "commit" ? { totalChunks: batch.nextSequence - 1, totalBytes: batch.stagedBytes } : {}),
                ...(action === "reconcile" ? {
                    resolution: "do-not-reprint", acknowledgePrinterCleared: true,
                } : {}),
            });
            if (!result.ok) throw new Error(result.error || "The batch action did not complete.");
            setBatches((current) => current.map((entry) => entry.batchId === result.batchId ? result : entry));
            window.dispatchEvent(new Event("nextwaves-raw-spool-batches-changed"));
            if (action !== "status") setRevision((value) => value + 1);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy("");
        }
    };

    const discardLocal = async (batchId: string) => {
        setBusy(batchId);
        setError("");
        try {
            await forgetMissingWindowsSpoolBatch(agentUrl, batchId);
            setLocalRequests((current) => current.filter((id) => id !== batchId));
            setRevision((value) => value + 1);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setBusy("");
        }
    };

    if (!agentUrl.trim() || !printerName.trim()) return null;
    const unresolved = batches.filter((batch) => ["staging", "queued", "spooling", "uncertain"].includes(batch.state));
    const pendingCount = unresolved.length + localRequests.length;
    const visible = [...unresolved, ...batches.filter((batch) => !unresolved.includes(batch)).slice(0, 8)];
    return (
        <details className="rounded-xl border border-border bg-card p-3 text-foreground" data-testid="print-history">
            <summary className="cursor-pointer text-sm font-semibold">
                Print history {error || localRequests.length || batches.some((batch) => batch.state === "uncertain" || batch.recoveryRequired) ? "· Needs attention" : pendingCount > 0 ? `(${pendingCount} pending)` : ""}
            </summary>
            <p className="mt-2 text-xs text-muted-foreground">Windows manages queued jobs. Pause and resume on the printer. Use this history only to review or recover an interrupted submission.</p>
            {error && <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{error}</p>}
            {visible.length === 0 && localRequests.length === 0 && <p className="mt-2 text-xs text-muted-foreground">No saved batches for this queue.</p>}
            <div className="mt-2 space-y-2">
                {localRequests.map((batchId) => <div key={batchId} className="rounded-lg border border-amber-200 p-3 text-xs">
                    <p className="font-medium text-amber-900 dark:text-amber-300">Local request awaiting verification</p>
                    <p className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{batchId}</p>
                    <p className="mt-2 text-muted-foreground">The connector has no visible history for this request. Discard checks the connector again and only clears this local request if the batch is absent.</p>
                    <button type="button" disabled={!!busy} onClick={() => void discardLocal(batchId)} className="mt-2 rounded border px-2 py-1 disabled:opacity-50">Verify and discard local request</button>
                </div>)}
                {visible.map((batch) => (
                    <div key={batch.batchId} className="rounded-lg border border-border p-3 text-xs">
                        <div className="flex flex-wrap items-start justify-between gap-2">
                            <span className="break-all font-medium">{batch.documentName}</span>
                            <span className={batch.state === "uncertain" ? "font-semibold text-amber-800 dark:text-amber-300" : "text-muted-foreground"}>{stateLabels[batch.state] || batch.state}</span>
                        </div>
                        <p className="mt-1 text-muted-foreground">{batch.stagedLabels}/{batch.totalLabels} labels</p>
                        <details className="mt-1 text-muted-foreground">
                            <summary className="cursor-pointer">Technical details</summary>
                            <p className="mt-1 break-all font-mono text-[10px]">{batch.batchId}{batch.jobId != null ? ` · Windows job ${batch.jobId}` : ""}</p>
                        </details>
                        {batch.error && <p className="mt-2 whitespace-pre-wrap text-amber-800 dark:text-amber-300">{batch.error}</p>}
                        {batch.recoveryRequired && <p className="mt-2 text-amber-800 dark:text-amber-300">Recovered after restart. This batch has not been automatically resubmitted.</p>}
                        {batch.spoolStatus && <p className="mt-2 text-muted-foreground">Windows: {batch.spoolStatus.exists === false ? "Job no longer in queue; physical outcome is not confirmed." : (batch.spoolStatus.statusText || batch.spoolStatus.state || "Job status available.")}</p>}
                        {batch.state === "uncertain" && (
                            <p className="mt-3 text-amber-900 dark:text-amber-300">Check printed labels and EPCs, and resolve any pending job in Windows and on the printer before closing this submission. Select the remaining range separately.</p>
                        )}
                        <div className="mt-2 flex flex-wrap gap-2">
                            <button type="button" disabled={!!busy} onClick={() => void act(batch, "status")} className="rounded border px-2 py-1 disabled:opacity-50">Check status</button>
                            {["staging", "queued", "failed"].includes(batch.state) && <button type="button" disabled={!!busy} onClick={() => void act(batch, "cancel")} className="rounded border px-2 py-1 disabled:opacity-50">Discard unsent batch</button>}
                            {batch.recoveryRequired && ["staging", "queued"].includes(batch.state) && batch.stagedLabels === batch.totalLabels && batch.stagedBytes > 0 && <button type="button" disabled={!!busy} onClick={() => void act(batch, "commit")} className="rounded border border-blue-400 px-2 py-1 text-blue-800 dark:text-blue-300 disabled:opacity-50">Submit saved batch</button>}
                            {batch.state === "uncertain" && <button type="button" disabled={!!busy} onClick={() => void act(batch, "reconcile")} className="rounded border border-amber-400 px-2 py-1 text-amber-900 dark:text-amber-300 disabled:opacity-50">Labels checked — close without reprinting</button>}
                            {["spool-accepted", "cancelled"].includes(batch.state) && <button type="button" disabled={!!busy} onClick={() => void act(batch, "archive")} className="rounded border px-2 py-1 disabled:opacity-50">Archive history</button>}
                        </div>
                    </div>
                ))}
            </div>
        </details>
    );
}
