import type { TextEl } from "./types";
import { dotsPerMm, dotsToMm, mmToDots } from "./units";

export const DEFAULT_TEXT_MARGIN_MM = 0.25;
export const MAX_TEXT_MARGIN_MM = 10;

export function textMarginMm(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(0, Math.min(MAX_TEXT_MARGIN_MM, value))
        : DEFAULT_TEXT_MARGIN_MM;
}

export function textContentFrame(el: TextEl, dpi: number) {
    const margin = textMarginMm(el.marginMm);
    // Round outward: a requested clearance is a minimum distance.
    const inset = margin > 0 ? Math.max(1, Math.ceil(margin * dotsPerMm(dpi) - 1e-9)) : 0;
    return {
        inset,
        x: mmToDots(el.pos.x, dpi) + inset,
        y: mmToDots(el.pos.y, dpi) + inset,
        w: Math.max(0, mmToDots(el.size.w, dpi) - 2 * inset),
        h: Math.max(0, mmToDots(el.size.h, dpi) - 2 * inset),
    };
}

// Inset the physical frame once. Rotation and text alignment then operate
// on the same printable rectangle regardless of the output path.
export function insetTextElement(el: TextEl, dpi: number): TextEl | null {
    const frame = textContentFrame(el, dpi);
    if (!frame.w || !frame.h) return null;
    return {
        ...el, marginMm: 0,
        pos: { x: dotsToMm(frame.x, dpi), y: dotsToMm(frame.y, dpi) },
        size: { w: dotsToMm(frame.w, dpi), h: dotsToMm(frame.h, dpi) },
    };
}
