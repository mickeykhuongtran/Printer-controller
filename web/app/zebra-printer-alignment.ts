import {
    buildZebraSgdGetCommand,
    isUsableZebraSgdValue,
    parseZebraSgdMap,
} from "./zebra-rfid";

export const ZEBRA_LABEL_TOP_MIN = -120;
export const ZEBRA_LABEL_TOP_MAX = 120;
export const ZEBRA_LEFT_POSITION_MIN = -9999;
export const ZEBRA_LEFT_POSITION_MAX = 9999;

export const ZEBRA_ALIGNMENT_QUERY_KEYS = [
    "zpl.label_top",
    "zpl.left_position",
] as const;

export type ZebraPrinterAlignment = {
    labelTopDots: number;
    leftPositionDots: number;
};

function clampInteger(value: unknown, min: number, max: number): number {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

export function normalizeZebraPrinterAlignment(
    alignment: Partial<ZebraPrinterAlignment> | null | undefined,
): ZebraPrinterAlignment {
    return {
        labelTopDots: clampInteger(
            alignment?.labelTopDots,
            ZEBRA_LABEL_TOP_MIN,
            ZEBRA_LABEL_TOP_MAX,
        ),
        leftPositionDots: clampInteger(
            alignment?.leftPositionDots,
            ZEBRA_LEFT_POSITION_MIN,
            ZEBRA_LEFT_POSITION_MAX,
        ),
    };
}

export function buildZebraAlignmentGetCommand(): string {
    return buildZebraSgdGetCommand(ZEBRA_ALIGNMENT_QUERY_KEYS);
}

export function buildZebraAlignmentSetCommand(
    alignment: Partial<ZebraPrinterAlignment>,
): string {
    const normalized = normalizeZebraPrinterAlignment(alignment);
    return [
        `! U1 setvar "zpl.label_top" "${normalized.labelTopDots}"`,
        `! U1 setvar "zpl.left_position" "${normalized.leftPositionDots}"`,
    ].join("\n");
}

export function parseZebraAlignmentResponse(
    raw: string,
): ZebraPrinterAlignment | null {
    const values = parseZebraSgdMap(raw, ZEBRA_ALIGNMENT_QUERY_KEYS);
    const labelTop = values["zpl.label_top"];
    const leftPosition = values["zpl.left_position"];
    if (
        !isUsableZebraSgdValue(labelTop) ||
        !isUsableZebraSgdValue(leftPosition)
    ) {
        return null;
    }

    const parsedTop = Number(labelTop);
    const parsedLeft = Number(leftPosition);
    if (!Number.isFinite(parsedTop) || !Number.isFinite(parsedLeft)) return null;

    return normalizeZebraPrinterAlignment({
        labelTopDots: parsedTop,
        leftPositionDots: parsedLeft,
    });
}
