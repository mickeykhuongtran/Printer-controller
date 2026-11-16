"use client";

import { useMemo } from "react";

import type { DataMatrixEl, Rotation } from "../../types";
import {
    encodeDataMatrix,
    fitDataMatrixToFrameDots,
    type DataMatrixMatrix,
} from "../../datamatrix";
import { dotsPerMm } from "../../units";

const VARIABLE_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

interface Props {
    el: DataMatrixEl;
    pxPerMm: number;
    dpi?: number;
    highlightVars?: boolean;
}

function normalizedRotation(value: Rotation | undefined): Rotation {
    return value === 90 || value === 180 || value === 270 ? value : 0;
}

function rotateMatrix(matrix: DataMatrixMatrix, rotation: Rotation): DataMatrixMatrix {
    if (rotation === 0) return matrix;
    const columns = rotation === 90 || rotation === 270 ? matrix.rows : matrix.columns;
    const rows = rotation === 90 || rotation === 270 ? matrix.columns : matrix.rows;
    const pixels = new Array<number>(columns * rows).fill(0);
    for (let sourceRow = 0; sourceRow < matrix.rows; sourceRow += 1) {
        for (let sourceColumn = 0; sourceColumn < matrix.columns; sourceColumn += 1) {
            const value = matrix.pixels[sourceRow * matrix.columns + sourceColumn];
            let x = sourceColumn;
            let y = sourceRow;
            if (rotation === 90) {
                x = matrix.rows - 1 - sourceRow;
                y = sourceColumn;
            } else if (rotation === 180) {
                x = matrix.columns - 1 - sourceColumn;
                y = matrix.rows - 1 - sourceRow;
            } else if (rotation === 270) {
                x = sourceRow;
                y = matrix.columns - 1 - sourceColumn;
            }
            pixels[y * columns + x] = value;
        }
    }
    return { columns, rows, pixels };
}

export function DataMatrixElement({
    el,
    pxPerMm,
    dpi = 203,
    highlightVars = false,
}: Props) {
    const encoded = useMemo(() => {
        try {
            return {
                matrix: encodeDataMatrix(el.data, {
                    contentFormat: el.contentFormat,
                    shape: el.shape,
                    textEncoding: el.textEncoding,
                    symbolRows: el.symbolRows,
                    symbolColumns: el.symbolColumns,
                }),
                error: "",
            };
        } catch (error) {
            return {
                matrix: null,
                error: error instanceof Error ? error.message : "Invalid Data Matrix data",
            };
        }
    }, [
        el.contentFormat,
        el.data,
        el.shape,
        el.symbolColumns,
        el.symbolRows,
        el.textEncoding,
    ]);

    const widthPx = el.size.w * pxPerMm;
    const heightPx = el.size.h * pxPerMm;
    if (!encoded.matrix) {
        return (
            <div
                className="bg-white text-red-600 text-[10px] flex items-center justify-center text-center font-mono p-1 overflow-hidden"
                style={{ width: widthPx, height: heightPx }}
                title={encoded.error}
            >
                {el.data ? "Invalid Data Matrix" : "Empty Data Matrix data"}
            </div>
        );
    }

    const rotation = normalizedRotation(el.rotation);
    const matrix = rotateMatrix(encoded.matrix, rotation);
    const nativeDotsPerMm = dotsPerMm(dpi);
    const frameWidthDots = Math.max(1, Math.round(el.size.w * nativeDotsPerMm));
    const frameHeightDots = Math.max(1, Math.round(el.size.h * nativeDotsPerMm));
    const layout = fitDataMatrixToFrameDots(
        frameWidthDots,
        frameHeightDots,
        matrix.columns,
        matrix.rows,
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
    const hasVar = highlightVars && VARIABLE_RE.test(el.data);
    const path: string[] = [];
    for (let row = 0; row < matrix.rows; row += 1) {
        let column = 0;
        while (column < matrix.columns) {
            if (!matrix.pixels[row * matrix.columns + column]) {
                column += 1;
                continue;
            }
            const start = column;
            while (
                column < matrix.columns &&
                matrix.pixels[row * matrix.columns + column]
            ) {
                column += 1;
            }
            const x = layout.dataOffsetXDots + start * layout.moduleDots;
            const y = layout.dataOffsetYDots + row * layout.moduleDots;
            const width = (column - start) * layout.moduleDots;
            path.push(`M${x} ${y}h${width}v${layout.moduleDots}h-${width}z`);
        }
    }

    return (
        <div
            className="bg-white relative overflow-hidden"
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
                aria-label={`Data Matrix preview rotated ${rotation} degrees`}
                data-rotation={rotation}
                data-symbol-size={`${matrix.rows}x${matrix.columns}`}
            >
                <rect
                    x={layout.outerOffsetXDots}
                    y={layout.outerOffsetYDots}
                    width={layout.outerWidthDots}
                    height={layout.outerHeightDots}
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
                        style={{ background: "#1d4ed8", color: "white", lineHeight: 1 }}
                    >
                        {"{var}"}
                    </div>
                </>
            )}
        </div>
    );
}
