"use client";

import type { LabelDoc } from "./types";
import type { RfidCaptureSummary } from "./rfid-capture";
import { fetchLocalAgentJson } from "./local-print-agent";
import { hasUserDataRows } from "./label-data";

export type ProductionPrintContext = {
    enabled: boolean; blocked: boolean; reason: string; remaining?: number;
    hasCapturedRuns?: boolean;
    rollId?: string; templateFingerprint?: string; sourceRollId?: string; materialLot?: string; operator?: string;
};
export type ProductionReview = { verified: boolean; operator: string; note: string; excludedOrdinals: number[]; at: string };
export type ProductionOperationMode = "read" | "write" | "read_write";
export type ProductionRunIdentity = {
    printerHost: string; printerPort: number; operationMode: ProductionOperationMode; bank: "EPC" | "TID"; templateFingerprint: string;
};
export type ProductionRoll = {
    historyClearedAt?: string;
    jobId: string; rollId: string; rollNumber: number; targetLabels: number; operator: string;
    templateName: string; templateFingerprint: string; materialLot: string; kind: string; reference?: string;
    createdAt: string; state: "open" | "closed" | "finalized"; revision: number; countersResetConfirmed?: boolean;
    runs: { runId: string; sourceRollId: string; materialLot: string; registeredAt: string; review?: ProductionReview }[];
    finalizedAt?: string; finalizedBy?: string; physicalGoodCount?: number; orientation?: "forward" | "reverse";
    closedAt?: string; closedBy?: string; closeWarnings?: string[]; exportedAt?: string; exportedBy?: string;
    printerValidCount?: number; printerVoidCount?: number; retainedVoidCount?: number; externalTestVoidCount?: number; qcMethod?: string; closeNote?: string;
    printerHost?: string; printerPort?: number; operationMode?: ProductionOperationMode; bank?: "EPC" | "TID"; removedValidCount?: number;
    removedGoodCount?: number; removedRejectedCount?: number; removalAccountingVersion?: number;
};
export type ProductionRow = {
    recordId: string; notes?: string[]; runId: string; runOrdinal: number; sourceRow: number; epc: string; receivedAt: string; result: string;
    disposition: "retained" | "excluded" | "unresolved"; rollOrdinal: number; reason: string; sourceRollId: string; materialLot: string;
};
export type ProductionMachineCounterSnapshot = {
    runId: string; at: string; valid: number; void: number; total: number;
    source: "stored_session_snapshot"; live: false;
};
export type ProductionUnreconciledRun = {
    runId: string; registeredAt: string; state: string; reason: string; detail?: string;
    expectedLabels: number; capturedEpcCount: number; capturedReadbackCount: number;
    lastSnapshotAt?: string; observedValidCount: number; observedVoidCount: number; observedCountsAvailable?: boolean;
};
export type ProductionNotSentRun = { runId: string; registeredAt: string; reason: string; detail?: string; requestedLabels: number };
export type ProductionRollResponse = {
    ok: boolean; roll: ProductionRoll; exportFileName?: string; rows: ProductionRow[];
    summary: {
        machineCounterSnapshot?: ProductionMachineCounterSnapshot;
        unreconciledRuns?: ProductionUnreconciledRun[];
        notSentRuns?: ProductionNotSentRun[];
        validCount?: number; voidCount?: number; totalCount?: number; countsComplete?: boolean;
        printerValidCount?: number; printerValidKnown?: boolean; capturedEpcCount?: number; capturedReadbackCount?: number;
        removedValidCount?: number; goodCount?: number; goodCountKnown?: boolean; missingEpcCount?: number;
        removedGoodCount?: number; removedRejectedCount?: number; removalAccountingVersion?: number; removalReviewRequired?: boolean;
        removableGoodCount?: number; removableRejectedCount?: number;
        writeVerificationIssues?: number; writeMismatchCount?: number; writeUnverifiedCount?: number;
        retainedCount: number; excludedCount: number; duplicateEpcs: string[]; duplicateSourceRows?: number[];
        conflictingRollIds?: string[]; unresolvedRecords: number; activeRuns: string[]; unreviewedRuns: string[];
        unknownVoidRuns: string[]; voidTotalKnown: number; canFinalize: boolean; blockers: string[];
    };
};

export function productionCounterReason(reason: string): string {
    const reasons: Record<string, string> = {
        run_active: "Lượt in đang chạy; chưa đến bước chốt số đếm.",
        stopped_before_payload: "Lượt đã dừng trước khi gửi tem.",
        baseline_missing: "Thiếu bộ số đếm đầu lượt; không thể tính số lượng thuộc lượt này.",
        baseline_unverified: "Chưa xác nhận máy hết hàng đợi và counter đầu lượt; chưa thể xác thực số lượng thuộc lượt.",
        final_snapshot_missing: "Thiếu bộ số đếm cuối lượt; EPC đã lưu vẫn được giữ nguyên.",
        counter_sample_failed: "Máy không trả đủ bộ số đếm hợp lệ; số cuối chưa được xác nhận.",
        socket_lost: "Mất kết nối trước khi chốt số đếm. Không thể gán số hiện tại của máy cho lượt cũ.",
        tcp_job_socket_lost: "Mất kết nối trước khi chốt số đếm. Không thể gán số hiện tại của máy cho lượt cũ.",
        tcp_job_query_read_failed: "Mất hoặc lỗi kết nối khi đọc phản hồi counter/trạng thái máy; chưa xác nhận số đếm cuối.",
        rfid_capture_query_failed: "Không đọc được phản hồi trạng thái/counter trên kết nối thu RFID. EPC đã lưu vẫn được giữ; chưa xác nhận số đếm cuối.",
        tcp_job_query_timeout: "Quá thời gian chờ phản hồi từ máy; bộ số đếm cuối chưa được xác nhận.",
        tcp_job_query_write_failed: "Không gửi được truy vấn trạng thái/counter; chưa xác nhận số đếm cuối.",
        tcp_job_query_write_zero: "Máy không nhận truy vấn trạng thái/counter; chưa xác nhận số đếm cuối.",
        tcp_job_query_write_timeout: "Quá thời gian gửi truy vấn trạng thái/counter; chưa xác nhận số đếm cuối.",
        tcp_job_query_finalization_failed: "Chốt số đếm cuối thất bại. EPC và các bộ counter đã đọc vẫn được lưu.",
        drain_timeout: "Chưa xác nhận máy xử lý hết hàng đợi trong thời gian chờ.",
        counter_reset: "Counter đã giảm hoặc bị reset giữa lượt; không thể suy ra số lượng của lượt.",
        cancelled: "Lượt đã dừng nhưng chưa đủ bằng chứng chốt số đếm.",
        session_aborted: "Phiên đã dừng trước khi lưu đủ bằng chứng chốt số đếm.",
        session_cancelled: "Phiên đã hủy nhưng chưa đủ bằng chứng xác nhận số đếm cuối.",
        session_failed: "Phiên kết thúc có lỗi trước khi lưu đủ bằng chứng chốt số đếm.",
        connector_stopped: "Connector dừng trước khi lưu bằng chứng chốt số đếm.",
        idle_expired: "Phiên hết thời gian chờ trước khi chốt số đếm; dữ liệu đã thu vẫn được giữ nguyên.",
        submitted_formats_unverified: "Chưa xác minh đầy đủ số tem trong dữ liệu đã gửi; không gán counter máy thành số cuộn.",
        counter_attribution_conflict: "Counter máy không khớp số tem đã gửi hoặc phản hồi đã lưu; cần đối soát tem thực tế.",
        run_interrupted: "Lượt bị gián đoạn; chưa xác nhận số đếm cuối.",
        legacy_counters_not_recorded: "Hồ sơ cũ chỉ lưu phản hồi RFID, không có số đếm đầu–cuối.",
        evidence_unavailable: "Không đọc được hồ sơ của lượt. Cần khôi phục dữ liệu gốc trước khi đối soát.",
        evidence_corrupt: "Dữ liệu gốc bị thiếu hoặc không hợp lệ; chưa thể xác thực số lượng.",
        roll_identity_mismatch: "Mã cuộn của lượt không khớp hồ sơ; cần kiểm tra dữ liệu gốc.",
        counter_totals_unverified: "Số đếm chưa khớp bằng chứng của lượt; cần đối soát tem thực tế.",
    };
    return reasons[reason] || "Chưa có đủ bằng chứng chốt số đếm; xem chi tiết kỹ thuật của lượt.";
}

/** Physical counter finality and RFID readback quality are separate outcomes. */
export function productionCaptureWarnings(capture: RfidCaptureSummary): string[] {
    const warnings: string[] = [], audit = capture.audit, bank = capture.options.bank;
    if (audit?.finalizationStatus !== "verified") {
        warnings.push(`Đã lưu ${capture.uniqueLabels} ${bank} đọc/ghi thành công. Counter chưa chốt: ${productionCounterReason(audit?.finalizationReason || "counter_totals_unverified")} Xem Lượt chưa đối soát trước khi tính in bù.`);
    } else if (audit.countsKnown && audit.validDelta > capture.uniqueLabels) {
        const gap = audit.validDelta - capture.uniqueLabels;
        warnings.push(capture.options.operationMode && capture.options.operationMode !== "read"
            ? `Có ${gap} kết quả VALID chưa có EPC ghi đúng được xác minh. Xem lỗi ghi và phản hồi đã lưu trước khi in bù.`
            : `Thiếu ${gap} ${bank} đọc thành công so với VALID đã xác nhận. Số đếm máy đã chốt; kiểm tra dữ liệu phản hồi trước khi in bù.`);
    }
    if (capture.issues > 0) warnings.push(`Có ${capture.issues} vấn đề trong phản hồi RFID đã lưu; xem dữ liệu lượt để kiểm tra lỗi ghi, trùng hoặc sai thứ tự.`);
    if (capture.error) warnings.push(`Dữ liệu phản hồi cần kiểm tra: ${capture.error}`);
    if (capture.state === "incomplete" && !warnings.length) warnings.push("Hồ sơ phản hồi chưa hoàn tất; xem chi tiết lượt đã lưu.");
    return warnings;
}

export function productionUnreconciledRuns(result: ProductionRollResponse): ProductionUnreconciledRun[] {
    if (result.summary.unreconciledRuns) return result.summary.unreconciledRuns;
    // Older saved reports may identify missing runs without diagnostics. Keep
    // those identities visible, without reconstructing counts from EPC rows.
    return [...new Set(result.summary.unknownVoidRuns || [])].map(runId => ({
        runId, registeredAt: result.roll.runs.find(run => run.runId === runId)?.registeredAt || "",
        state: "unknown", reason: "final_snapshot_missing", expectedLabels: 0,
        capturedEpcCount: 0, capturedReadbackCount: 0, observedValidCount: 0, observedVoidCount: 0,
    }));
}

export function productionRequest(agentUrl: string, action: string, production: Record<string, unknown> = {}): Promise<ProductionRollResponse> {
    return fetchLocalAgentJson(agentUrl, "/v1/tcp/job", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, production }),
    }, { timeoutMs: 60_000 });
}
export function listProductionRolls(agentUrl: string): Promise<{ rolls: ProductionRoll[] }> {
    return fetchLocalAgentJson(agentUrl, "/v1/tcp/job", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "roll-list", production: {} }),
    }, { timeoutMs: 60_000 });
}

export function updateProductionRollHistory(agentUrl: string, rollIds: string[], clear = true): Promise<{ ok: boolean; updatedRollIds: string[] }> {
    return fetchLocalAgentJson(agentUrl, "/v1/tcp/job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: clear ? "roll-history-clear" : "roll-history-restore", production: { rollIds } }),
    }, { timeoutMs: 60_000 });
}

function canonical(value: unknown): string {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).filter(key => object[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(",")}}`;
}
export function productionTemplateContent(doc: LabelDoc): string {
    const settings = { ...doc.settings, copies: 1, rfid: { ...doc.settings.rfid, captureToHost: true } };
    // Editor-only row IDs/default rows change when legacy templates are reopened.
    // Preserve the ordered print data and column semantics, not UI identity/width.
    const dataFeed = hasUserDataRows(doc) ? {
        columns: doc.dataFeed!.columns.map(({ name, formula, format, system }) => ({ name, formula, format, system })),
        rows: doc.dataFeed!.rows.map(row => doc.dataFeed!.columns.map(column => row.cells[column.id] ?? "")),
    } : undefined;
    return canonical({ name: doc.name, settings, elements: doc.elements,
        templateFields: doc.templateFields?.map(({ name, value }) => ({ name, value })), dataFeed });
}
export async function productionTemplateFingerprint(content: string): Promise<string> {
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)));
    return Array.from(hash, value => value.toString(16).padStart(2, "0")).join("");
}

export function parseExcludedOrdinals(value: string, allowed: ReadonlySet<number>): number[] {
    const result = new Set<number>();
    for (const part of value.split(/[,;\s]+/).filter(Boolean)) {
        const match = /^(\d+)(?:-(\d+))?$/.exec(part);
        if (!match) throw new Error(`Dòng loại không hợp lệ: ${part}. Nhập 1, 5, 10-12.`);
        const from = Number(match[1]), to = Number(match[2] ?? match[1]);
        if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from > 100_000) throw new Error("Khoảng dòng loại không hợp lệ.");
        for (let n = from; n <= to; n++) {
            if (!allowed.has(n)) throw new Error(`Dòng ${n} không có trong phản hồi của lần in đã chọn.`);
            result.add(n);
        }
    }
    return Array.from(result).sort((a, b) => a - b);
}

export type ProductionExportMetadata = { operator: string; jobId: string; rollNumber: number };

export function productionOperationMode(doc: LabelDoc): ProductionOperationMode {
    return doc.settings.rfid.enabled ? (doc.settings.rfid.readEnabled ? "read_write" : "write") : "read";
}

export function normalizeProductionPrinterHost(value: string): string {
    const host = value.trim().replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
    if (!host.includes(":")) return host;
    try { return new URL(`http://[${host}]/`).hostname.replace(/^\[|\]$/g, ""); }
    catch { return host; }
}

export function productionRunIdentity(doc: LabelDoc, printer: { host: string; port: number }, templateFingerprint: string): ProductionRunIdentity {
    if (!printer.host.trim() || !Number.isSafeInteger(printer.port) || printer.port < 1 || printer.port > 65535) throw new Error("Máy in TCP/IP chưa hợp lệ.");
    return { printerHost: normalizeProductionPrinterHost(printer.host), printerPort: printer.port, templateFingerprint,
        operationMode: productionOperationMode(doc), bank: doc.settings.rfid.enabled ? "EPC" : doc.settings.rfid.readBank ?? "EPC" };
}

/** Refuse mixed roll contents without creating a second roll or changing the draft. */
export function productionIdentityMismatch(roll: ProductionRoll | undefined, identity: ProductionRunIdentity | undefined): string {
    if (!roll || roll.state !== "open" || !roll.runs?.length || !identity) return "";
    const changed = roll.printerHost && (normalizeProductionPrinterHost(roll.printerHost) !== normalizeProductionPrinterHost(identity.printerHost) || roll.printerPort !== identity.printerPort) ? "máy in"
        : roll.operationMode && roll.operationMode !== identity.operationMode ? "chế độ đọc/ghi"
        : roll.bank && roll.bank !== identity.bank ? "bank RFID"
        : "";
    return changed ? `Đã đổi ${changed}. Đóng cuộn hiện tại để bắt đầu lô mới, hoặc khôi phục cấu hình của cuộn để tiếp tục.` : "";
}

/** Discovery never authorizes resuming a saved roll; only an explicit selection does. */
export function findProductionOpenRoll(rolls: ProductionRoll[], printer: { host: string; port: number }, selectedRollId?: string): ProductionRoll | undefined {
    const selected = rolls.find(roll => roll.state === "open" && roll.rollId === selectedRollId && (!roll.printerHost || normalizeProductionPrinterHost(roll.printerHost) === normalizeProductionPrinterHost(printer.host) && roll.printerPort === printer.port));
    if (selected) return selected;
    return rolls.find(roll => roll.state === "open" && !!roll.printerHost
        && normalizeProductionPrinterHost(roll.printerHost) === normalizeProductionPrinterHost(printer.host) && roll.printerPort === printer.port)
        || rolls.find(roll => roll.state === "open" && !roll.printerHost);
}

export async function closeProductionRoll(agentUrl: string, rollId: string, options: { closedBy?: string; note?: string } = {}): Promise<ProductionRollResponse> {
    const result = await productionRequest(agentUrl, "roll-close", { rollId, ...options });
    if (result.roll.state === "open") throw new Error("Chưa đóng được cuộn. Hồ sơ vẫn đang mở; hãy tải lại trước khi bắt đầu lô mới.");
    return result;
}

/** Native VALID and captured EPCs are separate evidence; neither substitutes for the other. */
export function productionRollCounts(result: ProductionRollResponse | null) {
    const summary = result?.summary;
    const printerValid = summary?.printerValidCount ?? summary?.validCount ?? 0;
    const printerValidKnown = summary?.printerValidKnown ?? summary?.countsComplete ?? false;
    const capturedEpc = summary?.capturedEpcCount ?? (result?.roll.bank !== "TID" ? summary?.retainedCount ?? 0 : 0);
    const capturedReadback = summary?.capturedReadbackCount ?? capturedEpc;
    const writesEpc = !!result?.roll.operationMode && result.roll.operationMode !== "read";
    const legacyRemoved = summary?.removedValidCount ?? result?.roll.removedValidCount ?? 0;
    const removalVersion = summary?.removalAccountingVersion ?? result?.roll.removalAccountingVersion ?? 0;
    const removalReviewRequired = summary?.removalReviewRequired ?? (writesEpc && removalVersion < 2 && legacyRemoved > 0);
    const removed = summary?.removedGoodCount ?? result?.roll.removedGoodCount ?? (removalReviewRequired ? 0 : legacyRemoved);
    const removedRejected = summary?.removedRejectedCount ?? result?.roll.removedRejectedCount ?? 0;
    const verifiedBase = writesEpc ? Math.min(printerValid, capturedEpc) : printerValid;
    // Native roll totals account for each run separately. A legacy write
    // fallback cannot establish a reconciled total from aggregate counters.
    const good = summary?.goodCount ?? Math.max(0, verifiedBase - removed);
    return { printerValid, printerValidKnown, capturedEpc, capturedReadback, removed,
        removedRejected, removalReviewRequired,
        removableGood: summary?.removableGoodCount ?? good + removed,
        removableRejected: summary?.removableRejectedCount ?? 0,
        good, goodKnown: !removalReviewRequired && (summary?.goodCountKnown ?? (printerValidKnown && !writesEpc)),
        voidCount: summary?.voidCount ?? summary?.voidTotalKnown ?? 0,
        missingEpc: summary?.missingEpcCount ?? (result?.roll.bank !== "TID" ? Math.max(0, printerValid - capturedEpc) : 0),
    };
}

/** Allocate only when printing starts; resuming requires the explicitly selected roll ID. */
export async function prepareProductionRoll(agentUrl: string, doc: LabelDoc, quantity: number, printer: { host: string; port: number }, rollId?: string): Promise<ProductionRollResponse & { runIdentity: ProductionRunIdentity }> {
    const identity = productionRunIdentity(doc, printer, await productionTemplateFingerprint(productionTemplateContent(doc)));
    const result = await productionRequest(agentUrl, "roll-create", {
        ...(rollId ? { rollId } : {}), targetLabels: quantity, templateName: doc.name, allowTemplateRevision: true, ...identity,
    });
    const mismatch = productionIdentityMismatch(result.roll, identity);
    if (mismatch) throw new Error(mismatch);
    return { ...result, runIdentity: identity };
}

export async function downloadProductionRoll(agentUrl: string, result: ProductionRollResponse, metadata?: ProductionExportMetadata): Promise<ProductionRollResponse> {
    if (result.roll.state === "open") throw new Error("Đóng cuộn trước khi xuất CSV. Đóng cuộn vẫn giữ toàn bộ lịch sử để xuất sau.");
    const blob = await fetchLocalAgentJson<Blob>(agentUrl, "/v1/tcp/job", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "roll-export", production: { rollId: result.roll.rollId, ...metadata } }),
    }, { timeoutMs: 120_000, responseType: "blob" });
    // Export archives its immutable bytes independently of closing the roll.
    const exported = await productionRequest(agentUrl, "roll-get", { rollId: result.roll.rollId });
    if (exported.roll.state === "open" || !exported.exportFileName) throw new Error("File chưa được lưu vào hồ sơ cuộn. Dữ liệu cuộn vẫn được giữ; thử xuất lại.");
    const link = document.createElement("a");
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = exported.exportFileName || result.exportFileName || `${result.roll.rollId}_rfid.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    return exported;
}

/** A human-readable handoff file for the separately controlled core-label printer. */
export function downloadRollCoreRecord(result: ProductionRollResponse): void {
    const roll = result.roll;
    if (roll.state !== "finalized") throw new Error("Chốt cuộn trước khi xuất thông tin dán lõi.");
    const text = ["NEXTWAVES", `Job ID: ${roll.jobId}`, `Roll ID: ${roll.rollId}`, `Template: ${roll.templateName}`,
        `GOOD: ${roll.physicalGoodCount}`, `VOID giu tren cuon: ${roll.retainedVoidCount ?? "CHUA XAC NHAN"}`,
        `Printer valid counter: ${roll.printerValidCount ?? "CHUA XAC NHAN"}`, `Printer void counter: ${roll.printerVoidCount ?? "CHUA XAC NHAN"}`,
        `VOID thu ngoai production: ${roll.externalTestVoidCount ?? 0}`,
        `Counter source: operator_printer_display`, `QC: lay mau (khong phai kiem 100%)`,
        `Nguoi chot: ${roll.finalizedBy}`, `Ngay gio chot: ${roll.finalizedAt ? new Date(roll.finalizedAt).toLocaleString(undefined, { hour12: false }) : ""}`,
        `Thu tu GOOD tu dau thao cuon: ${roll.orientation === "reverse" ? "In sau truoc" : "In truoc truoc"}`,
        `File CSV: ${result.exportFileName || roll.rollId + "_FINAL_epc_Read.csv"}`, "",
        "Doi chieu Roll ID va GOOD/VOID tren nhan loi voi CSV truoc ban giao.", ""].join("\r\n");
    const link = document.createElement("a"), url = URL.createObjectURL(new Blob(["\ufeff", text], { type: "text/plain;charset=utf-8" }));
    link.href = url; link.download = `${roll.rollId}_CORE_LABEL.txt`; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
