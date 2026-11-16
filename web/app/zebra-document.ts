import type {
    FontSource,
    LabelDoc,
    LabelElement,
    Rotation,
    RfidSettings,
    TableCellStyle,
} from "./types";
import { scanSafeBarcodeNarrowDots } from "./barcode";
import { normalizeRfidReadLastChars } from "./rfid-text";
import { normalizeLineStroke } from "./line-geometry";
import { textMarginMm } from "./text-margin";

type UnknownRecord = Record<string, unknown>;

const FONT_SOURCES = new Set<FontSource>([
    "zpl",
    "system",
    "google",
    "custom",
]);

const DATA_MATRIX_SQUARE_SIZES = new Set([
    10, 12, 14, 16, 18, 20, 22, 24, 26, 32, 36, 40,
    44, 48, 52, 64, 72, 80, 88, 96, 104, 120, 132, 144,
]);
const DATA_MATRIX_RECTANGULAR_SIZES = new Set([
    "8x18", "8x32", "12x26", "12x36", "16x36", "16x48",
]);

function isRecord(value: unknown): value is UnknownRecord {
    return typeof value === "object" && value !== null;
}

function normalizeFontSource(value: unknown): FontSource | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    return typeof value === "string" && FONT_SOURCES.has(value as FontSource)
        ? (value as FontSource)
        : "zpl";
}

function normalizeCellStyle(style: TableCellStyle | undefined): TableCellStyle | undefined {
    if (!style) return undefined;
    const fontSource = normalizeFontSource((style as UnknownRecord).fontSource);
    return fontSource === undefined
        ? { ...style, fontSource: undefined }
        : { ...style, fontSource };
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const numeric = finiteNumber(value) ?? fallback;
    return Math.max(min, Math.min(max, numeric));
}

function normalizeRotation(value: unknown): Rotation {
    return value === 90 || value === 180 || value === 270 ? value : 0;
}

function normalizeElement(element: LabelElement, dpi: number): LabelElement {
    element = { ...element, rotation: normalizeRotation(element.rotation) };
    if (element.kind === "text") {
        const fontSource = normalizeFontSource((element as unknown as UnknownRecord).fontSource);
        return {
            ...element,
            fontSource,
            marginMm: textMarginMm(element.marginMm),
            ...(element.rfidReadLastChars !== undefined
                ? { rfidReadLastChars: normalizeRfidReadLastChars(element.rfidReadLastChars) }
                : {}),
        };
    }
    if (element.kind === "table") {
        const fontSource = normalizeFontSource((element as unknown as UnknownRecord).fontSource);
        return {
            ...element,
            fontSource,
            cellStyles: element.cellStyles?.map(normalizeCellStyle),
        };
    }
    if (element.kind === "qr") {
        const requestedMagnification = finiteNumber(element.magnification);
        const sizeMode = element.sizeMode === "manual" || element.sizeMode === "auto"
            ? element.sizeMode
            : requestedMagnification && requestedMagnification > 0
              ? "manual"
              : "auto";
        const ecc = element.ecc === "L" || element.ecc === "M" ||
            element.ecc === "Q" || element.ecc === "H"
            ? element.ecc
            : "M";
        return {
            ...element,
            rotation: normalizeRotation(element.rotation),
            ecc,
            sizeMode,
            magnification: sizeMode === "manual"
                ? Math.round(clampNumber(requestedMagnification, 4, 1, 10))
                : undefined,
            quietZoneModules: Math.round(
                clampNumber(element.quietZoneModules, 4, 4, 16),
            ),
            minModuleMm: clampNumber(element.minModuleMm, 0.33, 0.1, 2),
            version: Math.round(clampNumber(element.version, 0, 0, 40)),
            align: element.align === "left" || element.align === "right"
                ? element.align
                : "center",
            verticalAlign: element.verticalAlign === "top" || element.verticalAlign === "bottom"
                ? element.verticalAlign
                : "center",
        };
    }
    if (element.kind === "datamatrix") {
        const requestedMagnification = finiteNumber(element.magnification);
        const sizeMode = element.sizeMode === "manual" || element.sizeMode === "auto"
            ? element.sizeMode
            : requestedMagnification && requestedMagnification > 0
              ? "manual"
              : "auto";
        const contentFormat = element.contentFormat === "gs1" ||
            element.contentFormat === "gs1_digital_link"
            ? element.contentFormat
            : "standard";
        const shape = element.shape === "rectangle" ? "rectangle" : "square";
        const requestedRows = finiteNumber(element.symbolRows);
        const requestedColumns = finiteNumber(element.symbolColumns);
        const symbolRows = requestedRows === undefined ? undefined : Math.round(requestedRows);
        const symbolColumns = requestedColumns === undefined
            ? undefined
            : Math.round(requestedColumns);
        const validFixedSize = symbolRows !== undefined && symbolColumns !== undefined && (
            shape === "square"
                ? symbolRows === symbolColumns && DATA_MATRIX_SQUARE_SIZES.has(symbolRows)
                : DATA_MATRIX_RECTANGULAR_SIZES.has(`${symbolRows}x${symbolColumns}`)
        );
        return {
            ...element,
            rotation: normalizeRotation(element.rotation),
            contentFormat,
            shape,
            symbolRows: validFixedSize ? symbolRows : undefined,
            symbolColumns: validFixedSize ? symbolColumns : undefined,
            textEncoding: contentFormat === "standard" && element.textEncoding === "latin1"
                ? "latin1"
                : "utf8",
            sizeMode,
            magnification: sizeMode === "manual"
                ? Math.round(clampNumber(requestedMagnification, 3, 1, 40))
                : undefined,
            quietZoneModules: Math.round(
                clampNumber(element.quietZoneModules, 1, 1, 16),
            ),
            minModuleMm: clampNumber(element.minModuleMm, 0.25, 0.1, 2),
            align: element.align === "left" || element.align === "right"
                ? element.align
                : "center",
            verticalAlign: element.verticalAlign === "top" || element.verticalAlign === "bottom"
                ? element.verticalAlign
                : "center",
        };
    }
    if (element.kind === "barcode") {
        const isEan13 = element.symbology === "EAN13";
        const legacyTextSize = finiteNumber(element.textSize);
        const legacyTextPadding = finiteNumber(element.textPadding);
        // The old editor labelled these values as px (minimum 6 for size),
        // while the bitmap renderer interpreted them as mm. Preserve the
        // authored mm fixtures (typically 1.5–3), but migrate UI-originated
        // pixel values to their 8 px/mm design-canvas equivalent.
        const migratedLegacyTextSize = legacyTextSize === undefined
            ? 2
            : legacyTextSize >= 6
              ? legacyTextSize / 8
              : legacyTextSize;
        const migratedLegacyTextPadding = legacyTextPadding === undefined
            ? 0.3
            : legacyTextPadding >= 1
              ? legacyTextPadding / 8
              : legacyTextPadding;
        const sizeMode = element.sizeMode === "manual" || element.sizeMode === "auto"
            ? element.sizeMode
            : finiteNumber(element.narrowDots) !== undefined ||
                finiteNumber(element.wideDots) !== undefined
              ? "manual"
              : "auto";
        const rotation = normalizeRotation(element.rotation);
        const requestedBarHeightMm = finiteNumber(element.barHeightMm);
        // ^BC/^BE bar height is measured along the symbol's logical vertical
        // axis. A quarter-turn therefore uses the authored frame width as the
        // available height, matching preview, preflight and emitted ZPL.
        const logicalFrameHeightMm = Math.max(
            0.5,
            Math.min(
                1000,
                finiteNumber(rotation === 90 || rotation === 270
                    ? element.size.w
                    : element.size.h) ?? 0.5,
            ),
        );
        return {
            ...element,
            rotation,
            sizeMode,
            widthMode: undefined,
            narrowDots: sizeMode !== "manual"
                ? undefined
                : Math.round(clampNumber(
                      element.narrowDots,
                      scanSafeBarcodeNarrowDots(dpi),
                      1,
                      10,
                  )),
            minModuleMm: clampNumber(element.minModuleMm, 0.25, 0.1, 2),
            align: element.align === "left" || element.align === "right"
                ? element.align
                : "center",
            barHeightMm: requestedBarHeightMm === undefined
                ? undefined
                : clampNumber(
                      requestedBarHeightMm,
                      logicalFrameHeightMm,
                      0.5,
                      logicalFrameHeightMm,
                  ),
            textSizeMm: clampNumber(
                isEan13 ? 2 : element.textSizeMm,
                isEan13 ? 2 : migratedLegacyTextSize,
                0.5,
                10,
            ),
            textPaddingMm: clampNumber(
                isEan13 ? 0.3 : element.textPaddingMm,
                isEan13 ? 0.3 : migratedLegacyTextPadding,
                0,
                5,
            ),
            textPosition: element.textPosition === "above" ? "above" : "below",
            textAlign: !isEan13 && (element.textAlign === "left" || element.textAlign === "right")
                ? element.textAlign
                : "center",
            wideDots: undefined,
            textSize: undefined,
            textPadding: undefined,
        };
    }
    return element;
}

function normalizeRfidSettings(rfid: RfidSettings): RfidSettings {
    const source = rfid as unknown as UnknownRecord;
    return Object.fromEntries(
        Object.entries(source).filter(([key]) => key !== "variant"),
    ) as unknown as RfidSettings;
}

/**
 * Converts imported or persisted label data into the Zebra-only document
 * schema while preserving physical geometry and printer-font metrics.
 */
export function normalizeZebraDocument(doc: LabelDoc): LabelDoc {
    const settings = Object.fromEntries(
        Object.entries(doc.settings as unknown as UnknownRecord)
            .filter(([key]) => key !== "tearOffMm"),
    ) as unknown as LabelDoc["settings"];
    return {
        ...doc,
        symbolConfigVersion: 2,
        settings: {
            ...settings,
            contentRotation: normalizeRotation(settings.contentRotation),
            rfid: normalizeRfidSettings(doc.settings.rfid),
        },
        elements: doc.elements.map((element) => normalizeElement(
            element.kind === "line" ? normalizeLineStroke(element, settings.contentRotation) : element,
            settings.dpi,
        )),
    };
}

/** Shallow structural guard plus Zebra schema normalization for JSON inputs. */
export function parseZebraDocument(value: unknown): LabelDoc | null {
    if (!isRecord(value)) return null;
    if (typeof value.id !== "string" || typeof value.name !== "string") return null;
    if (!Array.isArray(value.elements) || !isRecord(value.settings)) return null;
    if (!isRecord(value.settings.rfid)) return null;
    return normalizeZebraDocument(value as unknown as LabelDoc);
}
