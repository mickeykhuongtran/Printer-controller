/** Numeric representation limit only; there is no application label-count cap. */
export const MAX_PRINT_BATCH_QUANTITY = Number.MAX_SAFE_INTEGER;

export type PrintBatchChunkRange = {
    chunkNumber: number;
    startIndex: number;
    endIndexExclusive: number;
    quantity: number;
};

export type PrintBatchLabelRange = {
    labelFrom: number;
    labelTo: number;
};

export function assertPrintBatchQuantity(quantity: number): void {
    if (
        !Number.isSafeInteger(quantity)
        || quantity < 1
        || quantity > MAX_PRINT_BATCH_QUANTITY
    ) {
        throw new RangeError(
            "Print quantity must be a positive safe integer.",
        );
    }
}

/** Plans bounded chunks without making any assumptions about template data. */
export function planPrintBatchChunks(
    quantity: number,
    chunkSize: number,
): PrintBatchChunkRange[] {
    return Array.from(iteratePrintBatchChunks(quantity, chunkSize));
}

/** Streaming callers must not allocate one planning object per chunk up front. */
export function* iteratePrintBatchChunks(
    quantity: number,
    chunkSize: number,
): Generator<PrintBatchChunkRange> {
    assertPrintBatchQuantity(quantity);
    if (
        !Number.isSafeInteger(chunkSize)
        || chunkSize < 1
        || chunkSize > MAX_PRINT_BATCH_QUANTITY
    ) {
        throw new RangeError(
            "Print chunk size must be a positive safe integer.",
        );
    }

    let chunkNumber = 0;
    for (let startIndex = 0; startIndex < quantity; startIndex += chunkSize) {
        const endIndexExclusive = Math.min(quantity, startIndex + chunkSize);
        yield {
            chunkNumber: ++chunkNumber,
            startIndex,
            endIndexExclusive,
            quantity: endIndexExclusive - startIndex,
        };
    }
}

/**
 * Converts a zero-based chunk offset into the operator-facing label/row
 * numbers. `firstLabelNumber` lets imported ranges retain their absolute row
 * numbers (for example, rows 251–500) during progress and failure reporting.
 */
export function printBatchLabelRange(
    chunk: Pick<PrintBatchChunkRange, "startIndex" | "quantity">,
    firstLabelNumber = 1,
): PrintBatchLabelRange {
    if (!Number.isSafeInteger(firstLabelNumber) || firstLabelNumber < 1) {
        throw new RangeError("First label number must be a positive integer.");
    }
    return {
        labelFrom: firstLabelNumber + chunk.startIndex,
        labelTo: firstLabelNumber + chunk.startIndex + chunk.quantity - 1,
    };
}

/**
 * A connector receipt is only accepted when it accounts for the entire
 * payload. It still does not prove that the physical labels finished printing.
 */
export function assertCompletePrintWrite(
    expectedBytes: number,
    bytesWritten: number,
): void {
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
        throw new RangeError("Expected byte count must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 0) {
        throw new Error(`Invalid write receipt: ${String(bytesWritten)} bytes.`);
    }
    if (bytesWritten !== expectedBytes) {
        throw new Error(
            `Short write: accepted ${bytesWritten} of ${expectedBytes} bytes.`,
        );
    }
}
