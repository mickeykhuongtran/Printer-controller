// Column formatting — Excel-style "Format Cells". The stored cell value is
// always the raw text the user typed (e.g. "10000"). Format is applied at
// the presentation boundary only:
//
//   • Data feed display (cell shown as "10,000" when not focused for edit)
//   • Label preview / print emit (text resolution of `{price}` etc.)
//   • Copy-to-clipboard of resolved values
//
// Formula references (`={price}*2`) continue to operate on the raw numeric
// value because they go through resolveByName → FormulaResult, which is a
// number-or-string union and is only stringified at the output boundary.

import type { ColumnFormat, DataColumn } from "./types";

// Parse a raw cell string into a number for formatting. Accepts optional
// whitespace, leading sign, common thousands separators, and a single
// decimal point. Returns null when the value isn't a clean numeric — in
// that case the caller falls back to the raw string (e.g. plain text in a
// number-formatted column).
function parseNumeric(raw: string): number | null {
    if (raw == null) return null;
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    // Strip thousands separators and a leading currency symbol so a value
    // that already looks formatted (e.g. "$1,234.50") still parses.
    const cleaned = trimmed
        .replace(/^[$€£¥₩₹]/, "")
        .replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
}

function formatNumberPart(
    n: number,
    decimals: number | undefined,
    thousands: boolean | undefined,
): string {
    const fixed = decimals != null ? n.toFixed(decimals) : String(n);
    if (!thousands) return fixed;
    // Apply commas to the integer part only — leave the fractional part alone.
    const negative = fixed.startsWith("-");
    const body = negative ? fixed.slice(1) : fixed;
    const [intPart, fracPart] = body.split(".");
    const withSeps = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    const result = fracPart ? `${withSeps}.${fracPart}` : withSeps;
    return negative ? `-${result}` : result;
}

// Format a raw resolved value (string) for display/print. Returns the raw
// string unchanged when:
//   • no format is configured
//   • format is "text"
//   • the value isn't a clean numeric (so a non-numeric cell in a number
//     column doesn't get mangled — it falls through verbatim).
export function applyColumnFormat(raw: string, format: ColumnFormat | undefined): string {
    if (!format || format.type === "text") return raw;
    const n = parseNumeric(raw);
    if (n === null) return raw;
    switch (format.type) {
        case "number":
            return formatNumberPart(n, format.decimals, format.thousands ?? true);
        case "currency": {
            const sym = format.symbol ?? "$";
            const body = formatNumberPart(
                n,
                format.decimals ?? 2,
                format.thousands ?? true,
            );
            return format.position === "after" ? `${body}${sym}` : `${sym}${body}`;
        }
        case "percent": {
            // Convention: stored value is the multiplier (0.25 → 25%).
            const body = formatNumberPart(
                n * 100,
                format.decimals ?? 0,
                format.thousands ?? false,
            );
            return `${body}%`;
        }
        case "custom": {
            const body = formatNumberPart(n, format.decimals, format.thousands);
            return `${format.prefix ?? ""}${body}${format.suffix ?? ""}`;
        }
    }
}

export function formatForColumn(raw: string, col: DataColumn | undefined): string {
    if (!col || !col.format) return raw;
    return applyColumnFormat(raw, col.format);
}

// Short human label for a format — used in dialog previews and column
// header indicators (e.g. "1,234", "$1,234.00", "12.50%").
export function describeFormat(format: ColumnFormat | undefined): string {
    if (!format || format.type === "text") return "Text";
    switch (format.type) {
        case "number":
            return `Number (${format.decimals ?? 0} dp${format.thousands === false ? "" : ", thousands"})`;
        case "currency":
            return `Currency ${format.symbol ?? "$"}`;
        case "percent":
            return `Percent (${format.decimals ?? 0} dp)`;
        case "custom":
            return `Custom${format.prefix ? ` "${format.prefix}…"` : ""}${format.suffix ? ` "…${format.suffix}"` : ""}`;
    }
}
