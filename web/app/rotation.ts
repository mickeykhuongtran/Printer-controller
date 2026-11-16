import type { LabelDoc, LabelElement, Rotation, Size, Vec } from "./types";
import { normalizeLineStroke } from "./line-geometry";

export function normalizeRotation(value: number | undefined): Rotation {
    return value === 90 || value === 180 || value === 270 ? value : 0;
}

export function isQuarterTurn(rotation: number | undefined): boolean {
    return rotation === 90 || rotation === 270;
}

/** size is always the visible, axis-aligned frame, in mm, pixels or dots. */
export function logicalSize(size: Size, rotation: number | undefined): Size {
    return isQuarterTurn(rotation) ? { w: size.h, h: size.w } : { ...size };
}

export function rotationFrame(size: Size, rotationValue: number | undefined) {
    const rotation = normalizeRotation(rotationValue);
    const logical = logicalSize(size, rotation);
    const x = rotation === 90 || rotation === 180 ? size.w : 0;
    const y = rotation === 180 || rotation === 270 ? size.h : 0;
    return {
        ...logical, x, y, radians: rotation * Math.PI / 180,
        style: {
            width: logical.w,
            height: logical.h,
            transform: `translate(${x}px, ${y}px) rotate(${rotation}deg)`,
            transformOrigin: "top left",
        },
    };
}

export function inverseRotatePoint(point: Vec, frame: Size, rotation: number | undefined): Vec {
    if (rotation === 90) return { x: point.y, y: frame.w - point.x };
    if (rotation === 180) return { x: frame.w - point.x, y: frame.h - point.y };
    if (rotation === 270) return { x: frame.h - point.y, y: point.x };
    return point;
}

export function inverseRotateVector(point: Vec, rotation: number | undefined): Vec {
    return inverseRotatePoint(point, { w: 0, h: 0 }, rotation);
}

/** Clockwise rotation about the page, without scaling, clipping or moving IDs. */
export function rotateElement(el: LabelElement, page: Size, rotation: Rotation): LabelElement {
    if (rotation === 0) return el;
    const { x, y } = el.pos;
    const { w, h } = el.size;
    // Remove floating point dust so repeated orientation changes do not drift.
    const clean = (n: number) => Math.round(n * 1e9) / 1e9;
    const pos = rotation === 90 ? { x: page.h - y - h, y: x }
        : rotation === 180 ? { x: page.w - x - w, y: page.h - y - h }
        : { x: y, y: page.w - x - w };
    const base = { ...el, pos: { x: clean(pos.x), y: clean(pos.y) }, size: logicalSize(el.size, rotation) };
    if (el.kind === "rect") return base;
    if (el.kind === "line") {
        const flip = rotation === 180 ||
            (rotation === 90 && el.orientation === "h") ||
            (rotation === 270 && el.orientation === "v");
        const end = el.strokeAnchor === "end";
        return {
            ...el, pos: base.pos, size: base.size,
            orientation: isQuarterTurn(rotation) ? (el.orientation === "h" ? "v" : "h") : el.orientation,
            strokeAnchor: end !== flip ? "end" : "start",
        };
    }
    const next = { ...base, rotation: ((normalizeRotation(el.rotation) + rotation) % 360) as Rotation };
    if (el.kind === "qr" || el.kind === "datamatrix") {
        // Matrix alignment is expressed in physical axes, unlike text/barcodes.
        const ax = el.align === "left" ? -1 : el.align === "right" ? 1 : 0;
        const ay = el.verticalAlign === "top" ? -1 : el.verticalAlign === "bottom" ? 1 : 0;
        const a = inverseRotateVector({ x: ax, y: ay }, ((360 - rotation) % 360) as Rotation);
        return { ...next, kind: el.kind,
            align: a.x < 0 ? "left" : a.x > 0 ? "right" : "center",
            verticalAlign: a.y < 0 ? "top" : a.y > 0 ? "bottom" : "center",
        } as LabelElement;
    }
    return next;
}

/** Settings store the chosen absolute angle; element geometry is already rotated. */
export function rotateTemplate(doc: LabelDoc, rotation: Rotation): LabelDoc {
    const angle = normalizeRotation(rotation);
    const delta = ((angle - normalizeRotation(doc.settings.contentRotation) + 360) % 360) as Rotation;
    if (delta === 0) return doc;
    const page = { w: doc.settings.widthMm, h: doc.settings.heightMm };
    const size = logicalSize(page, delta);
    return { ...doc,
        settings: { ...doc.settings, contentRotation: angle, widthMm: size.w, heightMm: size.h },
        elements: doc.elements.map(el => rotateElement(
            el.kind === "line" ? normalizeLineStroke(el, doc.settings.contentRotation) : el,
            page, delta,
        )),
    };
}
