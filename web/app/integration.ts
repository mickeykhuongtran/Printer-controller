import type { DataColumn, DataFeed, DataRow, LabelDoc } from "./types";
import { evaluateRow, isBuiltInVar } from "./data-feed";
import { buildZpl, encodeZpl } from "./zpl";
import {
    assertPrintBatchQuantity,
    planPrintBatchChunks,
    type PrintBatchLabelRange,
} from "./print-batch";
import { preflightLabelForPrinter } from "./dpi-preflight";

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export type TemplateFieldSource =
    | "data"
    | "text"
    | "qr"
    | "barcode"
    | "datamatrix"
    | "table"
    | "rfid";

export type TemplateField = {
    name: string;
    sources: TemplateFieldSource[];
    builtIn: boolean;
    defaultValue?: string;
};

export type TemplateValues = Record<string, string | number | boolean | null | undefined>;

function addField(
    fields: Map<string, TemplateField>,
    name: string,
    source: TemplateFieldSource,
    defaultValue?: string,
): void {
    if (!name.trim()) return;
    const key = name.toLowerCase();
    const existing = fields.get(key);
    if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if (defaultValue !== undefined && existing.defaultValue === undefined) {
            existing.defaultValue = defaultValue;
        }
        return;
    }
    fields.set(key, {
        name,
        sources: [source],
        builtIn: isBuiltInVar(name),
        defaultValue,
    });
}

function scanPlaceholders(
    src: string | undefined,
    source: TemplateFieldSource,
    fields: Map<string, TemplateField>,
): void {
    if (!src) return;
    PLACEHOLDER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = PLACEHOLDER_RE.exec(src)) !== null) {
        addField(fields, match[1], source);
    }
}

export function extractTemplateFields(
    doc: LabelDoc,
    options: { includeBuiltIns?: boolean } = {},
): TemplateField[] {
    const fields = new Map<string, TemplateField>();

    const feedValues = doc.dataFeed?.rows.length
        ? evaluateRow(doc.dataFeed, 0)
        : undefined;
    for (const column of doc.dataFeed?.columns ?? []) {
        if (column.system) continue;
        addField(fields, column.name, "data", feedValues?.[column.name] ?? "");
    }
    for (const field of doc.templateFields ?? []) {
        addField(fields, field.name, "data", field.value);
    }

    for (const el of doc.elements) {
        if (
            "fieldName" in el &&
            typeof el.fieldName === "string" &&
            el.fieldName.trim()
        ) {
            const source = el.kind === "text"
                ? "text"
                : el.kind === "qr"
                  ? "qr"
                  : el.kind === "barcode"
                    ? "barcode"
                    : el.kind === "datamatrix"
                      ? "datamatrix"
                      : undefined;
            if (source) {
                const fallback = el.kind === "text" ? el.text : el.data;
                addField(fields, el.fieldName, source, fallback);
            }
        }
        if (el.kind === "text") {
            scanPlaceholders(el.text, "text", fields);
        }
        else if (el.kind === "qr") {
            scanPlaceholders(el.data, "qr", fields);
        }
        else if (el.kind === "barcode") {
            scanPlaceholders(el.data, "barcode", fields);
        }
        else if (el.kind === "datamatrix") {
            scanPlaceholders(el.data, "datamatrix", fields);
        }
        else if (el.kind === "table") {
            for (const cell of el.cells) scanPlaceholders(cell, "table", fields);
        }
    }
    scanPlaceholders(doc.settings.rfid?.data, "rfid", fields);

    return Array.from(fields.values()).filter((field) => {
        if (options.includeBuiltIns) return true;
        return !field.builtIn;
    });
}

function valueToCell(value: TemplateValues[string]): string {
    if (value === null || value === undefined) return "";
    return String(value);
}

function makeColumn(name: string, index: number): DataColumn {
    const safe = name.replace(/[^A-Za-z0-9_]/g, "_") || `field_${index + 1}`;
    return { id: `api_${safe}_${index + 1}`, name };
}

export function applyTemplateValues(
    doc: LabelDoc,
    values: TemplateValues,
    options: { copies?: number } = {},
): LabelDoc {
    const copies = options.copies ?? doc.settings.copies ?? 1;
    assertPrintBatchQuantity(copies);
    const fields = extractTemplateFields(doc);
    const fieldNames = fields.map((field) => field.name);
    const defaultByName = new Map(
        fields.map((field) => [field.name.toLowerCase(), field.defaultValue ?? ""]),
    );
    const valueByName = new Map(
        Object.entries(values).map(([name, value]) => [name.toLowerCase(), value]),
    );
    const seen = new Set(fieldNames.map((name) => name.toLowerCase()));
    for (const name of Object.keys(values)) {
        const key = name.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            fieldNames.push(name);
        }
    }

    const columns = fieldNames.map(makeColumn);
    const cells: DataRow["cells"] = {};
    for (const column of columns) {
        const key = column.name.toLowerCase();
        const hasValue = valueByName.has(key);
        cells[column.id] = hasValue
            ? valueToCell(valueByName.get(key))
            : (defaultByName.get(key) ?? "");
    }

    const dataFeed: DataFeed = {
        columns,
        rows: [{ id: "api_row_1", cells }],
    };

    return {
        ...doc,
        settings: {
            ...doc.settings,
            copies,
        },
        dataFeed,
    };
}

function assertResolvedSymbolPreflight(
    doc: LabelDoc,
    startRowIdx: number,
    copies: number,
): void {
    for (let offset = 0; offset < copies; offset += 1) {
        const copyIndex = startRowIdx + offset;
        const blocking = preflightLabelForPrinter(doc, { copyIndex }).filter(
            (issue) => issue.severity === "error",
        );
        if (blocking.length === 0) continue;
        throw new Error(
            `Print blocked by target-printer preflight for data row ${copyIndex + 1}: ` +
            blocking.map((issue) => issue.message).join(" "),
        );
    }
}

export function compileZplNative(
    doc: LabelDoc,
    values: TemplateValues,
    options: { copies?: number } = {},
): { doc: LabelDoc; zpl: string; payload: Uint8Array; fields: TemplateField[] } {
    const appliedDoc = applyTemplateValues(doc, values, options);
    assertResolvedSymbolPreflight(appliedDoc, 0, appliedDoc.settings.copies);
    const zpl = buildZpl(appliedDoc);
    return {
        doc: appliedDoc,
        zpl,
        payload: encodeZpl(zpl),
        fields: extractTemplateFields(doc),
    };
}

export type CompiledNativePrintChunk = PrintBatchLabelRange & {
    chunkNumber: number;
    totalChunks: number;
    zpl: string;
    payload: Uint8Array;
};

/**
 * Compiles a large native batch into complete ZPL-format windows. Chunking is
 * done only between labels, never inside ^XA...^XZ. `startRowIdx` keeps serial
 * counters and built-in row variables absolute across windows.
 */
export function compileZplNativeChunks(
    doc: LabelDoc,
    values: TemplateValues,
    options: { copies?: number; labelsPerChunk?: number } = {},
): CompiledNativePrintChunk[] {
    const copies = options.copies ?? doc.settings.copies ?? 1;
    assertPrintBatchQuantity(copies);
    const labelsPerChunk = Math.max(
        1,
        Math.min(100, Math.floor(options.labelsPerChunk ?? 25)),
    );
    const applied = applyTemplateValues(doc, values, { copies });
    assertResolvedSymbolPreflight(applied, 0, copies);
    const ranges = planPrintBatchChunks(copies, labelsPerChunk);

    return ranges.map((range) => {
        const chunkDoc: LabelDoc = {
            ...applied,
            settings: {
                ...applied.settings,
                copies: range.quantity,
            },
        };
        const zpl = buildZpl(chunkDoc, range.startIndex);
        return {
            chunkNumber: range.chunkNumber,
            totalChunks: ranges.length,
            labelFrom: range.startIndex + 1,
            labelTo: range.endIndexExclusive,
            zpl,
            payload: encodeZpl(zpl),
        };
    });
}
