"use client";

import { normalizeRfidReadLastChars, rfidTextSource } from "../rfid-text";
import { MAX_TEXT_MARGIN_MM, textContentFrame, textMarginMm } from "../text-margin";
import { logicalSize } from "../rotation";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    Type,
    QrCode,
    Barcode,
    Grid3X3,
    Square as SquareIcon,
    Minus,
    Image as ImageIcon,
    Table as TableIcon,
    Eye,
    EyeOff,
    Trash2,
    ChevronDown,
    ChevronRight,
    CheckCircle2,
    AlertCircle,
    GripVertical,
    AlignLeft,
    AlignCenter,
    AlignRight,
    Check,
    ChevronsUpDown,
    Bold,
    Italic,
    Underline,
    RotateCcw,
    RefreshCw,
    Plug,
    Server,
    Settings2,
    Network,
    Printer,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
    Command,
    CommandEmpty,
    CommandGroup,
    CommandInput,
    CommandItem,
    CommandList,
} from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type {
    LabelDoc,
    LabelElement,
    LabelSettings,
    BarcodeEl,
    DataMatrixEl,
    DataMatrixAlign,
    DataMatrixContentFormat,
    DataMatrixShape,
    DataMatrixTextEncoding,
    DataMatrixVerticalAlign,
    PrinterDpi,
    RfidSettings,
    SerialSettings,
    Symbology,
    ZplFont,
    Scale,
    Rotation,
    ECC,
    ZebraRfidPositionMode,
    ZebraRfidModel,
    BarcodeAlign,
    BarcodeTextAlign,
    BarcodeTextPosition,
    SymbolSizeMode,
    DataColumn,
} from "../types";
import {
    RFID_CHIPS,
    epcBitsForChip,
    inferEpcBitsFromData,
    rfidSourceName,
    validateRfidHexValue,
    zebraRfidReadHexCharacterCount,
} from "../rfid";
import type { RfidChipType } from "../types";
import {
    GOOGLE_FONTS,
    SYSTEM_FONTS,
    loadGoogleFont,
    registerCustomFont,
    type FontSourceKind,
} from "../fonts";
import type {
    FontWeight,
    TableEl,
    TableScaleMode,
    TextAlign,
    TextEl,
    TextFitMode,
    TextWrapMode,
} from "../types";
import {
    DEFAULT_ICON_WEIGHT,
    findIconById,
    renderIconSvg,
    svgToDataUrl,
} from "../icons";
import { HighlightedField, type VariableSuggestion } from "./HighlightedField";
import { PRINTER_BAUD_RATES, type PrinterSettings } from "../storage";
import {
    barcodeHeightLayout,
    barcodeModuleLayout,
    renderBarcode,
    scanSafeBarcodeNarrowDots,
} from "../barcode";
import {
    fitQrToFrameDots,
    qrMinVersion,
    qrModuleCount,
} from "../qr-sizing";
import {
    DATA_MATRIX_ECC200_RECTANGLE_SIZES,
    DATA_MATRIX_ECC200_SQUARE_SIZES,
    encodeDataMatrix,
    fitDataMatrixToFrameDots,
} from "../datamatrix";
import { isBuiltInVar } from "../data-feed";
import { buildCalibrationSvg } from "../calibration-preview";
import { buildCalibrationZpl, encodeZpl } from "../zpl";
import { dotsToMm, mmToDots } from "../units";
import {
    listWindowsPrinters,
    rawZplPrinterWarning,
    type WindowsPrinterInfo,
} from "../windows-raw-print";
import {
    printerTransportCapabilities,
    writePrinterBytes,
    type PrinterWriteResult,
} from "../printer-transport";
import {
    buildZebraAlignmentSetCommand,
    normalizeZebraPrinterAlignment,
    ZEBRA_LABEL_TOP_MAX,
    ZEBRA_LABEL_TOP_MIN,
    ZEBRA_LEFT_POSITION_MAX,
    ZEBRA_LEFT_POSITION_MIN,
} from "../zebra-printer-alignment";

import {
    ZEBRA_PRINTER_MODELS,
    compatiblePrinterDpi,
    maxPrintSpeedIps,
    maxPrintWidthMm,
    zebraPrinterModelProfile,
} from "../printer-models";
import {
    preflightLabelForPrinter,
    type DpiPreflightIssue,
} from "../dpi-preflight";
import { zebraRfidModelOption } from "../zebra-rfid";
import { useSerialSession } from "../serial-session";

const TCP_EXECUTION_POLICY =
    process.env.NEXT_PUBLIC_TCP_EXECUTION === "connector"
    || process.env.NEXT_PUBLIC_TCP_EXECUTION === "server"
        ? process.env.NEXT_PUBLIC_TCP_EXECUTION
        : undefined;

const TARGET_PRINTER_MODELS = ["auto", "zt610r", "zd621r"].map(
    (id) => ZEBRA_PRINTER_MODELS.find((profile) => profile.id === id)!,
);

// LEFT sidebar: label-level setup (paper, gap, RFID, serial counter).
export function LabelSidebar({
    doc,
    printerSettings,
    onUpdatePrinterSettings,
    onUpdateSettings,
    onUpdateSerial,
    onUpdateRfid,
    onRename,
}: {
    doc: LabelDoc;
    printerSettings: PrinterSettings;
    onUpdatePrinterSettings: (patch: Partial<PrinterSettings>) => void;
    onUpdateSettings: (patch: Partial<LabelSettings>) => void;
    onUpdateSerial: (patch: Partial<SerialSettings>) => void;
    onUpdateRfid: (patch: Partial<RfidSettings>) => void;
    onRename: (name: string) => void;
}) {
    const preflightIssues = useMemo(() => preflightLabelForPrinter(doc), [doc]);

    return (
        <ScrollArea className="h-full">
            <div className="p-4 space-y-4">
                <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                        <Label htmlFor="doc-name">Label name</Label>
                        {doc.settings.rfid.enabled && (
                            <span
                                className="inline-flex items-center gap-1 rounded-full border border-blue-500/30 bg-blue-500/12 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300"
                                title="This template writes RFID EPC data"
                            >
                                <CheckCircle2 className="h-3 w-3" />
                                RFID
                            </span>
                        )}
                    </div>
                    <Input
                        id="doc-name"
                        value={doc.name}
                        onChange={(e) => onRename(e.target.value)}
                    />
                </div>

                <Tabs defaultValue="label">
                    <TabsList className="grid grid-cols-2 w-full">
                        <TabsTrigger value="label">Label</TabsTrigger>
                        <TabsTrigger value="rfid">
                            <span className="inline-flex items-center gap-1.5">
                                RFID encode
                                {doc.settings.rfid.enabled && (
                                    <span className="h-1.5 w-1.5 rounded-full bg-blue-500" />
                                )}
                            </span>
                        </TabsTrigger>
                    </TabsList>

                    <TabsContent value="label" className="pt-3 space-y-4">
                        <LabelProperties
                            settings={doc.settings}
                            printerSettings={printerSettings}
                            preflightIssues={preflightIssues}
                            onUpdatePrinterSettings={onUpdatePrinterSettings}
                            onUpdate={onUpdateSettings}
                            onUpdateSerial={onUpdateSerial}
                            onUpdateRfid={onUpdateRfid}
                        />
                    </TabsContent>

                    <TabsContent value="rfid" className="pt-3 space-y-4">
                        <RfidProperties
                            rfid={doc.settings.rfid}
                            labelLengthMm={doc.settings.heightMm}
                            dataColumns={doc.dataFeed?.columns ?? []}
                            onUpdate={onUpdateRfid}
                        />
                    </TabsContent>
                </Tabs>
            </div>
        </ScrollArea>
    );
}

// RIGHT sidebar: selected element's properties on top, layers list below.
export function ElementSidebar({
    doc,
    selected,
    onUpdateElement,
    onSelectElement,
    onRemoveElement,
    onMoveLayer,
    variables,
}: {
    doc: LabelDoc;
    selected: LabelElement | null;
    onUpdateElement: (id: string, patch: Partial<LabelElement>) => void;
    onSelectElement: (id: string | null) => void;
    onRemoveElement: (id: string) => void;
    onMoveLayer?: (id: string, toIndex: number) => void;
    variables?: VariableSuggestion[];
}) {
    return (
        <div className="h-full flex flex-col">
            <ScrollArea className="flex-1 min-h-0">
                <div className="p-4 space-y-4">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Element
                    </h2>
                    {selected ? (
                        <ElementProperties
                            el={selected}
                            settings={doc.settings}
                            onUpdate={onUpdateElement}
                            variables={variables}
                        />
                    ) : (
                        <p className="text-sm text-muted-foreground italic px-1">
                            Select an element on the canvas to edit its properties.
                        </p>
                    )}
                </div>
            </ScrollArea>

            <div className="border-t border-black/[0.06] dark:border-white/[0.06] flex flex-col min-h-0 max-h-[40%]">
                <div className="px-4 pt-3 pb-1 flex items-center justify-between">
                    <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        Layers
                    </h2>
                    <span className="text-[10px] font-mono text-muted-foreground">
                        {doc.elements.length}
                    </span>
                </div>
                <ScrollArea className="flex-1 min-h-0">
                    <div className="px-2 pb-3">
                        <LayersList
                            elements={doc.elements}
                            selectedId={selected?.id ?? null}
                            onSelect={onSelectElement}
                            onUpdate={onUpdateElement}
                            onRemove={onRemoveElement}
                            onMoveTo={onMoveLayer}
                        />
                    </div>
                </ScrollArea>
            </div>
        </div>
    );
}

function describeElement(el: LabelElement): { icon: React.ReactNode; label: string } {
    switch (el.kind) {
        case "text":
            return { icon: <Type className="w-3.5 h-3.5" />, label: el.text || "(empty text)" };
        case "qr":
            return { icon: <QrCode className="w-3.5 h-3.5" />, label: el.data || "QR" };
        case "barcode":
            return {
                icon: <Barcode className="w-3.5 h-3.5" />,
                label: `${el.symbology}: ${el.data || "-"}`,
            };
        case "datamatrix":
            return {
                icon: <Grid3X3 className="w-3.5 h-3.5" />,
                label: `Data Matrix: ${el.data || "-"}`,
            };
        case "rect":
            return {
                icon: <SquareIcon className="w-3.5 h-3.5" />,
                label: `Rectangle${el.filled ? " (filled)" : ""}`,
            };
        case "line":
            return {
                icon: <Minus className="w-3.5 h-3.5" />,
                label: `Line ${el.orientation === "h" ? "horizontal" : "vertical"}`,
            };
        case "image":
            return {
                icon: <ImageIcon className="w-3.5 h-3.5" />,
                label: el.fileName ?? "Image",
            };
        case "table":
            return {
                icon: <TableIcon className="w-3.5 h-3.5" />,
                label: `Table ${el.rows}×${el.cols}`,
            };
    }
}

function LayersList({
    elements,
    selectedId,
    onSelect,
    onUpdate,
    onRemove,
    onMoveTo,
}: {
    elements: LabelElement[];
    selectedId: string | null;
    onSelect: (id: string | null) => void;
    onUpdate: (id: string, patch: Partial<LabelElement>) => void;
    onRemove: (id: string) => void;
    onMoveTo?: (id: string, toIndex: number) => void;
}) {
    const [dragId, setDragId] = useState<string | null>(null);
    const [overId, setOverId] = useState<string | null>(null);

    if (elements.length === 0) {
        return (
            <p className="text-sm text-muted-foreground italic px-1">
                No elements yet. Use the toolbar to add Text, QR, Barcode, Data Matrix, etc.
            </p>
        );
    }

    // Layers list shows top-of-stack first (visually drawn last), so we reverse.
    const visualOrder = [...elements].reverse();

    const onDragStart = (e: React.DragEvent<HTMLLIElement>, id: string) => {
        setDragId(id);
        e.dataTransfer.effectAllowed = "move";
        try {
            e.dataTransfer.setData("text/plain", id);
        } catch {
            /* Safari sometimes throws */
        }
    };
    const onDragOver = (e: React.DragEvent<HTMLLIElement>, id: string) => {
        if (!dragId || dragId === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setOverId(id);
    };
    const onDrop = (e: React.DragEvent<HTMLLIElement>, targetId: string) => {
        e.preventDefault();
        const sourceId = dragId;
        setDragId(null);
        setOverId(null);
        if (!sourceId || !onMoveTo || sourceId === targetId) return;
        // Visual list is top-first (reversed). Translate the target's visual
        // index back into the underlying array index.
        const targetVisualIdx = visualOrder.findIndex((el) => el.id === targetId);
        if (targetVisualIdx < 0) return;
        const targetArrayIdx = elements.length - 1 - targetVisualIdx;
        onMoveTo(sourceId, targetArrayIdx);
    };
    const onDragEnd = () => {
        setDragId(null);
        setOverId(null);
    };

    return (
        <ul className="space-y-1">
            {visualOrder.map((el) => {
                const d = describeElement(el);
                const isSel = el.id === selectedId;
                const isDragging = dragId === el.id;
                const isOver = overId === el.id;
                return (
                    <li
                        key={el.id}
                        draggable={!!onMoveTo}
                        onDragStart={(e) => onDragStart(e, el.id)}
                        onDragOver={(e) => onDragOver(e, el.id)}
                        onDragLeave={() => setOverId((id) => (id === el.id ? null : id))}
                        onDrop={(e) => onDrop(e, el.id)}
                        onDragEnd={onDragEnd}
                        className={cn(
                            "group flex items-center gap-2 rounded-md px-2 py-1.5 text-sm cursor-pointer transition-colors",
                            isSel
                                ? "bg-primary text-primary-foreground"
                                : "hover:bg-muted",
                            isDragging && "opacity-40",
                            isOver && "ring-2 ring-blue-500/60",
                        )}
                        onClick={() => onSelect(el.id)}
                    >
                        <GripVertical
                            className={cn(
                                "w-3 h-3 flex-shrink-0",
                                onMoveTo
                                    ? "text-muted-foreground cursor-grab active:cursor-grabbing"
                                    : "opacity-0",
                            )}
                        />
                        <span className="flex-shrink-0">{d.icon}</span>
                        <span
                            className="flex-1 min-w-0 truncate max-w-[160px]"
                            title={d.label}
                        >
                            {d.label}
                        </span>
                        <span className="text-[10px] font-mono opacity-70 flex-shrink-0 tabular-nums">
                            {el.size.w.toFixed(0)}×{el.size.h.toFixed(0)}
                        </span>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onUpdate(el.id, {
                                    locked: !el.locked,
                                } as Partial<LabelElement>);
                            }}
                            className="flex-shrink-0 opacity-0 group-hover:opacity-100 hover:text-blue-500 transition-opacity"
                            title={el.locked ? "Unlock" : "Lock"}
                        >
                            {el.locked ? (
                                <EyeOff className="w-3.5 h-3.5" />
                            ) : (
                                <Eye className="w-3.5 h-3.5" />
                            )}
                        </button>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemove(el.id);
                            }}
                            className="flex-shrink-0 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
                            title="Delete"
                        >
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}

function ScaleChips({
    value,
    onChange,
    label,
}: {
    value: Scale;
    onChange: (s: Scale) => void;
    label: string;
}) {
    return (
        <div>
            <Label className="text-xs">{label}</Label>
            <div className="flex gap-1 mt-1">
                {([1, 2, 3] as Scale[]).map((s) => (
                    <button
                        key={s}
                        onClick={() => onChange(s)}
                        className={cn(
                            "flex-1 h-8 rounded-[6px] ring-1 text-sm font-semibold transition-colors",
                            value === s
                                ? "bg-primary text-primary-foreground ring-primary"
                                : "bg-black/[0.03] dark:bg-white/[0.06] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ring-black/[0.08] dark:ring-white/10",
                        )}
                    >
                        {s}×
                    </button>
                ))}
            </div>
        </div>
    );
}

function NumField({
    label,
    value,
    onChange,
    step = 1,
    min,
    max,
    disabled = false,
}: {
    label: string;
    value: number;
    onChange: (n: number) => void;
    step?: number;
    min?: number;
    max?: number;
    disabled?: boolean;
}) {
    // Round display to 2 decimals so float-dust values like 0.4778611468096
    // don't overflow the narrow sidebar input. The user can still type any
    // value — onChange forwards the typed number unchanged.
    const display = Number.isFinite(value) ? Number(value.toFixed(2)) : 0;
    return (
        <div className="space-y-1 min-w-0">
            <Label className="text-xs">{label}</Label>
            <Input
                type="number"
                value={display}
                aria-label={label}
                step={step}
                min={min}
                max={max}
                disabled={disabled}
                className="w-full"
                onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) onChange(n);
                }}
            />
        </div>
    );
}

function AlignmentField({
    label,
    command,
    valueDots,
    dpi,
    min,
    max,
    direction,
    onChangeDots,
}: {
    label: string;
    command: "^LT" | "^LS";
    valueDots: number;
    dpi: PrinterDpi;
    min: number;
    max: number;
    direction: string;
    onChangeDots: (n: number) => void;
}) {
    const dots = Math.max(min, Math.min(max, Math.round(valueDots)));

    return (
        <div className="space-y-1.5 min-w-0">
            <Label className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate">{label}</span>
                <code className="shrink-0 text-[10px] text-muted-foreground">{command}</code>
            </Label>
            <Input
                type="number"
                value={dots}
                step={1}
                min={min}
                max={max}
                className="h-11 w-full font-mono tabular-nums"
                onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) {
                        onChangeDots(Math.max(min, Math.min(max, Math.round(n))));
                    }
                }}
            />
            <div className="text-[10px] leading-snug text-muted-foreground">
                <span className="tabular-nums">{dotsToMm(dots, dpi).toFixed(3)} mm</span>
                <span aria-hidden="true"> · </span>
                {direction}
            </div>
        </div>
    );
}

function rfidReadFieldName(settings: LabelSettings): string {
    return (settings.rfid.readFieldName ?? "rfid_read")
        .trim()
        .replace(/^\{|\}$/g, "") || "rfid_read";
}

function rfidReadPlaceholderRegex(settings: LabelSettings, global = false): RegExp {
    const escaped = rfidReadFieldName(settings).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\{\\s*${escaped}\\s*\\}`, global ? "gi" : "i");
}

function barcodeUsesRfidRead(el: Pick<BarcodeEl, "data" | "fieldName">, settings: LabelSettings): boolean {
    if (!settings.rfid.readEnabled) return false;
    const fieldName = rfidReadFieldName(settings).toLowerCase();
    return (el.fieldName ?? "").trim().toLowerCase() === fieldName ||
        rfidReadPlaceholderRegex(settings).test(el.data);
}

const SYMBOL_VARIABLE_RE = /\{[A-Za-z_][A-Za-z0-9_]*\}/;

function deferredDynamicSymbolCheck(symbolName: string) {
    return {
        level: "deferred" as const,
        summary: `${symbolName} uses dynamic data`,
        details: "Resolved and validated for every data row before printing",
        lines: ["Select or import a data row to verify its final capacity and physical module size."],
    };
}

function barcodeAnalysisData(el: BarcodeEl, settings: LabelSettings): string {
    const fallback = el.symbology === "EAN13" ? "5901234123457" : "BARCODE";
    const data = el.data || fallback;
    if (!barcodeUsesRfidRead(el, settings)) return data;
    const readLength = zebraRfidReadHexCharacterCount(settings.rfid);
    const sample = el.symbology === "EAN13"
        ? "0".repeat(Math.min(13, readLength))
        : "F".repeat(readLength);
    if ((el.fieldName ?? "").trim().toLowerCase() === rfidReadFieldName(settings).toLowerCase() &&
        !rfidReadPlaceholderRegex(settings).test(data)) {
        return sample;
    }
    return data.replace(rfidReadPlaceholderRegex(settings, true), sample);
}

function barcodeScanCheck(el: BarcodeEl, settings: LabelSettings) {
    const hasRfidRead = barcodeUsesRfidRead(el, settings);
    if (el.symbology === "EAN13" && hasRfidRead) {
        return {
            level: "error" as const,
            summary: "Use Code 128 or QR for RFID data",
            lines: [`EAN-13 cannot encode RFID HEX. Use Code 128 or QR for {${rfidReadFieldName(settings)}}.`],
        };
    }
    if (!hasRfidRead && (!!el.fieldName || SYMBOL_VARIABLE_RE.test(el.data))) {
        return deferredDynamicSymbolCheck(el.symbology === "EAN13" ? "EAN-13" : "Code 128");
    }

    const analysisData = barcodeAnalysisData(el, settings);
    const result = renderBarcode(analysisData, el.symbology);
    if (!result || result.totalModules <= 0) {
        return {
            level: "error" as const,
            summary: "Invalid barcode data",
            lines: [el.symbology === "EAN13"
                ? "EAN-13 requires exactly 12 data digits, or 13 digits with a valid checksum."
                : "Code 128 data must be non-empty printable ASCII (characters U+0020 through U+007E)."],
        };
    }

    const dpi = settings.dpi ?? 203;
    const quarterTurn = el.rotation === 90 || el.rotation === 270;
    const logicalWidthMm = quarterTurn ? el.size.h : el.size.w;
    const logicalHeightMm = quarterTurn ? el.size.w : el.size.h;
    const widthDots = Math.max(1, mmToDots(logicalWidthMm, dpi));
    const manual = el.sizeMode === "manual" ||
        (el.sizeMode === undefined && typeof el.narrowDots === "number");
    const minModuleMm = el.minModuleMm ?? 0.25;
    const layout = barcodeModuleLayout({
        containerDots: widthDots,
        totalModules: result.totalModules,
        quietZoneLeftModules: result.quietZoneLeftModules,
        quietZoneRightModules: result.quietZoneRightModules,
        dpi,
        minModuleMm,
        align: el.align ?? "center",
        mode: manual ? "fixed" : "auto",
        requestedDotsPerModule: manual
            ? (el.narrowDots ?? scanSafeBarcodeNarrowDots(dpi))
            : undefined,
    });
    const lines: string[] = [];

    if (!layout.fitsFrame) {
        lines.push(
            `${manual ? "Manual" : "Auto"} ${layout.dotsPerModule}-dot X-dimension needs ` +
            `${layout.printedWidthMm.toFixed(2)} mm, but the frame provides ${logicalWidthMm.toFixed(2)} mm along the barcode axis. Test printing is allowed; the symbol may be clipped.`,
        );
    }
    if (layout.xDimensionMm + 1e-9 < minModuleMm) {
        lines.push(
            `${layout.dotsPerModule} dot/module = ${layout.xDimensionMm.toFixed(3)} mm, below the configured ${minModuleMm.toFixed(3)} mm minimum. ` +
            `Meeting this minimum needs ${layout.requiredSafeWidthMm.toFixed(2)} mm. Test print and adjust dots/module or frame size.`,
        );
    }
    const heightLayout = barcodeHeightLayout({
        frameHeightDots: Math.max(1, mmToDots(logicalHeightMm, dpi)),
        dpi,
        humanReadable: el.humanReadable,
        barHeightMm: el.barHeightMm,
        textSizeMm: el.textSizeMm,
        textPaddingMm: el.textPaddingMm,
        textPosition: el.textPosition,
    });
    if (!heightLayout.fitsFrame) {
        lines.push(
            `Bars and human-readable text require ${(
                heightLayout.barHeightMm +
                dotsToMm(heightLayout.textHeightDots + heightLayout.textPaddingDots, dpi)
            ).toFixed(2)} mm, but the frame provides ${logicalHeightMm.toFixed(2)} mm across the barcode axis.`,
        );
    }

    if (hasRfidRead) {
        lines.push("RFID size is estimated until the printer reads the tag. Test a few tags, then adjust manual dots/module and scan the result.");
    }
    return {
        level: lines.length ? "warning" as const : "ok" as const,
        summary: lines.length ? "Barcode warning · test printing allowed" : "Barcode ready to print",
        details:
            `${manual ? "Fixed" : "Automatic"} · ` +
            `${layout.dotsPerModule} dots/module = ${layout.xDimensionMm.toFixed(3)} mm ` +
            `@ ${dpi} dpi · ${layout.printedWidthMm.toFixed(2)} mm wide`,
        lines,
    };
}

function automaticBarcodeBarHeightMm(el: BarcodeEl): number {
    const hriReserveMm = el.humanReadable
        ? (el.textSizeMm ?? 2) + (el.textPaddingMm ?? 0.3)
        : 0;
    const logicalHeightMm = el.rotation === 90 || el.rotation === 270
        ? el.size.w
        : el.size.h;
    return Math.max(0.5, logicalHeightMm - hriReserveMm);
}

function dataMatrixSizeValue(el: DataMatrixEl): string {
    return typeof el.symbolRows === "number" && typeof el.symbolColumns === "number"
        ? `${el.symbolRows}x${el.symbolColumns}`
        : "auto";
}

function qrScanCheck(el: Extract<LabelElement, { kind: "qr" }>, settings: LabelSettings) {
    if (!el.data.trim() && !el.fieldName) {
        return {
            level: "error" as const,
            summary: "QR data is required",
            lines: ["QR data is empty. Empty QR elements are not printable."],
        };
    }
    if (barcodeUsesRfidRead(el, settings)) {
        return {
            level: "warning" as const,
            summary: "RFID QR · test printing allowed",
            details: "Final data is read from the tag during printing",
            lines: ["QR sizing is estimated from the configured RFID read length. Print a few tags, adjust manual magnification and verify with your scanner."],
        };
    }
    if (!!el.fieldName || SYMBOL_VARIABLE_RE.test(el.data)) {
        return deferredDynamicSymbolCheck("QR");
    }
    try {
        const data = el.data || "QR-DATA";
        const modules = qrModuleCount(data, el.ecc, qrMinVersion(el.version));
        const dpi = settings.dpi ?? 203;
        const layout = fitQrToFrameDots(
            Math.max(1, mmToDots(el.size.w, dpi)),
            Math.max(1, mmToDots(el.size.h, dpi)),
            modules,
            {
                quietZoneModules: el.quietZoneModules,
                requestedMagnification: el.sizeMode === "manual" ||
                    (el.sizeMode === undefined && typeof el.magnification === "number")
                    ? el.magnification
                    : undefined,
                dpi,
                minModuleMm: el.minModuleMm,
                align: el.align,
                verticalAlign: el.verticalAlign,
            },
        );
        const lines: string[] = [];
        if (!layout.fitsFrame) {
            lines.push("The QR plus quiet zone does not fit the frame. Test printing is allowed; adjust magnification or frame size and scan the result.");
        }
        if (layout.moduleSizeMm + 1e-9 < layout.minModuleMm) {
            lines.push(
                `Module size is below the configured ${layout.minModuleMm.toFixed(3)} mm scanner minimum; enlarge the frame or lower ECC/version.`,
            );
        }
        return {
            level: layout.fitsFrame && layout.scanSafe ? "ok" as const : "warning" as const,
            summary: layout.fitsFrame && layout.scanSafe
                ? "QR ready to print"
                : "QR warning · test printing allowed",
            details:
                `${layout.auto ? "Automatic" : "Fixed"} · ` +
                `${layout.moduleDots} dots/module = ${layout.moduleSizeMm.toFixed(3)} mm ` +
                `@ ${dpi} dpi · Version ${(modules - 17) / 4}`,
            lines,
        };
    } catch (error) {
        return {
            level: "error" as const,
            summary: "QR data cannot be encoded",
            lines: [error instanceof Error ? error.message : "QR data cannot be encoded."],
        };
    }
}

function dataMatrixScanCheck(el: DataMatrixEl, settings: LabelSettings) {
    if (!el.data.trim() && !el.fieldName) {
        return {
            level: "error" as const,
            summary: "Data Matrix data is required",
            details: "",
            lines: ["Empty Data Matrix elements are not printable."],
        };
    }
    if (!!el.fieldName || SYMBOL_VARIABLE_RE.test(el.data)) {
        return deferredDynamicSymbolCheck("Data Matrix");
    }
    try {
        const matrix = encodeDataMatrix(el.data || "DM-DATA", {
            contentFormat: el.contentFormat,
            shape: el.shape,
            textEncoding: el.textEncoding,
            symbolRows: el.symbolRows,
            symbolColumns: el.symbolColumns,
        });
        const dpi = settings.dpi ?? 203;
        const quarterTurn = el.rotation === 90 || el.rotation === 270;
        const renderedColumns = quarterTurn ? matrix.rows : matrix.columns;
        const renderedRows = quarterTurn ? matrix.columns : matrix.rows;
        const layout = fitDataMatrixToFrameDots(
            Math.max(1, mmToDots(el.size.w, dpi)),
            Math.max(1, mmToDots(el.size.h, dpi)),
            renderedColumns,
            renderedRows,
            {
                quietZoneModules: el.quietZoneModules,
                requestedMagnification: el.sizeMode === "manual" ||
                    (el.sizeMode === undefined && typeof el.magnification === "number")
                    ? el.magnification
                    : undefined,
                dpi,
                minModuleMm: el.minModuleMm,
                align: el.align,
                verticalAlign: el.verticalAlign,
            },
        );
        const lines: string[] = [];
        if (!layout.fitsFrame) {
            lines.push(
                `The rotated ${renderedColumns} × ${renderedRows} matrix plus quiet zone does not fit the frame; printing is blocked.`,
            );
        }
        if (layout.moduleSizeMm + 1e-9 < layout.minModuleMm) {
            lines.push(
                `Module size is below the configured ${layout.minModuleMm.toFixed(3)} mm scanner minimum; enlarge the frame or shorten the data.`,
            );
        }
        return {
            level: lines.length ? "error" as const : "ok" as const,
            summary: lines.length ? "Increase the Data Matrix size" : "Data Matrix ready to print",
            details:
                `${layout.auto ? "Automatic" : "Fixed"} · ` +
                `${layout.moduleDots} dots/module = ${layout.moduleSizeMm.toFixed(3)} mm ` +
                `@ ${dpi} dpi · ${renderedColumns} × ${renderedRows} modules`,
            lines,
        };
    } catch (error) {
        return {
            level: "error" as const,
            summary: "Data Matrix data cannot be encoded",
            details: "",
            lines: [error instanceof Error ? error.message : "Invalid Data Matrix data."],
        };
    }
}

function ElementProperties({
    el,
    settings,
    onUpdate,
    variables,
}: {
    el: LabelElement;
    settings: LabelSettings;
    onUpdate: (id: string, patch: Partial<LabelElement>) => void;
    variables?: VariableSuggestion[];
}) {
    const patch = (p: Partial<LabelElement>) => onUpdate(el.id, p);
    const barcodeCheck = el.kind === "barcode" ? barcodeScanCheck(el, settings) : null;
    const qrCheck = el.kind === "qr" ? qrScanCheck(el, settings) : null;
    const dataMatrixCheck = el.kind === "datamatrix"
        ? dataMatrixScanCheck(el, settings)
        : null;
    return (
        <div className="space-y-4">
            <div className="text-xs font-mono text-muted-foreground">
                {el.kind.toUpperCase()} · id: {el.id}
            </div>

            <div className="grid grid-cols-2 gap-2">
                <NumField
                    label="X (mm)"
                    value={el.pos.x}
                    step={0.5}
                    onChange={(x) => patch({ pos: { ...el.pos, x } } as Partial<LabelElement>)}
                />
                <NumField
                    label="Y (mm)"
                    value={el.pos.y}
                    step={0.5}
                    onChange={(y) => patch({ pos: { ...el.pos, y } } as Partial<LabelElement>)}
                />
                {el.kind === "qr" ||
                (el.kind === "datamatrix" && (el.shape ?? "square") === "square") ? (
                    <div className="col-span-2">
                        <NumField
                            label={el.kind === "qr" ? "QR size (mm)" : "Data Matrix size (mm)"}
                            value={Math.min(el.size.w, el.size.h)}
                            step={0.5}
                            min={1}
                            onChange={(side) =>
                                patch({ size: { w: side, h: side } } as Partial<LabelElement>)
                            }
                        />
                    </div>
                ) : (
                    <>
                        <NumField
                            label="W (mm)"
                            value={el.size.w}
                            step={0.5}
                            min={1}
                            onChange={(w) =>
                                patch({ size: { ...el.size, w } } as Partial<LabelElement>)
                            }
                        />
                        <NumField
                            label="H (mm)"
                            value={el.size.h}
                            step={0.5}
                            min={1}
                            onChange={(h) =>
                                patch({ size: { ...el.size, h } } as Partial<LabelElement>)
                            }
                        />
                    </>
                )}
            </div>

            {(el.kind === "qr" || el.kind === "datamatrix" || el.kind === "barcode" || el.kind === "image" || el.kind === "table") && (
                <div className="space-y-1">
                    <Label className="text-xs">Rotation</Label>
                    <Select
                        value={String(el.rotation ?? 0)}
                        onValueChange={(value) => patch({
                            rotation: Number(value) as Rotation,
                        } as Partial<LabelElement>)}
                    >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="0">0° · Normal</SelectItem>
                            <SelectItem value="90">90° · Right</SelectItem>
                            <SelectItem value="180">180° · Inverted</SelectItem>
                            <SelectItem value="270">270° · Left</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            )}

            <Separator />

            {el.kind === "text" && (
                <TextEditor
                    el={el}
                    settings={settings}
                    patch={patch}
                    variables={variables}
                />
            )}

            {el.kind === "qr" && (
                <div className="space-y-3">
                    <div className="space-y-1">
                        <Label className="text-xs">Data</Label>
                        <HighlightedField
                            multiline
                            value={el.data}
                            rows={2}
                            onChange={(data) => patch({ data } as Partial<LabelElement>)}
                            placeholder="Use {SKU}, {rfid}, {serial}, or {step}"
                            variables={variables}
                        />
                    </div>
                    <div>
                            <Label className="text-xs">Error correction</Label>
                            <Select
                                value={el.ecc}
                                onValueChange={(v) =>
                                    patch({ ecc: v as ECC } as Partial<LabelElement>)
                                }
                            >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="L">Low · L (~7%)</SelectItem>
                                    <SelectItem value="M">Standard · M (~15%)</SelectItem>
                                    <SelectItem value="Q">High · Q (~25%)</SelectItem>
                                    <SelectItem value="H">Maximum · H (~30%)</SelectItem>
                                </SelectContent>
                            </Select>
                    </div>
                    <details className="group rounded-[6px] border border-border bg-muted/20">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                            More QR settings
                            {((el.sizeMode ?? "auto") !== "auto" ||
                                (el.minModuleMm ?? 0.33) !== 0.33 ||
                                (el.quietZoneModules ?? 4) !== 4 ||
                                (el.align ?? "center") !== "center" ||
                                (el.verticalAlign ?? "center") !== "center" ||
                                (el.version ?? 0) !== 0) && (
                                <span className="ml-auto rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-normal dark:bg-white/[0.08]">
                                    Custom
                                </span>
                            )}
                        </summary>
                        <div className="grid grid-cols-2 gap-2 border-t border-border p-2.5">
                            <div className="col-span-2">
                                <Label className="text-xs">Sizing</Label>
                                <Select
                                    value={el.sizeMode ?? "auto"}
                                    onValueChange={(v) =>
                                        patch({
                                            sizeMode: v as SymbolSizeMode,
                                            magnification: v === "manual"
                                                ? (el.magnification ?? 4)
                                                : undefined,
                                        } as Partial<LabelElement>)
                                    }
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="auto">Fit to frame (recommended)</SelectItem>
                                        <SelectItem value="manual">Fixed module size</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            {(el.sizeMode === "manual" ||
                                (el.sizeMode === undefined && typeof el.magnification === "number")) && (
                                <div className="col-span-2 space-y-1">
                                    <NumField
                                        label="Magnification / module size (dots)"
                                        value={el.magnification ?? 4}
                                        step={1}
                                        min={1}
                                        max={10}
                                        onChange={(magnification) => patch({
                                            magnification: Math.max(1, Math.min(10, Math.round(magnification))),
                                        } as Partial<LabelElement>)}
                                    />
                                    <p className="text-[10px] leading-snug text-muted-foreground">
                                        Zebra magnification · {el.magnification ?? 4} dots = {dotsToMm(el.magnification ?? 4, settings.dpi ?? 203).toFixed(3)} mm at {settings.dpi ?? 203} dpi.
                                    </p>
                                </div>
                            )}
                            {el.sizeMode !== "manual" && qrCheck?.details && (
                                <div className="col-span-2 rounded-[5px] bg-background px-2.5 py-2">
                                    <p className="text-[10px] font-medium text-muted-foreground">Actual module size</p>
                                    <p className="mt-0.5 text-xs font-semibold text-foreground">
                                        {qrCheck.details.replace(/^Automatic · /, "")}
                                    </p>
                                </div>
                            )}
                            <div>
                                <Label className="text-xs">Horizontal align</Label>
                                <Select
                                    value={el.align ?? "center"}
                                    onValueChange={(value) => patch({
                                        align: value as DataMatrixAlign,
                                    } as Partial<LabelElement>)}
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="left">Left</SelectItem>
                                        <SelectItem value="center">Center</SelectItem>
                                        <SelectItem value="right">Right</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div>
                                <Label className="text-xs">Vertical align</Label>
                                <Select
                                    value={el.verticalAlign ?? "center"}
                                    onValueChange={(value) => patch({
                                        verticalAlign: value as DataMatrixVerticalAlign,
                                    } as Partial<LabelElement>)}
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="top">Top</SelectItem>
                                        <SelectItem value="center">Center</SelectItem>
                                        <SelectItem value="bottom">Bottom</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="col-span-2 space-y-1">
                                <NumField
                                    label="Quiet zone (modules)"
                                    value={el.quietZoneModules ?? 4}
                                    step={1}
                                    min={4}
                                    max={16}
                                    onChange={(quietZoneModules) => patch({
                                        quietZoneModules: Math.max(4, Math.min(16, Math.round(quietZoneModules))),
                                    } as Partial<LabelElement>)}
                                />
                                <p className="text-[10px] leading-snug text-muted-foreground">
                                    QR Model 2 requires at least four clear modules on every side.
                                </p>
                            </div>
                            <details className="group/expert col-span-2 rounded-[5px] border border-border">
                                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-[11px] font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                                    <ChevronRight className="h-3 w-3 transition-transform group-open/expert:rotate-90" />
                                    Expert settings
                                </summary>
                                <div className="grid grid-cols-2 gap-2 border-t border-border p-2.5">
                                    <NumField
                                        label="Minimum module (mm)"
                                        value={el.minModuleMm ?? 0.33}
                                        step={0.01}
                                        min={0.1}
                                        max={2}
                                        onChange={(minModuleMm) => patch({ minModuleMm } as Partial<LabelElement>)}
                                    />
                                    <NumField
                                        label="Minimum version (0=Auto)"
                                        value={el.version ?? 0}
                                        step={1}
                                        min={0}
                                        max={40}
                                        onChange={(version) => patch({
                                            version: Math.max(0, Math.min(40, Math.round(version))),
                                        } as Partial<LabelElement>)}
                                    />
                                    <p className="col-span-2 text-[10px] leading-snug text-muted-foreground">
                                        Model 2 is used. Resolved data is emitted as the exact module grid shown here; only printer-resolved RFID fields use native ^BQ.
                                    </p>
                                </div>
                            </details>
                        </div>
                    </details>
                    {qrCheck && (
                        <div className={cn(
                            "rounded-[6px] border px-2.5 py-2 text-[11px] leading-relaxed",
                            qrCheck.level === "error"
                                ? "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200"
                                : qrCheck.level === "deferred" || qrCheck.level === "warning"
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                                : "border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
                        )}>
                            <div className="flex items-center gap-1.5 font-semibold">
                                {qrCheck.level === "error" || qrCheck.level === "warning" ? (
                                    <AlertCircle className="h-3.5 w-3.5" />
                                ) : qrCheck.level === "deferred" ? (
                                    <RefreshCw className="h-3.5 w-3.5" />
                                ) : (
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                )}
                                {qrCheck.summary}
                            </div>
                            {qrCheck.details && (
                                <p className="mt-1 pl-5 text-[10px] opacity-80">
                                    {qrCheck.details}
                                </p>
                            )}
                            {qrCheck.lines.length > 0 && (
                                <div className="mt-1 pl-5">
                                    {qrCheck.lines.map((line) => <p key={line}>{line}</p>)}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {el.kind === "datamatrix" && (
                <div className="space-y-3">
                    <div className="space-y-1">
                        <Label className="text-xs">Data</Label>
                        <HighlightedField
                            multiline
                            value={el.data}
                            rows={3}
                            onChange={(data) => patch({ data } as Partial<LabelElement>)}
                            placeholder="Use text, {SKU}, {serial}, or {step}"
                            variables={variables}
                        />
                    </div>
                    <div>
                        <Label className="text-xs">Content format</Label>
                        <Select
                            value={el.contentFormat ?? "standard"}
                            onValueChange={(value) => patch({
                                contentFormat: value as DataMatrixContentFormat,
                                textEncoding: value === "standard"
                                    ? (el.textEncoding ?? "utf8")
                                    : "utf8",
                            } as Partial<LabelElement>)}
                        >
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="standard">Standard ECC 200</SelectItem>
                                <SelectItem value="gs1">GS1 Data Matrix</SelectItem>
                                <SelectItem value="gs1_digital_link">GS1 Digital Link</SelectItem>
                            </SelectContent>
                        </Select>
                        {(el.contentFormat ?? "standard") === "gs1" && (
                            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                                Enter GS1 AIs with parentheses, for example (01)09501101530003(10)LOT123.
                            </p>
                        )}
                        {el.contentFormat === "gs1_digital_link" && (
                            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                                Enter a complete GS1 Digital Link URI including its domain and AI path.
                            </p>
                        )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <Label className="text-xs">Shape</Label>
                            <Select
                                value={el.shape ?? "square"}
                                onValueChange={(value) => {
                                    const selected = value as DataMatrixShape;
                                    const side = Math.min(el.size.w, el.size.h);
                                    patch({
                                        shape: selected,
                                        symbolRows: undefined,
                                        symbolColumns: undefined,
                                        size: selected === "square"
                                            ? { w: side, h: side }
                                            : el.size,
                                    } as Partial<LabelElement>);
                                }}
                            >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="square">Square</SelectItem>
                                    <SelectItem value="rectangle">Rectangular</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label className="text-xs">Text encoding</Label>
                            <Select
                                value={el.textEncoding ?? "utf8"}
                                disabled={(el.contentFormat ?? "standard") !== "standard"}
                                onValueChange={(value) => patch({
                                    textEncoding: value as DataMatrixTextEncoding,
                                } as Partial<LabelElement>)}
                            >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="utf8">UTF-8</SelectItem>
                                    <SelectItem value="latin1">ISO-8859-1</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div className="col-span-2">
                            <Label className="text-xs">Matrix size</Label>
                            <Select
                                value={dataMatrixSizeValue(el)}
                                onValueChange={(value) => {
                                    if (value === "auto") {
                                        patch({
                                            symbolRows: undefined,
                                            symbolColumns: undefined,
                                        } as Partial<LabelElement>);
                                        return;
                                    }
                                    const [symbolRows, symbolColumns] = value
                                        .split("x")
                                        .map(Number);
                                    patch({ symbolRows, symbolColumns } as Partial<LabelElement>);
                                }}
                            >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="auto">Auto (recommended)</SelectItem>
                                    {(el.shape ?? "square") === "square"
                                        ? DATA_MATRIX_ECC200_SQUARE_SIZES.map((side) => (
                                            <SelectItem key={side} value={`${side}x${side}`}>
                                                {side} × {side} modules
                                            </SelectItem>
                                        ))
                                        : DATA_MATRIX_ECC200_RECTANGLE_SIZES.map(([rows, columns]) => (
                                            <SelectItem
                                                key={`${rows}x${columns}`}
                                                value={`${rows}x${columns}`}
                                            >
                                                {rows} × {columns} modules
                                            </SelectItem>
                                        ))}
                                </SelectContent>
                            </Select>
                            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                                Auto selects the smallest ECC 200 matrix that holds the resolved data.
                            </p>
                        </div>
                    </div>
                    <details className="group rounded-[6px] border border-border bg-muted/20">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                            More Data Matrix settings
                            {((el.sizeMode ?? "auto") !== "auto" ||
                                dataMatrixSizeValue(el) !== "auto" ||
                                (el.minModuleMm ?? 0.25) !== 0.25 ||
                                (el.quietZoneModules ?? 1) !== 1 ||
                                (el.align ?? "center") !== "center" ||
                                (el.verticalAlign ?? "center") !== "center") && (
                                <span className="ml-auto rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-normal dark:bg-white/[0.08]">
                                    Custom
                                </span>
                            )}
                        </summary>
                        <div className="grid grid-cols-2 gap-2 border-t border-border p-2.5">
                            <div className="col-span-2">
                                <Label className="text-xs">Sizing</Label>
                                <Select
                                    value={el.sizeMode ?? "auto"}
                                    onValueChange={(value) => patch({
                                        sizeMode: value as SymbolSizeMode,
                                        magnification: value === "manual"
                                            ? (el.magnification ?? 3)
                                            : undefined,
                                    } as Partial<LabelElement>)}
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="auto">Fit to frame (recommended)</SelectItem>
                                        <SelectItem value="manual">Fixed module size</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            {(el.sizeMode === "manual" ||
                                (el.sizeMode === undefined && typeof el.magnification === "number")) && (
                                <div className="col-span-2 space-y-1">
                                    <NumField
                                        label="Magnification / module size (dots)"
                                        value={el.magnification ?? 3}
                                        step={1}
                                        min={1}
                                        max={40}
                                        onChange={(magnification) => patch({
                                            magnification: Math.max(1, Math.min(40, Math.round(magnification))),
                                        } as Partial<LabelElement>)}
                                    />
                                    <p className="text-[10px] leading-snug text-muted-foreground">
                                        {el.magnification ?? 3} dots = {dotsToMm(el.magnification ?? 3, settings.dpi ?? 203).toFixed(3)} mm at {settings.dpi ?? 203} dpi.
                                    </p>
                                </div>
                            )}
                            {el.sizeMode !== "manual" && dataMatrixCheck?.details && (
                                <div className="col-span-2 rounded-[5px] bg-background px-2.5 py-2">
                                    <p className="text-[10px] font-medium text-muted-foreground">Actual module size</p>
                                    <p className="mt-0.5 text-xs font-semibold text-foreground">
                                        {dataMatrixCheck.details.replace(/^Automatic · /, "")}
                                    </p>
                                </div>
                            )}
                            <div>
                                <Label className="text-xs">Horizontal align</Label>
                                <Select
                                    value={el.align ?? "center"}
                                    onValueChange={(value) => patch({
                                        align: value as DataMatrixAlign,
                                    } as Partial<LabelElement>)}
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="left">Left</SelectItem>
                                        <SelectItem value="center">Center</SelectItem>
                                        <SelectItem value="right">Right</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div>
                                <Label className="text-xs">Vertical align</Label>
                                <Select
                                    value={el.verticalAlign ?? "center"}
                                    onValueChange={(value) => patch({
                                        verticalAlign: value as DataMatrixVerticalAlign,
                                    } as Partial<LabelElement>)}
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="top">Top</SelectItem>
                                        <SelectItem value="center">Center</SelectItem>
                                        <SelectItem value="bottom">Bottom</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <NumField
                                label="Quiet zone (modules)"
                                value={el.quietZoneModules ?? 1}
                                step={1}
                                min={1}
                                max={16}
                                onChange={(quietZoneModules) => patch({
                                    quietZoneModules: Math.max(1, Math.min(16, Math.round(quietZoneModules))),
                                } as Partial<LabelElement>)}
                            />
                            <NumField
                                label="Minimum module (mm)"
                                value={el.minModuleMm ?? 0.25}
                                step={0.01}
                                min={0.1}
                                max={2}
                                onChange={(minModuleMm) => patch({ minModuleMm } as Partial<LabelElement>)}
                            />
                            <p className="col-span-2 text-[10px] leading-snug text-muted-foreground">
                                ECC 200 is used. The quiet zone is included in the frame and every module is snapped to whole printer dots. Zebra supports up to 3,116 numeric, 2,335 alphanumeric, or 1,556 8-bit characters. Resolved data is emitted as the exact module grid; only printer-resolved RFID fields use native ^BX.
                            </p>
                        </div>
                    </details>
                    {dataMatrixCheck && (
                        <div className={cn(
                            "rounded-[6px] border px-2.5 py-2 text-[11px] leading-relaxed",
                            dataMatrixCheck.level === "error"
                                ? "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200"
                                : dataMatrixCheck.level === "deferred"
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                                : "border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
                        )}>
                            <div className="flex items-center gap-1.5 font-semibold">
                                {dataMatrixCheck.level === "error" ? (
                                    <AlertCircle className="h-3.5 w-3.5" />
                                ) : dataMatrixCheck.level === "deferred" ? (
                                    <RefreshCw className="h-3.5 w-3.5" />
                                ) : (
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                )}
                                {dataMatrixCheck.summary}
                            </div>
                            {dataMatrixCheck.details && (
                                <p className="mt-1 pl-5 text-[10px] opacity-80">
                                    {dataMatrixCheck.details}
                                </p>
                            )}
                            {dataMatrixCheck.lines.length > 0 && (
                                <div className="mt-1 pl-5">
                                    {dataMatrixCheck.lines.map((line) => <p key={line}>{line}</p>)}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {el.kind === "barcode" && (
                <div className="space-y-3">
                    <div className="space-y-1">
                        <Label className="text-xs">Data</Label>
                        <HighlightedField
                            value={el.data}
                            onChange={(data) => patch({ data } as Partial<LabelElement>)}
                            placeholder="Use {SKU}, {serial}, or {step}"
                            variables={variables}
                        />
                    </div>
                    <div>
                        <Label className="text-xs">Symbology</Label>
                        <Select
                            value={el.symbology}
                            onValueChange={(v) => patch({
                                symbology: v as Symbology,
                                ...(v === "EAN13"
                                    ? {
                                          textAlign: "center" as const,
                                          textSizeMm: 2,
                                          textPaddingMm: 0.3,
                                      }
                                    : {}),
                            } as Partial<LabelElement>)}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="CODE128">Code 128</SelectItem>
                                <SelectItem value="EAN13">EAN-13</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex items-center justify-between">
                        <Label className="text-xs">Human-readable</Label>
                        <Switch
                            checked={el.humanReadable}
                            onCheckedChange={(v) =>
                                patch({ humanReadable: v } as Partial<LabelElement>)
                            }
                        />
                    </div>
                    <details className="group rounded-[6px] border border-border bg-muted/20">
                        <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
                            <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
                            More barcode settings
                            {((el.sizeMode ?? "auto") !== "auto" ||
                                (el.align ?? "center") !== "center" ||
                                (el.minModuleMm ?? 0.25) !== 0.25 ||
                                 el.barHeightMm !== undefined ||
                                 (el.textPosition ?? "below") !== "below" ||
                                 (el.symbology === "CODE128" && (
                                     (el.textAlign ?? "center") !== "center" ||
                                     (el.textSizeMm ?? 2) !== 2 ||
                                     (el.textPaddingMm ?? 0.3) !== 0.3
                                 ))) && (
                                <span className="ml-auto rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] font-normal dark:bg-white/[0.08]">
                                    Custom
                                </span>
                            )}
                        </summary>
                        <div className="grid grid-cols-2 gap-2 border-t border-border p-2.5">
                            <div className="col-span-2">
                                <Label className="text-xs">Sizing</Label>
                                <Select
                                    value={el.sizeMode ?? (typeof el.narrowDots === "number" ? "manual" : "auto")}
                                    onValueChange={(v) => patch({
                                        sizeMode: v as SymbolSizeMode,
                                        narrowDots: v === "manual"
                                            ? (el.narrowDots ?? scanSafeBarcodeNarrowDots(settings.dpi ?? 203))
                                            : undefined,
                                        wideDots: undefined,
                                        widthMode: undefined,
                                    } as Partial<LabelElement>)}
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="auto">Fit to frame (recommended)</SelectItem>
                                        <SelectItem value="manual">Fixed X-dimension</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            {(el.sizeMode === "manual" ||
                                (el.sizeMode === undefined && typeof el.narrowDots === "number")) ? (
                                <div className="col-span-2 space-y-1">
                                    <NumField
                                        label="X-dimension (dots)"
                                        value={el.narrowDots ?? scanSafeBarcodeNarrowDots(settings.dpi ?? 203)}
                                        step={1}
                                        min={1}
                                        max={10}
                                        onChange={(narrowDots) => patch({
                                            narrowDots: Math.max(1, Math.min(10, Math.round(narrowDots))),
                                        } as Partial<LabelElement>)}
                                    />
                                    <p className="text-[10px] leading-snug text-muted-foreground">
                                        Narrow bar · {el.narrowDots ?? scanSafeBarcodeNarrowDots(settings.dpi ?? 203)} dots = {dotsToMm(el.narrowDots ?? scanSafeBarcodeNarrowDots(settings.dpi ?? 203), settings.dpi ?? 203).toFixed(3)} mm at {settings.dpi ?? 203} dpi.
                                    </p>
                                </div>
                            ) : barcodeCheck?.details ? (
                                <div className="col-span-2 rounded-[5px] bg-background px-2.5 py-2">
                                    <p className="text-[10px] font-medium text-muted-foreground">Actual X-dimension</p>
                                    <p className="mt-0.5 text-xs font-semibold text-foreground">
                                        {barcodeCheck.details.replace(/^Automatic · /, "")}
                                    </p>
                                </div>
                            ) : null}
                            <div className="col-span-2 space-y-1">
                                <NumField
                                    label="Bar height (mm)"
                                    value={el.barHeightMm ?? automaticBarcodeBarHeightMm(el)}
                                    step={0.5}
                                    min={0.5}
                                    max={automaticBarcodeBarHeightMm(el)}
                                    onChange={(barHeightMm) => patch({
                                        barHeightMm: Math.max(
                                            0.5,
                                            Math.min(automaticBarcodeBarHeightMm(el), barHeightMm),
                                        ),
                                    } as Partial<LabelElement>)}
                                />
                                <div className="flex items-center justify-between gap-2 text-[10px] leading-snug text-muted-foreground">
                                    <span>
                                        {el.barHeightMm === undefined
                                            ? "Automatic · derived from frame height"
                                            : "Fixed physical bar height"}
                                    </span>
                                    {el.barHeightMm !== undefined && (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 shrink-0 px-1.5 text-[10px]"
                                            onClick={() => patch({ barHeightMm: undefined } as Partial<LabelElement>)}
                                        >
                                            Use frame
                                        </Button>
                                    )}
                                </div>
                            </div>
                            <div>
                                <Label className="text-xs">Alignment</Label>
                                <Select
                                    value={el.align ?? "center"}
                                    onValueChange={(v) =>
                                        patch({ align: v as BarcodeAlign } as Partial<LabelElement>)
                                    }
                                >
                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="left">Left</SelectItem>
                                        <SelectItem value="center">Center</SelectItem>
                                        <SelectItem value="right">Right</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            {el.humanReadable && (
                                <>
                                    <div>
                                        <Label className="text-xs">Text position</Label>
                                        <Select
                                            value={el.textPosition ?? "below"}
                                            onValueChange={(v) =>
                                                patch({ textPosition: v as BarcodeTextPosition } as Partial<LabelElement>)
                                            }
                                        >
                                            <SelectTrigger><SelectValue /></SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="below">Below bars</SelectItem>
                                                <SelectItem value="above">Above bars</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </div>
                                    {el.symbology === "CODE128" ? (
                                        <>
                                            <div>
                                                <Label className="text-xs">Text alignment</Label>
                                                <Select
                                                    value={el.textAlign ?? "center"}
                                                    onValueChange={(value) => patch({
                                                        textAlign: value as BarcodeTextAlign,
                                                    } as Partial<LabelElement>)}
                                                >
                                                    <SelectTrigger><SelectValue /></SelectTrigger>
                                                    <SelectContent>
                                                        <SelectItem value="left">Left</SelectItem>
                                                        <SelectItem value="center">Center</SelectItem>
                                                        <SelectItem value="right">Right</SelectItem>
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                            <NumField
                                                label="Text size (mm)"
                                                value={el.textSizeMm ?? 2}
                                                step={0.1}
                                                min={0.5}
                                                max={10}
                                                onChange={(textSizeMm) => patch({ textSizeMm } as Partial<LabelElement>)}
                                            />
                                            <NumField
                                                label="Text padding (mm)"
                                                value={el.textPaddingMm ?? 0.3}
                                                step={0.1}
                                                min={0}
                                                max={5}
                                                onChange={(textPaddingMm) => patch({ textPaddingMm } as Partial<LabelElement>)}
                                            />
                                        </>
                                    ) : (
                                        <p className="self-end text-[10px] leading-snug text-muted-foreground">
                                            EAN-13 uses its standards-compliant digit grouping and fixed text alignment.
                                        </p>
                                    )}
                                </>
                            )}
                            <details className="group/expert col-span-2 rounded-[5px] border border-border">
                                <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2.5 py-2 text-[11px] font-medium text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                                    <ChevronRight className="h-3 w-3 transition-transform group-open/expert:rotate-90" />
                                    Expert settings
                                </summary>
                                <div className="border-t border-border p-2.5">
                                    <NumField
                                        label="Minimum X-dimension (mm)"
                                        value={el.minModuleMm ?? 0.25}
                                        step={0.01}
                                        min={0.1}
                                        max={2}
                                        onChange={(minModuleMm) => patch({ minModuleMm } as Partial<LabelElement>)}
                                    />
                                </div>
                            </details>
                        </div>
                    </details>
                    {barcodeCheck && (
                        <div
                            className={cn(
                                "rounded-[6px] border px-2.5 py-2 text-[11px] leading-relaxed",
                                barcodeCheck.level === "error"
                                    ? "border-red-500/30 bg-red-500/10 text-red-800 dark:text-red-200"
                                    : barcodeCheck.level === "deferred" || barcodeCheck.level === "warning"
                                      ? "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-200"
                                    : "border-emerald-500/25 bg-emerald-500/10 text-emerald-800 dark:text-emerald-200",
                            )}
                        >
                            <div className="flex items-center gap-1.5 font-semibold">
                                {barcodeCheck.level === "error" || barcodeCheck.level === "warning" ? (
                                    <AlertCircle className="h-3.5 w-3.5" />
                                ) : barcodeCheck.level === "deferred" ? (
                                    <RefreshCw className="h-3.5 w-3.5" />
                                ) : (
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                )}
                                {barcodeCheck.summary}
                            </div>
                            {barcodeCheck.details && (
                                <p className="mt-1 pl-5 text-[10px] opacity-80">
                                    {barcodeCheck.details}
                                </p>
                            )}
                            {barcodeCheck.lines.length > 0 && (
                                <div className="mt-1 pl-5">
                                    {barcodeCheck.lines.map((line) => <p key={line}>{line}</p>)}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}

            {el.kind === "rect" && (
                <div className="space-y-3">
                    <NumField
                        label="Thickness (mm)"
                        value={el.thickness}
                        step={0.1}
                        min={0.1}
                        onChange={(thickness) => patch({ thickness } as Partial<LabelElement>)}
                    />
                    <div className="flex items-center justify-between">
                        <Label className="text-xs">Filled</Label>
                        <Switch
                            checked={el.filled}
                            onCheckedChange={(v) => patch({ filled: v } as Partial<LabelElement>)}
                        />
                    </div>
                </div>
            )}

            {el.kind === "line" && (
                <div className="space-y-3">
                    <NumField
                        label="Thickness (mm)"
                        value={el.thickness}
                        step={0.1}
                        min={0.1}
                        onChange={(thickness) => patch({ thickness } as Partial<LabelElement>)}
                    />
                    <div>
                        <Label className="text-xs">Orientation</Label>
                        <Select
                            value={el.orientation}
                            onValueChange={(v) => {
                                const next = v as "h" | "v";
                                if (next === el.orientation) return;
                                // Swap w/h so the visible line keeps its length
                                // when flipping between horizontal and vertical.
                                patch({
                                    orientation: next,
                                    size: { w: el.size.h, h: el.size.w },
                                } as Partial<LabelElement>);
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="h">Horizontal</SelectItem>
                                <SelectItem value="v">Vertical</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                </div>
            )}

            {el.kind === "image" && (
                <div className="space-y-3">
                    <p className="text-[11px] text-muted-foreground italic">
                        Images keep their original proportions inside the W × H frame
                        in the editor, preview, and print. Unused space stays clear.
                    </p>
                    <div className="space-y-1">
                        <Label className="text-xs">File name</Label>
                        <div className="flex gap-2">
                            <Input
                                value={el.fileName ?? ""}
                                disabled
                                readOnly
                                className="flex-1"
                            />
                            <label className="inline-flex items-center justify-center h-10 px-3 rounded-[6px] ring-1 ring-black/[0.08] dark:ring-white/10 bg-black/[0.03] dark:bg-white/[0.06] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-sm font-semibold cursor-pointer transition-colors whitespace-nowrap">
                                Replace…
                                <input
                                    type="file"
                                    accept="image/*"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        e.target.value = "";
                                        if (!file) return;
                                        const reader = new FileReader();
                                        reader.onload = () => {
                                            patch({
                                                src: String(reader.result),
                                                fileName: file.name,
                                                iconId: undefined,
                                                iconWeight: undefined,
                                            } as Partial<LabelElement>);
                                        };
                                        reader.readAsDataURL(file);
                                    }}
                                />
                            </label>
                        </div>
                        <p className="text-[10px] text-muted-foreground italic">
                            Keeps frame size, position, threshold, and rotation.
                            The replacement image keeps its own original proportions.
                        </p>
                    </div>
                    {(() => {
                        const iconId =
                            el.iconId ??
                            (el.fileName?.endsWith(".svg")
                                ? el.fileName.replace(/\.svg$/, "")
                                : undefined);
                        const icon = iconId ? findIconById(iconId) : undefined;
                        if (!icon) return null;
                        const weight = el.iconWeight ?? DEFAULT_ICON_WEIGHT;
                        const setWeight = (w: number) => {
                            const next = Math.max(0.5, Math.min(4, w));
                            patch({
                                iconId: icon.id,
                                iconWeight: next,
                                src: svgToDataUrl(renderIconSvg(icon.svg, next)),
                            } as Partial<LabelElement>);
                        };
                        return (
                            <div className="space-y-1.5">
                                <div className="flex items-center justify-between">
                                    <Label className="text-xs">Boldness</Label>
                                    <span className="text-[11px] font-mono text-muted-foreground tabular-nums">
                                        {weight.toFixed(2)}
                                    </span>
                                </div>
                                <input
                                    type="range"
                                    min={0.5}
                                    max={4}
                                    step={0.25}
                                    value={weight}
                                    onChange={(e) =>
                                        setWeight(Number(e.target.value))
                                    }
                                    className="w-full h-1.5 cursor-pointer accent-foreground"
                                />
                                <div className="flex flex-wrap gap-1">
                                    {[1, 1.5, 2, 2.5, 3].map((w) => (
                                        <Button
                                            key={w}
                                            type="button"
                                            size="sm"
                                            variant={
                                                Math.abs(weight - w) < 0.01
                                                    ? "default"
                                                    : "outline"
                                            }
                                            className="h-6 px-2 text-[11px]"
                                            onClick={() => setWeight(w)}
                                        >
                                            {w === 1
                                                ? "Thin"
                                                : w === 1.5
                                                ? "Default"
                                                : w === 2
                                                ? "Medium"
                                                : w === 2.5
                                                ? "Bold"
                                                : "Heavy"}
                                        </Button>
                                    ))}
                                </div>
                            </div>
                        );
                    })()}
                    <NumField
                        label="Threshold"
                        value={el.threshold}
                        step={5}
                        min={-50}
                        max={50}
                        onChange={(threshold) => patch({ threshold } as Partial<LabelElement>)}
                    />
                </div>
            )}

            {el.kind === "table" && (
                <TableEditor el={el} patch={patch} variables={variables} />
            )}
        </div>
    );
}

function TextEditor({
    el,
    settings,
    patch,
    variables,
}: {
    el: TextEl;
    settings: LabelSettings;
    patch: (p: Partial<LabelElement>) => void;
    variables?: VariableSuggestion[];
}) {
    const fontSource: FontSourceKind = el.fontSource ?? "zpl";
    const rfidSource = rfidTextSource(el, settings.rfid);
    const lastChars = normalizeRfidReadLastChars(el.rfidReadLastChars);
    const textDpi = settings.dpi ?? 203;
    const content = textContentFrame(el, textDpi);
    const usable = logicalSize(content, el.rotation);

    // Make sure the chosen Google Font is loaded into the page.
    useEffect(() => {
        if (fontSource === "google" && el.fontFamily) {
            loadGoogleFont(el.fontFamily);
        }
    }, [fontSource, el.fontFamily]);

    const setSource = (next: FontSourceKind) => {
        if (next === fontSource) return;
        const updates: Partial<TextEl> = { fontSource: next };
        if (next === "zpl") {
            // Stay with the existing native font fields.
        } else {
            updates.fontSizeMm = el.fontSizeMm ?? 4;
            updates.fontWeight = el.fontWeight ?? 400;
            if (next === "system") {
                updates.fontFamily = el.fontFamily ?? "System Sans";
            } else if (next === "google") {
                updates.fontFamily = el.fontFamily ?? "Be Vietnam Pro";
                loadGoogleFont(updates.fontFamily!);
            } else if (next === "custom") {
                updates.fontFamily = el.fontFamily ?? "Custom font";
            }
        }
        patch(updates as Partial<LabelElement>);
    };

    const onUploadCustom = async (file: File) => {
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
        const name = file.name.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, "");
        registerCustomFont(name, dataUrl);
        patch({
            fontSource: "custom",
            fontFamily: name,
            customFontDataUrl: dataUrl,
        } as Partial<LabelElement>);
    };

    const align: TextAlign = el.align ?? "left";
    const wrapMode: TextWrapMode = el.wrapMode ?? "none";
    const fitMode: TextFitMode = el.fitMode ?? "clip";
    const modeButtonClass = (active: boolean) =>
        cn(
            "h-8 rounded-[6px] ring-1 text-xs font-semibold flex items-center justify-center transition-colors",
            active
                ? "bg-primary text-primary-foreground ring-primary"
                : "bg-black/[0.03] dark:bg-white/[0.06] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ring-black/[0.08] dark:ring-white/10",
        );

    return (
        <div className="space-y-3">
            <div className="space-y-1">
                <Label className="text-xs">Text</Label>
                <HighlightedField
                    multiline
                    value={el.text}
                    rows={2}
                    onChange={(text) => patch({ text } as Partial<LabelElement>)}
                    placeholder="Use {product_name}, {sku}, {serial}, or {step}"
                    variables={variables}
                />
            </div>

            {rfidSource && (
                <div className="space-y-2 rounded-[6px] border border-border p-2.5" data-testid="rfid-text-format">
                    <Label className="text-xs">RFID text output</Label>
                    <Select
                        value={lastChars ? "last" : "all"}
                        onValueChange={(value) => patch({ rfidReadLastChars: value === "last" ? 6 : undefined })}
                    >
                        <SelectTrigger aria-label="RFID text output"><SelectValue /></SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All characters</SelectItem>
                            <SelectItem value="last">Last N characters</SelectItem>
                        </SelectContent>
                    </Select>
                    {lastChars && (
                        <div className="space-y-1">
                            <Label htmlFor={`rfid-last-${el.id}`} className="text-xs">Number of HEX characters</Label>
                            <Input
                                id={`rfid-last-${el.id}`}
                                aria-label="RFID last characters"
                                type="number"
                                min={1}
                                max={128}
                                step={1}
                                value={lastChars}
                                onChange={(event) => {
                                    const value = event.target.valueAsNumber;
                                    if (Number.isFinite(value)) {
                                        patch({ rfidReadLastChars: Math.max(1, Math.min(128, Math.round(value))) });
                                    }
                                }}
                            />
                            <p className="text-[10px] leading-snug text-muted-foreground">
                                Applies to {`{${rfidSource}}`} in this Text only. Leading zeros are kept.
                                If fewer than N characters are available, all are printed.
                                Preview uses F until RFID data is available.
                            </p>
                            <p className="text-[10px] leading-snug text-muted-foreground">
                                Printer read: Link-OS 6.8 Release 2 or newer. ZD621R: Link-OS 7.0 or newer recommended.
                            </p>
                        </div>
                    )}
                </div>
            )}

            <div className="space-y-1">
                <Label className="text-xs">Align</Label>
                <div className="grid grid-cols-3 gap-1">
                    {(
                        [
                            { v: "left", icon: <AlignLeft className="w-3.5 h-3.5" /> },
                            {
                                v: "center",
                                icon: <AlignCenter className="w-3.5 h-3.5" />,
                            },
                            { v: "right", icon: <AlignRight className="w-3.5 h-3.5" /> },
                        ] as { v: TextAlign; icon: React.ReactNode }[]
                    ).map(({ v, icon }) => (
                        <button
                            key={v}
                            type="button"
                            onClick={() =>
                                patch({ align: v } as Partial<LabelElement>)
                            }
                            className={cn(
                                "h-8 rounded-[6px] ring-1 text-sm flex items-center justify-center transition-colors",
                                align === v
                                    ? "bg-primary text-primary-foreground ring-primary"
                                    : "bg-black/[0.03] dark:bg-white/[0.06] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ring-black/[0.08] dark:ring-white/10",
                            )}
                            title={v}
                        >
                            {icon}
                        </button>
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                    <Label className="text-xs">Flow</Label>
                    <div className="grid grid-cols-3 gap-1">
                        {(
                            [
                                { v: "none", label: "Line", title: "Single line" },
                                { v: "word", label: "Wrap", title: "Word wrap" },
                                { v: "anywhere", label: "Break", title: "Break long text" },
                            ] as { v: TextWrapMode; label: string; title: string }[]
                        ).map(({ v, label, title }) => (
                            <button
                                key={v}
                                type="button"
                                title={title}
                                onClick={() =>
                                    patch({ wrapMode: v } as Partial<LabelElement>)
                                }
                                className={modeButtonClass(wrapMode === v)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
                <div className="space-y-1">
                    <Label className="text-xs">Fit</Label>
                    <div className="grid grid-cols-2 gap-1">
                        {(
                            [
                                { v: "clip", label: "Clip" },
                                { v: "shrink", label: "Shrink" },
                            ] as { v: TextFitMode; label: string }[]
                        ).map(({ v, label }) => (
                            <button
                                key={v}
                                type="button"
                                onClick={() =>
                                    patch({ fitMode: v } as Partial<LabelElement>)
                                }
                                className={modeButtonClass(fitMode === v)}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            <div className="space-y-1">
                <NumField label="Text margin (mm)" value={textMarginMm(el.marginMm)}
                    min={0} max={MAX_TEXT_MARGIN_MM} step={0.05}
                    onChange={value => patch({ marginMm: textMarginMm(value) } as Partial<TextEl>)} />
                <p className="text-[10px] text-muted-foreground">
                    {content.inset} dots per side · Text area {dotsToMm(usable.w, textDpi).toFixed(2)} × {dotsToMm(usable.h, textDpi).toFixed(2)} mm
                </p>
            </div>
            <div className="space-y-1">
                <Label className="text-xs">Font source</Label>
                <Select
                    value={fontSource}
                    onValueChange={(v) => setSource(v as FontSourceKind)}
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="zpl">ZPL native (bitmap)</SelectItem>
                        <SelectItem value="system">System font</SelectItem>
                        <SelectItem value="google">Google Font</SelectItem>
                        <SelectItem value="custom">Custom upload</SelectItem>
                    </SelectContent>
                </Select>
            </div>

            {fontSource === "zpl" && (
                <>
                    <div className="grid grid-cols-2 gap-2">
                        <div>
                            <Label className="text-xs">Font</Label>
                            <Select
                                value={el.font}
                                onValueChange={(v) =>
                                    patch({ font: v as ZplFont } as Partial<LabelElement>)
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="A">A · 4x6 dots</SelectItem>
                                    <SelectItem value="B">B · 5x9 dots</SelectItem>
                                    <SelectItem value="D">D · 9x17 dots</SelectItem>
                                    <SelectItem value="E">E · 12x24 dots</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <Label className="text-xs">Rotation</Label>
                            <Select
                                value={String(el.rotation)}
                                onValueChange={(v) =>
                                    patch({
                                        rotation: Number(v) as Rotation,
                                    } as Partial<LabelElement>)
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="0">0°</SelectItem>
                                    <SelectItem value="90">90°</SelectItem>
                                    <SelectItem value="180">180°</SelectItem>
                                    <SelectItem value="270">270°</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        <ScaleChips
                            label="Scale X"
                            value={el.scaleX}
                            onChange={(scaleX) =>
                                patch({ scaleX } as Partial<LabelElement>)
                            }
                        />
                        <ScaleChips
                            label="Scale Y"
                            value={el.scaleY}
                            onChange={(scaleY) =>
                                patch({ scaleY } as Partial<LabelElement>)
                            }
                        />
                    </div>
                    <div className="flex gap-2 pt-1">
                        <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            onClick={() =>
                                patch({
                                    scaleX: Math.min(3, el.scaleX + 1) as Scale,
                                    scaleY: Math.min(3, el.scaleY + 1) as Scale,
                                } as Partial<LabelElement>)
                            }
                        >
                            <Type className="w-3.5 h-3.5" /> A+ Bigger
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className="flex-1"
                            onClick={() =>
                                patch({
                                    scaleX: Math.max(1, el.scaleX - 1) as Scale,
                                    scaleY: Math.max(1, el.scaleY - 1) as Scale,
                                } as Partial<LabelElement>)
                            }
                        >
                            <Type className="w-3 h-3" /> A− Smaller
                        </Button>
                    </div>
                    <p className="text-[10px] text-muted-foreground italic">
                        Native bitmap fonts. ASCII / Latin-1 only - no Vietnamese
                        diacritics.
                    </p>
                </>
            )}

            {fontSource === "system" && (
                <>
                    <div>
                        <Label className="text-xs">System font</Label>
                        <Select
                            value={el.fontFamily ?? SYSTEM_FONTS[0].name}
                            onValueChange={(v) =>
                                patch({ fontFamily: v } as Partial<LabelElement>)
                            }
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SYSTEM_FONTS.map((f) => (
                                    <SelectItem key={f.name} value={f.name}>
                                        {f.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <FontMetricsRow el={el} patch={patch} />
                    <FontWebPrintNote />
                </>
            )}

            {fontSource === "google" && (
                <>
                    <div>
                        <Label className="text-xs">Google Font</Label>
                        <Select
                            value={el.fontFamily ?? "Be Vietnam Pro"}
                            onValueChange={(v) => {
                                loadGoogleFont(v);
                                patch({ fontFamily: v } as Partial<LabelElement>);
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-72">
                                {GOOGLE_FONTS.map((f) => (
                                    <SelectItem key={f.name} value={f.name}>
                                        <span style={{ fontFamily: `"${f.name}", sans-serif` }}>
                                            {f.name}
                                        </span>
                                        {f.description && (
                                            <span className="text-[10px] text-muted-foreground ml-2">
                                                {f.description}
                                            </span>
                                        )}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <FontMetricsRow el={el} patch={patch} />
                    <FontWebPrintNote />
                </>
            )}

            {fontSource === "custom" && (
                <>
                    <div className="space-y-1">
                        <Label className="text-xs">Custom font file</Label>
                        <div className="flex gap-2">
                            <Input
                                value={el.fontFamily ?? ""}
                                onChange={(e) =>
                                    patch({
                                        fontFamily: e.target.value,
                                    } as Partial<LabelElement>)
                                }
                                placeholder="Font name"
                            />
                            <label className="inline-flex items-center justify-center h-10 px-3 rounded-[6px] ring-1 ring-black/[0.08] dark:ring-white/10 bg-black/[0.03] dark:bg-white/[0.06] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-sm font-semibold cursor-pointer transition-colors">
                                Upload
                                <input
                                    type="file"
                                    accept=".ttf,.otf,.woff,.woff2"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        e.target.value = "";
                                        if (file) onUploadCustom(file);
                                    }}
                                />
                            </label>
                        </div>
                        <p className="text-[10px] text-muted-foreground italic">
                            TTF / OTF / WOFF / WOFF2. Stored locally in the browser.
                        </p>
                    </div>
                    <FontMetricsRow el={el} patch={patch} />
                    <FontWebPrintNote />
                </>
            )}
        </div>
    );
}

function TableEditor({
    el,
    patch,
    variables,
}: {
    el: TableEl;
    patch: (p: Partial<LabelElement>) => void;
    variables?: VariableSuggestion[];
}) {
    void variables;
    const align: TextAlign = el.align ?? "left";
    const fontSource: FontSourceKind = el.fontSource ?? "zpl";

    // Make sure the chosen Google Font is loaded into the page so the
    // canvas renders cells with it.
    useEffect(() => {
        if (fontSource === "google" && el.fontFamily) {
            loadGoogleFont(el.fontFamily);
        }
    }, [fontSource, el.fontFamily]);

    const setRows = (n: number) => {
        const rows = Math.max(1, Math.min(20, Math.floor(n)));
        patch({ rows } as Partial<LabelElement>);
    };
    const setCols = (n: number) => {
        const cols = Math.max(1, Math.min(20, Math.floor(n)));
        patch({ cols } as Partial<LabelElement>);
    };
    const setFontSource = (next: FontSourceKind) => {
        if (next === fontSource) return;
        const updates: Partial<TableEl> = { fontSource: next };
        if (next === "system") {
            updates.fontFamily = el.fontFamily ?? "System Sans";
        } else if (next === "google") {
            updates.fontFamily = el.fontFamily ?? "Be Vietnam Pro";
            loadGoogleFont(updates.fontFamily!);
        } else if (next === "custom") {
            updates.fontFamily = el.fontFamily ?? "Custom font";
        }
        patch(updates as Partial<LabelElement>);
    };
    const onUploadCustom = async (file: File) => {
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((resolve, reject) => {
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
        });
        const name = file.name.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/, "");
        registerCustomFont(name, dataUrl);
        patch({
            fontSource: "custom",
            fontFamily: name,
        } as Partial<LabelElement>);
    };


    return (
        <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
                <NumField
                    label="Rows"
                    value={el.rows}
                    step={1}
                    min={1}
                    max={20}
                    onChange={setRows}
                />
                <NumField
                    label="Columns"
                    value={el.cols}
                    step={1}
                    min={1}
                    max={20}
                    onChange={setCols}
                />
            </div>

            <div className="space-y-1">
                <Label className="text-xs">Scale mode</Label>
                <Select
                    value={el.scaleMode}
                    onValueChange={(v) =>
                        patch({ scaleMode: v as TableScaleMode } as Partial<LabelElement>)
                    }
                >
                    <SelectTrigger>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="all">
                            Scale all (rows + columns)
                        </SelectItem>
                        <SelectItem value="rows">
                            Scale rows only (height)
                        </SelectItem>
                        <SelectItem value="cols">
                            Scale columns only (width)
                        </SelectItem>
                        <SelectItem value="fixed">
                            Fixed outer · redistribute
                        </SelectItem>
                        <SelectItem value="auto">
                            Auto-fit to content
                        </SelectItem>
                    </SelectContent>
                </Select>
                <p className="text-[10px] text-muted-foreground italic leading-snug">
                    {scaleModeHint(el.scaleMode)}
                </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
                <NumField
                    label="Font size mm"
                    value={el.fontSizeMm}
                    step={0.5}
                    min={1}
                    max={20}
                    onChange={(fontSizeMm) =>
                        patch({ fontSizeMm } as Partial<LabelElement>)
                    }
                />
                <NumField
                    label="Border mm"
                    value={el.borderThickness}
                    step={0.1}
                    min={0}
                    max={5}
                    onChange={(borderThickness) =>
                        patch({ borderThickness } as Partial<LabelElement>)
                    }
                />
                <NumField
                    label="Padding mm"
                    value={el.padding}
                    step={0.1}
                    min={0}
                    max={10}
                    onChange={(padding) =>
                        patch({ padding } as Partial<LabelElement>)
                    }
                />
                <div className="flex items-center justify-between pt-5">
                    <Label className="text-xs">Header row</Label>
                    <Switch
                        checked={!!el.headerRow}
                        onCheckedChange={(v) =>
                            patch({ headerRow: v } as Partial<LabelElement>)
                        }
                    />
                </div>
            </div>

            <div className="space-y-1">
                <Label className="text-xs">Cell align</Label>
                <div className="grid grid-cols-3 gap-1">
                    {(
                        [
                            { v: "left", icon: <AlignLeft className="w-3.5 h-3.5" /> },
                            {
                                v: "center",
                                icon: <AlignCenter className="w-3.5 h-3.5" />,
                            },
                            { v: "right", icon: <AlignRight className="w-3.5 h-3.5" /> },
                        ] as { v: TextAlign; icon: React.ReactNode }[]
                    ).map(({ v, icon }) => (
                        <button
                            key={v}
                            type="button"
                            onClick={() =>
                                patch({ align: v } as Partial<LabelElement>)
                            }
                            className={cn(
                                "h-8 rounded-[6px] ring-1 text-sm flex items-center justify-center transition-colors",
                                align === v
                                    ? "bg-primary text-primary-foreground ring-primary"
                                    : "bg-black/[0.03] dark:bg-white/[0.06] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ring-black/[0.08] dark:ring-white/10",
                            )}
                            title={v}
                        >
                            {icon}
                        </button>
                    ))}
                </div>
            </div>

            <Separator />

            <div className="space-y-2">
                <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Font (table default)
                </Label>
                <div className="space-y-1">
                    <Label className="text-xs">Font source</Label>
                    <Select
                        value={fontSource}
                        onValueChange={(v) => setFontSource(v as FontSourceKind)}
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="zpl">ZPL native (bitmap)</SelectItem>
                            <SelectItem value="system">System font</SelectItem>
                            <SelectItem value="google">Google Font</SelectItem>
                            <SelectItem value="custom">Custom upload</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {fontSource === "system" && (
                    <div>
                        <Label className="text-xs">System font</Label>
                        <Select
                            value={el.fontFamily ?? SYSTEM_FONTS[0].name}
                            onValueChange={(v) =>
                                patch({ fontFamily: v } as Partial<LabelElement>)
                            }
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SYSTEM_FONTS.map((f) => (
                                    <SelectItem key={f.name} value={f.name}>
                                        {f.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                {fontSource === "google" && (
                    <div>
                        <Label className="text-xs">Google Font</Label>
                        <Select
                            value={el.fontFamily ?? "Be Vietnam Pro"}
                            onValueChange={(v) => {
                                loadGoogleFont(v);
                                patch({ fontFamily: v } as Partial<LabelElement>);
                            }}
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent className="max-h-72">
                                {GOOGLE_FONTS.map((f) => (
                                    <SelectItem key={f.name} value={f.name}>
                                        <span style={{ fontFamily: `"${f.name}", sans-serif` }}>
                                            {f.name}
                                        </span>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}

                {fontSource === "custom" && (
                    <div className="space-y-1">
                        <Label className="text-xs">Custom font file</Label>
                        <div className="flex gap-2">
                            <Input
                                value={el.fontFamily ?? ""}
                                onChange={(e) =>
                                    patch({
                                        fontFamily: e.target.value,
                                    } as Partial<LabelElement>)
                                }
                                placeholder="Font name"
                            />
                            <label className="inline-flex items-center justify-center h-10 px-3 rounded-[6px] ring-1 ring-black/[0.08] dark:ring-white/10 bg-black/[0.03] dark:bg-white/[0.06] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-sm font-semibold cursor-pointer transition-colors">
                                Upload
                                <input
                                    type="file"
                                    accept=".ttf,.otf,.woff,.woff2"
                                    className="hidden"
                                    onChange={(e) => {
                                        const file = e.target.files?.[0];
                                        e.target.value = "";
                                        if (file) onUploadCustom(file);
                                    }}
                                />
                            </label>
                        </div>
                    </div>
                )}

                {fontSource !== "zpl" && (
                    <div>
                        <Label className="text-xs">Weight</Label>
                        <Select
                            value={String(el.fontWeight ?? 400)}
                            onValueChange={(v) =>
                                patch({
                                    fontWeight: Number(v) as FontWeight,
                                } as Partial<LabelElement>)
                            }
                        >
                            <SelectTrigger>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="300">300</SelectItem>
                                <SelectItem value="400">400</SelectItem>
                                <SelectItem value="500">500</SelectItem>
                                <SelectItem value="600">600</SelectItem>
                                <SelectItem value="700">700</SelectItem>
                                <SelectItem value="900">900</SelectItem>
                            </SelectContent>
                        </Select>
                    </div>
                )}

                {fontSource !== "zpl" && (
                    <p className="text-[10px] text-amber-600 dark:text-amber-400 italic leading-snug">
                        Renders with the chosen font in the designer. The
                        selected font is rasterized into the Zebra ZPL job.
                    </p>
                )}
            </div>
        </div>
    );
}

function scaleModeHint(mode: TableScaleMode): string {
    switch (mode) {
        case "all":
            return "Drag any handle to scale rows AND columns proportionally.";
        case "rows":
            return "Only top/bottom handles; row heights scale, column widths stay locked.";
        case "cols":
            return "Only left/right handles; column widths scale, row heights stay locked.";
        case "fixed":
            return "Outer size locked. Adding/removing rows or columns redistributes inside the fixed bounds.";
        case "auto":
            return "Outer size follows the cell text. Edit content and the table grows or shrinks to fit.";
    }
}

function FontMetricsRow({
    el,
    patch,
}: {
    el: TextEl;
    patch: (p: Partial<LabelElement>) => void;
}) {
    const isBold = (el.fontWeight ?? 400) >= 600;
    const isItalic = !!el.fontItalic;
    const isUnderline = !!el.fontUnderline;
    const styleButtonClass = (active: boolean) =>
        cn(
            "h-8 w-8 rounded-[6px] ring-1 flex items-center justify-center transition-colors",
            active
                ? "bg-primary text-primary-foreground ring-primary"
                : "bg-black/[0.03] dark:bg-white/[0.06] hover:bg-black/[0.06] dark:hover:bg-white/[0.08] ring-black/[0.08] dark:ring-white/10",
        );
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-3 gap-2">
                <NumField
                    label="Size mm"
                    value={el.fontSizeMm ?? 4}
                    step={0.5}
                    min={1}
                    max={40}
                    onChange={(fontSizeMm) =>
                        patch({ fontSizeMm } as Partial<LabelElement>)
                    }
                />
                <div>
                    <Label className="text-xs">Weight</Label>
                    <Select
                        value={String(el.fontWeight ?? 400)}
                        onValueChange={(v) =>
                            patch({
                                fontWeight: Number(v) as FontWeight,
                            } as Partial<LabelElement>)
                        }
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="300">300</SelectItem>
                            <SelectItem value="400">400</SelectItem>
                            <SelectItem value="500">500</SelectItem>
                            <SelectItem value="600">600</SelectItem>
                            <SelectItem value="700">700</SelectItem>
                            <SelectItem value="900">900</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
                <div>
                    <Label className="text-xs">Rotation</Label>
                    <Select
                        value={String(el.rotation)}
                        onValueChange={(v) =>
                            patch({
                                rotation: Number(v) as Rotation,
                            } as Partial<LabelElement>)
                        }
                    >
                        <SelectTrigger>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="0">0°</SelectItem>
                            <SelectItem value="90">90°</SelectItem>
                            <SelectItem value="180">180°</SelectItem>
                            <SelectItem value="270">270°</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </div>
            <div className="flex items-center gap-1">
                <button
                    type="button"
                    onClick={() =>
                        patch({
                            fontWeight: (isBold ? 400 : 700) as FontWeight,
                        } as Partial<LabelElement>)
                    }
                    className={styleButtonClass(isBold)}
                    title="Bold (toggles weight 400 ↔ 700)"
                >
                    <Bold className="w-3.5 h-3.5" />
                </button>
                <button
                    type="button"
                    onClick={() =>
                        patch({
                            fontItalic: !isItalic,
                        } as Partial<LabelElement>)
                    }
                    className={styleButtonClass(isItalic)}
                    title="Italic"
                >
                    <Italic className="w-3.5 h-3.5" />
                </button>
                <button
                    type="button"
                    onClick={() =>
                        patch({
                            fontUnderline: !isUnderline,
                        } as Partial<LabelElement>)
                    }
                    className={styleButtonClass(isUnderline)}
                    title="Underline"
                >
                    <Underline className="w-3.5 h-3.5" />
                </button>
            </div>
        </div>
    );
}

function FontWebPrintNote() {
    return (
        <p className="text-[10px] text-amber-600 dark:text-amber-400 italic leading-snug">
            The selected font is rasterized into the Zebra ZPL print job.
        </p>
    );
}

const PAPER_PRESETS: Array<{ w: number; h: number }> = [
    { w: 45, h: 20 },
    { w: 50, h: 20 },
    { w: 50, h: 25 },
    { w: 54, h: 34 },
    { w: 57, h: 38 },
    { w: 60, h: 40 },
    { w: 76, h: 20 },
    { w: 76, h: 22 },
    { w: 87, h: 41 },
    { w: 100, h: 50 },
    { w: 100, h: 100 },
    { w: 125, h: 22 },
];

function windowsPrinterLabel(printer: WindowsPrinterInfo): string {
    const parts = [printer.name];
    if (printer.portName) parts.push(printer.portName);
    if (printer.driverName) parts.push(printer.driverName);
    if (printer.isDefault) parts.push("Default");
    return parts.join(" - ");
}

function PaperSizePresets({
    widthMm,
    heightMm,
    onSelect,
}: {
    widthMm: number;
    heightMm: number;
    onSelect: (w: number, h: number) => void;
}) {
    const [open, setOpen] = useState(false);
    const matched = PAPER_PRESETS.find((p) => p.w === widthMm && p.h === heightMm);
    const triggerLabel = matched
        ? `${matched.w}×${matched.h}mm`
        : `${widthMm}×${heightMm}mm · Custom`;

    return (
        <div className="min-w-0 space-y-1.5">
            <Label className="text-xs">Label size</Label>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger asChild>
                    <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={open}
                        className="w-full min-w-0 justify-between px-3 font-normal"
                    >
                        <span className="min-w-0 truncate">{triggerLabel}</span>
                        <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
                    </Button>
                </PopoverTrigger>
                <PopoverContent className="p-0 w-[--radix-popover-trigger-width]" align="start">
                    <Command>
                        <CommandInput placeholder="Search size…" className="h-9" />
                        <CommandList>
                            <CommandEmpty>No matching size.</CommandEmpty>
                            <CommandGroup>
                                {PAPER_PRESETS.map((p) => {
                                    const value = `${p.w}x${p.h}`;
                                    const active =
                                        p.w === widthMm && p.h === heightMm;
                                    return (
                                        <CommandItem
                                            key={value}
                                            value={`${p.w}×${p.h}mm ${p.w}x${p.h}`}
                                            onSelect={() => {
                                                onSelect(p.w, p.h);
                                                setOpen(false);
                                            }}
                                        >
                                            <Check
                                                className={cn(
                                                    "mr-2 h-4 w-4",
                                                    active ? "opacity-100" : "opacity-0",
                                                )}
                                            />
                                            {p.w}×{p.h}mm
                                        </CommandItem>
                                    );
                                })}
                            </CommandGroup>
                        </CommandList>
                    </Command>
                </PopoverContent>
            </Popover>
        </div>
    );
}

function TargetPrinterCard({
    settings,
    printerSettings,
    preflightIssues,
    onUpdatePrinterSettings,
    onUpdate,
    onUpdateRfid,
}: {
    settings: LabelSettings;
    printerSettings: PrinterSettings;
    preflightIssues: DpiPreflightIssue[];
    onUpdatePrinterSettings: (patch: Partial<PrinterSettings>) => void;
    onUpdate: (patch: Partial<LabelSettings>) => void;
    onUpdateRfid: (patch: Partial<RfidSettings>) => void;
}) {
    const rawModel = settings.targetPrinterModel ?? settings.rfid.zebraModel ?? "auto";
    const model = TARGET_PRINTER_MODELS.some((profile) => profile.id === rawModel)
        ? rawModel
        : "auto";
    const profile = zebraPrinterModelProfile(model);
    const errorCount = preflightIssues.filter((issue) => issue.severity === "error").length;
    const warningCount = preflightIssues.filter((issue) => issue.severity === "warning").length;
    const preflightTitle = preflightIssues.map((issue) => issue.message).join("\n");
    const serialSession = useSerialSession();
    const [comMessage, setComMessage] = useState<string | null>(null);
    const [windowsPrinters, setWindowsPrinters] = useState<WindowsPrinterInfo[]>([]);
    const [printerListLoading, setPrinterListLoading] = useState(false);
    const [connectionMessage, setConnectionMessage] = useState<string | null>(null);
    const windowsPrintersUrlRef = useRef("");
    const transportCapabilities = printerTransportCapabilities(printerSettings.connectionMode);
    const selectedWindowsPrinter = useMemo(
        () => windowsPrinters.find((printer) => printer.name === printerSettings.printerName),
        [printerSettings.printerName, windowsPrinters],
    );
    const selectedPrinterWarning = useMemo(
        () => rawZplPrinterWarning(selectedWindowsPrinter),
        [selectedWindowsPrinter],
    );

    const onSelectComPort = async () => {
        try {
            setComMessage(null);
            await serialSession.selectPort();
        } catch (error) {
            const cancelled = error instanceof DOMException && error.name === "NotFoundError";
            if (!cancelled) {
                setComMessage(error instanceof Error ? error.message : "Could not select a COM port.");
            }
        }
    };

    const onToggleComConnection = async () => {
        try {
            setComMessage(null);
            if (serialSession.connection) {
                await serialSession.disconnect();
            } else {
                await serialSession.connect(
                    printerSettings.baudRate,
                    printerSettings.serialFlowControl,
                );
            }
        } catch (error) {
            setComMessage(error instanceof Error ? error.message : "Could not connect the COM port.");
        }
    };

    const onRefreshWindowsPrinters = useCallback(async (options?: { silent?: boolean }) => {
        try {
            setPrinterListLoading(true);
            setConnectionMessage(null);
            const printers = await listWindowsPrinters(printerSettings.printAgentUrl);
            setWindowsPrinters(printers);
            windowsPrintersUrlRef.current = printerSettings.printAgentUrl.trim();

            const currentName = printerSettings.printerName.trim();
            const currentStillAvailable = printers.some((printer) => printer.name === currentName);
            if (currentName && !currentStillAvailable) {
                setConnectionMessage("The saved printer is unavailable. Reconnect it or select another printer.");
            } else if (!options?.silent) {
                setConnectionMessage(
                    `Found ${printers.length} Windows ${printers.length === 1 ? "printer" : "printers"}.`,
                );
            }
        } catch (error) {
            windowsPrintersUrlRef.current = "";
            setConnectionMessage(
                error instanceof Error
                    ? `Local print agent unavailable - ${error.message}`
                    : "Local print agent unavailable.",
            );
        } finally {
            setPrinterListLoading(false);
        }
    }, [
        printerSettings.printAgentUrl,
        printerSettings.printerName,
        setConnectionMessage,
        setPrinterListLoading,
        setWindowsPrinters,
    ]);

    useEffect(() => {
        if (printerSettings.connectionMode !== "windowsRaw") return;
        const connectorUrl = printerSettings.printAgentUrl.trim();
        if (windowsPrintersUrlRef.current === connectorUrl) return;
        windowsPrintersUrlRef.current = "";
        setWindowsPrinters([]);
        void onRefreshWindowsPrinters({ silent: true });
    }, [
        onRefreshWindowsPrinters,
        printerSettings.connectionMode,
        printerSettings.printAgentUrl,
    ]);

    const selectModel = (value: string) => {
        const nextModel = value as ZebraRfidModel;
        const nextDpi = compatiblePrinterDpi(nextModel, settings.dpi);
        const nextMaxSpeed = maxPrintSpeedIps(nextModel, nextDpi);
        onUpdate({
            targetPrinterModel: nextModel,
            dpi: nextDpi,
            speed: nextMaxSpeed === undefined
                ? settings.speed
                : Math.min(settings.speed, nextMaxSpeed),
        });
        const rfidProfile = zebraRfidModelOption(nextModel);
        onUpdateRfid({
            zebraModel: nextModel,
            zebraAntenna: rfidProfile.multiAntenna
                ? (settings.rfid.zebraAntenna ?? "A4")
                : "A1",
        });
    };

    const selectDpi = (value: string) => {
        const dpi = Number(value) as PrinterDpi;
        const nextMaxSpeed = maxPrintSpeedIps(model, dpi);
        onUpdate({
            dpi,
            speed: nextMaxSpeed === undefined
                ? settings.speed
                : Math.min(settings.speed, nextMaxSpeed),
        });
    };

    return (
        <section
            className="space-y-2.5 rounded-[10px] border border-blue-500/25 bg-blue-500/[0.05] p-3"
            data-testid="target-printer-card"
        >
            <Label className="text-sm font-semibold">Target printer</Label>

            <div className="space-y-1">
                <Label className="text-xs">Model</Label>
                <Select value={model} onValueChange={selectModel}>
                    <SelectTrigger className="h-9">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {TARGET_PRINTER_MODELS.map((option) => (
                            <SelectItem key={option.id} value={option.id}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectContent>
                </Select>
            </div>

            <div className="space-y-1">
                <Label className="text-xs">DPI</Label>
                <div
                    className={cn(
                        "grid gap-1",
                        profile.supportedDpis.length === 1
                            ? "grid-cols-1"
                            : profile.supportedDpis.length === 2
                                ? "grid-cols-2"
                                : "grid-cols-3",
                    )}
                    role="group"
                    aria-label="Printer DPI"
                >
                    {profile.supportedDpis.map((dpi) => (
                        <Button
                            key={dpi}
                            type="button"
                            size="sm"
                            variant={settings.dpi === dpi ? "default" : "outline"}
                            onClick={() => selectDpi(String(dpi))}
                            aria-pressed={settings.dpi === dpi}
                            className="h-8 px-2 font-mono text-xs"
                        >
                            {dpi}
                        </Button>
                    ))}
                </div>
            </div>

            <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                    <Label className="text-xs">Connection</Label>
                </div>
                <div className="grid grid-cols-3 gap-1" role="group" aria-label="Printer protocol">
                    <Button
                        type="button"
                        size="sm"
                        variant={printerSettings.connectionMode === "webserial" ? "default" : "outline"}
                        onClick={() => onUpdatePrinterSettings({ connectionMode: "webserial" })}
                        disabled={serialSession.action !== null}
                        className="h-8 px-1.5 text-[11px]"
                    >
                        <Plug className="h-3.5 w-3.5" />
                        COM
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant={printerSettings.connectionMode === "tcp" ? "default" : "outline"}
                        onClick={() => {
                            if (serialSession.connection) void serialSession.disconnect();
                            onUpdatePrinterSettings({ connectionMode: "tcp" });
                        }}
                        disabled={serialSession.action !== null}
                        className="h-8 px-1.5 text-[11px]"
                    >
                        <Network className="h-3.5 w-3.5" />
                        Direct TCP
                    </Button>
                    <Button
                        type="button"
                        size="sm"
                        variant={printerSettings.connectionMode === "windowsRaw" ? "default" : "outline"}
                        onClick={() => {
                            if (serialSession.connection) void serialSession.disconnect();
                            onUpdatePrinterSettings({ connectionMode: "windowsRaw" });
                            if (
                                windowsPrintersUrlRef.current
                                !== printerSettings.printAgentUrl.trim()
                            ) {
                                void onRefreshWindowsPrinters({ silent: true });
                            }
                        }}
                        disabled={serialSession.action !== null}
                        className="h-8 px-1.5 text-[11px]"
                    >
                        <Server className="h-3.5 w-3.5" />
                        Windows
                    </Button>
                </div>

                {printerSettings.connectionMode === "webserial" && (
                    <div className="space-y-2">
                        <div className="grid grid-cols-2 gap-2">
                            <div className="space-y-1">
                            <Label className="text-xs">Baud rate</Label>
                            <Select
                                value={String(printerSettings.baudRate)}
                                onValueChange={(value) =>
                                    onUpdatePrinterSettings({ baudRate: Number(value) })
                                }
                                disabled={serialSession.connection !== null}
                            >
                                <SelectTrigger className="h-9 font-mono text-xs">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {PRINTER_BAUD_RATES.map((baudRate) => (
                                        <SelectItem
                                            key={baudRate}
                                            value={String(baudRate)}
                                            className="font-mono"
                                        >
                                            {baudRate}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs">Handshake</Label>
                                <Select
                                    value={printerSettings.serialFlowControl}
                                    onValueChange={(value) => onUpdatePrinterSettings({
                                        serialFlowControl: value === "hardware" ? "hardware" : "none",
                                    })}
                                    disabled={serialSession.connection !== null}
                                >
                                    <SelectTrigger className="h-9 text-xs">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="none">None</SelectItem>
                                        <SelectItem value="hardware">RTS/CTS</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        <div
                            className={cn(
                                "flex min-h-12 items-center justify-center rounded-md border px-2 py-2 text-center text-[10px]",
                                serialSession.connection
                                    ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                    : "border-border bg-background/60 text-muted-foreground",
                            )}
                        >
                            {serialSession.connection
                                ? `Connected · ${serialSession.connection.label}`
                                : serialSession.selectedPort
                                  ? `Port selected · ${serialSession.selectedPort.label}`
                                  : "No port selected"}
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-8 text-[11px]"
                                onClick={() => void onSelectComPort()}
                                disabled={
                                    !serialSession.supported
                                    || serialSession.connection !== null
                                    || serialSession.action !== null
                                }
                            >
                                {serialSession.action === "select" ? (
                                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Plug className="h-3.5 w-3.5" />
                                )}
                                Select Port
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                className="h-8 text-[11px]"
                                variant={serialSession.connection ? "outline" : "default"}
                                onClick={() => void onToggleComConnection()}
                                disabled={
                                    !serialSession.supported
                                    || serialSession.action !== null
                                    || (!serialSession.connection && !serialSession.selectedPort)
                                }
                            >
                                {serialSession.action === "connect"
                                || serialSession.action === "disconnect" ? (
                                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                ) : null}
                                {serialSession.connection ? "Disconnect" : "Connect"}
                            </Button>
                        </div>
                        {!serialSession.supported && (
                            <p className="text-[10px] leading-snug text-destructive">
                                Web Serial requires Chrome or Edge over HTTPS / localhost.
                            </p>
                        )}
                        {comMessage && (
                            <p className="text-[10px] leading-snug text-destructive">{comMessage}</p>
                        )}
                    </div>
                )}
                {printerSettings.connectionMode === "tcp" && (
                    <div className="space-y-2">
                        <div className="grid grid-cols-[1fr_72px] gap-2">
                            <div className="space-y-1">
                                <Label className="text-xs">Printer IP / host</Label>
                                <Input
                                    value={printerSettings.tcpHost}
                                    onChange={(event) =>
                                        onUpdatePrinterSettings({ tcpHost: event.target.value })
                                    }
                                    placeholder="192.168.50.50"
                                    className="h-9 font-mono text-xs"
                                />
                            </div>
                            <div className="space-y-1">
                                <Label className="text-xs">Port</Label>
                                <Input
                                    type="number"
                                    min={1}
                                    max={65535}
                                    value={printerSettings.tcpPort}
                                    onChange={(event) =>
                                        onUpdatePrinterSettings({
                                            tcpPort: Math.max(
                                                1,
                                                Math.min(
                                                    65535,
                                                    Math.round(Number(event.target.value) || 9100),
                                                ),
                                            ),
                                        })
                                    }
                                    className="h-9 font-mono text-xs"
                                />
                            </div>
                        </div>
                        <details className="space-y-2 text-xs">
                            <summary className="cursor-pointer text-muted-foreground">Advanced connection settings</summary>
                        <div className="space-y-1">
                            <Label className="text-xs">TCP execution</Label>
                            <Select
                                value={TCP_EXECUTION_POLICY ?? printerSettings.tcpExecutionMode}
                                onValueChange={(value) =>
                                    onUpdatePrinterSettings({
                                        tcpExecutionMode: value as PrinterSettings["tcpExecutionMode"],
                                    })
                                }
                                disabled={TCP_EXECUTION_POLICY !== undefined}
                            >
                                <SelectTrigger className="h-8 text-xs">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="auto">Auto (recommended)</SelectItem>
                                    <SelectItem value="connector">Local connector</SelectItem>
                                    <SelectItem value="server">Local Next.js server</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                        {(TCP_EXECUTION_POLICY ?? printerSettings.tcpExecutionMode) !== "server" && (
                            <Input
                                value={printerSettings.printAgentUrl}
                                onChange={(event) =>
                                    onUpdatePrinterSettings({ printAgentUrl: event.target.value })
                                }
                                placeholder="http://127.0.0.1:17917"
                                className="h-8 font-mono text-xs"
                                aria-label="Local print connector URL"
                            />
                        )}
                        <p className="text-[10px] leading-snug text-muted-foreground">
                            {TCP_EXECUTION_POLICY
                                ? `This deployment enforces ${TCP_EXECUTION_POLICY} execution.`
                                : "Auto uses the local connector on cloud/HTTPS and preserves the direct Next.js TCP socket when the app runs on localhost."}
                            {" "}Use 127.0.0.1 for a connector on this computer, or the
                            Mac&apos;s private LAN IP when it runs in site-gateway mode.
                        </p>
                        </details>
                    </div>
                )}
                {printerSettings.connectionMode === "windowsRaw" && (
                    <div className="space-y-1.5">
                        <div className="grid grid-cols-[1fr_auto] gap-2">
                            <Select
                                value={printerSettings.printerName}
                                onValueChange={(printerName) =>
                                    onUpdatePrinterSettings({ printerName })
                                }
                                disabled={printerListLoading || windowsPrinters.length === 0}
                            >
                                <SelectTrigger className="h-9 min-w-0">
                                    <SelectValue
                                        placeholder={
                                            printerListLoading
                                                ? "Loading printers..."
                                                : "Select a Windows printer"
                                        }
                                    />
                                </SelectTrigger>
                                <SelectContent>
                                    {windowsPrinters.map((printer) => (
                                        <SelectItem key={printer.name} value={printer.name}>
                                            {windowsPrinterLabel(printer)}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                            <Button
                                type="button"
                                variant="outline"
                                size="icon"
                                className="h-9 w-9"
                                onClick={() => onRefreshWindowsPrinters()}
                                disabled={printerListLoading}
                                title="Reload Windows printer queues"
                            >
                                <RefreshCw
                                    className={cn(
                                        "h-3.5 w-3.5",
                                        printerListLoading && "animate-spin",
                                    )}
                                />
                            </Button>
                        </div>
                        <p className="text-xs leading-snug text-muted-foreground">Recommended for USB or Ethernet. Select a Zebra ZPL printer installed in Windows; Windows manages the print queue.</p>
                        <details className="space-y-2 text-xs">
                            <summary className="cursor-pointer text-muted-foreground">Advanced connection settings</summary>
                            <Input value={printerSettings.printAgentUrl}
                                onChange={(event) => {
                                    windowsPrintersUrlRef.current = "";
                                    setWindowsPrinters([]);
                                    onUpdatePrinterSettings({ printAgentUrl: event.target.value });
                                }} placeholder="http://127.0.0.1:17917"
                                className="h-8 font-mono text-xs" aria-label="Local print agent URL" />
                            <p className="text-[10px] leading-snug text-muted-foreground">{transportCapabilities.reason}</p>
                        </details>
                        {selectedPrinterWarning && (
                            <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[10px] leading-snug text-amber-700 dark:text-amber-300">
                                {selectedPrinterWarning}
                            </p>
                        )}
                        {connectionMessage && (
                            <p className="text-[10px] leading-snug text-muted-foreground">
                                {connectionMessage}
                            </p>
                        )}
                    </div>
                )}
            </div>

            {(errorCount > 0 || warningCount > 0) && (
                <div
                    className={cn(
                        "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px]",
                        errorCount > 0
                            ? "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-300"
                            : "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300",
                    )}
                    title={preflightTitle}
                    data-testid="dpi-preflight-summary"
                    role="status"
                >
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                        {errorCount > 0
                            ? `${errorCount} error${errorCount === 1 ? "" : "s"}`
                            : `${warningCount} warning${warningCount === 1 ? "" : "s"}`}
                    </span>
                </div>
            )}
        </section>
    );
}

function LabelProperties({
    settings,
    printerSettings,
    preflightIssues,
    onUpdatePrinterSettings,
    onUpdate,
    onUpdateSerial,
    onUpdateRfid,
}: {
    settings: LabelSettings;
    printerSettings: PrinterSettings;
    preflightIssues: DpiPreflightIssue[];
    onUpdatePrinterSettings: (patch: Partial<PrinterSettings>) => void;
    onUpdate: (patch: Partial<LabelSettings>) => void;
    onUpdateSerial: (patch: Partial<SerialSettings>) => void;
    onUpdateRfid: (patch: Partial<RfidSettings>) => void;
}) {
    const serialSession = useSerialSession();
    const [calibrating, setCalibrating] = useState(false);
    const [labelSettingBusy, setLabelSettingBusy] = useState<"set" | "reset" | null>(null);
    const [calibStatus, setCalibStatus] = useState<{
        text: string;
        kind: "ok" | "error" | "info";
    } | null>(null);
    const selectedTargetModel = settings.targetPrinterModel ?? settings.rfid.zebraModel ?? "auto";
    const selectedTargetProfile = zebraPrinterModelProfile(selectedTargetModel);
    const selectedTargetMaxWidth = maxPrintWidthMm(selectedTargetModel, settings.dpi);
    const targetWidthExceeded =
        selectedTargetMaxWidth !== undefined && settings.widthMm > selectedTargetMaxWidth;
    const currentAlignment = useMemo(
        () => normalizeZebraPrinterAlignment({
            labelTopDots: printerSettings.labelTopDots,
            leftPositionDots: printerSettings.leftPositionDots,
        }),
        [printerSettings.labelTopDots, printerSettings.leftPositionDots],
    );
    useEffect(() => {
        const hasLegacyAlignment =
            printerSettings.legacyPaperMarginXMm !== undefined ||
            printerSettings.legacyPaperMarginYMm !== undefined ||
            printerSettings.legacyLabelStartOffsetDots !== undefined;
        if (!hasLegacyAlignment) return;

        const migrated = normalizeZebraPrinterAlignment({
            labelTopDots:
                mmToDots(printerSettings.legacyPaperMarginYMm ?? 0, settings.dpi) +
                Math.round(printerSettings.legacyLabelStartOffsetDots ?? 0),
            leftPositionDots: mmToDots(
                printerSettings.legacyPaperMarginXMm ?? 0,
                settings.dpi,
            ),
        });
        onUpdatePrinterSettings({
            ...migrated,
            legacyPaperMarginXMm: undefined,
            legacyPaperMarginYMm: undefined,
            legacyLabelStartOffsetDots: undefined,
        });
    }, [
        onUpdatePrinterSettings,
        printerSettings.legacyLabelStartOffsetDots,
        printerSettings.legacyPaperMarginXMm,
        printerSettings.legacyPaperMarginYMm,
        settings.dpi,
    ]);
    const paperActionDisabled =
        calibrating ||
        labelSettingBusy !== null ||
        (printerSettings.connectionMode === "windowsRaw" &&
            !printerSettings.printerName.trim()) ||
        (printerSettings.connectionMode === "tcp" && !printerSettings.tcpHost.trim());
    const sendZplToPrinter = async (
        code: string,
        documentName: string,
    ): Promise<PrinterWriteResult> => {
        return writePrinterBytes({
            settings: printerSettings,
            payload: encodeZpl(code),
            documentName,
            language: "zpl",
            connection:
                printerSettings.connectionMode === "webserial"
                    ? serialSession.connection ?? undefined
                    : undefined,
        });
    };
    const onSetAllLabel = async () => {
        setLabelSettingBusy("set");
        setCalibStatus({ text: "Applying Zebra alignment...", kind: "info" });
        try {
            const sent = await sendZplToPrinter(
                buildZebraAlignmentSetCommand(currentAlignment),
                "ZbrePrinter Zebra alignment",
            );
            setCalibStatus({
                text:
                    sent.delivery === "queued"
                        ? `Alignment queued - ${sent.bytesWritten} bytes (write is unverified)`
                        : `Alignment written - ${sent.bytesWritten} bytes`,
                kind: "ok",
            });
        } catch (err) {
            setCalibStatus({
                text: err instanceof Error ? err.message : "Set label settings failed",
                kind: "error",
            });
        } finally {
            setLabelSettingBusy(null);
        }
    };
    const onResetAllLabel = async () => {
        setLabelSettingBusy("reset");
        setCalibStatus({ text: "Resetting Zebra alignment...", kind: "info" });
        try {
            const resetAlignment = normalizeZebraPrinterAlignment({});
            const sent = await sendZplToPrinter(
                buildZebraAlignmentSetCommand(resetAlignment),
                "ZbrePrinter reset Zebra alignment",
            );
            onUpdatePrinterSettings(resetAlignment);
            setCalibStatus({
                text:
                    sent.delivery === "queued"
                        ? `Reset queued - ${sent.bytesWritten} bytes (application is unverified)`
                        : `Label settings reset - ${sent.bytesWritten} bytes`,
                kind: "ok",
            });
        } catch (err) {
            setCalibStatus({
                text: err instanceof Error ? err.message : "Reset label settings failed",
                kind: "error",
            });
        } finally {
            setLabelSettingBusy(null);
        }
    };
    const onPrintCalibration = async () => {
        setCalibrating(true);
        setCalibStatus({ text: "Connecting to printer…", kind: "info" });
        try {
            const code = buildCalibrationZpl(settings, currentAlignment);
            const sent = await sendZplToPrinter(code, "ZbrePrinter calibration ruler");

            setCalibStatus({
                text:
                    sent.delivery === "queued"
                        ? `Calibration job queued - ${sent.bytesWritten} bytes`
                        : `Calibration ruler written - ${sent.bytesWritten} bytes`,
                kind: "ok",
            });
        } catch (err) {
            setCalibStatus({
                text:
                    err instanceof Error
                        ? err.message
                        : "Calibration print failed",
                kind: "error",
            });
        } finally {
            setCalibrating(false);
        }
    };
    return (
        <>
            <TargetPrinterCard
                settings={settings}
                printerSettings={printerSettings}
                preflightIssues={preflightIssues}
                onUpdatePrinterSettings={onUpdatePrinterSettings}
                onUpdate={onUpdate}
                onUpdateRfid={onUpdateRfid}
            />

            <PaperSizePresets
                widthMm={settings.widthMm}
                heightMm={settings.heightMm}
                onSelect={(widthMm, heightMm) => onUpdate({ widthMm, heightMm })}
            />
            <div className="space-y-1.5">
                <Label className="text-xs">Template rotation</Label>
                <div className="grid grid-cols-4 gap-1" role="group" aria-label="Template rotation">
                    {([0, 90, 180, 270] as const).map(angle => (
                        <Button
                            key={angle}
                            type="button"
                            size="sm"
                            variant={(settings.contentRotation ?? 0) === angle ? "default" : "outline"}
                            aria-pressed={(settings.contentRotation ?? 0) === angle}
                            onClick={() => onUpdate({ contentRotation: angle })}
                        >
                            {angle}°
                        </Button>
                    ))}
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground">
                    Rotates all content together. At 90° / 270°, label width and height swap.
                </p>
            </div>
            <div className="grid grid-cols-3 gap-2">
                <NumField
                    label="Width (mm)"
                    value={settings.widthMm}
                    min={10}
                    onChange={(widthMm) => onUpdate({ widthMm })}
                />
                <NumField
                    label="Height (mm)"
                    value={settings.heightMm}
                    min={10}
                    onChange={(heightMm) => onUpdate({ heightMm })}
                />
                <NumField
                    label="Gap (mm)"
                    value={settings.gapMm}
                    min={0}
                    onChange={(gapMm) => onUpdate({ gapMm })}
                />
            </div>
            {targetWidthExceeded && (
                <p
                    className="flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2 py-1.5 text-[11px] text-red-700 dark:text-red-300"
                    role="alert"
                >
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    Width exceeds {selectedTargetProfile.label} limit: {selectedTargetMaxWidth} mm.
                </p>
            )}
            <Separator />

            <div className="space-y-3">
                <Label className="text-sm font-semibold">Printer alignment</Label>
                <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 p-2.5">
                    <div>
                        <p className="text-xs font-medium">Override alignment in every print job</p>
                        <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                            Off preserves the printer&apos;s Horizontal/Vertical Label Offset by omitting ^LS/^LT.
                        </p>
                    </div>
                    <Switch
                        checked={printerSettings.embedAlignmentInJobs}
                        onCheckedChange={(embedAlignmentInJobs) =>
                            onUpdatePrinterSettings({ embedAlignmentInJobs })
                        }
                    />
                </div>
                <div className="grid grid-cols-2 gap-2">
                    <AlignmentField
                        label="Vertical offset / Label Top"
                        command="^LT"
                        valueDots={currentAlignment.labelTopDots}
                        dpi={settings.dpi}
                        min={ZEBRA_LABEL_TOP_MIN}
                        max={ZEBRA_LABEL_TOP_MAX}
                        direction="− up / + down"
                        onChangeDots={(labelTopDots) =>
                            onUpdatePrinterSettings({ labelTopDots })
                        }
                    />
                    <AlignmentField
                        label="Horizontal offset / Left Position"
                        command="^LS"
                        valueDots={currentAlignment.leftPositionDots}
                        dpi={settings.dpi}
                        min={ZEBRA_LEFT_POSITION_MIN}
                        max={ZEBRA_LEFT_POSITION_MAX}
                        direction="− left / + right"
                        onChangeDots={(leftPositionDots) =>
                            onUpdatePrinterSettings({ leftPositionDots })
                        }
                    />
                </div>
                <div className="rounded-md border bg-background p-2">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
                        Calibration label preview
                    </div>
                    <div
                        dangerouslySetInnerHTML={{
                            __html: buildCalibrationSvg(settings),
                        }}
                    />
                </div>
                <div className="grid grid-cols-3 gap-2">
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={paperActionDisabled}
                        onClick={onSetAllLabel}
                    >
                        <Settings2 className="h-3.5 w-3.5" />
                        {labelSettingBusy === "set" ? "Applying..." : "Apply"}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={paperActionDisabled}
                        onClick={onPrintCalibration}
                    >
                        <Printer className="h-3.5 w-3.5" />
                        {calibrating ? "Printing…" : "Print ruler"}
                    </Button>
                    <Button
                        size="sm"
                        variant="outline"
                        disabled={paperActionDisabled}
                        onClick={onResetAllLabel}
                    >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {labelSettingBusy === "reset" ? "Resetting..." : "Reset"}
                    </Button>
                </div>
                {calibStatus && (
                    <p
                        className={cn(
                            "text-[11px]",
                            calibStatus.kind === "error" && "text-destructive",
                            calibStatus.kind === "ok" && "text-emerald-700 dark:text-emerald-400",
                            calibStatus.kind === "info" && "text-muted-foreground",
                        )}
                    >
                        {calibStatus.text}
                    </p>
                )}
            </div>

            <Separator />

            <div className="space-y-3">
                <div className="flex items-center justify-between">
                    <Label className="text-sm font-semibold">Serial counter</Label>
                    <Switch
                        checked={settings.serial.enabled}
                        onCheckedChange={(v) => onUpdateSerial({ enabled: v })}
                    />
                </div>
                {settings.serial.enabled && (
                    <div className="grid grid-cols-2 gap-2">
                        <NumField
                            label="Start"
                            value={settings.serial.start}
                            onChange={(start) => onUpdateSerial({ start })}
                        />
                        <NumField
                            label="Step"
                            value={settings.serial.step}
                            min={1}
                            onChange={(step) => onUpdateSerial({ step })}
                        />
                        <NumField
                            label="Pad"
                            value={settings.serial.pad}
                            min={1}
                            max={12}
                            onChange={(pad) => onUpdateSerial({ pad })}
                        />
                        <div className="space-y-1">
                            <Label className="text-xs">Prefix</Label>
                            <Input
                                value={settings.serial.prefix}
                                onChange={(e) => onUpdateSerial({ prefix: e.target.value })}
                            />
                        </div>
                        <p className="col-span-2 text-[11px] text-muted-foreground italic">
                            Use{" "}
                            <code className="bg-muted px-1 py-0.5 rounded">{"{serial}"}</code>
                            ,{" "}
                            <code className="bg-muted px-1 py-0.5 rounded">{"{step}"}</code>{" "}
                            or{" "}
                            <code className="bg-muted px-1 py-0.5 rounded">{"{n}"}</code>{" "}
                            in any text/QR/barcode/Data Matrix/RFID field - the counter will be substituted
                            per copy.
                        </p>
                    </div>
                )}
            </div>
        </>
    );
}

function RfidProperties({
    rfid,
    labelLengthMm,
    dataColumns,
    onUpdate,
}: {
    rfid: RfidSettings;
    labelLengthMm: number;
    dataColumns: DataColumn[];
    onUpdate: (patch: Partial<RfidSettings>) => void;
}) {
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const autoEpcBits = rfid.autoEpcBitsFromData === true;
    const fixedEpcBits = rfid.epcBits ?? 96;
    const zebraPositionMode = rfid.zebraPositionMode ?? "calibrated";
    const programPositionMax = zebraPositionMode === "backward"
        ? 30
        : Math.min(999, Math.max(0, Math.floor(labelLengthMm)));
    const programPositionMm = Math.round(
        Math.max(0, Math.min(programPositionMax, rfid.writePositionMm ?? 0)),
    );
    const programPositionOptions = Array.from(
        { length: programPositionMax + 1 },
        (_, distance) => distance,
    );
    const onChipChange = (chip: RfidChipType) => {
        const bits = epcBitsForChip(chip);
        onUpdate({
            chip,
            epcBits: bits,
            words: Math.max(1, Math.floor(bits / 16)),
            autoEpcBitsFromData: false,
        });
    };

    const onEpcBitsChange = (bits: number) => {
        const clamped = Math.max(16, Math.min(496, Math.round(bits / 16) * 16));
        onUpdate({
            epcBits: clamped,
            words: Math.max(1, Math.floor(clamped / 16)),
            autoEpcBitsFromData: false,
        });
    };
    const sourceName = rfidSourceName(rfid.data) ?? rfid.fieldName ?? "";
    const selectableColumns = dataColumns.filter((col) => !col.system);
    const sourceColumn = selectableColumns.find(
        (col) => col.name.toLowerCase() === sourceName.toLowerCase(),
    );
    const sourceIsBuiltIn = sourceName ? isBuiltInVar(sourceName) : false;
    const manualSourceValue = "__manual__";
    const sourceSelectValue = sourceColumn?.name ?? manualSourceValue;
    const literalHexValidation =
        rfid.enabled && rfid.format === "H" && !rfidSourceName(rfid.data)
            ? validateRfidHexValue(rfid.data, autoEpcBits ? undefined : fixedEpcBits)
            : null;
    const literalAutoBits =
        autoEpcBits && literalHexValidation?.valid
            ? inferEpcBitsFromData(rfid.data, "H")
            : null;
    const selectSourceField = (name: string) => {
        if (name === manualSourceValue) {
            onUpdate({ fieldName: undefined, data: "" });
            return;
        }
        onUpdate({ fieldName: name, data: `{${name}}` });
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <Label className="text-sm font-semibold">RFID write</Label>
                <Switch
                    checked={rfid.enabled}
                    onCheckedChange={(v) => onUpdate({ enabled: v })}
                />
            </div>

            {rfid.enabled && (
                <>
                    <div className="space-y-1">
                        <Label className="text-xs">Chip</Label>
                        <Select
                            value={rfid.chip ?? "epc_96"}
                            onValueChange={(v) => onChipChange(v as RfidChipType)}
                        >
                            <SelectTrigger>
                                <SelectValue>
                                    {
                                        RFID_CHIPS.find((c) => c.value === (rfid.chip ?? "epc_96"))
                                            ?.label
                                    }
                                </SelectValue>
                            </SelectTrigger>
                            <SelectContent>
                                {RFID_CHIPS.map((c) => (
                                    <SelectItem key={c.value} value={c.value}>
                                        <div className="flex flex-col">
                                            <span className="font-medium">{c.label}</span>
                                            <span className="text-muted-foreground text-[10px]">
                                                {c.epcBits} bits ·{" "}
                                                {c.epcBits / 4} hex chars
                                                {c.description ? ` · ${c.description}` : ""}
                                            </span>
                                        </div>
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                            <Label className="text-xs">EPC length (bits)</Label>
                            <Input
                                type="number"
                                step={16}
                                min={16}
                                max={496}
                                value={fixedEpcBits}
                                onChange={(e) =>
                                    onEpcBitsChange(Number(e.target.value))
                                }
                                disabled={(rfid.chip ?? "epc_96") !== "manual" || autoEpcBits}
                                className="font-mono"
                            />
                            <p className="text-[10px] text-muted-foreground">
                                {autoEpcBits
                                    ? "Auto from each row"
                                    : `${fixedEpcBits / 4} hex chars`}
                            </p>
                        </div>
                        <div className="space-y-1">
                            <Label className="text-xs">Format</Label>
                            <Select
                                value={rfid.format}
                                onValueChange={(v) =>
                                    onUpdate({ format: v as "A" | "H" })
                                }
                            >
                                <SelectTrigger>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="H">Hex</SelectItem>
                                    <SelectItem value="A">ASCII</SelectItem>
                                </SelectContent>
                            </Select>
                        </div>
                    </div>

                    <label className="flex cursor-pointer items-start gap-2 rounded-[8px] border border-black/[0.06] bg-black/[0.02] p-3 text-xs dark:border-white/[0.08] dark:bg-white/[0.04]">
                        <Checkbox
                            checked={autoEpcBits}
                            onCheckedChange={(v) =>
                                onUpdate(
                                    v === true
                                        ? { autoEpcBitsFromData: true, chip: "manual" }
                                        : { autoEpcBitsFromData: false },
                                )
                            }
                            className="mt-0.5"
                        />
                        <span className="space-y-0.5 leading-snug">
                            <span className="block font-medium">Auto EPC length from data</span>
                            <span className="block text-[10px] text-muted-foreground">
                                Hex rows use their own word-aligned length, e.g. 8 hex = 32 bits, 12 hex = 48 bits.
                            </span>
                        </span>
                    </label>

                    <div className="rounded-[8px] border border-black/[0.06] bg-black/[0.02] p-3 space-y-2 dark:border-white/[0.08] dark:bg-white/[0.04]">
                        <div className="flex items-center justify-between gap-2">
                            <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                EPC source field
                            </Label>
                            {sourceColumn ? (
                                <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                                    <CheckCircle2 className="h-3 w-3" />
                                    linked
                                </span>
                            ) : sourceIsBuiltIn ? (
                                <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                                    <CheckCircle2 className="h-3 w-3" />
                                    built-in
                                </span>
                            ) : sourceName ? (
                                <span className="inline-flex items-center gap-1 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-700 dark:text-red-300">
                                    <AlertCircle className="h-3 w-3" />
                                    missing
                                </span>
                            ) : (
                                <span className="rounded bg-black/[0.06] px-1.5 py-0.5 text-[10px] text-muted-foreground dark:bg-white/[0.08]">
                                    manual
                                </span>
                            )}
                        </div>
                        <Select value={sourceSelectValue} onValueChange={selectSourceField}>
                            <SelectTrigger className="font-mono text-xs">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value={manualSourceValue}>
                                    Manual / literal EPC data
                                </SelectItem>
                                {selectableColumns.map((col) => (
                                    <SelectItem key={col.id} value={col.name}>
                                        {col.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <p className="text-[10px] leading-snug text-muted-foreground">
                            Chọn column import như <code className="rounded bg-background px-1">rfid</code>{" "}
                            để encode EPC theo từng row. Đổi tên column ở Data Feed thì binding RFID sẽ đi theo.
                        </p>
                    </div>

                    <div className="space-y-1">
                        <Label className="text-xs">EPC / data</Label>
                        <Input
                            value={rfid.data}
                            title={
                                literalAutoBits
                                    ? `Auto EPC length: ${literalAutoBits} bits`
                                    : undefined
                            }
                            onChange={(e) => {
                                const data = e.target.value;
                                onUpdate({
                                    data,
                                    fieldName: rfidSourceName(data) ?? undefined,
                                });
                            }}
                            placeholder="30140F21880C0000000001"
                            className={cn(
                                "font-mono text-xs",
                                literalHexValidation &&
                                    (literalHexValidation.valid
                                        ? "border-emerald-500/60 text-emerald-700 dark:text-emerald-300"
                                        : "border-red-500/60 text-red-700 dark:text-red-300"),
                            )}
                        />
                        {rfid.format === "H" && (
                            <p
                                className={cn(
                                    "text-[10px] leading-snug",
                                    literalHexValidation
                                        ? literalHexValidation.valid
                                            ? "text-emerald-700 dark:text-emerald-300"
                                            : "text-red-700 dark:text-red-300"
                                        : "text-muted-foreground",
                                )}
                            >
                                {literalHexValidation
                                    ? literalHexValidation.valid
                                        ? literalAutoBits
                                            ? `Valid hex - ${literalHexValidation.normalized.length} chars - auto ${literalAutoBits} bits`
                                            : `Valid hex - ${literalHexValidation.normalized.length}/${fixedEpcBits / 4} chars`
                                        : literalHexValidation.reason
                                    : autoEpcBits
                                      ? "Data Feed RFID cells derive EPC length from each row."
                                      : "Data Feed RFID cells must match the configured EPC length."}
                            </p>
                        )}
                    </div>

                    <div>
                        <button
                            type="button"
                            onClick={() => setAdvancedOpen((v) => !v)}
                            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                        >
                            {advancedOpen ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                            ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                            )}
                            Advanced options
                        </button>
                        {advancedOpen && (
                            <div className="grid grid-cols-2 gap-2 mt-3 pl-4 border-l border-black/[0.06] dark:border-white/[0.06]">
                                <NumField
                                    label="Attempts"
                                    value={rfid.retries}
                                    min={1}
                                    max={10}
                                    onChange={(retries) => onUpdate({ retries })}
                                />
                                <label className="col-span-2 flex items-center justify-between gap-2 text-xs">
                                    <span>Use printer-stored RFID settings</span>
                                    <Switch
                                        checked={rfid.zebraUsePrinterSettings !== false}
                                        onCheckedChange={(checked) =>
                                            onUpdate({ zebraUsePrinterSettings: checked })
                                        }
                                    />
                                </label>
                                {rfid.zebraUsePrinterSettings === false && (
                                    <>
                                        <div>
                                            <Label className="text-xs">Program position</Label>
                                            <Select
                                                value={zebraPositionMode}
                                                onValueChange={(value) =>
                                                    onUpdate({
                                                        zebraPositionMode: value as ZebraRfidPositionMode,
                                                        writePositionMm: Math.min(
                                                            value === "backward"
                                                                ? 30
                                                                : Math.min(
                                                                      999,
                                                                      Math.max(0, Math.floor(labelLengthMm)),
                                                                  ),
                                                            Math.max(
                                                                0,
                                                                Math.round(rfid.writePositionMm ?? 0),
                                                            ),
                                                        ),
                                                    })
                                                }
                                            >
                                                <SelectTrigger>
                                                    <SelectValue />
                                                </SelectTrigger>
                                                <SelectContent>
                                                    <SelectItem value="calibrated">Printer calibrated</SelectItem>
                                                    <SelectItem value="forward">Forward</SelectItem>
                                                    <SelectItem value="backward">Backward</SelectItem>
                                                </SelectContent>
                                            </Select>
                                        </div>
                                        {zebraPositionMode !== "calibrated" && (
                                            <div>
                                                <Label className="text-xs">Position</Label>
                                                <Select
                                                    value={String(programPositionMm)}
                                                    onValueChange={(value) =>
                                                        onUpdate({ writePositionMm: Number(value) })
                                                    }
                                                >
                                                    <SelectTrigger>
                                                        <SelectValue />
                                                    </SelectTrigger>
                                                    <SelectContent>
                                                        {programPositionOptions.map((distance) => (
                                                            <SelectItem
                                                                key={distance}
                                                                value={String(distance)}
                                                            >
                                                                {zebraPositionMode === "forward" ? "F" : "B"}
                                                                {distance} · {distance} mm
                                                            </SelectItem>
                                                        ))}
                                                    </SelectContent>
                                                </Select>
                                            </div>
                                        )}
                                        <NumField
                                            label="Read power"
                                            value={rfid.zebraReadPower ?? rfid.power ?? -1}
                                            min={-1}
                                            max={30}
                                            onChange={(zebraReadPower) => onUpdate({ zebraReadPower })}
                                        />
                                        <NumField
                                            label="Write power"
                                            value={rfid.zebraWritePower ?? rfid.power ?? -1}
                                            min={-1}
                                            max={30}
                                            onChange={(zebraWritePower) => onUpdate({ zebraWritePower })}
                                        />
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
