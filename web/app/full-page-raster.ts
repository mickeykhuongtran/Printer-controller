// Full-page rasterizer. Draws every element of a label onto one offscreen
// canvas at the selected printer DPI, then packs the canvas to a single
// 1-bit MSB-first bitmap for Zebra ZPL graphic output.
//
// This is the "Print as full bitmap" path. It provides pixel-consistent
// output for layouts that depend on browser fonts or complex composition.
// The trade-off is payload size: a 60×40 mm label at 203 DPI is roughly
// 480×320 dots, or 19 KB before ZPL encoding.

import type {
    BarcodeEl,
    DataMatrixEl,
    ImageEl,
    LabelDoc,
    LabelElement,
    LineEl,
    QrEl,
    RectEl,
    RfidSettings,
    TableEl,
    TextEl,
} from "./types";
import { mmToDots } from "./units";
import { logicalSize, rotationFrame } from "./rotation";
import { insetTextElement } from "./text-margin";
import { lineStrokeBoundsDots } from "./line-geometry";
import { decodeImage, drawContainedImage } from "./image-layout";
import { fontStackFor } from "./fonts";
import {
    barcodeHeightLayout,
    barcodeModuleLayout,
    renderBarcode,
    scanSafeBarcodeNarrowDots,
} from "./barcode";
import type { RasterBitmap } from "./bitmap";
import { formatSerial, resolveDynamicValue, resolveTextValue, variablesForCopy } from "./label-data";
import {
    encodeQrMatrix,
    fitQrToFrameDots,
    qrMinVersion,
} from "./qr-sizing";
import {
    encodeDataMatrix,
    fitDataMatrixToFrameDots,
    type DataMatrixMatrix,
} from "./datamatrix";
import {
    addLetterSpacingToWidth,
    getTextFitMode,
    getTextWrapMode,
    layoutTextInFrame,
    textUsesFrame,
} from "./text-flow";

const DEFAULT_DPI = 203;
const TEXT_FONT_DOTS: Record<TextEl["font"], { h: number; w: number }> = {
    A: { h: 9, w: 5 },
    B: { h: 12, w: 7 },
    D: { h: 18, w: 10 },
    E: { h: 28, w: 15 },
};

type RenderLabelOptions = {
    skipNativeQr?: boolean;
    skipRfidReadDynamicElements?: boolean;
    skipResolvedRfidReadDynamicElements?: boolean;
};

export type PreviewCanvasOptions = {
    /** Maximum number of RGBA backing pixels allocated for this preview. */
    maxBackingPixels?: number;
    /** Optional display-driven bounds. The native printer-dot aspect is kept. */
    maxBackingWidthPx?: number;
    maxBackingHeightPx?: number;
};

export type PreviewBackingSize = {
    widthPx: number;
    heightPx: number;
    scale: number;
};

function positivePixelLimit(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value)) return Number.POSITIVE_INFINITY;
    return Math.max(1, Math.floor(value));
}

/**
 * Bounds a preview bitmap without changing its physical aspect ratio. Native
 * dimensions remain the default; limits are used only by thumbnail callers.
 */
export function previewBackingSize(
    nativeWidthDots: number,
    nativeHeightDots: number,
    options: PreviewCanvasOptions = {},
): PreviewBackingSize {
    const nativeWidth = Math.max(1, Math.floor(nativeWidthDots));
    const nativeHeight = Math.max(1, Math.floor(nativeHeightDots));
    const maxWidth = positivePixelLimit(options.maxBackingWidthPx);
    const maxHeight = positivePixelLimit(options.maxBackingHeightPx);
    const maxPixels = positivePixelLimit(options.maxBackingPixels);
    const areaScale = Number.isFinite(maxPixels)
        ? Math.sqrt(maxPixels / (nativeWidth * nativeHeight))
        : 1;
    const scale = Math.min(
        1,
        maxWidth / nativeWidth,
        maxHeight / nativeHeight,
        areaScale,
    );

    return {
        widthPx: Math.max(1, Math.floor(nativeWidth * scale)),
        heightPx: Math.max(1, Math.floor(nativeHeight * scale)),
        scale,
    };
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rfidReadFieldName(doc: LabelDoc): string | null {
    if (!doc.settings.rfid.readEnabled) return null;
    const fieldName = (doc.settings.rfid.readFieldName ?? "rfid_read")
        .trim()
        .replace(/^\{|\}$/g, "");
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName) ? fieldName : null;
}

function elementUsesRfidReadField(doc: LabelDoc, el: LabelElement): boolean {
    const fieldName = rfidReadFieldName(doc);
    if (!fieldName) return false;
    const elementFieldName = "fieldName" in el ? el.fieldName : undefined;
    if ((elementFieldName ?? "").trim().toLowerCase() === fieldName.toLowerCase()) return true;
    const placeholder = new RegExp(`\\{\\s*${escapeRegex(fieldName)}\\s*\\}`, "i");
    if (el.kind === "text") return placeholder.test(el.text);
    if (el.kind === "qr" || el.kind === "barcode" || el.kind === "datamatrix") {
        return placeholder.test(el.data);
    }
    return false;
}

function varsHaveRfidReadValue(
    vars: Record<string, string> | undefined,
    fieldName: string,
): boolean {
    if (!vars) return false;
    const wanted = fieldName.toLowerCase();
    for (const [key, value] of Object.entries(vars)) {
        if (key.toLowerCase() === wanted && String(value).trim() !== "") return true;
    }
    return false;
}

function textWidth(
    ctx: CanvasRenderingContext2D,
    value: string,
    letterSpacingPx = 0,
): number {
    return addLetterSpacingToWidth(ctx.measureText(value || " ").width, value, letterSpacingPx);
}

function fillTextLine(
    ctx: CanvasRenderingContext2D,
    line: string,
    x: number,
    y: number,
    align: CanvasTextAlign,
    letterSpacingPx: number,
): number {
    const width = textWidth(ctx, line, letterSpacingPx);
    if (!line || letterSpacingPx === 0) {
        ctx.textAlign = align;
        ctx.fillText(line, x, y);
        return width;
    }
    let cursor = x;
    if (align === "center") cursor = x - width / 2;
    else if (align === "right" || align === "end") cursor = x - width;
    ctx.textAlign = "left";
    for (const ch of Array.from(line)) {
        ctx.fillText(ch, cursor, y);
        cursor += ctx.measureText(ch).width + letterSpacingPx;
    }
    ctx.textAlign = align;
    return width;
}

function normalizedSymbolRotation(value: number | undefined): 0 | 90 | 180 | 270 {
    return value === 90 || value === 180 || value === 270 ? value : 0;
}

function logicalFrameSize(
    widthDots: number,
    heightDots: number,
    rotation: 0 | 90 | 180 | 270,
): { widthDots: number; heightDots: number } {
    return rotation === 90 || rotation === 270
        ? { widthDots: heightDots, heightDots: widthDots }
        : { widthDots, heightDots };
}

function rotateModuleMatrix(
    matrix: DataMatrixMatrix,
    rotationValue: number | undefined,
): DataMatrixMatrix {
    const rotation = normalizedSymbolRotation(rotationValue);
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
            } else {
                x = sourceRow;
                y = matrix.columns - 1 - sourceColumn;
            }
            pixels[y * columns + x] = value;
        }
    }
    return { columns, rows, pixels };
}

/**
 * Match the editor's opaque-white symbol frame and rotate the complete symbol
 * inside its physical bounding box. The callback draws in local logical dots.
 */
function drawInSymbolFrame(
    ctx: CanvasRenderingContext2D,
    xDots: number,
    yDots: number,
    widthDots: number,
    heightDots: number,
    rotationValue: number | undefined,
    draw: (logicalWidthDots: number, logicalHeightDots: number) => void,
): void {
    const rotation = normalizedSymbolRotation(rotationValue);
    const logical = logicalFrameSize(widthDots, heightDots, rotation);
    ctx.save();
    try {
        ctx.beginPath();
        ctx.rect(xDots, yDots, widthDots, heightDots);
        ctx.clip();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(xDots, yDots, widthDots, heightDots);
        if (rotation === 90) {
            ctx.translate(xDots + widthDots, yDots);
            ctx.rotate(Math.PI / 2);
        } else if (rotation === 180) {
            ctx.translate(xDots + widthDots, yDots + heightDots);
            ctx.rotate(Math.PI);
        } else if (rotation === 270) {
            ctx.translate(xDots, yDots + heightDots);
            ctx.rotate(-Math.PI / 2);
        } else {
            ctx.translate(xDots, yDots);
        }
        draw(logical.widthDots, logical.heightDots);
    } finally {
        ctx.restore();
    }
}

function expandSerial(value: string, sn: string, vars?: Record<string, string>): string {
    if (!sn && !vars) return value;
    return value.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (full, name: string) => {
        const lower = name.toLowerCase();
        if (lower === "serial" || lower === "step" || lower === "n" || lower === "counter" || lower === "index") {
            return sn || full;
        }
        if (vars && Object.prototype.hasOwnProperty.call(vars, name)) {
            return vars[name];
        }
        return full;
    });
}

function drawText(
    ctx: CanvasRenderingContext2D,
    el: TextEl,
    sn: string,
    vars: Record<string, string> | undefined,
    xDots: number,
    yDots: number,
    dpi: number,
    rfid?: RfidSettings,
): void {
    const text = resolveTextValue(el, sn, vars, rfid, true);
    if (!text) return;
    const isWebFont = el.fontSource && el.fontSource !== "zpl";

    let fontPx: number;
    let family: string;
    let weight: number;
    let style: "normal" | "italic";
    let letterSpacingPx = 0;
    if (isWebFont) {
        const sizeMm = el.fontSizeMm ?? 4;
        fontPx = (sizeMm / 25.4) * dpi;
        family = fontStackFor(el.fontSource ?? "system", el.fontFamily);
        weight = el.fontWeight ?? 400;
        style = el.fontItalic ? "italic" : "normal";
    } else {
        // ZPL native-font fallback: pick a clean monospace and size it
        // to match the selected native font cell height.
        const dots = TEXT_FONT_DOTS[el.font];
        const targetMm = el.fontSizeMm ?? (dots.h / DEFAULT_DPI) * 25.4 * Math.max(1, el.scaleY ?? 1);
        fontPx = (targetMm / 25.4) * dpi;
        const cellWmm = (dots.w / DEFAULT_DPI) * 25.4 * Math.max(1, el.scaleX ?? 1);
        const cellWpx = (cellWmm / 25.4) * dpi;
        letterSpacingPx = cellWpx - fontPx * 0.6;
        family = '"Andale Mono", "Liberation Mono", "DejaVu Sans Mono", "Menlo", "Consolas", monospace';
        weight = 400;
        style = "normal";
    }

    const wrapMode = getTextWrapMode(el.wrapMode);
    const fitMode = getTextFitMode(el.fitMode);
    const framed = textUsesFrame(wrapMode, fitMode);
    const widthDots = Math.max(1, mmToDots(el.size.w, dpi));
    const heightDots = Math.max(1, mmToDots(el.size.h, dpi));
    const letterSpacingFor = (candidateFontPx: number) =>
        letterSpacingPx * (candidateFontPx / Math.max(1, fontPx));
    const createMeasure = (candidateFontPx: number) => {
        ctx.font = `${style} ${weight} ${candidateFontPx}px ${family}`;
        const spacing = letterSpacingFor(candidateFontPx);
        return (value: string) => textWidth(ctx, value, spacing);
    };
    const layout = layoutTextInFrame({
        text,
        baseFontPx: fontPx,
        frameWidthPx: framed ? widthDots : Number.MAX_SAFE_INTEGER,
        frameHeightPx: framed ? heightDots : Number.MAX_SAFE_INTEGER,
        wrapMode: framed ? wrapMode : "none",
        fitMode: framed ? fitMode : "clip",
        lineHeightRatio: 1.0,
        createMeasure,
    });

    ctx.fillStyle = "#000000";
    ctx.font = `${style} ${weight} ${layout.fontPx}px ${family}`;
    ctx.textBaseline = "top";
    const align = el.align ?? "left";
    const canvasAlign: CanvasTextAlign =
        align === "center" ? "center" : align === "right" ? "right" : "left";
    ctx.textAlign = canvasAlign;
    const originX = canvasAlign === "center" ? widthDots / 2 : canvasAlign === "right" ? widthDots : 0;
    const lineHeight = layout.lineHeightPx;
    const spacing = letterSpacingFor(layout.fontPx);
    const drawUnderline = (line: string, x: number, y: number, lineWidth: number) => {
        if (!el.fontUnderline || !line) return;
        let left = x;
        if (canvasAlign === "center") left = x - lineWidth / 2;
        else if (canvasAlign === "right") left = x - lineWidth;
        const underlineY = y + layout.fontPx * 0.9;
        const thickness = Math.max(1, Math.round(layout.fontPx * 0.06));
        ctx.fillRect(left, underlineY, lineWidth, thickness);
    };
    const drawLines = () => {
        for (let i = 0; i < layout.lines.length; i += 1) {
            const y = i * lineHeight;
            if (framed && y > heightDots) break;
            const width = fillTextLine(ctx, layout.lines[i], originX, y, canvasAlign, spacing);
            drawUnderline(layout.lines[i], originX, y, width);
        }
    };

    ctx.save();
    if (el.rotation) {
        ctx.translate(xDots, yDots);
        ctx.rotate((el.rotation * Math.PI) / 180);
        if (framed) {
            ctx.beginPath();
            ctx.rect(0, 0, widthDots, heightDots);
            ctx.clip();
        }
        drawLines();
    } else {
        ctx.translate(xDots, yDots);
        if (framed) {
            ctx.beginPath();
            ctx.rect(0, 0, widthDots, heightDots);
            ctx.clip();
        }
        drawLines();
    }
    ctx.restore();
}

async function drawImageEl(
    ctx: CanvasRenderingContext2D,
    el: ImageEl,
    xDots: number,
    yDots: number,
    dpi: number,
): Promise<void> {
    if (!el.src) return;
    const wDots = Math.max(1, mmToDots(el.size.w, dpi));
    const hDots = Math.max(1, mmToDots(el.size.h, dpi));
    try {
        const img = await decodeImage(el.src);
        drawContainedImage(ctx, img, xDots, yDots, wDots, hDots);
    } catch {
        /* skip un-decodable image */
    }
}

async function drawQr(
    ctx: CanvasRenderingContext2D,
    el: QrEl,
    sn: string,
    vars: Record<string, string> | undefined,
    xDots: number,
    yDots: number,
    dpi: number,
): Promise<void> {
    const data = resolveDynamicValue(el.data, el.fieldName, sn, vars);
    if (!data) return;
    const frameWidthDots = Math.max(1, mmToDots(el.size.w, dpi));
    const frameHeightDots = Math.max(1, mmToDots(el.size.h, dpi));
    let matrix: DataMatrixMatrix;
    try {
        matrix = rotateModuleMatrix(
            encodeQrMatrix(data, el.ecc, qrMinVersion(el.version)),
            el.rotation,
        );
    } catch (error) {
        console.warn("[print] QR encode failed:", error);
        return;
    }
    const layout = fitQrToFrameDots(frameWidthDots, frameHeightDots, matrix.columns, {
        quietZoneModules: el.quietZoneModules,
        requestedMagnification: el.sizeMode === "manual" ||
            (el.sizeMode === undefined && typeof el.magnification === "number")
            ? el.magnification
            : undefined,
        dpi,
        minModuleMm: el.minModuleMm,
        align: el.align,
        verticalAlign: el.verticalAlign,
    });
    drawInSymbolFrame(
        ctx,
        xDots,
        yDots,
        frameWidthDots,
        frameHeightDots,
        0,
        () => {
            ctx.fillStyle = "#000000";
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
                    ctx.fillRect(
                        layout.dataOffsetXDots + start * layout.moduleDots,
                        layout.dataOffsetYDots + row * layout.moduleDots,
                        (column - start) * layout.moduleDots,
                        layout.moduleDots,
                    );
                }
            }
        },
    );
}

function drawDataMatrix(
    ctx: CanvasRenderingContext2D,
    el: DataMatrixEl,
    sn: string,
    vars: Record<string, string> | undefined,
    xDots: number,
    yDots: number,
    dpi: number,
): void {
    const data = resolveDynamicValue(el.data, el.fieldName, sn, vars);
    if (!data) return;
    try {
        const matrix = rotateModuleMatrix(
            encodeDataMatrix(data, {
                contentFormat: el.contentFormat,
                shape: el.shape,
                textEncoding: el.textEncoding,
                symbolRows: el.symbolRows,
                symbolColumns: el.symbolColumns,
            }),
            el.rotation,
        );
        const frameWidthDots = Math.max(1, mmToDots(el.size.w, dpi));
        const frameHeightDots = Math.max(1, mmToDots(el.size.h, dpi));
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
        drawInSymbolFrame(
            ctx,
            xDots,
            yDots,
            frameWidthDots,
            frameHeightDots,
            0,
            () => {
                ctx.fillStyle = "#000000";
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
                        ctx.fillRect(
                            layout.dataOffsetXDots + start * layout.moduleDots,
                            layout.dataOffsetYDots + row * layout.moduleDots,
                            (column - start) * layout.moduleDots,
                            layout.moduleDots,
                        );
                    }
                }
            },
        );
    } catch (error) {
        console.warn("[print] Data Matrix encode failed:", error);
    }
}

function drawBarcode(
    ctx: CanvasRenderingContext2D,
    el: BarcodeEl,
    sn: string,
    vars: Record<string, string> | undefined,
    xDots: number,
    yDots: number,
    dpi: number,
): void {
    const data = resolveDynamicValue(el.data, el.fieldName, sn, vars);
    if (!data) return;
    const r = renderBarcode(data, el.symbology);
    if (!r || r.totalModules <= 0) return;
    const frameWidthDots = Math.max(1, mmToDots(el.size.w, dpi));
    const frameHeightDots = Math.max(2, mmToDots(el.size.h, dpi));
    const rotation = normalizedSymbolRotation(el.rotation);
    const logical = logicalFrameSize(frameWidthDots, frameHeightDots, rotation);
    const align = el.align ?? "center";
    const manual = el.sizeMode === "manual" ||
        (el.sizeMode === undefined && typeof el.narrowDots === "number");
    const layout = barcodeModuleLayout({
        containerDots: logical.widthDots,
        totalModules: r.totalModules,
        quietZoneLeftModules: r.quietZoneLeftModules,
        quietZoneRightModules: r.quietZoneRightModules,
        dpi,
        minModuleMm: el.minModuleMm,
        align,
        mode: manual ? "fixed" : "auto",
        requestedDotsPerModule: manual
            ? (el.narrowDots ?? scanSafeBarcodeNarrowDots(dpi))
            : undefined,
    });
    const vertical = barcodeHeightLayout({
        frameHeightDots: logical.heightDots,
        dpi,
        humanReadable: el.humanReadable,
        barHeightMm: el.barHeightMm,
        textSizeMm: el.textSizeMm,
        textPaddingMm: el.textPaddingMm,
        textPosition: el.textPosition,
    });

    drawInSymbolFrame(
        ctx,
        xDots,
        yDots,
        frameWidthDots,
        frameHeightDots,
        rotation,
        (logicalWidthDots) => {
            ctx.fillStyle = "#000000";
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

            // Keep every module on the printer-dot grid. Fractionally
            // stretching a symbol changes bar/space ratios and scan quality.
            let cursorDots = layout.barOffsetDots;
            let symbolModule = 0;
            for (let i = 0; i < r.widths.length; i += 1) {
                const moduleWidth = r.widths[i];
                const width = moduleWidth * layout.narrowDots;
                if (i % 2 === 0) {
                    const guard = el.symbology === "EAN13" &&
                        overlapsGuard(symbolModule, symbolModule + moduleWidth);
                    const shortened = guard ? 0 : guardExtension;
                    const barY = vertical.barsOffsetDots + (textAbove ? shortened : 0);
                    ctx.fillRect(
                        cursorDots,
                        barY,
                        width,
                        Math.max(2, vertical.barHeightDots - shortened),
                    );
                }
                cursorDots += width;
                symbolModule += moduleWidth;
            }

            if (!el.humanReadable) return;
            ctx.font = `400 ${vertical.textHeightDots}px "Andale Mono", "Liberation Mono", monospace`;
            ctx.textBaseline = "top";
            if (el.symbology === "EAN13" && r.render.length === 13) {
                const x = layout.barOffsetDots;
                const unit = layout.narrowDots;
                ctx.textAlign = "center";
                ctx.fillText(r.render[0], Math.max(unit * 2, x - unit * 4), vertical.textOffsetDots);
                ctx.fillText(r.render.slice(1, 7), x + unit * 24, vertical.textOffsetDots);
                ctx.fillText(r.render.slice(7), x + unit * 71, vertical.textOffsetDots);
                return;
            }
            const textAlign = el.textAlign ?? "center";
            ctx.textAlign = textAlign;
            const textX = textAlign === "left"
                ? 0
                : textAlign === "right"
                  ? logicalWidthDots
                  : logicalWidthDots / 2;
            ctx.fillText(r.render, textX, vertical.textOffsetDots);
        },
    );
}

function drawRect(ctx: CanvasRenderingContext2D, el: RectEl, xDots: number, yDots: number, dpi: number): void {
    const wDots = Math.max(1, mmToDots(el.size.w, dpi));
    const hDots = Math.max(1, mmToDots(el.size.h, dpi));
    ctx.fillStyle = "#000000";
    if (el.filled) {
        ctx.fillRect(xDots, yDots, wDots, hDots);
        return;
    }
    const t = Math.max(1, mmToDots(el.thickness, dpi));
    // Frame: top, bottom, left, right strips.
    ctx.fillRect(xDots, yDots, wDots, t);
    ctx.fillRect(xDots, yDots + hDots - t, wDots, t);
    ctx.fillRect(xDots, yDots, t, hDots);
    ctx.fillRect(xDots + wDots - t, yDots, t, hDots);
}

function drawLine(ctx: CanvasRenderingContext2D, el: LineEl, xDots: number, yDots: number, dpi: number): void {
    const ink = lineStrokeBoundsDots(el, dpi);
    ctx.fillStyle = "#000000";
    ctx.fillRect(xDots + ink.x, yDots + ink.y, ink.w, ink.h);
}

// Mirrors the native printer table renderer: outer + interior frame rectangles,
// one text fill per cell. Without this case, tables are silently dropped
// from the print preview, PDF export, and full-bitmap print path while
// while preserving the same geometry in the ZPL output.
function drawTable(
    ctx: CanvasRenderingContext2D,
    el: TableEl,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
): void {
    const x0 = mmToDots(el.pos.x, dpi);
    const y0 = mmToDots(el.pos.y, dpi);
    const x1 = mmToDots(el.pos.x + el.size.w, dpi);
    const y1 = mmToDots(el.pos.y + el.size.h, dpi);

    if (el.borderThickness > 0) {
        const t = Math.max(1, mmToDots(el.borderThickness, dpi));
        ctx.fillStyle = "#000000";
        // Outer frame.
        ctx.fillRect(x0, y0, x1 - x0, t); // top
        ctx.fillRect(x0, y1 - t, x1 - x0, t); // bottom
        ctx.fillRect(x0, y0, t, y1 - y0); // left
        ctx.fillRect(x1 - t, y0, t, y1 - y0); // right

        // Interior verticals.
        let cx = el.pos.x;
        for (let c = 0; c < el.cols - 1; c += 1) {
            cx += el.colWidths[c] ?? 0;
            const xv = mmToDots(cx, dpi);
            ctx.fillRect(xv, y0, t, y1 - y0);
        }
        // Interior horizontals.
        let cy = el.pos.y;
        for (let r = 0; r < el.rows - 1; r += 1) {
            cy += el.rowHeights[r] ?? 0;
            const yh = mmToDots(cy, dpi);
            ctx.fillRect(x0, yh, x1 - x0, t);
        }
    }

    const padDots = mmToDots(el.padding, dpi);
    ctx.fillStyle = "#000000";
    ctx.textBaseline = "top";

    let cellY = el.pos.y;
    for (let r = 0; r < el.rows; r += 1) {
        let cellX = el.pos.x;
        for (let c = 0; c < el.cols; c += 1) {
            const value = el.cells[r * el.cols + c] ?? "";
            const expanded = expandSerial(value, sn, vars);
            if (expanded) {
                const style = el.cellStyles?.[r * el.cols + c];
                const targetMm =
                    typeof style?.fontSizeMm === "number" ? style.fontSizeMm : el.fontSizeMm;
                const isHeader = r === 0 && el.headerRow === true;
                const bold = style?.bold ?? isHeader;
                const align = style?.align ?? el.align ?? "left";
                const fontPx = (targetMm / 25.4) * dpi;
                const weight = bold ? 700 : 400;
                ctx.font = `${weight} ${fontPx}px "Andale Mono", "Liberation Mono", "DejaVu Sans Mono", "Menlo", "Consolas", monospace`;
                ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";

                const colW = el.colWidths[c] ?? 0;
                const tx0 = mmToDots(cellX, dpi) + padDots;
                const cellWidthDots = Math.max(0, mmToDots(colW, dpi) - padDots * 2);
                const ty = mmToDots(cellY, dpi) + padDots;
                let originX = tx0;
                if (ctx.textAlign === "center") originX = tx0 + cellWidthDots / 2;
                else if (ctx.textAlign === "right") originX = tx0 + cellWidthDots;
                ctx.fillText(expanded, originX, ty);
            }
            cellX += el.colWidths[c] ?? 0;
        }
        cellY += el.rowHeights[r] ?? 0;
    }
}

async function drawElement(
    ctx: CanvasRenderingContext2D,
    el: LabelElement,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
    rfid?: RfidSettings,
): Promise<void> {
    if (el.kind !== "text" && el.kind !== "image" && el.kind !== "table") {
        return drawElementContent(ctx, el, sn, vars, dpi, rfid);
    }
    if (el.kind === "text") {
        const inner = insetTextElement(el, dpi);
        if (!inner) return;
        el = inner;
    }
    const w = Math.max(1, mmToDots(el.size.w, dpi));
    const h = Math.max(1, mmToDots(el.size.h, dpi));
    const frame = rotationFrame({ w, h }, el.rotation);
    ctx.save();
    try {
        ctx.translate(mmToDots(el.pos.x, dpi), mmToDots(el.pos.y, dpi));
        ctx.beginPath();
        ctx.rect(0, 0, w, h);
        ctx.clip();
        ctx.translate(frame.x, frame.y);
        ctx.rotate(frame.radians);
        await drawElementContent(ctx, {
            ...el, pos: { x: 0, y: 0 }, size: logicalSize(el.size, el.rotation), rotation: 0,
        }, sn, vars, dpi, rfid);
    } finally {
        ctx.restore();
    }
}

async function drawElementContent(
    ctx: CanvasRenderingContext2D,
    el: LabelElement,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
    rfid?: RfidSettings,
): Promise<void> {
    const xDots = mmToDots(el.pos.x, dpi);
    const yDots = mmToDots(el.pos.y, dpi);
    switch (el.kind) {
        case "text":
            drawText(ctx, el, sn, vars, xDots, yDots, dpi, rfid);
            return;
        case "image":
            await drawImageEl(ctx, el, xDots, yDots, dpi);
            return;
        case "qr":
            await drawQr(ctx, el, sn, vars, xDots, yDots, dpi);
            return;
        case "barcode":
            drawBarcode(ctx, el, sn, vars, xDots, yDots, dpi);
            return;
        case "datamatrix":
            drawDataMatrix(ctx, el, sn, vars, xDots, yDots, dpi);
            return;
        case "rect":
            drawRect(ctx, el, xDots, yDots, dpi);
            return;
        case "line":
            drawLine(ctx, el, xDots, yDots, dpi);
            return;
        case "table":
            drawTable(ctx, el, sn, vars, dpi);
            return;
    }
}

function packCanvasToBitmap(
    ctx: CanvasRenderingContext2D,
    widthDots: number,
    heightDots: number,
): RasterBitmap {
    const data = ctx.getImageData(0, 0, widthDots, heightDots).data;
    const widthBytes = Math.ceil(widthDots / 8);
    const bytes = new Uint8Array(widthBytes * heightDots);
    for (let y = 0; y < heightDots; y += 1) {
        let byteIdx = y * widthBytes;
        let bitMask = 0x80;
        let acc = 0;
        for (let x = 0; x < widthDots; x += 1) {
            const i = (y * widthDots + x) * 4;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const a = data[i + 3];
            const lum = (r * 299 + g * 587 + b * 114) / 1000;
            const composited = (lum * a + 255 * (255 - a)) / 255;
            if (composited < 128) acc |= bitMask;
            bitMask >>>= 1;
            if (bitMask === 0) {
                bytes[byteIdx] = acc;
                byteIdx += 1;
                acc = 0;
                bitMask = 0x80;
            }
        }
        if (bitMask !== 0x80) bytes[byteIdx] = acc;
    }
    return { widthDots, heightDots, widthBytes, bytes };
}

// Render every element of the doc into a fresh canvas at the given DPI.
// Shared by the bitmap path (which packs the result to 1-bit) and the
// pixel-accurate preview path (which thresholds the result and displays it).
async function drawDocToCanvas(
    doc: LabelDoc,
    copyIndex: number,
    dpi: number,
    options: RenderLabelOptions & PreviewCanvasOptions = {},
): Promise<HTMLCanvasElement | null> {
    if (typeof document === "undefined") return null;
    const nativeWidthDots = Math.max(1, mmToDots(doc.settings.widthMm, dpi));
    const nativeHeightDots = Math.max(1, mmToDots(doc.settings.heightMm, dpi));
    const backing = previewBackingSize(nativeWidthDots, nativeHeightDots, options);

    const canvas = document.createElement("canvas");
    canvas.width = backing.widthPx;
    canvas.height = backing.heightPx;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const s = doc.settings.serial;
    const sn = s.enabled ? formatSerial(s.start + copyIndex * s.step, s.pad, s.prefix) : "";
    const vars = variablesForCopy(doc, copyIndex);
    const readFieldName = rfidReadFieldName(doc);
    const hasResolvedReadValue = readFieldName
        ? varsHaveRfidReadValue(vars, readFieldName)
        : false;

    // Element layout still runs in native printer-dot coordinates. Scaling the
    // drawing context maps that layout directly into a bounded thumbnail and
    // avoids ever allocating a native-size full-label canvas for roll items.
    ctx.save();
    ctx.scale(canvas.width / nativeWidthDots, canvas.height / nativeHeightDots);
    try {
        for (const el of doc.elements) {
            if (options.skipNativeQr && el.kind === "qr") continue;
            if (
                options.skipRfidReadDynamicElements &&
                elementUsesRfidReadField(doc, el) &&
                (options.skipResolvedRfidReadDynamicElements || !hasResolvedReadValue)
            ) {
                continue;
            }
            await drawElement(ctx, el, sn, vars, dpi, doc.settings.rfid);
        }
    } finally {
        ctx.restore();
    }

    return canvas;
}

// Render the entire label for a single copy / row to a 1-bit bitmap.
// Returns null in non-browser contexts.
export async function renderLabelToBitmap(
    doc: LabelDoc,
    copyIndex: number = 0,
    options: RenderLabelOptions = {},
): Promise<RasterBitmap | null> {
    const dpi = doc.settings.dpi ?? DEFAULT_DPI;
    const canvas = await drawDocToCanvas(doc, copyIndex, dpi, options);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    return packCanvasToBitmap(ctx, canvas.width, canvas.height);
}

// Render the label and threshold every backing pixel to pure black or white.
// With default options this is the native-DPI source-of-truth for what will
// print. Thumbnail callers may bound the backing allocation while layout still
// runs in native printer-dot coordinates.
export async function renderLabelToPreviewCanvas(
    doc: LabelDoc,
    copyIndex: number = 0,
    options: PreviewCanvasOptions = {},
): Promise<HTMLCanvasElement | null> {
    const dpi = doc.settings.dpi ?? DEFAULT_DPI;
    const canvas = await drawDocToCanvas(doc, copyIndex, dpi, options);
    if (!canvas) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    // The threshold pass requires reading the canvas back, which throws a
    // SecurityError if any image taints the canvas (e.g. an SVG/PNG fetched
    // without CORS). Fall back to the un-thresholded canvas in that case so
    // the user still sees a preview instead of a blank rectangle.
    try {
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const px = img.data;
        for (let i = 0; i < px.length; i += 4) {
            const lum = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000;
            const a = px[i + 3];
            const composited = (lum * a + 255 * (255 - a)) / 255;
            const v = composited < 128 ? 0 : 255;
            px[i] = px[i + 1] = px[i + 2] = v;
            px[i + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
    } catch (err) {
        console.warn("[preview] threshold pass failed, returning un-thresholded canvas:", err);
    }
    return canvas;
}

// Rasterize a single QR element to a 1-bit bitmap sized exactly to the
// element's designed dimensions. Used to overlay QRs as a `Q` graphic
// when the native `W` command's `mul` parameter (capped at 8) makes the
// printed QR smaller than the design slot.
export async function rasterizeQrEl(
    el: QrEl,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number = DEFAULT_DPI,
): Promise<RasterBitmap | null> {
    if (typeof document === "undefined") return null;
    const sideDots = Math.max(8, Math.min(mmToDots(el.size.w, dpi), mmToDots(el.size.h, dpi)));
    const canvas = document.createElement("canvas");
    canvas.width = sideDots;
    canvas.height = sideDots;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sideDots, sideDots);
    // Draw the QR at (0, 0) on this dedicated canvas. The shared `drawQr`
    // helper takes element pos via its xDots/yDots args; we pass 0,0 since
    // the canvas IS the element bounding box.
    const elAtOrigin: QrEl = { ...el, pos: { x: 0, y: 0 } };
    await drawQr(ctx, elAtOrigin, sn, vars, 0, 0, dpi);
    return packCanvasToBitmap(ctx, sideDots, sideDots);
}

// Rasterize a single barcode element to a 1-bit bitmap sized exactly to
// the element's designed dimensions. Used instead of the native `B`
// command when the printer's `narrow` parameter doesn't reproduce the
// designed barcode width.
export function rasterizeBarcodeEl(
    el: BarcodeEl,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number = DEFAULT_DPI,
): RasterBitmap | null {
    if (typeof document === "undefined") return null;
    const wDots = Math.max(8, mmToDots(el.size.w, dpi));
    const hDots = Math.max(8, mmToDots(el.size.h, dpi));
    const canvas = document.createElement("canvas");
    canvas.width = wDots;
    canvas.height = hDots;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, wDots, hDots);
    const elAtOrigin: BarcodeEl = { ...el, pos: { x: 0, y: 0 } };
    drawBarcode(ctx, elAtOrigin, sn, vars, 0, 0, dpi);
    return packCanvasToBitmap(ctx, wDots, hDots);
}
