import { evaluateRow } from "./data-feed";
import type { LabelDoc, RfidSettings, TextEl } from "./types";
import { rfidTextLastChars, rfidTextPlaceholder, rfidTextSource } from "./rfid-text";
import { zebraRfidReadHexCharacterCount } from "./rfid";

const BUILTIN_PLACEHOLDER_NAMES = new Set([
    "serial",
    "step",
    "n",
    "counter",
    "index",
    "row",
]);

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const RFID_READ_FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RFID_READ_VALUE_ALIASES = [
    "rfid_read",
    "rfid_epc_encode",
    "rfid_id",
    "field_rfid",
    "rfid",
    "epc",
];

export function hasUserDataRows(doc: Pick<LabelDoc, "dataFeed">): boolean {
    return (
        (doc.dataFeed?.rows.length ?? 0) > 0
        && (doc.dataFeed?.columns.some((column) => !column.system) ?? false)
    );
}

export function hasPerCopyBuiltins(
    doc: Pick<LabelDoc, "dataFeed" | "elements">,
): boolean {
    const userColumnNames = new Set(
        (doc.dataFeed?.columns ?? [])
            .filter((column) => !column.system)
            .map((column) => column.name.trim().toLowerCase()),
    );
    const fieldIsBuiltIn = (fieldName: string | undefined) => {
        const normalized = (fieldName ?? "")
            .trim()
            .replace(/^\{|\}$/g, "")
            .toLowerCase();
        return (
            BUILTIN_PLACEHOLDER_NAMES.has(normalized)
            && !userColumnNames.has(normalized)
        );
    };
    const valueHasBuiltIn = (value: string) => {
        for (const match of value.matchAll(
            /\{(serial|step|n|counter|index|row)\}/gi,
        )) {
            if (!userColumnNames.has(match[1].toLowerCase())) return true;
        }
        return false;
    };
    return doc.elements.some((element) => {
        if (
            element.kind === "text"
            || element.kind === "qr"
            || element.kind === "barcode"
            || element.kind === "datamatrix"
        ) {
            const value = element.kind === "text" ? element.text : element.data;
            return fieldIsBuiltIn(element.fieldName)
                || valueHasBuiltIn(value);
        }
        if (element.kind === "table") {
            return element.cells.some(valueHasBuiltIn);
        }
        return false;
    });
}

export function hasPerCopyPrintData(
    doc: Pick<LabelDoc, "dataFeed" | "elements" | "settings">,
): boolean {
    return (
        doc.settings.serial.enabled
        || doc.settings.rfid.enabled
        || !!doc.settings.rfid.readEnabled
        || hasPerCopyBuiltins(doc)
        || (
            hasUserDataRows(doc)
            && (doc.dataFeed?.rows.length ?? 0) > 1
        )
    );
}

export function formatSerial(value: number, pad: number, prefix: string): string {
    const width = Math.max(1, Math.floor(pad));
    return `${prefix}${String(value).padStart(width, "0")}`;
}

function expandPlaceholders(
    value: string,
    serial: string,
    vars?: Record<string, string>,
): string {
    if (!serial && !vars) return value;
    return value.replace(PLACEHOLDER_RE, (full, name: string) => {
        const bound = valueFromVars(vars, name);
        if (bound !== undefined) return bound;
        if (BUILTIN_PLACEHOLDER_NAMES.has(name.toLowerCase())) return serial || full;
        return full;
    });
}

function valueFromVars(
    vars: Record<string, string> | undefined,
    name: string | undefined,
): string | undefined {
    if (!vars || !name) return undefined;
    const normalizedName = name.trim().replace(/^\{|\}$/g, "");
    if (!normalizedName) return undefined;
    if (Object.prototype.hasOwnProperty.call(vars, normalizedName)) {
        return vars[normalizedName];
    }
    const wanted = normalizedName.toLowerCase();
    for (const [varName, value] of Object.entries(vars)) {
        if (varName.toLowerCase() === wanted) return value;
    }
    return undefined;
}

export function resolveDynamicValue(
    value: string,
    fieldName: string | undefined,
    serial: string,
    vars?: Record<string, string>,
): string {
    const bound = valueFromVars(vars, fieldName);
    if (bound !== undefined) return bound;
    const normalizedFieldName = (fieldName ?? "").trim().replace(/^\{|\}$/g, "");
    if (
        serial
        && BUILTIN_PLACEHOLDER_NAMES.has(normalizedFieldName.toLowerCase())
    ) {
        return serial;
    }
    return expandPlaceholders(value, serial, vars);
}

/** Resolve only this Text's RFID reference, without shortening shared variables. */
export function resolveTextValue(
    el: TextEl,
    serial: string,
    vars?: Record<string, string>,
    rfid?: RfidSettings,
    preview = false,
): string {
    const count = rfidTextLastChars(el, rfid);
    const name = count ? rfidTextSource(el, rfid) : undefined;
    if (!name || !count) return resolveDynamicValue(el.text, el.fieldName, serial, vars);
    const value = valueFromVars(vars, name);
    const source = value?.trim() ? value : preview && rfid
        ? "F".repeat(zebraRfidReadHexCharacterCount(rfid))
        : undefined;
    if (source === undefined) return resolveDynamicValue(el.text, el.fieldName, serial, vars);
    const tail = source.slice(-count);
    const placeholder = rfidTextPlaceholder(name);
    const bound = (el.fieldName ?? "").trim().replace(/^\{|\}$/g, "").toLowerCase() === name.toLowerCase();
    if (!placeholder.test(el.text)) return tail;
    // Preserve literal prefixes/suffixes and other variables around the RFID reference.
    return resolveDynamicValue(
        el.text.replace(rfidTextPlaceholder(name), () => tail),
        bound ? undefined : el.fieldName,
        serial,
        vars,
    );
}

function rfidReadFieldName(doc: LabelDoc): string | undefined {
    if (!doc.settings.rfid.readEnabled) return undefined;
    const fieldName = (doc.settings.rfid.readFieldName ?? "rfid_read")
        .trim()
        .replace(/^\{|\}$/g, "");
    return RFID_READ_FIELD_RE.test(fieldName) ? fieldName : undefined;
}

function varsWithResolvedRfidRead(
    doc: LabelDoc,
    vars: Record<string, string> | undefined,
): Record<string, string> | undefined {
    const fieldName = rfidReadFieldName(doc);
    if (fieldName && doc.settings.rfid.captureToHost && vars) {
        return Object.fromEntries(Object.entries(vars).filter(([key]) => key.toLowerCase() !== fieldName.toLowerCase()));
    }
    if (!fieldName || valueFromVars(vars, fieldName)) return vars;
    for (const alias of RFID_READ_VALUE_ALIASES) {
        const value = valueFromVars(vars, alias);
        if (value?.trim()) return { ...vars, [fieldName]: value };
    }
    return vars;
}

export function templateFieldVars(doc: LabelDoc): Record<string, string> | undefined {
    const vars: Record<string, string> = {};
    let hasVars = false;
    const printerReadFieldName = rfidReadFieldName(doc)?.toLowerCase();
    const put = (name: string | undefined, value: string | undefined) => {
        const normalizedName = (name ?? "").trim().replace(/^\{|\}$/g, "");
        if (
            !normalizedName
            || BUILTIN_PLACEHOLDER_NAMES.has(normalizedName.toLowerCase())
            || Object.prototype.hasOwnProperty.call(vars, normalizedName)
        ) {
            return;
        }
        vars[normalizedName] = value ?? "";
        hasVars = true;
    };
    const putElement = (name: string | undefined, value: string | undefined) => {
        const normalizedName = (name ?? "").trim().replace(/^\{|\}$/g, "");
        // A printer-read field is populated by ^RFR/^FN at print time. Do not
        // mistake the element's design-time placeholder for a resolved value.
        if (printerReadFieldName && normalizedName.toLowerCase() === printerReadFieldName) return;
        put(name, value);
    };

    for (const field of doc.templateFields ?? []) put(field.name, field.value);
    for (const element of doc.elements) {
        if (element.kind === "text") putElement(element.fieldName, element.text);
        else if (element.kind === "qr") putElement(element.fieldName, element.data);
        else if (element.kind === "barcode") putElement(element.fieldName, element.data);
        else if (element.kind === "datamatrix") putElement(element.fieldName, element.data);
    }
    put(doc.settings.rfid.fieldName, doc.settings.rfid.data);
    return hasVars ? vars : undefined;
}

export function variablesForCopy(
    doc: LabelDoc,
    copyIndex: number,
): Record<string, string> | undefined {
    const baseVars = templateFieldVars(doc);
    const feed = doc.dataFeed;
    const hasUserDataColumns = hasUserDataRows(doc);
    const rowVars = feed?.rows.length && hasUserDataColumns
        ? evaluateRow(feed, Math.min(Math.max(0, copyIndex), feed.rows.length - 1))
        : undefined;
    const rawCounter = String(Math.max(0, copyIndex) + 1);
    const counter = doc.settings.serial.enabled
        ? formatSerial(
            doc.settings.serial.start + copyIndex * doc.settings.serial.step,
            doc.settings.serial.pad,
            doc.settings.serial.prefix,
        )
        : rawCounter;
    // The default five-row system feed is a design aid, not a print limit.
    // Synthesize its built-ins from the absolute copy index so legacy
    // field-bound {step}/{serial} templates keep advancing past row five.
    const builtinVars = Object.fromEntries(
        Array.from(BUILTIN_PLACEHOLDER_NAMES)
            .filter((name) =>
                !(feed?.columns ?? []).some(
                    (column) =>
                        !column.system
                        && column.name.trim().toLowerCase() === name,
                ),
            )
            .map((name) => [name, counter]),
    );
    const systemVars = feed
        ? Object.fromEntries(
            feed.columns
                .filter((column) =>
                    column.system
                    && BUILTIN_PLACEHOLDER_NAMES.has(column.name.toLowerCase()),
                )
                .map((column) => [column.name, counter]),
        )
        : undefined;
    const vars = baseVars || rowVars || builtinVars || systemVars
        ? { ...baseVars, ...builtinVars, ...rowVars, ...systemVars }
        : undefined;
    return varsWithResolvedRfidRead(doc, vars);
}

export function resolveDocForCopy(
    doc: LabelDoc,
    copyIndex: number,
    vars?: Record<string, string>,
): LabelDoc {
    const serialSettings = doc.settings.serial;
    const serial = serialSettings.enabled
        ? formatSerial(
              serialSettings.start + copyIndex * serialSettings.step,
              serialSettings.pad,
              serialSettings.prefix,
          )
        : "";
    const hasRfidTextSuffix = doc.elements.some((el) =>
        el.kind === "text" && rfidTextLastChars(el, doc.settings.rfid));
    if (!serial && !vars && !hasRfidTextSuffix) return doc;
    const rewrite = (value: string, fieldName?: string) =>
        resolveDynamicValue(value, fieldName, serial, vars);
    return {
        ...doc,
        elements: doc.elements.map((element) => {
            if (element.kind === "text") {
                if (rfidTextLastChars(element, doc.settings.rfid)) {
                    // This is a display/export copy. Clear the binding so subsequent
                    // renderers cannot substitute the full source or apply the tail twice.
                    return {
                        ...element,
                        text: resolveTextValue(element, serial, vars, doc.settings.rfid, true),
                        fieldName: undefined,
                        rfidReadLastChars: undefined,
                    };
                }
                return { ...element, text: rewrite(element.text, element.fieldName) };
            }
            if (element.kind === "qr") return { ...element, data: rewrite(element.data, element.fieldName) };
            if (element.kind === "barcode") return { ...element, data: rewrite(element.data, element.fieldName) };
            if (element.kind === "datamatrix") return { ...element, data: rewrite(element.data, element.fieldName) };
            if (element.kind === "table") {
                return { ...element, cells: element.cells.map((cell) => rewrite(cell)) };
            }
            return element;
        }),
    };
}

export function copyCountFor(doc: LabelDoc): number {
    return Math.max(1, Math.floor(doc.settings.copies));
}

export function previewBatch(
    doc: LabelDoc,
    startRowIdx = 0,
): Array<{ key: string; label: string; vars?: Record<string, string>; copyIndex: number }> {
    const serial = doc.settings.serial;
    const copies = copyCountFor(doc);
    const hasFeed = !!doc.dataFeed?.rows.length;
    const start = Math.max(0, Math.floor(startRowIdx));
    if (serial.enabled || copies > 1 || hasFeed) {
        return Array.from({ length: copies }, (_, index) => {
            const copyIndex = start + index;
            return {
                key: `copy-${copyIndex}`,
                label: serial.enabled
                    ? formatSerial(
                          serial.start + copyIndex * serial.step,
                          serial.pad,
                          serial.prefix,
                      )
                    : `Copy ${copyIndex + 1}`,
                vars: variablesForCopy(doc, copyIndex),
                copyIndex,
            };
        });
    }
    return [{
        key: "single",
        label: "1",
        vars: variablesForCopy(doc, start),
        copyIndex: start,
    }];
}
