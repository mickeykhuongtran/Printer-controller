import { isQuarterTurn, logicalSize, rotateTemplate } from "./rotation";
import { normalizeLineStroke } from "./line-geometry";
import type {
    DataColumn,
    DataFeed,
    DataRow,
    DesignerAction,
    DesignerState,
    LabelDoc,
    LabelElement,
    Size,
    TableEl,
    Vec,
} from "./types";
import { isBuiltInVar } from "./data-feed";
import { uid } from "./units";

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// Pulls every {var} placeholder out of an element list (text + 2D + barcode
// data fields), preserving first-seen order so generated columns line up with
// how the template reads top-to-bottom.
function placeholderNamesIn(elements: LabelElement[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    const scan = (src: string) => {
        PLACEHOLDER_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = PLACEHOLDER_RE.exec(src)) !== null) {
            const name = m[1];
            const key = name.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                out.push(name);
            }
        }
    };
    for (const el of elements) {
        if (el.kind === "text") scan(el.text);
        else if (el.kind === "qr") scan(el.data);
        else if (el.kind === "barcode") scan(el.data);
        else if (el.kind === "datamatrix") scan(el.data);
        else if (el.kind === "table") {
            for (const cell of el.cells) {
                if (cell) scan(cell);
            }
        }
    }
    return out;
}

// Adds a column for every placeholder used in the elements that isn't a
// built-in (serial/step/etc) or already in the feed. Run on template load so
// the user doesn't have to manually add {sku}, {price}, etc. before the
// placeholders resolve.
function declaredBindingNames(
    doc: Pick<LabelDoc, "templateFields" | "elements" | "settings">,
): Set<string> {
    const declared = new Set<string>();
    const add = (name: string | undefined) => {
        const normalized = (name ?? "").trim().replace(/^\{|\}$/g, "");
        if (normalized) declared.add(normalized.toLowerCase());
    };
    for (const field of doc.templateFields ?? []) add(field.name);
    for (const element of doc.elements) {
        if ("fieldName" in element) add(element.fieldName);
    }
    add(doc.settings.rfid.fieldName);
    if (doc.settings.rfid.readEnabled) {
        add(doc.settings.rfid.readFieldName ?? "rfid_read");
    }
    return declared;
}

function ensureTemplateColumns(
    feed: DataFeed,
    elements: LabelElement[],
    declaredNames: ReadonlySet<string> = new Set(),
): DataFeed {
    const existing = new Set([
        ...feed.columns.map((c) => c.name.toLowerCase()),
        ...declaredNames,
    ]);
    const toAdd: string[] = [];
    for (const name of placeholderNamesIn(elements)) {
        const key = name.toLowerCase();
        if (isBuiltInVar(key)) continue;
        if (existing.has(key)) continue;
        existing.add(key);
        toAdd.push(name);
    }
    if (toAdd.length === 0) return feed;
    return {
        ...feed,
        columns: [...feed.columns, ...toAdd.map((n) => makeColumn(n))],
    };
}

function emptyFeed(): DataFeed {
    return { columns: [], rows: [] };
}

// A fresh feed starts with a single `step` column whose value is the 1-based
// row index, and 5 empty rows so the user immediately sees {step} = 1..5
// without having to click "+ Row" first.
//
// `step` is marked `system: true` — it can't be renamed, reformulated, or
// deleted because it's tied to the built-in serial counter.
const DEFAULT_ROW_COUNT = 5;

export function defaultDataFeed(): DataFeed {
    return {
        columns: [
            { id: "col_step", name: "step", formula: "=ROW()", system: true },
        ],
        rows: Array.from({ length: DEFAULT_ROW_COUNT }, () => makeRow()),
    };
}

function feedOf(state: DesignerState): DataFeed {
    return state.doc.dataFeed ?? emptyFeed();
}

function withFeed(state: DesignerState, next: DataFeed): DesignerState {
    return { ...state, doc: { ...state.doc, dataFeed: next } };
}

function uniqueColumnName(feed: DataFeed, base: string): string {
    let name = base;
    let i = 1;
    const taken = new Set(feed.columns.map((c) => c.name));
    while (taken.has(name)) {
        i += 1;
        name = `${base}_${i}`;
    }
    return name;
}

function cleanFieldName(value: string, fallback = "field"): string {
    const cleaned = value
        .trim()
        .replace(/[^A-Za-z0-9_]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    const safe = cleaned.length > 0 ? cleaned : fallback;
    return /^[A-Za-z_]/.test(safe) ? safe : `field_${safe}`;
}

function makeColumn(name: string): DataColumn {
    return { id: uid("col"), name: cleanFieldName(name, "field") };
}

function replacePlaceholder(value: string, fromName: string, toName: string): string {
    if (!value || fromName === toName) return value;
    return value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name) =>
        name.toLowerCase() === fromName.toLowerCase() ? `{${toName}}` : full,
    );
}

function replaceFieldName(
    value: string | undefined,
    fromName: string,
    toName: string,
): string | undefined {
    if (!value || fromName === toName) return value;
    return value.toLowerCase() === fromName.toLowerCase() ? toName : value;
}

function renameFieldBindings(
    elements: LabelElement[],
    fromName: string,
    toName: string,
): LabelElement[] {
    if (fromName === toName) return elements;
    return elements.map((el) => {
        if (el.kind === "text") {
            return {
                ...el,
                text: replacePlaceholder(el.text, fromName, toName),
                fieldName: replaceFieldName(el.fieldName, fromName, toName),
            };
        }
        if (el.kind === "qr") {
            return {
                ...el,
                data: replacePlaceholder(el.data, fromName, toName),
                fieldName: replaceFieldName(el.fieldName, fromName, toName),
            };
        }
        if (el.kind === "barcode") {
            return {
                ...el,
                data: replacePlaceholder(el.data, fromName, toName),
                fieldName: replaceFieldName(el.fieldName, fromName, toName),
            };
        }
        if (el.kind === "datamatrix") {
            return {
                ...el,
                data: replacePlaceholder(el.data, fromName, toName),
                fieldName: replaceFieldName(el.fieldName, fromName, toName),
            };
        }
        if (el.kind === "table") {
            return { ...el, cells: el.cells.map((cell) => replacePlaceholder(cell, fromName, toName)) };
        }
        return el;
    });
}

function ensureFirstRow(feed: DataFeed): DataFeed {
    if (feed.rows.length > 0) return feed;
    return { ...feed, rows: [makeRow()] };
}

function legacyRfidColumnIds(feed: DataFeed): Set<string> {
    return new Set(
        feed.columns
            .filter((col) => col.id === "col_rfid_epc_encode" || col.name.toLowerCase() === "rfid_epc_encode")
            .map((col) => col.id),
    );
}

function removeLegacyRfidColumn(feed: DataFeed): DataFeed {
    const ids = legacyRfidColumnIds(feed);
    if (ids.size === 0) return feed;
    return {
        ...feed,
        columns: feed.columns.filter((col) => !ids.has(col.id)),
        rows: feed.rows.map((row) => {
            const cells = { ...row.cells };
            for (const id of ids) delete cells[id];
            return { ...row, cells };
        }),
    };
}

function unprotectLegacyRfidColumn(feed: DataFeed): DataFeed {
    const ids = legacyRfidColumnIds(feed);
    if (ids.size === 0) return feed;
    return {
        ...feed,
        columns: feed.columns.map((col) =>
            ids.has(col.id) ? { ...col, protected: undefined } : col,
        ),
    };
}

function preferredRfidColumnName(feed: DataFeed): string | null {
    const preferred = ["rfid", "epc", "epc_hex", "rfid_epc", "rfid_epc_encode"];
    for (const name of preferred) {
        const col = feed.columns.find((c) => c.name.toLowerCase() === name);
        if (col && !col.system) return col.name;
    }
    return null;
}

function makeRow(): DataRow {
    // Rows default to unchecked — the data-feed sheet is for design / preview
    // only. The Print step has its own controls for which rows actually go to
    // the printer.
    return { id: uid("row"), cells: {} };
}

// When the label dimensions change, scale every element's pos/size to match.
// Stroke thicknesses and the legacy QR cell hint follow the smaller axis
// ratio. A manual QR magnification is a printer-dot contract and therefore
// must not be silently changed when physical geometry is resized.
function scaleElementsTo(
    elements: LabelElement[],
    oldW: number,
    oldH: number,
    newW: number,
    newH: number,
): LabelElement[] {
    if (oldW === newW && oldH === newH) return elements;
    if (oldW <= 0 || oldH <= 0) return elements;
    if (newW <= 0 || newH <= 0) return elements;
    const sx = newW / oldW;
    const sy = newH / oldH;
    const sMin = Math.min(sx, sy);
    return elements.map((el) => {
        const base = {
            ...el,
            pos: { x: el.pos.x * sx, y: el.pos.y * sy },
            size: { w: el.size.w * sx, h: el.size.h * sy },
        };
        if (el.kind === "rect" || el.kind === "line") {
            return { ...base, thickness: el.thickness * sMin };
        }
        if (el.kind === "qr") {
            const cell = Math.max(1, Math.round(el.cell * sMin));
            return { ...base, cell };
        }
        return base;
    });
}

// Approximate monospace metrics. We render tables with the same monospace
// stack as ZPL bitmap fonts, so each char takes ~0.6 EM horizontally and
// ~1.1 EM vertically. Good enough for auto-fit; the user can always switch
// to manual mode if they want pixel-exact sizing.
const MONO_CHAR_W_RATIO = 0.6;
const MONO_LINE_H_RATIO = 1.1;

// Recompute rowHeights / colWidths and the outer size so every cell's
// content fits exactly. Called whenever scaleMode is "auto" and something
// that affects layout changes (cells, fontSizeMm, padding, rows, cols).
function autoFitTable(el: TableEl): TableEl {
    const pad2 = el.padding * 2;
    const cellFs = (r: number, c: number) =>
        el.cellStyles?.[r * el.cols + c]?.fontSizeMm ?? el.fontSizeMm;
    const colWidths = new Array(el.cols).fill(0).map((_, c) => {
        let widestPx = 0;
        for (let r = 0; r < el.rows; r += 1) {
            const value = el.cells[r * el.cols + c] ?? "";
            const widestLine = value
                .split(/\n/)
                .reduce((m, line) => Math.max(m, line.length), 1);
            widestPx = Math.max(
                widestPx,
                widestLine * cellFs(r, c) * MONO_CHAR_W_RATIO,
            );
        }
        return Math.max(2, widestPx + pad2);
    });
    const rowHeights = new Array(el.rows).fill(0).map((_, r) => {
        let tallestPx = 0;
        for (let c = 0; c < el.cols; c += 1) {
            const value = el.cells[r * el.cols + c] ?? "";
            const lines = value === "" ? 1 : value.split(/\n/).length;
            tallestPx = Math.max(
                tallestPx,
                lines * cellFs(r, c) * MONO_LINE_H_RATIO,
            );
        }
        return Math.max(2, tallestPx + pad2);
    });
    const w = colWidths.reduce((s, x) => s + x, 0);
    const h = rowHeights.reduce((s, x) => s + x, 0);
    return { ...el, colWidths, rowHeights, size: { w, h } };
}

// Reshape a table when its row or column count changes: cell strings,
// rowHeights, and colWidths arrays all need to be padded or trimmed. New
// rows/cols inherit a default size derived from the current sizes (or a
// reasonable default when growing past empty).
function reshapeTable(
    el: TableEl,
    nextRows: number,
    nextCols: number,
): TableEl {
    const r = Math.max(1, Math.floor(nextRows));
    const c = Math.max(1, Math.floor(nextCols));
    if (r === el.rows && c === el.cols) return el;

    // Reshape cell array (row-major) preserving content at matching (r,c).
    const cells: string[] = new Array(r * c).fill("");
    for (let i = 0; i < Math.min(r, el.rows); i += 1) {
        for (let j = 0; j < Math.min(c, el.cols); j += 1) {
            cells[i * c + j] = el.cells[i * el.cols + j] ?? "";
        }
    }

    // Same reshape for the parallel cellStyles array, if present. Sparse
    // entries (`undefined`) survive — we just place them at the new index.
    let cellStyles: typeof el.cellStyles | undefined = undefined;
    if (el.cellStyles) {
        const next: typeof el.cellStyles = new Array(r * c);
        for (let i = 0; i < Math.min(r, el.rows); i += 1) {
            for (let j = 0; j < Math.min(c, el.cols); j += 1) {
                next[i * c + j] = el.cellStyles[i * el.cols + j];
            }
        }
        cellStyles = next;
    }

    const avgColW =
        el.colWidths.length > 0
            ? el.colWidths.reduce((s, x) => s + x, 0) / el.colWidths.length
            : el.size.w / Math.max(1, el.cols);
    const avgRowH =
        el.rowHeights.length > 0
            ? el.rowHeights.reduce((s, x) => s + x, 0) / el.rowHeights.length
            : el.size.h / Math.max(1, el.rows);

    let colWidths = el.colWidths.slice(0, c);
    while (colWidths.length < c) colWidths.push(avgColW);
    let rowHeights = el.rowHeights.slice(0, r);
    while (rowHeights.length < r) rowHeights.push(avgRowH);

    let next: TableEl = {
        ...el,
        rows: r,
        cols: c,
        cells,
        cellStyles,
        colWidths,
        rowHeights,
    };

    if (el.scaleMode === "fixed") {
        // Outer locked. Redistribute proportionally so the new col/row sizes
        // sum back to the original outer dimensions.
        const sumW = colWidths.reduce((s, x) => s + x, 0);
        const sumH = rowHeights.reduce((s, x) => s + x, 0);
        if (sumW > 0) colWidths = colWidths.map((w) => (w / sumW) * el.size.w);
        if (sumH > 0) rowHeights = rowHeights.map((h) => (h / sumH) * el.size.h);
        next = { ...next, colWidths, rowHeights };
    } else if (el.scaleMode !== "auto") {
        // Update outer size to match the new sums.
        next = {
            ...next,
            size: {
                w: colWidths.reduce((s, x) => s + x, 0),
                h: rowHeights.reduce((s, x) => s + x, 0),
            },
        };
    }

    if (next.scaleMode === "auto") return autoFitTable(next);
    return next;
}

// Run after applying a partial patch to a TableEl. Handles two follow-ups:
//   1. If rows/cols changed, reshape arrays so the cell grid stays consistent.
//   2. If the resulting table is in "auto" mode, refit the outer dims.
function postProcessTablePatch(prev: TableEl, patched: TableEl): TableEl {
    if (prev.rotation || patched.rotation) {
        const result = postProcessTablePatch(
            { ...prev, rotation: 0, size: logicalSize(prev.size, prev.rotation) },
            { ...patched, rotation: 0, size: logicalSize(patched.size, patched.rotation) },
        );
        return { ...result, rotation: patched.rotation, size: logicalSize(result.size, patched.rotation) };
    }
    const rowsChanged = patched.rows !== prev.rows;
    const colsChanged = patched.cols !== prev.cols;
    let next = patched;
    if (rowsChanged || colsChanged) {
        next = reshapeTable({ ...prev }, patched.rows, patched.cols);
        // Carry forward all OTHER patched fields (e.g. scaleMode change in
        // the same updateElement call should still take effect).
        next = { ...next, ...patched, rows: next.rows, cols: next.cols, cells: next.cells, colWidths: next.colWidths, rowHeights: next.rowHeights, size: next.size };
    }
    // If we just switched into auto, or the patch touched a size-relevant
    // field while in auto, refit.
    const switchedToAuto =
        prev.scaleMode !== "auto" && next.scaleMode === "auto";
    if (next.scaleMode === "auto" || switchedToAuto) {
        next = autoFitTable(next);
    }
    return next;
}

// Apply a resize gesture to a TableEl, honoring its scaleMode so the user
// can pick exactly which dimensions are allowed to change. The pos / size
// passed in is what ElementBox computed from the raw drag (already clamped
// for min size etc) — we either accept it, partially accept it, or reject
// it depending on the mode.
//
// "fixed" / "auto": outer dimensions are LOCKED; only position changes.
// "all":            scale row heights by sy, column widths by sx.
// "rows":           only height changes; width snaps back to original.
// "cols":           only width changes; height snaps back to original.
function resizeTable(el: TableEl, pos: Vec, size: Size): TableEl {
    if (el.rotation) {
        const result = resizeTable(
            { ...el, rotation: 0, size: logicalSize(el.size, el.rotation) },
            el.pos, logicalSize(size, el.rotation),
        );
        const physical = logicalSize(result.size, el.rotation);
        return { ...result, rotation: el.rotation, size: physical,
            pos: { x: physical.w === el.size.w ? el.pos.x : pos.x,
                y: physical.h === el.size.h ? el.pos.y : pos.y },
        };
    }
    const oldW = el.size.w;
    const oldH = el.size.h;
    const newW = size.w;
    const newH = size.h;

    if (el.scaleMode === "fixed" || el.scaleMode === "auto") {
        return { ...el, pos: el.pos, size: el.size };
    }

    if (el.scaleMode === "all") {
        const sx = oldW > 0 ? newW / oldW : 1;
        const sy = oldH > 0 ? newH / oldH : 1;
        // Pick the smaller axis ratio for things that don't have a single
        // dominant axis (font + padding). Using `min` keeps text from
        // overflowing the cell when the user drags a corner unevenly.
        const sUni = Math.min(sx, sy);
        return {
            ...el,
            pos,
            size,
            colWidths: el.colWidths.map((w) => w * sx),
            rowHeights: el.rowHeights.map((h) => h * sy),
            fontSizeMm: clampFont(el.fontSizeMm * sUni),
            padding: roundMm(el.padding * sUni),
            borderThickness: roundMm(el.borderThickness * sUni),
        };
    }

    if (el.scaleMode === "rows") {
        // Vertical-only: keep outer width and the table's left edge. Font
        // and padding follow the height ratio so cell contents scale with
        // the row height.
        const sy = oldH > 0 ? newH / oldH : 1;
        return {
            ...el,
            pos: { x: el.pos.x, y: pos.y },
            size: { w: oldW, h: newH },
            rowHeights: el.rowHeights.map((h) => h * sy),
            fontSizeMm: clampFont(el.fontSizeMm * sy),
            padding: roundMm(el.padding * sy),
        };
    }

    // "cols"
    const sx = oldW > 0 ? newW / oldW : 1;
    return {
        ...el,
        pos: { x: pos.x, y: el.pos.y },
        size: { w: newW, h: oldH },
        colWidths: el.colWidths.map((w) => w * sx),
        fontSizeMm: clampFont(el.fontSizeMm * sx),
        padding: roundMm(el.padding * sx),
    };
}

function clampFont(mm: number): number {
    if (!Number.isFinite(mm)) return 1;
    // Round to 2 decimals so successive scales don't accumulate float dust
    // (e.g. 1.91144458723851...) and the property panel stays readable.
    const rounded = Math.round(mm * 100) / 100;
    return Math.max(0.5, Math.min(40, rounded));
}

function roundMm(mm: number): number {
    if (!Number.isFinite(mm)) return 0;
    return Math.max(0, Math.round(mm * 100) / 100);
}

export function labelReducer(state: DesignerState, action: DesignerAction): DesignerState {
    switch (action.type) {
        case "load": {
            let feed = action.doc.dataFeed ?? defaultDataFeed();
            feed = action.doc.settings.rfid.enabled
                ? unprotectLegacyRfidColumn(feed)
                : removeLegacyRfidColumn(feed);
            feed = ensureTemplateColumns(
                feed,
                action.doc.elements,
                declaredBindingNames(action.doc),
            );
            const doc = { ...action.doc, dataFeed: feed };
            return { ...state, doc, selectedId: null, selectedIds: [] };
        }
        case "addElement": {
            // A new line starts at its own top/left, even in a rotated template.
            const element = action.element.kind === "line" ? normalizeLineStroke(action.element) : action.element;
            const elements = [...state.doc.elements, element];
            const dataFeed = ensureTemplateColumns(
                state.doc.dataFeed ?? defaultDataFeed(),
                elements,
                declaredBindingNames({ ...state.doc, elements }),
            );
            return {
                ...state,
                doc: { ...state.doc, elements, dataFeed },
                selectedId: action.element.id,
                selectedIds: [action.element.id],
            };
        }
        case "updateElement": {
            const elements = state.doc.elements.map((el) => {
                if (el.id !== action.id) return el;
                const patch = action.patch;
                const size = patch.size ?? (patch.rotation !== undefined &&
                    isQuarterTurn(patch.rotation) !== isQuarterTurn(el.rotation)
                    ? { w: el.size.h, h: el.size.w } : el.size);
                const patched = { ...el, ...patch, size } as LabelElement;
                if (el.kind === "table" && patched.kind === "table") {
                    return postProcessTablePatch(el, patched);
                }
                return patched;
            });
            const dataFeed = ensureTemplateColumns(
                state.doc.dataFeed ?? defaultDataFeed(),
                elements,
                declaredBindingNames({ ...state.doc, elements }),
            );
            return { ...state, doc: { ...state.doc, elements, dataFeed } };
        }
        case "removeElement": {
            const elements = state.doc.elements.filter((el) => el.id !== action.id);
            const selectedIds = state.selectedIds.filter((id) => id !== action.id);
            const selectedId =
                state.selectedId === action.id
                    ? (selectedIds[selectedIds.length - 1] ?? null)
                    : state.selectedId;
            return {
                ...state,
                doc: { ...state.doc, elements },
                selectedId,
                selectedIds,
            };
        }
        case "removeElements": {
            const drop = new Set(action.ids);
            const elements = state.doc.elements.filter((el) => !drop.has(el.id));
            const selectedIds = state.selectedIds.filter((id) => !drop.has(id));
            const selectedId =
                state.selectedId && drop.has(state.selectedId)
                    ? (selectedIds[selectedIds.length - 1] ?? null)
                    : state.selectedId;
            return {
                ...state,
                doc: { ...state.doc, elements },
                selectedId,
                selectedIds,
            };
        }
        case "select": {
            // If the user clicks away from the element they were editing
            // (or deselects everything), drop editingId too. Otherwise the
            // element stays "in edit mode" forever and ElementBox's drag
            // handler refuses subsequent clicks (`if (editing) return`).
            const editingId =
                state.editingId && state.editingId !== action.id
                    ? null
                    : state.editingId;
            return {
                ...state,
                selectedId: action.id,
                selectedIds: action.id ? [action.id] : [],
                editingId,
            };
        }
        case "selectAdd": {
            // Same rationale as `select`: if the active editor is no
            // longer the focused selection, drop it.
            const editingId =
                state.editingId && state.editingId !== action.id
                    ? null
                    : state.editingId;
            if (state.selectedIds.includes(action.id)) {
                return { ...state, selectedId: action.id, editingId };
            }
            return {
                ...state,
                selectedId: action.id,
                selectedIds: [...state.selectedIds, action.id],
                editingId,
            };
        }
        case "selectToggle": {
            const editingId =
                state.editingId && state.editingId !== action.id
                    ? null
                    : state.editingId;
            if (state.selectedIds.includes(action.id)) {
                const next = state.selectedIds.filter((i) => i !== action.id);
                return {
                    ...state,
                    selectedIds: next,
                    selectedId:
                        state.selectedId === action.id
                            ? (next[next.length - 1] ?? null)
                            : state.selectedId,
                    editingId,
                };
            }
            return {
                ...state,
                selectedId: action.id,
                selectedIds: [...state.selectedIds, action.id],
                editingId,
            };
        }
        case "selectMany": {
            const ids = action.ids;
            const editingId =
                state.editingId && !ids.includes(state.editingId)
                    ? null
                    : state.editingId;
            return {
                ...state,
                selectedIds: ids,
                selectedId: ids[ids.length - 1] ?? null,
                editingId,
            };
        }
        case "moveElement": {
            const elements = state.doc.elements.map((el) =>
                el.id === action.id ? { ...el, pos: action.pos } : el,
            );
            return { ...state, doc: { ...state.doc, elements } };
        }
        case "moveElements": {
            const map = new Map(action.deltas.map((d) => [d.id, d.pos]));
            const elements = state.doc.elements.map((el) =>
                map.has(el.id) ? { ...el, pos: map.get(el.id)! } : el,
            );
            return { ...state, doc: { ...state.doc, elements } };
        }
        case "resizeElement": {
            const elements = state.doc.elements.map((el) => {
                if (el.id !== action.id) return el;
                if (el.kind === "table") {
                    return resizeTable(el, action.pos, action.size);
                }
                return { ...el, pos: action.pos, size: action.size };
            });
            return { ...state, doc: { ...state.doc, elements } };
        }
        case "updateSettings": {
            if (action.patch.contentRotation !== undefined &&
                action.patch.contentRotation !== (state.doc.settings.contentRotation ?? 0)) {
                const doc = rotateTemplate(state.doc, action.patch.contentRotation);
                const rest = { ...action.patch };
                delete rest.contentRotation;
                return labelReducer({ ...state, doc, editingId: null }, {
                    ...action, patch: rest,
                });
            }
            const oldW = state.doc.settings.widthMm;
            const oldH = state.doc.settings.heightMm;
            const newSettings = { ...state.doc.settings, ...action.patch };
            if (action.patch.targetPrinterModel !== undefined) {
                newSettings.rfid = {
                    ...newSettings.rfid,
                    zebraModel: action.patch.targetPrinterModel,
                };
            }
            const newW = newSettings.widthMm;
            const newH = newSettings.heightMm;
            const dimsChanged =
                (action.patch.widthMm !== undefined && action.patch.widthMm !== oldW) ||
                (action.patch.heightMm !== undefined && action.patch.heightMm !== oldH);
            const newElements = dimsChanged && action.resizePolicy !== "keep"
                ? scaleElementsTo(state.doc.elements, oldW, oldH, newW, newH)
                : state.doc.elements;
            return {
                ...state,
                doc: {
                    ...state.doc,
                    settings: newSettings,
                    elements: newElements,
                },
            };
        }
        case "updateSerial":
            return {
                ...state,
                doc: {
                    ...state.doc,
                    settings: {
                        ...state.doc.settings,
                        serial: { ...state.doc.settings.serial, ...action.patch },
                    },
                },
            };
        case "updateRfid": {
            const nextRfid = { ...state.doc.settings.rfid, ...action.patch };
            const currentFeed = state.doc.dataFeed ?? { columns: [], rows: [] };
            let feed = currentFeed;
            if (nextRfid.enabled) {
                feed = unprotectLegacyRfidColumn(feed);
                const sourceName = preferredRfidColumnName(feed);
                if ((!nextRfid.data || nextRfid.data.length === 0) && sourceName) {
                    nextRfid.data = `{${sourceName}}`;
                }
                if (!nextRfid.fieldName && sourceName) {
                    nextRfid.fieldName = sourceName;
                }
            } else {
                feed = removeLegacyRfidColumn(feed);
            }
            return {
                ...state,
                doc: {
                    ...state.doc,
                    settings: { ...state.doc.settings, rfid: nextRfid },
                    dataFeed: feed,
                },
            };
        }
        case "rename":
            return { ...state, doc: { ...state.doc, name: action.name } };
        case "toggleSnap":
            return { ...state, snapToGrid: !state.snapToGrid };
        case "toggleGrid":
            return { ...state, showGrid: !state.showGrid };
        case "toggleHighlightVars":
            return { ...state, highlightVars: !state.highlightVars };
        case "setZoom":
            return { ...state, zoom: action.zoom };
        case "reorder": {
            const idx = state.doc.elements.findIndex((el) => el.id === action.id);
            if (idx < 0) return state;
            const els = [...state.doc.elements];
            const [item] = els.splice(idx, 1);
            switch (action.direction) {
                case "top":
                    els.push(item);
                    break;
                case "bottom":
                    els.unshift(item);
                    break;
                case "up":
                    els.splice(Math.min(idx + 1, els.length), 0, item);
                    break;
                case "down":
                    els.splice(Math.max(idx - 1, 0), 0, item);
                    break;
            }
            return { ...state, doc: { ...state.doc, elements: els } };
        }
        case "moveLayerTo": {
            const fromIdx = state.doc.elements.findIndex((el) => el.id === action.id);
            if (fromIdx < 0) return state;
            const els = [...state.doc.elements];
            const [item] = els.splice(fromIdx, 1);
            const clamped = Math.max(0, Math.min(els.length, action.toIndex));
            els.splice(clamped, 0, item);
            return { ...state, doc: { ...state.doc, elements: els } };
        }
        case "beginEdit":
            return {
                ...state,
                editingId: action.id,
                selectedId: action.id,
                selectedIds: [action.id],
            };
        case "endEdit":
            return { ...state, editingId: null };

        case "feed/setOpen":
            return { ...state, feedOpen: action.open };
        case "feed/setFullscreen":
            return { ...state, feedFullscreen: action.fullscreen };
        case "feed/setPreviewRow":
            return { ...state, previewRowId: action.rowId };
        case "feed/addColumn": {
            const feed = feedOf(state);
            const name = uniqueColumnName(feed, action.name ?? `column_${feed.columns.length + 1}`);
            return withFeed(state, {
                ...feed,
                columns: [...feed.columns, makeColumn(name)],
            });
        }
        case "feed/renameColumn": {
            const feed = feedOf(state);
            const target = feed.columns.find((c) => c.id === action.id);
            if (!target || target.system || target.protected) return state;
            const safe = uniqueColumnName(
                { ...feed, columns: feed.columns.filter((c) => c.id !== action.id) },
                action.name || "column",
            );
            const nextState = withFeed(state, {
                ...feed,
                columns: feed.columns.map((c) =>
                    c.id === action.id ? { ...c, name: safe } : c,
                ),
            });
            const rfidData = replacePlaceholder(state.doc.settings.rfid.data, target.name, safe);
            const rfidFieldName = replaceFieldName(
                state.doc.settings.rfid.fieldName,
                target.name,
                safe,
            );
            return {
                ...nextState,
                doc: {
                    ...nextState.doc,
                    settings: {
                        ...nextState.doc.settings,
                        rfid: {
                            ...nextState.doc.settings.rfid,
                            data: rfidData,
                            fieldName: rfidFieldName,
                        },
                    },
                },
            };
        }
        case "feed/setColumnFormula": {
            const feed = feedOf(state);
            const target = feed.columns.find((c) => c.id === action.id);
            if (!target || target.system || target.protected) return state;
            return withFeed(state, {
                ...feed,
                columns: feed.columns.map((c) =>
                    c.id === action.id ? { ...c, formula: action.formula } : c,
                ),
            });
        }
        case "feed/deleteColumn": {
            const feed = feedOf(state);
            const target = feed.columns.find((c) => c.id === action.id);
            if (!target || target.system || target.protected) return state;
            const nextState = withFeed(state, {
                ...feed,
                columns: feed.columns.filter((c) => c.id !== action.id),
                rows: feed.rows.map((r) => {
                    const { [action.id]: _drop, ...rest } = r.cells;
                    void _drop;
                    return { ...r, cells: rest };
                }),
            });
            const currentRfid = nextState.doc.settings.rfid;
            const sourceName = currentRfid.data.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
            const clearsRfid =
                sourceName?.toLowerCase() === target.name.toLowerCase() ||
                currentRfid.fieldName?.toLowerCase() === target.name.toLowerCase();
            if (!clearsRfid) return nextState;
            return {
                ...nextState,
                doc: {
                    ...nextState.doc,
                    settings: {
                        ...nextState.doc.settings,
                        rfid: { ...currentRfid, data: "", fieldName: undefined },
                    },
                },
            };
        }
        case "feed/reorderColumn": {
            const feed = feedOf(state);
            const idx = feed.columns.findIndex((c) => c.id === action.id);
            if (idx < 0) return state;
            const cols = [...feed.columns];
            const [moved] = cols.splice(idx, 1);
            cols.splice(Math.max(0, Math.min(cols.length, action.toIndex)), 0, moved);
            return withFeed(state, { ...feed, columns: cols });
        }
        case "feed/setColumnWidth": {
            const feed = feedOf(state);
            const idx = feed.columns.findIndex((c) => c.id === action.id);
            if (idx < 0) return state;
            const w =
                typeof action.width === "number" && Number.isFinite(action.width)
                    ? Math.max(40, Math.round(action.width))
                    : undefined;
            const cols = feed.columns.map((c, i) =>
                i === idx ? { ...c, width: w } : c,
            );
            return withFeed(state, { ...feed, columns: cols });
        }
        case "feed/setColumnFormat": {
            const feed = feedOf(state);
            const idx = feed.columns.findIndex((c) => c.id === action.id);
            if (idx < 0) return state;
            // System columns (e.g. `step`) opt out of formatting — they have
            // their own padded/prefixed display tied to the serial counter.
            if (feed.columns[idx].system) return state;
            const cols = feed.columns.map((c, i) =>
                i === idx ? { ...c, format: action.format } : c,
            );
            return withFeed(state, { ...feed, columns: cols });
        }
        case "feed/addRow": {
            const current = feedOf(state);
            // First row on an empty feed → seed the default step column.
            const seeded =
                current.columns.length === 0
                    ? { ...current, columns: defaultDataFeed().columns }
                    : current;
            return withFeed(state, {
                ...seeded,
                rows: [...seeded.rows, makeRow()],
            });
        }
        case "feed/addRows": {
            const n = Math.max(0, Math.floor(action.count));
            if (n === 0) return state;
            const current = feedOf(state);
            const seeded =
                current.columns.length === 0
                    ? { ...current, columns: defaultDataFeed().columns }
                    : current;
            const fresh = Array.from({ length: n }, () => makeRow());
            return withFeed(state, {
                ...seeded,
                rows: [...seeded.rows, ...fresh],
            });
        }
        case "feed/setCell": {
            const feed = feedOf(state);
            return withFeed(state, {
                ...feed,
                rows: feed.rows.map((r) =>
                    r.id === action.rowId
                        ? { ...r, cells: { ...r.cells, [action.colId]: action.value } }
                        : r,
                ),
            });
        }
        case "feed/setCells": {
            const feed = feedOf(state);
            const extraRows = Math.max(0, Math.floor(action.addRows ?? 0));
            const rowsBase = extraRows
                ? [...feed.rows, ...Array.from({ length: extraRows }, () => makeRow())]
                : feed.rows;
            const byRow = new Map<string, Record<string, string>>();
            for (const u of action.updates) {
                const m = byRow.get(u.rowId) ?? {};
                m[u.colId] = u.value;
                byRow.set(u.rowId, m);
            }
            return withFeed(state, {
                ...feed,
                rows: rowsBase.map((r) => {
                    const patch = byRow.get(r.id);
                    return patch ? { ...r, cells: { ...r.cells, ...patch } } : r;
                }),
            });
        }
        case "feed/deleteRows": {
            const feed = feedOf(state);
            const drop = new Set(action.rowIds);
            return withFeed(state, {
                ...feed,
                rows: feed.rows.filter((r) => !drop.has(r.id)),
            });
        }
        case "feed/replaceAll": {
            const nextFeed = {
                columns: action.columns,
                rows: action.rows,
            };
            const nextState = withFeed(state, nextFeed);
            const rfid = state.doc.settings.rfid;
            const currentSource = rfid.data.match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/)?.[1];
            const sourceExists =
                !!currentSource &&
                nextFeed.columns.some(
                    (col) => col.name.toLowerCase() === currentSource.toLowerCase(),
                );
            const preferred = preferredRfidColumnName(nextFeed);
            if (!rfid.enabled || !preferred || (rfid.data && sourceExists)) {
                return nextState;
            }
            return {
                ...nextState,
                doc: {
                    ...nextState.doc,
                    settings: {
                        ...nextState.doc.settings,
                        rfid: {
                            ...nextState.doc.settings.rfid,
                            data: `{${preferred}}`,
                            fieldName: preferred,
                        },
                    },
                },
            };
        }
        default:
            return state;
    }
}
