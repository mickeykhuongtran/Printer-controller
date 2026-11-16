"use client";

import type { LineEl } from "../../types";
import { dotsPerMm } from "../../units";
import { lineStrokeBoundsDots } from "../../line-geometry";

interface Props {
    el: LineEl;
    pxPerMm: number;
    dpi?: number;
}

export function LineElement({ el, pxPerMm, dpi = 203 }: Props) {
    const ink = lineStrokeBoundsDots(el, dpi);
    const scale = pxPerMm / dotsPerMm(dpi);
    return (
        <div
            style={{
                position: "relative",
                left: ink.x * scale,
                top: ink.y * scale,
                width: ink.w * scale,
                height: ink.h * scale,
                background: "#000",
            }}
        />
    );
}
