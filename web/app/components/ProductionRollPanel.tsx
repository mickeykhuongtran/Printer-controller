"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { closeProductionRoll, downloadProductionRoll, findProductionOpenRoll, listProductionRolls, updateProductionRollHistory, productionRequest, productionRollCounts, productionIdentityMismatch,
    productionCounterReason, productionUnreconciledRuns, productionRunIdentity, productionTemplateContent, productionTemplateFingerprint,
    type ProductionPrintContext, type ProductionRoll, type ProductionRollResponse, type ProductionRunIdentity } from "../production-roll";
import { RollNotes } from "./RollNotes";
import type { LabelDoc } from "../types";

type Props = { agentUrl: string; busy: boolean; revision: number; doc: LabelDoc; printerHost: string; printerPort: number; recordingEnabled: boolean;
    selectedRollId: string; onSelectRoll: (rollId: string, expectedRollId?: string) => void; onContextChange: (context: ProductionPrintContext | null) => void };
const inputClass = "mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm";
const displayDate = (value?: string) => value ? new Date(value).toLocaleString(undefined, { hour12: false }) : "Chưa ghi nhận";

function RollIdentity({ roll }: { roll: ProductionRoll }) {
    return <div className="text-muted-foreground"><p>{roll.printerHost || "IP chưa ghi nhận"} · {roll.templateName}</p>
        {(roll.jobId || roll.rollNumber > 0) && <p>{roll.jobId}{roll.rollNumber > 0 ? ` · Cuộn ${roll.rollNumber}` : ""}</p>}</div>;
}
function RollEvidence({ result, history = false }: { result: ProductionRollResponse; history?: boolean }) {
    const counts = productionRollCounts(result), prefix = history ? "history-" : "";
    return <div className="space-y-2">
        <dl className="grid grid-cols-2 gap-3 text-base" aria-label="Roll counts">
            <div><dt>VALID</dt><dd className="font-semibold text-2xl" data-testid={`${prefix}roll-printer-valid`}>{counts.printerValid.toLocaleString()}</dd></div>
            <div><dt>VOID</dt><dd className="font-semibold text-2xl" data-testid={`${prefix}roll-void`}>{counts.voidCount.toLocaleString()}</dd></div>
        </dl>
        {!counts.printerValidKnown && !result.summary.activeRuns?.length && <p className="text-amber-700">Cần đối soát lượt bị gián đoạn.</p>}
        {counts.missingEpc > 0 && <p className="text-amber-700" data-testid={`${prefix}roll-epc-gap`}>Thiếu phản hồi {counts.missingEpc} EPC. Kiểm tra trước khi bàn giao cuộn.</p>}
        <details><summary className="cursor-pointer text-muted-foreground">Chi tiết đối soát</summary>
            <p>Tạo lúc {displayDate(result.roll.createdAt)} · {result.roll.runs?.length || 0} lượt</p>
            <p data-testid={`${prefix}roll-captured-epc`}>EPC đã thu: {counts.capturedEpc}</p>
            <p data-testid={`${prefix}roll-good`}>Tem đạt còn lại: {counts.goodKnown ? counts.good : "Chưa xác định"}</p>
            {productionUnreconciledRuns(result).map(run => <p key={run.runId}>{productionCounterReason(run.reason)}</p>)}
            {result.summary.blockers?.map((message, i) => <p key={i}>{message}</p>)}
            {result.roll.closeWarnings?.map((message, i) => <p key={`close-${i}`}>{message}</p>)}
        </details>
    </div>;
}

export function ProductionRollPanel({ agentUrl, busy, revision, doc, printerHost, printerPort, recordingEnabled, selectedRollId, onSelectRoll, onContextChange }: Props) {
    const [ready, setReady] = useState(false), [working, setWorking] = useState(false), [error, setError] = useState("");
    const [discoveryError, setDiscoveryError] = useState("");
    const [result, setResult] = useState<ProductionRollResponse | null>(null), [rolls, setRolls] = useState<ProductionRoll[]>([]);
    const [historyResult, setHistoryResult] = useState<ProductionRollResponse | null>(null), [historyId, setHistoryId] = useState("");
    const [historyExpanded, setHistoryExpanded] = useState(false);
    const [showClearedHistory, setShowClearedHistory] = useState(false), [historyMessage, setHistoryMessage] = useState("");
    const [jobId, setJobId] = useState(""), [rollNumber, setRollNumber] = useState("1"), [operator, setOperator] = useState(""), [closeNote, setCloseNote] = useState("");
    const [removalDraft, setRemovalDraft] = useState<{ rollId: string; good: string; rejected: string } | null>(null);
    const [identitySnapshot, setIdentitySnapshot] = useState<{ key: string; identity?: ProductionRunIdentity; error?: string } | null>(null);
    const templateContent = useMemo(() => productionTemplateContent(doc), [doc]);
    const identityKey = `${printerHost.trim().toLowerCase()}:${printerPort}:${templateContent}`;
    const discoveryKey = `${agentUrl}:${printerHost.trim().toLowerCase()}:${printerPort}:${selectedRollId}`;
    const [loadedDiscoveryKey, setLoadedDiscoveryKey] = useState("");
    useEffect(() => {
        let live = true;
        void productionTemplateFingerprint(templateContent).then(fingerprint => {
            const identity = productionRunIdentity(doc, { host: printerHost, port: printerPort }, fingerprint);
            if (live) setIdentitySnapshot({ key: identityKey, identity });
        }).catch(e => { if (live) setIdentitySnapshot({ key: identityKey, error: e instanceof Error ? e.message : String(e) }); });
        return () => { live = false; };
    }, [doc, printerHost, printerPort, identityKey, templateContent]);
    const key = `zbre.production-roll.v2:${agentUrl}:${printerHost}:${printerPort}`;
    const generation = useRef(0), refreshSequence = useRef(0);

    const refresh = useCallback(async () => {
        const gen = generation.current, sequence = ++refreshSequence.current;
        try {
            const list = await listProductionRolls(agentUrl);
            const open = findProductionOpenRoll(list.rolls || [], { host: printerHost, port: printerPort }, selectedRollId);
            const value = open ? await productionRequest(agentUrl, "roll-status", { rollId: open.rollId }) : null;
            if (generation.current !== gen || refreshSequence.current !== sequence) return;
            setRolls((list.rolls || []).filter(item => !item.printerHost || item.printerHost === printerHost && item.printerPort === printerPort)); setResult(value); setDiscoveryError(""); setLoadedDiscoveryKey(discoveryKey);
            setHistoryId(current => list.rolls?.some(item => item.rollId === current) ? current : "");
            setHistoryResult(current => current && list.rolls?.some(item => item.rollId === current.roll.rollId) ? current : null);
            // Do not clear a newer selection made while this request was in flight.
            if (selectedRollId && !list.rolls?.some(item => item.rollId === selectedRollId && item.state === "open")) onSelectRoll("", selectedRollId);
        } catch (e) {
            if (generation.current === gen && refreshSequence.current === sequence) setDiscoveryError(e instanceof Error ? e.message : String(e));
            throw e;
        }
    }, [agentUrl, printerHost, printerPort, selectedRollId, discoveryKey, onSelectRoll]);

    useEffect(() => {
        const gen = ++generation.current;
        void Promise.resolve().then(() => {
            if (generation.current !== gen) return;
            let saved: { operator?: string; jobId?: string; rollNumber?: string | number } = {};
            try { saved = JSON.parse(localStorage.getItem(key) || "{}"); } catch { /* The connector keeps the evidence. */ }
            setOperator(saved.operator || ""); setJobId(saved.jobId || ""); setRollNumber(String(saved.rollNumber || 1));
            // Previously persisted rollId is intentionally not resumed after a restart.
            setReady(true);
        });
        return () => { generation.current = gen + 1; };
    }, [key]);
    useEffect(() => {
        if (!ready) return;
        try { localStorage.setItem(key, JSON.stringify({ jobId, rollNumber, operator })); } catch { /* The connector retains every captured record. */ }
    }, [ready, key, operator, jobId, rollNumber]);
    useEffect(() => {
        if (!ready) return;
        let stopped = false, inFlight = false, timer = 0;
        const load = async () => {
            if (stopped || inFlight) return;
            inFlight = true; window.clearTimeout(timer);
            try { await refresh(); } catch { /* refresh publishes the error. */ }
            finally { inFlight = false; if (!stopped) timer = window.setTimeout(load, 5000); }
        };
        void load(); const update = () => void load(); window.addEventListener("zbre-fleet-refresh", update);
        return () => { stopped = true; window.clearTimeout(timer); window.removeEventListener("zbre-fleet-refresh", update); };
    }, [ready, busy, revision, refresh]);

    const roll = result?.roll, summary = result?.summary;
    const active = roll?.state === "open" && roll.rollId === selectedRollId;
    const writesEpc = roll?.operationMode === "write" || roll?.operationMode === "read_write";
    const counts = productionRollCounts(result);
    const identityReady = identitySnapshot?.key === identityKey;
    const identityReason = identityReady ? identitySnapshot.error || productionIdentityMismatch(roll, identitySnapshot.identity) : "Đang kiểm tra cấu hình cuộn.";
    const reason = discoveryError ? "Chưa đọc được lịch sử cuộn. Nhấn Tải lại; chưa gửi lệnh in."
        : !ready || loadedDiscoveryKey !== discoveryKey ? "Đang đọc lịch sử cuộn trước khi gửi lệnh in."
        : working ? "Đang lưu dữ liệu cuộn."
        : summary?.activeRuns?.length ? "Máy đang xử lý lượt in. Theo dõi hoặc dừng lượt tại bảng máy in."
        : roll?.state === "open" && !active ? "Còn hồ sơ cuộn cũ đang mở. Chọn tiếp tục cuộn cũ hoặc đóng cuộn để bắt đầu lô mới."
        : active || recordingEnabled ? identityReason : "";
    const removedInput = removalDraft && removalDraft.rollId === roll?.rollId ? removalDraft.good : counts.removalReviewRequired ? "" : String(counts.removed);
    const rejectedInput = removalDraft && removalDraft.rollId === roll?.rollId ? removalDraft.rejected : counts.removalReviewRequired ? "" : String(counts.removedRejected);
    const removedValue = Number(removedInput), rejectedValue = writesEpc ? Number(rejectedInput) : 0;
    const removalDirty = counts.removalReviewRequired || removedInput.trim() === "" || removedValue !== counts.removed
        || (writesEpc && (rejectedInput.trim() === "" || rejectedValue !== counts.removedRejected));
    const hasUnsavedRemovals = removalDraft?.rollId === roll?.rollId && removalDirty;
    const removalValid = removedInput.trim() !== "" && Number.isSafeInteger(removedValue) && removedValue >= 0 && removedValue <= counts.removableGood
        && (!writesEpc || (rejectedInput.trim() !== "" && Number.isSafeInteger(rejectedValue) && rejectedValue >= 0 && rejectedValue <= counts.removableRejected));
    const context = useMemo<ProductionPrintContext>(() => ({
        enabled: recordingEnabled || active, blocked: !!reason, reason,
        remaining: counts.goodKnown ? Math.max(0, (roll?.targetLabels ?? 2500) - counts.good) : undefined, rollId: active ? roll.rollId : undefined,
        hasCapturedRuns: active && !!roll.runs?.length,
    }), [reason, recordingEnabled, active, roll?.rollId, roll?.targetLabels, roll?.runs?.length, counts.good, counts.goodKnown]);
    useEffect(() => { onContextChange(context); }, [context, onContextChange]);
    useEffect(() => () => onContextChange(null), [onContextChange]);

    const operate = async (action: () => Promise<void>) => {
        if (working || busy) return;
        setWorking(true); setError("");
        try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setWorking(false); }
    };
    const closeRoll = async (target: ProductionRollResponse) => {
        if (hasUnsavedRemovals && removalDraft?.rollId === target.roll.rollId) throw new Error("Lưu số tem loại vừa nhập trước khi đóng cuộn.");
        ++refreshSequence.current;
        const closed = await closeProductionRoll(agentUrl, target.roll.rollId, { closedBy: operator.trim() || undefined, note: closeNote.trim() || undefined });
        // Unbind immediately only after the connector durably confirms closure.
        if (selectedRollId === target.roll.rollId) onSelectRoll("", target.roll.rollId);
        setResult(current => current?.roll.rollId === target.roll.rollId ? null : current);
        setRolls(current => current.map(item => item.rollId === closed.roll.rollId ? closed.roll : item));
        setHistoryId(closed.roll.rollId); setHistoryResult(closed); setHistoryExpanded(true); setRemovalDraft(null); setCloseNote("");
        await refresh();
    };
    const inspectHistory = async () => {
        const value = await productionRequest(agentUrl, "roll-get", { rollId: historyId });
        setHistoryResult(value);
        setJobId(value.roll.jobId || ""); setRollNumber(String(value.roll.rollNumber || 1));
        if (value.roll.operator) setOperator(value.roll.operator);
    };
    const exportRoll = async () => {
        if (!historyResult || historyResult.roll.state === "open") return;
        const exported = await downloadProductionRoll(agentUrl, historyResult, historyResult.exportFileName ? undefined
            : { operator: operator.trim(), jobId: jobId.trim(), rollNumber: Number(rollNumber) });
        setHistoryResult(exported); await refresh();
    };
    const changeHistory = async (ids: string[], clear = true) => {
        ++refreshSequence.current;
        setHistoryMessage("");
        try {
            const updated = await updateProductionRollHistory(agentUrl, ids, clear);
            if (clear) setShowClearedHistory(false);
            setHistoryId(""); setHistoryResult(null);
            setHistoryMessage(`${clear ? "Đã clear" : "Đã khôi phục"} ${updated.updatedRollIds.length} hồ sơ cuộn.`);
        } finally {
            // Refresh even after a failed batch so any committed records are reflected.
            await refresh();
        }
    };
    const clearedCount = rolls.filter(item => !!item.historyClearedAt).length;
    const visibleHistory = rolls.filter(item => showClearedHistory || !item.historyClearedAt);
    const clearableIds = rolls.filter(item => item.state !== "open" && !item.historyClearedAt).map(item => item.rollId);
    const selectedHistory = visibleHistory.find(item => item.rollId === historyId);
    const selectedHistoryResult = selectedHistory ? historyResult : null;
    const historical = selectedHistoryResult?.roll;
    const canExport = historyResult && historical && historical.state !== "open" && !busy && !working
        && (!!historyResult.exportFileName || (!!operator.trim() && !!jobId.trim() && Number.isSafeInteger(Number(rollNumber)) && Number(rollNumber) > 0));

    return <section className="rounded border border-border p-3 space-y-3 text-xs" aria-label="Production roll">
        <div className="flex items-center justify-between gap-2">
            <p className="font-semibold text-sm">Dữ liệu cuộn</p>
            <Button size="sm" variant="outline" disabled={busy || working || !ready} onClick={() => void operate(refresh)}>Tải lại hồ sơ</Button>
        </div>
        {(!ready || loadedDiscoveryKey !== discoveryKey) && <p role="status">Đang đọc lịch sử cuộn…</p>}
        {discoveryError && <p role="alert" className="break-words text-destructive">Không đọc được lịch sử cuộn: {discoveryError}. Nhấn Tải lại trước khi in.</p>}
        {roll?.state === "open" && result ? <div className="space-y-3" aria-live="polite">
            <p className="font-medium">{summary?.activeRuns?.length ? "Đang in" : active ? "Cuộn đang mở" : "Cuộn chưa đóng"}</p>
            <RollIdentity roll={roll} />
            <RollEvidence result={result} />
            <RollNotes key={roll.rollId} agentUrl={agentUrl} rollId={roll.rollId} onSaved={refresh} />
            {!active && <p>Đây là hồ sơ trên máy tính. Chọn tiếp tục chỉ khi vẫn đang làm đúng cuộn và lô này.</p>}
            {!active && <Button size="sm" variant="outline" disabled={busy || working || !!identityReason || !!summary?.activeRuns?.length}
                onClick={() => { onSelectRoll(roll.rollId); setError(""); }}>Tiếp tục cuộn cũ</Button>}
            {!active && identityReason && <p className="text-amber-700 dark:text-amber-300">{identityReason}</p>}
            {!!roll.runs?.length && <details className="space-y-2" open={counts.removalReviewRequired || undefined}>
                <summary className="cursor-pointer">Tem đã loại</summary>
                {counts.removalReviewRequired && <p className="text-amber-700 dark:text-amber-300">Cuộn cũ: nhập lại số tem loại theo hai nhóm nếu đã đối soát. Vẫn có thể đóng cuộn với dữ liệu chưa đủ.</p>}
                <label className="block">Tổng tem đạt đã loại<input aria-label="Removed good labels" className={inputClass} type="number" min="0" step="1" max={counts.removableGood}
                    value={removedInput} disabled={busy || working} onChange={e => setRemovalDraft({ rollId: roll.rollId, good: e.target.value, rejected: rejectedInput })} /></label>
                {writesEpc && <label className="block">Tổng tem lỗi ghi đã loại<input aria-label="Removed rejected labels" className={inputClass} type="number" min="0" step="1" max={counts.removableRejected}
                    value={rejectedInput} disabled={busy || working} onChange={e => setRemovalDraft({ rollId: roll.rollId, good: removedInput, rejected: e.target.value })} /></label>}
                <Button size="sm" variant="outline" disabled={busy || working || !removalDirty || !removalValid || !!summary?.activeRuns?.length} onClick={() => void operate(async () => {
                    setResult(await productionRequest(agentUrl, "roll-adjust", { rollId: roll.rollId, removedGoodCount: removedValue, removedRejectedCount: rejectedValue })); setRemovalDraft(null);
                })}>Lưu số tem loại</Button>
                {hasUnsavedRemovals && <p className="text-amber-700 dark:text-amber-300">Lưu số tem loại vừa nhập trước khi đóng cuộn.</p>}
            </details>}
            <label className="block">Ghi chú đóng cuộn (không bắt buộc)<input aria-label="Roll close note" className={inputClass} value={closeNote} disabled={busy || working} onChange={e => setCloseNote(e.target.value)} /></label>
            <Button size="sm" disabled={busy || working || hasUnsavedRemovals || !!summary?.activeRuns?.length} onClick={() => void operate(() => closeRoll(result))}>Đóng cuộn</Button>
            <p className="text-muted-foreground">Có thể in tiếp hoặc in bù cùng cuộn. Chỉ đóng khi đã kết thúc cuộn thực tế.</p>
        </div> : loadedDiscoveryKey === discoveryKey && !discoveryError && <p>Sẵn sàng bắt đầu lô mới. {recordingEnabled ? "Hồ sơ cuộn được tạo khi bắt đầu in." : "Bật lưu dữ liệu nếu cần lưu EPC và xuất CSV cho lô mới."}</p>}
        <details className="space-y-3" open={historyExpanded} onToggle={event => setHistoryExpanded(event.currentTarget.open)}>
            <summary className="cursor-pointer font-semibold">Lịch sử cuộn / xuất CSV</summary>
            <p className="text-muted-foreground">Clear dọn cuộn đã đóng khỏi danh sách. Dữ liệu EPC/CSV được giữ và có thể xem lại hoặc khôi phục bên dưới.</p>
            {(clearedCount > 0 || showClearedHistory) && <label className="flex items-center gap-2"><input type="checkbox" aria-label="Show cleared roll history" checked={showClearedHistory} disabled={busy || working}
                onChange={e => { setShowClearedHistory(e.target.checked); setHistoryId(""); setHistoryResult(null); }} />Hiện cuộn đã clear ({clearedCount})</label>}
            <select aria-label="Production roll history" className={inputClass} disabled={busy || working || !visibleHistory.length} value={selectedHistory?.rollId || ""} onChange={e => { setHistoryId(e.target.value); setHistoryResult(null); setHistoryExpanded(true); setHistoryMessage(""); }}>
                <option value="">Chọn hồ sơ cuộn</option>
                {visibleHistory.map(item => <option key={item.rollId} value={item.rollId}>{item.historyClearedAt ? "[Đã clear] " : ""}{item.jobId || item.templateName || item.rollId} · {displayDate(item.createdAt)} · {item.state === "open" ? "Đang mở" : item.exportedAt || item.state === "finalized" ? "Đã xuất CSV" : "Đã đóng, chưa xuất CSV"}</option>)}
            </select>
            {!visibleHistory.length && <p>Danh sách lịch sử cuộn trống.</p>}
            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={busy || working || !selectedHistory} onClick={() => void operate(inspectHistory)}>Xem dữ liệu cuộn</Button>
                <Button size="sm" variant="outline" disabled={busy || working || !selectedHistory || selectedHistory.state === "open"}
                    onClick={() => selectedHistory && void operate(() => changeHistory([selectedHistory.rollId], !selectedHistory.historyClearedAt))}>{selectedHistory?.historyClearedAt ? "Khôi phục cuộn đã chọn" : "Clear cuộn đã chọn"}</Button>
                <Button size="sm" variant="outline" disabled={busy || working || !clearableIds.length}
                    onClick={() => void operate(() => changeHistory(clearableIds))}>Clear toàn bộ cuộn đã đóng ({clearableIds.length})</Button>
            </div>
            {selectedHistory?.state === "open" && <p className="text-muted-foreground">Đóng cuộn trước khi clear lịch sử.</p>}
            {historyMessage && <p role="status">{historyMessage}</p>}
            {historical && historyResult && <div className="space-y-3 rounded border border-border p-2" aria-label="Historical production roll">
                <RollIdentity roll={historical} />
                <p>{historical.state === "open" ? "Hồ sơ đang mở" : `Đã đóng lúc ${displayDate(historical.closedAt || historical.finalizedAt)}`}</p>
                {historical.closeNote && <p>Ghi chú: {historical.closeNote}</p>}
                <RollEvidence result={historyResult} history />
                {historical.state === "open" ? <>
                    <p>Đóng hồ sơ này để xuất CSV. Thao tác xem lịch sử không chọn cuộn để in tiếp.</p>
                    {historical.rollId !== roll?.rollId && <Button size="sm" disabled={busy || working || !!historyResult.summary?.activeRuns?.length}
                        onClick={() => void operate(() => closeRoll(historyResult))}>Đóng hồ sơ cuộn này</Button>}
                </> : <>
                    {!historyResult.exportFileName ? <>
                        <p>Xuất CSV bất kỳ lúc nào từ hồ sơ đã đóng. Thông tin dưới đây được lưu vào bản xuất đầu tiên.</p>
                        <label className="block">Tên người vận hành<input aria-label="Production operator" className={inputClass} value={operator} disabled={busy || working} onChange={e => setOperator(e.target.value)} /></label>
                        <label className="block">Job ID<input aria-label="Production Job ID" className={inputClass} value={jobId} disabled={busy || working} onChange={e => setJobId(e.target.value)} /></label>
                        <label className="block">Thứ tự cuộn<input aria-label="Production roll number" className={inputClass} type="number" min="1" step="1" value={rollNumber} disabled={busy || working} onChange={e => setRollNumber(e.target.value)} /></label>
                    </> : <p className="break-words">File đã lưu: {historyResult.exportFileName}. Tải lại giữ nguyên nội dung bản xuất.</p>}
                    <Button size="sm" disabled={!canExport} onClick={() => void operate(exportRoll)}>{historyResult.exportFileName ? "Tải lại CSV" : "Xuất CSV"}</Button>
                </>}
            </div>}
        </details>
        {error && <p role="alert" className="break-words text-destructive">{error}</p>}
    </section>;
}
