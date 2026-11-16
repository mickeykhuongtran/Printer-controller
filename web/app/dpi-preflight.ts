import {
    barcodeHeightLayout,
    barcodeModuleLayout,
    renderBarcode,
    scanSafeBarcodeNarrowDots,
} from "./barcode";
import {
    maxPrintWidthMm,
    zebraPrinterModelProfile,
} from "./printer-models";
import { fitQrToFrameDots, qrMinVersion, qrModuleCount } from "./qr-sizing";
import { encodeDataMatrix, fitDataMatrixToFrameDots } from "./datamatrix";
import type {
    BarcodeEl,
    LabelDoc,
    PrinterDpi,
    RfidSettings,
    ZebraRfidModel,
} from "./types";
import { dotsPerMm, dotsToMm, mmToDots } from "./units";
import { formatSerial, resolveDynamicValue, variablesForCopy } from "./label-data";
import { isBuiltInVar } from "./data-feed";
import { zebraRfidReadHexCharacterCount } from "./rfid";
import { rfidTextLastChars } from "./rfid-text";
import { textContentFrame } from "./text-margin";
import { logicalSize } from "./rotation";

export type DpiPreflightSeverity = "error" | "warning" | "info";

export type DpiPreflightIssueCode =
    | "MODEL_DPI_UNSUPPORTED"
    | "LABEL_EXCEEDS_PRINTABLE_WIDTH"
    | "ELEMENT_OUTSIDE_LABEL"
    | "STROKE_BELOW_ONE_DOT"
    | "BARCODE_NARROW_DOTS_UNSAFE"
    | "BARCODE_INVALID_DATA"
    | "BARCODE_DOES_NOT_FIT"
    | "BARCODE_HEIGHT_DOES_NOT_FIT"
    | "BARCODE_RFID_EAN13_UNSUPPORTED"
    | "BARCODE_RFID_NATIVE_UNSUPPORTED"
    | "SYMBOL_UNKNOWN_PLACEHOLDER"
    | "SYMBOL_UNRESOLVED_PLACEHOLDER"
    | "QR_EMPTY_DATA"
    | "QR_INVALID_DATA"
    | "QR_TOO_SMALL_FOR_MODULE_MATRIX"
    | "QR_MODULE_SIZE_UNSAFE"
    | "QR_RFID_NATIVE_UNSUPPORTED"
    | "DATAMATRIX_EMPTY_DATA"
    | "DATAMATRIX_INVALID_DATA"
    | "DATAMATRIX_DOES_NOT_FIT"
    | "DATAMATRIX_MODULE_SIZE_UNSAFE"
    | "DATAMATRIX_RFID_NATIVE_UNSUPPORTED"
    | "RFID_FIELD_CONCAT_REQUIRES_LINK_OS_68"
    | "DYNAMIC_SYMBOL_CHECK_DEFERRED"
    | "RFID_SYMBOL_SIZE_ESTIMATED"
    | "LEGACY_TEXT_WITHOUT_PHYSICAL_SIZE"
    | "TEXT_MARGIN_NO_SPACE"
    | "TEXT_MARGIN_FONT_HEIGHT";

export type DpiPreflightIssue = {
    severity: DpiPreflightSeverity;
    code: DpiPreflightIssueCode;
    message: string;
    elementId?: string;
};

const GEOMETRY_EPSILON_MM = 1e-6;
const DYNAMIC_FIELD_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}/;
const FIELD_CONCAT_DELIMITERS = "#|@!%&;:?+*/-.$()[]{}";

type SymbolElement = Extract<
    LabelDoc["elements"][number],
    { kind: "barcode" | "qr" | "datamatrix" }
>;
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function normalizedVariableName(value: string | undefined): string {
    return (value ?? "").trim().replace(/^\{|\}$/g, "").toLowerCase();
}

function placeholderNames(value: string): string[] {
    const found = new Map<string, string>();
    for (const match of value.matchAll(PLACEHOLDER_RE)) {
        const name = match[1];
        const key = name.toLowerCase();
        if (!found.has(key)) found.set(key, name);
    }
    return Array.from(found.values());
}

function declaredVariableNames(doc: LabelDoc): Set<string> {
    const names = new Set<string>();
    const add = (value: string | undefined) => {
        const name = normalizedVariableName(value);
        if (name) names.add(name);
    };
    for (const column of doc.dataFeed?.columns ?? []) add(column.name);
    for (const field of doc.templateFields ?? []) add(field.name);
    for (const element of doc.elements) {
        if ("fieldName" in element) add(element.fieldName);
    }
    add(doc.settings.rfid.fieldName);
    if (doc.settings.rfid.readEnabled) {
        add(doc.settings.rfid.readFieldName ?? "rfid_read");
    }
    return names;
}

function symbolPlaceholderIssue(
    element: SymbolElement,
    resolvedData: string,
    declaredNames: ReadonlySet<string>,
    copyIndex: number | undefined,
    printerRfidReadField: string | null,
): DpiPreflightIssue | null {
    const printerField = normalizedVariableName(printerRfidReadField ?? undefined);
    if (copyIndex === undefined) {
        const unknown = placeholderNames(element.data).filter((name) => {
            const key = name.toLowerCase();
            return key !== printerField && !isBuiltInVar(key) && !declaredNames.has(key);
        });
        if (unknown.length === 0) return null;
        return {
            severity: "error",
            code: "SYMBOL_UNKNOWN_PLACEHOLDER",
            elementId: element.id,
            message:
                `${element.kind === "qr" ? "QR" : element.kind === "barcode" ? "Barcode" : "Data Matrix"} ` +
                `uses undeclared variable${unknown.length === 1 ? "" : "s"} ` +
                `${unknown.map((name) => `{${name}}`).join(", ")}. ` +
                "Add the field to Data Feed/template fields or select a valid binding before printing.",
        };
    }

    const unresolved = placeholderNames(resolvedData).filter(
        (name) => name.toLowerCase() !== printerField,
    );
    if (unresolved.length === 0) return null;
    return {
        severity: "error",
        code: "SYMBOL_UNRESOLVED_PLACEHOLDER",
        elementId: element.id,
        message:
            `${element.kind === "qr" ? "QR" : element.kind === "barcode" ? "Barcode" : "Data Matrix"} ` +
            `variable${unresolved.length === 1 ? "" : "s"} ` +
            `${unresolved.map((name) => `{${name}}`).join(", ")} ` +
            `did not resolve for data row ${copyIndex + 1}. Fill or correct that row before printing.`,
    };
}

function targetModel(doc: LabelDoc): ZebraRfidModel {
    // zebraModel was the design target in older saved documents. Prefer the
    // explicit targetPrinterModel field, while retaining useful preflight for
    // those legacy templates.
    return doc.settings.targetPrinterModel ?? doc.settings.rfid.zebraModel ?? "auto";
}

function formatMm(value: number): string {
    return `${Math.round(value * 1000) / 1000}`;
}

function configuredRfidReadField(doc: LabelDoc): string | null {
    if (!doc.settings.rfid.readEnabled) return null;
    const fieldName = (doc.settings.rfid.readFieldName ?? "rfid_read")
        .trim()
        .replace(/^\{|\}$/g, "");
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName) ? fieldName : null;
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rfidReadPlaceholderRegex(fieldName: string): RegExp {
    return new RegExp(`\\{\\s*${escapeRegex(fieldName)}\\s*\\}`, "gi");
}

function varsHaveRfidReadValue(
    vars: Record<string, string> | undefined,
    fieldName: string,
): boolean {
    if (!vars) return false;
    const wanted = fieldName.toLowerCase();
    return Object.entries(vars).some(
        ([key, value]) => key.toLowerCase() === wanted && String(value).trim() !== "",
    );
}

function varsWithoutField(
    vars: Record<string, string> | undefined,
    fieldName: string,
): Record<string, string> | undefined {
    if (!vars) return undefined;
    const wanted = fieldName.toLowerCase();
    const filtered = Object.fromEntries(
        Object.entries(vars).filter(([key]) => key.toLowerCase() !== wanted),
    );
    return Object.keys(filtered).length === Object.keys(vars).length ? vars : filtered;
}

/** Keep this conservative sample identical to the printer-resolved path in zpl.ts. */
function rfidReadSample(rfid: RfidSettings, symbology?: BarcodeEl["symbology"]): string {
    const hexChars = zebraRfidReadHexCharacterCount(rfid);
    return symbology === "EAN13"
        ? "0".repeat(Math.min(13, hexChars))
        : "F".repeat(hexChars);
}

function printerRfidSymbolData(
    element: SymbolElement,
    fieldName: string,
    rfid: RfidSettings,
    sn: string,
    vars: Record<string, string> | undefined,
): { raw: string; sizingData: string } {
    const fieldMatches = (element.fieldName ?? "").trim().toLowerCase() === fieldName.toLowerCase();
    const textContainsRead = rfidReadPlaceholderRegex(fieldName).test(element.data);
    const raw = fieldMatches && !textContainsRead
        ? `{${fieldName}}`
        : resolveDynamicValue(
              element.data,
              textContainsRead ? undefined : element.fieldName,
              sn,
              varsWithoutField(vars, fieldName),
          );
    return {
        raw,
        sizingData: raw.replace(
            rfidReadPlaceholderRegex(fieldName),
            rfidReadSample(rfid, element.kind === "barcode" ? element.symbology : undefined),
        ),
    };
}

function fieldConcatDelimiter(value: string): string | null {
    for (const candidate of FIELD_CONCAT_DELIMITERS) {
        if (!value.includes(candidate)) return candidate;
    }
    return null;
}

function isOnlyRfidReadField(value: string, fieldName: string): boolean {
    return new RegExp(`^\\s*\\{\\s*${escapeRegex(fieldName)}\\s*\\}\\s*$`, "i").test(value);
}

function zplHexByteLength(value: string, extraUnsafe: string): number {
    let length = 0;
    for (const byte of new TextEncoder().encode(value)) {
        const printable = byte >= 0x20 && byte <= 0x7e;
        const character = String.fromCharCode(byte);
        length += printable && byte !== 0x5e && byte !== 0x7e && byte !== 0x5c
            && !extraUnsafe.includes(character)
            ? 1
            : 3;
    }
    return length;
}

function concatenatedNativeFieldLength(
    value: string,
    fieldName: string,
    delimiter: string,
    kind: "qr" | "datamatrix",
): number {
    const tokenLength = `${delimiter}1${delimiter}`.length;
    const regex = rfidReadPlaceholderRegex(fieldName);
    let length = kind === "qr" ? 3 : 0; // `${ecc}A,` is part of QR ^FD.
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
        const literal = value.slice(lastIndex, match.index);
        length += zplHexByteLength(
            kind === "datamatrix" ? literal.replace(/_/g, "__") : literal,
            delimiter,
        );
        length += tokenLength;
        lastIndex = match.index + match[0].length;
    }
    const tail = value.slice(lastIndex);
    length += zplHexByteLength(
        kind === "datamatrix" ? tail.replace(/_/g, "__") : tail,
        delimiter,
    );
    return length;
}

function printerRfidNativeDataError(
    element: SymbolElement,
    raw: string,
    sizingData: string,
    fieldName: string,
): string | null {
    const delimiter = fieldConcatDelimiter(raw);
    if (!delimiter) {
        return "Printer-resolved RFID content uses every supported Zebra ^FE delimiter. " +
            "Resolve the RFID value on the host before printing.";
    }
    if (element.kind === "qr") {
        if (!/^[\x20-\x7E]+$/.test(sizingData)) {
            return "Printer-resolved RFID QR data is limited to safe ASCII for native Zebra output. " +
                "Resolve non-ASCII data on the host for UTF-8 bitmap output.";
        }
        if (concatenatedNativeFieldLength(raw, fieldName, delimiter, "qr") > 3072) {
            return "Printer-resolved RFID QR field data exceeds Zebra's 3,072-byte ^FD limit.";
        }
    }
    if (
        element.kind === "datamatrix"
        && !isOnlyRfidReadField(raw, fieldName)
        && concatenatedNativeFieldLength(raw, fieldName, delimiter, "datamatrix") > 3072
    ) {
        return "Printer-resolved RFID Data Matrix field data exceeds Zebra's 3,072-byte ^FD limit.";
    }
    return null;
}

function elementUsesPrinterRfidRead(
    element: SymbolElement,
    fieldName: string | null,
): boolean {
    if (!fieldName) return false;
    const direct = (element.fieldName ?? "").trim();
    if (direct.toLowerCase() === fieldName.toLowerCase()) return true;
    return rfidReadPlaceholderRegex(fieldName).test(element.data);
}

function printerRfidFieldNeedsConcatenation(
    element: SymbolElement,
    raw: string,
    fieldName: string,
): boolean {
    // ^BQ keeps its error-correction/input switches inside ^FD, so even a
    // direct QR value must be concatenated with that prefix through ^FE.
    if (element.kind === "qr") return true;
    return !isOnlyRfidReadField(raw, fieldName);
}

/**
 * Run deterministic, side-effect-free checks that can change when a template
 * is assigned to a different Zebra model or printhead resolution.
 *
 * Positions and sizes remain physical millimetres; this intentionally avoids
 * reporting harmless sub-dot coordinate quantisation.
 */
export function preflightLabelForPrinter(
    doc: LabelDoc,
    options: { copyIndex?: number } = {},
): DpiPreflightIssue[] {
    const issues: DpiPreflightIssue[] = [];
    const { settings } = doc;
    const dpi: PrinterDpi = settings.dpi;
    const model = targetModel(doc);
    const profile = zebraPrinterModelProfile(model);

    if (!profile.supportedDpis.includes(dpi)) {
        issues.push({
            severity: "error",
            code: "MODEL_DPI_UNSUPPORTED",
            message: `${profile.label} does not support a ${dpi} dpi printhead.`,
        });
    }

    const printableWidthMm = maxPrintWidthMm(model, dpi);
    if (
        typeof printableWidthMm === "number" &&
        settings.widthMm > printableWidthMm + GEOMETRY_EPSILON_MM
    ) {
        issues.push({
            severity: "error",
            code: "LABEL_EXCEEDS_PRINTABLE_WIDTH",
            message:
                `Label width ${formatMm(settings.widthMm)} mm exceeds the ` +
                `${formatMm(printableWidthMm)} mm printable width of ${profile.label} at ${dpi} dpi.`,
        });
    }

    const oneDotMm = 1 / dotsPerMm(dpi);
    const copyIndex = options.copyIndex;
    const serial = settings.serial;
    const sn = copyIndex === undefined || !serial.enabled
        ? ""
        : formatSerial(
              serial.start + copyIndex * serial.step,
              serial.pad,
              serial.prefix,
          );
    const vars = copyIndex === undefined ? undefined : variablesForCopy(doc, copyIndex);
    const printerRfidReadField = configuredRfidReadField(doc);
    const printerRfidReadIsResolved = printerRfidReadField
        ? varsHaveRfidReadValue(vars, printerRfidReadField)
        : false;
    const declaredNames = declaredVariableNames(doc);
    const symbolData = (element: Extract<
        typeof doc.elements[number],
        { kind: "barcode" | "qr" | "datamatrix" }
    >) =>
        copyIndex === undefined
            ? element.data
            : resolveDynamicValue(element.data, element.fieldName, sn, vars);

    for (const element of doc.elements) {
        const x0 = Math.min(element.pos.x, element.pos.x + element.size.w);
        if (element.kind === "text") {
            const content = textContentFrame(element, dpi);
            const usable = logicalSize(content, element.rotation);
            if (!content.w || !content.h) {
                issues.push({ severity: "error", code: "TEXT_MARGIN_NO_SPACE", elementId: element.id,
                    message: "Text margin leaves no printable area. Enlarge the text frame or reduce its margin." });
            } else if (content.inset && element.fitMode !== "shrink" && element.fontSizeMm &&
                mmToDots(element.fontSizeMm, dpi) > usable.h) {
                issues.push({ severity: "warning", code: "TEXT_MARGIN_FONT_HEIGHT", elementId: element.id,
                    message: `The height inside the text margin is ${formatMm(dotsToMm(usable.h, dpi))} mm for a ${formatMm(element.fontSizeMm)} mm font. Enlarge the frame, reduce the margin or choose a smaller font.` });
            }
        }
        if (element.kind === "text" && rfidTextLastChars(element, settings.rfid) && !printerRfidReadIsResolved) {
            issues.push({
                severity: "warning",
                code: "RFID_FIELD_CONCAT_REQUIRES_LINK_OS_68",
                elementId: element.id,
                message: "RFID last-N text requires Link-OS 6.8 Release 2 or newer. " +
                    "For ZD621R, Link-OS 7.0 or newer is recommended for the RFID field fix.",
            });
        }
        const y0 = Math.min(element.pos.y, element.pos.y + element.size.h);
        const x1 = Math.max(element.pos.x, element.pos.x + element.size.w);
        const y1 = Math.max(element.pos.y, element.pos.y + element.size.h);
        if (
            x0 < -GEOMETRY_EPSILON_MM ||
            y0 < -GEOMETRY_EPSILON_MM ||
            x1 > settings.widthMm + GEOMETRY_EPSILON_MM ||
            y1 > settings.heightMm + GEOMETRY_EPSILON_MM
        ) {
            const intersectsLabel =
                x1 > GEOMETRY_EPSILON_MM
                && y1 > GEOMETRY_EPSILON_MM
                && x0 < settings.widthMm - GEOMETRY_EPSILON_MM
                && y0 < settings.heightMm - GEOMETRY_EPSILON_MM;
            const machineReadableSymbol =
                element.kind === "barcode" ||
                element.kind === "qr" ||
                element.kind === "datamatrix";
            issues.push({
                // Barcode/QR overlap is advisory so operators can calibrate
                // real tags. Entirely off-label elements still produce no output.
                severity: intersectsLabel && element.kind !== "datamatrix" ? "warning" : "error",
                code: "ELEMENT_OUTSIDE_LABEL",
                elementId: element.id,
                message: intersectsLabel && machineReadableSymbol
                    ? `The ${element.kind === "barcode" ? "barcode" : element.kind === "qr" ? "QR" : "Data Matrix"} frame extends outside the label. ` +
                        (element.kind === "datamatrix"
                            ? "Printing is blocked because clipping modules or the quiet zone makes the symbol unreliable."
                            : "Printing is allowed for calibration; bars, modules or the quiet zone may be clipped. Adjust position/size and scan a test label.")
                    : intersectsLabel
                    ? `Element frame extends outside the ${formatMm(settings.widthMm)} × ` +
                        `${formatMm(settings.heightMm)} mm label; printing is allowed for calibration, ` +
                        "but printed content may be clipped."
                    : `Element is fully outside the ${formatMm(settings.widthMm)} × ` +
                        `${formatMm(settings.heightMm)} mm label and would not produce visible label content.`,
            });
        }

        const isPrintableStroke =
            element.kind === "line" || (element.kind === "rect" && !element.filled);
        if (
            isPrintableStroke &&
            Number.isFinite(element.thickness) &&
            element.thickness < oneDotMm - GEOMETRY_EPSILON_MM
        ) {
            issues.push({
                severity: "warning",
                code: "STROKE_BELOW_ONE_DOT",
                elementId: element.id,
                message:
                    `Stroke ${formatMm(element.thickness)} mm is thinner than one ${dpi} dpi ` +
                    `printer dot (${formatMm(oneDotMm)} mm) and will be rounded to one dot.`,
            });
        }

        const symbolElement: SymbolElement | null =
            element.kind === "barcode" || element.kind === "qr" || element.kind === "datamatrix"
                ? element
                : null;
        const usesPrinterRfidRead = !!(
            symbolElement
            && printerRfidReadField
            && !printerRfidReadIsResolved
            && elementUsesPrinterRfidRead(symbolElement, printerRfidReadField)
        );
        const printerRfidData = usesPrinterRfidRead && symbolElement && printerRfidReadField
            ? printerRfidSymbolData(
                  symbolElement,
                  printerRfidReadField,
                  settings.rfid,
                  sn,
                  vars,
              )
            : null;

        if (printerRfidData && (element.kind === "barcode" || element.kind === "qr")) {
            issues.push({
                severity: "warning",
                code: "RFID_SYMBOL_SIZE_ESTIMATED",
                elementId: element.id,
                message:
                    `The printer reads {${printerRfidReadField}} from the tag during printing. ` +
                    "Barcode/QR sizing uses an estimated HEX value based on the configured RFID read length; " +
                    "the actual symbol can differ. Printing is allowed: test a few tags, then adjust " +
                    "manual dots/module or QR magnification and verify with your scanner.",
            });
        }

        if (
            symbolElement &&
            printerRfidReadField &&
            printerRfidData &&
            printerRfidFieldNeedsConcatenation(
                symbolElement,
                printerRfidData.raw,
                printerRfidReadField,
            )
        ) {
            issues.push({
                severity: "warning",
                code: "RFID_FIELD_CONCAT_REQUIRES_LINK_OS_68",
                elementId: element.id,
                message:
                    "This printer-resolved RFID field uses Zebra ^FE concatenation. " +
                    "Verify Link-OS 6.8 or newer on the target printer; older firmware must resolve the value on the host.",
            });
        }

        if (
            element.kind === "barcode" ||
            element.kind === "qr" ||
            element.kind === "datamatrix"
        ) {
            const placeholderIssue = symbolPlaceholderIssue(
                element,
                symbolData(element),
                declaredNames,
                copyIndex,
                printerRfidReadField,
            );
            if (placeholderIssue) {
                issues.push(placeholderIssue);
                // Never pass an unresolved token into a symbology encoder:
                // Code 128, QR and Data Matrix can all encode "{foo}" as
                // literal data, hiding the missing binding until production.
                continue;
            }
        }

        if (element.kind === "barcode") {
            const data = printerRfidData?.sizingData ?? symbolData(element);
            if (usesPrinterRfidRead && element.symbology === "EAN13") {
                issues.push({
                    severity: "error",
                    code: "BARCODE_RFID_EAN13_UNSUPPORTED",
                    elementId: element.id,
                    message:
                        "EAN-13 cannot encode a printer-resolved RFID EPC/TID value. " +
                        "Use Code 128, QR, or Data Matrix instead.",
                });
                continue;
            }
            if (printerRfidData && printerRfidReadField) {
                const nativeError = printerRfidNativeDataError(
                    element,
                    printerRfidData.raw,
                    printerRfidData.sizingData,
                    printerRfidReadField,
                );
                if (nativeError) {
                    issues.push({
                        severity: "error",
                        code: "BARCODE_RFID_NATIVE_UNSUPPORTED",
                        elementId: element.id,
                        message: nativeError,
                    });
                    continue;
                }
            }
            const deferDynamicSizing = copyIndex === undefined && (
                (!printerRfidData && !!element.fieldName) || DYNAMIC_FIELD_RE.test(data)
            );
            const rendered = renderBarcode(data, element.symbology);
            if (!rendered) {
                issues.push(deferDynamicSizing
                    ? {
                          severity: "info",
                          code: "DYNAMIC_SYMBOL_CHECK_DEFERRED",
                          elementId: element.id,
                          message: "Barcode content and width will be validated after resolving each data row.",
                      }
                    : {
                          severity: "error",
                          code: "BARCODE_INVALID_DATA",
                          elementId: element.id,
                          message: element.symbology === "EAN13"
                              ? "EAN-13 requires 12 data digits or 13 digits with a valid checksum."
                              : "Code 128 requires non-empty printable ASCII data (U+0020–U+007E).",
                      });
            }
            if (rendered && rendered.totalModules > 0) {
                // Match the render/ZPL sizing path exactly. In automatic mode
                // a long payload in a narrow physical frame can force the
                // computed X-dimension below the scan-safe dot count even when
                // the template never stored an explicit narrowDots value.
                const manual = element.sizeMode === "manual" ||
                    (element.sizeMode === undefined && typeof element.narrowDots === "number");
                const minModuleMm = element.minModuleMm ?? 0.25;
                const quarterTurn = element.rotation === 90 || element.rotation === 270;
                const logicalWidthMm = quarterTurn ? element.size.h : element.size.w;
                const logicalHeightMm = quarterTurn ? element.size.w : element.size.h;
                const layout = barcodeModuleLayout({
                    containerDots: Math.max(1, mmToDots(logicalWidthMm, dpi)),
                    totalModules: rendered.totalModules,
                    quietZoneLeftModules: rendered.quietZoneLeftModules,
                    quietZoneRightModules: rendered.quietZoneRightModules,
                    dpi,
                    minModuleMm,
                    align: element.align ?? "center",
                    mode: manual ? "fixed" : "auto",
                    requestedDotsPerModule: manual
                        ? (element.narrowDots ?? scanSafeBarcodeNarrowDots(dpi))
                        : undefined,
                });

                if (deferDynamicSizing) {
                    issues.push({
                        severity: "info",
                        code: "DYNAMIC_SYMBOL_CHECK_DEFERRED",
                        elementId: element.id,
                        message: "Barcode width will be validated again for every resolved data row before printing.",
                    });
                }
                if (!deferDynamicSizing && !layout.fitsFrame) {
                    issues.push({
                        severity: "warning",
                        code: "BARCODE_DOES_NOT_FIT",
                        elementId: element.id,
                        message:
                            `${manual ? "Manual" : "Automatic"} barcode needs ` +
                            `${formatMm(layout.printedWidthMm)} mm at ${layout.dotsPerModule} ` +
                            `dots/module, but its frame provides ${formatMm(logicalWidthMm)} mm ` +
                            `along the barcode axis.`,
                    });
                }
                if (!deferDynamicSizing && layout.xDimensionMm + GEOMETRY_EPSILON_MM < minModuleMm) {
                    const mode = manual ? "Manual" : "Automatic";
                    issues.push({
                        severity: "warning",
                        code: "BARCODE_NARROW_DOTS_UNSAFE",
                        elementId: element.id,
                        message:
                            `${mode} barcode sizing produces ${layout.dotsPerModule} dots/module ` +
                            `(${formatMm(layout.xDimensionMm)} mm), below the configured ` +
                            `${formatMm(minModuleMm)} mm minimum. The encoded symbol needs about ` +
                            `${formatMm(layout.requiredSafeWidthMm)} mm at that minimum, ` +
                            `but this frame provides ${formatMm(logicalWidthMm)} mm along the barcode axis.`,
                    });
                }
                const heightLayout = barcodeHeightLayout({
                    frameHeightDots: Math.max(1, mmToDots(logicalHeightMm, dpi)),
                    dpi,
                    humanReadable: element.humanReadable,
                    barHeightMm: element.barHeightMm,
                    textSizeMm: element.textSizeMm,
                    textPaddingMm: element.textPaddingMm,
                    textPosition: element.textPosition,
                });
                if (!heightLayout.fitsFrame) {
                    issues.push({
                        severity: "warning",
                        code: "BARCODE_HEIGHT_DOES_NOT_FIT",
                        elementId: element.id,
                        message:
                            `Barcode bars and human-readable text require ` +
                            `${formatMm(heightLayout.barHeightMm + dotsToMm(
                                heightLayout.textHeightDots + heightLayout.textPaddingDots,
                                dpi,
                            ))} mm, but the frame provides ${formatMm(logicalHeightMm)} mm ` +
                            `across the barcode axis.`,
                    });
                }
            }
        }

        if (element.kind === "qr") {
            const data = printerRfidData?.sizingData ?? symbolData(element);
            const deferDynamicSizing = copyIndex === undefined && (
                (!printerRfidData && !!element.fieldName) || DYNAMIC_FIELD_RE.test(data)
            );
            if (!data) {
                issues.push({
                    severity: "error",
                    code: "QR_EMPTY_DATA",
                    elementId: element.id,
                    message: "QR data is empty after resolving template variables.",
                });
                continue;
            }
            if (
                usesPrinterRfidRead &&
                ((element.rotation ?? 0) !== 0 || qrMinVersion(element.version) !== undefined)
            ) {
                issues.push({
                    severity: "error",
                    code: "QR_RFID_NATIVE_UNSUPPORTED",
                    elementId: element.id,
                    message:
                        "Printer-resolved RFID QR fields require 0-degree rotation and Version Auto. " +
                        "Resolve the RFID value before printing to use exact bitmap output.",
                });
                continue;
            }
            if (printerRfidData && printerRfidReadField) {
                const nativeError = printerRfidNativeDataError(
                    element,
                    printerRfidData.raw,
                    printerRfidData.sizingData,
                    printerRfidReadField,
                );
                if (nativeError) {
                    issues.push({
                        severity: "error",
                        code: "QR_RFID_NATIVE_UNSUPPORTED",
                        elementId: element.id,
                        message: nativeError,
                    });
                    continue;
                }
            }
            const frameWidthDots = mmToDots(element.size.w, dpi);
            const frameHeightDots = mmToDots(element.size.h, dpi);
            let matrixModules: number;
            try {
                matrixModules = qrModuleCount(data, element.ecc, qrMinVersion(element.version));
            } catch (error) {
                issues.push(deferDynamicSizing
                    ? {
                          severity: "info",
                          code: "DYNAMIC_SYMBOL_CHECK_DEFERRED",
                          elementId: element.id,
                          message: "QR content, capacity and module size will be validated after resolving each data row.",
                      }
                    : {
                          severity: "error",
                          code: "QR_INVALID_DATA",
                          elementId: element.id,
                          message: error instanceof Error ? error.message : "QR data cannot be encoded.",
                      });
                continue;
            }
            // Bitmap/GFA and native ^BQN now share one whole-dot module and
            // quiet-zone contract; check the complete outer scan area.
            const layout = fitQrToFrameDots(
                frameWidthDots,
                frameHeightDots,
                matrixModules,
                {
                    quietZoneModules: element.quietZoneModules,
                    requestedMagnification: element.sizeMode === "manual" ||
                        (element.sizeMode === undefined && typeof element.magnification === "number")
                        ? element.magnification
                        : undefined,
                    dpi,
                    minModuleMm: element.minModuleMm,
                    align: element.align,
                    verticalAlign: element.verticalAlign,
                },
            );
            if (usesPrinterRfidRead && layout.moduleDots > 10) {
                issues.push({
                    severity: "error",
                    code: "QR_RFID_NATIVE_UNSUPPORTED",
                    elementId: element.id,
                    message:
                        `Printer-resolved RFID QR requires ${layout.moduleDots} dots/module to match ` +
                        "the frame, above the conservative native ^BQ compatibility limit of 10. " +
                        "Reduce the frame or use resolved data so bitmap output can preserve size.",
                });
            }
            if (deferDynamicSizing) {
                issues.push({
                    severity: "info",
                    code: "DYNAMIC_SYMBOL_CHECK_DEFERRED",
                    elementId: element.id,
                    message: "QR capacity and module size will be validated again for every resolved data row before printing.",
                });
            }
            if (!deferDynamicSizing && !layout.fitsFrame) {
                const frameSideDots = Math.max(
                    0,
                    Math.min(frameWidthDots, frameHeightDots),
                );
                issues.push({
                    severity: "warning",
                    code: "QR_TOO_SMALL_FOR_MODULE_MATRIX",
                    elementId: element.id,
                    message:
                        `QR frame provides ${frameSideDots} printer dots per side, ` +
                        `but its ${matrixModules} × ${matrixModules} matrix plus ` +
                        `${layout.quietZoneModules}-module quiet zone requires ` +
                        `${layout.outerSideDots} dots per side at ${dpi} dpi.`,
                });
            }
            if (!deferDynamicSizing && layout.moduleSizeMm + GEOMETRY_EPSILON_MM < layout.minModuleMm) {
                issues.push({
                    severity: "warning",
                    code: "QR_MODULE_SIZE_UNSAFE",
                    elementId: element.id,
                    message:
                        `QR uses ${layout.moduleDots} dots/module ` +
                        `(${formatMm(layout.moduleSizeMm)} mm), below the configured ` +
                        `${formatMm(layout.minModuleMm)} mm scanner minimum.`,
                });
            }
        }

        if (element.kind === "datamatrix") {
            const data = printerRfidData?.sizingData ?? symbolData(element);
            const deferDynamicSizing = copyIndex === undefined && (
                (!printerRfidData && !!element.fieldName) || DYNAMIC_FIELD_RE.test(data)
            );
            if (
                usesPrinterRfidRead &&
                (
                    (element.contentFormat ?? "standard") !== "standard" ||
                    (element.shape ?? "square") !== "square" ||
                    (element.textEncoding ?? "utf8") !== "utf8"
                )
            ) {
                issues.push({
                    severity: "error",
                    code: "DATAMATRIX_RFID_NATIVE_UNSUPPORTED",
                    elementId: element.id,
                    message:
                        "Printer-resolved RFID data in Data Matrix requires a square Standard ECC 200 symbol and UTF-8. " +
                        "Other shapes or formats require resolved data before rasterization.",
                });
                continue;
            }
            if (printerRfidData && printerRfidReadField) {
                const nativeError = printerRfidNativeDataError(
                    element,
                    printerRfidData.raw,
                    printerRfidData.sizingData,
                    printerRfidReadField,
                );
                if (nativeError) {
                    issues.push({
                        severity: "error",
                        code: "DATAMATRIX_RFID_NATIVE_UNSUPPORTED",
                        elementId: element.id,
                        message: nativeError,
                    });
                    continue;
                }
            }
            if (!data) {
                issues.push({
                    severity: "error",
                    code: "DATAMATRIX_EMPTY_DATA",
                    elementId: element.id,
                    message: "Data Matrix data is empty after resolving template variables.",
                });
                continue;
            }
            let matrix;
            try {
                matrix = encodeDataMatrix(data, {
                    contentFormat: element.contentFormat,
                    shape: element.shape,
                    textEncoding: element.textEncoding,
                    symbolRows: element.symbolRows,
                    symbolColumns: element.symbolColumns,
                });
            } catch (error) {
                if (deferDynamicSizing) {
                    issues.push({
                        severity: "info",
                        code: "DYNAMIC_SYMBOL_CHECK_DEFERRED",
                        elementId: element.id,
                        message: "Data Matrix content and capacity will be validated for every resolved data row before printing.",
                    });
                } else {
                    issues.push({
                        severity: "error",
                        code: "DATAMATRIX_INVALID_DATA",
                        elementId: element.id,
                        message: error instanceof Error
                            ? error.message
                            : "Data Matrix data cannot be encoded.",
                    });
                }
                continue;
            }
            const quarterTurn = element.rotation === 90 || element.rotation === 270;
            const layout = fitDataMatrixToFrameDots(
                Math.max(1, mmToDots(quarterTurn ? element.size.h : element.size.w, dpi)),
                Math.max(1, mmToDots(quarterTurn ? element.size.w : element.size.h, dpi)),
                matrix.columns,
                matrix.rows,
                {
                    quietZoneModules: element.quietZoneModules,
                    requestedMagnification: element.sizeMode === "manual" ||
                        (element.sizeMode === undefined && typeof element.magnification === "number")
                        ? element.magnification
                        : undefined,
                    dpi,
                    minModuleMm: element.minModuleMm,
                    align: element.align,
                    verticalAlign: element.verticalAlign,
                },
            );
            if (deferDynamicSizing) {
                issues.push({
                    severity: "info",
                    code: "DYNAMIC_SYMBOL_CHECK_DEFERRED",
                    elementId: element.id,
                    message: "Data Matrix capacity and module size will be validated again for every resolved data row before printing.",
                });
            }
            if (!deferDynamicSizing && !layout.fitsFrame) {
                issues.push({
                    severity: "error",
                    code: "DATAMATRIX_DOES_NOT_FIT",
                    elementId: element.id,
                    message:
                        `Data Matrix frame is ${layout.frameWidthDots} × ${layout.frameHeightDots} dots, ` +
                        `but its ${matrix.columns} × ${matrix.rows} matrix plus ` +
                        `${layout.quietZoneModules}-module quiet zone requires ` +
                        `${layout.outerWidthDots} × ${layout.outerHeightDots} dots.`,
                });
            }
            if (
                !deferDynamicSizing &&
                layout.moduleSizeMm + GEOMETRY_EPSILON_MM < layout.minModuleMm
            ) {
                issues.push({
                    severity: "error",
                    code: "DATAMATRIX_MODULE_SIZE_UNSAFE",
                    elementId: element.id,
                    message:
                        `Data Matrix uses ${layout.moduleDots} dots/module ` +
                        `(${formatMm(layout.moduleSizeMm)} mm), below the configured ` +
                        `${formatMm(layout.minModuleMm)} mm scanner minimum.`,
                });
            }
        }

        if (
            element.kind === "text" &&
            (typeof element.fontSizeMm !== "number" || !Number.isFinite(element.fontSizeMm))
        ) {
            issues.push({
                severity: "info",
                code: "LEGACY_TEXT_WITHOUT_PHYSICAL_SIZE",
                elementId: element.id,
                message:
                    "Legacy text has no explicit fontSizeMm; a 203 dpi compatibility size will be converted for this printhead.",
            });
        }
    }

    return issues;
}
