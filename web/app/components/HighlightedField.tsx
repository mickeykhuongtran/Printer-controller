"use client";

import {
    useEffect,
    useMemo,
    useRef,
    useState,
    type ReactElement,
} from "react";
import { cn } from "@/lib/utils";

export type VariableSuggestion = {
    name: string;
    source: "builtin" | "column" | "formula";
    description?: string;
};

const BUILTIN_NAMES = new Set([
    "serial",
    "step",
    "n",
    "counter",
    "index",
    "row",
]);

function buildHighlightRegex(extraNames: string[]): RegExp {
    const all = [
        ...BUILTIN_NAMES,
        ...extraNames.map((n) => n.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")),
    ];
    if (all.length === 0) return /\{x^x\}/g; // never matches
    return new RegExp(`\\{(${all.join("|")})\\}`, "gi");
}

function highlight(text: string, re: RegExp): ReactElement[] {
    if (!text) return [<span key="empty">{"​"}</span>];
    const parts: ReactElement[] = [];
    let lastIndex = 0;
    let i = 0;
    const live = new RegExp(re.source, "gi");
    let m: RegExpExecArray | null;
    while ((m = live.exec(text)) !== null) {
        if (m.index > lastIndex) {
            parts.push(<span key={i++}>{text.slice(lastIndex, m.index)}</span>);
        }
        parts.push(
            <span
                key={i++}
                style={{
                    color: "var(--field-token-foreground, #60a5fa)",
                    fontWeight: 700,
                    background: "var(--field-token-background, rgba(96, 165, 250, 0.18))",
                    borderRadius: 3,
                    padding: "0 2px",
                    margin: "0 -2px",
                }}
            >
                {m[0]}
            </span>,
        );
        lastIndex = m.index + m[0].length;
    }
    if (lastIndex < text.length) {
        parts.push(<span key={i++}>{text.slice(lastIndex)}</span>);
    }
    if (text.endsWith("\n")) parts.push(<span key={i++}>{"​"}</span>);
    return parts;
}

interface BaseProps {
    value: string;
    onChange: (next: string) => void;
    placeholder?: string;
    className?: string;
    variables?: VariableSuggestion[]; // column names (built-ins are merged in)
}

interface TextareaProps extends BaseProps {
    rows?: number;
    multiline: true;
}
interface InputProps extends BaseProps {
    multiline?: false;
}

type Props = TextareaProps | InputProps;

const sharedFieldStyle: React.CSSProperties = {
    fontFamily: "inherit",
    fontSize: "14px",
    lineHeight: "20px",
    padding: "8px 12px",
    boxSizing: "border-box",
    margin: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    overflowWrap: "break-word",
};

const BUILTIN_SUGGESTIONS: VariableSuggestion[] = [
    { name: "step", source: "builtin", description: "Row index, 1-based" },
    { name: "serial", source: "builtin", description: "Alias for step" },
    { name: "n", source: "builtin", description: "Alias for step" },
    { name: "counter", source: "builtin", description: "Alias for step" },
    { name: "index", source: "builtin", description: "Alias for step" },
    { name: "row", source: "builtin", description: "1-based row/copy index" },
];

export function HighlightedField(props: Props) {
    const taRef = useRef<HTMLTextAreaElement | null>(null);
    const inRef = useRef<HTMLInputElement | null>(null);
    const backRef = useRef<HTMLDivElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const [autocomplete, setAutocomplete] = useState<{
        prefix: string;
        startPos: number;
        x: number;
        y: number;
        selectedIdx: number;
    } | null>(null);

    const allSuggestions = useMemo(() => {
        // De-duplicate by name. User-defined columns/formulas win over the
        // built-in alias of the same name.
        const seen = new Set<string>();
        const out: VariableSuggestion[] = [];
        for (const s of [...(props.variables ?? []), ...BUILTIN_SUGGESTIONS]) {
            const k = s.name.toLowerCase();
            if (seen.has(k)) continue;
            seen.add(k);
            out.push(s);
        }
        return out;
    }, [props.variables]);

    const filtered = useMemo(() => {
        if (!autocomplete) return [];
        const p = autocomplete.prefix.toLowerCase();
        return allSuggestions
            .filter((s) => s.name.toLowerCase().startsWith(p))
            .slice(0, 12);
    }, [autocomplete, allSuggestions]);

    const highlightRegex = useMemo(
        () =>
            buildHighlightRegex(
                (props.variables ?? []).map((v) => v.name),
            ),
        [props.variables],
    );

    useEffect(() => {
        const field = props.multiline ? taRef.current : inRef.current;
        const back = backRef.current;
        if (!field || !back) return;
        const sync = () => {
            back.scrollTop = field.scrollTop;
            back.scrollLeft = field.scrollLeft;
        };
        sync();
        field.addEventListener("scroll", sync);
        return () => field.removeEventListener("scroll", sync);
    }, [props.multiline]);

    // Detect when caret is inside a `{partial` and trigger autocomplete.
    const updateAutocomplete = (input: HTMLInputElement | HTMLTextAreaElement) => {
        const caret = input.selectionStart ?? 0;
        const value = input.value;
        // Walk back from caret to find an unclosed "{".
        let i = caret - 1;
        let foundOpen = -1;
        while (i >= 0) {
            const ch = value[i];
            if (ch === "}") break;
            if (ch === "{") {
                foundOpen = i;
                break;
            }
            // Identifier characters allowed
            if (!/[A-Za-z0-9_]/.test(ch)) break;
            i -= 1;
        }
        if (foundOpen < 0) {
            setAutocomplete(null);
            return;
        }
        const prefix = value.slice(foundOpen + 1, caret);
        // Position the popup just below the caret. Approximate by using the
        // field's bounding box + caret-relative offsets via a hidden mirror.
        const rect = input.getBoundingClientRect();
        const containerRect = containerRef.current?.getBoundingClientRect();
        if (!containerRect) return;
        // Simple approach: position below the input at left edge.
        const x = rect.left - containerRect.left;
        const y = rect.bottom - containerRect.top + 4;
        setAutocomplete((prev) => {
            const sameToken =
                prev &&
                prev.startPos === foundOpen &&
                prev.prefix === prefix;
            return {
                prefix,
                startPos: foundOpen,
                x,
                y,
                selectedIdx: sameToken ? prev.selectedIdx : 0,
            };
        });
    };

    const insertSuggestion = (s: VariableSuggestion) => {
        if (!autocomplete) return;
        const field = props.multiline ? taRef.current : inRef.current;
        if (!field) return;
        const value = props.value;
        const caret = field.selectionStart ?? value.length;
        const before = value.slice(0, autocomplete.startPos);
        const after = value.slice(caret);
        const inserted = `{${s.name}}`;
        const next = before + inserted + after;
        props.onChange(next);
        setAutocomplete(null);
        // Place caret after the inserted token.
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

    const onKeyDown = (
        e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
        if (!autocomplete || filtered.length === 0) return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setAutocomplete({
                ...autocomplete,
                selectedIdx: (autocomplete.selectedIdx + 1) % filtered.length,
            });
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setAutocomplete({
                ...autocomplete,
                selectedIdx:
                    (autocomplete.selectedIdx - 1 + filtered.length) %
                    filtered.length,
            });
        } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            insertSuggestion(
                filtered[Math.min(autocomplete.selectedIdx, filtered.length - 1)],
            );
        } else if (e.key === "Escape") {
            e.preventDefault();
            setAutocomplete(null);
        }
    };

    const baseClass = cn(
        "relative w-full rounded-[6px] ring-1 ring-black/[0.08] dark:ring-white/10 bg-black/[0.03] dark:bg-white/[0.06] text-sm focus-within:ring-2 focus-within:ring-foreground/40 transition",
        props.className,
    );

    const fieldShared: React.CSSProperties = {
        ...sharedFieldStyle,
        position: "relative",
        background: "transparent",
        color: "transparent",
        caretColor: "var(--foreground)",
        outline: "none",
        width: "100%",
        resize: props.multiline ? "vertical" : undefined,
    };

    const backdropStyle: React.CSSProperties = {
        ...sharedFieldStyle,
        position: "absolute",
        inset: 0,
        color: "var(--foreground)",
        pointerEvents: "none",
        overflow: "hidden",
    };

    return (
        <div ref={containerRef} className={baseClass}>
            <div
                ref={backRef}
                aria-hidden
                className={!props.value ? "text-muted-foreground" : undefined}
                style={backdropStyle}
            >
                {props.value
                    ? highlight(props.value, highlightRegex)
                    : props.placeholder || "​"}
            </div>
            {props.multiline ? (
                <textarea
                    ref={taRef}
                    value={props.value}
                    rows={props.rows ?? 2}
                    placeholder={props.placeholder}
                    onChange={(e) => {
                        props.onChange(e.target.value);
                        updateAutocomplete(e.target);
                    }}
                    onKeyDown={onKeyDown}
                    onKeyUp={(e) => updateAutocomplete(e.currentTarget)}
                    onClick={(e) => updateAutocomplete(e.currentTarget)}
                    onBlur={() => setTimeout(() => setAutocomplete(null), 150)}
                    style={fieldShared}
                />
            ) : (
                <input
                    ref={inRef}
                    type="text"
                    value={props.value}
                    placeholder={props.placeholder}
                    onChange={(e) => {
                        props.onChange(e.target.value);
                        updateAutocomplete(e.target);
                    }}
                    onKeyDown={onKeyDown}
                    onKeyUp={(e) => updateAutocomplete(e.currentTarget)}
                    onClick={(e) => updateAutocomplete(e.currentTarget)}
                    onBlur={() => setTimeout(() => setAutocomplete(null), 150)}
                    style={{ ...fieldShared, height: 36 }}
                />
            )}

            {autocomplete && filtered.length > 0 && (
                <ul
                    className="absolute z-50 min-w-[180px] max-w-[260px] bg-popover/95 backdrop-blur text-foreground ring-1 ring-black/[0.08] dark:ring-white/10 rounded-[8px] shadow-lg overflow-hidden py-1"
                    style={{ left: autocomplete.x, top: autocomplete.y }}
                >
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
                                        "w-full text-left px-3 py-1.5 flex items-center justify-between gap-2 transition-colors",
                                        active
                                            ? "bg-blue-600 text-white"
                                            : "text-foreground/80 hover:bg-muted",
                                    )}
                                >
                                    <span className="font-mono text-xs">
                                        {`{${s.name}}`}
                                    </span>
                                    <span
                                        className={cn(
                                            "text-[10px] uppercase tracking-wider",
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
