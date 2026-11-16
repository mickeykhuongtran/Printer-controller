export const DEFAULT_DPI = 203 as const;

export function dotsPerMm(dpi: number = DEFAULT_DPI): number {
    if (dpi >= 600) return 24;
    if (dpi >= 300) return 12;
    return 8;
}

export function mmToDots(mm: number, dpi: number = DEFAULT_DPI): number {
    return Math.round(mm * dotsPerMm(dpi));
}

export function dotsToMm(dots: number, dpi: number = DEFAULT_DPI): number {
    return dots / dotsPerMm(dpi);
}

export function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

export function snap(value: number, step: number): number {
    if (step <= 0) return value;
    return Math.round(value / step) * step;
}

export function uid(prefix = "el"): string {
    const rnd = Math.random().toString(36).slice(2, 8);
    return `${prefix}_${Date.now().toString(36)}_${rnd}`;
}
