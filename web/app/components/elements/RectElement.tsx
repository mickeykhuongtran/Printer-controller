"use client";

import type { RectEl } from "../../types";
import { dotsPerMm } from "../../units";

interface Props {
    el: RectEl;
    pxPerMm: number;
    dpi?: number;
}

export function RectElement({ el, pxPerMm, dpi = 203 }: Props) {
    const widthPx = el.size.w * pxPerMm;
    const heightPx = el.size.h * pxPerMm;
    const nativeDotsPerMm = dotsPerMm(dpi);
    const thicknessDots = Math.max(1, Math.round(el.thickness * nativeDotsPerMm));
    const borderPx = thicknessDots * (pxPerMm / nativeDotsPerMm);
    return (
        <div
            style={{
                width: widthPx,
                height: heightPx,
                background: el.filled ? "#000" : "transparent",
                border: el.filled ? "none" : `${borderPx}px solid #000`,
                boxSizing: "border-box",
            }}
        />
    );
}
