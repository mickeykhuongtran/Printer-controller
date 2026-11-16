"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { LabelDoc, LabelElement, Vec } from "../types";
import { resolveTextValue } from "../label-data";
import { rfidTextLastChars } from "../rfid-text";
import { ElementBox, type SnapGuides, type SelectMode } from "./ElementBox";
import { PrintFidelityPreview } from "./PrintFidelityPreview";
import { Rulers, RULER_OFFSET } from "./Rulers";

interface DesignerCanvasProps {
    doc: LabelDoc;
    selectedId?: string | null;
    selectedIds?: string[];
    editingId?: string | null;
    pxPerMm: number;
    snapToGrid?: boolean;
    showGrid?: boolean;
    /** Physical spacing of the editor grid. Defaults to 1 mm. */
    gridStepMm?: number;
    /** Physical snap increment. Defaults to 1 mm for backward compatibility. */
    snapStepMm?: number;
    showRulers?: boolean;
    /** Display ruler values as physical millimetres or native printer dots. */
    rulerUnit?: "mm" | "dot";
    readOnly?: boolean;
    highlightVars?: boolean;
    // Force Zebra built-in bitmap-font rendering on all text. Used by the Print step
    // preview so the user sees what the printer will actually output.
    forcePrintFidelity?: boolean;
    /** Marks the canvas as using print-fidelity presentation for future overlays. */
    printFidelity?: boolean;
    variables?: import("./HighlightedField").VariableSuggestion[];
    padding?: number;
    onSelect?: (id: string | null, mode?: SelectMode) => void;
    onSelectMany?: (ids: string[], mode: "replace" | "add") => void;
    onMove?: (id: string, pos: Vec) => void;
    onMoveMany?: (deltas: { id: string; pos: Vec }[]) => void;
    onResize?: (id: string, pos: Vec, size: { w: number; h: number }) => void;
    onBeginEdit?: (id: string) => void;
    onEndEdit?: () => void;
    onUpdateElement?: (id: string, patch: Partial<LabelElement>) => void;
    onContextMenu?: (id: string, clientX: number, clientY: number) => void;
}

const noop = () => {};

interface MarqueeState {
    sxMm: number;
    syMm: number;
    cxMm: number;
    cyMm: number;
    pointerId: number;
    additive: boolean;
}

export function DesignerCanvas({
    doc,
    selectedId = null,
    selectedIds,
    editingId = null,
    pxPerMm,
    snapToGrid = false,
    showGrid = false,
    gridStepMm = 1,
    snapStepMm = 1,
    showRulers = true,
    rulerUnit = "mm",
    readOnly = false,
    highlightVars = false,
    forcePrintFidelity = false,
    printFidelity = false,
    variables,
    padding = 24,
    onSelect = noop,
    onSelectMany,
    onMove = noop,
    onMoveMany,
    onResize = noop,
    onBeginEdit = noop,
    onEndEdit = noop,
    onUpdateElement = noop,
    onContextMenu,
}: DesignerCanvasProps) {
    const widthPx = doc.settings.widthMm * pxPerMm;
    const heightPx = doc.settings.heightMm * pxPerMm;
    // Paper margin is print-only: it shifts element coordinates in the ZPL
    // output to compensate for media that's wider/taller than the label,
    // but the on-screen canvas keeps showing the label at its native
    // origin so the design layout stays clean.
    const offset = showRulers ? RULER_OFFSET : 0;
    const [snapGuides, setSnapGuides] = useState<SnapGuides>({
        vertical: false,
        horizontal: false,
    });
    const [marquee, setMarquee] = useState<MarqueeState | null>(null);
    const marqueeRef = useRef<MarqueeState | null>(null);

    const effectiveSelectedIds = useMemo(
        () => selectedIds ?? (selectedId ? [selectedId] : []),
        [selectedIds, selectedId],
    );
    const groupMembers = useMemo(() => {
        if (effectiveSelectedIds.length <= 1) return undefined;
        const set = new Set(effectiveSelectedIds);
        return doc.elements.filter((e) => set.has(e.id));
    }, [doc.elements, effectiveSelectedIds]);

    const onCanvasDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            if (readOnly) return;
            if (e.target !== e.currentTarget) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const sxMm = (e.clientX - rect.left) / pxPerMm;
            const syMm = (e.clientY - rect.top) / pxPerMm;
            const additive = e.shiftKey || e.ctrlKey || e.metaKey;
            const next: MarqueeState = {
                sxMm,
                syMm,
                cxMm: sxMm,
                cyMm: syMm,
                pointerId: e.pointerId,
                additive,
            };
            try {
                e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
                /* ignore */
            }
            marqueeRef.current = next;
            setMarquee(next);
        },
        [readOnly, pxPerMm],
    );

    const onCanvasMove = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const m = marqueeRef.current;
            if (!m || m.pointerId !== e.pointerId) return;
            const rect = e.currentTarget.getBoundingClientRect();
            const cxMm = (e.clientX - rect.left) / pxPerMm;
            const cyMm = (e.clientY - rect.top) / pxPerMm;
            const next = { ...m, cxMm, cyMm };
            marqueeRef.current = next;
            setMarquee(next);
        },
        [pxPerMm],
    );

    const onCanvasUp = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            const m = marqueeRef.current;
            if (!m || m.pointerId !== e.pointerId) return;
            try {
                e.currentTarget.releasePointerCapture(e.pointerId);
            } catch {
                /* ignore */
            }
            const x0 = Math.min(m.sxMm, m.cxMm);
            const y0 = Math.min(m.syMm, m.cyMm);
            const x1 = Math.max(m.sxMm, m.cxMm);
            const y1 = Math.max(m.syMm, m.cyMm);
            const dragged = x1 - x0 > 0.5 || y1 - y0 > 0.5;
            if (dragged) {
                const ids = doc.elements
                    .filter((el) => {
                        const ex0 = el.pos.x;
                        const ey0 = el.pos.y;
                        const ex1 = el.pos.x + el.size.w;
                        const ey1 = el.pos.y + el.size.h;
                        return ex0 < x1 && ex1 > x0 && ey0 < y1 && ey1 > y0;
                    })
                    .map((el) => el.id);
                if (onSelectMany) {
                    onSelectMany(ids, m.additive ? "add" : "replace");
                } else if (ids.length > 0) {
                    // Fallback when consumer hasn't wired multi-select.
                    onSelect(ids[0]);
                } else if (!m.additive) {
                    onSelect(null);
                }
            } else if (!m.additive) {
                onSelect(null);
            }
            marqueeRef.current = null;
            setMarquee(null);
        },
        [doc.elements, onSelect, onSelectMany],
    );

    const safeGridStepMm = Number.isFinite(gridStepMm) && gridStepMm > 0
        ? gridStepMm
        : 1;
    const gridSpacingPx = safeGridStepMm * pxPerMm;
    // Sub-pixel grids create moire patterns and cost paint time. Hide them
    // until the selected physical interval is large enough to be useful.
    const gridStyle = showGrid && gridSpacingPx >= 3
        ? {
              backgroundImage: `linear-gradient(to right, rgba(0,0,0,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(0,0,0,0.08) 1px, transparent 1px)`,
              backgroundSize: `${gridSpacingPx}px ${gridSpacingPx}px`,
          }
        : undefined;

    const marqueeRect = marquee
        ? {
              left: Math.min(marquee.sxMm, marquee.cxMm) * pxPerMm,
              top: Math.min(marquee.syMm, marquee.cyMm) * pxPerMm,
              width: Math.abs(marquee.cxMm - marquee.sxMm) * pxPerMm,
              height: Math.abs(marquee.cyMm - marquee.syMm) * pxPerMm,
          }
        : null;

    const onOuterDown = readOnly
        ? undefined
        : (e: React.PointerEvent<HTMLDivElement>) => {
              // Click on the padding area around the rulers/paper — deselect.
              if (e.target === e.currentTarget) onSelect(null);
          };

    return (
        <div
            className="inline-block"
            style={{ padding }}
            onPointerDown={onOuterDown}
        >
            <div
                className="relative"
                style={{
                    width: widthPx + offset,
                    height: heightPx + offset,
                }}
                onPointerDown={onOuterDown}
            >
                {showRulers && (
                    <Rulers
                        widthMm={doc.settings.widthMm}
                        heightMm={doc.settings.heightMm}
                        pxPerMm={pxPerMm}
                        dpi={doc.settings.dpi ?? 203}
                        unit={rulerUnit}
                    />
                )}
                <div
                    className={cn(
                        "absolute bg-white rounded-[10px]",
                        readOnly
                            ? "ring-1 ring-black/[0.08] dark:ring-white/10 overflow-hidden"
                            : "shadow-xl ring-1 ring-black/[0.08] dark:ring-white/10",
                    )}
                    style={{
                        left: offset,
                        top: offset,
                        width: widthPx,
                        height: heightPx,
                        ...gridStyle,
                        touchAction: readOnly ? undefined : "none",
                    }}
                    onPointerDown={readOnly ? undefined : onCanvasDown}
                    onPointerMove={readOnly ? undefined : onCanvasMove}
                    onPointerUp={readOnly ? undefined : onCanvasUp}
                    onPointerCancel={readOnly ? undefined : onCanvasUp}
                    data-print-fidelity={printFidelity ? "true" : undefined}
                    data-testid="designer-paper"
                    data-width-mm={doc.settings.widthMm}
                    data-height-mm={doc.settings.heightMm}
                    data-dpi={doc.settings.dpi ?? 203}
                >
                    {printFidelity ? (
                        <PrintFidelityPreview
                            doc={doc}
                            displayWidthPx={widthPx}
                            displayHeightPx={heightPx}
                            className="rounded-none ring-0"
                            ariaLabel={`${doc.name} print-fidelity preview at ${doc.settings.dpi} dpi`}
                        />
                    ) : (
                        doc.elements.map((el: LabelElement) => (
                            <ElementBox
                                key={el.id}
                                el={el.kind === "text" && el.id !== editingId && rfidTextLastChars(el, doc.settings.rfid)
                                    ? { ...el, text: resolveTextValue(el, "", undefined, doc.settings.rfid, true) }
                                    : el}
                                selected={effectiveSelectedIds.includes(el.id)}
                                editing={el.id === editingId}
                                readOnly={readOnly}
                                highlightVars={highlightVars}
                                forcePrintFidelity={forcePrintFidelity}
                                variables={variables}
                                pxPerMm={pxPerMm}
                                dpi={doc.settings.dpi ?? 203}
                                canvasMm={{
                                    w: doc.settings.widthMm,
                                    h: doc.settings.heightMm,
                                }}
                                snapToGrid={snapToGrid}
                                snapStepMm={snapStepMm}
                                groupMembers={groupMembers}
                                onSelect={onSelect as (id: string, mode?: SelectMode) => void}
                                onMove={onMove}
                                onMoveMany={onMoveMany}
                                onResize={onResize}
                                onBeginEdit={onBeginEdit}
                                onEndEdit={onEndEdit}
                                onUpdateElement={onUpdateElement}
                                onContextMenu={onContextMenu}
                                onSnapGuides={readOnly ? undefined : setSnapGuides}
                            />
                        ))
                    )}
                    {!readOnly && snapGuides.vertical && (
                        <div
                            className="absolute pointer-events-none"
                            style={{
                                left: widthPx / 2,
                                top: 0,
                                width: 1,
                                height: heightPx,
                                background: "rgb(236 72 153)",
                            }}
                        />
                    )}
                    {!readOnly && snapGuides.horizontal && (
                        <div
                            className="absolute pointer-events-none"
                            style={{
                                left: 0,
                                top: heightPx / 2,
                                width: widthPx,
                                height: 1,
                                background: "rgb(236 72 153)",
                            }}
                        />
                    )}
                    {marqueeRect && (
                        <div
                            className="absolute pointer-events-none border border-blue-500 bg-blue-500/10"
                            style={marqueeRect}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
