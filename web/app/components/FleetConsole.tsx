"use client";
import { useEffect, useRef, useState } from "react";
import { fleetDraft } from "../fleet-drafts";
import { fleetRequest, isFleetActive, fleetStatusNames, type FleetJob } from "../fleet-spool";
import { publishFleetSnapshot } from "../fleet-store";
import { FleetJobControls } from "./FleetJobControls";
import type { PrinterSettings } from "../storage";
import type { LabelDoc } from "../types";
import { Button } from "@/components/ui/button";

type Profile = { id: string; host: string; port: number; settings: PrinterSettings; doc?: LabelDoc };
type Props = { settings: PrinterSettings; doc: LabelDoc; preparing: boolean; onSwitching: (busy: boolean) => void; onSelect: (settings: PrinterSettings, doc?: LabelDoc) => void };
const KEY = "zbre.fleet.v1";
export function FleetConsole({ settings, doc, preparing, onSelect, onSwitching }: Props) {
    const [profiles, setProfiles] = useState<Profile[]>([]), [jobs, setJobs] = useState<FleetJob[]>([]);
    const [host, setHost] = useState(""), [showAdd, setShowAdd] = useState(false), [error, setError] = useState("");
    const [working, setWorking] = useState("");
    const [ready, setReady] = useState(false), [stale, setStale] = useState(false);
    const current = useRef({ settings, doc });
    useEffect(() => { current.current = { settings, doc }; }, [settings, doc]);
    useEffect(() => {
        let live = true;
        void (async () => {
            // Read legacy embedded documents once, then move them out of localStorage.
            await Promise.resolve();
            try {
                const saved = JSON.parse(localStorage.getItem(KEY) || "[]");
                if (Array.isArray(saved)) {
                    const valid = saved.filter(p => p && typeof p.id === "string" && typeof p.host === "string" && p.settings) as Profile[];
                    for (const profile of valid) { if (profile.doc) await fleetDraft(profile.id, profile.doc); delete profile.doc; }
                    if (live) { setProfiles(valid); localStorage.setItem(KEY, JSON.stringify(valid)); }
                }
            } catch { if (live) setError("Không đọc được danh sách máy đã lưu."); }
            if (live) setReady(true);
        })();
        return () => { live = false; };
    }, []);
    // Debounce large template snapshots; polling never serializes the designer document.
    useEffect(() => {
        if (!ready || !settings.tcpHost) return;
        const timer = window.setTimeout(() => {
            setProfiles(previous => {
                const found = previous.find(p => p.host === settings.tcpHost && p.port === settings.tcpPort);
                const value = { id: found?.id || crypto.randomUUID(), host: settings.tcpHost, port: settings.tcpPort, settings };
                const next = found ? previous.map(p => p.id === found.id ? value : p) : [...previous, value];
                try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { setError("Không lưu được cấu hình máy; dữ liệu lượt in vẫn nằm ở connector."); }
                void fleetDraft(value.id, doc).catch(() => setError("Không lưu được bản nháp template."));
                return next;
            });
        }, 1000);
        return () => window.clearTimeout(timer);
    }, [settings, doc, ready]);
    useEffect(() => {
        let stopped = false, timer = 0, inFlight = false;
        const load = async () => {
            if (stopped || inFlight) return; inFlight = true; window.clearTimeout(timer);
            try { const data = await fleetRequest<{ jobs: FleetJob[] }>(settings.printAgentUrl, "spool-list"); if (!stopped) { setJobs(data.jobs); setStale(false); publishFleetSnapshot(settings.printAgentUrl, { jobs: data.jobs, stale: false }); } }
            catch { if (!stopped) { setStale(true); publishFleetSnapshot(settings.printAgentUrl); } }
            finally { inFlight = false; if (!stopped) timer = window.setTimeout(load, 1500); }
        };
        void load(); const refresh = () => void load(); window.addEventListener("zbre-fleet-refresh", refresh);
        return () => { stopped = true; window.clearTimeout(timer); window.removeEventListener("zbre-fleet-refresh", refresh); };
    }, [settings.printAgentUrl]);
    const saveAndSelect = async (target: Profile) => {
        setWorking("switch"); onSwitching(true); setError("");
        try {
            const now = current.current;
            const previous = profiles.find(p => p.host === now.settings.tcpHost && p.port === now.settings.tcpPort);
            if (previous) await fleetDraft(previous.id, now.doc);
            const next = profiles.map(p => p.id === previous?.id ? { ...p, settings: now.settings } : p);
            localStorage.setItem(KEY, JSON.stringify(next)); setProfiles(next);
            const saved = await fleetDraft(target.id);
            onSelect(target.settings, saved);
        } catch { setError("Không lưu hoặc đọc được template của máy. Vẫn giữ máy đang chọn."); }
        finally { setWorking(""); onSwitching(false); }
    };
    return <section aria-label="Printer fleet" className="shrink-0 border-b bg-background px-4 py-2 space-y-2">
        <div className="flex items-center justify-between"><strong className="text-sm">Máy in · {profiles.length}</strong><Button size="sm" variant="outline" disabled={preparing} onClick={() => setShowAdd(v => !v)}>Thêm máy in</Button></div>
        {showAdd && <form className="flex gap-2" onSubmit={async e => {
            e.preventDefault(); const ip = host.trim();
            if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split(".").some(n => Number(n) > 255)) { setError("Nhập địa chỉ IPv4 của máy in."); return; }
            if (profiles.some(p => p.host === ip && p.port === 9100)) { setError("IP này đã có trong danh sách."); return; }
            const profile: Profile = { id: crypto.randomUUID(), host: ip, port: 9100, settings: { ...settings, connectionMode: "tcp", tcpHost: ip, tcpPort: 9100, tcpExecutionMode: "connector" }, doc: structuredClone(doc) };
            const next = [...profiles, profile];
            try { await fleetDraft(profile.id, profile.doc); const prior = profiles.find(p => p.host === settings.tcpHost && p.port === settings.tcpPort); if (prior) await fleetDraft(prior.id, doc); }
            catch { setError("Không lưu được template máy in."); return; }
            delete profile.doc; try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { setError("Không lưu được danh sách máy."); return; }
            setProfiles(next); setHost(""); setShowAdd(false); setError(""); onSelect(profile.settings, structuredClone(doc));
        }}><input aria-label="New printer IP" placeholder="192.168.50.2" value={host} onChange={e => setHost(e.target.value)} className="rounded border px-2 text-sm bg-background" /><Button size="sm" type="submit">Thêm</Button></form>}
        <div className="flex gap-2 overflow-x-auto pb-1">{profiles.map(p => {
            const job = jobs.find(j => j.host === p.host && j.port === p.port), active = job && isFleetActive(job);
            const audit = job?.receipt?.capture?.audit;
            const selected = p.host === settings.tcpHost && p.port === settings.tcpPort;
            return <div key={p.id} data-testid="fleet-printer" className={`min-w-64 rounded border p-2 text-xs space-y-1 ${selected ? "border-primary bg-primary/5" : "border-border"}`}>
                <button className="font-semibold text-base text-left" disabled={preparing || !!working} onClick={() => void saveAndSelect(p)}>{p.host}{p.port !== 9100 ? `:${p.port}` : ""}{selected ? " · Đang chọn" : ""}</button>
                <div>{stale ? "Mất kết nối theo dõi" : job ? job.cancelRequested && isFleetActive(job) ? "Đang dừng…" : job.state === "printing" && job.paused ? "Tạm dừng / điều chỉnh" : fleetStatusNames[job.state] || job.state : "Sẵn sàng"}</div>
                {job && <><div>Lượt in: {job.capture?.expectedLabels.toLocaleString() ?? "—"} tem</div><div className="flex gap-5 text-sm font-semibold"><span>VALID {audit ? ((job.rollValidBefore || 0) + audit.validDelta).toLocaleString() : "—"}</span><span>VOID {audit ? ((job.rollVoidBefore || 0) + audit.voidDelta).toLocaleString() : "—"}</span></div></>}
                {job && <FleetJobControls key={job.jobId} job={job} agent={settings.printAgentUrl} stale={stale} />}
                {selected && active && <p className="text-muted-foreground">Host đang cấp tem có giới hạn. Chỉnh template áp dụng cho lượt tiếp theo.</p>}
                {job?.error && (job.state === "not_sent" ? <p role="alert" className="break-words max-w-80 text-destructive">{job.error}</p>
                    : <details><summary>Chi tiết lượt in</summary><p className="break-words max-w-80">{job.error}</p></details>)}
                {!active && !selected && job?.state !== "needs_review" && <button className="text-muted-foreground underline" onClick={() => { const next = profiles.filter(v => v.id !== p.id); localStorage.setItem(KEY, JSON.stringify(next)); setProfiles(next); }}>Ẩn máy</button>}
            </div>;
        })}</div>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </section>;
}
