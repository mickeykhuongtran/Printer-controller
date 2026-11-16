// Data feed utilities: CSV parsing/serialization, row evaluation with cycle
// detection, and helpers to derive resolved variable maps for the canvas.

import {
    evaluateExpression,
    formatFormulaValue,
    isFormulaError,
    type FormulaResult,
} from "./formula";
import { applyColumnFormat } from "./column-format";
import type { DataColumn, DataFeed, DataRow } from "./types";

const BUILT_IN_VARS = new Set([
    "step",
    "serial",
    "n",
    "counter",
    "index",
    "row",
]);

export function isBuiltInVar(name: string): boolean {
    return BUILT_IN_VARS.has(name.toLowerCase());
}

export function builtInVariableNames(): string[] {
    return Array.from(BUILT_IN_VARS);
}

// Evaluate a single cell value (raw text or formula starting with "=").
// Inline `{var}` references are resolved against the row.
function evalCell(
    src: string,
    rowIdx: number,
    rowCount: number,
    resolveColByName: (name: string) => FormulaResult,
): FormulaResult {
    if (src.startsWith("=")) {
        return evaluateExpression(src, {
            rowIndex: rowIdx,
            rowCount,
            resolveVar: resolveColByName,
        });
    }
    // Plain string with optional {var} interpolation.
    if (!src.includes("{")) return src;
    return src.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) => {
        const v = resolveColByName(name);
        if (isFormulaError(v)) return full;
        return formatFormulaValue(v);
    });
}

// Returns the source string used to evaluate a (column, row) — applying the
// "first-row formula cascades to all rows" rule.
//
// Resolution order:
//   1. column.formula (set via column header) — applies to all rows.
//   2. row 0's cell if it starts with "=" — applies to rows 1+.
//   3. this row's own cell.
export function effectiveCellSource(
    feed: DataFeed,
    rowIdx: number,
    colId: string,
): { source: string; fromColumn: boolean; fromFirstRow: boolean } {
    const col = feed.columns.find((c) => c.id === colId);
    if (col?.formula) {
        return { source: col.formula, fromColumn: true, fromFirstRow: false };
    }
    const ownCell = feed.rows[rowIdx]?.cells[colId] ?? "";
    if (rowIdx > 0) {
        const firstCell = feed.rows[0]?.cells[colId] ?? "";
        if (firstCell.startsWith("=")) {
            return { source: firstCell, fromColumn: false, fromFirstRow: true };
        }
    }
    return { source: ownCell, fromColumn: false, fromFirstRow: false };
}

export function isCellEditable(
    feed: DataFeed,
    rowIdx: number,
    colId: string,
): boolean {
    const col = feed.columns.find((c) => c.id === colId);
    if (col?.system) return false;
    if (col?.formula) return false;
    if (rowIdx > 0) {
        const firstCell = feed.rows[0]?.cells[colId] ?? "";
        if (firstCell.startsWith("=")) return false;
    }
    return true;
}

// Resolve all columns for a single row, with cycle detection.
// Returns a map keyed by column NAME so it can be substituted into label text.
export function evaluateRow(
    feed: DataFeed,
    rowIdx: number,
): Record<string, string> {
    const row = feed.rows[rowIdx];
    if (!row) return {};
    const colByName = new Map(feed.columns.map((c) => [c.name, c]));
    const resolved = new Map<string, FormulaResult>();
    const visiting = new Set<string>();

    const resolveByName = (name: string): FormulaResult => {
        if (isBuiltInVar(name)) return rowIdx + 1;
        const col = colByName.get(name);
        if (!col) return { error: true, code: "REF", message: `Unknown {${name}}` };
        return resolveCol(col);
    };

    function resolveCol(col: DataColumn): FormulaResult {
        if (resolved.has(col.id)) return resolved.get(col.id)!;
        if (visiting.has(col.id)) {
            return { error: true, code: "CYCLE", message: `Cycle through ${col.name}` };
        }
        visiting.add(col.id);
        const { source } = effectiveCellSource(feed, rowIdx, col.id);
        const value = evalCell(source, rowIdx, feed.rows.length, resolveByName);
        visiting.delete(col.id);
        resolved.set(col.id, value);
        return value;
    }

    const out: Record<string, string> = {};
    for (const col of feed.columns) {
        // Stringify the resolved value first, then apply the column's display
        // format. Errors and non-numeric strings pass through unchanged so a
        // column with mixed text/numbers still works.
        const stringified = formatFormulaValue(resolveCol(col));
        out[col.name] = applyColumnFormat(stringified, col.format);
    }
    return out;
}

// Evaluate one cell for display in the spreadsheet UI. Returns the value to
// show + any formula error so the cell can render `#CYCLE`/`#REF` etc.
export function evaluateCellForDisplay(
    feed: DataFeed,
    rowIdx: number,
    colId: string,
): { display: string; raw: string; isFormula: boolean; inherited: boolean; error?: string } {
    const col = feed.columns.find((c) => c.id === colId);
    const row = feed.rows[rowIdx];
    if (!col || !row) return { display: "", raw: "", isFormula: false, inherited: false };
    const eff = effectiveCellSource(feed, rowIdx, colId);
    const raw = eff.source;
    const isFormula = raw.startsWith("=") || !!col.formula;
    const inherited = eff.fromColumn || eff.fromFirstRow;
    if (!isFormula && !raw.includes("{")) {
        return {
            display: applyColumnFormat(raw, col.format),
            raw,
            isFormula: false,
            inherited,
        };
    }
    const colByName = new Map(feed.columns.map((c) => [c.name, c]));
    const resolved = new Map<string, FormulaResult>();
    const visiting = new Set<string>();
    const resolveByName = (name: string): FormulaResult => {
        if (isBuiltInVar(name)) return rowIdx + 1;
        const c = colByName.get(name);
        if (!c) return { error: true, code: "REF", message: `Unknown {${name}}` };
        return resolveCol(c);
    };
    function resolveCol(c: DataColumn): FormulaResult {
        if (resolved.has(c.id)) return resolved.get(c.id)!;
        if (visiting.has(c.id)) {
            return { error: true, code: "CYCLE", message: `Cycle through ${c.name}` };
        }
        visiting.add(c.id);
        const { source } = effectiveCellSource(feed, rowIdx, c.id);
        const v = evalCell(source, rowIdx, feed.rows.length, resolveByName);
        visiting.delete(c.id);
        resolved.set(c.id, v);
        return v;
    }
    const value = resolveCol(col);
    if (isFormulaError(value)) {
        return {
            display: `#${value.code}`,
            raw,
            isFormula: true,
            inherited,
            error: value.message,
        };
    }
    return {
        display: applyColumnFormat(formatFormulaValue(value), col.format),
        raw,
        isFormula,
        inherited,
    };
}

// ── CSV ───────────────────────────────────────────────────────────────────
// RFC 4180-style: comma separator, "" escapes inner quote, fields with comma /
// newline / quote get wrapped in quotes.

export function parseCsv(text: string): string[][] {
    const rows: string[][] = [];
    let cur: string[] = [];
    let field = "";
    let i = 0;
    let inQuote = false;
    while (i < text.length) {
        const c = text[i];
        if (inQuote) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuote = false;
                i += 1;
                continue;
            }
            field += c;
            i += 1;
            continue;
        }
        if (c === '"') {
            inQuote = true;
            i += 1;
            continue;
        }
        if (c === ",") {
            cur.push(field);
            field = "";
            i += 1;
            continue;
        }
        if (c === "\n" || c === "\r") {
            cur.push(field);
            rows.push(cur);
            cur = [];
            field = "";
            // skip CRLF combo
            if (c === "\r" && text[i + 1] === "\n") i += 1;
            i += 1;
            continue;
        }
        field += c;
        i += 1;
    }
    if (field.length > 0 || cur.length > 0) {
        cur.push(field);
        rows.push(cur);
    }
    return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

export function serializeCsv(matrix: string[][]): string {
    const escape = (s: string) =>
        /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    return matrix.map((row) => row.map(escape).join(",")).join("\n") + "\n";
}

export function feedFromCsv(text: string, makeId: () => string): {
    columns: DataColumn[];
    rows: DataRow[];
} {
    return feedFromMatrix(parseCsv(text), makeId);
}

export function feedFromMatrix(matrix: string[][], makeId: () => string): {
    columns: DataColumn[];
    rows: DataRow[];
} {
    if (matrix.length === 0) return { columns: [], rows: [] };
    const headers = matrix[0];
    const columns: DataColumn[] = headers.map((h, i) => ({
        id: makeId(),
        name: h.trim() || `column_${i + 1}`,
    }));
    const rows: DataRow[] = matrix.slice(1).map((cells) => {
        const cellMap: Record<string, string> = {};
        cells.forEach((value, ci) => {
            const col = columns[ci];
            if (col) cellMap[col.id] = value;
        });
        return { id: makeId(), cells: cellMap };
    });
    return { columns, rows };
}

export function feedToCsv(feed: DataFeed): string {
    const headers = feed.columns.map((c) => c.name);
    const rows = feed.rows.map((r) =>
        feed.columns.map((c) => r.cells[c.id] ?? c.formula ?? ""),
    );
    return serializeCsv([headers, ...rows]);
}

// Parse Excel-clipboard TSV. Each line → row, tabs split fields.
export function parseTsv(text: string): string[][] {
    return text
        .replace(/\r/g, "")
        .replace(/\n+$/, "")
        .split("\n")
        .map((line) => line.split("\t"));
}
