"use client";

import {
    useCallback,
    useRef,
    useState,
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
} from "react";
import { cn } from "@/lib/utils";
import type { LabelElement, TableEl, TextEl, Vec } from "../types";
import { snap } from "../units";
import { inverseRotatePoint, isQuarterTurn } from "../rotation";
import type { VariableSuggestion } from "./HighlightedField";
import { TextElement } from "./elements/TextElement";
import { QrElement } from "./elements/QrElement";
import { BarcodeElement } from "./elements/BarcodeElement";
import { DataMatrixElement } from "./elements/DataMatrixElement";
import { RectElement } from "./elements/RectElement";
import { LineElement } from "./elements/LineElement";
import { ImageElement } from "./elements/ImageElement";
import { TableElement } from "./elements/TableElement";

type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

export interface SnapGuides {
    vertical: boolean;
    horizontal: boolean;
}

const CENTER_SNAP_THRESHOLD_MM = 1;

export type SelectMode = "replace" | "add" | "toggle";

interface ElementBoxProps {
    el: LabelElement;
    selected: boolean;
    editing: boolean;
    readOnly?: boolean;
    highlightVars?: boolean;
    forcePrintFidelity?: boolean;
    variables?: VariableSuggestion[];
    pxPerMm: number;
    dpi?: number;
    canvasMm: { w: number; h: number };
    snapToGrid: boolean;
    snapStepMm?: number;
    groupMembers?: LabelElement[];
    onSelect: (id: string, mode?: SelectMode) => void;
    onMove: (id: string, pos: Vec) => void;
    onMoveMany?: (deltas: { id: string; pos: Vec }[]) => void;
    onResize: (id: string, pos: Vec, size: { w: number; h: number }) => void;
    onBeginEdit: (id: string) => void;
    onEndEdit: () => void;
    onUpdateElement: (id: string, patch: Partial<LabelElement>) => void;
    onContextMenu?: (id: string, clientX: number, clientY: number) => void;
    onSnapGuides?: (guides: SnapGuides) => void;
}

export function ElementBox({
    el,
    selected,
    editing,
    readOnly = false,
    highlightVars = false,
    forcePrintFidelity = false,
    variables,
    pxPerMm,
    dpi = 203,
    canvasMm,
    snapToGrid,
    snapStepMm = 1,
    groupMembers,
    onSelect,
    onMove,
    onMoveMany,
    onResize,
    onBeginEdit,
    onEndEdit,
    onUpdateElement,
    onContextMenu,
    onSnapGuides,
}: ElementBoxProps) {
    const startRef = useRef<{
        clientX: number;
        clientY: number;
        pos: Vec;
        size: { w: number; h: number };
        handle: Handle;
        pointerId: number;
        group: { id: string; pos: Vec; size: { w: number; h: number } }[] | null;
    } | null>(null);
    const locksSquareAspect = el.kind === "qr" ||
        (el.kind === "datamatrix" && (el.shape ?? "square") === "square");

    const beginDrag = useCallback(
        (handle: Handle) =>
            (e: ReactPointerEvent<HTMLDivElement>) => {
                if (readOnly) return;
                if (el.locked) return;
                if (editing) return;
                e.stopPropagation();
                e.preventDefault();
                const isAlreadySelected =
                    !!groupMembers && groupMembers.some((g) => g.id === el.id);
                let dragGroup:
                    | { id: string; pos: Vec; size: { w: number; h: number } }[]
                    | null = null;
                if (handle === "move") {
                    if (e.shiftKey) {
                        onSelect(el.id, "add");
                        dragGroup =
                            (isAlreadySelected ? groupMembers : [
                                ...(groupMembers ?? []),
                                el,
                            ])?.map((g) => ({
                                id: g.id,
                                pos: { ...g.pos },
                                size: { ...g.size },
                            })) ?? null;
                    } else if (e.ctrlKey || e.metaKey) {
                        onSelect(el.id, "toggle");
                        if (isAlreadySelected) {
                            // Toggling off — don't begin a drag.
                            return;
                        }
                        dragGroup = [
                            ...(groupMembers ?? []),
                            el,
                        ].map((g) => ({
                            id: g.id,
                            pos: { ...g.pos },
                            size: { ...g.size },
                        }));
                    } else {
                        if (isAlreadySelected && (groupMembers?.length ?? 0) > 1) {
                            // Dragging a member of a multi-selection — keep group.
                            dragGroup =
                                groupMembers?.map((g) => ({
                                    id: g.id,
                                    pos: { ...g.pos },
                                    size: { ...g.size },
                                })) ?? null;
                        } else {
                            onSelect(el.id);
                            dragGroup = null;
                        }
                    }
                } else {
                    // Resize handle: always operate on this element only,
                    // and don't disturb existing selection if we're in it.
                    if (!isAlreadySelected) onSelect(el.id);
                }
                startRef.current = {
                    clientX: e.clientX,
                    clientY: e.clientY,
                    pos: { ...el.pos },
                    size: { ...el.size },
                    handle,
                    pointerId: e.pointerId,
                    group:
                        dragGroup && dragGroup.length > 1 ? dragGroup : null,
                };
                (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
            },
        [el, groupMembers, editing, readOnly, onSelect],
    );

    // Tables: when the user double-clicks, we want to open the SPECIFIC cell
    // they pointed at — not just put the table into "edit mode" and force a
    // second click. The dblclick handler computes the cell from the click
    // coordinates, stashes it, and TableElement consumes it on next render.
    const [requestCell, setRequestCell] = useState<{ r: number; c: number } | null>(null);

    const onDoubleClick = useCallback(
        (e: ReactMouseEvent<HTMLDivElement>) => {
            if (readOnly) return;
            if (el.kind === "text") {
                onBeginEdit(el.id);
                return;
            }
            if (el.kind === "table") {
                const t = el as TableEl;
                const rect = e.currentTarget.getBoundingClientRect();
                const { x: xMm, y: yMm } = inverseRotatePoint({
                    x: (e.clientX - rect.left) / pxPerMm,
                    y: (e.clientY - rect.top) / pxPerMm,
                }, el.size, el.rotation);
                let col = t.cols - 1;
                let acc = 0;
                for (let c = 0; c < t.cols; c += 1) {
                    acc += t.colWidths[c] ?? 0;
                    if (xMm < acc) {
                        col = c;
                        break;
                    }
                }
                acc = 0;
                let row = t.rows - 1;
                for (let r = 0; r < t.rows; r += 1) {
                    acc += t.rowHeights[r] ?? 0;
                    if (yMm < acc) {
                        row = r;
                        break;
                    }
                }
                setRequestCell({ r: row, c: col });
                onBeginEdit(el.id);
            }
        },
        [el, pxPerMm, readOnly, onBeginEdit],
    );

    const onPointerMove = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => {
            const start = startRef.current;
            if (!start) return;
            const dxMm = (e.clientX - start.clientX) / pxPerMm;
            const dyMm = (e.clientY - start.clientY) / pxPerMm;
            const safeSnapStepMm = Number.isFinite(snapStepMm) && snapStepMm > 0
                ? snapStepMm
                : 1;
            const step = snapToGrid ? safeSnapStepMm : 0;

            if (start.handle === "move") {
                if (start.group) {
                    let dx = dxMm;
                    let dy = dyMm;
                    if (step) {
                        dx = snap(dx, step);
                        dy = snap(dy, step);
                    }
                    onMoveMany?.(
                        start.group.map((g) => ({
                            id: g.id,
                            pos: { x: g.pos.x + dx, y: g.pos.y + dy },
                        })),
                    );
                    onSnapGuides?.({ vertical: false, horizontal: false });
                    return;
                }
                let x = start.pos.x + dxMm;
                let y = start.pos.y + dyMm;
                if (step) {
                    x = snap(x, step);
                    y = snap(y, step);
                }
                const canvasCx = canvasMm.w / 2;
                const canvasCy = canvasMm.h / 2;
                let snappedV = false;
                let snappedH = false;
                if (Math.abs(x + start.size.w / 2 - canvasCx) < CENTER_SNAP_THRESHOLD_MM) {
                    x = canvasCx - start.size.w / 2;
                    snappedV = true;
                }
                if (Math.abs(y + start.size.h / 2 - canvasCy) < CENTER_SNAP_THRESHOLD_MM) {
                    y = canvasCy - start.size.h / 2;
                    snappedH = true;
                }
                onMove(el.id, { x, y });
                onSnapGuides?.({ vertical: snappedV, horizontal: snappedH });
                return;
            }

            let { x, y } = start.pos;
            let { w, h } = start.size;
            if (start.handle.includes("e")) {
                w = start.size.w + dxMm;
            }
            if (start.handle.includes("s")) {
                h = start.size.h + dyMm;
            }
            if (start.handle.includes("w")) {
                w = start.size.w - dxMm;
                x = start.pos.x + dxMm;
            }
            if (start.handle.includes("n")) {
                h = start.size.h - dyMm;
                y = start.pos.y + dyMm;
            }
            const isCorner = start.handle.length === 2;
            const keepAspect =
                isCorner &&
                (locksSquareAspect ||
                    e.shiftKey || e.ctrlKey || e.metaKey) &&
                start.size.w > 0 &&
                start.size.h > 0;
            if (keepAspect) {
                // QR modules are square, so the design frame should resize as
                // a square without requiring a modifier key. Other objects
                // retain their authored aspect ratio when a modifier is held.
                const aspect = locksSquareAspect ? 1 : start.size.w / start.size.h;
                const wChange = Math.abs(w - start.size.w);
                const hChange = Math.abs(h - start.size.h) * aspect;
                if (wChange >= hChange) {
                    h = w / aspect;
                } else {
                    w = h * aspect;
                }
                if (start.handle.includes("w")) x = start.pos.x + start.size.w - w;
                if (start.handle.includes("n")) y = start.pos.y + start.size.h - h;
            }
            const minSide = 2;
            if (keepAspect) {
                const aspect = locksSquareAspect ? 1 : start.size.w / start.size.h;
                if (w < minSide) {
                    w = minSide;
                    h = w / aspect;
                }
                if (h < minSide) {
                    h = minSide;
                    w = h * aspect;
                }
                if (start.handle.includes("w")) x = start.pos.x + start.size.w - w;
                if (start.handle.includes("n")) y = start.pos.y + start.size.h - h;
            } else {
                if (w < minSide) {
                    if (start.handle.includes("w")) x = start.pos.x + start.size.w - minSide;
                    w = minSide;
                }
                if (h < minSide) {
                    if (start.handle.includes("n")) y = start.pos.y + start.size.h - minSide;
                    h = minSide;
                }
            }
            if (step && !keepAspect) {
                x = snap(x, step);
                y = snap(y, step);
                w = snap(w, step);
                h = snap(h, step);
            }
            if (w < minSide) w = minSide;
            if (h < minSide) h = minSide;
            onResize(el.id, { x, y }, { w, h });
        },
        [
            pxPerMm,
            snapToGrid,
            snapStepMm,
            el.id,
            locksSquareAspect,
            canvasMm.w,
            canvasMm.h,
            onMove,
            onMoveMany,
            onResize,
            onSnapGuides,
        ],
    );

    const endDrag = useCallback(
        (e: ReactPointerEvent<HTMLDivElement>) => {
            const start = startRef.current;
            if (start) {
                try {
                    (e.currentTarget as HTMLDivElement).releasePointerCapture(start.pointerId);
                } catch {
                    /* ignore */
                }
            }
            startRef.current = null;
            onSnapGuides?.({ vertical: false, horizontal: false });
        },
        [onSnapGuides],
    );

    const left = el.pos.x * pxPerMm;
    const top = el.pos.y * pxPerMm;
    const width = el.size.w * pxPerMm;
    const height = el.size.h * pxPerMm;

    return (
        <div
            data-element-id={el.id}
            className={cn(
                "absolute select-none",
                readOnly
                    ? ""
                    : selected
                      ? "ring-2 ring-blue-500/80 ring-offset-1 ring-offset-white"
                      : "ring-1 ring-transparent hover:ring-blue-300/60",
                readOnly
                    ? ""
                    : editing
                      ? "cursor-text"
                      : el.locked
                        ? "cursor-not-allowed"
                        : "cursor-move",
            )}
            style={{
                left,
                top,
                width,
                height,
                touchAction: "none",
                pointerEvents: readOnly ? "none" : undefined,
            }}
            onPointerDown={readOnly ? undefined : beginDrag("move")}
            onPointerMove={readOnly ? undefined : onPointerMove}
            onPointerUp={readOnly ? undefined : endDrag}
            onPointerCancel={readOnly ? undefined : endDrag}
            onDoubleClick={readOnly ? undefined : onDoubleClick}
            onContextMenu={
                readOnly || !onContextMenu
                    ? undefined
                    : (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const inSelection =
                              !!groupMembers && groupMembers.some((g) => g.id === el.id);
                          // If right-clicking outside the current selection,
                          // make this the only selection. Otherwise keep the
                          // multi-selection so menu actions affect all of it.
                          if (!inSelection) onSelect(el.id);
                          onContextMenu(el.id, e.clientX, e.clientY);
                      }
            }
        >
            <div
                className={cn("w-full h-full", editing ? "" : "pointer-events-none")}
            >
                {el.kind === "text" && (
                    <TextElement
                        el={el as TextEl}
                        pxPerMm={pxPerMm}
                        dpi={dpi}
                        editing={editing}
                        highlightVars={highlightVars}
                        forcePrintFidelity={forcePrintFidelity}
                        variables={variables}
                        onChange={(text) =>
                            onUpdateElement(el.id, { text } as Partial<LabelElement>)
                        }
                        onCommit={onEndEdit}
                    />
                )}
                {el.kind === "qr" && (
                    <QrElement
                        el={el}
                        pxPerMm={pxPerMm}
                        dpi={dpi}
                        highlightVars={highlightVars}
                    />
                )}
                {el.kind === "barcode" && (
                    <BarcodeElement
                        el={el}
                        pxPerMm={pxPerMm}
                        dpi={dpi}
                        highlightVars={highlightVars}
                    />
                )}
                {el.kind === "datamatrix" && (
                    <DataMatrixElement
                        el={el}
                        pxPerMm={pxPerMm}
                        dpi={dpi}
                        highlightVars={highlightVars}
                    />
                )}
                {el.kind === "rect" && (
                    <RectElement el={el} pxPerMm={pxPerMm} dpi={dpi} />
                )}
                {el.kind === "line" && (
                    <LineElement el={el} pxPerMm={pxPerMm} dpi={dpi} />
                )}
                {el.kind === "image" && (
                    <ImageElement
                        el={el}
                        pxPerMm={pxPerMm}
                        dpi={dpi}
                        onUpdate={(patch) => onUpdateElement(el.id, patch)}
                    />
                )}
                {el.kind === "table" && (
                    <TableElement
                        el={el as TableEl}
                        pxPerMm={pxPerMm}
                        editing={editing}
                        selected={selected}
                        highlightVars={highlightVars}
                        variables={variables}
                        interactive={!readOnly}
                        requestEditCell={editing ? requestCell : null}
                        onChangeCell={(r, c, value) => {
                            const t = el as TableEl;
                            const idx = r * t.cols + c;
                            const next = t.cells.slice();
                            next[idx] = value;
                            onUpdateElement(el.id, {
                                cells: next,
                            } as Partial<LabelElement>);
                        }}
                        onUpdate={(patch) =>
                            onUpdateElement(el.id, patch as Partial<LabelElement>)
                        }
                        onEndEdit={onEndEdit}
                    />
                )}
            </div>

            {selected && !el.locked && !editing && (
                <>
                    {visibleHandles(el).map((h) => (
                        <div
                            key={h}
                            className="absolute bg-blue-500 border border-white"
                            style={handleStyle(h)}
                            onPointerDown={beginDrag(h)}
                            onPointerMove={onPointerMove}
                            onPointerUp={endDrag}
                            onPointerCancel={endDrag}
                        />
                    ))}
                    <div
                        className="absolute -top-6 left-0 px-1.5 py-0.5 rounded bg-blue-600 text-white text-[10px] font-mono whitespace-nowrap pointer-events-none"
                    >
                        {el.size.w.toFixed(1)}×{el.size.h.toFixed(1)} mm @ {el.pos.x.toFixed(1)},{el.pos.y.toFixed(1)}
                    </div>
                </>
            )}
        </div>
    );
}

// Tables with locked dimensions only show the relevant resize handles, so the
// UX self-documents which scale modes do what. Other element kinds always
// expose all 8 handles.
function visibleHandles(el: LabelElement): Handle[] {
    const all: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
    if (
        el.kind === "qr" ||
        (el.kind === "datamatrix" && (el.shape ?? "square") === "square")
    ) return ["nw", "ne", "se", "sw"];
    if (el.kind !== "table") return all;
    switch (el.scaleMode) {
        case "fixed":
        case "auto":
            return [];
        case "rows":
            return isQuarterTurn(el.rotation) ? ["e", "w"] : ["n", "s"];
        case "cols":
            return isQuarterTurn(el.rotation) ? ["n", "s"] : ["e", "w"];
        case "all":
        default:
            return all;
    }
}

function handleStyle(h: Handle): React.CSSProperties {
    const sz = 8;
    const style: React.CSSProperties = {
        width: sz,
        height: sz,
        zIndex: 5,
        touchAction: "none",
    };
    const set = (key: keyof React.CSSProperties, value: string) => {
        (style as Record<string, unknown>)[key as string] = value;
    };
    if (h.includes("n")) set("top", `-${sz / 2}px`);
    if (h.includes("s")) set("bottom", `-${sz / 2}px`);
    if (h.includes("w")) set("left", `-${sz / 2}px`);
    if (h.includes("e")) set("right", `-${sz / 2}px`);
    if (h === "n" || h === "s") {
        set("left", `calc(50% - ${sz / 2}px)`);
        set("cursor", "ns-resize");
    }
    if (h === "e" || h === "w") {
        set("top", `calc(50% - ${sz / 2}px)`);
        set("cursor", "ew-resize");
    }
    if (h === "ne" || h === "sw") set("cursor", "nesw-resize");
    if (h === "nw" || h === "se") set("cursor", "nwse-resize");
    return style;
}
