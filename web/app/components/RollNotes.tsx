"use client";
import { useState } from "react";
import { productionRequest, type ProductionRow } from "../production-roll";
import { Button } from "@/components/ui/button";

export function RollNotes({ agentUrl, rollId, onSaved }: { agentUrl: string; rollId: string; onSaved: () => Promise<void> }) {
    const [rows, setRows] = useState<ProductionRow[]>([]), [selected, setSelected] = useState<string[]>([]);
    const [note, setNote] = useState(""), [incident, setIncident] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
    const [page, setPage] = useState(0), [requestId, setRequestId] = useState("");
    const load = async () => {
        setBusy(true); setError("");
        try { const value = await productionRequest(agentUrl, "roll-get", { rollId }); setRows(value.rows); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
    };
    const apply = async () => {
        setBusy(true); setError("");
        const id = requestId || crypto.randomUUID(); setRequestId(id);
        try {
            const value = await productionRequest(agentUrl, "roll-note", { rollId, noteId: id, recordIds: selected, note, incident });
            setRows(value.rows); setNote(""); setSelected([]); setRequestId("");
            await onSaved();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setBusy(false); }
    };
    return <details className="space-y-2" onToggle={e => { if (e.currentTarget.open && rows.length === 0 && !busy) void load(); }}>
        <summary className="cursor-pointer font-medium">Ghi chú dòng / sự cố</summary>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>Tải dòng mới</Button><span>{rows.length} dòng · chọn {selected.length}</span></div>
        <div className="max-h-64 overflow-auto"><table className="w-full text-left"><thead><tr><th>Chọn</th><th>Dòng</th><th>EPC / kết quả</th></tr></thead><tbody>
            {rows.slice(page * 50, page * 50 + 50).map(row => <tr key={row.recordId} className="border-b">
                <td><input type="checkbox" aria-label={`Note row ${row.rollOrdinal}`} checked={selected.includes(row.recordId)} disabled={busy} onChange={e => { setSelected(v => e.target.checked ? [...v, row.recordId] : v.filter(id => id !== row.recordId)); setRequestId(""); }} /></td>
                <td>{row.rollOrdinal}</td><td className="break-all">{row.epc || "Chưa có EPC"}<div className="text-muted-foreground">{row.result}{row.notes?.length ? ` · ${row.notes.join(" · ")}` : ""}</div></td>
            </tr>)}
        </tbody></table></div>
        <div className="flex items-center gap-2"><Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(v => v - 1)}>Trước</Button><span>{page + 1} / {Math.max(1, Math.ceil(rows.length / 50))}</span><Button size="sm" variant="outline" disabled={(page + 1) * 50 >= rows.length} onClick={() => setPage(v => v + 1)}>Sau</Button></div>
        <label className="flex items-center gap-2"><input type="checkbox" checked={incident} disabled={busy} onChange={e => { setIncident(e.target.checked); setRequestId(""); }} />Sự cố gần dòng đã chọn · không xác định EPC bị mất</label>
        <input aria-label="Row note" maxLength={240} value={note} disabled={busy} placeholder="Ví dụ: chỉnh lệch giấy, bỏ khoảng 3 tem" className="w-full rounded border bg-background px-2 py-1.5" onChange={e => { setNote(e.target.value); setRequestId(""); }} />
        <Button size="sm" disabled={busy || !note.trim() || (!incident && !selected.length)} onClick={() => void apply()}>Áp dụng ghi chú</Button>
        {error && <p role="alert" className="text-destructive">{error}</p>}
    </details>;
}
