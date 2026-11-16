import bwipjs from "bwip-js/browser";

import type {
    DataMatrixContentFormat,
    DataMatrixEl,
    DataMatrixShape,
    DataMatrixTextEncoding,
} from "./types";
import { dotsToMm } from "./units";

export const DATA_MATRIX_MIN_QUIET_ZONE_MODULES = 1;
export const DEFAULT_DATA_MATRIX_MIN_MODULE_MM = 0.25;
export const DEFAULT_DATA_MATRIX_SIZING_DPI = 203;
export const ZEBRA_DATA_MATRIX_MAX_MODULE_DOTS = 40;

export type DataMatrixEncodeOptions = {
    contentFormat?: DataMatrixContentFormat;
    shape?: DataMatrixShape;
    textEncoding?: DataMatrixTextEncoding;
    /** Fixed ECC 200 symbol dimensions. Both values are required together. */
    symbolRows?: number;
    symbolColumns?: number;
};

export const DATA_MATRIX_ECC200_SQUARE_SIZES = [
    10, 12, 14, 16, 18, 20, 22, 24, 26, 32, 36, 40, 44, 48, 52,
    64, 72, 80, 88, 96, 104, 120, 132, 144,
] as const;

export const DATA_MATRIX_ECC200_RECTANGLE_SIZES = [
    [8, 18],
    [8, 32],
    [12, 26],
    [12, 36],
    [16, 36],
    [16, 48],
] as const;

export type DataMatrixMatrix = {
    columns: number;
    rows: number;
    /** Row-major modules. A truthy value is a black module. */
    pixels: readonly number[];
};

export type DataMatrixLayoutOptions = {
    quietZoneModules?: number;
    requestedMagnification?: number;
    dpi?: number;
    minModuleMm?: number;
    align?: DataMatrixEl["align"];
    verticalAlign?: DataMatrixEl["verticalAlign"];
};

export type DataMatrixFrameLayout = {
    frameWidthDots: number;
    frameHeightDots: number;
    matrixColumns: number;
    matrixRows: number;
    outerColumns: number;
    outerRows: number;
    quietZoneModules: number;
    auto: boolean;
    desiredModuleDots: number;
    moduleDots: number;
    dpi: number;
    moduleSizeMm: number;
    minModuleMm: number;
    dataWidthDots: number;
    dataHeightDots: number;
    outerWidthDots: number;
    outerHeightDots: number;
    dataOffsetXDots: number;
    dataOffsetYDots: number;
    outerOffsetXDots: number;
    outerOffsetYDots: number;
    fitsFrame: boolean;
    scanSafe: boolean;
};

const MATRIX_CACHE_LIMIT = 256;
const matrixCache = new Map<string, DataMatrixMatrix>();

function contentFormat(value: DataMatrixContentFormat | undefined): DataMatrixContentFormat {
    return value === "gs1" || value === "gs1_digital_link" ? value : "standard";
}

function shape(value: DataMatrixShape | undefined): DataMatrixShape {
    return value === "rectangle" ? "rectangle" : "square";
}

function textEncoding(value: DataMatrixTextEncoding | undefined): DataMatrixTextEncoding {
    return value === "latin1" ? "latin1" : "utf8";
}

function latin1Text(value: string): string {
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) > 0xff) {
            throw new RangeError(
                "ISO-8859-1 encoding only supports characters U+0000 through U+00FF.",
            );
        }
    }
    return value;
}

function fixedSymbolVersion(
    options: DataMatrixEncodeOptions,
    selectedShape: DataMatrixShape,
): { rows: number; columns: number; version: string } | undefined {
    const hasRows = options.symbolRows !== undefined;
    const hasColumns = options.symbolColumns !== undefined;
    if (!hasRows && !hasColumns) return undefined;
    if (!hasRows || !hasColumns) {
        throw new RangeError("Fixed Data Matrix size requires both rows and columns.");
    }
    const rows = options.symbolRows as number;
    const columns = options.symbolColumns as number;
    if (
        !Number.isFinite(rows) ||
        !Number.isFinite(columns) ||
        !Number.isInteger(rows) ||
        !Number.isInteger(columns) ||
        rows <= 0 ||
        columns <= 0
    ) {
        throw new RangeError("Data Matrix rows and columns must be positive whole numbers.");
    }

    const valid = selectedShape === "square"
        ? rows === columns && DATA_MATRIX_ECC200_SQUARE_SIZES.includes(
              rows as (typeof DATA_MATRIX_ECC200_SQUARE_SIZES)[number],
          )
        : DATA_MATRIX_ECC200_RECTANGLE_SIZES.some(
              ([allowedRows, allowedColumns]) =>
                  rows === allowedRows && columns === allowedColumns,
          );
    if (!valid) {
        throw new RangeError(
            `${rows}x${columns} is not a supported ${selectedShape} Data Matrix ECC 200 size.`,
        );
    }
    return { rows, columns, version: `${rows}x${columns}` };
}

function encoderOptions(data: string, options: DataMatrixEncodeOptions) {
    const selectedFormat = contentFormat(options.contentFormat);
    const selectedShape = shape(options.shape);
    const selectedEncoding = textEncoding(options.textEncoding);
    if (selectedFormat !== "standard" && selectedEncoding !== "utf8") {
        throw new RangeError("GS1 Data Matrix formats require UTF-8 text encoding.");
    }
    const fixedSize = fixedSymbolVersion(options, selectedShape);
    const text = selectedEncoding === "latin1" ? latin1Text(data) : data;
    const bcid = selectedFormat === "gs1"
        ? "gs1datamatrix"
        : selectedFormat === "gs1_digital_link"
          ? "gs1dldatamatrix"
          : "datamatrix";
    return {
        bcid,
        text,
        ...(selectedShape === "rectangle" ? { format: "rectangle" } : {}),
        ...(selectedEncoding === "latin1" ? { binarytext: true } : {}),
        ...(fixedSize ? { version: fixedSize.version } : {}),
    };
}

function friendlyEncoderError(error: unknown): Error {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw
        .replace(/^Error:\s*/i, "")
        .replace(/^bwipp\.[^:]+:\s*/i, "")
        .replace(/^bwip-js:\s*/i, "")
        .trim();
    return new Error(message || "Data Matrix data cannot be encoded.");
}

/**
 * Encode a Data Matrix ECC 200 symbol and expose its exact module grid.
 * bwip-js performs the capacity, GS1 and GS1 Digital Link validation; every
 * renderer consumes this same matrix so the designer and printed graphic do
 * not silently choose different rows/columns.
 */
export function encodeDataMatrix(
    data: string,
    options: DataMatrixEncodeOptions = {},
): DataMatrixMatrix {
    if (!data) throw new RangeError("Data Matrix data must not be empty.");
    const selectedFormat = contentFormat(options.contentFormat);
    const selectedShape = shape(options.shape);
    const selectedEncoding = textEncoding(options.textEncoding);
    const fixedSize = fixedSymbolVersion(options, selectedShape);
    const fixedVersion = fixedSize?.version ?? "auto";
    const key = `${selectedFormat}\u0000${selectedShape}\u0000${selectedEncoding}\u0000${fixedVersion}\u0000${data}`;
    const cached = matrixCache.get(key);
    if (cached) return cached;

    try {
        const raw = bwipjs.raw(encoderOptions(data, options));
        const matrix = raw.find(
            (entry): entry is {
                pixs: number[];
                pixx: number;
                pixy: number;
                height: number;
                width: number;
            } => "pixs" in entry && "pixx" in entry && "pixy" in entry,
        );
        if (!matrix || matrix.pixx <= 0 || matrix.pixy <= 0) {
            throw new Error("Encoder returned an empty Data Matrix.");
        }
        if (
            fixedSize &&
            (matrix.pixx !== fixedSize.columns || matrix.pixy !== fixedSize.rows)
        ) {
            throw new Error(
                `Encoder returned ${matrix.pixy}x${matrix.pixx}, expected ${fixedSize.rows}x${fixedSize.columns}.`,
            );
        }
        const result: DataMatrixMatrix = {
            columns: matrix.pixx,
            rows: matrix.pixy,
            pixels: matrix.pixs.slice(),
        };
        if (matrixCache.size >= MATRIX_CACHE_LIMIT) {
            const oldest = matrixCache.keys().next().value as string | undefined;
            if (oldest !== undefined) matrixCache.delete(oldest);
        }
        matrixCache.set(key, result);
        return result;
    } catch (error) {
        throw friendlyEncoderError(error);
    }
}

function positiveRounded(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.round(value))
        : fallback;
}

function alignedOffset(
    remaining: number,
    alignment: "start" | "center" | "end",
): number {
    if (alignment === "start") return 0;
    if (alignment === "end") return remaining;
    return Math.floor(remaining / 2);
}

/** Fit an ECC 200 module grid and protected quiet zone to a printer-dot frame. */
export function fitDataMatrixToFrameDots(
    frameWidthDots: number,
    frameHeightDots: number,
    matrixColumns: number,
    matrixRows: number,
    options: DataMatrixLayoutOptions = {},
): DataMatrixFrameLayout {
    const safeWidth = positiveRounded(frameWidthDots, 1);
    const safeHeight = positiveRounded(frameHeightDots, 1);
    const safeColumns = positiveRounded(matrixColumns, 10);
    const safeRows = positiveRounded(matrixRows, 10);
    const quietZoneModules = Math.max(
        DATA_MATRIX_MIN_QUIET_ZONE_MODULES,
        Math.ceil(positiveRounded(options.quietZoneModules, DATA_MATRIX_MIN_QUIET_ZONE_MODULES)),
    );
    const outerColumns = safeColumns + quietZoneModules * 2;
    const outerRows = safeRows + quietZoneModules * 2;
    const requested = typeof options.requestedMagnification === "number" &&
        Number.isFinite(options.requestedMagnification) &&
        options.requestedMagnification > 0
        ? Math.max(1, Math.round(options.requestedMagnification))
        : undefined;
    const auto = requested === undefined;
    const desiredModuleDots = requested ?? Math.max(
        1,
        Math.min(
            Math.floor(safeWidth / outerColumns),
            Math.floor(safeHeight / outerRows),
        ),
    );
    const moduleDots = Math.min(ZEBRA_DATA_MATRIX_MAX_MODULE_DOTS, desiredModuleDots);
    const dataWidthDots = safeColumns * moduleDots;
    const dataHeightDots = safeRows * moduleDots;
    const outerWidthDots = outerColumns * moduleDots;
    const outerHeightDots = outerRows * moduleDots;
    const remainingX = safeWidth - outerWidthDots;
    const remainingY = safeHeight - outerHeightDots;
    const horizontal = options.align === "left"
        ? "start"
        : options.align === "right"
          ? "end"
          : "center";
    const vertical = options.verticalAlign === "top"
        ? "start"
        : options.verticalAlign === "bottom"
          ? "end"
          : "center";
    const outerOffsetXDots = alignedOffset(remainingX, horizontal);
    const outerOffsetYDots = alignedOffset(remainingY, vertical);
    const dataOffsetXDots = outerOffsetXDots + quietZoneModules * moduleDots;
    const dataOffsetYDots = outerOffsetYDots + quietZoneModules * moduleDots;
    const dpi = typeof options.dpi === "number" && Number.isFinite(options.dpi) && options.dpi > 0
        ? options.dpi
        : DEFAULT_DATA_MATRIX_SIZING_DPI;
    const minModuleMm = typeof options.minModuleMm === "number" &&
        Number.isFinite(options.minModuleMm) &&
        options.minModuleMm > 0
        ? options.minModuleMm
        : DEFAULT_DATA_MATRIX_MIN_MODULE_MM;
    const moduleSizeMm = dotsToMm(moduleDots, dpi);
    const fitsFrame = outerWidthDots <= safeWidth && outerHeightDots <= safeHeight;
    return {
        frameWidthDots: safeWidth,
        frameHeightDots: safeHeight,
        matrixColumns: safeColumns,
        matrixRows: safeRows,
        outerColumns,
        outerRows,
        quietZoneModules,
        auto,
        desiredModuleDots,
        moduleDots,
        dpi,
        moduleSizeMm,
        minModuleMm,
        dataWidthDots,
        dataHeightDots,
        outerWidthDots,
        outerHeightDots,
        dataOffsetXDots,
        dataOffsetYDots,
        outerOffsetXDots,
        outerOffsetYDots,
        fitsFrame,
        scanSafe: fitsFrame && moduleSizeMm >= minModuleMm,
    };
}
