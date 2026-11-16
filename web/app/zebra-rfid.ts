import type {
    RfidReadBank,
    RfidSettings,
    ZebraRfidModel,
    ZebraRfidPositionMode,
} from "./types";
import { ZEBRA_PRINTER_MODELS } from "./printer-models";

export type ZebraRfidModelOption = {
    value: ZebraRfidModel;
    label: string;
    multiAntenna: boolean;
};

const MULTI_ANTENNA_MODELS = new Set<ZebraRfidModel>([
    "zt411r",
    "zt421r",
    "zt610r",
    "zt620r",
]);

const AUTO_PC_EPC_MODELS = new Set<ZebraRfidModel>([
    "zt411r",
    "zt421r",
    "zt610r",
    "zt620r",
]);

export const ZEBRA_RFID_MODELS: ZebraRfidModelOption[] =
    ZEBRA_PRINTER_MODELS.map((profile) => ({
        value: profile.id,
        label: profile.label,
        multiAntenna: MULTI_ANTENNA_MODELS.has(profile.id),
    }));

export const ZEBRA_ANTENNAS = [
    "A1", "A2", "A3", "A4",
    "B1", "B2", "B3", "B4",
    "C1", "C2", "C3", "C4",
    "D1", "D2", "D3", "D4",
    "E1", "E2", "E3", "E4",
] as const;

export const ZEBRA_RFID_QUERY_KEYS = [
    "rfid.enable",
    "rfid.reader_1.model",
    "rfid.reader_1.firmware_version",
    "rfid.reader_1.hardware_version",
    "rfid.position.program",
    "rfid.reader_1.power.read",
    "rfid.reader_1.power.write",
    "rfid.reader_1.antenna_port",
    "rfid.adaptive_antenna",
    "rfid.region_code",
    "rfid.error.response",
    "odometer.rfid.valid_resettable",
    "odometer.rfid.void_resettable",
] as const;

export const ZEBRA_RFID_CONFIG_KEYS = [
    "rfid.position.program",
    "rfid.reader_1.power.read",
    "rfid.reader_1.power.write",
    "rfid.reader_1.antenna_port",
    "rfid.adaptive_antenna",
] as const;

export const ZEBRA_ADAPTIVE_ANTENNA_MIN_LABEL_MM = 51;

export type ZebraRfidSnapshotState =
    | "ready"
    | "partial"
    | "unconfigured"
    | "disabled"
    | "reader_unavailable";

export type ZebraRfidPrinterSnapshot = {
    values: Record<string, string>;
    patch: Partial<RfidSettings>;
    state: ZebraRfidSnapshotState;
    readerDetected: boolean;
    enabled?: boolean;
    readerModel?: string;
    readerFirmware?: string;
    readerHardware?: string;
    programPosition?: string;
    readPower?: number;
    writePower?: number;
    antenna?: string;
    adaptiveAntenna?: "none" | "neighbors";
    region?: string;
    errorStatus?: string;
    validCount?: number;
    voidCount?: number;
    unavailableKeys: string[];
};

export type ZebraRfidSgdConfigOptions = {
    allowAdaptiveAntenna?: boolean;
};

export type ZebraRfidConfigMismatch = {
    key: string;
    expected: string;
    actual?: string;
};

export const ZEBRA_MEDIA_QUERY_KEYS = [
    "ezpl.print_width",
    "zpl.label_length",
    "ezpl.tear_off",
    "media.speed",
    "print.tone",
    "ezpl.media_type",
    "ezpl.print_method",
] as const;

function finite(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
    return Math.max(min, Math.min(max, Math.round(finite(value, fallback))));
}

function strictInteger(
    value: string | undefined,
    min: number,
    max: number,
): number | undefined {
    if (!isUsableZebraSgdValue(value)) return undefined;
    const normalized = value.trim();
    if (!/^-?\d+$/.test(normalized)) return undefined;
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
        ? parsed
        : undefined;
}

function usableValue(value: string | undefined): string | undefined {
    return isUsableZebraSgdValue(value) ? value.trim() : undefined;
}

export function zebraRfidModelOption(model: ZebraRfidModel | undefined): ZebraRfidModelOption {
    return ZEBRA_RFID_MODELS.find((option) => option.value === model) ?? ZEBRA_RFID_MODELS[0];
}

/** ZT400/ZT600 support ^RF memory bank A, which updates EPC PC length bits. */
export function zebraRfidSupportsAutoPcBits(
    model: ZebraRfidModel | undefined,
): boolean {
    return !!model && AUTO_PC_EPC_MODELS.has(model);
}

export function inferZebraRfidModel(value: string): ZebraRfidModel {
    const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const option of ZEBRA_RFID_MODELS) {
        if (option.value === "auto" || option.value === "other_link_os") continue;
        if (normalized.includes(option.value.replace(/r$/, ""))) return option.value;
    }
    return "auto";
}

export function zebraProgramPosition(rfid: RfidSettings): string | null {
    const mode = rfid.zebraPositionMode ?? "calibrated";
    if (mode === "calibrated") return null;
    const max = mode === "backward" ? 30 : 999;
    const distance = clampInt(rfid.writePositionMm, 0, max, 0);
    return `${mode === "backward" ? "B" : "F"}${distance}`;
}

export function parseZebraProgramPosition(value: string): {
    mode: ZebraRfidPositionMode;
    distanceMm?: number;
} {
    const normalized = normalizeZebraProgramPosition(value);
    const match = normalized?.match(/^([FB])(\d{1,3})$/);
    if (!match) return { mode: "calibrated" };
    return {
        mode: match[1] === "B" ? "backward" : "forward",
        distanceMm: Number(match[2]),
    };
}

export function normalizeZebraProgramPosition(value: string | undefined): string | null {
    const match = (value ?? "").trim().toUpperCase().match(/^([FB])(\d{1,3})$/);
    if (!match) return null;
    const distance = Number(match[2]);
    if (!Number.isSafeInteger(distance)) return null;
    if (match[1] === "B" && distance > 30) return null;
    if (match[1] === "F" && distance > 999) return null;
    return `${match[1]}${distance}`;
}

export function buildZebraSgdGetCommand(keys: readonly string[]): string {
    return keys.map((key) => `! U1 getvar "${key}"`).join("\n");
}

export function buildZebraJsonGetCommand(keys: readonly string[]): string {
    const request = Object.fromEntries(keys.map((key) => [key, null]));
    return `{}` + JSON.stringify(request);
}

function jsonObjects(raw: string): unknown[] {
    const text = raw
        .replace(/\0/g, "")
        .replace(/[\x01-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "");
    const objects: unknown[] = [];
    for (let start = 0; start < text.length; start += 1) {
        if (text[start] !== "{") continue;
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === "\\") escaped = true;
                else if (char === "\"") inString = false;
                continue;
            }
            if (char === "\"") {
                inString = true;
                continue;
            }
            if (char === "{") depth += 1;
            else if (char === "}") {
                depth -= 1;
                if (depth !== 0) continue;
                try {
                    objects.push(JSON.parse(text.slice(start, index + 1)));
                } catch {
                    // A printer may echo the JSON request prefix before its
                    // response. Continue scanning for the next complete object.
                }
                start = index;
                break;
            }
        }
    }
    return objects;
}

function flattenJsonValues(
    value: unknown,
    result: Record<string, string>,
    prefix = "",
): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
            flattenJsonValues(entry, result, path);
            continue;
        }
        const targetKey = key.includes(".") ? key : path;
        if (entry === null || entry === undefined) result[targetKey] = "";
        else if (
            typeof entry === "string"
            || typeof entry === "number"
            || typeof entry === "boolean"
        ) {
            result[targetKey] = String(entry);
        }
    }
}

export function parseZebraJsonMap(
    raw: string,
    keys: readonly string[] = ZEBRA_RFID_QUERY_KEYS,
): Record<string, string> {
    const flattened: Record<string, string> = {};
    for (const object of jsonObjects(raw)) flattenJsonValues(object, flattened);
    const result: Record<string, string> = {};
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(flattened, key)) {
            result[key] = flattened[key];
        }
    }
    return result;
}

export function parseZebraSgdValues(raw: string): string[] {
    const lines = raw
        .replace(/\0/g, "")
        // Zebra host responses may be framed with STX/ETX and other C0
        // controls. Keep CR/LF as delimiters but never let framing bytes make
        // a numeric or antenna value fail validation.
        .replace(/[\x01-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "")
        .replace(/\r/g, "\n")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^!\s*U1\s+/i.test(line));

    return lines.map((line) => {
        const quoted = line.match(/^"([\s\S]*)"$/);
        return (quoted?.[1] ?? line).trim();
    });
}

export function parseZebraSgdMap(
    raw: string,
    keys: readonly string[],
): Record<string, string> {
    const values = parseZebraSgdValues(raw);
    const result: Record<string, string> = {};
    keys.forEach((key, index) => {
        const value = values[index];
        if (value !== undefined) result[key] = value;
    });
    return result;
}

export function isUsableZebraSgdValue(value: string | undefined): value is string {
    const normalized = (value ?? "").trim().toLowerCase();
    return !!normalized
        && normalized !== "?"
        && normalized !== "n/a"
        && normalized !== "not supported"
        && !normalized.includes("unknown variable");
}

export function zebraRfidPatchFromSgd(raw: string): {
    patch: Partial<RfidSettings>;
    values: Record<string, string>;
} {
    const values = parseZebraSgdMap(raw, ZEBRA_RFID_QUERY_KEYS);
    return {
        patch: zebraRfidPatchFromValues(values),
        values,
    };
}

export function zebraRfidPatchFromValues(
    values: Record<string, string>,
): Partial<RfidSettings> {
    const patch: Partial<RfidSettings> = {};
    const rawPosition = normalizeZebraProgramPosition(values["rfid.position.program"]);
    if (rawPosition) {
        const position = parseZebraProgramPosition(rawPosition);
        patch.zebraPositionMode = position.mode;
        if (position.distanceMm !== undefined) patch.writePositionMm = position.distanceMm;
    }

    const readPower = strictInteger(values["rfid.reader_1.power.read"], 0, 30);
    if (readPower !== undefined) patch.zebraReadPower = readPower;
    const writePower = strictInteger(values["rfid.reader_1.power.write"], 0, 30);
    if (writePower !== undefined) patch.zebraWritePower = writePower;

    const antenna = (values["rfid.reader_1.antenna_port"] ?? "").trim().toUpperCase();
    if (/^[A-E][1-4]$/.test(antenna)) patch.zebraAntenna = antenna;
    const adaptiveAntenna = (values["rfid.adaptive_antenna"] ?? "").trim().toLowerCase();
    if (adaptiveAntenna === "neighbors") patch.zebraAdaptiveAntenna = true;
    else if (adaptiveAntenna === "none") patch.zebraAdaptiveAntenna = false;
    return patch;
}

function parseOnOff(value: string | undefined): boolean | undefined {
    const normalized = (value ?? "").trim().toLowerCase();
    if (normalized === "on" || normalized === "true" || normalized === "1") return true;
    if (normalized === "off" || normalized === "false" || normalized === "0") return false;
    return undefined;
}

export function zebraRfidSnapshotFromValues(
    values: Record<string, string>,
): ZebraRfidPrinterSnapshot {
    const readerModel = usableValue(values["rfid.reader_1.model"]);
    const readerFirmware = usableValue(values["rfid.reader_1.firmware_version"]);
    const readerHardware = usableValue(values["rfid.reader_1.hardware_version"]);
    const readerDetected = !!(readerModel || readerFirmware || readerHardware);
    const enabled = parseOnOff(values["rfid.enable"]);
    const programPosition = normalizeZebraProgramPosition(values["rfid.position.program"])
        ?? undefined;
    const readPower = strictInteger(values["rfid.reader_1.power.read"], 0, 30);
    const writePower = strictInteger(values["rfid.reader_1.power.write"], 0, 30);
    const rawAntenna = usableValue(values["rfid.reader_1.antenna_port"])?.toUpperCase();
    const antenna = rawAntenna && /^[A-E][1-4]$/.test(rawAntenna)
        ? rawAntenna
        : undefined;
    const rawAdaptive = usableValue(values["rfid.adaptive_antenna"])?.toLowerCase();
    const adaptiveAntenna = rawAdaptive === "neighbors" || rawAdaptive === "none"
        ? rawAdaptive
        : undefined;
    const configuredCount = [
        programPosition,
        readPower,
        writePower,
        antenna,
    ].filter((value) => value !== undefined).length;
    const state: ZebraRfidSnapshotState = enabled === false
        ? "disabled"
        : !readerDetected && configuredCount === 0
            ? "reader_unavailable"
            : configuredCount === 0
                ? "unconfigured"
                : configuredCount === 4
                    ? "ready"
                    : "partial";

    return {
        values: { ...values },
        patch: zebraRfidPatchFromValues(values),
        state,
        readerDetected,
        enabled,
        readerModel,
        readerFirmware,
        readerHardware,
        programPosition,
        readPower,
        writePower,
        antenna,
        adaptiveAntenna,
        region: usableValue(values["rfid.region_code"]),
        errorStatus: usableValue(values["rfid.error.response"]),
        validCount: strictInteger(
            values["odometer.rfid.valid_resettable"],
            0,
            Number.MAX_SAFE_INTEGER,
        ),
        voidCount: strictInteger(
            values["odometer.rfid.void_resettable"],
            0,
            Number.MAX_SAFE_INTEGER,
        ),
        unavailableKeys: ZEBRA_RFID_QUERY_KEYS.filter(
            (key) => !isUsableZebraSgdValue(values[key]),
        ),
    };
}

export function zebraRfidSgdConfigValues(
    rfid: RfidSettings,
    options: ZebraRfidSgdConfigOptions = {},
): Record<string, string> {
    const values: Record<string, string> = {};
    const position = zebraProgramPosition(rfid);
    if (position) values["rfid.position.program"] = position;

    // Live printer configuration must never inherit a legacy template/lab
    // reference implicitly. Only explicit Zebra overrides are persisted.
    const readPower = finite(rfid.zebraReadPower, -1);
    const writePower = finite(rfid.zebraWritePower, -1);
    if (readPower >= 0) {
        values["rfid.reader_1.power.read"] = String(clampInt(readPower, 0, 30, 16));
    }
    if (writePower >= 0) {
        values["rfid.reader_1.power.write"] = String(clampInt(writePower, 0, 30, 16));
    }

    const profile = zebraRfidModelOption(rfid.zebraModel);
    const antenna = (rfid.zebraAntenna ?? "").toUpperCase();
    if ((profile.multiAntenna || rfid.zebraModel === "auto") && /^[A-E][1-4]$/.test(antenna)) {
        values["rfid.reader_1.antenna_port"] = antenna;
    }
    const supportsMultipleAntenna = profile.multiAntenna || rfid.zebraModel === "auto";
    if (
        supportsMultipleAntenna
        && typeof rfid.zebraAdaptiveAntenna === "boolean"
    ) {
        values["rfid.adaptive_antenna"] =
            rfid.zebraAdaptiveAntenna && options.allowAdaptiveAntenna !== false
            ? "neighbors"
            : "none";
    }
    return values;
}

export function buildZebraRfidSgdConfigCommand(
    rfid: RfidSettings,
    options: ZebraRfidSgdConfigOptions = {},
): string {
    return Object.entries(zebraRfidSgdConfigValues(rfid, options))
        .map(([key, value]) => `! U1 setvar "${key}" "${value}"`)
        .join("\n");
}

function comparableConfigValue(key: string, value: string | undefined): string | undefined {
    if (!isUsableZebraSgdValue(value)) return undefined;
    if (
        key === "rfid.reader_1.power.read"
        || key === "rfid.reader_1.power.write"
    ) {
        const parsed = strictInteger(value, 0, 30);
        return parsed === undefined ? undefined : String(parsed);
    }
    return value.trim().toUpperCase();
}

export function zebraRfidConfigMismatches(
    expected: Record<string, string>,
    actual: Record<string, string>,
): ZebraRfidConfigMismatch[] {
    const mismatches: ZebraRfidConfigMismatch[] = [];
    for (const [key, expectedValue] of Object.entries(expected)) {
        if (
            comparableConfigValue(key, expectedValue)
            !== comparableConfigValue(key, actual[key])
        ) {
            mismatches.push({
                key,
                expected: expectedValue,
                actual: actual[key],
            });
        }
    }
    return mismatches;
}

export function buildZebraRfidSgdTagReadStartCommand(bank: RfidReadBank): string {
    const content = bank === "TID" ? "tid information" : "epc";
    return [
        `! U1 setvar "rfid.tag.read.content" "${content}"`,
        `! U1 setvar "rfid.tag.read.execute"`,
    ].join("\n");
}

export function buildZebraRfidSgdTagReadResultCommand(): string {
    return [
        `! U1 getvar "rfid.tag.read.result_line1"`,
        `! U1 getvar "rfid.tag.read.result_line2"`,
        `! U1 getvar "rfid.tag.data"`,
    ].join("\n");
}

export function buildZebraRfidSgdTagReadCommand(bank: RfidReadBank): string {
    return [
        buildZebraRfidSgdTagReadStartCommand(bank),
        buildZebraRfidSgdTagReadResultCommand(),
    ].join("\n");
}

export function parseZebraRfidTagData(raw: string): string | null {
    const values = parseZebraSgdValues(raw);
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const matches = values[index].match(/[0-9A-Fa-f][0-9A-Fa-f .:-]{6,}/g) ?? [];
        const candidates = matches
            .map((value) => value.replace(/[^0-9A-Fa-f]/g, "").toUpperCase())
            .filter((value) => value.length >= 8 && value.length % 2 === 0)
            .sort((a, b) => b.length - a.length);
        if (candidates[0]) return candidates[0];
    }
    return null;
}

export function parseZebraRfidHostReadData(raw: string): string | null {
    const normalized = raw.replace(/\0/g, "").replace(/\r/g, "\n");
    const matches = Array.from(
        normalized.matchAll(/(?:^|\n)\s*DATA:\s*([0-9A-Fa-f][0-9A-Fa-f .:-]*)/gi),
    );
    for (let index = matches.length - 1; index >= 0; index -= 1) {
        const data = (matches[index][1] ?? "").replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
        if (data.length >= 2 && data.length % 2 === 0) return data;
    }
    return null;
}
