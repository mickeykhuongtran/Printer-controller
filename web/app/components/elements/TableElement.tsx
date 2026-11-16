"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
    AlignCenter,
    AlignLeft,
    AlignRight,
    Bold,
    RotateCcw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { fontStackFor } from "../../fonts";
import { inverseRotateVector, logicalSize, rotationFrame } from "../../rotation";
import type { TableCellStyle, TableEl, TextAlign } from "../../types";
import type { VariableSuggestion } from "../HighlightedField";

const MONO_STACK =
    '"Andale Mono", "Liberation Mono", "DejaVu Sans Mono", "Lucida Sans Typewriter", "Menlo", "Consolas", monospace';

function pointerAxis(x: number, y: number, axis: "col" | "row", rotation: number | undefined): number {
    const local = inverseRotateVector({ x, y }, rotation);
    return axis === "col" ? local.x : local.y;
}

// Match any {ident} placeholder. Resolution: known names get blue, unknown
// names get red so the user sees typos immediately.
const ANY_VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const BUILTIN_NAMES = new Set([
    "serial",
    "step",
    "n",
    "counter",
    "index",
]);

function renderHighlighted(
    text: string,
    knownNames: Set<string>,
): React.ReactNode {
    if (!text) return null;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let i = 0;
    const re = new RegExp(ANY_VAR_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
        if (match.index > lastIndex) {
            parts.push(<span key={i++}>{text.slice(lastIndex, match.index)}</span>);
        }
        const name = match[1];
        const known =
            BUILTIN_NAMES.has(name.toLowerCase()) || knownNames.has(name);
        parts.push(
            <span
                key={i++}
                style={
                    known
                        ? {
                              color: "#1d4ed8",
                              fontWeight: 700,
                              background: "rgba(59, 130, 246, 0.12)",
                              borderRadius: 3,
                              padding: "0 2px",
                          }
                        : {
                              color: "#b91c1c",
                              fontWeight: 700,
                              background: "rgba(220, 38, 38, 0.12)",
                              borderRadius: 3,
                              padding: "0 2px",
                          }
                }
            >
                {match[0]}
            </span>,
        );
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
        parts.push(<span key={i++}>{text.slice(lastIndex)}</span>);
    }
    return parts;
}

interface Props {
    el: TableEl;
    pxPerMm: number;
    editing: boolean;
    // When true, internal column/row separators are rendered so the user
    // can drag them like Excel. False on the print preview / read-only
    // canvas. Also gated by scaleMode (no separators in "auto").
    selected?: boolean;
    highlightVars?: boolean;
    variables?: VariableSuggestion[];
    // When true, the cell click-to-edit handlers are wired and the grid is
    // visually highlighted as interactive. The Print step / read-only canvas
    // sets this to false.
    interactive?: boolean;
    // Set by the parent on dblclick to pre-focus the specific cell that was
    // double-clicked. Consumed once per change.
    requestEditCell?: { r: number; c: number } | null;
    onChangeCell?: (row: number, col: number, value: string) => void;
    // General-purpose patch dispatch for things bigger than cell content
    // (inner-separator drag changes colWidths / rowHeights / size).
    onUpdate?: (patch: Partial<TableEl>) => void;
    // Fires when the user closes a cell editor without immediately moving
    // to another cell (Enter / Escape / blur). The parent clears its
    // editingId so resize handles and column/row separators reappear.
    onEndEdit?: () => void;
}

export function TableElement(props: Props) {
    const frame = rotationFrame({ w: props.el.size.w * props.pxPerMm, h: props.el.size.h * props.pxPerMm }, props.el.rotation);
    return (
        <div style={frame.style}>
            <TableContent {...props}
                el={{ ...props.el, size: logicalSize(props.el.size, props.el.rotation) }}
                onUpdate={props.onUpdate ? patch => props.onUpdate?.({ ...patch,
                    ...(patch.size ? { size: logicalSize(patch.size, props.el.rotation) } : {}),
                }) : undefined}
            />
        </div>
    );
}

function TableContent({
    el,
    pxPerMm,
    editing,
    selected = false,
    highlightVars = false,
    variables,
    interactive = true,
    requestEditCell = null,
    onChangeCell,
    onUpdate,
    onEndEdit,
}: Props) {
    const knownNames = useMemo(
        () => new Set((variables ?? []).map((v) => v.name)),
        [variables],
    );

    const widthPx = el.size.w * pxPerMm;
    const heightPx = el.size.h * pxPerMm;
    const fontPx = Math.max(6, el.fontSizeMm * pxPerMm);
    const paddingPx = Math.max(0, el.padding * pxPerMm);
    const borderPx = el.borderThickness > 0
        ? Math.max(1, el.borderThickness * pxPerMm)
        : 0;
    const align: TextAlign = el.align ?? "left";

    // Per-row / per-column pixel sizes derived from the el's mm fields.
    // These already reflect whatever scale-mode logic the resize reducer
    // applied; we just render them.
    const colPx = useMemo(
        () => el.colWidths.map((w) => w * pxPerMm),
        [el.colWidths, pxPerMm],
    );
    const rowPx = useMemo(
        () => el.rowHeights.map((h) => h * pxPerMm),
        [el.rowHeights, pxPerMm],
    );

    // Inline cell editor state. Click a cell while the table is selected to
    // edit it in place. Esc / blur commits. When `editing` flips off the
    // cell editor is hidden via the render gate (`editing && editCell`),
    // so we don't need a state-sync effect to clear it.
    const [editCell, setEditCell] = useState<{ r: number; c: number } | null>(
        null,
    );
    // Render-time sync: when the parent supplies a new requestEditCell
    // (e.g. user double-clicked a specific cell on the canvas), seed the
    // editor with it without bouncing through useEffect.
    const [lastRequest, setLastRequest] = useState<typeof requestEditCell>(null);
    if (requestEditCell !== lastRequest) {
        setLastRequest(requestEditCell);
        if (requestEditCell) setEditCell(requestEditCell);
    }
    const editorRef = useRef<HTMLTextAreaElement | null>(null);

    useEffect(() => {
        if (editCell && editorRef.current) {
            const node = editorRef.current;
            node.focus();
            const len = node.value.length;
            try {
                node.setSelectionRange(len, len);
            } catch {
                /* ignore */
            }
        }
    }, [editCell]);

    const cellAt = (r: number, c: number): string => {
        const idx = r * el.cols + c;
        return el.cells[idx] ?? "";
    };

    // Inner-separator drag (Excel-style column / row sizing). Active when
    // the table is selected, not editing a cell, and the scaleMode allows
    // changes along that axis. Outer ElementBox is unaware of these — they
    // dispatch updates via `onUpdate`.
    const dragSepRef = useRef<{
        kind: "col" | "row";
        index: number;
        startClient: number;
        startSizes: number[];
        pointerId: number;
    } | null>(null);

    const beginSepDrag =
        (kind: "col" | "row", index: number) =>
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (!onUpdate) return;
            e.stopPropagation();
            e.preventDefault();
            dragSepRef.current = {
                kind,
                index,
                startClient: pointerAxis(e.clientX, e.clientY, kind, el.rotation),
                startSizes:
                    kind === "col" ? el.colWidths.slice() : el.rowHeights.slice(),
                pointerId: e.pointerId,
            };
            try {
                e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
                /* ignore */
            }
        };

    const onSepMove = (e: React.PointerEvent<HTMLDivElement>) => {
        const start = dragSepRef.current;
        if (!start || !onUpdate) return;
        const client = pointerAxis(e.clientX, e.clientY, start.kind, el.rotation);
        let delta = (client - start.startClient) / pxPerMm;
        const minSize = 1;
        const sizes = start.startSizes.slice();
        const i = start.index;

        if (el.scaleMode === "fixed") {
            // Steal from / give to the next cell. Total stays constant.
            const cur = sizes[i];
            const nxt = sizes[i + 1];
            // Clamp delta so neither side falls below minSize.
            if (delta > nxt - minSize) delta = nxt - minSize;
            if (delta < -(cur - minSize)) delta = -(cur - minSize);
            sizes[i] = cur + delta;
            sizes[i + 1] = nxt - delta;
        } else {
            const cur = sizes[i];
            if (delta < -(cur - minSize)) delta = -(cur - minSize);
            sizes[i] = cur + delta;
        }

        if (start.kind === "col") {
            const patch: Partial<TableEl> = { colWidths: sizes };
            if (el.scaleMode !== "fixed") {
                patch.size = {
                    ...el.size,
                    w: sizes.reduce((s, x) => s + x, 0),
                };
            }
            onUpdate(patch);
        } else {
            const patch: Partial<TableEl> = { rowHeights: sizes };
            if (el.scaleMode !== "fixed") {
                patch.size = {
                    ...el.size,
                    h: sizes.reduce((s, x) => s + x, 0),
                };
            }
            onUpdate(patch);
        }
    };

    const endSepDrag = (e: React.PointerEvent<HTMLDivElement>) => {
        const start = dragSepRef.current;
        if (start) {
            try {
                e.currentTarget.releasePointerCapture(start.pointerId);
            } catch {
                /* ignore */
            }
        }
        dragSepRef.current = null;
    };

    // Which separators are draggable depends on the scaleMode. "auto" means
    // size is content-driven, so user-resizable separators don't make sense.
    const showColSep =
        selected &&
        !editing &&
        interactive &&
        (el.scaleMode === "all" ||
            el.scaleMode === "cols" ||
            el.scaleMode === "fixed");
    const showRowSep =
        selected &&
        !editing &&
        interactive &&
        (el.scaleMode === "all" ||
            el.scaleMode === "rows" ||
            el.scaleMode === "fixed");

    // Cumulative pixel offsets for the interior boundaries.
    const colBoundaries: number[] = [];
    {
        let acc = 0;
        for (let c = 0; c < el.cols - 1; c += 1) {
            acc += colPx[c] ?? 0;
            colBoundaries.push(acc);
        }
    }
    const rowBoundaries: number[] = [];
    {
        let acc = 0;
        for (let r = 0; r < el.rows - 1; r += 1) {
            acc += rowPx[r] ?? 0;
            rowBoundaries.push(acc);
        }
    }

    // Excel-style double-click on a column / row separator: auto-fit that
    // single column or row to its widest / tallest content. Approximates
    // glyph metrics with the same monospace ratios autoFitTable uses, so
    // the result matches the table's intrinsic auto layout.
    const MONO_CHAR_W = 0.6;
    const MONO_LINE_H = 1.1;
    const cellFont = (r: number, c: number) =>
        el.cellStyles?.[r * el.cols + c]?.fontSizeMm ?? el.fontSizeMm;
    const idealColWidthMm = (c: number): number => {
        let widestMm = 0;
        for (let r = 0; r < el.rows; r += 1) {
            const v = el.cells[r * el.cols + c] ?? "";
            const widestLine = v
                .split(/\n/)
                .reduce((m, line) => Math.max(m, line.length), 1);
            widestMm = Math.max(
                widestMm,
                widestLine * cellFont(r, c) * MONO_CHAR_W,
            );
        }
        return Math.max(2, widestMm + el.padding * 2);
    };
    const idealRowHeightMm = (r: number): number => {
        let tallestMm = 0;
        for (let c = 0; c < el.cols; c += 1) {
            const v = el.cells[r * el.cols + c] ?? "";
            const lines = v === "" ? 1 : v.split(/\n/).length;
            tallestMm = Math.max(
                tallestMm,
                lines * cellFont(r, c) * MONO_LINE_H,
            );
        }
        return Math.max(2, tallestMm + el.padding * 2);
    };

    const autoFitCol = (c: number) => {
        if (!onUpdate) return;
        const next = el.colWidths.slice();
        const target = idealColWidthMm(c);
        if (el.scaleMode === "fixed") {
            // Outer locked: absorb the delta from the neighbor column so
            // the table's total width stays the same.
            const delta = target - (next[c] ?? 0);
            const neighbor = c + 1 < el.cols ? c + 1 : c - 1;
            if (neighbor >= 0 && neighbor < el.cols) {
                const newNeighbor = Math.max(1, (next[neighbor] ?? 0) - delta);
                const consumed = (next[neighbor] ?? 0) - newNeighbor;
                next[c] = (next[c] ?? 0) + consumed;
                next[neighbor] = newNeighbor;
            }
            onUpdate({ colWidths: next });
        } else {
            next[c] = target;
            onUpdate({
                colWidths: next,
                size: { ...el.size, w: next.reduce((s, x) => s + x, 0) },
            });
        }
    };

    const autoFitRow = (r: number) => {
        if (!onUpdate) return;
        const next = el.rowHeights.slice();
        const target = idealRowHeightMm(r);
        if (el.scaleMode === "fixed") {
            const delta = target - (next[r] ?? 0);
            const neighbor = r + 1 < el.rows ? r + 1 : r - 1;
            if (neighbor >= 0 && neighbor < el.rows) {
                const newNeighbor = Math.max(1, (next[neighbor] ?? 0) - delta);
                const consumed = (next[neighbor] ?? 0) - newNeighbor;
                next[r] = (next[r] ?? 0) + consumed;
                next[neighbor] = newNeighbor;
            }
            onUpdate({ rowHeights: next });
        } else {
            next[r] = target;
            onUpdate({
                rowHeights: next,
                size: { ...el.size, h: next.reduce((s, x) => s + x, 0) },
            });
        }
    };

    // Patch helper for the floating toolbar — merge a TableCellStyle delta
    // into the currently-edited cell.
    const updateEditCellStyle = (delta: Partial<TableCellStyle>) => {
        if (!editCell || !onUpdate) return;
        const total = el.rows * el.cols;
        const next: Array<TableCellStyle | undefined> = (
            el.cellStyles ?? new Array(total)
        ).slice();
        while (next.length < total) next.push(undefined);
        const idx = editCell.r * el.cols + editCell.c;
        const merged: TableCellStyle = { ...(next[idx] ?? {}), ...delta };
        const nonEmpty = Object.entries(merged).some(
            ([, v]) => v !== undefined,
        );
        next[idx] = nonEmpty ? merged : undefined;
        onUpdate({ cellStyles: next });
    };

    const clearEditCellStyle = () => {
        if (!editCell || !onUpdate || !el.cellStyles) return;
        const next = el.cellStyles.slice();
        const idx = editCell.r * el.cols + editCell.c;
        next[idx] = undefined;
        onUpdate({ cellStyles: next });
    };

    // Active-cell metrics for positioning the floating toolbar.
    let activeStyle: TableCellStyle | undefined;
    let activeTopPx = 0;
    let activeLeftPx = 0;
    let activeWidthPx = 0;
    if (editCell) {
        activeStyle = el.cellStyles?.[editCell.r * el.cols + editCell.c];
        activeTopPx = rowPx
            .slice(0, editCell.r)
            .reduce((s, h) => s + h, 0);
        activeLeftPx = colPx
            .slice(0, editCell.c)
            .reduce((s, w) => s + w, 0);
        activeWidthPx = colPx[editCell.c] ?? 0;
    }
    const toolbarHeight = 36;
    // Default to above the cell. If that would clip past the top of the
    // table outer (rare but happens when editing the first row), drop it
    // below the cell instead.
    const toolbarAbove = activeTopPx >= toolbarHeight + 6;
    const toolbarTop = toolbarAbove
        ? activeTopPx - toolbarHeight - 6
        : activeTopPx + (rowPx[editCell?.r ?? 0] ?? 0) + 6;
    const showToolbar = editing && editCell && interactive && onUpdate;
    const activeHeader = editCell?.r === 0 && el.headerRow === true;
    const tbBold = activeStyle?.bold ?? activeHeader ?? false;
    const tbAlign: TextAlign = activeStyle?.align ?? align;

    return (
        <div
            className="relative text-black"
            style={{
                width: widthPx,
                height: heightPx,
                // Outer border. Inner separators are drawn per-cell so we
                // don't double-up at the seams.
                boxSizing: "border-box",
                border: borderPx > 0 ? `${borderPx}px solid #000` : undefined,
                // Each cell sets its own font-family below — the outer
                // div just provides a sensible fallback for any text that
                // somehow lands here (it shouldn't).
                fontFamily: MONO_STACK,
                fontSize: `${fontPx}px`,
                lineHeight: 1.1,
                userSelect: "none",
                // Cell content is clipped to the inner grid (below). Outer
                // is overflow:visible so the floating cell toolbar can
                // extend above the table.
            }}
        >
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns: colPx.map((w) => `${w}px`).join(" "),
                    gridTemplateRows: rowPx.map((h) => `${h}px`).join(" "),
                    width: "100%",
                    height: "100%",
                    overflow: "hidden",
                }}
            >
                {Array.from({ length: el.rows }).map((_, r) =>
                    Array.from({ length: el.cols }).map((__, c) => {
                        const value = cellAt(r, c);
                        const isHeader = r === 0 && el.headerRow === true;
                        const isEditing =
                            editing &&
                            editCell?.r === r &&
                            editCell?.c === c &&
                            interactive;
                        // Per-cell formatting: anything not set on the
                        // cell falls back to the table-level setting.
                        const style = el.cellStyles?.[r * el.cols + c];
                        const cellBold = style?.bold ?? isHeader;
                        const cellAlign: TextAlign = style?.align ?? align;
                        const cellFontMm =
                            typeof style?.fontSizeMm === "number"
                                ? style.fontSizeMm
                                : el.fontSizeMm;
                        const cellFontPx = Math.max(6, cellFontMm * pxPerMm);
                        const cellColor = style?.color ?? "#000";
                        // Font: cell override → table default → "zpl"
                        // (the bitmap monospace stack — what the printer
                        // actually renders).
                        const cellFontSource =
                            style?.fontSource ?? el.fontSource ?? "zpl";
                        const cellFontFamily =
                            cellFontSource === "zpl"
                                ? MONO_STACK
                                : fontStackFor(
                                      cellFontSource,
                                      style?.fontFamily ??
                                          el.fontFamily,
                                  );
                        // fontWeight precedence: cell explicit → cell bold
                        // toggle → table explicit → 400 default.
                        const cellFontWeight =
                            style?.fontWeight ??
                            (cellBold ? 700 : el.fontWeight ?? 400);
                        return (
                            <div
                                key={`${r}-${c}`}
                                onPointerDown={(e) => {
                                    if (!editing || !interactive) return;
                                    // While the table itself is selected, a
                                    // click on a cell should not start a
                                    // drag/move on the parent. ElementBox
                                    // already swallows in editing mode but
                                    // this protects against the "selected
                                    // but not yet editing" case.
                                    e.stopPropagation();
                                    setEditCell({ r, c });
                                }}
                                style={{
                                    padding: paddingPx,
                                    borderRight:
                                        borderPx > 0 && c < el.cols - 1
                                            ? `${borderPx}px solid #000`
                                            : undefined,
                                    borderBottom:
                                        borderPx > 0 && r < el.rows - 1
                                            ? `${borderPx}px solid #000`
                                            : undefined,
                                    fontFamily: cellFontFamily,
                                    fontWeight: cellFontWeight,
                                    fontSize: `${cellFontPx}px`,
                                    color: cellColor,
                                    textAlign: cellAlign,
                                    overflow: "hidden",
                                    whiteSpace: "pre",
                                    cursor:
                                        editing && interactive
                                            ? "text"
                                            : undefined,
                                    boxSizing: "border-box",
                                    display: "flex",
                                    alignItems: "flex-start",
                                    justifyContent:
                                        cellAlign === "center"
                                            ? "center"
                                            : cellAlign === "right"
                                              ? "flex-end"
                                              : "flex-start",
                                }}
                            >
                                {isEditing ? (
                                    <textarea
                                        ref={editorRef}
                                        value={value}
                                        onChange={(e) =>
                                            onChangeCell?.(r, c, e.target.value)
                                        }
                                        onPointerDown={(e) =>
                                            e.stopPropagation()
                                        }
                                        onBlur={(e) => {
                                            // If focus moved into the
                                            // floating toolbar (e.g. user
                                            // clicked the font-size input),
                                            // keep the cell editor active so
                                            // the toolbar doesn't tear down
                                            // before they can interact.
                                            const next =
                                                e.relatedTarget as HTMLElement | null;
                                            if (
                                                next &&
                                                next.closest(
                                                    "[data-table-cell-toolbar]",
                                                )
                                            ) {
                                                return;
                                            }
                                            setEditCell(null);
                                            onEndEdit?.();
                                        }}
                                        onKeyDown={(e) => {
                                            const mod = e.metaKey || e.ctrlKey;
                                            const k = e.key.toLowerCase();
                                            // Cmd/Ctrl + B → toggle bold.
                                            // No italic — ZPL bitmap fonts
                                            // are upright-only.
                                            if (mod && k === "b") {
                                                e.preventDefault();
                                                updateEditCellStyle({
                                                    bold: !tbBold,
                                                });
                                                e.stopPropagation();
                                                return;
                                            }
                                            // Cmd/Ctrl + "+" / "-" → bump
                                            // this cell's font size in 0.5
                                            // mm increments. Overrides the
                                            // table-level shortcut so the
                                            // change stays scoped to the
                                            // active cell while editing.
                                            if (
                                                mod &&
                                                (e.key === "+" ||
                                                    e.key === "=" ||
                                                    e.key === "-" ||
                                                    e.key === "_")
                                            ) {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                const isPlus =
                                                    e.key === "+" ||
                                                    e.key === "=";
                                                const delta = isPlus ? 0.5 : -0.5;
                                                const cur =
                                                    typeof style?.fontSizeMm ===
                                                    "number"
                                                        ? style.fontSizeMm
                                                        : el.fontSizeMm;
                                                const nextSize =
                                                    Math.round(
                                                        Math.max(
                                                            0.5,
                                                            Math.min(
                                                                40,
                                                                cur + delta,
                                                            ),
                                                        ) * 100,
                                                    ) / 100;
                                                if (nextSize !== cur) {
                                                    updateEditCellStyle({
                                                        fontSizeMm: nextSize,
                                                    });
                                                }
                                                return;
                                            }
                                            if (
                                                e.key === "Escape" ||
                                                (e.key === "Enter" && !e.shiftKey)
                                            ) {
                                                e.preventDefault();
                                                setEditCell(null);
                                                onEndEdit?.();
                                            }
                                            // Tab → move to next cell.
                                            if (e.key === "Tab") {
                                                e.preventDefault();
                                                const totalCells =
                                                    el.rows * el.cols;
                                                const cur = r * el.cols + c;
                                                const delta = e.shiftKey ? -1 : 1;
                                                const next =
                                                    (cur + delta + totalCells) %
                                                    totalCells;
                                                setEditCell({
                                                    r: Math.floor(next / el.cols),
                                                    c: next % el.cols,
                                                });
                                            }
                                            e.stopPropagation();
                                        }}
                                        style={{
                                            width: "100%",
                                            height: "100%",
                                            border: "1px solid #2563eb",
                                            outline: "none",
                                            resize: "none",
                                            font: "inherit",
                                            fontFamily: cellFontFamily,
                                            fontWeight: cellFontWeight,
                                            fontSize: `${cellFontPx}px`,
                                            color: cellColor,
                                            background: "rgba(59, 130, 246, 0.06)",
                                            padding: 0,
                                            margin: 0,
                                            textAlign: cellAlign,
                                        }}
                                    />
                                ) : (
                                    <span
                                        className={cn(
                                            "block min-w-0",
                                            value === "" && "opacity-30",
                                        )}
                                        style={{ width: "100%" }}
                                    >
                                        {value === "" ? (
                                            <span>&nbsp;</span>
                                        ) : highlightVars ? (
                                            renderHighlighted(value, knownNames)
                                        ) : (
                                            value
                                        )}
                                    </span>
                                )}
                            </div>
                        );
                    }),
                )}
            </div>

            {showColSep &&
                colBoundaries.map((leftPx, i) => (
                    <div
                        key={`vsep-${i}`}
                        title="Drag to resize column"
                        className="group absolute"
                        style={{
                            // Generous 18px hit zone so the user doesn't
                            // have to pixel-hunt for a thin border line.
                            left: leftPx - 9,
                            top: 0,
                            width: 18,
                            height: "100%",
                            cursor: "col-resize",
                            // Re-enable pointer events even though the
                            // ElementBox wrapper has pointer-events: none
                            // outside of editing mode.
                            pointerEvents: "auto",
                            zIndex: 4,
                        }}
                        onPointerDown={beginSepDrag("col", i)}
                        onPointerMove={onSepMove}
                        onPointerUp={endSepDrag}
                        onPointerCancel={endSepDrag}
                        onDoubleClick={(e) => {
                            // Excel-style: dblclick the separator
                            // auto-fits the column on its LEFT.
                            e.stopPropagation();
                            e.preventDefault();
                            autoFitCol(i);
                        }}
                    >
                        {/* Always-visible thin guide so the user knows the
                            border is grabbable; thickens on hover. */}
                        <div
                            className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 bg-blue-500/40 group-hover:bg-blue-500 group-active:bg-blue-700 transition-all"
                            style={{ width: 3 }}
                        />
                        {/* Center grip marker to make the affordance
                            obvious from a glance. */}
                        <div
                            className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-blue-500 ring-1 ring-white shadow-sm group-hover:bg-blue-600 transition-colors"
                            style={{ width: 8, height: 18 }}
                        />
                    </div>
                ))}

            {showToolbar && editCell && (
                <div
                    data-table-cell-toolbar
                    // Stop pointerdown so the underlying cell beneath the
                    // toolbar doesn't get a "select me" hit. The textarea's
                    // onBlur uses [data-table-cell-toolbar] to keep the
                    // editor open when focus moves into the toolbar.
                    onPointerDown={(e) => e.stopPropagation()}
                    className="absolute flex items-center gap-1 px-1.5 py-1 rounded-[8px] bg-popover/95 backdrop-blur ring-1 ring-black/[0.1] dark:ring-white/15 shadow-lg"
                    style={{
                        top: toolbarTop,
                        left: Math.max(0, activeLeftPx),
                        zIndex: 6,
                        // Don't let the toolbar wider than ~3 buttons fall
                        // outside the table on narrow cells — clamp left.
                        maxWidth: Math.max(160, activeWidthPx + 200),
                        pointerEvents: "auto",
                    }}
                >
                    <ToolbarButton
                        active={tbBold}
                        onPress={() =>
                            updateEditCellStyle({ bold: !tbBold })
                        }
                        title="Bold"
                    >
                        <Bold className="w-3.5 h-3.5" />
                    </ToolbarButton>

                    <span className="w-px h-5 bg-black/[0.08] dark:bg-white/10 mx-0.5" />

                    {(
                        [
                            { v: "left", icon: <AlignLeft className="w-3.5 h-3.5" /> },
                            { v: "center", icon: <AlignCenter className="w-3.5 h-3.5" /> },
                            { v: "right", icon: <AlignRight className="w-3.5 h-3.5" /> },
                        ] as { v: TextAlign; icon: React.ReactNode }[]
                    ).map(({ v, icon }) => (
                        <ToolbarButton
                            key={v}
                            active={tbAlign === v}
                            onPress={() => updateEditCellStyle({ align: v })}
                            title={`Align ${v}`}
                        >
                            {icon}
                        </ToolbarButton>
                    ))}

                    <span className="w-px h-5 bg-black/[0.08] dark:bg-white/10 mx-0.5" />

                    <input
                        type="number"
                        step={0.5}
                        min={1}
                        max={20}
                        value={Number(
                            (typeof activeStyle?.fontSizeMm === "number"
                                ? activeStyle.fontSizeMm
                                : el.fontSizeMm
                            ).toFixed(2),
                        )}
                        onChange={(e) => {
                            const n = Number(e.target.value);
                            if (Number.isFinite(n))
                                updateEditCellStyle({
                                    fontSizeMm: Math.round(n * 100) / 100,
                                });
                        }}
                        className="h-7 w-14 px-1.5 text-xs rounded-[6px] bg-background ring-1 ring-black/[0.08] dark:ring-white/10 focus:outline-none focus:ring-blue-500"
                        title="Font size (mm)"
                    />

                    {activeStyle && (
                        <>
                            <span className="w-px h-5 bg-black/[0.08] dark:bg-white/10 mx-0.5" />
                            <ToolbarButton
                                active={false}
                                onPress={clearEditCellStyle}
                                title="Reset cell formatting"
                            >
                                <RotateCcw className="w-3.5 h-3.5" />
                            </ToolbarButton>
                        </>
                    )}
                </div>
            )}

            {showRowSep &&
                rowBoundaries.map((topPx, i) => (
                    <div
                        key={`hsep-${i}`}
                        title="Drag to resize row"
                        className="group absolute"
                        style={{
                            top: topPx - 9,
                            left: 0,
                            height: 18,
                            width: "100%",
                            cursor: "row-resize",
                            pointerEvents: "auto",
                            zIndex: 4,
                        }}
                        onPointerDown={beginSepDrag("row", i)}
                        onPointerMove={onSepMove}
                        onPointerUp={endSepDrag}
                        onPointerCancel={endSepDrag}
                        onDoubleClick={(e) => {
                            // Excel-style: dblclick the separator
                            // auto-fits the row ABOVE.
                            e.stopPropagation();
                            e.preventDefault();
                            autoFitRow(i);
                        }}
                    >
                        <div
                            className="absolute left-0 right-0 top-1/2 -translate-y-1/2 bg-blue-500/40 group-hover:bg-blue-500 group-active:bg-blue-700 transition-all"
                            style={{ height: 3 }}
                        />
                        <div
                            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-sm bg-blue-500 ring-1 ring-white shadow-sm group-hover:bg-blue-600 transition-colors"
                            style={{ width: 18, height: 8 }}
                        />
                    </div>
                ))}
        </div>
    );
}

function ToolbarButton({
    active,
    onPress,
    title,
    children,
}: {
    active: boolean;
    onPress: () => void;
    title: string;
    children: React.ReactNode;
}) {
    return (
        <button
            type="button"
            title={title}
            // Use mousedown+preventDefault so clicks on the toolbar do NOT
            // blur the cell's textarea (which would dismiss the editor).
            // The actual action runs on click, after preventDefault.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onPress}
            className={cn(
                "h-7 w-7 rounded-[6px] flex items-center justify-center transition-colors",
                active
                    ? "bg-primary text-primary-foreground"
                    : "text-foreground/80 hover:bg-muted",
            )}
        >
            {children}
        </button>
    );
}
