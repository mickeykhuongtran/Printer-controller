export type RfidCaptureOptions = {
    allowTemplateRevision?: boolean;
    configurationSnapshot?: string;
    operationMode?: "read" | "write" | "read_write";
    productionRollId?: string;
    templateFingerprint?: string;
    sourceRollId?: string;
    materialLot?: string;
    operator?: string;
    auditBatchCounters?: boolean;
    expectedHexChars?: number;
    expectedLabels: number;
    firstRow: number;
    rowStep: 1 | -1;
    bank: "EPC" | "TID";
    templateName: string;
};

export type RfidCaptureSummary = {
    jobId: string;
    host: string;
    port: number;
    options: RfidCaptureOptions;
    createdAt: string;
    state: "capturing" | "complete" | "incomplete" | "interrupted" | "cancelled";
    received: number;
    uniqueLabels: number;
    invalidReads?: number;
    issues: number;
    audit?: { state: string; note?: string; countsKnown?: boolean; validDelta: number; voidDelta: number; totalDelta: number;
        lifecycleVersion?: number; finalizationStatus?: "collecting" | "verified" | "unresolved";
        finalizationReason?: string; finalizationNote?: string; lastSampleAt?: string; finalizedAt?: string; counterSampleCount?: number;
        submittedAttempts?: number; submittedAttemptsKnown?: boolean;
        finalCounterProof?: { method: string; sequence: number } };
    error?: string;
};

/** Uses the SAME ^FN1 populated by ^RFR for the printed text, including when
 * the printed text shows only a suffix. L also exposes duplicate/VOID attempts. */
export function buildRfidCaptureZpl(jobId: string, ordinal: number, write?: { expectedHex: string; fieldNumber: number }): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9.:-]{7,127}$/.test(jobId)
        || !Number.isSafeInteger(ordinal) || ordinal < 1) {
        throw new Error("Invalid RFID session identity or label ordinal.");
    }
    if (write && (!/^(?:[0-9A-F]{2}){1,128}$/.test(write.expectedHex) || write.fieldNumber !== 2)) {
        throw new Error("Invalid RFID write verification bytes or field.");
    }
    const expected = write ? `W|${write.expectedHex}|` : "";
    return `^FH_^HV${write?.fieldNumber ?? 1},256,NWEP|${jobId}|${ordinal}|${expected},|END_0D_0A,L^FS`;
}

export function assertRfidCaptureComplete(summary: RfidCaptureSummary): void {
    const audit = summary.audit;
    const accounted = summary.options.auditBatchCounters
        ? !!audit?.countsKnown && (!audit.lifecycleVersion || audit.finalizationStatus === "verified")
            && audit.validDelta + audit.voidDelta === summary.options.expectedLabels
            && summary.uniqueLabels === audit.validDelta && summary.received <= summary.options.expectedLabels
            && (summary.invalidReads ?? 0) <= audit.voidDelta
        : summary.uniqueLabels === summary.options.expectedLabels && summary.received === summary.options.expectedLabels;
    if (summary.error || summary.issues > 0 || !accounted) {
        throw new Error(`RFID session saved ${summary.uniqueLabels}/${summary.options.expectedLabels} label reads, `
            + `${summary.received} responses, ${summary.issues} issue(s). ${summary.error ?? "Download the session CSV to inspect missing, duplicate or invalid reads. Do not replay the batch."}`);
    }
}
