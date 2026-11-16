import type { TextFitMode, TextWrapMode } from "./types";

export const DEFAULT_TEXT_LINE_HEIGHT = 1.05;

export function getTextWrapMode(mode: TextWrapMode | undefined): TextWrapMode {
    return mode ?? "none";
}

export function getTextFitMode(mode: TextFitMode | undefined): TextFitMode {
    return mode ?? "clip";
}

export function textUsesFrame(mode: TextWrapMode | undefined, fit: TextFitMode | undefined): boolean {
    return getTextWrapMode(mode) !== "none" || getTextFitMode(fit) === "shrink";
}

export function addLetterSpacingToWidth(width: number, text: string, letterSpacingPx = 0): number {
    const chars = Array.from(text).length;
    if (chars <= 1 || letterSpacingPx === 0) return Math.max(0, width);
    return Math.max(0, width + letterSpacingPx * (chars - 1));
}

function wrapWords(paragraph: string, maxWidth: number, measure: (value: string) => number): string[] {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [""];
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
        const candidate = line ? `${line} ${word}` : word;
        if (line && measure(candidate) > maxWidth) {
            lines.push(line);
            line = word;
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line);
    return lines;
}

function wrapAnywhere(paragraph: string, maxWidth: number, measure: (value: string) => number): string[] {
    const lines: string[] = [];
    let line = "";
    for (const ch of Array.from(paragraph)) {
        if (!line && /\s/.test(ch)) continue;
        const candidate = line + ch;
        if (line && measure(candidate) > maxWidth) {
            lines.push(line.trimEnd());
            line = ch.trimStart();
        } else {
            line = candidate;
        }
    }
    if (line) lines.push(line.trimEnd());
    return lines.length ? lines : [""];
}

export function wrapTextToWidth(
    text: string,
    maxWidth: number,
    measure: (value: string) => number,
    mode: TextWrapMode,
): string[] {
    const paragraphs = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    if (mode === "none") return paragraphs;
    const width = Math.max(1, maxWidth);
    const out: string[] = [];
    for (const paragraph of paragraphs) {
        if (!paragraph) {
            out.push("");
            continue;
        }
        const lines =
            mode === "anywhere"
                ? wrapAnywhere(paragraph, width, measure)
                : wrapWords(paragraph, width, measure);
        out.push(...lines);
    }
    return out.length ? out : [""];
}

export type TextFrameLayout = {
    fontPx: number;
    lineHeightPx: number;
    lines: string[];
    widestPx: number;
    totalHeightPx: number;
};

export function layoutTextInFrame({
    text,
    baseFontPx,
    frameWidthPx,
    frameHeightPx,
    wrapMode,
    fitMode,
    lineHeightRatio = DEFAULT_TEXT_LINE_HEIGHT,
    minFontPx = 5,
    createMeasure,
}: {
    text: string;
    baseFontPx: number;
    frameWidthPx: number;
    frameHeightPx: number;
    wrapMode: TextWrapMode;
    fitMode: TextFitMode;
    lineHeightRatio?: number;
    minFontPx?: number;
    createMeasure: (fontPx: number) => (value: string) => number;
}): TextFrameLayout {
    const width = Math.max(1, frameWidthPx);
    const height = Math.max(1, frameHeightPx);
    const base = Math.max(1, baseFontPx);
    const min = Math.max(1, Math.min(minFontPx, base));

    const compute = (fontPx: number): TextFrameLayout => {
        const measure = createMeasure(fontPx);
        const lines = wrapTextToWidth(text, width, measure, wrapMode);
        const lineHeightPx = Math.max(1, fontPx * lineHeightRatio);
        const widestPx = lines.reduce(
            (max, line) => Math.max(max, measure(line || " ")),
            0,
        );
        return {
            fontPx,
            lineHeightPx,
            lines,
            widestPx,
            totalHeightPx: lineHeightPx * Math.max(1, lines.length),
        };
    };

    let best = compute(base);
    const fits = (layout: TextFrameLayout) =>
        layout.totalHeightPx <= height + 0.01 && layout.widestPx <= width + 0.01;

    if (fitMode !== "shrink" || fits(best)) return best;

    let low = min;
    let high = base;
    best = compute(min);
    for (let i = 0; i < 14; i += 1) {
        const mid = (low + high) / 2;
        const current = compute(mid);
        if (fits(current)) {
            best = current;
            low = mid;
        } else {
            high = mid;
        }
    }
    return best;
}
