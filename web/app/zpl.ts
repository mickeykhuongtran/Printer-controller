import { buildRfidCaptureZpl } from "./rfid-capture";
import type {
    BarcodeEl,
    DataMatrixEl,
    LabelDoc,
    LabelElement,
    LabelSettings,
    LineEl,
    QrEl,
    RectEl,
    RfidReadBank,
    RfidSettings,
    TableEl,
    TextEl,
} from "./types";
import { zlibSync } from "fflate";
import { dotsToMm, mmToDots } from "./units";
import { logicalSize, rotateElement } from "./rotation";
import { insetTextElement } from "./text-margin";
import { lineStrokeBoundsDots } from "./line-geometry";
import { maxPrintSpeedIps } from "./printer-models";
import type { RasterBitmap } from "./bitmap";
import {
    barcodeHeightLayout,
    barcodeModuleLayout,
    normalizeEan13,
    renderBarcode,
    scanSafeBarcodeNarrowDots,
} from "./barcode";
import {
    formatSerial,
    previewBatch,
    resolveDynamicValue,
    resolveTextValue,
} from "./label-data";
import { rfidTextLastChars } from "./rfid-text";
import {
    padEpcAsciiToBits,
    rfidBitsForData,
    validateRfidHexValue,
    zebraRfidFixedReadByteCount,
    zebraRfidReadHexCharacterCount,
} from "./rfid";
import {
    buildZebraRfidSgdTagReadCommand,
    zebraProgramPosition,
    zebraRfidModelOption,
    zebraRfidSupportsAutoPcBits,
} from "./zebra-rfid";
import {
    getTextFitMode,
    getTextWrapMode,
    textUsesFrame,
    wrapTextToWidth,
} from "./text-flow";
import {
    encodeQrMatrix,
    fitQrToFrameDots,
    nativeQrSizing,
    qrMinVersion,
    qrModuleCount,
    type QrMatrix,
    type NativeQrSizing,
} from "./qr-sizing";
import {
    encodeDataMatrix,
    fitDataMatrixToFrameDots,
    type DataMatrixFrameLayout,
    type DataMatrixMatrix,
} from "./datamatrix";
import {
    normalizeZebraPrinterAlignment,
    type ZebraPrinterAlignment,
} from "./zebra-printer-alignment";
import { buildZebraTearOffDotsCommand } from "./zebra-media";

const READ_BANK_ID: Record<RfidReadBank, string> = { EPC: "1", TID: "2" };
const TEXT_FONT_DOTS: Record<TextEl["font"], { h: number; w: number }> = {
    A: { h: 9, w: 5 },
    B: { h: 12, w: 7 },
    D: { h: 18, w: 10 },
    E: { h: 28, w: 15 },
};

function clampInt(value: number | undefined, min: number, max: number, fallback = min): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}

function hex(bytes: Uint8Array): string {
    let out = "";
    for (let i = 0; i < bytes.length; i += 1) {
        out += bytes[i].toString(16).padStart(2, "0").toUpperCase();
    }
    return out;
}

const BASE64_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64(bytes: Uint8Array): string {
    let out = "";
    let index = 0;
    for (; index + 2 < bytes.length; index += 3) {
        const value =
            (bytes[index] << 16)
            | (bytes[index + 1] << 8)
            | bytes[index + 2];
        out += BASE64_ALPHABET[(value >>> 18) & 0x3f];
        out += BASE64_ALPHABET[(value >>> 12) & 0x3f];
        out += BASE64_ALPHABET[(value >>> 6) & 0x3f];
        out += BASE64_ALPHABET[value & 0x3f];
    }
    if (index < bytes.length) {
        const first = bytes[index];
        const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
        const value = (first << 16) | (second << 8);
        out += BASE64_ALPHABET[(value >>> 18) & 0x3f];
        out += BASE64_ALPHABET[(value >>> 12) & 0x3f];
        out += index + 1 < bytes.length
            ? BASE64_ALPHABET[(value >>> 6) & 0x3f]
            : "=";
        out += "=";
    }
    return out;
}

/**
 * Zebra ZB64 uses CRC-16/CCITT (polynomial 0x1021, initial value 0) over
 * the printable Base64 payload, not over the compressed binary bytes.
 */
function zebraCrc16(value: string): string {
    let crc = 0;
    for (let index = 0; index < value.length; index += 1) {
        crc ^= value.charCodeAt(index) << 8;
        for (let bit = 0; bit < 8; bit += 1) {
            crc = crc & 0x8000
                ? ((crc << 1) ^ 0x1021) & 0xffff
                : (crc << 1) & 0xffff;
        }
    }
    return crc.toString(16).padStart(4, "0").toUpperCase();
}

function z64(bytes: Uint8Array): string {
    const compressed = zlibSync(bytes, { level: 9 });
    const encoded = base64(compressed);
    return `:Z64:${encoded}:${zebraCrc16(encoded)}`;
}

function zplText(value: string): string {
    return value.replace(/\^/g, " ").replace(/~/g, " ").replace(/\r?\n/g, " ");
}

/** Escape only unsafe UTF-8 bytes for a ^FH field, preserving native capacity. */
function zplHexBytes(value: string, indicator = "\\", extraUnsafe = ""): string {
    const bytes = new TextEncoder().encode(value);
    let result = "";
    for (const byte of bytes) {
        if (
            byte >= 0x20 &&
            byte <= 0x7e &&
            byte !== 0x5e &&
            byte !== 0x7e &&
            byte !== indicator.charCodeAt(0) &&
            !extraUnsafe.includes(String.fromCharCode(byte))
        ) {
            result += String.fromCharCode(byte);
        } else {
            result += `${indicator}${byte.toString(16).padStart(2, "0").toUpperCase()}`;
        }
    }
    return result;
}

function zplComment(value: string): string {
    return zplText(value).replace(/\^FS/g, " ");
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rfidReadFieldName(rfid: RfidSettings): string | null {
    if (!rfid.readEnabled) return null;
    const fieldName = (rfid.readFieldName ?? "rfid_read").trim().replace(/^\{|\}$/g, "");
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(fieldName) ? fieldName : null;
}

function rfidReadPlaceholderRegex(fieldName: string): RegExp {
    return new RegExp(`\\{\\s*${escapeRegex(fieldName)}\\s*\\}`, "gi");
}

function textUsesRfidReadField(el: TextEl, fieldName: string): boolean {
    if ((el.fieldName ?? "").trim().toLowerCase() === fieldName.toLowerCase()) return true;
    return rfidReadPlaceholderRegex(fieldName).test(el.text);
}

function elementUsesRfidReadField(el: LabelElement, fieldName: string): boolean {
    const elementFieldName = "fieldName" in el ? el.fieldName : undefined;
    if ((elementFieldName ?? "").trim().toLowerCase() === fieldName.toLowerCase()) return true;
    const regex = rfidReadPlaceholderRegex(fieldName);
    if (el.kind === "text") return regex.test(el.text);
    if (el.kind === "qr" || el.kind === "barcode" || el.kind === "datamatrix") {
        return regex.test(el.data);
    }
    return false;
}

function isOnlyRfidReadField(value: string, fieldName: string): boolean {
    return new RegExp(`^\\s*\\{\\s*${escapeRegex(fieldName)}\\s*\\}\\s*$`, "i").test(value);
}

const FIELD_CONCAT_DELIMITERS = "#|@!%&;:?+*/-.$()[]{}";

function fieldConcatDelimiter(value: string): string {
    for (const candidate of FIELD_CONCAT_DELIMITERS) {
        if (!value.includes(candidate)) return candidate;
    }
    throw new Error(
        "Printer-resolved RFID field contains every supported ^FE delimiter. " +
        "Resolve the value on the host before printing.",
    );
}

function zplStaticFieldData(value: string, delimiter: string): string {
    return zplHexBytes(value, "\\", delimiter);
}

/**
 * Encode a literal Code 128 value for Zebra's ^BC parser. Zebra reserves `>`
 * for invocation codes, while `^` and `~` are also ZPL command prefixes.
 * These documented invocations reproduce the literal Code Set B characters.
 */
function code128FieldData(value: string): string {
    let out = "";
    let plain = "";
    const flush = () => {
        if (!plain) return;
        out += zplHexBytes(plain);
        plain = "";
    };
    for (const character of value) {
        if (character === "^" || character === ">" || character === "~") {
            flush();
            out += character === "^" ? "><" : character === ">" ? ">0" : ">=";
        } else {
            plain += character;
        }
    }
    flush();
    return out;
}

function zplFieldDataWithReadField(
    value: string,
    fieldName: string,
    fieldNumber: number,
    delimiter: string,
    lastChars?: number,
): string {
    // Extract one character at a time, from the Nth-last through the last.
    // ZT610R / Link-OS 7.6.2 was reported to print only the last character
    // with b,1,N, despite Zebra's backward-range example. Length 1 avoids
    // that range ambiguity and works with either interpretation of b.
    // Reuse the full read field so other Text and symbols keep the full EPC.
    const token = lastChars
        ? Array.from({ length: lastChars }, (_, index) =>
            `${delimiter}${fieldNumber},b,${lastChars - index},1${delimiter}`).join("")
        : `${delimiter}${fieldNumber}${delimiter}`;
    const regex = rfidReadPlaceholderRegex(fieldName);
    let out = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
        out += zplStaticFieldData(value.slice(lastIndex, match.index), delimiter);
        out += token;
        lastIndex = match.index + match[0].length;
    }
    out += zplStaticFieldData(value.slice(lastIndex), delimiter);
    return out || token;
}

function dataMatrixFieldDataWithReadField(
    value: string,
    fieldName: string,
    fieldNumber: number,
    delimiter: string,
): string {
    const token = `${delimiter}${fieldNumber}${delimiter}`;
    const regex = rfidReadPlaceholderRegex(fieldName);
    let out = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
        // ^BX uses underscore as its FNC/control escape character. Preserve a
        // literal underscore by doubling it before ^FH byte escaping.
        out += zplHexBytes(
            value.slice(lastIndex, match.index).replace(/_/g, "__"),
            "\\",
            delimiter,
        );
        out += token;
        lastIndex = match.index + match[0].length;
    }
    out += zplHexBytes(value.slice(lastIndex).replace(/_/g, "__"), "\\", delimiter);
    return out || token;
}

function code128FieldDataWithReadField(
    value: string,
    fieldName: string,
    fieldNumber: number,
    delimiter: string,
): string {
    const token = `${delimiter}${fieldNumber}${delimiter}`;
    const regex = rfidReadPlaceholderRegex(fieldName);
    let out = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
        out += code128FieldData(value.slice(lastIndex, match.index));
        out += token;
        lastIndex = match.index + match[0].length;
    }
    out += code128FieldData(value.slice(lastIndex));
    return out || token;
}

function qrPayloadWithReadField(
    value: string,
    fieldName: string,
    fieldNumber: number,
    ecc: QrEl["ecc"],
    delimiter: string,
): string {
    // ^BQ requires its mode prefix (for example "MA,") to live inside ^FD.
    // Use ^FE field concatenation for the RFID value instead of placing ^FN
    // inside ^FD. ^FE is supported by the ZT610 and keeps one RFID read field
    // reusable by text, Code 128, and QR in the same active format.
    const token = `${delimiter}${fieldNumber}${delimiter}`;
    const regex = rfidReadPlaceholderRegex(fieldName);
    let out = "";
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) {
        out += zplStaticFieldData(value.slice(lastIndex, match.index), delimiter);
        out += token;
        lastIndex = match.index + match[0].length;
    }
    out += zplStaticFieldData(value.slice(lastIndex), delimiter);
    return `${ecc}A,${out || token}`;
}

function varsWithoutField(
    vars: Record<string, string> | undefined,
    fieldName: string,
): Record<string, string> | undefined {
    if (!vars) return undefined;
    const filtered: Record<string, string> = {};
    const fieldKey = fieldName.toLowerCase();
    let changed = false;
    for (const [key, value] of Object.entries(vars)) {
        if (key.toLowerCase() === fieldKey) {
            changed = true;
            continue;
        }
        filtered[key] = value;
    }
    return changed ? filtered : vars;
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

function rfidReadSample(rfid: RfidSettings, symbology?: BarcodeEl["symbology"]): string {
    const hexChars = zebraRfidReadHexCharacterCount(rfid);
    return symbology === "EAN13"
        ? "0".repeat(Math.min(13, hexChars))
        : "F".repeat(hexChars);
}

function rfidReadElementData(
    value: string,
    fieldNameForElement: string | undefined,
    readFieldName: string,
    sn: string,
    vars: Record<string, string> | undefined,
): string {
    const fieldMatches = (fieldNameForElement ?? "").trim().toLowerCase() === readFieldName.toLowerCase();
    const textContainsRead = rfidReadPlaceholderRegex(readFieldName).test(value);
    if (fieldMatches && !textContainsRead) return `{${readFieldName}}`;
    return resolveDynamicValue(
        value,
        textContainsRead ? undefined : fieldNameForElement,
        sn,
        varsWithoutField(vars, readFieldName),
    );
}

function zplRotation(rotation: number): "N" | "R" | "I" | "B" {
    if (rotation === 90) return "R";
    if (rotation === 180) return "I";
    if (rotation === 270) return "B";
    return "N";
}

function finiteSetting(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function setupLines(
    settings: LabelSettings,
    options: {
        marginXMm?: number;
        marginYMm?: number;
        alignment?: ZebraPrinterAlignment;
        tearOffOverrideDots?: number;
    } = {},
): string[] {
    const dpi = settings.dpi ?? 203;
    const marginXMm = options.marginXMm ?? 0;
    const marginYMm = options.marginYMm ?? 0;
    const widthDots = mmToDots(settings.widthMm + Math.max(0, marginXMm), dpi);
    const heightDots = mmToDots(settings.heightMm + Math.max(0, marginYMm), dpi);
    const targetModel = settings.targetPrinterModel ?? settings.rfid.zebraModel;
    const maxSpeed = maxPrintSpeedIps(targetModel, dpi) ?? 14;
    const lines = [
        "^XA",
        // Prevent firmware replay of a partial RFID label after head/media/
        // ribbon service. This printer mode lasts until another ^JZ or poweroff;
        // send it for every RFID format and never persist it with ^JUS.
        ...(settings.rfid.enabled || settings.rfid.readEnabled ? ["^JZN"] : []),
        "^CI28",
        `^PW${Math.max(1, widthDots)}`,
        `^LL${Math.max(1, heightDots)}`,
        "^MMT",
        `~SD${String(clampInt(settings.darkness, 0, 30, 10)).padStart(2, "0")}`,
        `^PR${clampInt(settings.speed, 1, maxSpeed, Math.min(4, maxSpeed))}`,
    ];
    if (options.tearOffOverrideDots !== undefined) {
        lines.splice(2, 0, buildZebraTearOffDotsCommand(options.tearOffOverrideDots));
    }
    if (options.alignment) {
        // Local printer profiles are emitted explicitly, including zero, so a
        // job cannot inherit stale ^LT/^LS values left by another application.
        const alignment = normalizeZebraPrinterAlignment(options.alignment);
        lines.push(`^LT${alignment.labelTopDots}`);
        lines.push(`^LS${alignment.leftPositionDots}`);
    } else {
        // API/listener jobs that have no local printer profile retain the
        // printer's configured alignment unless the document explicitly
        // contains a legacy offset.
        const labelTop = clampInt(settings.startOffsetDots, -120, 120, 0);
        const labelShift = clampInt(settings.rowOffsetDots, -9999, 9999, 0);
        if (labelTop !== 0) lines.push(`^LT${labelTop}`);
        if (labelShift !== 0) lines.push(`^LS${labelShift}`);
    }
    lines.push(
        "^LH0,0",
        settings.printMode === "direct_thermal" ? "^MTD" : "^MTT",
    );
    lines.push(...buildZebraRfidSetupLines(settings.rfid));
    return lines;
}

function finishLines(copies: number): string[] {
    return [`^PQ${Math.max(1, Math.floor(copies))}`, "^XZ"];
}

function rfidPayload(rfid: RfidSettings, data: string): { format: "A" | "H"; payload: string; bytes: number } {
    const format = rfid.format === "A" ? "A" : "H";
    const bits = rfidBitsForData(rfid, data);
    let payload: string;
    if (format === "H") {
        const validation = validateRfidHexValue(
            data,
            rfid.autoEpcBitsFromData ? undefined : bits,
        );
        if (!validation.valid) {
            throw new Error(
                `RFID write blocked: ${validation.reason ?? "invalid EPC data"}. ` +
                "The EPC was not truncated or sent to the printer.",
            );
        }
        payload = validation.normalized;
    } else {
        payload = padEpcAsciiToBits(data, bits);
    }
    const bytes = format === "H"
        ? Math.max(1, Math.ceil(payload.length / 2))
        : Math.max(1, payload.length);
    return { format, payload, bytes };
}

export function buildZebraRfidSetupLines(
    rfid: RfidSettings,
): string[] {
    if (!rfid.enabled && !rfid.readEnabled) return [];

    const lines: string[] = [];
    // Attempts/error handling are ^RS format policy, not persistent SGD
    // settings, so they are emitted even when the tuning remains printer
    // managed. A blank position preserves the calibrated printer position.
    const overridePrinterTuning = rfid.zebraUsePrinterSettings === false;
    const programmingPosition = overridePrinterTuning
        ? zebraProgramPosition(rfid) ?? ""
        : "";
    // Read-and-print quantities count physical attempts, including VOID. Zebra
    // ^RS n retries the entire format on another label, while P/E retains it
    // in the queue. Override legacy templates so a bad inlay consumes one
    // attempt and the next queued format continues without operator Resume.
    const continuousCapture = rfid.readEnabled || (rfid.enabled && rfid.captureToHost);
    const attempts = continuousCapture ? 1 : clampInt(rfid.retries, 1, 10, 1);
    const errorHandling = !continuousCapture && (rfid.zebraErrorHandling === "P" || rfid.zebraErrorHandling === "E")
        ? rfid.zebraErrorHandling
        : "N";
    lines.push(`^RS8,${programmingPosition},,${attempts},${errorHandling}`);
    if (!overridePrinterTuning) return lines;

    const legacyPower = finiteSetting(rfid.power, -1);
    const readPower = finiteSetting(rfid.zebraReadPower, legacyPower);
    const writePower = finiteSetting(rfid.zebraWritePower, legacyPower);
    const profile = zebraRfidModelOption(rfid.zebraModel);
    const configuredAntenna = (rfid.zebraAntenna ?? "").toUpperCase();
    const antenna = (profile.multiAntenna || rfid.zebraModel === "auto") &&
        /^[A-E][1-4]$/.test(configuredAntenna)
        ? configuredAntenna
        : "";
    const rwParams = [
        readPower >= 0 ? String(clampInt(readPower, 0, 30, 16)) : "",
        writePower >= 0 ? String(clampInt(writePower, 0, 30, 16)) : "",
        antenna,
    ];
    while (rwParams.length > 0 && rwParams[rwParams.length - 1] === "") rwParams.pop();
    if (rwParams.length > 0) lines.push(`^RW${rwParams.join(",")}`);

    return lines;
}

export function buildZebraRfidWriteCommand(
    rfid: RfidSettings,
    data: string,
    targetModel: RfidSettings["zebraModel"] = rfid.zebraModel,
): string {
    if (!rfid.enabled || !data.trim()) return "";
    const { format, payload, bytes } = rfidPayload(rfid, data);
    if (zebraRfidSupportsAutoPcBits(targetModel)) {
        // Zebra ZT400/ZT600 memory bank A starts at EPC word 2 and updates
        // the Gen2 PC length bits to match ^FD. This is essential when EPC
        // lengths vary; writing bank 1 alone leaves a stale PC word and can
        // produce 02000423 / GEN2 MEMORY BAD PC.
        return `^RFW,${format},,,A^FD${zplText(payload)}^FS`;
    }
    const startBlock = Math.max(0, Math.floor(finiteSetting(rfid.block, 2)));
    return `^RFW,${format},${startBlock},${bytes},1^FD${zplText(payload)}^FS`;
}

export function buildZebraRfidReadCommand(rfid: RfidSettings, fieldNumber = 1): string {
    if (!rfid.readEnabled) return "";
    const bank = rfid.readBank ?? "EPC";
    if (bank === "EPC" && (rfid.zebraEpcReadMode ?? "pc") === "pc") {
        return `^RFR,H,,,E^FN${fieldNumber}^FS`;
    }
    const defaultStartBlock = bank === "TID" ? 0 : 2;
    const startBlock = Math.max(0, Math.floor(finiteSetting(rfid.readStartBlock, defaultStartBlock)));
    // ^RF expects bytes. Current templates store that value explicitly;
    // legacy readLength-only templates are converted by the shared helper.
    const byteCount = zebraRfidFixedReadByteCount(rfid);
    return `^RFR,H,${startBlock},${byteCount},${READ_BANK_ID[bank]}^FN${fieldNumber}^FS`;
}

/** Read back exactly the bytes written, independently of printed read fields.
 * A template can print TID or a shortened EPC while its write evidence must
 * still verify the complete intended write range. FN2 is reserved for this. */
function buildRfidWriteVerification(settings: LabelSettings, data: string, capture: { jobId: string; ordinal: number }): string[] {
    if (!data.trim()) throw new Error("RFID write capture requires non-empty EPC data for every label.");
    const { format, payload, bytes } = rfidPayload(settings.rfid, data);
    if (format === "A" && (/[^\x20-\x7E]|[\^~]/.test(data) || data.length > bytes)) {
        throw new Error("RFID ASCII write verification requires printable ASCII without ^/~ and must fit the configured length; use hexadecimal for other bytes.");
    }
    const expectedHex = format === "H" ? payload : Array.from(payload, c => c.charCodeAt(0).toString(16).padStart(2, "0")).join("").toUpperCase();
    const model = settings.targetPrinterModel ?? settings.rfid.zebraModel;
    const startBlock = zebraRfidSupportsAutoPcBits(model) ? 2 : Math.max(0, Math.floor(finiteSetting(settings.rfid.block, 2)));
    return [
        `^RFR,H,${startBlock},${bytes},1^FN2^FS`,
        buildRfidCaptureZpl(capture.jobId, capture.ordinal, { expectedHex, fieldNumber: 2 }),
    ];
}

export function buildZebraRfidHostReadCommand(rfid: RfidSettings): string {
    if (!rfid.readEnabled) return "";
    const hexChars = zebraRfidReadHexCharacterCount(rfid);
    return [
        "^XA",
        "^CI28",
        ...buildZebraRfidSetupLines(rfid),
        buildZebraRfidReadCommand(rfid),
        `^FH^HV1,${Math.min(256, hexChars)},DATA:,_0D_0A,L^FS`,
        "^XZ",
    ].join("\n");
}

export function buildZebraRfidSgdHostReadCommand(rfid: RfidSettings): string {
    if (!rfid.readEnabled) return "";
    return buildZebraRfidSgdTagReadCommand(rfid.readBank ?? "EPC");
}

export function encodeZpl(zpl: string): Uint8Array {
    const normalized = zpl.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const withTrailing = normalized.endsWith("\n") ? normalized : normalized + "\n";
    const crlf = withTrailing.replace(/\n/g, "\r\n");
    return new TextEncoder().encode(crlf);
}

type FullPageZplOptions = {
    capture?: { jobId: string; ordinal: number };
    rfidData?: string;
    elements?: LabelElement[];
    sn?: string;
    vars?: Record<string, string>;
    emitResolvedRfidReadFields?: boolean;
    alignment?: ZebraPrinterAlignment;
    tearOffOverrideDots?: number;
};

function storedGraphicReference(name: string): string {
    const cleaned = name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!cleaned) throw new Error("Stored Zebra graphic name is empty.");
    return `R:${cleaned}.GRF`;
}

/** Downloads a static full-page bitmap once for reuse by small ^PQ windows. */
export function buildFullPageStoredGraphicDownloadZpl(
    fullPage: RasterBitmap,
    name: string,
): string {
    const totalBytes = fullPage.widthBytes * fullPage.heightDots;
    return `~DG${storedGraphicReference(name)},${totalBytes},${fullPage.widthBytes},${z64(fullPage.bytes)}\n`;
}

/** Recalls a previously downloaded full-page bitmap without retransmitting it. */
export function buildFullPageStoredGraphicRecallZpl(
    settings: LabelSettings,
    name: string,
    copies: number,
    options: Pick<FullPageZplOptions, "alignment" | "tearOffOverrideDots"> = {},
): string {
    const dpi = settings.dpi ?? 203;
    const marginXMm = Number.isFinite(settings.paperMarginXMm)
        ? (settings.paperMarginXMm as number)
        : 0;
    const marginYMm = Number.isFinite(settings.paperMarginYMm)
        ? (settings.paperMarginYMm as number)
        : 0;
    const x = Math.max(0, mmToDots(marginXMm, dpi));
    const y = Math.max(0, mmToDots(marginYMm, dpi));
    const lines = setupLines(settings, {
        marginXMm,
        marginYMm,
        alignment: options.alignment,
        tearOffOverrideDots: options.tearOffOverrideDots,
    });
    lines.push(`^FO${x},${y}^XG${storedGraphicReference(name)},1,1^FS`);
    lines.push(...finishLines(copies));
    return `${lines.join("\n")}\n`;
}

export function buildStoredGraphicDeleteZpl(name: string): string {
    return `^XA\n^ID${storedGraphicReference(name)}^FS\n^XZ\n`;
}

export function buildFullPageZpl(
    settings: LabelSettings,
    fullPage: RasterBitmap,
    copies = 1,
    options: FullPageZplOptions = {},
): string {
    if (options.capture && ((!settings.rfid.readEnabled && !settings.rfid.enabled) || copies !== 1 || options.emitResolvedRfidReadFields)) {
        throw new Error("RFID capture requires one printer-read label per format.");
    }
    const dpi = settings.dpi ?? 203;
    const marginXMm = Number.isFinite(settings.paperMarginXMm)
        ? (settings.paperMarginXMm as number)
        : 0;
    const marginYMm = Number.isFinite(settings.paperMarginYMm)
        ? (settings.paperMarginYMm as number)
        : 0;
    const x = Math.max(0, mmToDots(marginXMm, dpi));
    const y = Math.max(0, mmToDots(marginYMm, dpi));
    const totalBytes = fullPage.widthBytes * fullPage.heightDots;
    const lines = setupLines(settings, {
        marginXMm,
        marginYMm,
        alignment: options.alignment,
        tearOffOverrideDots: options.tearOffOverrideDots,
    });
    if (settings.rfid.enabled && options.rfidData) {
        const write = buildZebraRfidWriteCommand(
            settings.rfid,
            options.rfidData,
            settings.targetPrinterModel ?? settings.rfid.zebraModel,
        );
        if (write) lines.push(write);
    }
    lines.push(
        `^FO${x},${y}^GFA,${totalBytes},${totalBytes},${fullPage.widthBytes},${z64(fullPage.bytes)}^FS`,
    );
    if (rfidReadElementsNeedStoredFormat(options.elements, settings.rfid, options.vars)) {
        const formatName = "R:RFIDQR.ZPL";
        const dynamicFields = emitStoredRfidReadDynamicFields(
            options.elements ?? [],
            settings.rfid,
            options.sn ?? "",
            options.vars,
            dpi,
        );
        lines.push(...dynamicFields.formatLines);

        const storedFormat = [
            ...lines.slice(0, 1),
            `^DF${formatName}^FS`,
            ...lines.slice(1),
            "^XZ",
        ];
        const recallLines = [
            "^XA",
            `^XF${formatName}^FS`,
        ];
        const read = buildZebraRfidReadCommand(settings.rfid);
        if (read) recallLines.push(read);
        recallLines.push(...dynamicFields.recallLines);
        recallLines.push(...finishLines(copies));
        return `${storedFormat.join("\n")}\n${recallLines.join("\n")}\n`;
    }
    const resolvedRfidReadFields = settings.rfid.readEnabled &&
        options.emitResolvedRfidReadFields &&
        options.elements
        ? emitResolvedRfidReadFields(
            options.elements,
            settings.rfid,
            options.sn ?? "",
            options.vars,
            dpi,
        )
        : [];
    if (resolvedRfidReadFields.length > 0) {
        lines.push(...resolvedRfidReadFields);
    } else if (settings.rfid.readEnabled) {
        if (options.elements) {
            lines.push(...emitRfidReadDynamicFields(
                options.elements,
                settings.rfid,
                options.sn ?? "",
                options.vars,
                dpi,
            ));
        }
        const read = buildZebraRfidReadCommand(settings.rfid);
        if (read) lines.push(read);
        if (options.elements) {
            lines.push(...emitRfidReadDynamicFields(
                options.elements,
                settings.rfid,
                options.sn ?? "",
                options.vars,
                dpi,
                1,
                "afterRead",
            ));
        }
    }
    if (options.capture) {
        lines.push(...(settings.rfid.enabled
            ? buildRfidWriteVerification(settings, options.rfidData ?? "", options.capture)
            : [buildRfidCaptureZpl(options.capture.jobId, options.capture.ordinal)]));
    }
    lines.push(...finishLines(copies));
    return lines.join("\n") + "\n";
}

export function buildZplSourcePreview(
    settings: LabelSettings,
    copies: number,
    alignment?: ZebraPrinterAlignment,
    tearOffOverrideDots?: number,
): string {
    const dpi = settings.dpi ?? 203;
    const widthDots = mmToDots(settings.widthMm, dpi);
    const heightDots = mmToDots(settings.heightMm, dpi);
    const widthBytes = Math.ceil(widthDots / 8);
    const totalBytes = widthBytes * heightDots;
    const lines = setupLines(settings, { alignment, tearOffOverrideDots });
    if (settings.rfid.enabled) {
        lines.push(
            settings.rfid.zebraUsePrinterSettings !== false
                ? "^FX RFID write is inserted per label; calibrated tuning is preserved and ^RS failure policy is applied.^FS"
                : "^FX RFID write and selected ^RS/^RW job tuning are inserted per rendered label.^FS",
        );
    }
    lines.push(`^FO0,0^GFA,${totalBytes},${totalBytes},${widthBytes},<bitmap data>^FS`);
    if (settings.rfid.readEnabled) {
        lines.push("^FX Text, QR, barcode, and Data Matrix fields that contain {rfid_read} are emitted as native Zebra fields over the bitmap.^FS");
        lines.push(buildZebraRfidReadCommand(settings.rfid));
    }
    lines.push(...finishLines(copies));
    return lines.join("\n") + "\n";
}

function textFontDots(el: TextEl, dpi: number): number {
    if (typeof el.fontSizeMm === "number" && Number.isFinite(el.fontSizeMm)) {
        return Math.max(8, mmToDots(el.fontSizeMm, dpi));
    }
    const native = TEXT_FONT_DOTS[el.font] ?? TEXT_FONT_DOTS.D;
    const physicalHeightMm = dotsToMm(native.h, 203) * Math.max(1, el.scaleY ?? 1);
    return Math.max(8, mmToDots(physicalHeightMm, dpi));
}

// A single left-aligned line without wrapping needs no ^FB. In a one-line
// ^FB, overflowing data wraps over the same line on the printer.
function directTextPrefix(el: TextEl, dpi: number, value: string): string | undefined {
    if ((el.align ?? "left") !== "left" || /[\r\n]/.test(value) ||
        textUsesFrame(getTextWrapMode(el.wrapMode), getTextFitMode(el.fitMode))) return;

    const x = mmToDots(el.pos.x, dpi);
    const y = mmToDots(el.pos.y, dpi);
    const fontDots = textFontDots(el, dpi);
    const orientation = zplRotation(el.rotation);
    const font = `^A0${orientation},${fontDots},${fontDots}`;
    if (orientation === "N") return `^FO${x},${y}${font}`;

    // ^FT follows the first character's baseline even when the printer alone
    // knows the EPC length. Zebra font 0's baseline is 3/4 of its cell height.
    const w = mmToDots(el.size.w, dpi);
    const h = mmToDots(el.size.h, dpi);
    const baseline = Math.round(fontDots * 3 / 4);
    if (orientation === "R") return `^FT${x + w - baseline},${y},0${font}`;
    if (orientation === "I") return `^FT${x + w},${y + h - baseline},0${font}`;
    return `^FT${x + baseline},${y + h},0${font}`;
}

function emitText(outer: TextEl, sn: string, vars: Record<string, string> | undefined, dpi: number, rfid?: RfidSettings): string[] {
    const el = insetTextElement(outer, dpi);
    if (!el) throw new Error(`Text ${outer.id}: margin leaves no printable area. Enlarge the frame or reduce the margin.`);
    const raw = resolveTextValue(el, sn, vars, rfid);
    if (!raw) return [];
    const direct = directTextPrefix(el, dpi, raw);
    if (direct) return [`${direct}^FD${zplText(raw)}^FS`];
    const x = mmToDots(el.pos.x, dpi);
    const y = mmToDots(el.pos.y, dpi);
    const logical = logicalSize(el.size, el.rotation);
    const widthDots = Math.max(1, mmToDots(logical.w, dpi));
    const heightDots = Math.max(1, mmToDots(logical.h, dpi));
    const fontDots = textFontDots(el, dpi);
    const rotation = zplRotation(el.rotation);
    const wrapMode = getTextWrapMode(el.wrapMode);
    const approxChar = Math.max(1, Math.round(fontDots * 0.58));
    const lines = wrapMode === "none"
        ? raw.split(/\r?\n/)
        : wrapTextToWidth(raw, widthDots, (value) => value.length * approxChar, wrapMode);
    const lineStep = Math.max(1, Math.round(fontDots * 1.12));
    const maxLines = Math.max(1, Math.floor(heightDots / lineStep));
    const align = el.align === "center" ? "C" : el.align === "right" ? "R" : "L";
    return lines.slice(0, maxLines).map((line, index) => rotatedTextField(
        x, y, mmToDots(el.size.w, dpi), mmToDots(el.size.h, dpi), rotation,
        0, index * lineStep, widthDots, fontDots, align, `^FD${zplText(line)}`,
    ));
}

function nativeTextPrefix(el: TextEl, dpi: number): string {
    const logical = logicalSize(el.size, el.rotation);
    const widthDots = Math.max(1, mmToDots(logical.w, dpi));
    const heightDots = Math.max(1, mmToDots(logical.h, dpi));
    const fontDots = textFontDots(el, dpi);
    const rotation = zplRotation(el.rotation);
    const wrapMode = getTextWrapMode(el.wrapMode);
    const fitMode = getTextFitMode(el.fitMode);
    const framed = textUsesFrame(wrapMode, fitMode);
    const lineStep = Math.max(1, Math.round(fontDots * 1.12));
    const maxLines = framed ? Math.max(1, Math.floor(heightDots / lineStep)) : 1;
    // ^FO is the top-left of the *rotated field*, not its rotation pivot.
    const block = rotateElement({ ...el, rotation: 0, pos: { x: 0, y: 0 },
        size: { w: widthDots, h: fontDots + (maxLines - 1) * lineStep },
    }, { w: widthDots, h: heightDots }, el.rotation);
    const x = mmToDots(el.pos.x, dpi) + block.pos.x;
    const y = mmToDots(el.pos.y, dpi) + block.pos.y;
    const align = el.align === "center" ? "C" : el.align === "right" ? "R" : "L";
    const fieldBlock = `^FB${widthDots},${maxLines},0,${align},0`;
    return `^FO${x},${y}^A0${rotation},${fontDots},${fontDots}${fieldBlock}`;
}

// Physical sizing is advisory: keep the requested whole-dot size so operators
// can calibrate a real tag. Invalid payloads/native commands still throw.
function symbolCalibrationWarnings(
    kind: "Barcode" | "QR",
    fitsFrame: boolean,
    scanSafe: boolean,
    heightFits = true,
): string[] {
    const warnings: string[] = [];
    if (!fitsFrame || !heightFits) {
        warnings.push(`^FX WARNING ${kind} exceeds its frame and may be clipped. Test print and adjust size or magnification.^FS`);
    }
    if (!scanSafe) {
        warnings.push(`^FX WARNING ${kind} module size is below the configured scanner minimum. Test print and verify scanning.^FS`);
    }
    return warnings;
}

function nativeQrPlan(
    el: QrEl,
    sizingData: string,
    dpi: number,
): { x: number; y: number; sizing: NativeQrSizing; warnings: string[] } {
    const frameWidthDots = Math.max(1, mmToDots(el.size.w, dpi));
    const frameHeightDots = Math.max(1, mmToDots(el.size.h, dpi));
    // Zebra chooses the symbol version from the actual field data. Do not use
    // the bitmap-only minVersion here; report it as unsupported metadata.
    if (!sizingData) throw new Error(`QR ${el.id} has empty data.`);
    const modules = qrModuleCount(sizingData, el.ecc);
    const sizing = nativeQrSizing({
        frameWidthDots,
        frameHeightDots,
        moduleCount: modules,
        requestedMagnification: el.sizeMode === "manual" ||
            (el.sizeMode === undefined && typeof el.magnification === "number")
            ? el.magnification
            : undefined,
        requestedVersion: el.version,
        quietZoneModules: el.quietZoneModules,
        dpi,
        minModuleMm: el.minModuleMm,
        align: el.align,
        verticalAlign: el.verticalAlign,
    });
    const frameX = mmToDots(el.pos.x, dpi);
    const frameY = mmToDots(el.pos.y, dpi);
    const x = frameX + sizing.dataOffsetXDots;
    const y = frameY + sizing.dataOffsetYDots;
    const warnings = symbolCalibrationWarnings("QR", sizing.fitsFrame, sizing.moduleSizeMm >= sizing.minModuleMm);
    if (sizing.limitedByNativeMax) {
        warnings.push(
            `^FX WARNING QR ${el.id}: requested ${sizing.desiredMagnification} dots/module but native ^BQN is capped at 10; use GFA bitmap output to fill the physical frame.^FS`,
        );
    }
    if (sizing.requestedVersionUnsupported) {
        warnings.push(
            `^FX WARNING QR ${el.id}: fixed/minimum version is bitmap-only; Zebra ^BQN selects version from payload.^FS`,
        );
    }
    return { x, y, sizing, warnings };
}

function assertPrinterResolvedQrCompatibility(
    el: QrEl,
    sizingData: string,
    plan: ReturnType<typeof nativeQrPlan>,
    payload: string,
): void {
    if ((el.rotation ?? 0) !== 0 || qrMinVersion(el.version) !== undefined) {
        throw new Error(
            `QR ${el.id}: printer-resolved RFID data requires 0-degree rotation and Version Auto.`,
        );
    }
    if (plan.sizing.limitedByNativeMax) {
        throw new Error(
            `QR ${el.id}: printer-resolved RFID data requires more than 10 dots/module. ` +
            "Reduce the frame or resolve the data on the host for exact bitmap output.",
        );
    }
    if (!/^[\x20-\x7E]+$/.test(sizingData)) {
        throw new Error(
            `QR ${el.id}: native Zebra automatic input is limited to safe ASCII in this application. ` +
            "Resolve non-ASCII data on the host for UTF-8 bitmap output.",
        );
    }
    if (payload.length > 3072) {
        throw new Error(
            `QR ${el.id}: native Zebra field data exceeds the 3,072-byte ^FD limit.`,
        );
    }
}

function dataMatrixPlan(
    el: DataMatrixEl,
    data: string,
    dpi: number,
): {
    x: number;
    y: number;
    matrix: DataMatrixMatrix;
    layout: DataMatrixFrameLayout;
} {
    if (!data) throw new Error(`Data Matrix ${el.id} has empty data.`);
    const matrix = encodeDataMatrix(data, {
        contentFormat: el.contentFormat,
        shape: el.shape,
        textEncoding: el.textEncoding,
        symbolRows: el.symbolRows,
        symbolColumns: el.symbolColumns,
    });
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
    if (!layout.fitsFrame) {
        throw new Error(
            `Data Matrix ${el.id} requires ${layout.outerWidthDots} × ` +
            `${layout.outerHeightDots} dots including its quiet zone, but its frame is ` +
            `${frameWidthDots} × ${frameHeightDots} dots.`,
        );
    }
    if (!layout.scanSafe) {
        throw new Error(
            `Data Matrix ${el.id} uses ${layout.moduleDots} dots/module ` +
            `(${layout.moduleSizeMm.toFixed(3)} mm), below the configured ` +
            `${layout.minModuleMm.toFixed(3)} mm scanner minimum.`,
        );
    }
    return {
        x: mmToDots(el.pos.x, dpi) + layout.dataOffsetXDots,
        y: mmToDots(el.pos.y, dpi) + layout.dataOffsetYDots,
        matrix,
        layout,
    };
}

function emitNativeDataMatrix(
    el: DataMatrixEl,
    sizingData: string,
    fieldData: string,
    dpi: number,
): string {
    if ((el.contentFormat ?? "standard") !== "standard") {
        throw new Error(
            `Data Matrix ${el.id}: printer-resolved RFID fields support Standard ECC 200 only.`,
        );
    }
    if ((el.textEncoding ?? "utf8") !== "utf8") {
        throw new Error(
            `Data Matrix ${el.id}: printer-resolved RFID fields require UTF-8 encoding.`,
        );
    }
    if ((el.shape ?? "square") !== "square") {
        throw new Error(
            `Data Matrix ${el.id}: printer-resolved RFID fields require a square ECC 200 symbol; ` +
            "rectangular symbols use exact bitmap output after host resolution.",
        );
    }
    const plan = dataMatrixPlan(el, sizingData, dpi);
    const aspect = (el.shape ?? "square") === "rectangle" ? 2 : 1;
    return whiteFrameField(el, dpi) +
        `^FO${plan.x},${plan.y}^BX${zplRotation(el.rotation ?? 0)},${plan.layout.moduleDots},200,` +
        `${plan.matrix.columns},${plan.matrix.rows},,_,${aspect}${fieldData}^FS`;
}

type ModuleMatrix = Pick<DataMatrixMatrix, "columns" | "rows" | "pixels"> | QrMatrix;

function moduleMatrixBitmap(
    matrix: ModuleMatrix,
    moduleDots: number,
    quietZoneModules: number,
): RasterBitmap {
    const widthDots = (matrix.columns + quietZoneModules * 2) * moduleDots;
    const heightDots = (matrix.rows + quietZoneModules * 2) * moduleDots;
    const widthBytes = Math.ceil(widthDots / 8);
    const bytes = new Uint8Array(widthBytes * heightDots);
    const offset = quietZoneModules * moduleDots;
    for (let row = 0; row < matrix.rows; row += 1) {
        for (let column = 0; column < matrix.columns; column += 1) {
            if (!matrix.pixels[row * matrix.columns + column]) continue;
            const x0 = offset + column * moduleDots;
            const y0 = offset + row * moduleDots;
            for (let dy = 0; dy < moduleDots; dy += 1) {
                const byteRow = (y0 + dy) * widthBytes;
                for (let dx = 0; dx < moduleDots; dx += 1) {
                    const x = x0 + dx;
                    bytes[byteRow + (x >> 3)] |= 0x80 >>> (x & 7);
                }
            }
        }
    }
    return { widthDots, heightDots, widthBytes, bytes };
}

function rasterBit(bitmap: RasterBitmap, x: number, y: number): boolean {
    return (bitmap.bytes[y * bitmap.widthBytes + (x >> 3)] & (0x80 >>> (x & 7))) !== 0;
}

function setRasterBit(bytes: Uint8Array, widthBytes: number, x: number, y: number): void {
    bytes[y * widthBytes + (x >> 3)] |= 0x80 >>> (x & 7);
}

function rotateRasterBitmap(
    bitmap: RasterBitmap,
    rotationValue: number | undefined,
): RasterBitmap {
    const rotation = rotationValue === 90 || rotationValue === 180 || rotationValue === 270
        ? rotationValue
        : 0;
    if (rotation === 0) return bitmap;
    const widthDots = rotation === 90 || rotation === 270
        ? bitmap.heightDots
        : bitmap.widthDots;
    const heightDots = rotation === 90 || rotation === 270
        ? bitmap.widthDots
        : bitmap.heightDots;
    const widthBytes = Math.ceil(widthDots / 8);
    const bytes = new Uint8Array(widthBytes * heightDots);
    for (let y = 0; y < bitmap.heightDots; y += 1) {
        for (let x = 0; x < bitmap.widthDots; x += 1) {
            if (!rasterBit(bitmap, x, y)) continue;
            let targetX: number;
            let targetY: number;
            if (rotation === 90) {
                targetX = bitmap.heightDots - 1 - y;
                targetY = x;
            } else if (rotation === 180) {
                targetX = bitmap.widthDots - 1 - x;
                targetY = bitmap.heightDots - 1 - y;
            } else {
                targetX = y;
                targetY = bitmap.widthDots - 1 - x;
            }
            setRasterBit(bytes, widthBytes, targetX, targetY);
        }
    }
    return { widthDots, heightDots, widthBytes, bytes };
}

/**
 * Build the exact Code 128/EAN bar field used by the SVG and full-page
 * renderers. Keeping the bars as a dot bitmap prevents a printer firmware from
 * choosing different Code 128 subsets and silently changing the symbol width.
 */
function barcodeBarsBitmap(
    rendered: NonNullable<ReturnType<typeof renderBarcode>>,
    layout: ReturnType<typeof barcodeModuleLayout>,
    vertical: ReturnType<typeof barcodeHeightLayout>,
    symbology: BarcodeEl["symbology"],
    humanReadable: boolean,
    textPosition: BarcodeEl["textPosition"],
): RasterBitmap {
    const widthDots = layout.containerDots;
    const heightDots = vertical.frameHeightDots;
    const widthBytes = Math.ceil(widthDots / 8);
    const bytes = new Uint8Array(widthBytes * heightDots);
    const textAbove = (textPosition ?? "below") === "above";
    const guardExtension = symbology === "EAN13" && humanReadable
        ? Math.min(
              Math.max(1, Math.round(vertical.textHeightDots * 0.25)),
              Math.max(0, vertical.barHeightDots - 2),
          )
        : 0;
    const overlapsEanGuard = (start: number, end: number) =>
        (start < 3 && end > 0) ||
        (start < 50 && end > 45) ||
        (start < 95 && end > 92);

    let cursorDots = layout.barOffsetDots;
    let symbolModule = 0;
    for (let index = 0; index < rendered.widths.length; index += 1) {
        const moduleWidth = rendered.widths[index];
        const barWidthDots = moduleWidth * layout.narrowDots;
        if (index % 2 === 0) {
            const guard = symbology === "EAN13" &&
                overlapsEanGuard(symbolModule, symbolModule + moduleWidth);
            const shortened = guard ? 0 : guardExtension;
            const y0 = vertical.barsOffsetDots + (textAbove ? shortened : 0);
            const barHeightDots = Math.max(2, vertical.barHeightDots - shortened);
            for (let y = y0; y < Math.min(heightDots, y0 + barHeightDots); y += 1) {
                for (let x = cursorDots; x < Math.min(widthDots, cursorDots + barWidthDots); x += 1) {
                    if (x >= 0 && y >= 0) setRasterBit(bytes, widthBytes, x, y);
                }
            }
        }
        cursorDots += barWidthDots;
        symbolModule += moduleWidth;
    }
    return { widthDots, heightDots, widthBytes, bytes };
}

function graphicField(x: number, y: number, bitmap: RasterBitmap): string {
    const totalBytes = bitmap.widthBytes * bitmap.heightDots;
    return `^FO${x},${y}^GFA,${totalBytes},${totalBytes},${bitmap.widthBytes},${z64(bitmap.bytes)}^FS`;
}

function whiteFrameField(
    el: Pick<LabelElement, "pos" | "size">,
    dpi: number,
): string {
    const x = mmToDots(el.pos.x, dpi);
    const y = mmToDots(el.pos.y, dpi);
    const width = Math.max(1, mmToDots(el.size.w, dpi));
    const height = Math.max(1, mmToDots(el.size.h, dpi));
    // Zebra ^GB supports W (white). Drawing a filled white field makes native
    // output match the editor's opaque symbol frame and protects quiet zones
    // from any black element rendered earlier in the format.
    return `^FO${x},${y}^GB${width},${height},${Math.min(width, height)},W,0^FS`;
}

function rotatedTextField(
    frameX: number,
    frameY: number,
    frameWidthDots: number,
    frameHeightDots: number,
    rotation: ReturnType<typeof zplRotation>,
    localX: number,
    localY: number,
    localWidthDots: number,
    textHeightDots: number,
    align: "L" | "C" | "R",
    fieldData: string,
): string {
    let x = frameX + localX;
    let y = frameY + localY;
    if (rotation === "R") {
        x = frameX + frameWidthDots - localY - textHeightDots;
        y = frameY + localX;
    } else if (rotation === "I") {
        x = frameX + frameWidthDots - localX - localWidthDots;
        y = frameY + frameHeightDots - localY - textHeightDots;
    } else if (rotation === "B") {
        x = frameX + localY;
        y = frameY + frameHeightDots - localX - localWidthDots;
    }
    // Zebra scalable font 0 already has an intrinsic glyph advance near the
    // regular monospace face used by preview. Setting width to 0.6× height
    // compresses that intrinsic ratio again on real firmware, so keep the
    // canonical square font box here.
    return `^FO${x},${y}^A0${rotation},${textHeightDots},${textHeightDots}` +
        `^FB${localWidthDots},1,0,${align},0${fieldData}^FS`;
}

function emitNativeBarcode(
    el: BarcodeEl,
    sizingData: string,
    fieldData: string,
    dpi: number,
    symbology: BarcodeEl["symbology"] = el.symbology,
    hriFieldData?: string,
): string {
    const frameX = mmToDots(el.pos.x, dpi);
    const frameY = mmToDots(el.pos.y, dpi);
    const frameWidthDots = Math.max(1, mmToDots(el.size.w, dpi));
    const frameHeightDots = Math.max(2, mmToDots(el.size.h, dpi));
    const rotation = zplRotation(el.rotation ?? 0);
    const quarterTurn = rotation === "R" || rotation === "B";
    const logicalWidthDots = quarterTurn ? frameHeightDots : frameWidthDots;
    const logicalHeightDots = quarterTurn ? frameWidthDots : frameHeightDots;
    const rendered = renderBarcode(sizingData, symbology);
    if (!rendered) {
        throw new Error(
            symbology === "EAN13"
                ? `Barcode ${el.id}: EAN-13 requires 12 data digits or 13 digits with a valid checksum.`
                : `Barcode ${el.id}: Code 128 requires printable ASCII data.`,
        );
    }
    const manual = el.sizeMode === "manual" ||
        (el.sizeMode === undefined && typeof el.narrowDots === "number");
    const fallbackNarrow = scanSafeBarcodeNarrowDots(dpi);
    const layout = barcodeModuleLayout({
        containerDots: logicalWidthDots,
        totalModules: rendered.totalModules,
        quietZoneLeftModules: rendered.quietZoneLeftModules,
        quietZoneRightModules: rendered.quietZoneRightModules,
        dpi,
        minModuleMm: el.minModuleMm,
        align: el.align ?? "center",
        mode: manual ? "fixed" : "auto",
        requestedDotsPerModule: manual
            ? (el.narrowDots ?? fallbackNarrow)
            : undefined,
    });
    const narrowDots = layout.narrowDots;
    const customCode128Hri = !!el.humanReadable && symbology === "CODE128" && !!hriFieldData;
    const human = el.humanReadable && !customCode128Hri ? "Y" : "N";
    const humanAbove = human === "Y" && el.textPosition === "above" ? "Y" : "N";
    const vertical = barcodeHeightLayout({
        frameHeightDots: logicalHeightDots,
        dpi,
        humanReadable: el.humanReadable,
        barHeightMm: el.barHeightMm,
        textSizeMm: el.textSizeMm,
        textPaddingMm: el.textPaddingMm,
        textPosition: el.textPosition,
    });
    const symbolWidthDots = rendered.symbolModules * narrowDots;
    let barcodeX = frameX + layout.barOffsetDots;
    let barcodeY = frameY + vertical.barsOffsetDots;
    if (rotation === "R") {
        barcodeX = frameX + frameWidthDots - vertical.barsOffsetDots - vertical.barHeightDots;
        barcodeY = frameY + layout.barOffsetDots;
    } else if (rotation === "I") {
        barcodeX = frameX + frameWidthDots - layout.barOffsetDots - symbolWidthDots;
        barcodeY = frameY + frameHeightDots - vertical.barsOffsetDots - vertical.barHeightDots;
    } else if (rotation === "B") {
        barcodeX = frameX + vertical.barsOffsetDots;
        barcodeY = frameY + frameHeightDots - layout.barOffsetDots - symbolWidthDots;
    }
    const font = el.humanReadable && !customCode128Hri
        ? `^A0${rotation},${vertical.textHeightDots},${vertical.textHeightDots}`
        : "";
    // Code 128 and EAN are fixed-ratio symbols. ^BY parameter 2 is a ratio,
    // not a wide-bar dot count, so keep it at a valid 2.0 value.
    const by = `^BY${narrowDots},2.0,${vertical.barHeightDots}`;
    const clear = symbolCalibrationWarnings(
        "Barcode", layout.fitsFrame, layout.xDimensionMm >= layout.minimumXDimensionMm, vertical.fitsFrame,
    ).join("") + whiteFrameField(el, dpi);
    if (symbology === "EAN13") {
        return clear + `${font}^FO${barcodeX},${barcodeY}${by}` +
            `^BE${rotation},${vertical.barHeightDots},${human},${humanAbove}${fieldData}^FS`;
    }
    // Automatic mode lets the printer switch Code 128 subsets for compact
    // numeric runs while retaining the full alphanumeric EPC text.
    const barcode = `${font}^FO${barcodeX},${barcodeY}${by}` +
        `^BC${rotation},${vertical.barHeightDots},${human},${humanAbove},N,A${fieldData}^FS`;
    if (!customCode128Hri || !hriFieldData) return clear + barcode;
    const hriAlign = el.textAlign === "left" ? "L" : el.textAlign === "right" ? "R" : "C";
    const hri = rotatedTextField(
        frameX,
        frameY,
        frameWidthDots,
        frameHeightDots,
        rotation,
        0,
        vertical.textOffsetDots,
        logicalWidthDots,
        vertical.textHeightDots,
        hriAlign,
        hriFieldData,
    );
    return clear + barcode + hri;
}

function emitRfidReadTextFields(
    elements: LabelElement[],
    rfid: RfidSettings,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
    fieldNumber = 1,
): string[] {
    const fieldName = rfidReadFieldName(rfid);
    if (!fieldName) return [];
    if (varsHaveRfidReadValue(vars, fieldName)) return [];
    const out: string[] = [];
    const readSafeVars = varsWithoutField(vars, fieldName);
    for (const el of elements) {
        if (el.kind !== "text" || !textUsesRfidReadField(el, fieldName)) continue;
        const fieldMatches = (el.fieldName ?? "").trim().toLowerCase() === fieldName.toLowerCase();
        const textContainsRead = rfidReadPlaceholderRegex(fieldName).test(el.text);
        const raw = fieldMatches && !textContainsRead
            ? `{${fieldName}}`
            : resolveDynamicValue(el.text, textContainsRead ? undefined : el.fieldName, sn, readSafeVars);
        const inner = insetTextElement(el, dpi);
        if (!inner) throw new Error(`Text ${el.id}: margin leaves no printable area. Enlarge the frame or reduce the margin.`);
        const prefix = directTextPrefix(inner, dpi, raw) ?? nativeTextPrefix(inner, dpi);
        const lastChars = rfidTextLastChars(el, rfid);
        if (!lastChars && (fieldMatches || isOnlyRfidReadField(raw, fieldName))) {
            out.push(`${prefix}^FN${fieldNumber}^FS`);
            continue;
        }
        const delimiter = fieldConcatDelimiter(raw);
        const data = zplFieldDataWithReadField(raw, fieldName, fieldNumber, delimiter, lastChars);
        out.push(`${prefix}^FH\\^FE${delimiter}^FD${data}^FS`);
    }
    return out;
}

function emitRfidReadQrBarcodeFields(
    elements: LabelElement[],
    rfid: RfidSettings,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
    fieldNumber = 1,
    phase: "beforeRead" | "afterRead" = "beforeRead",
): string[] {
    const fieldName = rfidReadFieldName(rfid);
    if (!fieldName) return [];
    if (varsHaveRfidReadValue(vars, fieldName)) return [];
    const out: string[] = [];
    for (const el of elements) {
        if (
            (el.kind !== "qr" && el.kind !== "barcode" && el.kind !== "datamatrix") ||
            !elementUsesRfidReadField(el, fieldName)
        ) {
            continue;
        }
        const raw = rfidReadElementData(el.data, el.fieldName, fieldName, sn, vars);
        const directReadField = isOnlyRfidReadField(raw, fieldName);
        if (el.kind === "qr") {
            if (phase === "afterRead") continue;
            const sizingData = raw.replace(
                rfidReadPlaceholderRegex(fieldName),
                rfidReadSample(rfid),
            );
            const plan = nativeQrPlan(el, sizingData, dpi);
            const delimiter = fieldConcatDelimiter(raw);
            const payload = qrPayloadWithReadField(
                raw,
                fieldName,
                fieldNumber,
                el.ecc,
                delimiter,
            );
            assertPrinterResolvedQrCompatibility(el, sizingData, plan, payload);
            out.push(
                ...plan.warnings,
                `^FO${plan.x},${plan.y}^BQN,2,${plan.sizing.magnification}` +
                    `^FH\\^FE${delimiter}^FD${payload}^FS`,
            );
            continue;
        }

        if (el.kind === "datamatrix") {
            if (phase === "afterRead") continue;
            const sampleData = raw.replace(
                rfidReadPlaceholderRegex(fieldName),
                rfidReadSample(rfid),
            );
            const delimiter = fieldConcatDelimiter(raw);
            const dataMatrixData = dataMatrixFieldDataWithReadField(
                raw,
                fieldName,
                fieldNumber,
                delimiter,
            );
            if (!directReadField && dataMatrixData.length > 3072) {
                throw new Error(
                    `Data Matrix ${el.id}: native Zebra field data exceeds the 3,072-byte ^FD limit.`,
                );
            }
            const fieldData = directReadField
                ? `^FN${fieldNumber}`
                : `^FH\\^FE${delimiter}^FD${dataMatrixData}`;
            out.push(emitNativeDataMatrix(el, sampleData, fieldData, dpi));
            continue;
        }

        if (phase === "afterRead") continue;

        if (el.symbology === "EAN13") {
            throw new Error(
                `Barcode ${el.id}: EAN-13 cannot encode printer-resolved RFID data; use Code 128 instead.`,
            );
        }
        const sampleData = raw.replace(
            rfidReadPlaceholderRegex(fieldName),
            rfidReadSample(rfid, el.symbology),
        );
        const delimiter = fieldConcatDelimiter(raw);
        const barcodeData = code128FieldDataWithReadField(
            raw,
            fieldName,
            fieldNumber,
            delimiter,
        );
        const fieldData = directReadField
            ? `^FN${fieldNumber}`
            : `^FH\\^FE${delimiter}^FD${barcodeData}`;
        const hriData = el.humanReadable
            ? zplFieldDataWithReadField(raw, fieldName, fieldNumber, delimiter)
            : "";
        const hriFieldData = !el.humanReadable
            ? undefined
            : directReadField
              ? `^FN${fieldNumber}`
              : `^FH\\^FE${delimiter}^FD${hriData}`;
        out.push(
            emitNativeBarcode(
                el,
                sampleData,
                fieldData,
                dpi,
                el.symbology,
                hriFieldData,
            ),
        );
    }
    return out;
}

function emitRfidReadDynamicFields(
    elements: LabelElement[],
    rfid: RfidSettings,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
    fieldNumber = 1,
    phase: "beforeRead" | "afterRead" = "beforeRead",
): string[] {
    if (phase === "afterRead") {
        return emitRfidReadQrBarcodeFields(elements, rfid, sn, vars, dpi, fieldNumber, phase);
    }
    return [
        ...emitRfidReadTextFields(elements, rfid, sn, vars, dpi, fieldNumber),
        ...emitRfidReadQrBarcodeFields(elements, rfid, sn, vars, dpi, fieldNumber, phase),
    ];
}

function rfidReadElementsNeedStoredFormat(
    elements: LabelElement[] | undefined,
    rfid: RfidSettings,
    vars: Record<string, string> | undefined,
): boolean {
    const fieldName = rfidReadFieldName(rfid);
    if (!elements || !fieldName || varsHaveRfidReadValue(vars, fieldName)) return false;
    // Some UHF RFID firmware accepts ^FN variables populated by ^RFR in the
    // active label format, but drops printable fields when the same flow is
    // wrapped in ^DF/^XF. Keep RFID-read labels as a single active format.
    return false;
}

function emitStoredRfidReadDynamicFields(
    elements: LabelElement[],
    rfid: RfidSettings,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
    fieldNumber = 1,
): { formatLines: string[]; recallLines: string[] } {
    const fieldName = rfidReadFieldName(rfid);
    if (!fieldName || varsHaveRfidReadValue(vars, fieldName)) {
        return { formatLines: [], recallLines: [] };
    }

    const formatLines: string[] = [];
    const recallLines: string[] = [];
    let nextFieldNumber = fieldNumber + 1;

    formatLines.push(...emitRfidReadTextFields(elements, rfid, sn, vars, dpi, fieldNumber));

    for (const el of elements) {
        if (
            (el.kind !== "qr" && el.kind !== "barcode" && el.kind !== "datamatrix") ||
            !elementUsesRfidReadField(el, fieldName)
        ) {
            continue;
        }

        const raw = rfidReadElementData(el.data, el.fieldName, fieldName, sn, vars);
        if (el.kind === "qr") {
            const sizingData = raw.replace(
                rfidReadPlaceholderRegex(fieldName),
                rfidReadSample(rfid),
            );
            const plan = nativeQrPlan(el, sizingData, dpi);
            const qrFieldNumber = nextFieldNumber;
            nextFieldNumber += 1;
            const delimiter = fieldConcatDelimiter(raw);
            const payload = qrPayloadWithReadField(
                raw,
                fieldName,
                fieldNumber,
                el.ecc,
                delimiter,
            );
            assertPrinterResolvedQrCompatibility(el, sizingData, plan, payload);
            formatLines.push(
                ...plan.warnings,
                `^FO${plan.x},${plan.y}^BQN,2,${plan.sizing.magnification}^FN${qrFieldNumber}^FS`,
            );
            recallLines.push(
                `^FN${qrFieldNumber}^FH\\^FE${delimiter}^FD${payload}^FS`,
            );
            continue;
        }


        if (el.kind === "datamatrix") {
            const directReadField = isOnlyRfidReadField(raw, fieldName);
            const sampleData = raw.replace(
                rfidReadPlaceholderRegex(fieldName),
                rfidReadSample(rfid),
            );
            const delimiter = fieldConcatDelimiter(raw);
            const dataMatrixData = dataMatrixFieldDataWithReadField(
                raw,
                fieldName,
                fieldNumber,
                delimiter,
            );
            if (!directReadField && dataMatrixData.length > 3072) {
                throw new Error(
                    `Data Matrix ${el.id}: native Zebra field data exceeds the 3,072-byte ^FD limit.`,
                );
            }
            const fieldData = directReadField
                ? `^FN${fieldNumber}`
                : `^FH\\^FE${delimiter}^FD${dataMatrixData}`;
            formatLines.push(emitNativeDataMatrix(el, sampleData, fieldData, dpi));
            continue;
        }

        const directReadField = isOnlyRfidReadField(raw, fieldName);
        if (el.symbology === "EAN13") {
            throw new Error(
                `Barcode ${el.id}: EAN-13 cannot encode printer-resolved RFID data; use Code 128 instead.`,
            );
        }
        const sampleData = raw.replace(
            rfidReadPlaceholderRegex(fieldName),
            rfidReadSample(rfid, el.symbology),
        );
        const delimiter = fieldConcatDelimiter(raw);
        const barcodeData = code128FieldDataWithReadField(
            raw,
            fieldName,
            fieldNumber,
            delimiter,
        );
        const fieldData = directReadField
            ? `^FN${fieldNumber}`
            : `^FH\\^FE${delimiter}^FD${barcodeData}`;
        const hriData = el.humanReadable
            ? zplFieldDataWithReadField(raw, fieldName, fieldNumber, delimiter)
            : "";
        const hriFieldData = !el.humanReadable
            ? undefined
            : directReadField
              ? `^FN${fieldNumber}`
              : `^FH\\^FE${delimiter}^FD${hriData}`;
        formatLines.push(
            emitNativeBarcode(
                el,
                sampleData,
                fieldData,
                dpi,
                el.symbology,
                hriFieldData,
            ),
        );
    }

    return { formatLines, recallLines };
}

function emitResolvedRfidReadFields(
    elements: LabelElement[],
    rfid: RfidSettings,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
): string[] {
    const fieldName = rfidReadFieldName(rfid);
    if (!fieldName || !varsHaveRfidReadValue(vars, fieldName)) return [];
    const out: string[] = [];
    for (const el of elements) {
        if (!elementUsesRfidReadField(el, fieldName)) continue;
        out.push(...emitElement(el, sn, vars, dpi, rfid));
    }
    return out;
}

function emitQrGraphic(el: QrEl, data: string, dpi: number): string[] {
    const matrix = encodeQrMatrix(data, el.ecc, qrMinVersion(el.version));
    const frameWidthDots = Math.max(1, mmToDots(el.size.w, dpi));
    const frameHeightDots = Math.max(1, mmToDots(el.size.h, dpi));
    const layout = fitQrToFrameDots(
        frameWidthDots,
        frameHeightDots,
        matrix.columns,
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
    const bitmap = rotateRasterBitmap(
        moduleMatrixBitmap(matrix, layout.moduleDots, layout.quietZoneModules),
        el.rotation,
    );
    const x = mmToDots(el.pos.x, dpi) + layout.outerOffsetXDots;
    const y = mmToDots(el.pos.y, dpi) + layout.outerOffsetYDots;
    return [
        ...symbolCalibrationWarnings("QR", layout.fitsFrame, layout.moduleSizeMm >= layout.minModuleMm),
        whiteFrameField(el, dpi),
        graphicField(x, y, bitmap),
    ];
}

function emitQr(el: QrEl, sn: string, vars: Record<string, string> | undefined, dpi: number): string[] {
    const data = resolveDynamicValue(el.data, el.fieldName, sn, vars);
    if (!data) return [];
    // Host-resolved symbols always use the exact matrix shown in the editor.
    // Native ^BQ remains reserved for printer-resolved RFID fields, where the
    // final value does not exist until the label is already inside the printer.
    return emitQrGraphic(el, data, dpi);
}

function emitBarcodeGraphic(
    el: BarcodeEl,
    data: string,
    dpi: number,
    symbology: BarcodeEl["symbology"] = el.symbology,
): string[] {
    const rendered = renderBarcode(data, symbology);
    if (!rendered) {
        throw new Error(
            symbology === "EAN13"
                ? `Barcode ${el.id}: invalid EAN-13 data.`
                : `Barcode ${el.id}: Code 128 requires printable ASCII data.`,
        );
    }
    const frameX = mmToDots(el.pos.x, dpi);
    const frameY = mmToDots(el.pos.y, dpi);
    const frameWidthDots = Math.max(1, mmToDots(el.size.w, dpi));
    const frameHeightDots = Math.max(2, mmToDots(el.size.h, dpi));
    const rotation = zplRotation(el.rotation ?? 0);
    const quarterTurn = rotation === "R" || rotation === "B";
    const logicalWidthDots = quarterTurn ? frameHeightDots : frameWidthDots;
    const logicalHeightDots = quarterTurn ? frameWidthDots : frameHeightDots;
    const manual = el.sizeMode === "manual" ||
        (el.sizeMode === undefined && typeof el.narrowDots === "number");
    const layout = barcodeModuleLayout({
        containerDots: logicalWidthDots,
        totalModules: rendered.totalModules,
        quietZoneLeftModules: rendered.quietZoneLeftModules,
        quietZoneRightModules: rendered.quietZoneRightModules,
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
    const bitmap = rotateRasterBitmap(
        barcodeBarsBitmap(
            rendered,
            layout,
            vertical,
            symbology,
            el.humanReadable,
            el.textPosition,
        ),
        el.rotation,
    );
    const fields = [
        ...symbolCalibrationWarnings("Barcode", layout.fitsFrame, layout.xDimensionMm >= layout.minimumXDimensionMm, vertical.fitsFrame),
        whiteFrameField(el, dpi),
        graphicField(frameX, frameY, bitmap),
    ];
    if (el.humanReadable) {
        if (symbology === "EAN13" && rendered.render.length === 13) {
            // EAN-13 HRI is grouped exactly like the editor: the leading digit
            // sits left of the start guard, with six digits under each half.
            // Drawing our own HRI also makes text size/padding deterministic;
            // native ^BE ignores the requested ^A0 height on Zebra firmware.
            const unit = layout.narrowDots;
            const groups = [
                {
                    text: rendered.render[0],
                    center: Math.max(unit * 2, layout.barOffsetDots - unit * 4),
                    width: Math.max(vertical.textHeightDots, unit * 8),
                },
                {
                    text: rendered.render.slice(1, 7),
                    center: layout.barOffsetDots + unit * 24,
                    width: unit * 42,
                },
                {
                    text: rendered.render.slice(7),
                    center: layout.barOffsetDots + unit * 71,
                    width: unit * 42,
                },
            ];
            for (const group of groups) {
                const localX = Math.max(0, Math.round(group.center - group.width / 2));
                const localWidth = Math.max(
                    1,
                    Math.min(group.width, logicalWidthDots - localX),
                );
                fields.push(rotatedTextField(
                    frameX,
                    frameY,
                    frameWidthDots,
                    frameHeightDots,
                    rotation,
                    localX,
                    vertical.textOffsetDots,
                    localWidth,
                    vertical.textHeightDots,
                    "C",
                    `^FH\\^FD${group.text}`,
                ));
            }
        } else {
            const hriAlign = el.textAlign === "left"
                ? "L"
                : el.textAlign === "right"
                  ? "R"
                  : "C";
            fields.push(rotatedTextField(
                frameX,
                frameY,
                frameWidthDots,
                frameHeightDots,
                rotation,
                0,
                vertical.textOffsetDots,
                logicalWidthDots,
                vertical.textHeightDots,
                hriAlign,
                `^FH\\^FD${zplHexBytes(rendered.render)}`,
            ));
        }
    }
    return fields;
}

function emitBarcode(el: BarcodeEl, sn: string, vars: Record<string, string> | undefined, dpi: number): string[] {
    const data = resolveDynamicValue(el.data, el.fieldName, sn, vars);
    if (!data) return [];
    if (el.symbology === "EAN13") {
        const canonical = normalizeEan13(data);
        if (!canonical) {
            throw new Error(`Barcode ${el.id}: invalid EAN-13 data.`);
        }
        // Host-resolved EAN-13 uses the same exact bar bitmap and grouped HRI
        // as preview. Native ^BE remains unsuitable here because its built-in
        // HRI sizing differs across printer firmware and can leave the frame.
        return emitBarcodeGraphic(el, canonical, dpi, "EAN13");
    }
    return emitBarcodeGraphic(el, data, dpi, "CODE128");
}

function emitDataMatrix(
    el: DataMatrixEl,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
): string[] {
    const data = resolveDynamicValue(el.data, el.fieldName, sn, vars);
    if (!data) return [];
    // Host-resolved Data Matrix always comes from the exact validated module
    // matrix. Native ^BX is used only for printer-resolved RFID fields.
    const sourceMatrix = encodeDataMatrix(data, {
        contentFormat: el.contentFormat,
        shape: el.shape,
        textEncoding: el.textEncoding,
        symbolRows: el.symbolRows,
        symbolColumns: el.symbolColumns,
    });
    const quarterTurn = el.rotation === 90 || el.rotation === 270;
    const matrixColumns = quarterTurn ? sourceMatrix.rows : sourceMatrix.columns;
    const matrixRows = quarterTurn ? sourceMatrix.columns : sourceMatrix.rows;
    const frameWidthDots = Math.max(1, mmToDots(el.size.w, dpi));
    const frameHeightDots = Math.max(1, mmToDots(el.size.h, dpi));
    const layout = fitDataMatrixToFrameDots(
        frameWidthDots,
        frameHeightDots,
        matrixColumns,
        matrixRows,
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
    if (!layout.fitsFrame) {
        throw new Error(
            `Data Matrix ${el.id} requires ${layout.outerWidthDots} × ` +
            `${layout.outerHeightDots} dots including its quiet zone, but its frame is ` +
            `${frameWidthDots} × ${frameHeightDots} dots.`,
        );
    }
    if (!layout.scanSafe) {
        throw new Error(
            `Data Matrix ${el.id} uses ${layout.moduleDots} dots/module ` +
            `(${layout.moduleSizeMm.toFixed(3)} mm), below the configured ` +
            `${layout.minModuleMm.toFixed(3)} mm scanner minimum.`,
        );
    }
    const bitmap = rotateRasterBitmap(
        moduleMatrixBitmap(
            sourceMatrix,
            layout.moduleDots,
            layout.quietZoneModules,
        ),
        el.rotation,
    );
    const x = mmToDots(el.pos.x, dpi) + layout.outerOffsetXDots;
    const y = mmToDots(el.pos.y, dpi) + layout.outerOffsetYDots;
    return [
        whiteFrameField(el, dpi),
        graphicField(x, y, bitmap),
    ];
}

function emitRect(el: RectEl, dpi: number): string[] {
    const x = mmToDots(el.pos.x, dpi);
    const y = mmToDots(el.pos.y, dpi);
    const w = Math.max(1, mmToDots(el.size.w, dpi));
    const h = Math.max(1, mmToDots(el.size.h, dpi));
    const t = el.filled ? Math.max(w, h) : Math.max(1, mmToDots(el.thickness, dpi));
    return [`^FO${x},${y}^GB${w},${h},${t},B,0^FS`];
}

function emitLine(el: LineEl, dpi: number): string[] {
    const ink = lineStrokeBoundsDots(el, dpi);
    const x = mmToDots(el.pos.x, dpi) + ink.x;
    const y = mmToDots(el.pos.y, dpi) + ink.y;
    return [`^FO${x},${y}^GB${ink.w},${ink.h},${ink.thickness},B,0^FS`];
}

function emitTable(physical: TableEl, sn: string, vars: Record<string, string> | undefined, dpi: number): string[] {
    const el = { ...physical, rotation: 0 as const, pos: { x: 0, y: 0 }, size: logicalSize(physical.size, physical.rotation) };
    const positioned = <T extends LabelElement>(part: T): T => {
        const rotated = rotateElement(part, el.size, physical.rotation ?? 0);
        return { ...rotated, pos: { x: rotated.pos.x + physical.pos.x, y: rotated.pos.y + physical.pos.y } } as T;
    };
    const out: string[] = [];
    const frame: RectEl = {
        id: `${el.id}_frame`,
        kind: "rect",
        pos: el.pos,
        size: el.size,
        thickness: el.borderThickness,
        filled: false,
    };
    if (el.borderThickness > 0) out.push(...emitRect(positioned(frame), dpi));

    let x = el.pos.x;
    for (let c = 0; c < el.cols - 1; c += 1) {
        x += el.colWidths[c] ?? 0;
        if (el.borderThickness > 0) out.push(...emitLine(positioned({
            id: `${el.id}_v_${c}`,
            kind: "line",
            pos: { x, y: el.pos.y },
            size: { w: el.borderThickness, h: el.size.h },
            thickness: el.borderThickness,
            orientation: "v",
        }), dpi));
    }

    let y = el.pos.y;
    for (let r = 0; r < el.rows - 1; r += 1) {
        y += el.rowHeights[r] ?? 0;
        if (el.borderThickness > 0) out.push(...emitLine(positioned({
            id: `${el.id}_h_${r}`,
            kind: "line",
            pos: { x: el.pos.x, y },
            size: { w: el.size.w, h: el.borderThickness },
            thickness: el.borderThickness,
            orientation: "h",
        }), dpi));
    }

    let cellY = el.pos.y;
    for (let r = 0; r < el.rows; r += 1) {
        let cellX = el.pos.x;
        for (let c = 0; c < el.cols; c += 1) {
            const index = r * el.cols + c;
            const value = el.cells[index] ?? "";
            const cell: TextEl = {
                id: `${el.id}_cell_${index}`,
                kind: "text",
                marginMm: 0, // Cell geometry already includes the table's padding.
                pos: { x: cellX + el.padding, y: cellY + el.padding },
                size: {
                    w: Math.max(1, (el.colWidths[c] ?? 0) - el.padding * 2),
                    h: Math.max(1, (el.rowHeights[r] ?? 0) - el.padding * 2),
                },
                text: value,
                rotation: 0,
                font: "D",
                scaleX: 1,
                scaleY: 1,
                fontSizeMm: el.cellStyles?.[index]?.fontSizeMm ?? el.fontSizeMm,
                align: el.cellStyles?.[index]?.align ?? el.align ?? "left",
                wrapMode: "word",
                fitMode: "clip",
            };
            out.push(...emitText(positioned(cell), sn, vars, dpi));
            cellX += el.colWidths[c] ?? 0;
        }
        cellY += el.rowHeights[r] ?? 0;
    }
    return out;
}

function emitElement(
    el: LabelElement,
    sn: string,
    vars: Record<string, string> | undefined,
    dpi: number,
    rfid?: RfidSettings,
): string[] {
    switch (el.kind) {
        case "text":
            return emitText(el, sn, vars, dpi, rfid);
        case "qr":
            return emitQr(el, sn, vars, dpi);
        case "barcode":
            return emitBarcode(el, sn, vars, dpi);
        case "datamatrix":
            return emitDataMatrix(el, sn, vars, dpi);
        case "rect":
            return emitRect(el, dpi);
        case "line":
            return emitLine(el, dpi);
        case "table":
            return emitTable(el, sn, vars, dpi);
        case "image":
            return [`^FX Image element ${zplComment(el.id)} is emitted only by browser bitmap mode.^FS`];
    }
}

function defaultRfidPayload(elements: LabelElement[]): string {
    for (const el of elements) {
        if (el.kind === "qr" || el.kind === "barcode" || el.kind === "datamatrix") return el.data;
        if (el.kind === "text") return el.text;
    }
    return "";
}

export function buildZpl(doc: LabelDoc, startRowIdx = 0): string {
    const { settings, elements } = doc;
    const serial = settings.serial;
    const batch = previewBatch(doc, startRowIdx);
    const blocks: string[] = [];
    const dpi = settings.dpi ?? 203;

    for (const entry of batch) {
        const copyIndex = entry.copyIndex;
        const sn = serial.enabled
            ? formatSerial(serial.start + copyIndex * serial.step, serial.pad, serial.prefix)
            : "";
        const vars = entry.vars;
        const lines = setupLines(settings);
        const readFieldName = rfidReadFieldName(settings.rfid);
        const hasResolvedReadValue = readFieldName
            ? varsHaveRfidReadValue(vars, readFieldName)
            : false;
        const needsStoredRfidRead = rfidReadElementsNeedStoredFormat(
            elements,
            settings.rfid,
            vars,
        );
        for (const el of elements) {
            if (
                readFieldName &&
                settings.rfid.readEnabled &&
                elementUsesRfidReadField(el, readFieldName) &&
                !hasResolvedReadValue
            ) {
                continue;
            }
            lines.push(...emitElement(el, sn, vars, dpi, settings.rfid));
        }
        if (settings.rfid.enabled) {
            const payload = resolveDynamicValue(
                settings.rfid.data || sn || defaultRfidPayload(elements),
                settings.rfid.fieldName,
                sn,
                vars,
            );
            const write = buildZebraRfidWriteCommand(
                settings.rfid,
                payload,
                settings.targetPrinterModel ?? settings.rfid.zebraModel,
            );
            if (write) lines.push(write);
        }
        if (settings.rfid.readEnabled) {
            if (needsStoredRfidRead) {
                const formatName = "R:RFIDREAD.ZPL";
                const dynamicFields = emitStoredRfidReadDynamicFields(
                    elements,
                    settings.rfid,
                    sn,
                    vars,
                    dpi,
                );
                lines.push(...dynamicFields.formatLines);
                const storedFormat = [
                    ...lines.slice(0, 1),
                    `^DF${formatName}^FS`,
                    ...lines.slice(1),
                    "^XZ",
                ];
                const recallLines = [
                    "^XA",
                    `^XF${formatName}^FS`,
                ];
                const read = buildZebraRfidReadCommand(settings.rfid);
                if (read) recallLines.push(read);
                recallLines.push(...dynamicFields.recallLines);
                recallLines.push(...finishLines(1));
                blocks.push(`${storedFormat.join("\n")}\n${recallLines.join("\n")}`);
                continue;
            }
            lines.push(...emitRfidReadDynamicFields(elements, settings.rfid, sn, vars, dpi));
            const read = buildZebraRfidReadCommand(settings.rfid);
            if (read) lines.push(read);
            lines.push(...emitRfidReadDynamicFields(
                elements,
                settings.rfid,
                sn,
                vars,
                dpi,
                1,
                "afterRead",
            ));
        }
        lines.push(...finishLines(1));
        blocks.push(lines.join("\n"));
    }

    return blocks.join("\n") + "\n";
}

export function buildTestZpl(
    settings: LabelSettings,
    alignment?: ZebraPrinterAlignment,
): string {
    const dpi = settings.dpi ?? 203;
    const m = (mm: number) => mmToDots(mm, dpi);
    const lines = setupLines(settings, { alignment });
    lines.push(`^FO${m(3)},${m(3)}^GB${m(34)},${m(16)},${Math.max(2, m(0.4))}^FS`);
    lines.push(`^FO${m(5)},${m(6)}^A0N,28,28^FDZEBRA TEST^FS`);
    lines.push(
        `^FO${m(5)},${m(12)}^A0N,22,22^FD${zplText(`${settings.widthMm}x${settings.heightMm} ZPL`)}^FS`,
    );
    lines.push(...finishLines(1));
    return lines.join("\n") + "\n";
}

export function buildGraphicsTestZpl(
    settings: LabelSettings,
    alignment?: ZebraPrinterAlignment,
): string {
    const widthDots = 64;
    const heightDots = 64;
    const widthBytes = 8;
    const bytes = new Uint8Array(widthBytes * heightDots);
    for (let y = 0; y < heightDots; y += 1) {
        for (let x = 0; x < widthDots; x += 1) {
            const isFrame = x < 4 || x >= widthDots - 4 || y < 4 || y >= heightDots - 4;
            const isCrossH = y >= heightDots / 2 - 2 && y < heightDots / 2 + 2;
            const isCrossV = x >= widthDots / 2 - 2 && x < widthDots / 2 + 2;
            if (isFrame || isCrossH || isCrossV) {
                bytes[y * widthBytes + (x >> 3)] |= 0x80 >>> (x & 7);
            }
        }
    }
    const dpi = settings.dpi ?? 203;
    const m = (mm: number) => mmToDots(mm, dpi);
    const lines = setupLines(settings, { alignment });
    const totalBytes = widthBytes * heightDots;
    lines.push(`^FO${m(3)},${m(3)}^GFA,${totalBytes},${totalBytes},${widthBytes},${hex(bytes)}^FS`);
    lines.push(`^FO${m(3)},${m(20)}^A0N,24,24^FDGFX TEST^FS`);
    lines.push(...finishLines(1));
    return lines.join("\n") + "\n";
}

export function buildCalibrationZpl(
    settings: LabelSettings,
    alignment?: ZebraPrinterAlignment,
): string {
    const dpi = settings.dpi ?? 203;
    const m = (mm: number) => mmToDots(mm, dpi);
    const lines = setupLines(settings, { alignment });
    const axisThick = Math.max(2, m(0.3));
    const widthMm = Math.max(10, settings.widthMm);
    const heightMm = Math.max(10, settings.heightMm);
    const xAxisYmm = 3;
    const yAxisXmm = widthMm - 3;

    lines.push(`^FO${m(0)},${m(xAxisYmm)}^GB${m(widthMm)},${axisThick},${axisThick}^FS`);
    for (let xMm = 0; xMm <= widthMm; xMm += 1) {
        const major = xMm % 5 === 0;
        const tickH = major ? 1.4 : 0.6;
        lines.push(`^FO${m(xMm)},${m(xAxisYmm)}^GB${axisThick},${m(tickH)},${axisThick}^FS`);
        if (major && xMm > 1 && xMm < yAxisXmm - 1) {
            lines.push(`^FO${m(xMm - 0.8)},${m(xAxisYmm + 2.2)}^A0N,16,16^FD${xMm}^FS`);
        }
    }

    lines.push(`^FO${m(yAxisXmm)},${m(0)}^GB${axisThick},${m(heightMm)},${axisThick}^FS`);
    for (let yMm = 0; yMm <= heightMm; yMm += 1) {
        const major = yMm % 5 === 0;
        const tickW = major ? 1.4 : 0.6;
        lines.push(`^FO${m(yAxisXmm)},${m(yMm)}^GB${m(tickW)},${axisThick},${axisThick}^FS`);
        if (major && yMm > xAxisYmm + 1 && yMm <= heightMm - 2) {
            lines.push(`^FO${m(yAxisXmm - 4)},${m(yMm - 1.5)}^A0N,16,16^FD${yMm}^FS`);
        }
    }

    lines.push(`^FO${m(yAxisXmm - 2.4)},${m(xAxisYmm - 2.4)}^A0N,20,20^FD0^FS`);
    lines.push(...finishLines(1));
    return lines.join("\n") + "\n";
}
