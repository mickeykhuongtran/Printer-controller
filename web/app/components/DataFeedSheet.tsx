"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
    Plus,
    Trash2,
    Upload,
    Download,
    Eye,
    Maximize2,
    Minimize2,
    Lock,
    Radio,
    Hash,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
    Dialog,
    DialogContent,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { ColumnFormat, DataColumn, DataFeed } from "../types";
import { applyColumnFormat, describeFormat } from "../column-format";
import {
    feedFromCsv,
    feedFromMatrix,
    feedToCsv,
    parseTsv,
    evaluateCellForDisplay,
    isCellEditable,
} from "../data-feed";
import { downloadFile } from "../storage";
import { uid } from "../units";
import { inferEpcBitsFromData, rfidSourceName, validateRfidHexValue } from "../rfid";

interface Props {
    feed: DataFeed;
    fullscreen: boolean;
    previewRowId: string | null;
    serial?: { enabled: boolean; start: number; step: number; pad: number; prefix: string };
    rfid?: {
        enabled: boolean;
        epcBits: number;
        format: "A" | "H";
        data?: string;
        autoEpcBitsFromData?: boolean;
    };
    showFullscreenToggle?: boolean;
    dispatch: React.Dispatch<{ type: string } & Record<string, unknown>>;
}

type CellPos = { rowIdx: number; colIdx: number };

type DragMode = "cell" | "row" | "col" | null;

function normalizeRange(
    a: CellPos,
    b: CellPos,
): { r1: number; r2: number; c1: number; c2: number } {
    return {
        r1: Math.min(a.rowIdx, b.rowIdx),
        r2: Math.max(a.rowIdx, b.rowIdx),
        c1: Math.min(a.colIdx, b.colIdx),
        c2: Math.max(a.colIdx, b.colIdx),
    };
}

const BUILTIN_VAR_NAMES = ["step", "serial", "n", "counter", "index"];

type FormulaArg = { name: string; description: string };
type FormulaFn = {
    name: string;
    signature: string;
    description: string;
    args?: FormulaArg[];
};

function renderSignatureWithActiveArg(fn: FormulaFn, argIdx: number): React.ReactNode {
    // Parse the signature like `PAD(value, width, char?)` into name + arg names
    // and render with the active arg in bold.
    const m = /^([A-Z_][A-Z0-9_]*)\((.*)\)$/.exec(fn.signature);
    if (!m) return fn.signature;
    const [, name, body] = m;
    const args = body.length === 0 ? [] : body.split(",").map((s) => s.trim());
    return (
        <span>
            <span className="font-semibold">{name}</span>
            <span>(</span>
            {args.map((arg, i) => (
                <span key={i}>
                    {i > 0 ? <span className="text-muted-foreground">, </span> : null}
                    <span
                        className={
                            i === argIdx
                                ? "font-bold text-blue-700 dark:text-blue-400 underline underline-offset-4"
                                : "text-muted-foreground"
                        }
                    >
                        {arg}
                    </span>
                </span>
            ))}
            <span>)</span>
        </span>
    );
}

const FORMULA_FUNCS: FormulaFn[] = [
    { name: "ROW", signature: "ROW()", description: "Current row (1-based). e.g. row 3 → 3" },
    { name: "STEP", signature: "STEP()", description: "Alias for ROW() - useful for clarity" },
    { name: "N", signature: "N()", description: "Alias for ROW()" },
    {
        name: "PAD",
        signature: "PAD(value, width, char?)",
        description: "Left-pad a value to a fixed width. e.g. PAD(7, 4) → \"0007\"",
        args: [
            { name: "value", description: "The text or number to pad (e.g. 7, {step})" },
            { name: "width", description: "Total length of the result. e.g. 4 → up to 4 chars" },
            { name: "char", description: "Pad character (optional, defaults to \"0\")" },
        ],
    },
    {
        name: "CONCAT",
        signature: "CONCAT(...)",
        description: "Join all arguments into one string. e.g. CONCAT(\"SKU-\", {step})",
        args: [{ name: "...values", description: "Strings, numbers, or variables to concatenate" }],
    },
    {
        name: "UPPER",
        signature: "UPPER(text)",
        description: "Uppercase a string. e.g. UPPER(\"abc\") → \"ABC\"",
        args: [{ name: "text", description: "Any string value or {variable}" }],
    },
    {
        name: "LOWER",
        signature: "LOWER(text)",
        description: "Lowercase a string",
        args: [{ name: "text", description: "Any string value or {variable}" }],
    },
    {
        name: "LEFT",
        signature: "LEFT(text, n)",
        description: "First n characters of text. e.g. LEFT(\"hello\", 3) → \"hel\"",
        args: [
            { name: "text", description: "Source string" },
            { name: "n", description: "How many leftmost characters to take" },
        ],
    },
    {
        name: "RIGHT",
        signature: "RIGHT(text, n)",
        description: "Last n characters of text",
        args: [
            { name: "text", description: "Source string" },
            { name: "n", description: "How many rightmost characters to take" },
        ],
    },
    {
        name: "MID",
        signature: "MID(text, start, n)",
        description: "Substring. e.g. MID(\"hello\", 2, 3) → \"ell\"",
        args: [
            { name: "text", description: "Source string" },
            { name: "start", description: "1-based start position (1 = first char)" },
            { name: "n", description: "How many characters to take" },
        ],
    },
    {
        name: "LEN",
        signature: "LEN(text)",
        description: "Length of a string in characters",
        args: [{ name: "text", description: "Any string" }],
    },
    {
        name: "IF",
        signature: "IF(cond, then, else)",
        description: "Pick a value based on a condition. e.g. IF({step}>5, \"big\", \"small\")",
        args: [
            { name: "cond", description: "Boolean expression. e.g. {step}>5 or LEN({sku})=12" },
            { name: "then", description: "Value when condition is true" },
            { name: "else", description: "Value when condition is false" },
        ],
    },
    {
        name: "SGTIN",
        signature: "SGTIN(barcode, serial, filter?, partition?)",
        description:
            "Encode a GS1 SGTIN-96 hex EPC tag from a full barcode. Returns 24 hex chars.",
        args: [
            {
                name: "barcode",
                description:
                    "EAN-13 (13 digits) or GTIN-14 (14 digits). The check digit is auto-stripped. e.g. {ean} or \"5901234123457\"",
            },
            {
                name: "serial",
                description:
                    "Unique serial number for this item (0 to 274,877,906,943). Use {step} for a per-row counter",
            },
            {
                name: "filter",
                description:
                    "Optional. 0–7 (default 1 = retail consumer trade item)",
            },
            {
                name: "partition",
                description:
                    "Optional. 0–6, controls how the barcode splits into GS1 company-prefix vs item-reference (default 5 → 7-digit company prefix)",
            },
        ],
    },
    {
        name: "EAN13_CHECK",
        signature: "EAN13_CHECK(d12)",
        description: "Compute the 13th check digit for an EAN-13 barcode",
        args: [
            {
                name: "d12",
                description: "The first 12 digits of the EAN-13. Returns the 13th (check) digit.",
            },
        ],
    },
    {
        name: "GTIN_CHECK",
        signature: "GTIN_CHECK(digits)",
        description: "Compute the mod-10 check digit for any GTIN-style number",
        args: [
            {
                name: "digits",
                description:
                    "All payload digits (no check digit). Works for GTIN-8, 12, 13, 14.",
            },
        ],
    },
];

const SHEET_HEADER_CLASS =
    "sticky top-0 z-30 bg-muted text-foreground border-b border-r border-border px-2 py-1 text-left text-xs font-semibold shadow-[0_1px_0_0_var(--border)]";
const SHEET_ROW_HEADER_CLASS =
    "sticky left-0 top-0 z-40 bg-muted text-muted-foreground border-b border-r border-border px-2 py-1 text-center text-[10px] font-mono font-semibold shadow-[1px_1px_0_0_var(--border)]";
const SHEET_ROW_GUTTER_CLASS =
    "sticky left-0 z-10 bg-background border-b border-r border-border px-2 py-0.5 text-center text-[11px] font-mono text-muted-foreground select-none cursor-pointer shadow-[1px_0_0_0_var(--border)] hover:bg-blue-500/10";
const SHEET_SYSTEM_HEADER_CLASS =
    "sticky top-0 z-30 bg-muted text-foreground border-b border-r border-border px-2 py-1 text-left text-xs font-semibold shadow-[0_1px_0_0_var(--border)]";

export function DataFeedSheet({
    feed,
    fullscreen,
    previewRowId,
    serial,
    rfid,
    showFullscreenToggle = true,
    dispatch,
}: Props) {
    // Selection model: a rectangular range from `anchor` to `cursor`. The
    // cursor is the "active" cell (the one whose input is editable). When
    // anchor === null, selection is collapsed to the cursor cell.
    const [cursor, setCursor] = useState<CellPos | null>(null);
    const [anchor, setAnchor] = useState<CellPos | null>(null);
    const [editingHeader, setEditingHeader] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    // Mouse-drag selection mode: cell, row gutter, or column header.
    const dragRef = useRef<DragMode>(null);
    useEffect(() => {
        const onUp = () => {
            dragRef.current = null;
        };
        window.addEventListener("mouseup", onUp);
        return () => window.removeEventListener("mouseup", onUp);
    }, []);

    const lastColIdx = Math.max(0, feed.columns.length - 1);
    const lastRowIdx = Math.max(0, feed.rows.length - 1);

    const range = useMemo(() => {
        if (!cursor) return null;
        return normalizeRange(anchor ?? cursor, cursor);
    }, [anchor, cursor]);

    const inRange = (r: number, c: number) => {
        if (!range) return false;
        return r >= range.r1 && r <= range.r2 && c >= range.c1 && c <= range.c2;
    };
    const rangeIsMultiCell =
        !!range && (range.r1 !== range.r2 || range.c1 !== range.c2);

    // Select an entire row (or extend selection through row when shift+drag).
    const selectRow = (rowIdx: number, extend: boolean) => {
        if (extend && anchor) {
            setCursor({ rowIdx, colIdx: lastColIdx });
        } else {
            setAnchor({ rowIdx, colIdx: 0 });
            setCursor({ rowIdx, colIdx: lastColIdx });
        }
    };
    const selectCol = (colIdx: number, extend: boolean) => {
        if (extend && anchor) {
            setCursor({ rowIdx: lastRowIdx, colIdx });
        } else {
            setAnchor({ rowIdx: 0, colIdx });
            setCursor({ rowIdx: lastRowIdx, colIdx });
        }
    };
    const selectAll = () => {
        setAnchor({ rowIdx: 0, colIdx: 0 });
        setCursor({ rowIdx: lastRowIdx, colIdx: lastColIdx });
    };

    // Stable list of variable suggestions (column names + builtins).
    const allVars = useMemo(
        () => [
            ...feed.columns.map((c) => ({ name: c.name, source: "column" as const })),
            ...BUILTIN_VAR_NAMES.map((n) => ({ name: n, source: "builtin" as const })),
        ],
        [feed.columns],
    );
    const rfidEncodeSourceName = rfid?.enabled ? rfidSourceName(rfid.data) : null;
    const isRfidEncodeColumn = (col: DataColumn) =>
        !!rfidEncodeSourceName &&
        col.name.toLowerCase() === rfidEncodeSourceName.toLowerCase();

    // Track which cell input currently has focus so we can route click-to-
    // reference (clicking a column header while in a formula cell inserts
    // `{name}` at the caret position). Returns true if the click was
    // consumed (an actual reference was inserted), so the caller can fall
    // back to other behaviors (column selection) when this is a no-op.
    const focusedInputRef = useRef<HTMLInputElement | null>(null);
    const insertReferenceAtFocus = (name: string): boolean => {
        const input = focusedInputRef.current;
        if (!input) return false;
        const value = input.value;
        // Only when in formula mode (`=...`).
        if (!value.startsWith("=")) return false;
        if (!cursor) return false;
        const row = feed.rows[cursor.rowIdx];
        const col = feed.columns[cursor.colIdx];
        if (!row || !col) return false;
        // Block self-reference — would create a cycle (#CYCLE error).
        if (col.name === name) return false;
        const start = input.selectionStart ?? value.length;
        const end = input.selectionEnd ?? start;
        const before = value.slice(0, start);
        const after = value.slice(end);
        const inserted = `{${name}}`;
        const next = before + inserted + after;
        dispatch({
            type: "feed/setCell",
            rowId: row.id,
            colId: col.id,
            value: next,
        } as never);
        setTimeout(() => {
            try {
                input.focus();
                const caret = before.length + inserted.length;
                input.setSelectionRange(caret, caret);
            } catch {
                /* ignore */
            }
        }, 0);
        return true;
    };


    // ── Virtualization: window-render rows when there are many. Uses a
    // fixed row height and a buffer above/below the viewport so the user
    // can scroll smoothly through 100k rows without rendering them all.
    const ROW_H = 32;
    const BUFFER = 12;
    const VIRT_THRESHOLD = 60;
    const sheetScrollRef = useRef<HTMLDivElement | null>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(600);
    useEffect(() => {
        const el = sheetScrollRef.current;
        if (!el) return;
        const onScroll = () => setScrollTop(el.scrollTop);
        const onResize = () => setViewportH(el.clientHeight);
        onResize();
        el.addEventListener("scroll", onScroll, { passive: true });
        const ro = new ResizeObserver(onResize);
        ro.observe(el);
        return () => {
            el.removeEventListener("scroll", onScroll);
            ro.disconnect();
        };
    }, []);
    const totalRows = feed.rows.length;
    // Both drawer and fullscreen modes should expose the whole data feed.
    // When the feed is large, render a moving window and keep the full scroll
    // height with spacers so users can still scroll through every row.
    const virtualize = totalRows > VIRT_THRESHOLD;
    const startIdx = virtualize
        ? Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER)
        : 0;
    const endIdx = virtualize
        ? Math.min(totalRows, Math.ceil((scrollTop + viewportH) / ROW_H) + BUFFER)
        : totalRows;
    const topSpacer = virtualize ? startIdx * ROW_H : 0;
    const bottomSpacer = virtualize ? (totalRows - endIdx) * ROW_H : 0;
    const visibleRows = virtualize
        ? feed.rows.slice(startIdx, endIdx)
        : feed.rows;

    const onAddColumn = () =>
        dispatch({ type: "feed/addColumn" } as never);
    const [addRowsOpen, setAddRowsOpen] = useState(false);
    const [addRowsCount, setAddRowsCount] = useState(5);
    // Column whose Format Cells dialog is currently open. null = closed.
    const [formatColId, setFormatColId] = useState<string | null>(null);
    const onAddRow = () => setAddRowsOpen(true);
    const confirmAddRows = () => {
        const n = Math.max(1, Math.min(1000, Math.floor(addRowsCount)));
        // Single bulk action — avoid per-row dispatches that would each cause
        // a re-render and history entry.
        dispatch({ type: "feed/addRows", count: n } as never);
        setAddRowsOpen(false);
    };
    const onSetCell = (rowId: string, colId: string, value: string) =>
        dispatch({ type: "feed/setCell", rowId, colId, value } as never);
    const onDeleteRow = (rowId: string) =>
        dispatch({ type: "feed/deleteRows", rowIds: [rowId] } as never);
    const onPreviewRow = (rowId: string) =>
        dispatch({
            type: "feed/setPreviewRow",
            rowId: previewRowId === rowId ? null : rowId,
        } as never);
    const onRenameColumn = (id: string, name: string) =>
        dispatch({ type: "feed/renameColumn", id, name } as never);
    const onSetFormula = (id: string, formula: string | undefined) =>
        dispatch({ type: "feed/setColumnFormula", id, formula } as never);
    const onDeleteColumn = (id: string) =>
        dispatch({ type: "feed/deleteColumn", id } as never);
    const onToggleFullscreen = () =>
        dispatch({
            type: "feed/setFullscreen",
            fullscreen: !fullscreen,
        } as never);

    const onImportFile = () => fileInputRef.current?.click();
    const onDataFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const ext = file.name.split(".").pop()?.toLowerCase();
        let parsed: { columns: DataColumn[]; rows: DataFeed["rows"] };
        if (ext === "xlsx" || ext === "xls") {
            const XLSX = await import("xlsx");
            const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
            const sheetName = workbook.SheetNames[0];
            const sheet = sheetName ? workbook.Sheets[sheetName] : undefined;
            const rawMatrix = sheet
                ? XLSX.utils.sheet_to_json<unknown[]>(sheet, {
                      header: 1,
                      defval: "",
                      raw: false,
                  })
                : [];
            const matrix = rawMatrix.map((row) =>
                row.map((cell) => (cell == null ? "" : String(cell))),
            );
            parsed = feedFromMatrix(matrix, () => uid("id"));
        } else if (ext === "tsv") {
            const text = await file.text();
            parsed = feedFromMatrix(parseTsv(text), () => uid("id"));
        } else {
            const text = await file.text();
            parsed = feedFromCsv(text, () => uid("id"));
        }
        dispatch({
            type: "feed/replaceAll",
            columns: parsed.columns,
            rows: parsed.rows,
        } as never);
    };
    const onExportCsv = () => {
        downloadFile("data-feed.csv", feedToCsv(feed), "text/csv");
    };

    // Paste from clipboard. Three cases:
    //   1. Multi-cell clipboard (TSV / multiple lines) → paste matrix at the
    //      top-left of the current selection, growing rows as needed.
    //   2. Single-value clipboard + multi-cell selection → fill every editable
    //      cell in the selection with that value.
    //   3. Single-value + single-cell selection → fall through to the
    //      browser's native paste into the focused input.
    const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
        const text = e.clipboardData.getData("text/plain");
        if (!text || !cursor) return;
        const isMatrix = text.includes("\t") || text.includes("\n");
        if (!isMatrix && !rangeIsMultiCell) return;

        e.preventDefault();
        const top = range
            ? { rowIdx: range.r1, colIdx: range.c1 }
            : cursor;
        const matrix = isMatrix ? parseTsv(text) : [[text]];

        const updates: Array<{ rowId: string; colId: string; value: string }> = [];
        let rowsToAdd = 0;

        if (isMatrix) {
            // Paste the matrix starting at top-left, growing rows if needed.
            for (let r = 0; r < matrix.length; r += 1) {
                const targetRowIdx = top.rowIdx + r;
                const row = feed.rows[targetRowIdx];
                if (!row) {
                    rowsToAdd = Math.max(rowsToAdd, targetRowIdx - feed.rows.length + 1);
                    continue;
                }
                for (let c = 0; c < matrix[r].length; c += 1) {
                    const col = feed.columns[top.colIdx + c];
                    if (!col) continue;
                    if (!isCellEditable(feed, targetRowIdx, col.id)) continue;
                    updates.push({ rowId: row.id, colId: col.id, value: matrix[r][c] });
                }
            }
        } else if (range) {
            // Single-value fill across the whole selection.
            const value = matrix[0][0];
            for (let r = range.r1; r <= range.r2; r += 1) {
                const row = feed.rows[r];
                if (!row) continue;
                for (let c = range.c1; c <= range.c2; c += 1) {
                    const col = feed.columns[c];
                    if (!col) continue;
                    if (!isCellEditable(feed, r, col.id)) continue;
                    updates.push({ rowId: row.id, colId: col.id, value });
                }
            }
        }

        if (updates.length === 0 && rowsToAdd === 0) return;
        dispatch({
            type: "feed/setCells",
            updates,
            addRows: rowsToAdd,
        } as never);
    };

    // Read the currently-selected range as a TSV string. Uses the *displayed*
    // value of each cell so formulas come out as their resolved values
    // (matches what the user sees and what Excel/Sheets does on copy).
    const buildSelectionTsv = (): string | null => {
        if (!range) return null;
        const lines: string[] = [];
        for (let r = range.r1; r <= range.r2; r += 1) {
            const row = feed.rows[r];
            const cells: string[] = [];
            for (let c = range.c1; c <= range.c2; c += 1) {
                const col = feed.columns[c];
                if (!row || !col) {
                    cells.push("");
                    continue;
                }
                const raw = row.cells[col.id] ?? "";
                // For raw user-entered values that aren't formulas, copy
                // verbatim so a round-trip copy-paste preserves the source.
                // For formulas / computed columns, copy the resolved display.
                if (raw.startsWith("=") || col.formula || col.system) {
                    cells.push(evaluateCellForDisplay(feed, r, col.id).display);
                } else {
                    cells.push(raw);
                }
            }
            lines.push(cells.join("\t"));
        }
        return lines.join("\n");
    };

    const onCopy = (e: React.ClipboardEvent<HTMLDivElement>) => {
        if (!rangeIsMultiCell) return;
        const tsv = buildSelectionTsv();
        if (tsv === null) return;
        e.preventDefault();
        e.clipboardData.setData("text/plain", tsv);
    };

    // Clear every editable cell in the current selection. Used by the Delete
    // key when a multi-cell selection is active.
    const clearSelection = () => {
        if (!range) return;
        const updates: Array<{ rowId: string; colId: string; value: string }> = [];
        for (let r = range.r1; r <= range.r2; r += 1) {
            const row = feed.rows[r];
            if (!row) continue;
            for (let c = range.c1; c <= range.c2; c += 1) {
                const col = feed.columns[c];
                if (!col) continue;
                if (!isCellEditable(feed, r, col.id)) continue;
                if ((row.cells[col.id] ?? "") === "") continue;
                updates.push({ rowId: row.id, colId: col.id, value: "" });
            }
        }
        if (updates.length === 0) return;
        dispatch({ type: "feed/setCells", updates } as never);
    };

    // Delete key on multi-cell selection clears the range. We listen on the
    // container with a capture handler so it fires even when an input has
    // focus — but only when there's no caret-driven text selection inside
    // that input (otherwise the user is trying to edit, not bulk-clear).
    const onContainerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key !== "Delete" && e.key !== "Backspace") return;
        if (!rangeIsMultiCell) return;
        const active = document.activeElement as HTMLInputElement | null;
        if (active && active.tagName === "INPUT") {
            const start = active.selectionStart ?? 0;
            const end = active.selectionEnd ?? 0;
            // Let the user's intra-cell editing (caret moves, char delete)
            // win when they're actively editing — only clear the range on
            // Delete (forward delete) which doesn't conflict with editing.
            if (e.key === "Backspace" && active.value.length > 0) return;
            if (e.key === "Delete" && (start !== end || start < active.value.length)) {
                // Has caret selection or caret isn't at end → editing intent.
                if (start !== end) return;
            }
        }
        e.preventDefault();
        clearSelection();
    };

    const moveCursor = (drow: number, dcol: number) => {
        if (!cursor) return;
        const next: CellPos = {
            rowIdx: Math.max(0, Math.min(feed.rows.length - 1, cursor.rowIdx + drow)),
            colIdx: Math.max(
                0,
                Math.min(feed.columns.length - 1, cursor.colIdx + dcol),
            ),
        };
        // Arrow / Tab / Enter collapses any range selection.
        setAnchor(null);
        setCursor(next);
    };

    return (
        <TooltipProvider delayDuration={150}>
            <div
                ref={containerRef}
                className={cn(
                    "flex h-full min-h-0 flex-col bg-background text-foreground [color-scheme:light] dark:[color-scheme:dark]",
                    fullscreen ? "rounded-lg" : "",
                )}
                data-testid="data-feed-sheet"
                onPaste={onPaste}
                onCopy={onCopy}
                onKeyDown={onContainerKeyDown}
                tabIndex={0}
            >
                {/* Toolbar */}
                <div
                    className={cn(
                        "flex items-center gap-2 px-3 py-2 border-b border-black/[0.06] dark:border-white/[0.06] flex-shrink-0",
                        fullscreen && "rounded-t-lg",
                    )}
                >
                    <Button size="sm" variant="outline" onClick={onImportFile}>
                        <Upload className="w-3.5 h-3.5" />
                        <span className="ml-1.5">Import CSV/Excel</span>
                    </Button>
                    <Button size="sm" variant="outline" onClick={onExportCsv}>
                        <Download className="w-3.5 h-3.5" />
                        <span className="ml-1.5">Export CSV</span>
                    </Button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv,text/csv,.tsv,text/tab-separated-values,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                        className="hidden"
                        onChange={onDataFile}
                    />
                    <span className="ml-auto text-xs text-muted-foreground">
                        {feed.rows.length} rows · {feed.columns.length} cols
                    </span>
                    {showFullscreenToggle && (
                        <Button
                            size="sm"
                            variant={fullscreen ? "outline" : "ghost"}
                            onClick={onToggleFullscreen}
                            title={fullscreen ? "Exit full-screen" : "Full-screen"}
                        >
                            {fullscreen ? (
                                <>
                                    <Minimize2 className="w-3.5 h-3.5" />
                                    <span className="ml-1.5 hidden md:inline">Close</span>
                                </>
                            ) : (
                                <Maximize2 className="w-3.5 h-3.5" />
                            )}
                        </Button>
                    )}
                </div>

                {/* Sheet */}
                <div
                    ref={sheetScrollRef}
                    className={cn(
                        "min-h-0 flex-1 relative overscroll-contain",
                        fullscreen
                            ? "overflow-auto p-4"
                            : "p-2 overflow-auto",
                    )}
                >
                    {feed.columns.length === 0 ? (
                        <div className="flex flex-col items-center gap-3 p-8 text-center text-sm text-muted-foreground">
                            <p>
                                Import a CSV/Excel file, or add a column to start a manual data feed.
                                Each column becomes a{" "}
                                <code className="bg-muted px-1 rounded">{"{name}"}</code>{" "}
                                variable you can use in your label.
                            </p>
                            <Button size="sm" variant="outline" onClick={onAddColumn}>
                                <Plus className="w-3.5 h-3.5" />
                                <span className="ml-1.5">Add column</span>
                            </Button>
                        </div>
                    ) : (
                        <table
                            data-testid="data-feed-table"
                            className={cn(
                                "border-separate border-spacing-0 text-sm w-full bg-background text-foreground ring-1 ring-border rounded-[8px] table-fixed",
                                fullscreen && "shadow-sm",
                            )}
                        >
                            <colgroup>
                                <col style={{ width: 40 }} />
                                {feed.columns.map((col) => (
                                    <col
                                        key={col.id}
                                        style={
                                            col.width
                                                ? { width: col.width }
                                                : undefined
                                        }
                                    />
                                ))}
                                <col style={{ width: 32 }} />
                            </colgroup>
                            <thead>
                                <tr>
                                    <th
                                        className={cn(
                                            SHEET_ROW_HEADER_CLASS,
                                            "cursor-pointer hover:bg-blue-500/10 dark:hover:bg-blue-400/10",
                                        )}
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            selectAll();
                                        }}
                                        title="Row index - click to select all rows"
                                    >
                                        #
                                    </th>
                                    {feed.columns.map((col, ci) => {
                                        const colSelected =
                                            !!range &&
                                            range.c1 <= ci &&
                                            ci <= range.c2 &&
                                            range.r1 === 0 &&
                                            range.r2 === lastRowIdx;
                                        return (
                                        <ColumnHeader
                                            key={col.id}
                                            col={col}
                                            colIdx={ci}
                                            totalCols={feed.columns.length}
                                            dispatch={dispatch}
                                            editing={editingHeader === col.id}
                                            selected={colSelected}
                                            rfidEncodeSource={isRfidEncodeColumn(col)}
                                            onBeginRename={() => setEditingHeader(col.id)}
                                            onCommitRename={(name) => {
                                                onRenameColumn(col.id, name);
                                                setEditingHeader(null);
                                            }}
                                            onCancelRename={() => setEditingHeader(null)}
                                            onSetFormula={(f) => onSetFormula(col.id, f)}
                                            onDelete={() => onDeleteColumn(col.id)}
                                            onClickName={() => {
                                                // First try to insert a {ref}
                                                // into the focused formula
                                                // cell. If that's a no-op,
                                                // select the column instead.
                                                if (insertReferenceAtFocus(col.name)) return;
                                                selectCol(ci, false);
                                            }}
                                            onSelectColumn={(extend) => {
                                                selectCol(ci, extend);
                                                dragRef.current = "col";
                                            }}
                                            onExtendColumn={() => {
                                                if (dragRef.current === "col") {
                                                    setCursor({
                                                        rowIdx: lastRowIdx,
                                                        colIdx: ci,
                                                    });
                                                }
                                            }}
                                            onOpenFormat={() =>
                                                setFormatColId(col.id)
                                            }
                                        />
                                        );
                                    })}
                                    <th className={cn(SHEET_HEADER_CLASS, "border-r-0 text-center")}>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 w-6 p-0"
                                            onClick={onAddColumn}
                                            title="Add column"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                        </Button>
                                    </th>
                                </tr>
                            </thead>
                            <tbody
                                data-testid="data-feed-table-body"
                                className="bg-background text-foreground"
                            >
                                {topSpacer > 0 && (
                                    <tr style={{ height: topSpacer }} aria-hidden>
                                        <td colSpan={feed.columns.length + 2} />
                                    </tr>
                                )}
                                {visibleRows.map((row, vi) => {
                                    const ri = startIdx + vi;
                                    const rowSelected =
                                        !!range &&
                                        range.r1 <= ri &&
                                        ri <= range.r2 &&
                                        range.c1 === 0 &&
                                        range.c2 === lastColIdx;
                                    return (
                                    <tr
                                        key={row.id}
                                        style={virtualize ? { height: ROW_H } : undefined}
                                        className={cn(
                                            "bg-background text-foreground",
                                            previewRowId === row.id &&
                                                "bg-blue-500/5",
                                        )}
                                    >
                                        <td
                                            className={cn(
                                                SHEET_ROW_GUTTER_CLASS,
                                                rowSelected &&
                                                    "bg-blue-500/15 text-blue-700 dark:text-blue-300 font-semibold",
                                            )}
                                            onMouseDown={(e) => {
                                                // Plain/shift click selects the
                                                // row; drag extends through the
                                                // gutter. Double-click handles
                                                // the preview toggle separately.
                                                e.preventDefault();
                                                selectRow(ri, e.shiftKey);
                                                dragRef.current = "row";
                                            }}
                                            onMouseEnter={() => {
                                                if (dragRef.current === "row") {
                                                    setCursor({
                                                        rowIdx: ri,
                                                        colIdx: lastColIdx,
                                                    });
                                                }
                                            }}
                                            onDoubleClick={() => onPreviewRow(row.id)}
                                            title="Click to select row · Double-click to preview · Shift+click to extend"
                                        >
                                            {previewRowId === row.id ? (
                                                <Eye
                                                    className={cn(
                                                        "w-3.5 h-3.5 mx-auto",
                                                        !rowSelected && "text-blue-600",
                                                    )}
                                                />
                                            ) : (
                                                ri + 1
                                            )}
                                        </td>
                                        {feed.columns.map((col, ci) => (
                                            <Cell
                                                key={col.id}
                                                rowId={row.id}
                                                col={col}
                                                rowIdx={ri}
                                                colIdx={ci}
                                                value={row.cells[col.id] ?? ""}
                                                feed={feed}
                                                cursor={
                                                    !!cursor &&
                                                    cursor.rowIdx === ri &&
                                                    cursor.colIdx === ci
                                                }
                                                selected={inRange(ri, ci)}
                                                autoFocus={
                                                    !!cursor &&
                                                    cursor.rowIdx === ri &&
                                                    cursor.colIdx === ci &&
                                                    !rangeIsMultiCell
                                                }
                                                onMouseDownCell={(shift) => {
                                                    // Shift+click on a cell
                                                    // extends the existing
                                                    // selection — useful for
                                                    // building rectangular
                                                    // ranges to copy/clear.
                                                    if (shift && cursor) {
                                                        if (!anchor) setAnchor(cursor);
                                                        setCursor({ rowIdx: ri, colIdx: ci });
                                                    } else {
                                                        setAnchor({ rowIdx: ri, colIdx: ci });
                                                        setCursor({ rowIdx: ri, colIdx: ci });
                                                    }
                                                    dragRef.current = "cell";
                                                }}
                                                onEnterEdit={() => {
                                                    setAnchor({ rowIdx: ri, colIdx: ci });
                                                    setCursor({ rowIdx: ri, colIdx: ci });
                                                    dragRef.current = null;
                                                }}
                                                onMouseEnterCell={() => {
                                                    if (dragRef.current === "row") {
                                                        // Drag through rows
                                                        // extends row range.
                                                        setCursor({
                                                            rowIdx: ri,
                                                            colIdx: lastColIdx,
                                                        });
                                                    } else if (dragRef.current === "cell") {
                                                        setCursor({ rowIdx: ri, colIdx: ci });
                                                        if (focusedInputRef.current) {
                                                            focusedInputRef.current.blur();
                                                        }
                                                    }
                                                }}
                                                onFocus={(input) => {
                                                    focusedInputRef.current = input;
                                                    // If selection wasn't set
                                                    // by a mouseDown (e.g. tab
                                                    // navigation moved focus),
                                                    // sync cursor + collapse
                                                    // anchor.
                                                    if (
                                                        !cursor ||
                                                        cursor.rowIdx !== ri ||
                                                        cursor.colIdx !== ci
                                                    ) {
                                                        setAnchor(null);
                                                        setCursor({ rowIdx: ri, colIdx: ci });
                                                    }
                                                }}
                                                onBlur={() => {
                                                    // Don't clear synchronously —
                                                    // a click on a header still
                                                    // needs the ref.
                                                }}
                                                onChange={(v) =>
                                                    onSetCell(row.id, col.id, v)
                                                }
                                                onMove={moveCursor}
                                                allVars={allVars}
                                                serial={serial}
                                                rfid={rfid}
                                                rfidEncodeSource={isRfidEncodeColumn(col)}
                                            />
                                        ))}
                                        <td className="border-b border-border bg-background px-1 py-0.5 text-center text-foreground">
                                            <Tooltip>
                                                <TooltipTrigger asChild>
                                                    <button
                                                        onClick={() =>
                                                            onDeleteRow(row.id)
                                                        }
                                                        className="text-muted-foreground hover:text-destructive p-1"
                                                    >
                                                        <Trash2 className="w-3 h-3" />
                                                    </button>
                                                </TooltipTrigger>
                                                <TooltipContent>Delete row</TooltipContent>
                                            </Tooltip>
                                        </td>
                                    </tr>
                                    );
                                })}
                                {bottomSpacer > 0 && (
                                    <tr style={{ height: bottomSpacer }} aria-hidden>
                                        <td colSpan={feed.columns.length + 2} />
                                    </tr>
                                )}
                                <tr>
                                    <td
                                        className={cn(
                                            SHEET_ROW_GUTTER_CLASS,
                                            "text-center",
                                        )}
                                    >
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 w-6 p-0"
                                            onClick={onAddRow}
                                            title="Add row"
                                        >
                                            <Plus className="w-3.5 h-3.5" />
                                        </Button>
                                    </td>
                                    <td
                                        colSpan={feed.columns.length + 1}
                                        className="border-b border-border bg-background px-1 py-0.5 text-foreground"
                                    >
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-7 w-full justify-start text-muted-foreground"
                                            onClick={onAddRow}
                                        >
                                            <span className="ml-1.5">Add row</span>
                                        </Button>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    )}

                    {!fullscreen && showFullscreenToggle && (
                        <div className="flex flex-col items-center justify-center pt-3 pb-1 gap-1">
                            {totalRows > 0 && (
                                <span className="text-[11px] text-muted-foreground">
                                    {totalRows} rows available · scroll inside the sheet
                                </span>
                            )}
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={onToggleFullscreen}
                                className="gap-1.5"
                            >
                                <Maximize2 className="w-3.5 h-3.5" />
                                View all
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            <Dialog open={addRowsOpen} onOpenChange={setAddRowsOpen}>
                <DialogContent className="sm:max-w-sm">
                    <DialogTitle>Add rows</DialogTitle>
                    <DialogDescription className="text-xs">
                        How many empty rows should be appended to the data feed?
                    </DialogDescription>
                    <div className="space-y-2 pt-2">
                        <Label className="text-xs">Number of rows</Label>
                        <Input
                            type="number"
                            min={1}
                            max={1000}
                            value={addRowsCount}
                            autoFocus
                            onChange={(e) =>
                                setAddRowsCount(Number(e.target.value))
                            }
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    confirmAddRows();
                                }
                            }}
                        />
                        <div className="flex flex-wrap gap-1">
                            {[1, 10, 100, 1000].map((n) => (
                                <Button
                                    key={n}
                                    variant={addRowsCount === n ? "default" : "outline"}
                                    size="sm"
                                    className="h-7 px-2.5 text-xs"
                                    onClick={() => setAddRowsCount(n)}
                                >
                                    {n}
                                </Button>
                            ))}
                        </div>
                    </div>
                    <DialogFooter>
                        <Button
                            variant="outline"
                            onClick={() => setAddRowsOpen(false)}
                        >
                            Cancel
                        </Button>
                        <Button onClick={confirmAddRows}>
                            Add {addRowsCount} {addRowsCount === 1 ? "row" : "rows"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <FormatCellsDialog
                open={!!formatColId}
                column={feed.columns.find((c) => c.id === formatColId) ?? null}
                onClose={() => setFormatColId(null)}
                onApply={(format) => {
                    if (!formatColId) return;
                    dispatch({
                        type: "feed/setColumnFormat",
                        id: formatColId,
                        format,
                    } as never);
                    setFormatColId(null);
                }}
            />
        </TooltipProvider>
    );
}

function ColumnHeader({
    col,
    colIdx,
    totalCols,
    dispatch,
    editing,
    selected,
    rfidEncodeSource,
    onBeginRename,
    onCommitRename,
    onCancelRename,
    onDelete,
    onClickName,
    onSelectColumn,
    onExtendColumn,
    onOpenFormat,
}: {
    col: DataColumn;
    colIdx: number;
    totalCols: number;
    dispatch: React.Dispatch<{ type: string } & Record<string, unknown>>;
    editing: boolean;
    selected?: boolean;
    rfidEncodeSource?: boolean;
    onBeginRename: () => void;
    onCommitRename: (name: string) => void;
    onCancelRename: () => void;
    onSetFormula: (f: string | undefined) => void;
    onDelete: () => void;
    onClickName?: () => void;
    onSelectColumn?: (extend: boolean) => void;
    onExtendColumn?: () => void;
    onOpenFormat?: () => void;
}) {
    const thRef = useRef<HTMLTableCellElement | null>(null);

    const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startW = thRef.current?.offsetWidth ?? col.width ?? 120;
        const onMove = (ev: PointerEvent) => {
            const next = Math.max(60, startW + (ev.clientX - startX));
            dispatch({ type: "feed/setColumnWidth", id: col.id, width: next });
        };
        const onUp = () => {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    const dragHandlers = col.system
        ? {}
        : {
              draggable: true,
              onDragStart: (e: React.DragEvent<HTMLTableCellElement>) => {
                  e.dataTransfer.setData("application/x-nw-col", col.id);
                  e.dataTransfer.effectAllowed = "move";
              },
              onDragOver: (e: React.DragEvent<HTMLTableCellElement>) => {
                  if (e.dataTransfer.types.includes("application/x-nw-col")) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                  }
              },
              onDrop: (e: React.DragEvent<HTMLTableCellElement>) => {
                  const fromId = e.dataTransfer.getData("application/x-nw-col");
                  if (!fromId || fromId === col.id) return;
                  e.preventDefault();
                  const toIndex = Math.max(0, Math.min(totalCols - 1, colIdx));
                  dispatch({ type: "feed/reorderColumn", id: fromId, toIndex });
              },
          };

    const resizeHandle = (
        <div
            data-resize
            onPointerDown={startResize}
            className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500/70"
            style={{ touchAction: "none" }}
            title="Drag to resize column"
        />
    );

    // Selection-related handlers shared across all three th variants. Clicking
    // anywhere on the header box (other than the rename input, action button,
    // or resize grip) behaves like clicking the column name itself: tries to
    // insert a `{name}` ref into a focused formula cell first, falls back to
    // selecting the whole column. Hovering while a column-drag is active
    // extends the selection.
    const selectionThProps = {
        onMouseDown: (e: React.MouseEvent<HTMLTableCellElement>) => {
            if ((e.target as HTMLElement).closest("input,button,[data-resize]")) return;
            // The name span has its own onMouseDown that already dispatches
            // onClickName — let it run instead of double-firing here.
            if ((e.target as HTMLElement).closest("[data-col-name]")) return;
            e.preventDefault();
            // Shift-click on the box always extends column selection — keeps
            // multi-column shift-drag working.
            if (e.shiftKey) {
                onSelectColumn?.(true);
                return;
            }
            // Single-click anywhere on the box: same as clicking the name.
            if (onClickName) {
                onClickName();
            } else {
                onSelectColumn?.(false);
            }
        },
        onMouseEnter: () => {
            onExtendColumn?.();
        },
    };
    const selectedClass = selected
        ? "bg-blue-500/15 text-blue-700 dark:text-blue-300"
        : "";

    if (col.system) {
        // Locked column (e.g. the built-in `step` counter). Read-only label,
        // no rename, no formula edit, no delete. Clicking the name still
        // inserts a `{name}` reference into a focused formula cell.
        return (
            <th
                ref={thRef}
                {...selectionThProps}
                className={cn(
                    SHEET_SYSTEM_HEADER_CLASS,
                    "min-w-[110px] cursor-pointer",
                    selectedClass,
                )}
                title="System counter column - locked. Use {step} in templates or formulas."
            >
                <div
                    data-col-name
                    className="flex items-center gap-1.5 cursor-pointer hover:text-blue-600"
                    onMouseDown={(e) => {
                        e.preventDefault();
                        onClickName?.();
                    }}
                    title="Click while in a formula cell to insert {step}"
                >
                    <Lock className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                    <span className="font-mono">{col.name}</span>
                    <span
                        className="rounded bg-black/[0.08] px-1 py-px text-[9px] font-mono uppercase tracking-wide text-muted-foreground dark:bg-white/[0.12]"
                        title="System-generated field"
                    >
                        sys
                    </span>
                    {col.formula && (
                        <span
                            className="text-[9px] font-mono px-1 rounded bg-blue-500/15 text-blue-700 dark:text-blue-400"
                            title={`Formula: ${col.formula}`}
                        >
                            ƒx
                        </span>
                    )}
                </div>
                {resizeHandle}
            </th>
        );
    }

    if (col.protected) {
        // Name + delete locked, but cells (especially row 1) remain editable.
        // Used for managed/legacy columns.
        const isRfid = col.id === "col_rfid_epc_encode";
        return (
            <th
                ref={thRef}
                {...dragHandlers}
                {...selectionThProps}
                className={cn(
                    SHEET_HEADER_CLASS,
                    "min-w-[110px] cursor-pointer",
                    selectedClass,
                )}
                title="Managed column - name and delete are locked, but cells are editable"
            >
                <div
                    data-col-name
                    className="flex items-center gap-1 cursor-pointer hover:text-blue-600"
                    onMouseDown={(e) => {
                        e.preventDefault();
                        onClickName?.();
                    }}
                    title={`Click while in a formula cell to insert {${col.name}}`}
                >
                    {isRfid ? (
                        <Radio className="w-3 h-3 text-blue-600 flex-shrink-0" />
                    ) : (
                        <Lock className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                    )}
                    <span className="font-mono">{col.name}</span>
                </div>
                {resizeHandle}
            </th>
        );
    }

    return (
        <th
            ref={thRef}
            {...dragHandlers}
            {...selectionThProps}
            className={cn(
                SHEET_HEADER_CLASS,
                "min-w-[110px] group cursor-pointer",
                selectedClass,
            )}
            onDoubleClick={onBeginRename}
        >
            <div className="flex items-center gap-1">
                {editing ? (
                    <Input
                        autoFocus
                        defaultValue={col.name}
                        onChange={(e) => {
                            e.currentTarget.value = e.currentTarget.value.replace(
                                /[^A-Za-z0-9_]/g,
                                "_",
                            );
                        }}
                        onBlur={(e) => onCommitRename(e.currentTarget.value)}
                        onKeyDown={(e) => {
                            if (e.key === "Enter") onCommitRename(e.currentTarget.value);
                            if (e.key === "Escape") onCancelRename();
                        }}
                        className="h-6 text-xs"
                    />
                ) : (
                    <>
                        {rfidEncodeSource && (
                            <Radio
                                className="w-3 h-3 text-blue-600 dark:text-blue-400 flex-shrink-0"
                                aria-hidden
                            />
                        )}
                        <span
                            data-col-name
                            className="font-mono cursor-pointer hover:text-blue-600"
                            onMouseDown={(e) => {
                                // mousedown so it fires before the focused cell blurs
                                e.preventDefault();
                                onClickName?.();
                            }}
                            title="Click to insert {name} into a formula cell, or select column"
                        >
                            {col.name}
                        </span>
                    </>
                )}
                {rfidEncodeSource && (
                    <span
                        className="rounded bg-blue-500/15 px-1 py-px text-[9px] font-mono uppercase tracking-wide text-blue-700 dark:text-blue-300"
                        title="RFID EPC encode source"
                    >
                        RFID
                    </span>
                )}
                {col.formula && (
                    <span
                        className="text-[9px] font-mono px-1 rounded bg-blue-500/15 text-blue-700 dark:text-blue-400"
                        title={`Formula: ${col.formula}`}
                    >
                        ƒx
                    </span>
                )}
                {col.format && col.format.type !== "text" && (
                    <span
                        className="text-[9px] font-mono px-1 rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                        title={`Format: ${describeFormat(col.format)}`}
                    >
                        123
                    </span>
                )}
                <div className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onOpenFormat?.();
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-blue-600 p-0.5"
                        title="Format cells (number, currency, percent…)"
                        type="button"
                    >
                        <Hash className="w-3 h-3" />
                    </button>
                    <button
                        onClick={onDelete}
                        onMouseDown={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-destructive p-0.5"
                        title="Delete column"
                        type="button"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                </div>
            </div>
            {resizeHandle}
        </th>
    );
}

function Cell({
    rowId,
    col,
    rowIdx,
    colIdx,
    value,
    feed,
    cursor,
    selected,
    autoFocus,
    onMouseDownCell,
    onMouseEnterCell,
    onEnterEdit,
    onFocus,
    onBlur,
    onChange,
    onMove,
    allVars,
    serial,
    rfid,
    rfidEncodeSource,
}: {
    rowId: string;
    col: DataColumn;
    rowIdx: number;
    colIdx: number;
    value: string;
    feed: DataFeed;
    cursor: boolean;
    selected: boolean;
    autoFocus: boolean;
    onMouseDownCell: (shift: boolean) => void;
    onMouseEnterCell: () => void;
    onEnterEdit: () => void;
    onFocus: (input: HTMLInputElement) => void;
    onBlur?: () => void;
    onChange: (v: string) => void;
    onMove: (drow: number, dcol: number) => void;
    allVars: Array<{ name: string; source: "column" | "builtin" }>;
    serial?: { enabled: boolean; start: number; step: number; pad: number; prefix: string };
    rfid?: {
        enabled: boolean;
        epcBits: number;
        format: "A" | "H";
        data?: string;
        autoEpcBitsFromData?: boolean;
    };
    rfidEncodeSource?: boolean;
}) {
    void rowId;
    const inputRef = useRef<HTMLInputElement | null>(null);
    type AutocompleteMode = "var" | "func";
    const [autocomplete, setAutocomplete] = useState<{
        mode: AutocompleteMode;
        prefix: string;
        startPos: number;
        selectedIdx: number;
    } | null>(null);
    // Tracks whether this cell's input currently has focus. Drives the
    // "raw on focus, formatted on blur" Excel-style display: when blurred
    // and the column has a numeric format, the input renders the formatted
    // value (e.g. "10,000") instead of the raw stored value ("10000").
    const [focused, setFocused] = useState(false);
    // Auto-focus the input only when this cell is the cursor AND the
    // selection is collapsed to a single cell. When the cursor is inside a
    // multi-cell range (e.g. user dragged to select), don't steal text focus —
    // they're selecting, not editing.
    useEffect(() => {
        if (
            autoFocus &&
            inputRef.current &&
            document.activeElement !== inputRef.current
        ) {
            inputRef.current.focus();
        }
    }, [autoFocus]);

    const selectionBg =
        selected && !cursor
            ? "bg-blue-500/10 dark:bg-blue-400/10"
            : "";

    // Excel-style click model:
    //   • Single click on a cell → selects that single cell. Drag extends
    //     a rectangular range in any direction (use the row gutter to
    //     select an entire row).
    //   • Double-click → enters edit mode on the cell.
    //   • Shift+click → extends the existing selection (cell-range) so the
    //     user can build a rectangular block.
    const onMouseDownTd = (e: React.MouseEvent<HTMLTableCellElement>) => {
        // Don't fire when clicking inside a button (e.g. preview toggle).
        if ((e.target as HTMLElement).closest("button")) return;
        // If the input already has focus (user is mid-edit), let the click
        // land in the input naturally — don't steal it back to selection.
        if (
            inputRef.current &&
            document.activeElement === inputRef.current
        ) {
            return;
        }
        e.preventDefault();
        onMouseDownCell(e.shiftKey);
    };
    const onDoubleClickTd = (e: React.MouseEvent<HTMLTableCellElement>) => {
        if ((e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        onEnterEdit();
        // Focus input next tick — autoFocus effect will normally handle it,
        // but if we're already cursor+collapsed it won't re-fire.
        setTimeout(() => inputRef.current?.focus(), 0);
    };
    const onMouseEnterTd = () => {
        onMouseEnterCell();
    };

    const filtered = useMemo(() => {
        if (!autocomplete) return [] as Array<{ name: string; hint?: string; signature?: string }>;
        const p = autocomplete.prefix.toLowerCase();
        if (autocomplete.mode === "var") {
            return allVars
                .filter((v) => v.name !== col.name)
                .filter((v) => v.name.toLowerCase().startsWith(p))
                .slice(0, 12)
                .map((v) => ({ name: v.name, hint: v.source }));
        }
        // func mode
        return FORMULA_FUNCS.filter((f) => f.name.toLowerCase().startsWith(p))
            .slice(0, 12)
            .map((f) => ({
                name: f.name,
                signature: f.signature,
                hint: f.description,
            }));
    }, [autocomplete, allVars]);

    // Live "function signature hint" — like Google Sheets. Detects when the
    // caret is inside FUNC(...) and bolds the current argument.
    const [activeFn, setActiveFn] = useState<{ fn: FormulaFn; argIdx: number } | null>(null);
    const updateActiveFn = (input: HTMLInputElement) => {
        if (!input.value.startsWith("=")) {
            setActiveFn(null);
            return;
        }
        const v = input.value;
        const caret = input.selectionStart ?? 0;
        let depth = 0;
        let argIdx = 0;
        for (let i = caret - 1; i >= 0; i -= 1) {
            const ch = v[i];
            if (ch === ")") {
                depth += 1;
                continue;
            }
            if (ch === "(") {
                if (depth === 0) {
                    let j = i - 1;
                    let name = "";
                    while (j >= 0 && /[A-Za-z0-9_]/.test(v[j])) {
                        name = v[j] + name;
                        j -= 1;
                    }
                    if (!name) {
                        setActiveFn(null);
                        return;
                    }
                    const fn = FORMULA_FUNCS.find(
                        (f) => f.name === name.toUpperCase(),
                    );
                    if (!fn) {
                        setActiveFn(null);
                        return;
                    }
                    setActiveFn({ fn, argIdx });
                    return;
                }
                depth -= 1;
                continue;
            }
            if ((ch === "," || ch === ";") && depth === 0) {
                argIdx += 1;
            }
        }
        setActiveFn(null);
    };

    const updateAutocomplete = (input: HTMLInputElement) => {
        const caret = input.selectionStart ?? 0;
        const v = input.value;

        // 1. Variable mode: walk back to a "{" with only identifier chars in between.
        {
            let i = caret - 1;
            let foundOpen = -1;
            while (i >= 0) {
                const ch = v[i];
                if (ch === "}") break;
                if (ch === "{") {
                    foundOpen = i;
                    break;
                }
                if (!/[A-Za-z0-9_]/.test(ch)) break;
                i -= 1;
            }
            if (foundOpen >= 0) {
                setAutocomplete({
                    mode: "var",
                    prefix: v.slice(foundOpen + 1, caret),
                    startPos: foundOpen,
                    selectedIdx: 0,
                });
                return;
            }
        }

        // 2. Function mode: when in formula (value starts with "="), look at
        //    an identifier-in-progress preceded by `=`, `(`, `,` or operator.
        if (v.startsWith("=")) {
            let i = caret - 1;
            while (i >= 0 && /[A-Za-z0-9_]/.test(v[i])) i -= 1;
            const before = i >= 0 ? v[i] : "";
            const validBefore = i < 0 || "=,(+-*/&<>%^".includes(before);
            const prefixStart = i + 1;
            const prefix = v.slice(prefixStart, caret);
            // Don't trigger on bare `=` with no letters yet — wait until they
            // type at least one letter. Also skip when prefix has digits only.
            if (validBefore && prefix.length > 0 && /^[A-Za-z_]/.test(prefix)) {
                setAutocomplete({
                    mode: "func",
                    prefix,
                    startPos: prefixStart,
                    selectedIdx: 0,
                });
                return;
            }
        }

        setAutocomplete(null);
    };

    const insertSuggestion = (name: string) => {
        if (!autocomplete) return;
        const input = inputRef.current;
        if (!input) return;
        const caret = input.selectionStart ?? value.length;
        const before = value.slice(0, autocomplete.startPos);
        const after = value.slice(caret);
        let inserted: string;
        let caretOffset: number;
        if (autocomplete.mode === "var") {
            inserted = `{${name}}`;
            caretOffset = inserted.length;
        } else {
            // Function: insert `NAME(` and place caret inside the parens.
            inserted = `${name}(`;
            caretOffset = inserted.length;
        }
        const next = before + inserted + after;
        onChange(next);
        setAutocomplete(null);
        setTimeout(() => {
            const pos = before.length + caretOffset;
            try {
                input.setSelectionRange(pos, pos);
                input.focus();
            } catch {
                /* ignore */
            }
        }, 0);
    };

    const computed = useMemo(
        () => evaluateCellForDisplay(feed, rowIdx, col.id),
        [feed, rowIdx, col.id],
    );
    const isSystem = !!col.system;
    const editable = isCellEditable(feed, rowIdx, col.id);
    const rfidValidation =
        rfid?.enabled && rfidEncodeSource && rfid.format === "H"
            ? validateRfidHexValue(
                  computed.display,
                  rfid.autoEpcBitsFromData ? undefined : rfid.epcBits,
              )
            : null;
    const rfidAutoBits =
        rfid?.autoEpcBitsFromData && rfidValidation?.valid
            ? inferEpcBitsFromData(computed.display, "H")
            : null;
    const rfidValidationClass = rfidValidation
        ? rfidValidation.valid
            ? "bg-emerald-500/10 dark:bg-emerald-400/10"
            : "bg-red-500/10 dark:bg-red-400/10"
        : "";
    const rfidValidationTitle = rfidValidation
        ? rfidValidation.valid
            ? rfidAutoBits
                ? `Valid RFID hex (${rfidValidation.normalized.length} chars, auto ${rfidAutoBits} bits)`
                : `Valid RFID hex (${rfidValidation.normalized.length} chars)`
            : rfidValidation.reason
        : undefined;

    // Locked system column: render the computed value as plain text — not editable.
    if (isSystem) {
        // The `step` column displays the prefixed/padded version using the
        // serial counter settings (e.g. "T0001"), but `{step}` in formulas
        // still resolves to the raw number so `{step}*2` etc. continue to
        // work as math.
        let display = computed.display;
        if (col.id === "col_step" && serial?.enabled) {
            const n = parseInt(computed.display, 10);
            if (Number.isFinite(n)) {
                const width = Math.max(1, Math.floor(serial.pad));
                const padded = String(n).padStart(width, "0");
                display = `${serial.prefix ?? ""}${padded}`;
            }
        }
        return (
            <td
                onMouseDown={onMouseDownTd}
                onDoubleClick={onDoubleClickTd}
                onMouseEnter={onMouseEnterTd}
                className={cn(
                    "border-b border-r border-border bg-muted/40 p-0 text-muted-foreground",
                    selectionBg,
                    cursor && "ring-1 ring-blue-500 ring-inset z-10",
                )}
            >
                <div
                    className="px-2 py-1 text-xs font-mono select-none cursor-default"
                    title="System counter - value is generated automatically. {step} in formulas is the raw number."
                >
                    {display}
                </div>
                <span className="hidden">{colIdx}</span>
            </td>
        );
    }

    // Inherited cell — formula in row 1 cascades down. Read-only display.
    if (!editable && computed.inherited) {
        if (computed.error) {
            return (
                <td
                    onMouseDown={onMouseDownTd}
                    onDoubleClick={onDoubleClickTd}
                    onMouseEnter={onMouseEnterTd}
                    className={cn(
                        "border-b border-r border-border bg-background p-0 text-foreground",
                        rfidValidationClass,
                        selectionBg,
                        cursor && "ring-1 ring-blue-500 ring-inset z-10",
                    )}
                >
                    <div
                        className="px-2 py-1 text-[11px] font-mono text-destructive cursor-default leading-tight"
                        title={computed.error}
                    >
                        <span className="font-semibold">{computed.display}:</span>{" "}
                        <span className="font-normal">{computed.error}</span>
                    </div>
                    <span className="hidden">{colIdx}</span>
                </td>
            );
        }
        const display = computed.display;
        return (
            <td
                onMouseDown={onMouseDownTd}
                onDoubleClick={onDoubleClickTd}
                onMouseEnter={onMouseEnterTd}
                className={cn(
                    "border-b border-r border-border bg-background p-0 text-foreground",
                    rfidValidationClass,
                    selectionBg,
                    cursor && "ring-1 ring-blue-500 ring-inset z-10",
                )}
            >
                <div
                    className="px-2 py-1 text-xs font-mono text-slate-500 dark:text-slate-400 italic select-none cursor-default truncate"
                    title={rfidValidationTitle ?? "Inherited from row 1's formula. Edit row 1 to change."}
                >
                    {display}
                </div>
                <span className="hidden">{colIdx}</span>
            </td>
        );
    }
    const useMonoFont = computed.isFormula || value.includes("{");

    // Is this cell the *source* of a column formula (i.e. starts with "=" in row 1
    // of a non-system column)? If so, highlight it as the formula source.
    const isFormulaSource = rowIdx === 0 && value.startsWith("=");

    // Show raw value while editing; show the column's formatted display when
    // not focused (Excel-style). Plain text and non-numeric cells fall
    // through unchanged because applyColumnFormat is a no-op for them.
    const displayValue =
        !focused && col.format && col.format.type !== "text" && !value.startsWith("=")
            ? applyColumnFormat(value, col.format)
            : value;

    return (
        <td
            onMouseDown={onMouseDownTd}
            onDoubleClick={onDoubleClickTd}
            onMouseEnter={onMouseEnterTd}
            className={cn(
                "relative border-b border-r border-border bg-background p-0 text-foreground",
                isFormulaSource && "bg-amber-50 dark:bg-amber-500/10",
                rfidValidationClass,
                selectionBg,
                cursor && "ring-1 ring-blue-500 ring-inset z-10",
            )}
        >
            <input
                ref={inputRef}
                type="text"
                value={displayValue}
                onChange={(e) => {
                    onChange(e.target.value);
                    updateAutocomplete(e.target);
                    updateActiveFn(e.target);
                }}
                onFocus={(e) => {
                    setFocused(true);
                    onFocus(e.currentTarget);
                    updateActiveFn(e.currentTarget);
                }}
                onClick={(e) => {
                    onFocus(e.currentTarget);
                    updateAutocomplete(e.currentTarget);
                    updateActiveFn(e.currentTarget);
                }}
                onKeyUp={(e) => {
                    updateAutocomplete(e.currentTarget);
                    updateActiveFn(e.currentTarget);
                }}
                onBlur={() => {
                    setFocused(false);
                    setTimeout(() => {
                        setAutocomplete(null);
                        setActiveFn(null);
                    }, 150);
                    onBlur?.();
                }}
                onKeyDown={(e) => {
                    // Autocomplete navigation takes priority while open.
                    if (autocomplete && filtered.length > 0) {
                        if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setAutocomplete({
                                ...autocomplete,
                                selectedIdx:
                                    (autocomplete.selectedIdx + 1) % filtered.length,
                            });
                            return;
                        }
                        if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setAutocomplete({
                                ...autocomplete,
                                selectedIdx:
                                    (autocomplete.selectedIdx - 1 + filtered.length) %
                                    filtered.length,
                            });
                            return;
                        }
                        if (e.key === "Enter" || e.key === "Tab") {
                            e.preventDefault();
                            insertSuggestion(filtered[autocomplete.selectedIdx].name);
                            return;
                        }
                        if (e.key === "Escape") {
                            e.preventDefault();
                            setAutocomplete(null);
                            return;
                        }
                    }
                    if (e.key === "Enter") {
                        e.preventDefault();
                        onMove(1, 0);
                    } else if (e.key === "Tab") {
                        e.preventDefault();
                        onMove(0, e.shiftKey ? -1 : 1);
                    } else if (e.key === "ArrowDown" && !e.shiftKey) {
                        if (
                            (e.target as HTMLInputElement).selectionStart ===
                            (e.target as HTMLInputElement).value.length
                        ) {
                            e.preventDefault();
                            onMove(1, 0);
                        }
                    } else if (e.key === "ArrowUp" && !e.shiftKey) {
                        if ((e.target as HTMLInputElement).selectionStart === 0) {
                            e.preventDefault();
                            onMove(-1, 0);
                        }
                    }
                }}
                className={cn(
                    "w-full appearance-none bg-background px-2 py-1 text-xs text-foreground caret-foreground outline-none placeholder:text-muted-foreground",
                    computed.error && "text-destructive",
                    !cursor &&
                        isFormulaSource &&
                        "text-blue-700 dark:text-blue-400 font-semibold",
                    !cursor &&
                        computed.isFormula &&
                        !isFormulaSource &&
                        "text-blue-700 dark:text-blue-400",
                    rfidValidation &&
                        (rfidValidation.valid
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-red-700 dark:text-red-300"),
                )}
                title={
                    rfidValidationTitle ??
                    computed.error ??
                    (computed.isFormula ? `→ ${computed.display}` : undefined)
                }
                style={{
                    minWidth: 80,
                    fontFamily: useMonoFont
                        ? "ui-monospace, monospace"
                        : "inherit",
                }}
                placeholder={col.formula ? "(formula on column)" : ""}
            />
            {/* Inline error banner — shows when the formula in this cell
                produces an error (#PARSE / #REF / #FN / #CYCLE / #ARG). */}
            {cursor && computed.error && computed.isFormula && (
                <div className="absolute z-40 left-0 top-full mt-0.5 max-w-[420px] rounded-[8px] bg-popover px-3 py-2 text-popover-foreground ring-1 ring-destructive/40 shadow-xl">
                    <div className="text-[11px] leading-snug">
                        <span className="font-mono font-semibold text-destructive">
                            {computed.display}
                        </span>{" "}
                        <span className="text-destructive">{computed.error}</span>
                    </div>
                </div>
            )}
            {/* Function signature hint (Google-Sheets style) — bolds the
                current argument and explains what it expects. Hidden when the
                autocomplete dropdown is open to avoid double tooltips. */}
            {activeFn && !autocomplete && (
                <div
                    className="absolute z-50 left-0 top-full mt-0.5 space-y-1.5 rounded-[8px] bg-popover px-3 py-2 text-popover-foreground ring-1 ring-border shadow-xl"
                    style={{
                        width: 480,
                        maxWidth: "calc(100vw - 32px)",
                        whiteSpace: "normal",
                    }}
                >
                    <div className="font-mono text-[11px]">
                        {renderSignatureWithActiveArg(activeFn.fn, activeFn.argIdx)}
                    </div>
                    {(() => {
                        const argDoc = activeFn.fn.args?.[activeFn.argIdx];
                        if (argDoc) {
                            return (
                                <div className="text-[11px] leading-snug">
                                    <span className="font-semibold text-blue-700 dark:text-blue-400">
                                        {argDoc.name}:
                                    </span>{" "}
                                    <span className="text-foreground">
                                        {argDoc.description}
                                    </span>
                                </div>
                            );
                        }
                        return null;
                    })()}
                    <div className="text-[10px] text-muted-foreground border-t border-black/[0.06] dark:border-white/[0.06] pt-1">
                        {activeFn.fn.description}
                    </div>
                </div>
            )}

            {autocomplete && filtered.length > 0 && (
                <ul
                    className="absolute z-50 left-0 top-full mt-0.5 overflow-hidden rounded-[8px] bg-popover text-popover-foreground ring-1 ring-border shadow-xl"
                    style={{
                        width: autocomplete.mode === "func" ? 360 : 240,
                        maxWidth: "calc(100vw - 32px)",
                    }}
                >
                    {filtered.map((s, idx) => (
                        <li key={s.name}>
                            <button
                                type="button"
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    insertSuggestion(s.name);
                                }}
                                className={cn(
                                    "w-full text-left px-2.5 py-1.5 transition-colors",
                                    idx === autocomplete.selectedIdx
                                        ? "bg-primary text-primary-foreground"
                                        : "hover:bg-muted",
                                )}
                            >
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-mono text-[11px] font-semibold">
                                        {autocomplete.mode === "var"
                                            ? `{${s.name}}`
                                            : (s as { signature?: string }).signature ?? s.name}
                                    </span>
                                </div>
                                {s.hint && (
                                    <div
                                        className={cn(
                                            "text-[10px] mt-0.5",
                                            idx === autocomplete.selectedIdx
                                                ? "text-primary-foreground/80"
                                                : "text-muted-foreground",
                                        )}
                                    >
                                        {s.hint}
                                    </div>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            )}
            <span className="hidden">{colIdx}</span>
        </td>
    );
}

// ── Format Cells dialog ──────────────────────────────────────────────────
// Excel-style category picker. The category controls which secondary
// options are visible. A live preview renders the current sample value
// with the in-progress format so the user can see the effect before
// committing.
const FORMAT_PRESETS: Array<{ key: ColumnFormat["type"]; label: string; sample: string }> = [
    { key: "text", label: "Text", sample: "10000" },
    { key: "number", label: "Number", sample: "10000" },
    { key: "currency", label: "Currency", sample: "10000" },
    { key: "percent", label: "Percent", sample: "0.125" },
    { key: "custom", label: "Custom", sample: "10000" },
];

function FormatCellsDialog({
    open,
    column,
    onClose,
    onApply,
}: {
    open: boolean;
    column: DataColumn | null;
    onClose: () => void;
    onApply: (format: ColumnFormat | undefined) => void;
}) {
    return (
        <Dialog
            open={open}
            onOpenChange={(o) => {
                if (!o) onClose();
            }}
        >
            <DialogContent className="sm:max-w-md">
                {column ? (
                    <FormatCellsDialogBody
                        key={column.id}
                        column={column}
                        onClose={onClose}
                        onApply={onApply}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}

// Body of the dialog — keyed on column.id so it remounts (and re-derives
// its draft state) every time a different column is opened. Avoids the
// "setState in useEffect" anti-pattern.
function FormatCellsDialogBody({
    column,
    onClose,
    onApply,
}: {
    column: DataColumn;
    onClose: () => void;
    onApply: (format: ColumnFormat | undefined) => void;
}) {
    // Local draft state — initialized from the column's current format on
    // first render; not synchronized after that (parent remounts via key).
    const [draft, setDraft] = useState<ColumnFormat>(
        column.format ?? { type: "text" },
    );

    const sampleRaw = (() => {
        // Try to reuse a real numeric sample if the column already has one.
        if (draft.type === "percent") return "0.125";
        return "10000";
    })();
    const samplePreview = applyColumnFormat(sampleRaw, draft);

    const setType = (type: ColumnFormat["type"]) => {
        switch (type) {
            case "text":
                setDraft({ type: "text" });
                break;
            case "number":
                setDraft({ type: "number", decimals: 0, thousands: true });
                break;
            case "currency":
                setDraft({
                    type: "currency",
                    decimals: 2,
                    thousands: true,
                    symbol: "$",
                    position: "before",
                });
                break;
            case "percent":
                setDraft({ type: "percent", decimals: 0 });
                break;
            case "custom":
                setDraft({
                    type: "custom",
                    decimals: 0,
                    thousands: true,
                    prefix: "",
                    suffix: "",
                });
                break;
        }
    };

    return (
        <>
            <DialogTitle>Format cells - {column.name}</DialogTitle>
            <DialogDescription className="text-xs">
                Display format applies to the data feed, label preview, and
                print output. The stored cell value stays raw, so formulas
                and references keep working with the underlying number.
            </DialogDescription>

            <div className="grid grid-cols-[140px_1fr] gap-3 pt-2">
                    {/* Category list */}
                    <div className="flex flex-col gap-0.5 border-r border-black/[0.06] dark:border-white/[0.06] pr-3">
                        {FORMAT_PRESETS.map((p) => (
                            <button
                                key={p.key}
                                type="button"
                                onClick={() => setType(p.key)}
                                className={cn(
                                    "text-left text-xs px-2 py-1.5 rounded transition-colors",
                                    draft.type === p.key
                                        ? "bg-primary text-primary-foreground"
                                        : "hover:bg-muted",
                                )}
                            >
                                {p.label}
                            </button>
                        ))}
                    </div>

                    {/* Options panel */}
                    <div className="space-y-3 min-w-0">
                        <div className="text-[11px] text-muted-foreground">
                            Preview
                        </div>
                        <div className="rounded border border-black/[0.08] dark:border-white/[0.08] bg-muted/40 px-3 py-2 font-mono text-sm">
                            {samplePreview || (
                                <span className="text-muted-foreground italic">
                                    (no value)
                                </span>
                            )}
                        </div>

                        {draft.type === "number" && (
                            <NumberOptions
                                decimals={draft.decimals ?? 0}
                                thousands={draft.thousands ?? true}
                                onChange={(d, t) =>
                                    setDraft({ type: "number", decimals: d, thousands: t })
                                }
                            />
                        )}
                        {draft.type === "currency" && (
                            <>
                                <NumberOptions
                                    decimals={draft.decimals ?? 2}
                                    thousands={draft.thousands ?? true}
                                    onChange={(d, t) =>
                                        setDraft({
                                            ...draft,
                                            decimals: d,
                                            thousands: t,
                                        })
                                    }
                                />
                                <div className="space-y-1">
                                    <Label className="text-xs">Symbol</Label>
                                    <Input
                                        value={draft.symbol ?? "$"}
                                        onChange={(e) =>
                                            setDraft({ ...draft, symbol: e.target.value })
                                        }
                                        className="h-8 text-xs"
                                    />
                                </div>
                                <div className="space-y-1">
                                    <Label className="text-xs">Symbol position</Label>
                                    <div className="flex gap-1">
                                        {(["before", "after"] as const).map((p) => (
                                            <Button
                                                key={p}
                                                type="button"
                                                variant={
                                                    (draft.position ?? "before") === p
                                                        ? "default"
                                                        : "outline"
                                                }
                                                size="sm"
                                                className="h-7 px-2.5 text-xs"
                                                onClick={() =>
                                                    setDraft({ ...draft, position: p })
                                                }
                                            >
                                                {p === "before" ? "$1,000" : "1,000$"}
                                            </Button>
                                        ))}
                                    </div>
                                </div>
                            </>
                        )}
                        {draft.type === "percent" && (
                            <div className="space-y-2">
                                <Label className="text-xs">Decimals</Label>
                                <Input
                                    type="number"
                                    min={0}
                                    max={10}
                                    value={draft.decimals ?? 0}
                                    onChange={(e) =>
                                        setDraft({
                                            type: "percent",
                                            decimals: Math.max(
                                                0,
                                                Math.min(10, Number(e.target.value) || 0),
                                            ),
                                        })
                                    }
                                    className="h-8 text-xs"
                                />
                                <div className="text-[10px] text-muted-foreground">
                                    Stored as a multiplier (0.125 → 12.5%).
                                </div>
                            </div>
                        )}
                        {draft.type === "custom" && (
                            <>
                                <NumberOptions
                                    decimals={draft.decimals ?? 0}
                                    thousands={draft.thousands ?? true}
                                    onChange={(d, t) =>
                                        setDraft({ ...draft, decimals: d, thousands: t })
                                    }
                                />
                                <div className="grid grid-cols-2 gap-2">
                                    <div className="space-y-1">
                                        <Label className="text-xs">Prefix</Label>
                                        <Input
                                            value={draft.prefix ?? ""}
                                            placeholder="e.g. ≈"
                                            onChange={(e) =>
                                                setDraft({
                                                    ...draft,
                                                    prefix: e.target.value,
                                                })
                                            }
                                            className="h-8 text-xs"
                                        />
                                    </div>
                                    <div className="space-y-1">
                                        <Label className="text-xs">Suffix</Label>
                                        <Input
                                            value={draft.suffix ?? ""}
                                            placeholder="e.g.  kg"
                                            onChange={(e) =>
                                                setDraft({
                                                    ...draft,
                                                    suffix: e.target.value,
                                                })
                                            }
                                            className="h-8 text-xs"
                                        />
                                    </div>
                                </div>
                            </>
                        )}
                        {draft.type === "text" && (
                            <div className="text-xs text-muted-foreground pt-1">
                                Show the cell value as-is. No number parsing.
                            </div>
                        )}
                    </div>
                </div>

            <DialogFooter className="gap-2 sm:gap-2">
                <Button
                    variant="ghost"
                    onClick={() => onApply(undefined)}
                    title="Remove formatting from this column"
                >
                    Clear format
                </Button>
                <Button variant="outline" onClick={onClose}>
                    Cancel
                </Button>
                <Button onClick={() => onApply(draft)}>Apply</Button>
            </DialogFooter>
        </>
    );
}

function NumberOptions({
    decimals,
    thousands,
    onChange,
}: {
    decimals: number;
    thousands: boolean;
    onChange: (decimals: number, thousands: boolean) => void;
}) {
    return (
        <div className="space-y-2">
            <div className="space-y-1">
                <Label className="text-xs">Decimals</Label>
                <Input
                    type="number"
                    min={0}
                    max={10}
                    value={decimals}
                    onChange={(e) => {
                        const next = Math.max(
                            0,
                            Math.min(10, Number(e.target.value) || 0),
                        );
                        onChange(next, thousands);
                    }}
                    className="h-8 text-xs"
                />
            </div>
            <label className="flex items-center gap-2 text-xs cursor-pointer">
                <Checkbox
                    checked={thousands}
                    onCheckedChange={(v) => onChange(decimals, v === true)}
                />
                <span>Thousands separator (1,234)</span>
            </label>
        </div>
    );
}
