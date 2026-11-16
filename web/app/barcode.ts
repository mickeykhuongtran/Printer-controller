// Inline Code128 + EAN-13 encoders. Widths are expressed in barcode modules.
// Each entry alternates bar, gap, bar, gap, ... starting with bar. Renderers
// must add the quiet zone before the first bar and after the last bar.

import { dotsPerMm, dotsToMm, mmToDots } from "./units";

export const CODE128_QUIET_ZONE_LEFT_MODULES = 10;
export const CODE128_QUIET_ZONE_RIGHT_MODULES = 10;
export const EAN13_QUIET_ZONE_LEFT_MODULES = 11;
export const EAN13_QUIET_ZONE_RIGHT_MODULES = 7;

/**
 * Backward-compatible Code 128 quiet-zone default. New code that knows the
 * symbology should use the explicit left/right constants above.
 */
export const BARCODE_QUIET_ZONE_MODULES = CODE128_QUIET_ZONE_LEFT_MODULES;
export const BARCODE_SCAN_SAFE_X_MM = 0.25;

export type BarcodeSizingMode = "auto" | "fixed";

export type BarcodeHeightLayoutOptions = {
    frameHeightDots: number;
    dpi: number;
    humanReadable: boolean;
    barHeightMm?: number;
    textSizeMm?: number;
    textPaddingMm?: number;
    textPosition?: "above" | "below";
};

export type BarcodeHeightLayout = {
    frameHeightDots: number;
    barHeightDots: number;
    barHeightMm: number;
    textHeightDots: number;
    textPaddingDots: number;
    barsOffsetDots: number;
    textOffsetDots: number;
    totalHeightDots: number;
    fitsFrame: boolean;
};

export type BarcodeModuleLayout = {
    mode: BarcodeSizingMode;
    containerDots: number;
    totalModules: number;
    quietZoneLeftModules: number;
    quietZoneRightModules: number;
    narrowDots: number;
    /** Additive, explicit alias for narrowDots. */
    dotsPerModule: number;
    /** Physical X-dimension represented by one narrow module. */
    xDimensionMm: number;
    minimumXDimensionMm: number;
    safeNarrowDots: number;
    maxFittingNarrowDots: number;
    printedWidthDots: number;
    printedWidthMm: number;
    requiredSafeWidthDots: number;
    requiredSafeWidthMm: number;
    leftInsetDots: number;
    barOffsetDots: number;
    fitsFrame: boolean;
    scanSafe: boolean;
    overflow: boolean;
    overflowDots: number;
    overflowMm: number;
};

/**
 * Minimum integer X-dimension that keeps a linear barcode near 0.25 mm.
 * This maps Zebra printheads to 203 -> 2, 300 -> 3, and 600 -> 6 dots.
 */
export function scanSafeBarcodeNarrowDots(dpi: number): number {
    return Math.max(1, Math.round(BARCODE_SCAN_SAFE_X_MM * dotsPerMm(dpi)));
}

/** Whole-dot X-dimension that meets a deployment/scanner minimum. */
export function barcodeNarrowDotsForMm(dpi: number, minModuleMm: number): number {
    const safeMm = Number.isFinite(minModuleMm)
        ? Math.max(0.1, Math.min(2, minModuleMm))
        : BARCODE_SCAN_SAFE_X_MM;
    return Math.max(1, Math.min(10, Math.ceil(safeMm * dotsPerMm(dpi) - 1e-9)));
}

/**
 * Resolve the physical bar area and optional human-readable interpretation
 * line inside one barcode frame. All values stay on Zebra's canonical
 * 8/12/24 dots-per-mm grid so preview, preflight and ZPL agree at every DPI.
 */
export function barcodeHeightLayout(
    options: BarcodeHeightLayoutOptions,
): BarcodeHeightLayout {
    const frameHeightDots = Math.max(1, Math.round(options.frameHeightDots));
    const humanReadable = !!options.humanReadable;
    const textSizeMm = typeof options.textSizeMm === "number" && Number.isFinite(options.textSizeMm)
        ? Math.max(0.5, Math.min(20, options.textSizeMm))
        : 2;
    const textPaddingMm = typeof options.textPaddingMm === "number" && Number.isFinite(options.textPaddingMm)
        ? Math.max(0, Math.min(20, options.textPaddingMm))
        : 0.3;
    const textHeightDots = humanReadable ? Math.max(1, mmToDots(textSizeMm, options.dpi)) : 0;
    const textPaddingDots = humanReadable ? Math.max(0, mmToDots(textPaddingMm, options.dpi)) : 0;
    const automaticBarHeight = Math.max(
        1,
        frameHeightDots - textHeightDots - textPaddingDots,
    );
    const requestedBarHeightDots = typeof options.barHeightMm === "number" &&
        Number.isFinite(options.barHeightMm) && options.barHeightMm > 0
        ? Math.max(1, mmToDots(options.barHeightMm, options.dpi))
        : automaticBarHeight;
    const textAbove = options.textPosition === "above";
    const barsOffsetDots = humanReadable && textAbove
        ? textHeightDots + textPaddingDots
        : 0;
    const textOffsetDots = humanReadable && !textAbove
        ? requestedBarHeightDots + textPaddingDots
        : 0;
    const totalHeightDots = requestedBarHeightDots + textHeightDots + textPaddingDots;
    return {
        frameHeightDots,
        barHeightDots: requestedBarHeightDots,
        barHeightMm: dotsToMm(requestedBarHeightDots, options.dpi),
        textHeightDots,
        textPaddingDots,
        barsOffsetDots,
        textOffsetDots,
        totalHeightDots,
        fitsFrame: totalHeightDots <= frameHeightDots,
    };
}

/**
 * Calculate one integer-dot layout shared by preview, raster and native ZPL.
 * totalModules must include the leading/trailing quiet zones.
 */
export type BarcodeModuleLayoutOptions = {
    containerDots: number;
    totalModules: number;
    quietZoneModules?: number;
    quietZoneLeftModules?: number;
    quietZoneRightModules?: number;
    dpi: number;
    minModuleMm?: number;
    align?: "left" | "center" | "right";
    mode?: BarcodeSizingMode;
    requestedDotsPerModule?: number;
    /** @deprecated Use mode="fixed" with requestedDotsPerModule. */
    manualNarrowDots?: number;
};

export function barcodeModuleLayout(options: BarcodeModuleLayoutOptions): BarcodeModuleLayout {
    const containerDots = Math.max(1, Math.round(options.containerDots));
    const totalModules = Math.max(1, Math.round(options.totalModules));
    const legacyQuietZoneModules = Math.max(
        0,
        Math.round(options.quietZoneModules ?? BARCODE_QUIET_ZONE_MODULES),
    );
    const quietZoneLeftModules = Math.max(
        0,
        Math.round(options.quietZoneLeftModules ?? legacyQuietZoneModules),
    );
    const quietZoneRightModules = Math.max(
        0,
        Math.round(options.quietZoneRightModules ?? legacyQuietZoneModules),
    );
    const minimumXDimensionMm = typeof options.minModuleMm === "number"
        ? Math.max(0.1, Math.min(2, options.minModuleMm))
        : BARCODE_SCAN_SAFE_X_MM;
    const safeNarrowDots = barcodeNarrowDotsForMm(options.dpi, minimumXDimensionMm);
    const maxFittingNarrowDots = Math.max(0, Math.min(10, Math.floor(containerDots / totalModules)));
    const requestedDotsPerModule =
        typeof options.requestedDotsPerModule === "number"
        && Number.isFinite(options.requestedDotsPerModule)
            ? options.requestedDotsPerModule
            : typeof options.manualNarrowDots === "number"
              && Number.isFinite(options.manualNarrowDots)
              ? options.manualNarrowDots
              : undefined;
    const mode: BarcodeSizingMode = options.mode
        ?? (requestedDotsPerModule === undefined ? "auto" : "fixed");
    const narrowDots = mode === "fixed"
        ? Math.max(1, Math.min(10, Math.round(requestedDotsPerModule ?? safeNarrowDots)))
        : Math.max(1, maxFittingNarrowDots);
    const printerDotsPerMm = dotsPerMm(options.dpi);
    const printedWidthDots = totalModules * narrowDots;
    const requiredSafeWidthDots = totalModules * safeNarrowDots;
    const freeDots = Math.max(0, containerDots - printedWidthDots);
    const overflowDots = Math.max(0, printedWidthDots - containerDots);
    const leftInsetDots = options.align === "left"
        ? 0
        : options.align === "right"
          ? freeDots
          : Math.floor(freeDots / 2);
    const fitsFrame = printedWidthDots <= containerDots;
    return {
        mode,
        containerDots,
        totalModules,
        quietZoneLeftModules,
        quietZoneRightModules,
        narrowDots,
        dotsPerModule: narrowDots,
        xDimensionMm: narrowDots / printerDotsPerMm,
        minimumXDimensionMm,
        safeNarrowDots,
        maxFittingNarrowDots,
        printedWidthDots,
        printedWidthMm: printedWidthDots / printerDotsPerMm,
        requiredSafeWidthDots,
        requiredSafeWidthMm: requiredSafeWidthDots / printerDotsPerMm,
        leftInsetDots,
        barOffsetDots: leftInsetDots + quietZoneLeftModules * narrowDots,
        fitsFrame,
        scanSafe: fitsFrame && narrowDots >= safeNarrowDots,
        overflow: overflowDots > 0,
        overflowDots,
        overflowMm: overflowDots / printerDotsPerMm,
    };
}

const C128_PATTERNS: number[][] = [
    [2,1,2,2,2,2],[2,2,2,1,2,2],[2,2,2,2,2,1],[1,2,1,2,2,3],[1,2,1,3,2,2],
    [1,3,1,2,2,2],[1,2,2,2,1,3],[1,2,2,3,1,2],[1,3,2,2,1,2],[2,2,1,2,1,3],
    [2,2,1,3,1,2],[2,3,1,2,1,2],[1,1,2,2,3,2],[1,2,2,1,3,2],[1,2,2,2,3,1],
    [1,1,3,2,2,2],[1,2,3,1,2,2],[1,2,3,2,2,1],[2,2,3,2,1,1],[2,2,1,1,3,2],
    [2,2,1,2,3,1],[2,1,3,2,1,2],[2,2,3,1,1,2],[3,1,2,1,3,1],[3,1,1,2,2,2],
    [3,2,1,1,2,2],[3,2,1,2,2,1],[3,1,2,2,1,2],[3,2,2,1,1,2],[3,2,2,2,1,1],
    [2,1,2,1,2,3],[2,1,2,3,2,1],[2,3,2,1,2,1],[1,1,1,3,2,3],[1,3,1,1,2,3],
    [1,3,1,3,2,1],[1,1,2,3,1,3],[1,3,2,1,1,3],[1,3,2,3,1,1],[2,1,1,3,1,3],
    [2,3,1,1,1,3],[2,3,1,3,1,1],[1,1,2,1,3,3],[1,1,2,3,3,1],[1,3,2,1,3,1],
    [1,1,3,1,2,3],[1,1,3,3,2,1],[1,3,3,1,2,1],[3,1,3,1,2,1],[2,1,1,3,3,1],
    [2,3,1,1,3,1],[2,1,3,1,1,3],[2,1,3,3,1,1],[2,1,3,1,3,1],[3,1,1,1,2,3],
    [3,1,1,3,2,1],[3,3,1,1,2,1],[3,1,2,1,1,3],[3,1,2,3,1,1],[3,3,2,1,1,1],
    [3,1,4,1,1,1],[2,2,1,4,1,1],[4,3,1,1,1,1],[1,1,1,2,2,4],[1,1,1,4,2,2],
    [1,2,1,1,2,4],[1,2,1,4,2,1],[1,4,1,1,2,2],[1,4,1,2,2,1],[1,1,2,2,1,4],
    [1,1,2,4,1,2],[1,2,2,1,1,4],[1,2,2,4,1,1],[1,4,2,1,1,2],[1,4,2,2,1,1],
    [2,4,1,2,1,1],[2,2,1,1,1,4],[4,1,3,1,1,1],[2,4,1,1,1,2],[1,3,4,1,1,1],
    [1,1,1,2,4,2],[1,2,1,1,4,2],[1,2,1,2,4,1],[1,1,4,2,1,2],[1,2,4,1,1,2],
    [1,2,4,2,1,1],[4,1,1,2,1,2],[4,2,1,1,1,2],[4,2,1,2,1,1],[2,1,2,1,4,1],
    [2,1,4,1,2,1],[4,1,2,1,2,1],[1,1,1,1,4,3],[1,1,1,3,4,1],[1,3,1,1,4,1],
    [1,1,4,1,1,3],[1,1,4,3,1,1],[4,1,1,1,1,3],[4,1,1,3,1,1],[1,1,3,1,4,1],
    [1,1,4,1,3,1],[3,1,1,1,4,1],[4,1,1,1,3,1],[2,1,1,4,1,2],[2,1,1,2,1,4],
    [2,1,1,2,3,2],[2,3,3,1,1,1,2],
];
// Last entry above is STOP (107) and has 7 bars (4+3 alternating + final bar).

const C128_START_B = 104;
const C128_START_C = 105;
const C128_CODE_B = 100;
const C128_CODE_C = 99;
const C128_STOP = 106;

export function isSupportedCode128Data(data: string): boolean {
    return data.length > 0 && /^[\x20-\x7E]+$/.test(data);
}

function code128BValue(char: string): number {
    const c = char.charCodeAt(0);
    if (c < 32 || c > 126) {
        throw new RangeError("Code 128 supports printable ASCII characters only.");
    }
    return c - 32;
}

function digitRunLength(data: string, start: number): number {
    let i = start;
    while (i < data.length && data.charCodeAt(i) >= 48 && data.charCodeAt(i) <= 57) {
        i += 1;
    }
    return i - start;
}

function encodeCode128(data: string): number[] | null {
    if (!isSupportedCode128Data(data)) return null;
    const codes: number[] = [];
    const initialDigits = digitRunLength(data, 0);
    let codeSet: "B" | "C" = initialDigits - (initialDigits % 2) >= 4 ? "C" : "B";
    codes.push(codeSet === "C" ? C128_START_C : C128_START_B);

    let i = 0;
    while (i < data.length) {
        if (codeSet === "C") {
            const run = digitRunLength(data, i);
            const evenRun = run - (run % 2);
            if (evenRun >= 2) {
                for (let j = 0; j < evenRun; j += 2) {
                    codes.push(parseInt(data.slice(i + j, i + j + 2), 10));
                }
                i += evenRun;
            }
            if (i < data.length) {
                codes.push(C128_CODE_B);
                codeSet = "B";
            }
            continue;
        }

        const run = digitRunLength(data, i);
        const evenRun = run - (run % 2);
        const runReachesEnd = i + evenRun >= data.length;
        if (evenRun >= (runReachesEnd ? 4 : 6)) {
            codes.push(C128_CODE_C);
            codeSet = "C";
            continue;
        }
        codes.push(code128BValue(data[i]));
        i += 1;
    }

    let sum = codes[0];
    for (let i = 1; i < codes.length; i += 1) sum += codes[i] * i;
    const checksum = sum % 103;
    codes.push(checksum);
    codes.push(C128_STOP);

    const widths: number[] = [];
    for (const code of codes) {
        const pattern = C128_PATTERNS[code];
        if (!pattern) continue;
        for (const w of pattern) widths.push(w);
    }
    return widths;
}

const EAN_L = ["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"];
const EAN_G = ["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"];
const EAN_R = ["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"];
const EAN_PARITY = ["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"];

export function ean13CheckDigit(dataDigits: string): number | null {
    if (!/^\d{12}$/.test(dataDigits)) return null;
    let sum = 0;
    for (let i = 0; i < 12; i += 1) {
        sum += Number(dataDigits[i]) * (i % 2 === 0 ? 1 : 3);
    }
    return (10 - (sum % 10)) % 10;
}

/**
 * Return one canonical 13-digit EAN value. Twelve data digits receive a
 * computed check digit; a supplied thirteenth digit must already be valid.
 */
export function normalizeEan13(data: string): string | null {
    if (!/^\d{12,13}$/.test(data)) return null;
    const dataDigits = data.slice(0, 12);
    const checkDigit = ean13CheckDigit(dataDigits);
    if (checkDigit === null) return null;
    if (data.length === 13 && Number(data[12]) !== checkDigit) return null;
    return `${dataDigits}${checkDigit}`;
}

function encodeEan13(data: string): { widths: number[]; render: string } | null {
    const d = normalizeEan13(data);
    if (!d) return null;
    const first = parseInt(d[0], 10);
    const parity = EAN_PARITY[first];
    let bits = "101";
    for (let i = 0; i < 6; i += 1) {
        const digit = parseInt(d[1 + i], 10);
        const set = parity[i] === "L" ? EAN_L : EAN_G;
        bits += set[digit];
    }
    bits += "01010";
    for (let i = 0; i < 6; i += 1) {
        const digit = parseInt(d[7 + i], 10);
        bits += EAN_R[digit];
    }
    bits += "101";

    const widths: number[] = [];
    let current = bits[0];
    let count = 0;
    for (const b of bits) {
        if (b === current) {
            count += 1;
        } else {
            widths.push(count);
            current = b;
            count = 1;
        }
    }
    widths.push(count);
    return { widths, render: d };
}

export type BarcodeRender = {
    widths: number[];
    symbolModules: number;
    totalModules: number;
    quietZoneLeftModules: number;
    quietZoneRightModules: number;
    /**
     * Backward-compatible alias for the leading quiet zone. Historically both
     * sides were assumed equal; use the explicit left/right fields in new code.
     */
    quietZoneModules: number;
    render: string;
};

export function renderBarcode(
    data: string,
    symbology: "CODE128" | "EAN13",
): BarcodeRender | null {
    if (symbology === "EAN13") {
        const ean = encodeEan13(data);
        if (!ean) return null;
        const symbolModules = ean.widths.reduce((a, b) => a + b, 0);
        return {
            widths: ean.widths,
            symbolModules,
            totalModules:
                symbolModules
                + EAN13_QUIET_ZONE_LEFT_MODULES
                + EAN13_QUIET_ZONE_RIGHT_MODULES,
            quietZoneLeftModules: EAN13_QUIET_ZONE_LEFT_MODULES,
            quietZoneRightModules: EAN13_QUIET_ZONE_RIGHT_MODULES,
            quietZoneModules: EAN13_QUIET_ZONE_LEFT_MODULES,
            render: ean.render,
        };
    }
    const widths = encodeCode128(data);
    if (!widths?.length) return null;
    const symbolModules = widths.reduce((a, b) => a + b, 0);
    return {
        widths,
        symbolModules,
        totalModules:
            symbolModules
            + CODE128_QUIET_ZONE_LEFT_MODULES
            + CODE128_QUIET_ZONE_RIGHT_MODULES,
        quietZoneLeftModules: CODE128_QUIET_ZONE_LEFT_MODULES,
        quietZoneRightModules: CODE128_QUIET_ZONE_RIGHT_MODULES,
        quietZoneModules: CODE128_QUIET_ZONE_LEFT_MODULES,
        render: data,
    };
}
