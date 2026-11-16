/** Inclusive DataFeed range. Row identities/formulas stay in the original feed. */
export type PrintRowRange = {
    fromIdx: number;
    toIdx: number;
    step: 1 | -1;
    quantity: number;
};

/** UI endpoints are one-based row numbers, clamped independently. */
export function selectPrintRowRange(
    totalRows: number,
    fromRow = 1,
    toRow = totalRows,
): PrintRowRange {
    const total = Number.isFinite(totalRows) ? Math.max(1, Math.floor(totalRows)) : 1;
    const indexFor = (row: number) =>
        Math.max(1, Math.min(total, Number.isFinite(row) ? Math.floor(row) : 1)) - 1;
    const fromIdx = indexFor(fromRow);
    const toIdx = indexFor(toRow);
    return {
        fromIdx,
        toIdx,
        step: toIdx < fromIdx ? -1 : 1,
        quantity: Math.abs(toIdx - fromIdx) + 1,
    };
}

export function printRowIndexAt(range: PrintRowRange, offset: number): number {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= range.quantity) {
        throw new RangeError("Print row offset is outside the selected range.");
    }
    return range.fromIdx + offset * range.step;
}
