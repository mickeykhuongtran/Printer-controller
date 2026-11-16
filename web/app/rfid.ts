// RFID encoding helpers — friendly preset → low-level RfidSettings.

import type { RfidChipType, RfidSettings } from "./types";

// Common UHF Gen2 chips. EPC bit lengths are the typical default — many chips
// support multiple sizes via PC-bit configuration but we use the most common
// factory default so the user gets the right amount of zero-padding.
export const RFID_CHIPS: Array<{
    value: RfidChipType;
    label: string;
    epcBits: number;
    description?: string;
}> = [
    { value: "epc_96", label: "Standard EPC · 96-bit", epcBits: 96, description: "Generic Gen2 96-bit EPC" },
    { value: "nxp_ucode_9", label: "NXP UCODE 9", epcBits: 96, description: "NXP Gen2v2, 96-bit EPC" },
    { value: "nxp_ucode_8m", label: "NXP UCODE 8m", epcBits: 128, description: "NXP, 128-bit EPC" },
    { value: "impinj_m730", label: "Impinj M730", epcBits: 96 },
    { value: "impinj_m750", label: "Impinj M750", epcBits: 128 },
    { value: "impinj_monza_r6", label: "Impinj Monza R6", epcBits: 96 },
    { value: "alien_higgs_9", label: "Alien Higgs-9", epcBits: 128 },
    { value: "quanray_qstar_7u", label: "Quanray QSTAR-7U", epcBits: 96 },
    { value: "manual", label: "Manual (custom bits)", epcBits: 96 },
];

export function epcBitsForChip(chip: RfidChipType): number {
    return RFID_CHIPS.find((c) => c.value === chip)?.epcBits ?? 96;
}

// Pad a hex EPC payload to a target bit length. Left-padded with 0s
// when shorter (so a numeric value like "2" becomes "0000…0002" — interpreted
// as a 96-bit integer). Oversized values are deliberately preserved so the
// preview and validator expose the mismatch instead of hiding the first words.
//
// If the input contains characters that aren't valid hex (e.g. "PAL2"), it is
// interpreted as ASCII and converted byte-by-byte to its hex representation
// ("PAL2" → "50414C32"), then padded/truncated like a normal hex EPC. This
// matches user expectation — "convert text to hex" — instead of silently
// stripping the alpha chars. The printer write path separately rejects
// non-hex input when Hex mode is selected.
export function padEpcToBits(input: string, bits: number): string {
    const targetChars = Math.max(0, Math.floor(bits / 4));
    const trimmed = input.replace(/\s+/g, "");
    const isPureHex = /^[0-9a-fA-F]*$/.test(trimmed);
    let cleaned: string;
    if (isPureHex) {
        cleaned = trimmed.toUpperCase();
    } else {
        let hex = "";
        for (let i = 0; i < input.length; i += 1) {
            const code = input.charCodeAt(i) & 0xff;
            hex += code.toString(16).toUpperCase().padStart(2, "0");
        }
        cleaned = hex;
    }
    if (cleaned.length >= targetChars) return cleaned;
    return cleaned.padStart(targetChars, "0");
}

function wordAlignedHexLength(chars: number): number {
    return Math.max(4, Math.ceil(Math.max(0, chars) / 4) * 4);
}

function hexFromAscii(text: string): string {
    let hex = "";
    for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i) & 0xff;
        hex += code.toString(16).toUpperCase().padStart(2, "0");
    }
    return hex;
}

function autoBitsFromHexPayload(data: string): number {
    const compact = data.replace(/\s+/g, "");
    const hex = /^[0-9a-fA-F]*$/.test(compact)
        ? compact
        : hexFromAscii(data);
    return wordAlignedHexLength(hex.length) * 4;
}

function autoBitsFromAsciiPayload(data: string): number {
    return Math.max(16, Math.ceil(Math.max(0, data.length) / 2) * 16);
}

function wordAlignedBits(bits: number): number {
    return Math.max(16, Math.floor(Math.max(0, bits) / 16) * 16);
}

export function inferEpcBitsFromData(data: string, fmt: "A" | "H"): number {
    if (fmt === "A") return autoBitsFromAsciiPayload(data);
    return autoBitsFromHexPayload(data);
}

export function rfidBitsForData(rfid: RfidSettings, data: string): number {
    if (rfid.autoEpcBitsFromData) {
        return inferEpcBitsFromData(data, rfid.format === "A" ? "A" : "H");
    }
    return wordAlignedBits(rfid.epcBits && rfid.epcBits > 0 ? rfid.epcBits : rfid.words * 16);
}

export function rfidPayloadForPreview(rfid: RfidSettings, data: string): string {
    const fmt = rfid.format === "A" ? "A" : "H";
    const bits = rfidBitsForData(rfid, data);
    return fmt === "H" ? padEpcToBits(data, bits) : padEpcAsciiToBits(data, bits);
}

function clampedRfidInteger(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, Math.round(value)));
}

/**
 * Exact byte count emitted by a Zebra fixed-range ^RF read. Older templates
 * may only contain readLength (HEX characters), while current templates keep
 * zebraReadByteCount explicitly. Supporting both here keeps UI, preflight and
 * ZPL generation on one definition.
 */
export function zebraRfidFixedReadByteCount(rfid: RfidSettings): number {
    const legacyHexChars = clampedRfidInteger(rfid.readLength, 1, 128, 24);
    return clampedRfidInteger(
        rfid.zebraReadByteCount,
        1,
        64,
        Math.max(1, Math.ceil(legacyHexChars / 2)),
    );
}

/** Number of hexadecimal characters returned in the configured ^RF field. */
export function zebraRfidReadHexCharacterCount(rfid: RfidSettings): number {
    const pcMode = rfid.readBank !== "TID" &&
        (rfid.zebraEpcReadMode ?? "pc") === "pc";
    if (pcMode) {
        const epcBits = clampedRfidInteger(rfid.epcBits, 4, 496, 96);
        // EPC PC length is encoded in 16-bit words (maximum 31 words).
        return Math.max(1, Math.min(124, Math.ceil(epcBits / 4)));
    }
    return zebraRfidFixedReadByteCount(rfid) * 2;
}

// ASCII variant: pads with spaces or truncates so the byte count matches the
// configured bit length.
export function padEpcAsciiToBits(text: string, bits: number): string {
    const targetBytes = Math.max(0, Math.floor(bits / 8));
    if (text.length >= targetBytes) return text.slice(0, targetBytes);
    return text.padEnd(targetBytes, " ");
}

export function rfidSourceName(data: string | undefined): string | null {
    const match = (data ?? "").trim().match(/^\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
    return match?.[1] ?? null;
}

export function validateRfidHexValue(value: string, expectedBits?: number): {
    valid: boolean;
    normalized: string;
    reason?: string;
} {
    const normalized = value.replace(/\s+/g, "").toUpperCase();
    if (normalized.length === 0) {
        return { valid: false, normalized, reason: "Empty EPC data" };
    }
    if (!/^[0-9A-F]+$/.test(normalized)) {
        return { valid: false, normalized, reason: "EPC must be hexadecimal only" };
    }
    if (normalized.length % 4 !== 0) {
        return {
            valid: false,
            normalized,
            reason: `Hex length must be a multiple of 4 (${normalized.length} chars)`,
        };
    }
    if (expectedBits && expectedBits > 0) {
        const expectedChars = Math.max(1, Math.floor(expectedBits / 4));
        if (normalized.length !== expectedChars) {
            return {
                valid: false,
                normalized,
                reason: `Expected ${expectedChars} hex chars for ${expectedBits}-bit EPC, got ${normalized.length}`,
            };
        }
    }
    return { valid: true, normalized };
}

export type RfidPreset =
    | "hex_96"
    | "hex_64"
    | "hex_128"
    | "ascii"
    | "sgtin_96"
    | "custom";

export const RFID_PRESETS: Array<{ value: RfidPreset; label: string; hint: string }> = [
    { value: "hex_96", label: "Hex EPC · 96-bit", hint: "24 hex chars · 6 words" },
    { value: "hex_64", label: "Hex EPC · 64-bit", hint: "16 hex chars · 4 words" },
    { value: "hex_128", label: "Hex EPC · 128-bit", hint: "32 hex chars · 8 words" },
    { value: "ascii", label: "ASCII text", hint: "plain text" },
    { value: "sgtin_96", label: "SGTIN-96 (composer)", hint: "GS1 EPC tag · 96-bit" },
    { value: "custom", label: "Custom (advanced)", hint: "all knobs exposed" },
];

export type PresetParams = {
    preset: RfidPreset;
    // Hex / ASCII flow
    data: string;
    // SGTIN-96 composer
    companyPrefix: string;
    itemReference: string;
    serialNumber: string;
    filter: number;
};

export function defaultPresetParams(): PresetParams {
    return {
        preset: "hex_96",
        data: "",
        companyPrefix: "0614141",
        itemReference: "12345",
        serialNumber: "{serial}",
        filter: 1,
    };
}

// Detect which preset best matches an existing RfidSettings (after a doc load).
export function detectPreset(settings: RfidSettings): RfidPreset {
    if (settings.format === "A") return "ascii";
    if (settings.format === "H") {
        if (settings.words === 4) return "hex_64";
        if (settings.words === 6) return "hex_96";
        if (settings.words === 8) return "hex_128";
    }
    return "custom";
}

// Words required per preset.
function presetWords(preset: RfidPreset, params: PresetParams): number {
    switch (preset) {
        case "hex_64":
            return 4;
        case "hex_96":
        case "sgtin_96":
            return 6;
        case "hex_128":
            return 8;
        case "ascii":
            return Math.max(1, Math.ceil(params.data.length / 2));
        case "custom":
            return 4;
    }
}

function presetFormat(preset: RfidPreset): "A" | "H" {
    return preset === "ascii" ? "A" : "H";
}

// Apply preset → produce the data string and updated `format` + `words`.
export function applyPreset(
    base: RfidSettings,
    params: PresetParams,
): { settings: RfidSettings; encoded: string; valid: boolean; error?: string } {
    const preset = params.preset;
    const format = presetFormat(preset);
    const words = presetWords(preset, params);

    if (preset === "sgtin_96") {
        const result = encodeSgtin96(
            params.companyPrefix,
            params.itemReference,
            params.serialNumber,
            params.filter,
        );
        return {
            settings: { ...base, format, words, data: result.hex },
            encoded: result.hex,
            valid: result.valid,
            error: result.error,
        };
    }

    if (preset === "ascii") {
        return {
            settings: { ...base, format, words, data: params.data },
            encoded: params.data,
            valid: params.data.length > 0,
        };
    }

    // Hex presets: validate hex input, pad as needed.
    const targetChars = words * 4;
    const cleaned = params.data.replace(/[^0-9a-fA-F{}\\serial]/gi, "").toUpperCase();
    return {
        settings: { ...base, format, words, data: cleaned },
        encoded: cleaned,
        valid: cleaned.replace(/\{serial\}/gi, "0".repeat(8)).length === targetChars
            || cleaned.includes("{SERIAL}")
            || cleaned.includes("{serial}"),
        error:
            cleaned.length === 0
                ? "Empty"
                : cleaned.length > targetChars
                  ? `Too long (${cleaned.length}/${targetChars} chars)`
                  : cleaned.length < targetChars && !cleaned.toLowerCase().includes("{serial}")
                    ? `Short (${cleaned.length}/${targetChars} chars - will be padded with zeros)`
                    : undefined,
    };
}

// SGTIN-96 partition table per GS1 EPC Tag Data Standard.
const SGTIN_PARTITION = [
    { p: 0, prefixBits: 40, prefixDigits: 12, itemBits: 4, itemDigits: 1 },
    { p: 1, prefixBits: 37, prefixDigits: 11, itemBits: 7, itemDigits: 2 },
    { p: 2, prefixBits: 34, prefixDigits: 10, itemBits: 10, itemDigits: 3 },
    { p: 3, prefixBits: 30, prefixDigits: 9, itemBits: 14, itemDigits: 4 },
    { p: 4, prefixBits: 27, prefixDigits: 8, itemBits: 17, itemDigits: 5 },
    { p: 5, prefixBits: 24, prefixDigits: 7, itemBits: 20, itemDigits: 6 },
    { p: 6, prefixBits: 20, prefixDigits: 6, itemBits: 24, itemDigits: 7 },
];

function encodeSgtin96(
    companyPrefix: string,
    itemReference: string,
    serialRaw: string,
    filter: number,
): { hex: string; valid: boolean; error?: string } {
    const cp = companyPrefix.replace(/\D/g, "");
    const ir = itemReference.replace(/\D/g, "");
    if (cp.length < 6 || cp.length > 12) {
        return {
            hex: "0".repeat(24),
            valid: false,
            error: "Company prefix must be 6–12 digits",
        };
    }
    const partition = SGTIN_PARTITION.find((p) => p.prefixDigits === cp.length);
    if (!partition) {
        return {
            hex: "0".repeat(24),
            valid: false,
            error: "Invalid company prefix length",
        };
    }
    if (ir.length !== partition.itemDigits) {
        return {
            hex: "0".repeat(24),
            valid: false,
            error: `Item reference must be ${partition.itemDigits} digits for a ${cp.length}-digit prefix`,
        };
    }

    // Serial: parse as int. {serial} is left as a placeholder — the ZPL emitter
    // will substitute it at print time, so we encode with serial=0 here and
    // let the runtime serial substitution happen via {serial} text replacement.
    // For preview, we use 0 as default.
    const ZERO = BigInt(0);
    const ONE = BigInt(1);
    const serialIsPlaceholder = /\{(serial|step|n|counter|index)\}/i.test(serialRaw);
    const serialVal = serialIsPlaceholder
        ? ZERO
        : BigInt(serialRaw.replace(/\D/g, "") || "0");
    const max38 = ONE << BigInt(38);
    if (serialVal < ZERO || serialVal >= max38) {
        return {
            hex: "0".repeat(24),
            valid: false,
            error: "Serial must be 0 to 274,877,906,943 (38 bits)",
        };
    }

    // Build the 96-bit value.
    let bits = ZERO;
    bits = (bits << BigInt(8)) | BigInt(0x30); // header
    bits = (bits << BigInt(3)) | BigInt(filter & 7); // filter
    bits = (bits << BigInt(3)) | BigInt(partition.p & 7); // partition
    bits = (bits << BigInt(partition.prefixBits)) | BigInt(cp);
    bits = (bits << BigInt(partition.itemBits)) | BigInt(ir);
    bits = (bits << BigInt(38)) | serialVal;

    let hex = bits.toString(16).toUpperCase().padStart(24, "0");
    if (hex.length > 24) hex = hex.slice(-24);

    if (serialIsPlaceholder) {
        // Mark the last 10 hex chars (~38 bits ≈ 9.5 hex chars, rounded up) as
        // a placeholder so the user sees where their serial lands.
        return { hex: hex.slice(0, 14) + "{serial}", valid: true };
    }
    return { hex, valid: true };
}

// Public wrapper for the formula engine: returns { hex } or { error }.
export function encodeSgtin96Hex(
    companyPrefix: string,
    itemReference: string,
    serial: string,
    filter: number,
): { hex: string } | { error: string } {
    const r = encodeSgtin96(companyPrefix, itemReference, serial, filter);
    if (!r.valid) return { error: r.error ?? "Invalid SGTIN" };
    return { hex: r.hex };
}

// User-friendly SGTIN-96 encoder: takes a full barcode (EAN-13 or GTIN-14)
// and derives the GS1 company prefix + item reference using a partition.
//
// - barcode: EAN-13/GTIN-13 (13 digits) OR GTIN-14 (14 digits). The trailing
//   check digit is stripped automatically.
// - serial: serial number (0 to 274,877,906,943).
// - filter: 0-7 (default 1 = retail consumer trade item).
// - partition: 0-6 (default 5 → 7-digit GS1 company prefix). Determines how
//   the 13 digits (indicator + company-prefix + item-reference) are split.
//
// Partition table (digits → bits):
//   P=0: CP 12 / IIR 1   |  P=1: CP 11 / IIR 2  |  P=2: CP 10 / IIR 3
//   P=3: CP  9 / IIR 4   |  P=4: CP  8 / IIR 5  |  P=5: CP  7 / IIR 6
//   P=6: CP  6 / IIR 7
export function encodeSgtin96FromBarcode(
    barcode: string,
    serial: string,
    filter = 1,
    partition?: number,
): { hex: string } | { error: string } {
    const digits = barcode.replace(/\D/g, "");
    if (digits.length !== 13 && digits.length !== 14) {
        return {
            error: `Barcode must be 13 (EAN/GTIN-13) or 14 (GTIN-14) digits, got ${digits.length}`,
        };
    }
    // Strip trailing check digit.
    const noCheck = digits.slice(0, -1);
    // Normalise to 13 digits (indicator + 12 company/item digits).
    // EAN-13 has no explicit indicator → prepend 0.
    const thirteen = noCheck.length === 12 ? "0" + noCheck : noCheck;
    if (thirteen.length !== 13) {
        return { error: "Could not normalise barcode to 13 digits" };
    }

    const p = partition ?? 5;
    const partitionEntry = SGTIN_PARTITION.find((q) => q.p === p);
    if (!partitionEntry) {
        return { error: `Partition must be 0–6, got ${p}` };
    }
    const cpDigits = partitionEntry.prefixDigits;
    const iirDigits = 13 - cpDigits; // includes the indicator digit
    if (iirDigits !== partitionEntry.itemDigits) {
        // Sanity check (partition table covers cpDigits + itemDigits = 13).
    }

    const cp = thirteen.slice(0, cpDigits);
    const ir = thirteen.slice(cpDigits);

    const r = encodeSgtin96(cp, ir, serial, filter);
    if (!r.valid) return { error: r.error ?? "Invalid SGTIN" };
    return { hex: r.hex };
}
