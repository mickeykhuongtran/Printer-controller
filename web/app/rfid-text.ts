import type { RfidSettings, TextEl } from "./types";

// A presentation option on one Text element; the source RFID field stays whole.
export function normalizeRfidReadLastChars(value: unknown): number | undefined {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 128
        ? value
        : undefined;
}

export function rfidTextPlaceholder(fieldName: string): RegExp {
    const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\{\\s*${escaped}\\s*\\}`, "gi");
}

export function rfidTextSource(el: TextEl, rfid?: RfidSettings): string | undefined {
    if (!rfid?.readEnabled) return undefined;
    const name = (rfid.readFieldName ?? "rfid_read").trim().replace(/^\{|\}$/g, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
    const bound = (el.fieldName ?? "").trim().replace(/^\{|\}$/g, "");
    return bound.toLowerCase() === name.toLowerCase() || rfidTextPlaceholder(name).test(el.text)
        ? name
        : undefined;
}

export function rfidTextLastChars(el: TextEl, rfid?: RfidSettings): number | undefined {
    return rfidTextSource(el, rfid) ? normalizeRfidReadLastChars(el.rfidReadLastChars) : undefined;
}
