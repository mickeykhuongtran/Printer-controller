"use client";

import { useMemo } from "react";

import type { BarcodeEl, Rotation } from "../../types";
import {
    barcodeHeightLayout,
    barcodeModuleLayout,
    renderBarcode,
    scanSafeBarcodeNarrowDots,
} from "../../barcode";
import { dotsPerMm, mmToDots } from "../../units";

const VARIABLE_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

interface Props {
    el: BarcodeEl;
    pxPerMm: number;
    dpi?: number;
    highlightVars?: boolean;
}

function normalizedRotation(value: Rotation | undefined): Rotation {
    return value === 90 || value === 180 || value === 270 ? value : 0;
}

function groupTransform(
    rotation: Rotation,
    frameWidthDots: number,
    frameHeightDots: number,
): string | undefined {
    if (rotation === 90) return `translate(${frameWidthDots} 0) rotate(90)`;
    if (rotation === 180) {
        return `translate(${frameWidthDots} ${frameHeightDots}) rotate(180)`;
    }
    if (rotation === 270) return `translate(0 ${frameHeightDots}) rotate(-90)`;
    return undefined;
}

export function BarcodeElement({ el, pxPerMm, dpi = 203, highlightVars = false }: Props) {
    const widthPx = el.size.w * pxPerMm;
    const heightPx = el.size.h * pxPerMm;
    const result = useMemo(
        () => renderBarcode(el.data, el.symbology),
        [el.data, el.symbology],
    );
    const hasVar = highlightVars && VARIABLE_RE.test(el.data);

    if (!result) {
        return (
            <div
                className="bg-white text-red-600 text-[10px] flex items-center justify-center font-mono"
                style={{ width: widthPx, height: heightPx }}
            >
                Invalid {el.symbology}
            </div>
        );
    }

    const rotation = normalizedRotation(el.rotation);
    const frameWidthDots = Math.max(1, mmToDots(el.size.w, dpi));
    const frameHeightDots = Math.max(1, mmToDots(el.size.h, dpi));
    const quarterTurn = rotation === 90 || rotation === 270;
    const logicalWidthDots = quarterTurn ? frameHeightDots : frameWidthDots;
    const logicalHeightDots = quarterTurn ? frameWidthDots : frameHeightDots;
    const manual = el.sizeMode === "manual" ||
        (el.sizeMode === undefined && typeof el.narrowDots === "number");
    const layout = barcodeModuleLayout({
        containerDots: logicalWidthDots,
        totalModules: result.totalModules,
        quietZoneLeftModules: result.quietZoneLeftModules,
        quietZoneRightModules: result.quietZoneRightModules,
        dpi,
        minModuleMm: el.minModuleMm,
        align: el.align ?? "center",
        mode: manual ? "fixed" : "auto",
        requestedDotsPerModule: manual
            ? (el.narrowDots ?? scanSafeBarcodeNarrowDots(dpi))
            : undefined,
    });
    const vertical = barcodeHeightLayout({
        frameHeightDots: logicalHeightDots,
        dpi,
        humanReadable: el.humanReadable,
        barHeightMm: el.barHeightMm,
        textSizeMm: el.textSizeMm,
        textPaddingMm: el.textPaddingMm,
        textPosition: el.textPosition,
    });
    const textAbove = (el.textPosition ?? "below") === "above";
    const guardExtension = el.symbology === "EAN13" && el.humanReadable
        ? Math.min(
              Math.max(1, Math.round(vertical.textHeightDots * 0.25)),
              Math.max(0, vertical.barHeightDots - 2),
          )
        : 0;
    const overlapsGuard = (start: number, end: number) =>
        (start < 3 && end > 0) ||
        (start < 50 && end > 45) ||
        (start < 95 && end > 92);
    const bars: React.ReactElement[] = [];
    let cursorDots = layout.barOffsetDots;
    let symbolModule = 0;
    result.widths.forEach((moduleWidth, index) => {
        const widthDots = moduleWidth * layout.narrowDots;
        if (index % 2 === 0) {
            const guard = el.symbology === "EAN13" &&
                overlapsGuard(symbolModule, symbolModule + moduleWidth);
            const shortened = guard ? 0 : guardExtension;
            bars.push(
                <rect
                    key={index}
                    x={cursorDots}
                    y={vertical.barsOffsetDots + (textAbove ? shortened : 0)}
                    width={widthDots}
                    height={Math.max(2, vertical.barHeightDots - shortened)}
                    fill="#000"
                />,
            );
        }
        cursorDots += widthDots;
        symbolModule += moduleWidth;
    });

    const hri = !el.humanReadable
        ? null
        : el.symbology === "EAN13" && result.render.length === 13
          ? (
                <g
                    fill="#000"
                    fontFamily="Andale Mono, Liberation Mono, monospace"
                    fontSize={vertical.textHeightDots}
                    textAnchor="middle"
                    dominantBaseline="hanging"
                >
                    <text
                        x={Math.max(layout.narrowDots * 2, layout.barOffsetDots - layout.narrowDots * 4)}
                        y={vertical.textOffsetDots}
                    >
                        {result.render[0]}
                    </text>
                    <text
                        x={layout.barOffsetDots + layout.narrowDots * 24}
                        y={vertical.textOffsetDots}
                    >
                        {result.render.slice(1, 7)}
                    </text>
                    <text
                        x={layout.barOffsetDots + layout.narrowDots * 71}
                        y={vertical.textOffsetDots}
                    >
                        {result.render.slice(7)}
                    </text>
                </g>
            )
          : (
                <text
                    x={
                        (el.textAlign ?? "center") === "left"
                            ? 0
                            : (el.textAlign ?? "center") === "right"
                              ? logicalWidthDots
                              : logicalWidthDots / 2
                    }
                    y={vertical.textOffsetDots}
                    fill="#000"
                    fontFamily="Andale Mono, Liberation Mono, monospace"
                    fontSize={vertical.textHeightDots}
                    textAnchor={
                        (el.textAlign ?? "center") === "left"
                            ? "start"
                            : (el.textAlign ?? "center") === "right"
                              ? "end"
                              : "middle"
                    }
                    dominantBaseline="hanging"
                >
                    {result.render}
                </text>
            );

    return (
        <div
            className="bg-white text-black overflow-hidden relative"
            style={{
                width: widthPx,
                height: heightPx,
                outline: hasVar ? "2px solid rgba(59, 130, 246, 0.7)" : undefined,
                outlineOffset: hasVar ? -2 : undefined,
                boxShadow: !layout.scanSafe || !vertical.fitsFrame
                    ? "inset 0 0 0 2px rgba(220,38,38,0.75)"
                    : undefined,
            }}
        >
            <svg
                width="100%"
                height="100%"
                viewBox={`0 0 ${frameWidthDots} ${frameHeightDots}`}
                preserveAspectRatio="none"
                shapeRendering="crispEdges"
                data-rotation={rotation}
                data-dots-per-mm={dotsPerMm(dpi)}
                aria-label={`${el.symbology} preview rotated ${rotation} degrees`}
            >
                <rect width={frameWidthDots} height={frameHeightDots} fill="#fff" />
                <g transform={groupTransform(rotation, frameWidthDots, frameHeightDots)}>
                    {bars}
                    {hri}
                </g>
            </svg>
            {hasVar && (
                <>
                    <div
                        className="absolute inset-0 pointer-events-none"
                        style={{ background: "rgba(59, 130, 246, 0.18)" }}
                    />
                    <div
                        className="absolute top-0 right-0 px-1 py-0.5 text-[9px] font-mono font-bold rounded-bl"
                        style={{ background: "#1d4ed8", color: "white", lineHeight: 1 }}
                    >
                        {"{var}"}
                    </div>
                </>
            )}
        </div>
    );
}
