"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { listRfidSessions, downloadRfidSession } from "../rfid-history";
import type { RfidCaptureSummary } from "../rfid-capture";

export function RfidSessionsPanel({ agentUrl, revision, busy }: { agentUrl: string; revision: number; busy: boolean }) {
    const [open, setOpen] = useState(false);
    const [sessions, setSessions] = useState<RfidCaptureSummary[]>([]);
    const [hiddenJobId, setHiddenJobId] = useState("");
    const viewKey = `zbre.rfid-history.hidden:${agentUrl}`;
    useEffect(() => { let live = true; void Promise.resolve().then(() => { if (!live) return; try { setHiddenJobId(localStorage.getItem(viewKey) || ""); } catch { setHiddenJobId(""); } }); return () => { live = false; }; }, [viewKey]);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(false);
    const refresh = useCallback(async () => {
        setLoading(true);
        try { const result = await listRfidSessions(agentUrl); setSessions(result.sessions.slice(0, 1)); setError(""); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setLoading(false); }
    }, [agentUrl]);
    useEffect(() => {
        if (!open) return;
        void Promise.resolve().then(refresh);
        if (!busy) return;
        const timer = window.setInterval(() => void refresh(), 5000);
        return () => window.clearInterval(timer);
    }, [open, refresh, revision, busy]);
    return <details className="rounded border border-border p-3" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer text-sm font-semibold">RFID session history</summary>
        <div className="mt-3 space-y-3 text-xs">
            <p className="text-muted-foreground">Latest session only. Clear view hides this card; every session file stays on disk. Readbacks and printer totals support batch reconciliation, not optical print-quality verification.</p>
            <p className="break-all text-muted-foreground">Desktop archive: %APPDATA%\ZbrePrinter\connector\rfid-sessions. Each session folder keeps its CSV files.</p>
            <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={loading} onClick={() => void refresh()}>Refresh</Button>
            <Button size="sm" variant="outline" disabled={busy || loading || !sessions.length || sessions[0].jobId === hiddenJobId} onClick={() => {
                const id = sessions[0]?.jobId || ""; setHiddenJobId(id);
                try { localStorage.setItem(viewKey, id); } catch { /* Keep current view usable. */ }
            }}>Clear view</Button>
            {hiddenJobId && <Button size="sm" variant="outline" onClick={() => { setHiddenJobId(""); try { localStorage.removeItem(viewKey); } catch { /* Local view only. */ } }}>Show latest</Button>}
            </div>
            {error && <p role="alert" className="text-destructive">{error}</p>}
            {!loading && !error && (sessions.length === 0 || sessions[0]?.jobId === hiddenJobId) && <p>No session displayed. Saved files have not been deleted.</p>}
            {sessions.filter(s => s.jobId !== hiddenJobId).map((s) => <div key={s.jobId} className="space-y-1 rounded bg-muted/50 p-2">
                <p className="font-medium">{s.options.templateName || "Untitled template"} · {new Date(s.createdAt).toLocaleString(undefined, { hour12: false })}</p>
                <p>{s.host}:{s.port} · {s.options.bank} · {s.state}</p>
                <p>{s.uniqueLabels}/{s.options.expectedLabels} label reads · {s.received} responses · {s.issues} issues</p>
                {s.audit && <p>Batch validation: {s.audit.state || "not_recorded"}{["matched", "needs_review"].includes(s.audit.state) ? ` · ${s.audit.validDelta} valid · ${s.audit.voidDelta} VOID · ${s.audit.totalDelta} label-counter increase` : ""}</p>}
                {s.audit?.note && <p className="text-muted-foreground">{s.audit.note}</p>}
                {s.error && <p className="text-destructive">{s.error}</p>}
                <p className="break-all font-mono text-[10px]">{s.jobId}</p>
                <Button size="sm" variant="outline" onClick={() => void downloadRfidSession(agentUrl, s).catch((e) => setError(String(e)))}>Download CSV</Button>
            </div>)}
        </div>
    </details>;
}
