import type { DesignerAction, DesignerState } from "./types";
import { labelReducer } from "./reducer";

export type HistoryState = {
    past: DesignerState[];
    present: DesignerState;
    future: DesignerState[];
};

export type HistoryAction = DesignerAction | { type: "undo" } | { type: "redo" };

const MAX_HISTORY = 100;

// Actions that should NOT push to history (transient UI / non-doc state).
const TRANSIENT_TYPES = new Set<DesignerAction["type"]>([
    "select",
    "toggleSnap",
    "toggleGrid",
    "toggleHighlightVars",
    "setZoom",
    "beginEdit",
    "endEdit",
    "feed/setOpen",
    "feed/setFullscreen",
    "feed/setPreviewRow",
]);

// Actions where consecutive same-id changes collapse into one history entry,
// so dragging an element creates one undo step instead of dozens.
const COALESCE_TYPES = new Set<DesignerAction["type"]>([
    "moveElement",
    "resizeElement",
    "updateElement",
    "feed/setCell",
    "feed/renameColumn",
    "feed/setColumnFormula",
]);

function actionKey(a: DesignerAction): string {
    if (a.type === "moveElement" || a.type === "resizeElement" || a.type === "updateElement") {
        return `${a.type}:${a.id}`;
    }
    if (a.type === "feed/setCell") {
        return `${a.type}:${a.rowId}:${a.colId}`;
    }
    if (a.type === "feed/renameColumn" || a.type === "feed/setColumnFormula") {
        return `${a.type}:${a.id}`;
    }
    return a.type;
}

let lastKey: string | null = null;

export function makeInitialHistory(initial: DesignerState): HistoryState {
    return { past: [], present: initial, future: [] };
}

export function historyReducer(
    state: HistoryState,
    action: HistoryAction,
): HistoryState {
    if (action.type === "undo") {
        if (state.past.length === 0) return state;
        const previous = state.past[state.past.length - 1];
        const newPast = state.past.slice(0, -1);
        lastKey = null;
        return {
            past: newPast,
            present: previous,
            future: [state.present, ...state.future],
        };
    }
    if (action.type === "redo") {
        if (state.future.length === 0) return state;
        const next = state.future[0];
        const newFuture = state.future.slice(1);
        lastKey = null;
        return {
            past: [...state.past, state.present],
            present: next,
            future: newFuture,
        };
    }

    const next = labelReducer(state.present, action);
    if (next === state.present) return state;
    if (action.type === "load") {
        lastKey = null;
        return { past: [], present: next, future: [] };
    }
    if (TRANSIENT_TYPES.has(action.type)) {
        return { ...state, present: next };
    }
    const key = actionKey(action);
    if (COALESCE_TYPES.has(action.type) && lastKey === key && state.past.length > 0) {
        // collapse — replace present without pushing a new history frame
        return { ...state, present: next };
    }
    lastKey = key;
    const newPast = [...state.past, state.present];
    if (newPast.length > MAX_HISTORY) newPast.shift();
    return { past: newPast, present: next, future: [] };
}
