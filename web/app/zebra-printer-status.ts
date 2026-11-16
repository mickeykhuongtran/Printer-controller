export const ZEBRA_SYSTEM_STATUS_COMMAND =
    '! U1 getvar "zpl.system_status"\r\n';
export const ZEBRA_HQES_STATUS_COMMAND = "~HQES\r\n";
export const ZEBRA_HOST_STATUS_COMMAND = "~HS\r\n";

export type ZebraPrinterStatusLevel =
    | "ready"
    | "paused"
    | "warning"
    | "error";

export type ZebraPrinterStatus = {
    level: ZebraPrinterStatusLevel;
    paused: boolean;
    errors: string[];
    warnings: string[];
    reasons: string[];
    raw: string;
    fields: {
        pauseFlag: 0 | 1;
        errorFlag: 0 | 1;
        errorGroup2: string;
        errorGroup1: string;
        warningFlag: 0 | 1;
        warningGroup2: string;
        warningGroup1: string;
    };
};

export type ZebraHostStatus = {
    raw: string;
    frames: readonly [string, string, string];
    communicationSettings: number;
    paperOut: boolean;
    paused: boolean;
    labelLengthDots: number;
    formatsInReceiveBuffer: number;
    bufferFull: boolean;
    diagnosticMode: boolean;
    partialFormat: boolean;
    corruptRam: boolean;
    underTemperature: boolean;
    overTemperature: boolean;
    functionSettings: number;
    headUp: boolean;
    ribbonOut: boolean;
    thermalTransferMode: boolean;
    printMode: string;
    printWidthMode: number;
    labelWaiting: boolean;
    labelsRemaining: number;
    formatWhilePrinting: boolean;
    storedGraphics: number;
    password: string;
    staticRamInstalled: boolean;
};

type StatusBit = readonly [mask: number, label: string];

// Group 1 is the status map documented by Zebra for zpl.system_status/~HQES.
// The higher, kiosk-specific bits are harmless to decode on industrial/desktop models.
const ERROR_GROUP_1_BITS: readonly StatusBit[] = [
    [0x00000001, "Media out"],
    [0x00000002, "Ribbon out"],
    [0x00000004, "Printhead open"],
    [0x00000008, "Cutter fault"],
    [0x00000010, "Printhead over temperature"],
    [0x00000020, "Motor over temperature"],
    [0x00000040, "Bad printhead element"],
    [0x00000080, "Printhead detection error"],
    [0x00000100, "Invalid firmware configuration"],
    [0x00000200, "Printhead thermistor open"],
    [0x00010000, "Printer paused"],
    [0x00020000, "Retract function timed out"],
    [0x00040000, "Black-mark calibration error"],
    [0x00080000, "Black mark not found"],
    [0x00100000, "Paper jam during retract"],
    [0x00200000, "Presenter not running"],
    [0x00400000, "Paper feed error"],
    [0x00800000, "Clear paper path failed"],
];

const WARNING_GROUP_1_BITS: readonly StatusBit[] = [
    [0x00000001, "Media calibration required"],
    [0x00000002, "Clean printhead"],
    [0x00000004, "Replace printhead"],
    [0x00000008, "Media near end"],
    [0x00000010, "Paper detected before printhead"],
    [0x00000020, "Black-mark sensor active"],
    [0x00000040, "Paper detected after printhead"],
    [0x00000080, "Loop-ready sensor active"],
    [0x00000100, "Presenter sensor active"],
    [0x00000200, "Retract-ready sensor active"],
    [0x00000400, "Retract sensor active"],
    [0x00000800, "Bin sensor active"],
];

const STATUS_RESPONSE_PATTERN =
    /["']?([01])["']?\s*,\s*["']?([01])["']?\s*,\s*["']?([0-9a-f]{1,8})["']?\s*,\s*["']?([0-9a-f]{1,8})["']?\s*,\s*["']?([01])["']?\s*,\s*["']?([0-9a-f]{1,8})["']?\s*,\s*["']?([0-9a-f]{1,8})["']?/i;
const HQES_RESPONSE_PATTERN =
    /PRINTER\s+STATUS\s+ERRORS:\s*([01])\s+([0-9a-f]{1,8})\s+([0-9a-f]{1,8})\s+WARNINGS:\s*([01])\s+([0-9a-f]{1,8})\s+([0-9a-f]{1,8})/i;
const HOST_STATUS_FRAME_PATTERN = /\u0002([^\u0002\u0003]*)\u0003\r\n/g;

export function cleanZebraPrinterResponse(response: string): string {
    return response
        .replace(/[\u0000\u0002\u0003]/g, "")
        .replace(/\r\n?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function parseHex(value: string): number {
    return Number.parseInt(value, 16);
}

function decodeBits(value: number, definitions: readonly StatusBit[]): {
    labels: string[];
    unknown: number;
} {
    const labels: string[] = [];
    let decodedValue = 0;

    for (const [mask, label] of definitions) {
        if (Math.floor(value / mask) % 2 === 1) {
            labels.push(label);
            decodedValue += mask;
        }
    }

    return {
        labels,
        unknown: value - decodedValue,
    };
}

function hexReason(group: 1 | 2, value: number): string {
    return `Unmapped group ${group} status bits: 0x${value
        .toString(16)
        .toUpperCase()
        .padStart(8, "0")}`;
}

export function parseZebraPrinterStatus(response: string): ZebraPrinterStatus {
    const raw = cleanZebraPrinterResponse(response);
    if (!raw) {
        throw new Error("The Zebra printer returned an empty status response.");
    }

    const match = STATUS_RESPONSE_PATTERN.exec(raw);
    if (!match) {
        throw new Error(
            "The Zebra response is not a valid zpl.system_status payload (expected 7 fields).",
        );
    }

    const [
        ,
        pauseFlagText,
        errorFlagText,
        errorGroup2Text,
        errorGroup1Text,
        warningFlagText,
        warningGroup2Text,
        warningGroup1Text,
    ] = match;
    const pauseFlag = Number(pauseFlagText) as 0 | 1;
    const errorFlag = Number(errorFlagText) as 0 | 1;
    const warningFlag = Number(warningFlagText) as 0 | 1;
    const errorGroup1 = parseHex(errorGroup1Text);
    const errorGroup2 = parseHex(errorGroup2Text);
    const warningGroup1 = parseHex(warningGroup1Text);
    const warningGroup2 = parseHex(warningGroup2Text);

    // Zebra also reports an operator pause as error-group-1 bit 16 (~HQES).
    // Keep it separate from faults, including when a real fault coexists.
    const pauseBit = (errorGroup1 & 0x00010000) !== 0;
    const faultGroup1 = (errorGroup1 & ~0x00010000) >>> 0;
    const decodedErrors = decodeBits(faultGroup1, ERROR_GROUP_1_BITS);
    const decodedWarnings = decodeBits(warningGroup1, WARNING_GROUP_1_BITS);
    const errors = [...decodedErrors.labels];
    const warnings = [...decodedWarnings.labels];

    if (decodedErrors.unknown !== 0) {
        errors.push(hexReason(1, decodedErrors.unknown));
    }
    if (errorGroup2 !== 0) {
        errors.push(hexReason(2, errorGroup2));
    }
    if (decodedWarnings.unknown !== 0) {
        warnings.push(hexReason(1, decodedWarnings.unknown));
    }
    if (warningGroup2 !== 0) {
        warnings.push(hexReason(2, warningGroup2));
    }

    const hasError = (errorFlag === 1 && !pauseBit)
        || faultGroup1 !== 0 || errorGroup2 !== 0;
    const hasWarning =
        warningFlag === 1 || warningGroup1 !== 0 || warningGroup2 !== 0;

    if (hasError && errors.length === 0) {
        errors.push("Printer reported an unspecified error");
    }
    if (hasWarning && warnings.length === 0) {
        warnings.push("Printer reported an unspecified warning");
    }

    const paused = pauseFlag === 1 || pauseBit;
    const level: ZebraPrinterStatusLevel = hasError
        ? "error"
        : hasWarning
          ? "warning"
          : paused
            ? "paused"
            : "ready";
    const reasons = [
        ...(paused ? ["Printer is paused"] : []),
        ...errors,
        ...warnings,
    ];

    return {
        level,
        paused,
        errors,
        warnings,
        reasons: reasons.length > 0 ? reasons : ["Printer is ready"],
        raw,
        fields: {
            pauseFlag,
            errorFlag,
            errorGroup2: errorGroup2Text.toUpperCase().padStart(8, "0"),
            errorGroup1: errorGroup1Text.toUpperCase().padStart(8, "0"),
            warningFlag,
            warningGroup2: warningGroup2Text.toUpperCase().padStart(8, "0"),
            warningGroup1: warningGroup1Text.toUpperCase().padStart(8, "0"),
        },
    };
}

/** Parse the error/warning status returned by the Zebra ~HQES command. */
export function parseZebraHqesStatus(response: string): ZebraPrinterStatus {
    const raw = cleanZebraPrinterResponse(response);
    if (!raw) {
        throw new Error("The Zebra printer returned an empty ~HQES response.");
    }

    const match = HQES_RESPONSE_PATTERN.exec(raw);
    if (!match) {
        throw new Error(
            "The Zebra response is not a valid ~HQES payload (expected ERRORS and WARNINGS fields).",
        );
    }

    const [
        ,
        errorFlag,
        errorGroup2,
        errorGroup1,
        warningFlag,
        warningGroup2,
        warningGroup1,
    ] = match;
    const parsed = parseZebraPrinterStatus(
        `0,${errorFlag},${errorGroup2},${errorGroup1},${warningFlag},${warningGroup2},${warningGroup1}`,
    );

    // ~HQES exposes pause in error-group-1 bit 16; ~HS additionally reports
    // the standalone pause flag, checked by the drain barrier.
    return { ...parsed, raw };
}

function parseHostStatusDecimal(
    value: string,
    pattern: RegExp,
    fieldName: string,
): number {
    if (!pattern.test(value)) {
        throw new Error(`Invalid ~HS ${fieldName} field: ${JSON.stringify(value)}.`);
    }
    return Number.parseInt(value, 10);
}

function parseHostStatusFlag(value: string, fieldName: string): boolean {
    if (value !== "0" && value !== "1") {
        throw new Error(`Invalid ~HS ${fieldName} flag: ${JSON.stringify(value)}.`);
    }
    return value === "1";
}

function extractHostStatusFrames(response: string): [string, string, string] {
    if (!response) {
        throw new Error("The Zebra printer returned an empty ~HS response.");
    }

    const frames: string[] = [];
    let cursor = 0;
    HOST_STATUS_FRAME_PATTERN.lastIndex = 0;
    for (
        let match = HOST_STATUS_FRAME_PATTERN.exec(response);
        match;
        match = HOST_STATUS_FRAME_PATTERN.exec(response)
    ) {
        if (!/^\s*$/.test(response.slice(cursor, match.index))) {
            throw new Error("The Zebra ~HS response contains data outside its framed payloads.");
        }
        frames.push(match[1]);
        cursor = HOST_STATUS_FRAME_PATTERN.lastIndex;
    }

    if (!/^\s*$/.test(response.slice(cursor))) {
        throw new Error("The Zebra ~HS response has invalid STX/ETX framing.");
    }
    if (frames.length !== 3) {
        throw new Error(
            `The Zebra ~HS response must contain exactly 3 frames; received ${frames.length}.`,
        );
    }

    return [frames[0], frames[1], frames[2]];
}

/**
 * Parse all three framed records returned by ~HS. This deliberately rejects
 * incomplete/coalesced unrelated data so a truncated status cannot release a
 * print chunk early.
 */
export function parseZebraHostStatus(response: string): ZebraHostStatus {
    const frames = extractHostStatusFrames(response);
    const first = frames[0].split(",");
    const second = frames[1].split(",");
    const third = frames[2].split(",");

    if (first.length !== 12 || second.length !== 11 || third.length !== 2) {
        throw new Error(
            "The Zebra ~HS response has an invalid field count (expected 12, 11, and 2).",
        );
    }

    parseHostStatusDecimal(first[8], /^000$/, "unused string-1");
    parseHostStatusDecimal(second[1], /^\d$/, "unused string-2");
    if (!/^[0-9KSA]$/.test(second[5])) {
        throw new Error(
            `Invalid ~HS print mode field: ${JSON.stringify(second[5])}.`,
        );
    }
    if (!/^[^,\u0000-\u001f\u007f]{4}$/.test(third[0])) {
        throw new Error(
            `Invalid ~HS password field: ${JSON.stringify(third[0])}.`,
        );
    }

    return {
        raw: response,
        frames,
        communicationSettings: parseHostStatusDecimal(
            first[0],
            /^\d{3}$/,
            "communication settings",
        ),
        paperOut: parseHostStatusFlag(first[1], "paper out"),
        paused: parseHostStatusFlag(first[2], "pause"),
        labelLengthDots: parseHostStatusDecimal(first[3], /^\d{4}$/, "label length"),
        formatsInReceiveBuffer: parseHostStatusDecimal(
            first[4],
            /^\d{3}$/,
            "formats in receive buffer",
        ),
        bufferFull: parseHostStatusFlag(first[5], "buffer full"),
        diagnosticMode: parseHostStatusFlag(first[6], "diagnostic mode"),
        partialFormat: parseHostStatusFlag(first[7], "partial format"),
        corruptRam: parseHostStatusFlag(first[9], "corrupt RAM"),
        underTemperature: parseHostStatusFlag(first[10], "under temperature"),
        overTemperature: parseHostStatusFlag(first[11], "over temperature"),
        functionSettings: parseHostStatusDecimal(
            second[0],
            /^\d{3}$/,
            "function settings",
        ),
        headUp: parseHostStatusFlag(second[2], "head up"),
        ribbonOut: parseHostStatusFlag(second[3], "ribbon out"),
        thermalTransferMode: parseHostStatusFlag(second[4], "thermal transfer mode"),
        printMode: second[5],
        printWidthMode: parseHostStatusDecimal(second[6], /^\d$/, "print width mode"),
        labelWaiting: parseHostStatusFlag(second[7], "label waiting"),
        labelsRemaining: parseHostStatusDecimal(
            second[8],
            /^\d{8}$/,
            "labels remaining",
        ),
        formatWhilePrinting: parseHostStatusFlag(second[9], "format while printing"),
        storedGraphics: parseHostStatusDecimal(second[10], /^\d{3}$/, "stored graphics"),
        password: third[0],
        staticRamInstalled: parseHostStatusFlag(third[1], "static RAM installed"),
    };
}

export function isZebraHostStatusDrained(status: ZebraHostStatus): boolean {
    return status.formatsInReceiveBuffer === 0
        && !status.bufferFull
        && !status.partialFormat
        && status.labelsRemaining === 0
        && !status.labelWaiting;
}
