"use client";

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import type { TextEl } from "../../types";
import { rotationFrame } from "../../rotation";
import { textContentFrame } from "../../text-margin";
import { dotsToMm } from "../../units";
import { fontStackFor } from "../../fonts";
import {
    addLetterSpacingToWidth,
    getTextFitMode,
    getTextWrapMode,
    layoutTextInFrame,
} from "../../text-flow";
import type { VariableSuggestion } from "../HighlightedField";

const BUILTIN_SUGGESTIONS: VariableSuggestion[] = [
    { name: "step", source: "builtin" },
    { name: "serial", source: "builtin" },
    { name: "n", source: "builtin" },
    { name: "counter", source: "builtin" },
    { name: "index", source: "builtin" },
];

// Zebra ZPL bitmap font dimensions in dots at 203 DPI.
const FONT_DOTS: Record<TextEl["font"], { h: number; w: number }> = {
    A: { h: 9, w: 5 },
    B: { h: 12, w: 7 },
    D: { h: 18, w: 10 },
    E: { h: 28, w: 15 },
};

const DPI = 203;

// Match any {ident} placeholder. Resolution: known names get blue, unknown
// names get red so the user sees typos immediately.
const ANY_VAR_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

const BUILTIN_NAMES = new Set([
    "serial",
    "step",
    "n",
    "counter",
    "index",
]);

function renderLine(
    line: string,
    baseKey: string,
    knownNames: Set<string>,
): ReactElement[] {
    if (!line) return [<span key={`${baseKey}-empty`}>{" "}</span>];
    const parts: ReactElement[] = [];
    let lastIndex = 0;
    let i = 0;
    const re = new RegExp(ANY_VAR_RE.source, "g");
    let match: RegExpExecArray | null;
    while ((match = re.exec(line)) !== null) {
        if (match.index > lastIndex) {
            parts.push(
                <span key={`${baseKey}-${i++}`}>
                    {line.slice(lastIndex, match.index)}
                </span>,
            );
        }
        const name = match[1];
        const known =
            BUILTIN_NAMES.has(name.toLowerCase()) || knownNames.has(name);
        parts.push(
            <span
                key={`${baseKey}-${i++}`}
                title={known ? undefined : "Unknown variable"}
                style={
                    known
                        ? {
                              color: "#1d4ed8",
                              fontWeight: 700,
                              background: "rgba(59, 130, 246, 0.12)",
                              borderRadius: 3,
                              padding: "0 2px",
                          }
                        : {
                              color: "#b91c1c",
                              fontWeight: 700,
                              background: "rgba(220, 38, 38, 0.12)",
                              borderRadius: 3,
                              padding: "0 2px",
                              textDecoration: "underline wavy",
                              textDecorationColor: "#dc2626",
                          }
                }
            >
                {match[0]}
            </span>,
        );
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < line.length) {
        parts.push(
            <span key={`${baseKey}-${i++}`}>{line.slice(lastIndex)}</span>,
        );
    }
    return parts;
}

interface Props {
    el: TextEl;
    pxPerMm: number;
    dpi: number;
    editing: boolean;
    highlightVars?: boolean;
    variables?: VariableSuggestion[];
    // When true, ignore web-font overrides and render every text element with
    // the Zebra bitmap-font fallback. Used by the Print step preview so the
    // user sees what'll actually print (the printer can't render web fonts —
    // they fall back to bitmap Font E).
    forcePrintFidelity?: boolean;
    onChange: (text: string) => void;
    onCommit: () => void;
}

export function TextElement({
    el,
    pxPerMm,
    dpi,
    editing,
    highlightVars = false,
    variables,
    forcePrintFidelity = false,
    onChange,
    onCommit,
}: Props) {
    const widthPx = el.size.w * pxPerMm;
    const heightPx = el.size.h * pxPerMm;
    const inputRef = useRef<HTMLTextAreaElement | null>(null);

    const allSuggestions = useMemo(() => {
        // De-duplicate by name. Prefer user-defined columns/formulas over the
        // built-in alias of the same name (e.g. a feed column called "step"
        // overrides the built-in "step").
        const seen = new Set<string>();
        const out: VariableSuggestion[] = [];
        for (const s of [...(variables ?? []), ...BUILTIN_SUGGESTIONS]) {
            const k = s.name.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(s);
        }
        return out;
    }, [variables]);
    const knownNames = useMemo(
        () => new Set((variables ?? []).map((v) => v.name)),
        [variables],
    );
    const [autocomplete, setAutocomplete] = useState<{
        prefix: string;
        startPos: number;
        selectedIdx: number;
    } | null>(null);
    const filtered = useMemo(() => {
        if (!autocomplete) return [];
        const p = autocomplete.prefix.toLowerCase();
        return allSuggestions
            .filter((s) => s.name.toLowerCase().startsWith(p))
            .slice(0, 12);
    }, [autocomplete, allSuggestions]);

    const updateAutocomplete = (input: HTMLTextAreaElement) => {
        const caret = input.selectionStart ?? 0;
        const value = input.value;
        let i = caret - 1;
        let foundOpen = -1;
        while (i >= 0) {
            const ch = value[i];
            if (ch === "}") break;
            if (ch === "{") {
                foundOpen = i;
                break;
            }
            if (!/[A-Za-z0-9_]/.test(ch)) break;
            i -= 1;
        }
        if (foundOpen < 0) {
            setAutocomplete(null);
            return;
        }
        const prefix = value.slice(foundOpen + 1, caret);
        setAutocomplete((prev) => {
            const sameToken =
                prev &&
                prev.startPos === foundOpen &&
                prev.prefix === prefix;
            return {
                prefix,
                startPos: foundOpen,
                selectedIdx: sameToken ? prev.selectedIdx : 0,
            };
        });
    };

    const insertSuggestion = (s: VariableSuggestion) => {
        if (!autocomplete) return;
        const field = inputRef.current;
        if (!field) return;
        const caret = field.selectionStart ?? el.text.length;
        const before = el.text.slice(0, autocomplete.startPos);
        const after = el.text.slice(caret);
        const inserted = `{${s.name}}`;
        const next = before + inserted + after;
        onChange(next);
        setAutocomplete(null);
        setTimeout(() => {
            const pos = before.length + inserted.length;
            try {
                field.setSelectionRange(pos, pos);
                field.focus();
            } catch {
                /* ignore */
            }
        }, 0);
    };

    const isWebFont = !forcePrintFidelity && el.fontSource && el.fontSource !== "zpl";

    let fontPx: number;
    let letterSpacingPx: number;
    let fontFamily: string;
    let fontWeight: number;
    let fontStyle: "normal" | "italic";
    let lineHeightRatio: number;

    if (isWebFont) {
        const sizeMm = el.fontSizeMm ?? 4;
        fontPx = sizeMm * pxPerMm;
        letterSpacingPx = 0;
        fontFamily = fontStackFor(el.fontSource ?? "system", el.fontFamily);
        fontWeight = el.fontWeight ?? 400;
        fontStyle = el.fontItalic ? "italic" : "normal";
        lineHeightRatio = 1.0;
    } else {
        // Zebra ZPL native bitmap fonts (A/B/D/E) are
        // monospace sans-serif bitmaps:
        //   A:  9×5 dots   B: 11×7   D: 18×10   E: 28×15
        // (height × width). The printed glyph fills the cell, so the cell
        // height in mm ≈ the printed glyph height. Pass that directly to
        // CSS `font-size` for a 1:1 visual size match.
        //
        // The cell W:H ratio is ~0.55. Monospace CSS fonts advance at
        // ~0.6 EM, so we pin the on-screen advance to the ZPL cell width
        // via `letter-spacing` (can be negative when the CSS font is
        // wider than the bitmap pitch).
        //
        // Zebra built-in bitmap fonts print at regular weight, not bold —
        // so 400 (not 600/700). Bold weight was making "$1.00" look much
        // chunkier on screen than on paper.
        const cellHmm = (FONT_DOTS[el.font].h / DPI) * 25.4 * el.scaleY;
        const cellWmm = (FONT_DOTS[el.font].w / DPI) * 25.4 * el.scaleX;
        fontPx = cellHmm * pxPerMm;
        const cellWpx = cellWmm * pxPerMm;
        const naturalAdvance = fontPx * 0.6;
        letterSpacingPx = cellWpx - naturalAdvance;
        // Andale Mono / Liberation Mono / DejaVu Sans Mono are clean
        // sans-serif monospaces that read closest to a thermal-print
        // bitmap. Falls back to the generic monospace family.
        fontFamily =
            '"Andale Mono", "Liberation Mono", "DejaVu Sans Mono", "Lucida Sans Typewriter", "Menlo", "Consolas", monospace';
        fontWeight = 400;
        fontStyle = "normal";
        lineHeightRatio = 1.0;
    }

    const frame = rotationFrame({ w: widthPx, h: heightPx }, el.rotation);
    const content = textContentFrame(el, dpi);
    const insetPx = dotsToMm(content.inset, dpi) * pxPerMm;
    const logicalWidth = Math.max(0, frame.w - 2 * insetPx);
    const logicalHeight = Math.max(0, frame.h - 2 * insetPx);
    const align: "left" | "center" | "right" = el.align ?? "left";
    const flexAlign =
        align === "center" ? "items-center" : align === "right" ? "items-end" : "items-start";
    const wrapMode = getTextWrapMode(el.wrapMode);
    const fitMode = getTextFitMode(el.fitMode);
    const wraps = wrapMode !== "none";
    const flowStyle = {
        whiteSpace: wraps ? "pre-wrap" : "pre",
        overflowWrap: wrapMode === "anywhere" ? "anywhere" : "normal",
        wordBreak: wrapMode === "anywhere" ? "break-word" : "normal",
        overflow: "hidden",
    } as const;
    const displayFontPx = useMemo(() => {
        if (fitMode !== "shrink" || typeof document === "undefined") return fontPx;
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return fontPx;
        const createMeasure = (candidateFontPx: number) => {
            ctx.font = `${fontStyle} ${fontWeight} ${candidateFontPx}px ${fontFamily}`;
            const ratio = candidateFontPx / Math.max(1, fontPx);
            const spacing = letterSpacingPx * ratio;
            return (value: string) =>
                addLetterSpacingToWidth(
                    ctx.measureText(value || " ").width,
                    value,
                    spacing,
                );
        };
        return layoutTextInFrame({
            text: el.text,
            baseFontPx: fontPx,
            frameWidthPx: Math.max(1, logicalWidth),
            frameHeightPx: Math.max(1, logicalHeight),
            wrapMode,
            fitMode,
            lineHeightRatio,
            minFontPx: 5,
            createMeasure,
        }).fontPx;
    }, [
        el.text,
        fitMode,
        fontFamily,
        fontPx,
        fontStyle,
        fontWeight,
        logicalHeight,
        letterSpacingPx,
        lineHeightRatio,
        logicalWidth,
        wrapMode,
    ]);
    const displayLetterSpacingPx = letterSpacingPx * (displayFontPx / Math.max(1, fontPx));

    useEffect(() => {
        if (editing && inputRef.current) {
            const node = inputRef.current;
            node.focus();
            // Place caret at end instead of selecting all — user explicitly disliked the highlight.
            const len = node.value.length;
            try {
                node.setSelectionRange(len, len);
            } catch {
                /* ignore */
            }
        }
    }, [editing]);

    if (editing) {
        return (
            <div className="relative" style={{ width: widthPx, height: heightPx }}>
                <textarea
                    ref={inputRef}
                    value={el.text}
                    wrap={wraps ? "soft" : "off"}
                    onChange={(e) => {
                        onChange(e.target.value);
                        updateAutocomplete(e.target);
                    }}
                    onClick={(e) => updateAutocomplete(e.currentTarget)}
                    onKeyUp={(e) => updateAutocomplete(e.currentTarget)}
                    onBlur={() => {
                        setTimeout(() => setAutocomplete(null), 150);
                        onCommit();
                    }}
                    onKeyDown={(e) => {
                        if (autocomplete && filtered.length > 0) {
                            if (e.key === "ArrowDown") {
                                e.preventDefault();
                                setAutocomplete({
                                    ...autocomplete,
                                    selectedIdx:
                                        (autocomplete.selectedIdx + 1) % filtered.length,
                                });
                                return;
                            }
                            if (e.key === "ArrowUp") {
                                e.preventDefault();
                                setAutocomplete({
                                    ...autocomplete,
                                    selectedIdx:
                                        (autocomplete.selectedIdx - 1 + filtered.length) %
                                        filtered.length,
                                });
                                return;
                            }
                            if (e.key === "Enter" || e.key === "Tab") {
                                e.preventDefault();
                                insertSuggestion(
                                    filtered[
                                        Math.min(
                                            autocomplete.selectedIdx,
                                            filtered.length - 1,
                                        )
                                    ],
                                );
                                return;
                            }
                            if (e.key === "Escape") {
                                e.preventDefault();
                                setAutocomplete(null);
                                return;
                            }
                        }
                        if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            onCommit();
                        }
                        if (e.key === "Escape") {
                            e.preventDefault();
                            onCommit();
                        }
                        e.stopPropagation();
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{
                        ...frame.style,
                        fontFamily,
                        fontSize: `${Math.max(8, displayFontPx)}px`,
                        fontWeight,
                        fontStyle,
                        textDecoration: el.fontUnderline ? "underline" : "none",
                        lineHeight: lineHeightRatio,
                        letterSpacing: `${displayLetterSpacingPx}px`,
                        textAlign: align,
                        color: "#000",
                        background: "transparent",
                        border: 0,
                        boxShadow: "inset 0 0 0 1px #2563eb",
                        outline: "none",
                        boxSizing: "border-box",
                        padding: insetPx,
                        margin: 0,
                        resize: "none",
                        overflow: "hidden",
                        whiteSpace: flowStyle.whiteSpace,
                        overflowWrap: flowStyle.overflowWrap,
                        wordBreak: flowStyle.wordBreak,
                    }}
                />
                {autocomplete && filtered.length > 0 && (
                    <ul className="absolute z-50 left-0 top-full mt-0.5 min-w-[160px] max-w-[240px] bg-popover/95 backdrop-blur text-foreground ring-1 ring-black/[0.08] dark:ring-white/10 rounded-[8px] shadow-lg overflow-hidden py-1">
                        {filtered.map((s, idx) => {
                            const active = idx === autocomplete.selectedIdx;
                            return (
                                <li key={`${s.source}:${s.name}`}>
                                    <button
                                        type="button"
                                        onMouseDown={(e) => {
                                            e.preventDefault();
                                            insertSuggestion(s);
                                        }}
                                        className={cn(
                                            "w-full text-left px-2.5 py-1 flex items-center justify-between gap-2 transition-colors",
                                            active
                                                ? "bg-blue-600 text-white"
                                                : "text-foreground/80 hover:bg-muted",
                                        )}
                                    >
                                        <span className="font-mono text-[11px]">
                                            {`{${s.name}}`}
                                        </span>
                                        <span
                                            className={cn(
                                                "text-[9px] uppercase tracking-wider",
                                                active
                                                    ? "text-white/80"
                                                    : "text-muted-foreground",
                                            )}
                                        >
                                            {s.source}
                                        </span>
                                    </button>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        );
    }

    const lines = el.text ? el.text.split(/\n/) : [""];

    return (
        <div
            className="relative text-black select-none"
            style={{
                ...frame.style,
                fontFamily,
                fontSize: `${Math.max(6, displayFontPx)}px`,
                fontWeight,
                fontStyle,
                textDecoration: el.fontUnderline ? "underline" : "none",
                lineHeight: lineHeightRatio,
                letterSpacing: `${displayLetterSpacingPx}px`,
                textAlign: align,
                ...flowStyle,
            }}
        >
            <div data-text-content className={`absolute flex flex-col ${flexAlign}`}
                style={{ inset: insetPx, overflow: "hidden" }}>
                {content.w > 0 && content.h > 0 && (el.text ? (
                    lines.map((line, i) => (
                        <span key={i} style={{ display: "block", width: "100%", maxWidth: "100%" }}>
                            {highlightVars ? renderLine(line, `l${i}`, knownNames) : (line || " ")}
                        </span>
                    ))
                ) : (
                    <span className="opacity-30">text</span>
                ))}
            </div>
        </div>
    );
}
