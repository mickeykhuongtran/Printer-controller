import type { LabelDoc } from "./types";
import {
    DEFAULT_PRINT_CONNECTOR_URL,
    normalizePrintConnectorUrl,
} from "./print-connector-config";
import { normalizeZebraDocument, parseZebraDocument } from "./zebra-document";

const KEY = "zbre.print.templates.v1";
const SESSION_KEY = "zbre.print.session.v1";
const PRINTER_KEY = "zbre.print.printer.v1";

export type PrintStep = "choose" | "edit" | "print";
export type PrinterLanguage = "zpl";
export type LabelHAlign = "left" | "center" | "right";
export type PrinterConnectionMode = "webserial" | "windowsRaw" | "tcp";
export type TcpExecutionMode = "auto" | "connector" | "server";
export type SerialFlowControl = "none" | "hardware";

export const PRINTER_BAUD_RATES = [9600, 19200, 38400, 57600, 115200] as const;
export const DEFAULT_PRINTER_BAUD_RATE: number = PRINTER_BAUD_RATES[0];
export const MIN_PRINTER_BAUD_RATE: number = PRINTER_BAUD_RATES[0];
export const MAX_PRINTER_BAUD_RATE: number =
    PRINTER_BAUD_RATES[PRINTER_BAUD_RATES.length - 1];
const DEFAULT_PRINT_AGENT_URL = DEFAULT_PRINT_CONNECTOR_URL;

export function normalizePrinterBaudRate(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return DEFAULT_PRINTER_BAUD_RATE;
    }
    const rounded = Math.round(value);
    return PRINTER_BAUD_RATES.some((baudRate) => baudRate === rounded)
        ? rounded
        : DEFAULT_PRINTER_BAUD_RATE;
}

function cleanConnectionMode(value: unknown): PrinterConnectionMode {
    if (value === "tcp") return "tcp";
    return value === "windowsRaw" ? "windowsRaw" : "webserial";
}

function cleanTcpPort(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 9100;
    const rounded = Math.round(value);
    if (rounded < 1 || rounded > 65535) return 9100;
    return rounded;
}

function cleanTcpExecutionMode(value: unknown): TcpExecutionMode {
    if (value === "connector" || value === "server") return value;
    return "auto";
}

function cleanSerialFlowControl(value: unknown): SerialFlowControl {
    return value === "hardware" ? "hardware" : "none";
}

function cleanText(value: unknown, fallback = ""): string {
    return typeof value === "string" ? value.trim() : fallback;
}

function cleanAgentUrl(value: unknown): string {
    const raw = cleanText(value, DEFAULT_PRINT_AGENT_URL);
    try {
        return normalizePrintConnectorUrl(raw);
    } catch {
        return DEFAULT_PRINT_AGENT_URL;
    }
}

// Physical print-head width in mm. 0 = "auto" (use the label's own width, the
// original behaviour). Set this for fixed-width heads (e.g. a 4"/120 mm head
// that can't narrow to a 40 mm label) so the label can be positioned within
// the head instead of always hugging the left edge.
function cleanHeadWidthMm(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    if (value <= 0) return 0;
    return Math.min(2000, Math.round(value * 100) / 100);
}

function cleanHAlign(value: unknown): LabelHAlign {
    return value === "center" || value === "right" ? value : "left";
}

function cleanLabelTopDots(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(-120, Math.min(120, Math.round(value)));
}

function cleanLeftPositionDots(value: unknown): number {
    if (typeof value !== "number" || !Number.isFinite(value)) return 0;
    return Math.max(-9999, Math.min(9999, Math.round(value)));
}

function cleanTearOffDots(value: unknown): number | undefined {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.max(-120, Math.min(120, Math.round(value)));
}

function cleanLegacyNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// Persistent printer-profile settings — stored across all templates so the
// physical-media calibration only has to be set once per machine.
export type PrinterSettings = {
    labelTopDots: number; // Zebra ^LT / zpl.label_top
    leftPositionDots: number; // Zebra ^LS / zpl.left_position
    // False preserves Horizontal/Vertical Label Offset stored in the printer.
    // Enable only when every print job must intentionally own ^LT/^LS.
    embedAlignmentInJobs: boolean;
    tearOffDots?: number; // Zebra ~TA / ezpl.tear_off; undefined until known
    // False preserves the value calibrated/stored in the physical printer.
    // Enable only when this workstation intentionally owns the override.
    embedTearOffInJobs: boolean;
    // Loaded only long enough to migrate printer profiles saved by older builds.
    legacyPaperMarginXMm?: number;
    legacyPaperMarginYMm?: number;
    legacyLabelStartOffsetDots?: number;
    connectionMode: PrinterConnectionMode;
    baudRate: number;
    serialFlowControl: SerialFlowControl;
    language: PrinterLanguage;
    printerName: string;
    printAgentUrl: string;
    tcpHost: string;
    tcpPort: number;
    tcpExecutionMode: TcpExecutionMode;
    headWidthMm: number; // fixed print-head width in mm; 0 = auto (= label width)
    hAlign: LabelHAlign; // label position within the head width
};

const DEFAULT_PRINTER_SETTINGS: PrinterSettings = {
    labelTopDots: 0,
    leftPositionDots: 0,
    embedAlignmentInJobs: false,
    embedTearOffInJobs: false,
    connectionMode: "windowsRaw",
    baudRate: DEFAULT_PRINTER_BAUD_RATE,
    serialFlowControl: "none",
    language: "zpl",
    printerName: "",
    printAgentUrl: DEFAULT_PRINT_AGENT_URL,
    tcpHost: "",
    tcpPort: 9100,
    tcpExecutionMode: "auto",
    headWidthMm: 0,
    hAlign: "left",
};

export function loadPrinterSettings(): PrinterSettings {
    if (typeof window === "undefined") return { ...DEFAULT_PRINTER_SETTINGS };
    try {
        const raw = window.localStorage.getItem(PRINTER_KEY);
        if (!raw) return { ...DEFAULT_PRINTER_SETTINGS };
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return { ...DEFAULT_PRINTER_SETTINGS };
        const v = parsed as Record<string, unknown>;
        const hasCurrentAlignment =
            typeof v.labelTopDots === "number" ||
            typeof v.leftPositionDots === "number";
        return {
            labelTopDots: cleanLabelTopDots(v.labelTopDots),
            leftPositionDots: cleanLeftPositionDots(v.leftPositionDots),
            embedAlignmentInJobs: v.embedAlignmentInJobs === true,
            tearOffDots: cleanTearOffDots(v.tearOffDots),
            // Legacy templates stored tearOffMm=10. Never migrate that value
            // into an enabled printer override or the old ~TA120 bug returns.
            embedTearOffInJobs: v.embedTearOffInJobs === true,
            legacyPaperMarginXMm: hasCurrentAlignment
                ? undefined
                : cleanLegacyNumber(v.paperMarginXMm),
            legacyPaperMarginYMm: hasCurrentAlignment
                ? undefined
                : cleanLegacyNumber(v.paperMarginYMm),
            legacyLabelStartOffsetDots: hasCurrentAlignment
                ? undefined
                : cleanLegacyNumber(v.labelStartOffsetDots),
            connectionMode: cleanConnectionMode(v.connectionMode),
            baudRate: normalizePrinterBaudRate(v.baudRate),
            serialFlowControl: cleanSerialFlowControl(v.serialFlowControl),
            // Zebra ZPL is the only supported printer language. Ignore any
            // previously persisted language value.
            language: "zpl",
            printerName: cleanText(v.printerName),
            printAgentUrl: cleanAgentUrl(v.printAgentUrl),
            tcpHost: cleanText(v.tcpHost),
            tcpPort: cleanTcpPort(v.tcpPort),
            tcpExecutionMode: cleanTcpExecutionMode(v.tcpExecutionMode),
            headWidthMm: cleanHeadWidthMm(v.headWidthMm),
            hAlign: cleanHAlign(v.hAlign),
        };
    } catch {
        return { ...DEFAULT_PRINTER_SETTINGS };
    }
}

export function savePrinterSettings(s: PrinterSettings): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(
            PRINTER_KEY,
            JSON.stringify({
                ...s,
                language: "zpl",
                baudRate: normalizePrinterBaudRate(s.baudRate),
            }),
        );
    } catch {
        /* ignore */
    }
}

export type PrintSession = {
    doc: LabelDoc;
    step: PrintStep;
    hasDoc: boolean;
    zoom?: number;
    scrollLeft?: number;
    scrollTop?: number;
};

export function loadCustomTemplates(): LabelDoc[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = window.localStorage.getItem(KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(parseZebraDocument)
            .filter((doc): doc is LabelDoc => doc !== null);
    } catch {
        return [];
    }
}

export function saveCustomTemplates(docs: LabelDoc[]): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(
            KEY,
            JSON.stringify(docs.map(normalizeZebraDocument)),
        );
    } catch {
        // quota exceeded or unavailable — ignore
    }
}

// Local timestamp suffix appended to a label name on its first save, so
// repeated saves of the same starting template list as distinct entries
// instead of stacking up as identical "Product 60x40" rows.
export function nameTimestamp(d: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function upsertCustomTemplate(doc: LabelDoc): LabelDoc[] {
    const existing = loadCustomTemplates();
    const idx = existing.findIndex((d) => d.id === doc.id);
    const stamped = normalizeZebraDocument({
        ...doc,
        builtIn: false,
        updatedAt: Date.now(),
    });
    const next =
        idx >= 0
            ? existing.map((d, i) => (i === idx ? stamped : d))
            : [...existing, stamped];
    saveCustomTemplates(next);
    return next;
}

export function removeCustomTemplate(id: string): LabelDoc[] {
    const next = loadCustomTemplates().filter((d) => d.id !== id);
    saveCustomTemplates(next);
    return next;
}

export function exportToJson(doc: LabelDoc): string {
    return JSON.stringify(normalizeZebraDocument(doc), null, 2);
}

export function parseImportedJson(text: string): LabelDoc | null {
    try {
        return parseZebraDocument(JSON.parse(text));
    } catch {
        return null;
    }
}

export function loadSession(): PrintSession | null {
    if (typeof window === "undefined") return null;
    try {
        const raw = window.localStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        const v = parsed as Record<string, unknown>;
        const doc = parseZebraDocument(v.doc);
        if (!doc) return null;
        if (typeof v.hasDoc !== "boolean") return null;
        const step = v.step;
        if (step !== "choose" && step !== "edit" && step !== "print") return null;
        const zoom = typeof v.zoom === "number" && Number.isFinite(v.zoom) ? v.zoom : undefined;
        const scrollLeft =
            typeof v.scrollLeft === "number" && Number.isFinite(v.scrollLeft)
                ? v.scrollLeft
                : undefined;
        const scrollTop =
            typeof v.scrollTop === "number" && Number.isFinite(v.scrollTop)
                ? v.scrollTop
                : undefined;
        return { doc, step, hasDoc: v.hasDoc, zoom, scrollLeft, scrollTop };
    } catch {
        return null;
    }
}

export function saveSession(session: PrintSession): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(
            SESSION_KEY,
            JSON.stringify({
                ...session,
                doc: normalizeZebraDocument(session.doc),
            }),
        );
    } catch {
        // quota exceeded or unavailable — ignore
    }
}

export function clearSession(): void {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.removeItem(SESSION_KEY);
    } catch {
        /* ignore */
    }
}

function downloadPart(content: string | Uint8Array): BlobPart {
    if (typeof content === "string") return content;
    if (content.buffer instanceof ArrayBuffer) {
        if (
            content.byteOffset === 0
            && content.byteLength === content.buffer.byteLength
        ) {
            return content.buffer;
        }
        return content.buffer.slice(
            content.byteOffset,
            content.byteOffset + content.byteLength,
        );
    }
    return new Uint8Array(content).buffer;
}

export function downloadFileParts(
    filename: string,
    contents: readonly (string | Uint8Array)[],
    mime: string,
): void {
    if (typeof window === "undefined") return;
    const blob = new Blob(contents.map(downloadPart), { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadFile(filename: string, content: string | Uint8Array, mime: string): void {
    downloadFileParts(filename, [content], mime);
}
