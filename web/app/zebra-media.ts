import type { PrinterDpi } from "./types";
import { mmToDots } from "./units";

export const ZEBRA_TEAR_OFF_DOTS_LIMIT = 120;

export function zebraTearOffDots(tearOffMm: number, dpi: PrinterDpi): number {
    const requestedDots = mmToDots(Number.isFinite(tearOffMm) ? tearOffMm : 0, dpi);
    const limitedDots = Math.max(
        -ZEBRA_TEAR_OFF_DOTS_LIMIT,
        Math.min(ZEBRA_TEAR_OFF_DOTS_LIMIT, requestedDots),
    );
    return dpi === 600
        ? Math.round(limitedDots / 2) * 2
        : Math.round(limitedDots);
}

export function formatZebraTearOff(value: number): string {
    const rounded = Math.round(
        Math.max(-ZEBRA_TEAR_OFF_DOTS_LIMIT, Math.min(ZEBRA_TEAR_OFF_DOTS_LIMIT, value)),
    );
    const magnitude = String(Math.abs(rounded)).padStart(3, "0");
    return rounded < 0 ? `-${magnitude}` : magnitude;
}

export function normalizeZebraTearOffDots(value: number): number {
    return Math.round(
        Math.max(
            -ZEBRA_TEAR_OFF_DOTS_LIMIT,
            Math.min(ZEBRA_TEAR_OFF_DOTS_LIMIT, Number.isFinite(value) ? value : 0),
        ),
    );
}

export function buildZebraTearOffDotsCommand(tearOffDots: number): string {
    return `~TA${formatZebraTearOff(normalizeZebraTearOffDots(tearOffDots))}`;
}

export function buildZebraTearOffCommand(tearOffMm: number, dpi: PrinterDpi): string {
    return buildZebraTearOffDotsCommand(zebraTearOffDots(tearOffMm, dpi));
}
