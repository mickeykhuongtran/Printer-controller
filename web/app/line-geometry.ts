import type { LineEl } from "./types";
import { mmToDots } from "./units";

/** Older 3.8 templates moved line frames but left the ink on the start edge. */
export function normalizeLineStroke(el: LineEl, templateRotation = 0): LineEl {
    if (el.strokeAnchor === "start" || el.strokeAnchor === "end") return el;
    const end = el.orientation === "h"
        ? templateRotation === 180 || templateRotation === 270
        : templateRotation === 90 || templateRotation === 180;
    return { ...el, strokeAnchor: end ? "end" : "start" };
}

/** Local ink bounds, distinct from the editable frame, on the printer-dot grid. */
export function lineStrokeBoundsDots(el: LineEl, dpi: number) {
    const width = Math.max(1, mmToDots(el.size.w, dpi));
    const height = Math.max(1, mmToDots(el.size.h, dpi));
    const thickness = Math.max(1, mmToDots(el.thickness, dpi));
    const horizontal = el.orientation === "h";
    return {
        x: !horizontal && el.strokeAnchor === "end" ? width - thickness : 0,
        y: horizontal && el.strokeAnchor === "end" ? height - thickness : 0,
        w: horizontal ? width : thickness,
        h: horizontal ? thickness : height,
        thickness,
    };
}
