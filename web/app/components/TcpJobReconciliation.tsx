"use client";

import { useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import type { PrinterSettings } from "../storage";
import { TcpPrintJob, TcpPrintJobError } from "../tcp-print-job";

// Keep failed requests reachable across reloads without asking users to copy IDs.
// The connector, not this local pointer, determines whether recovery is allowed.
const recoveryMemory = new Map<string, string>();
const recoveryEvent = "zbre-tcp-recovery-changed";
type RecoveryKind = "interrupted" | "cancelled" | "service-fault";
function subscribeRecovery(listener: () => void) {
    const onStorage = (event: StorageEvent) => {
        if (event.key) recoveryMemory.delete(event.key);
        else recoveryMemory.clear();
        listener();
    };
    window.addEventListener("storage", onStorage);
    window.addEventListener(recoveryEvent, listener);
    return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener(recoveryEvent, listener);
    };
}

export function useTcpJobRecovery(settings: PrinterSettings) {
    const key = `zbre.tcp-recovery.v1:${JSON.stringify([
        settings.printAgentUrl.trim(), settings.tcpExecutionMode,
        settings.tcpHost.trim().toLowerCase(), settings.tcpPort,
    ])}`;
    const raw = useSyncExternalStore(subscribeRecovery, () => {
        if (recoveryMemory.has(key)) return recoveryMemory.get(key)!;
        try { return localStorage.getItem(key) || ""; }
        catch { return ""; }
    }, () => "");
    let jobId = raw;
    let kind: RecoveryKind = "interrupted";
    if (raw.startsWith("{")) {
        try {
            const record = JSON.parse(raw);
            jobId = typeof record.jobId === "string" ? record.jobId : "";
            kind = record.kind === "cancelled" || record.kind === "service-fault" ? record.kind : "interrupted";
        } catch { jobId = ""; }
    }
    const remember = (jobId: string, kind: RecoveryKind = "interrupted") => {
        const value = jobId ? JSON.stringify({ jobId, kind }) : "";
        recoveryMemory.set(key, value);
        try {
            if (jobId) localStorage.setItem(key, value);
            else localStorage.removeItem(key);
        } catch { /* Recovery remains available in this window. */ }
        window.dispatchEvent(new Event(recoveryEvent));
    };
    return { jobId, kind, remember };
}

export function TcpJobReconciliation({ settings, stoppedJobId, disabled, onResolved, kind = "interrupted" }: {
    settings: PrinterSettings;
    stoppedJobId: string;
    disabled: boolean;
    onResolved: () => void;
    kind?: RecoveryKind;
}) {
    const [pending, setPending] = useState(false);
    const [message, setMessage] = useState("");
    const reconcile = async () => {
        setPending(true);
        setMessage("");
        try {
            await TcpPrintJob.reconcile({
                jobId: stoppedJobId, host: settings.tcpHost, port: settings.tcpPort,
                agentUrl: settings.printAgentUrl, executionMode: settings.tcpExecutionMode,
                confirmed: true,
                note: "Operator checked printed labels and EPCs, confirmed no pending labels, and closed the interrupted job without reprinting.",
            });
            onResolved();
        } catch (error) {
            // TCP receipts are retained in memory by the connector. After a
            // connector restart/expiry, an explicit physical check may close
            // this local reminder. Never treat network/auth/route errors as a
            // missing job, and never create/replay a job to recover its receipt.
            if (error instanceof TcpPrintJobError && error.status === 404
                && ["TCP_JOB_NOT_FOUND", "JOB_NOT_FOUND"].includes(error.code)) {
                onResolved();
            } else {
                setMessage(error instanceof Error ? error.message : String(error));
            }
        } finally {
            setPending(false);
        }
    };
    if (!stoppedJobId || disabled) return null;
    if (kind === "service-fault") return (
        <div className="rounded-md border border-amber-500/40 p-3 text-xs space-y-2" data-testid="tcp-recovery">
            <p className="font-medium">Đã dừng lần in để xử lý máy</p>
            <p>Kiểm tra giấy, mực và đầu in. Đối chiếu GOOD còn lại, nhập số tem cần bù rồi bấm Print.</p>
        </div>
    );
    return (
        <div className="rounded-md border border-amber-500/40 p-3 text-xs space-y-3" data-testid="tcp-recovery">
            <p className="font-medium">{kind === "cancelled" ? "Sending stopped — clear the printer buffer" : "Printing was interrupted"}</p>
            {kind === "cancelled"
                ? <p>Keep the printer paused. Now that sending has stopped, hold CANCEL (X) on the printer for two seconds to clear remaining labels. Check printed rows and EPCs before closing this job and choosing a new range.</p>
                : <p>Keep the printer paused; do not resume this interrupted run. Hold CANCEL (X) on the printer for two seconds to clear remaining labels, then inspect printed rows and EPCs and isolate any suspect labels. Close this job only after confirming that no labels remain pending. Start a new run only after reconciliation.</p>}
            <Button size="sm" variant="outline" disabled={pending}
                onClick={() => void reconcile()}>{pending ? "Checking…" : "Labels checked — close interrupted job"}</Button>
            {message && <p role="alert">{message}</p>}
        </div>
    );
}
