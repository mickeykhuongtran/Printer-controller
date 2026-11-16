"use client";

import { useMemo } from "react";

import type { QrEl, Rotation } from "../../types";
import { encodeQrMatrix, fitQrToFrameDots, qrMinVersion } from "../../qr-sizing";
import { dotsPerMm } from "../../units";

const VARIABLE_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

interface Props {
    el: QrEl;
    pxPerMm: number;
    dpi?: number;
    highlightVars?: boolean;
}

function normalizedRotation(value: Rotation | undefined): Rotation {
    return value === 90 || value === 180 || value === 270 ? value : 0;
}

function rotatedSquarePixels(
    pixels: readonly number[],
    side: number,
    rotation: Rotation,
): number[] {
    if (rotation === 0) return Array.from(pixels);
    const rotated = new Array<number>(side * side).fill(0);
    for (let row = 0; row < side; row += 1) {
        for (let column = 0; column < side; column += 1) {
            const value = pixels[row * side + column];
            let x = column;
            let y = row;
            if (rotation === 90) {
                x = side - 1 - row;
                y = column;
            } else if (rotation === 180) {
                x = side - 1 - column;
                y = side - 1 - row;
            } else if (rotation === 270) {
                x = row;
                y = side - 1 - column;
            }
            rotated[y * side + x] = value;
        }
    }
    return rotated;
}

export function QrElement({ el, pxPerMm, dpi = 203, highlightVars = false }: Props) {
    const value = el.data;
    const minVersion = qrMinVersion(el.version);
    const encoded = useMemo(() => {
        try {
            return {
                matrix: encodeQrMatrix(value, el.ecc, minVersion),
                error: "",
            };
        } catch (error) {
            return {
                matrix: null,
                error: error instanceof Error ? error.message : "Invalid QR data",
            };
        }
    }, [el.ecc, minVersion, value]);

    const widthPx = el.size.w * pxPerMm;
    const heightPx = el.size.h * pxPerMm;
    if (!encoded.matrix) {
        return (
            <div
                className="bg-white text-red-600 text-[10px] flex items-center justify-center text-center font-mono p-1 overflow-hidden"
                style={{ width: widthPx, height: heightPx }}
                title={encoded.error}
            >
                {value ? "Invalid QR data" : "Empty QR data"}
            </div>
        );
    }

    const nativeDotsPerMm = dotsPerMm(dpi);
    const frameWidthDots = Math.max(1, Math.round(el.size.w * nativeDotsPerMm));
    const frameHeightDots = Math.max(1, Math.round(el.size.h * nativeDotsPerMm));
    const layout = fitQrToFrameDots(
        frameWidthDots,
        frameHeightDots,
        encoded.matrix.columns,
        {
            quietZoneModules: el.quietZoneModules,
            requestedMagnification: el.sizeMode === "manual" ||
                (el.sizeMode === undefined && typeof el.magnification === "number")
                ? el.magnification
                : undefined,
            dpi,
            minModuleMm: el.minModuleMm,
            align: el.align,
            verticalAlign: el.verticalAlign,
        },
    );
    const rotation = normalizedRotation(el.rotation);
    const pixels = rotatedSquarePixels(
        encoded.matrix.pixels,
        encoded.matrix.columns,
        rotation,
    );
    const path: string[] = [];
    for (let row = 0; row < encoded.matrix.rows; row += 1) {
        let column = 0;
        while (column < encoded.matrix.columns) {
            if (!pixels[row * encoded.matrix.columns + column]) {
                column += 1;
                continue;
            }
            const start = column;
            while (
                column < encoded.matrix.columns &&
                pixels[row * encoded.matrix.columns + column]
            ) {
                column += 1;
            }
            const x = layout.dataOffsetXDots + start * layout.moduleDots;
            const y = layout.dataOffsetYDots + row * layout.moduleDots;
            const width = (column - start) * layout.moduleDots;
            path.push(`M${x} ${y}h${width}v${layout.moduleDots}h-${width}z`);
        }
    }

    const hasVar = highlightVars && VARIABLE_RE.test(el.data);
    return (
        <div
            className="bg-white p-0 relative overflow-hidden"
            style={{
                width: widthPx,
                height: heightPx,
                outline: hasVar ? "2px solid rgba(59, 130, 246, 0.7)" : undefined,
                outlineOffset: hasVar ? -2 : undefined,
                boxShadow: !layout.scanSafe
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
                aria-label={`QR preview rotated ${rotation} degrees`}
                data-rotation={rotation}
            >
                <rect
                    x={layout.outerOffsetXDots}
                    y={layout.outerOffsetYDots}
                    width={layout.outerSideDots}
                    height={layout.outerSideDots}
                    fill="#fff"
                />
                <path d={path.join("")} fill="#000" />
            </svg>
            {hasVar && (
                <>
                    <div
                        className="absolute inset-0 pointer-events-none"
                        style={{ background: "rgba(59, 130, 246, 0.18)" }}
                    />
                    <div
                        className="absolute top-0 right-0 px-1 py-0.5 text-[9px] font-mono font-bold rounded-bl"
                        style={{
                            background: "#1d4ed8",
                            color: "white",
                            lineHeight: 1,
                        }}
                    >
                        {"{var}"}
                    </div>
                </>
            )}
        </div>
    );
}
