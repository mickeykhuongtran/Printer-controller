"use client";

import type { CSSProperties, ReactElement } from "react";
import { dotsPerMm } from "../units";

export type RulerUnit = "mm" | "dot";

interface Props {
    widthMm: number;
    heightMm: number;
    pxPerMm: number;
    dpi?: number;
    unit?: RulerUnit;
}

const RULER_THICKNESS = 18;
const MIN_TICK_SPACING_PX = 3;
const MIN_LABEL_SPACING_PX = 38;
const MAX_TICKS_PER_AXIS = 800;
const MAX_LABELS_PER_AXIS = 160;

type Axis = "horizontal" | "vertical";

function niceStep(minimum: number): number {
    if (!Number.isFinite(minimum) || minimum <= 1) return 1;
    const exponent = Math.floor(Math.log10(minimum));
    const magnitude = 10 ** exponent;
    const fraction = minimum / magnitude;
    const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
    return niceFraction * magnitude;
}

function formatValue(value: number, unit: RulerUnit): string {
    if (unit === "dot") return String(Math.round(value));
    if (Math.abs(value - Math.round(value)) < 1e-6) return String(Math.round(value));
    return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function axisStyle(axis: Axis, offset: number, length: number): CSSProperties {
    return axis === "horizontal"
        ? { left: offset, bottom: 0, width: 1, height: length }
        : { top: offset, right: 0, height: 1, width: length };
}

function labelStyle(axis: Axis, offset: number): CSSProperties {
    return axis === "horizontal"
        ? { left: offset + 2, top: 1 }
        : { top: offset + 1, left: 2 };
}

function buildAxis(
    axis: Axis,
    lengthMm: number,
    pxPerMm: number,
    unit: RulerUnit,
    dpi: number,
): ReactElement[] {
    const unitsPerMm = unit === "dot" ? dotsPerMm(dpi) : 1;
    const totalUnits = Math.max(0, lengthMm * unitsPerMm);
    const pxPerUnit = pxPerMm / unitsPerMm;
    const minimumTickStep = Math.max(
        1,
        MIN_TICK_SPACING_PX / Math.max(pxPerUnit, 0.0001),
        totalUnits / MAX_TICKS_PER_AXIS,
    );
    const tickStep = niceStep(minimumTickStep);
    const labelStep = niceStep(Math.max(
        tickStep,
        MIN_LABEL_SPACING_PX / Math.max(pxPerUnit, 0.0001),
        totalUnits / MAX_LABELS_PER_AXIS,
    ));
    const nodes: ReactElement[] = [];
    const epsilon = Math.max(1e-7, tickStep / 1000);
    const axisKey = axis === "horizontal" ? "h" : "v";

    for (
        let index = 0, value = 0;
        value <= totalUnits + epsilon && index <= MAX_TICKS_PER_AXIS + 1;
        index += 1, value = index * tickStep
    ) {
        const offset = (value / unitsPerMm) * pxPerMm;
        nodes.push(
            <div
                key={`${axisKey}-tick-${index}`}
                className="absolute bg-foreground/35"
                style={axisStyle(axis, offset, 3)}
            />,
        );
    }

    const labelEpsilon = Math.max(1e-7, labelStep / 1000);
    for (
        let index = 1, value = labelStep;
        value <= totalUnits + labelEpsilon && index <= MAX_LABELS_PER_AXIS;
        index += 1, value = index * labelStep
    ) {
        const offset = (value / unitsPerMm) * pxPerMm;
        nodes.push(
            <div
                key={`${axisKey}-major-${index}`}
                className="absolute bg-foreground/50"
                style={axisStyle(axis, offset, 10)}
            />,
            <div
                key={`${axisKey}-label-${index}`}
                className="absolute whitespace-nowrap font-mono text-[9px] leading-none text-foreground/70"
                style={labelStyle(axis, offset)}
            >
                {formatValue(value, unit)}
            </div>,
        );
    }

    return nodes;
}

export function Rulers({
    widthMm,
    heightMm,
    pxPerMm,
    dpi = 203,
    unit = "mm",
}: Props) {
    const horizontal = buildAxis("horizontal", widthMm, pxPerMm, unit, dpi);
    const vertical = buildAxis("vertical", heightMm, pxPerMm, unit, dpi);

    return (
        <>
            <div
                className="absolute overflow-hidden border-b border-foreground/20 bg-background/40"
                style={{
                    left: RULER_THICKNESS,
                    top: 0,
                    width: widthMm * pxPerMm,
                    height: RULER_THICKNESS,
                }}
                aria-hidden="true"
            >
                {horizontal}
            </div>
            <div
                className="absolute overflow-hidden border-r border-foreground/20 bg-background/40"
                style={{
                    left: 0,
                    top: RULER_THICKNESS,
                    width: RULER_THICKNESS,
                    height: heightMm * pxPerMm,
                }}
                aria-hidden="true"
            >
                {vertical}
            </div>
            <div
                className="absolute flex items-center justify-center border-r border-b border-foreground/20 bg-background/60 font-mono text-[8px] uppercase text-foreground/60"
                style={{
                    left: 0,
                    top: 0,
                    width: RULER_THICKNESS,
                    height: RULER_THICKNESS,
                }}
                title={unit === "dot" ? `${dpi} dpi printer dots` : "Millimetres"}
            >
                {unit === "dot" ? "dot" : "mm"}
            </div>
        </>
    );
}

export const RULER_OFFSET = RULER_THICKNESS;
