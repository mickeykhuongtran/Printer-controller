import bwipjs from "bwip-js/browser";

import type { ECC } from "./types";
import { dotsToMm } from "./units";

export const ZEBRA_NATIVE_QR_MAX_MAGNIFICATION = 10;
export const QR_MIN_QUIET_ZONE_MODULES = 4;
export const DEFAULT_QR_MIN_MODULE_MM = 0.33;
export const DEFAULT_QR_SIZING_DPI = 203;

export type QrSizingOptions = {
    /** Clear modules reserved outside every edge of the Model 2 matrix. */
    quietZoneModules?: number;
    /** Missing/zero means Auto; a positive value is rounded to whole dots/module. */
    requestedMagnification?: number;
    /** Pass actual DPI for physical diagnostics; omitted uses the 203-dpi compatibility default. */
    dpi?: number;
    /** Application scan-safety threshold, independent of QR capacity/ECC. */
    minModuleMm?: number;
    /** Position the complete symbol, including its quiet zone, inside the frame. */
    align?: "left" | "center" | "right";
    verticalAlign?: "top" | "center" | "bottom";
};

export type QrMatrix = {
    columns: number;
    rows: number;
    /** Row-major modules. A truthy value is a black module. */
    pixels: readonly number[];
};

export type QrFrameLayout = {
    frameWidthDots: number;
    frameHeightDots: number;
    frameSideDots: number;
    auto: boolean;
    desiredModuleDots: number;
    moduleCount: number;
    outerModuleCount: number;
    quietZoneModules: number;
    moduleDots: number;
    dpi: number;
    moduleSizeMm: number;
    minModuleMm: number;
    align: "left" | "center" | "right";
    verticalAlign: "top" | "center" | "bottom";
    quietZoneDots: number;
    dataSideDots: number;
    outerSideDots: number;
    dataOffsetXDots: number;
    dataOffsetYDots: number;
    outerOffsetXDots: number;
    outerOffsetYDots: number;
    /** Backward-compatible alias for dataSideDots (the pixels passed to QRCodeSVG). */
    renderedSideDots: number;
    /** Backward-compatible aliases for the data-matrix origin inside the frame. */
    offsetXDots: number;
    offsetYDots: number;
    fitsFrame: boolean;
    scanSafe: boolean;
};

export type NativeQrSizing = {
    auto: boolean;
    desiredMagnification: number;
    magnification: number;
    moduleCount: number;
    outerModuleCount: number;
    quietZoneModules: number;
    quietZoneDots: number;
    dpi: number;
    moduleSizeMm: number;
    minModuleMm: number;
    align: "left" | "center" | "right";
    verticalAlign: "top" | "center" | "bottom";
    dataSideDots: number;
    outerSideDots: number;
    dataOffsetXDots: number;
    dataOffsetYDots: number;
    outerOffsetXDots: number;
    outerOffsetYDots: number;
    /** Backward-compatible alias for dataSideDots, used to center the ^BQ matrix. */
    renderedSideDots: number;
    fitsFrame: boolean;
    scanSafe: boolean;
    limitedByNativeMax: boolean;
    frameTooSmall: boolean;
    requestedVersionUnsupported: boolean;
};

const MODULE_COUNT_CACHE_LIMIT = 256;
const moduleCountCache = new Map<string, number>();
const MATRIX_CACHE_LIMIT = 128;
const matrixCache = new Map<string, QrMatrix>();

function positiveRounded(value: number, fallback = 1): number {
    return typeof value === "number" && Number.isFinite(value)
        ? Math.max(1, Math.round(value))
        : fallback;
}

function normalizeModel2Modules(moduleCount: number): number {
    const approximateVersion = Math.round((positiveRounded(moduleCount, 21) - 17) / 4);
    const version = Math.max(1, Math.min(40, approximateVersion));
    return version * 4 + 17;
}

function normalizeQuietZoneModules(quietZoneModules: number | undefined): number {
    if (typeof quietZoneModules !== "number" || !Number.isFinite(quietZoneModules)) {
        return QR_MIN_QUIET_ZONE_MODULES;
    }
    return Math.max(QR_MIN_QUIET_ZONE_MODULES, Math.ceil(quietZoneModules));
}

function normalizeDpi(dpi: number | undefined): number {
    return typeof dpi === "number" && Number.isFinite(dpi) && dpi > 0
        ? dpi
        : DEFAULT_QR_SIZING_DPI;
}

function normalizeMinModuleMm(minModuleMm: number | undefined): number {
    return typeof minModuleMm === "number" && Number.isFinite(minModuleMm) && minModuleMm > 0
        ? minModuleMm
        : DEFAULT_QR_MIN_MODULE_MM;
}

function requestedModuleDots(value: number | undefined): number | undefined {
    return typeof value === "number" && Number.isFinite(value) && value > 0
        ? Math.max(1, Math.round(value))
        : undefined;
}

function horizontalAlign(value: QrSizingOptions["align"]): "left" | "center" | "right" {
    return value === "left" || value === "right" ? value : "center";
}

function verticalAlign(
    value: QrSizingOptions["verticalAlign"],
): "top" | "center" | "bottom" {
    return value === "top" || value === "bottom" ? value : "center";
}

function alignedOffset(
    remaining: number,
    alignment: "start" | "center" | "end",
): number {
    if (alignment === "start") return 0;
    if (alignment === "end") return remaining;
    return Math.floor(remaining / 2);
}

// QR Model 2 data codewords for versions 1..40. These are the exact
// capacities obtained from the Reed-Solomon block structure used by Nayuki's
// qrcodegen encoder (the encoder bundled by qrcode.react). Index 0 is a
// sentinel so the array index is also the QR version.
const DATA_CODEWORDS_BY_ECC: Record<ECC, readonly number[]> = {
    L: [
        -1, 19, 34, 55, 80, 108, 136, 156, 194, 232, 274,
        324, 370, 428, 461, 523, 589, 647, 721, 795, 861,
        932, 1006, 1094, 1174, 1276, 1370, 1468, 1531, 1631, 1735,
        1843, 1955, 2071, 2191, 2306, 2434, 2566, 2702, 2812, 2956,
    ],
    M: [
        -1, 16, 28, 44, 64, 86, 108, 124, 154, 182, 216,
        254, 290, 334, 365, 415, 453, 507, 563, 627, 669,
        714, 782, 860, 914, 1000, 1062, 1128, 1193, 1267, 1373,
        1455, 1541, 1631, 1725, 1812, 1914, 1992, 2102, 2216, 2334,
    ],
    Q: [
        -1, 13, 22, 34, 48, 62, 76, 88, 110, 132, 154,
        180, 206, 244, 261, 295, 325, 367, 397, 445, 485,
        512, 568, 614, 664, 718, 754, 808, 871, 911, 985,
        1033, 1115, 1171, 1231, 1286, 1354, 1426, 1502, 1582, 1666,
    ],
    H: [
        -1, 9, 16, 26, 36, 46, 60, 66, 86, 100, 122,
        140, 158, 180, 197, 223, 253, 283, 313, 341, 385,
        406, 442, 464, 514, 538, 596, 628, 661, 701, 745,
        793, 845, 901, 961, 986, 1054, 1096, 1142, 1222, 1276,
    ],
};

const NUMERIC_RE = /^[0-9]*$/;
const ALPHANUMERIC_RE = /^[A-Z0-9 $%*+.\/:-]*$/;

type SegmentMetrics = {
    numChars: number;
    dataBits: number;
    charCountBits: readonly [number, number, number];
};

/** Match qrcodegen's encodeURI-based UTF-8 conversion without allocating bytes. */
function utf8ByteLength(value: string): number {
    const encoded = encodeURI(value);
    let bytes = 0;
    for (let index = 0; index < encoded.length; index += 1) {
        bytes += 1;
        if (encoded[index] === "%") index += 2;
    }
    return bytes;
}

/** Match QrSegment.makeSegments(): one numeric, alphanumeric, or UTF-8 byte segment. */
function segmentMetrics(value: string): SegmentMetrics {
    if (NUMERIC_RE.test(value)) {
        const remainder = value.length % 3;
        return {
            numChars: value.length,
            dataBits: Math.floor(value.length / 3) * 10 + (remainder === 0 ? 0 : remainder * 3 + 1),
            charCountBits: [10, 12, 14],
        };
    }
    if (ALPHANUMERIC_RE.test(value)) {
        return {
            numChars: value.length,
            dataBits: Math.floor(value.length / 2) * 11 + (value.length % 2) * 6,
            charCountBits: [9, 11, 13],
        };
    }
    const byteLength = utf8ByteLength(value);
    return {
        numChars: byteLength,
        dataBits: byteLength * 8,
        charCountBits: [8, 16, 16],
    };
}

function segmentBitLength(segment: SegmentMetrics, version: number): number {
    const versionRange = version <= 9 ? 0 : version <= 26 ? 1 : 2;
    const countBits = segment.charCountBits[versionRange];
    if (segment.numChars >= 2 ** countBits) return Number.POSITIVE_INFINITY;
    return 4 + countBits + segment.dataBits;
}

export function qrMinVersion(version: number | undefined): number | undefined {
    if (typeof version !== "number" || !Number.isFinite(version) || version <= 0) {
        return undefined;
    }
    return Math.max(1, Math.min(40, Math.round(version)));
}

/**
 * Return the actual matrix width selected by the same encoder used by the
 * browser bitmap path. `boostLevel=false` keeps the requested ECC authoritative
 * instead of silently upgrading it when spare capacity is available.
 */
export function qrModuleCount(
    data: string,
    ecc: ECC,
    minVersion?: number,
): number {
    const safeData = data || "QR";
    const normalizedMinVersion = qrMinVersion(minVersion);
    const key = `${ecc}\u0000${normalizedMinVersion ?? 0}\u0000${safeData}`;
    const cached = moduleCountCache.get(key);
    if (cached !== undefined) return cached;

    const capacities = DATA_CODEWORDS_BY_ECC[ecc];
    if (!capacities) throw new RangeError(`Unsupported QR error correction level: ${ecc}`);
    const segment = segmentMetrics(safeData);
    let version = normalizedMinVersion ?? 1;
    while (
        version <= 40 &&
        segmentBitLength(segment, version) > capacities[version] * 8
    ) {
        version += 1;
    }
    if (version > 40) throw new RangeError("QR data is too long");
    const modules = version * 4 + 17;

    if (moduleCountCache.size >= MODULE_COUNT_CACHE_LIMIT) {
        const oldest = moduleCountCache.keys().next().value as string | undefined;
        if (oldest !== undefined) moduleCountCache.delete(oldest);
    }
    moduleCountCache.set(key, modules);
    return modules;
}

function friendlyQrEncoderError(error: unknown): Error {
    const raw = error instanceof Error ? error.message : String(error);
    const message = raw
        .replace(/^Error:\s*/i, "")
        .replace(/^bwipp\.[^:]+:\s*/i, "")
        .replace(/^bwip-js:\s*/i, "")
        .trim();
    return new Error(message || "QR data cannot be encoded.");
}

/**
 * Encode the exact QR Model 2 module grid used by bitmap preview/output.
 *
 * `minVersion` retains the template meaning used by qrcode.react: it is a
 * lower bound, not a request to truncate a payload into that version. We
 * resolve the required version first, then ask bwip-js for that exact matrix
 * and ECC level so downstream GFA output and the designer consume identical bits.
 */
export function encodeQrMatrix(
    data: string,
    ecc: ECC,
    minVersion?: number,
): QrMatrix {
    if (!data) throw new RangeError("QR data must not be empty.");
    if (ecc !== "L" && ecc !== "M" && ecc !== "Q" && ecc !== "H") {
        throw new RangeError(`Unsupported QR error correction level: ${ecc}`);
    }
    const normalizedMinVersion = qrMinVersion(minVersion);
    const version = (qrModuleCount(data, ecc, normalizedMinVersion) - 17) / 4;
    const key = `${ecc}\u0000${version}\u0000${data}`;
    const cached = matrixCache.get(key);
    if (cached) return cached;

    try {
        const raw = bwipjs.raw(
            "qrcode",
            data,
            `eclevel=${ecc} version=${version}`,
        );
        const matrix = raw.find(
            (entry): entry is {
                pixs: number[];
                pixx: number;
                pixy: number;
                height: number;
                width: number;
            } => "pixs" in entry && "pixx" in entry && "pixy" in entry,
        );
        const expectedModules = version * 4 + 17;
        if (
            !matrix ||
            matrix.pixx !== expectedModules ||
            matrix.pixy !== expectedModules ||
            matrix.pixs.length !== expectedModules * expectedModules
        ) {
            throw new Error("Encoder returned an invalid QR module grid.");
        }
        const result: QrMatrix = {
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
        throw friendlyQrEncoderError(error);
    }
}

/**
 * Fit a Model 2 QR and its external quiet zone to a physical frame.
 *
 * `renderedSideDots` and `offset*Dots` intentionally continue to describe the
 * data matrix so existing qrcode.react callers can render with marginSize=0.
 * The offset already includes the reserved quiet zone; the new outer fields
 * expose the complete scan area for diagnostics and preflight.
 */
export function fitQrToFrameDots(
    frameWidthDots: number,
    frameHeightDots: number,
    moduleCount: number,
    options: QrSizingOptions = {},
): QrFrameLayout {
    const safeWidth = positiveRounded(frameWidthDots);
    const safeHeight = positiveRounded(frameHeightDots);
    const safeModules = normalizeModel2Modules(moduleCount);
    const quietZoneModules = normalizeQuietZoneModules(options.quietZoneModules);
    const outerModuleCount = safeModules + quietZoneModules * 2;
    const frameSideDots = Math.min(safeWidth, safeHeight);
    const manualModuleDots = requestedModuleDots(options.requestedMagnification);
    const auto = manualModuleDots === undefined;
    const desiredModuleDots = manualModuleDots ?? Math.max(
        1,
        Math.floor(frameSideDots / outerModuleCount),
    );
    const moduleDots = desiredModuleDots;
    const quietZoneDots = quietZoneModules * moduleDots;
    const dataSideDots = safeModules * moduleDots;
    const outerSideDots = outerModuleCount * moduleDots;
    const align = horizontalAlign(options.align);
    const vertical = verticalAlign(options.verticalAlign);
    const outerOffsetXDots = alignedOffset(
        safeWidth - outerSideDots,
        align === "left" ? "start" : align === "right" ? "end" : "center",
    );
    const outerOffsetYDots = alignedOffset(
        safeHeight - outerSideDots,
        vertical === "top" ? "start" : vertical === "bottom" ? "end" : "center",
    );
    const dataOffsetXDots = outerOffsetXDots + quietZoneDots;
    const dataOffsetYDots = outerOffsetYDots + quietZoneDots;
    const dpi = normalizeDpi(options.dpi);
    const moduleSizeMm = dotsToMm(moduleDots, dpi);
    const minModuleMm = normalizeMinModuleMm(options.minModuleMm);
    const fitsFrame = outerSideDots <= safeWidth && outerSideDots <= safeHeight;
    return {
        frameWidthDots: safeWidth,
        frameHeightDots: safeHeight,
        frameSideDots,
        auto,
        desiredModuleDots,
        moduleCount: safeModules,
        outerModuleCount,
        quietZoneModules,
        moduleDots,
        dpi,
        moduleSizeMm,
        minModuleMm,
        align,
        verticalAlign: vertical,
        quietZoneDots,
        dataSideDots,
        outerSideDots,
        dataOffsetXDots,
        dataOffsetYDots,
        outerOffsetXDots,
        outerOffsetYDots,
        renderedSideDots: dataSideDots,
        offsetXDots: dataOffsetXDots,
        offsetYDots: dataOffsetYDots,
        fitsFrame,
        scanSafe: fitsFrame && moduleSizeMm >= minModuleMm,
    };
}

/**
 * Resolve Zebra native `^BQN` sizing. A missing/zero magnification means Auto.
 * Unlike the GFA path, Zebra native QR magnification is limited to 1..10.
 */
export function nativeQrSizing(options: {
    frameWidthDots: number;
    frameHeightDots: number;
    moduleCount: number;
    requestedMagnification?: number;
    requestedVersion?: number;
    quietZoneModules?: number;
    dpi?: number;
    minModuleMm?: number;
    align?: QrSizingOptions["align"];
    verticalAlign?: QrSizingOptions["verticalAlign"];
}): NativeQrSizing {
    const frameWidthDots = positiveRounded(options.frameWidthDots);
    const frameHeightDots = positiveRounded(options.frameHeightDots);
    const frameSideDots = Math.min(frameWidthDots, frameHeightDots);
    const moduleCount = normalizeModel2Modules(options.moduleCount);
    const quietZoneModules = normalizeQuietZoneModules(options.quietZoneModules);
    const outerModuleCount = moduleCount + quietZoneModules * 2;
    const manualMagnification = requestedModuleDots(options.requestedMagnification);
    const auto = manualMagnification === undefined;
    const desiredMagnification = manualMagnification ?? Math.max(
        1,
        Math.floor(frameSideDots / outerModuleCount),
    );
    const magnification = Math.min(
        ZEBRA_NATIVE_QR_MAX_MAGNIFICATION,
        desiredMagnification,
    );
    const quietZoneDots = quietZoneModules * magnification;
    const dataSideDots = moduleCount * magnification;
    const outerSideDots = outerModuleCount * magnification;
    const dpi = normalizeDpi(options.dpi);
    const moduleSizeMm = dotsToMm(magnification, dpi);
    const minModuleMm = normalizeMinModuleMm(options.minModuleMm);
    const fitsFrame = outerSideDots <= frameWidthDots && outerSideDots <= frameHeightDots;
    const align = horizontalAlign(options.align);
    const vertical = verticalAlign(options.verticalAlign);
    const outerOffsetXDots = alignedOffset(
        frameWidthDots - outerSideDots,
        align === "left" ? "start" : align === "right" ? "end" : "center",
    );
    const outerOffsetYDots = alignedOffset(
        frameHeightDots - outerSideDots,
        vertical === "top" ? "start" : vertical === "bottom" ? "end" : "center",
    );
    const dataOffsetXDots = outerOffsetXDots + quietZoneDots;
    const dataOffsetYDots = outerOffsetYDots + quietZoneDots;
    return {
        auto,
        desiredMagnification,
        magnification,
        moduleCount,
        outerModuleCount,
        quietZoneModules,
        quietZoneDots,
        dpi,
        moduleSizeMm,
        minModuleMm,
        align,
        verticalAlign: vertical,
        dataSideDots,
        outerSideDots,
        dataOffsetXDots,
        dataOffsetYDots,
        outerOffsetXDots,
        outerOffsetYDots,
        renderedSideDots: dataSideDots,
        fitsFrame,
        scanSafe: fitsFrame && moduleSizeMm >= minModuleMm,
        limitedByNativeMax:
            desiredMagnification > ZEBRA_NATIVE_QR_MAX_MAGNIFICATION,
        frameTooSmall: frameSideDots < outerModuleCount,
        requestedVersionUnsupported: qrMinVersion(options.requestedVersion) !== undefined,
    };
}
