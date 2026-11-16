"use client";

/* eslint-disable react-hooks/set-state-in-effect -- browser storage and saved sessions are restored after hydration. */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import Link from "next/link";
import {
    ArrowLeft,
    ArrowRight,
    Undo2,
    Redo2,
    Save,
    Download,
    Magnet,
    Grid3x3,
    Braces,
    Eye,
    ZoomIn,
    ZoomOut,
    ChevronLeft,
    ChevronRight,
    BookOpen,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ThemeToggle } from "./components/ThemeToggle";
import { PrinterSetupDialog } from "./components/PrinterSetupDialog";
import { DesignerCanvas } from "./components/DesignerCanvas";
import { Toolbar } from "./components/Toolbar";
import { LabelSidebar, ElementSidebar } from "./components/PropertiesPanel";
import { BottomDock } from "./components/BottomDock";
import { ChooseStep } from "./components/ChooseStep";
import { FleetConsole } from "./components/FleetConsole";
import { PrintStep } from "./components/PrintStep";
import { DEFAULT_TEXT_MARGIN_MM } from "./text-margin";
import { Stepper, type Step } from "./components/Stepper";
import { ElementContextMenu, type ContextMenuTarget } from "./components/ElementContextMenu";
import { historyReducer, makeInitialHistory } from "./history";
import { defaultDataFeed } from "./reducer";
import {
    downloadFile,
    exportToJson,
    loadCustomTemplates,
    loadSession,
    loadPrinterSettings,
    DEFAULT_PRINTER_BAUD_RATE,
    nameTimestamp,
    normalizePrinterBaudRate,
    parseImportedJson,
    removeCustomTemplate,
    saveSession,
    savePrinterSettings,
    type PrinterSettings,
    upsertCustomTemplate,
} from "./storage";
import { DEFAULT_PRINT_CONNECTOR_URL } from "./print-connector-config";
import { resolveDocForCopy, templateFieldVars } from "./label-data";
import { rfidTextLastChars } from "./rfid-text";
import { evaluateRow } from "./data-feed";
import { track } from "./lib/analytics";
import type { VariableSuggestion } from "./components/HighlightedField";
import type {
    DesignerState,
    ElementKind,
    FontWeight,
    LabelDoc,
    LabelElement,
    TableEl,
    TextEl,
} from "./types";
import { DEFAULT_ICON_WEIGHT, renderIconSvg, svgToDataUrl, type IconDef } from "./icons";
import { dotsPerMm, uid } from "./units";
import { SerialSessionProvider } from "./serial-session";

const ZOOM_STEPS = [3, 4, 5, 6, 8, 10, 12, 14, 16, 20, 24];
const REFERENCE_ZOOM = 8;

function makeNewElement(kind: ElementKind, hostMm: { w: number; h: number }): LabelElement {
    const id = uid(kind);
    const cx = Math.max(2, Math.min(hostMm.w - 12, hostMm.w / 2 - 6));
    const cy = Math.max(2, Math.min(hostMm.h - 8, hostMm.h / 2 - 4));
    switch (kind) {
        case "text":
            return {
                id,
                kind: "text",
                pos: { x: cx, y: cy },
                size: { w: 30, h: 6 },
                text: "Sample text",
                marginMm: DEFAULT_TEXT_MARGIN_MM,
                // Zebra ZPL built-in font metadata is retained as a fallback;
                // the active designer render uses the system stack below.
                font: "D",
                scaleX: 1,
                scaleY: 1,
                rotation: 0,
                fontSource: "system",
                fontFamily: "System Sans",
                fontSizeMm: 4,
                wrapMode: "none",
                fitMode: "clip",
            };
        case "qr":
            return {
                id,
                kind: "qr",
                pos: { x: cx, y: cy },
                size: { w: 14, h: 14 },
                data: "QR-DATA",
                rotation: 0,
                ecc: "M",
                cell: 4,
                sizeMode: "auto",
                quietZoneModules: 4,
                minModuleMm: 0.33,
                version: 0,
                align: "center",
                verticalAlign: "center",
            };
        case "datamatrix":
            return {
                id,
                kind: "datamatrix",
                pos: { x: cx, y: cy },
                size: { w: 14, h: 14 },
                data: "DM-DATA",
                rotation: 0,
                contentFormat: "standard",
                shape: "square",
                textEncoding: "utf8",
                sizeMode: "auto",
                quietZoneModules: 1,
                minModuleMm: 0.25,
                align: "center",
                verticalAlign: "center",
            };
        case "barcode":
            return {
                id,
                kind: "barcode",
                pos: { x: 4, y: cy },
                size: { w: Math.min(hostMm.w - 8, 40), h: 12 },
                data: "1234567890",
                rotation: 0,
                symbology: "CODE128",
                humanReadable: true,
                align: "center",
                sizeMode: "auto",
                minModuleMm: 0.25,
                textSizeMm: 2,
                textPaddingMm: 0.3,
                textPosition: "below",
                textAlign: "center",
            };
        case "rect":
            return {
                id,
                kind: "rect",
                pos: { x: cx, y: cy },
                size: { w: 20, h: 14 },
                thickness: 0.4,
                filled: false,
            };
        case "line":
            return {
                id,
                kind: "line",
                pos: { x: cx, y: cy },
                size: { w: 30, h: 0.4 },
                thickness: 0.4,
                orientation: "h",
            };
        case "image":
            return {
                id,
                kind: "image",
                pos: { x: cx, y: cy },
                size: { w: 20, h: 20 },
                src: "",
                threshold: 0,
            };
        case "table": {
            const rows = 3;
            const cols = 3;
            const tableW = Math.min(hostMm.w - 4, 40);
            const tableH = Math.min(hostMm.h - 4, 18);
            const colW = tableW / cols;
            const rowH = tableH / rows;
            return {
                id,
                kind: "table",
                pos: {
                    x: Math.max(2, hostMm.w / 2 - tableW / 2),
                    y: Math.max(2, hostMm.h / 2 - tableH / 2),
                },
                size: { w: tableW, h: tableH },
                rows,
                cols,
                cells: [
                    "Name", "Qty", "Lot",
                    "", "", "",
                    "", "", "",
                ],
                rowHeights: Array(rows).fill(rowH),
                colWidths: Array(cols).fill(colW),
                scaleMode: "all",
                borderThickness: 0.3,
                headerRow: true,
                fontSizeMm: 3,
                align: "left",
                padding: 0.5,
                // Default to system font so non-ASCII (e.g. Vietnamese
                // diacritics) renders out of the box. Printer falls back
                // to bitmap Font E sized to match until raster output is
                // wired.
                fontSource: "system",
                fontFamily: "System Sans",
                fontWeight: 400,
            };
        }
    }
}

function duplicateElement(el: LabelElement, hostMm: { w: number; h: number }): LabelElement {
    const offset = 2;
    const dx = el.pos.x + offset > hostMm.w - el.size.w ? -offset : offset;
    const dy = el.pos.y + offset > hostMm.h - el.size.h ? -offset : offset;
    return {
        ...el,
        id: uid(el.kind),
        pos: { x: Math.max(0, el.pos.x + dx), y: Math.max(0, el.pos.y + dy) },
        size: { ...el.size },
    } as LabelElement;
}

function emptyDoc(): LabelDoc {
    return {
        id: "empty",
        name: "Untitled",
        settings: {
            widthMm: 60,
            heightMm: 40,
            gapMm: 3,
            dpi: 300,
            targetPrinterModel: "auto",
            copies: 1,
            speed: 4,
            darkness: 10,
            printMode: "thermal_transfer",
            sensorMode: 1,
            startOffsetDots: 0,
            rowOffsetDots: 0,
            codePage: 850,
            serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
            rfid: {
                enabled: false,
                chip: "epc_96",
                epcBits: 96,
                autoEpcBitsFromData: false,
                format: "H",
                retries: 3,
                block: 2,
                words: 6,
                data: "",
                zebraModel: "auto",
                zebraUsePrinterSettings: true,
                zebraPositionMode: "calibrated",
                zebraEpcReadMode: "pc",
            },
        },
        elements: [],
        dataFeed: defaultDataFeed(),
    };
}

const INITIAL_DESIGNER: DesignerState = {
    doc: emptyDoc(),
    selectedId: null,
    selectedIds: [],
    editingId: null,
    snapToGrid: true,
    showGrid: false,
    highlightVars: true,
    zoom: REFERENCE_ZOOM,
    feedOpen: false,
    feedFullscreen: false,
    previewRowId: null,
};

export default function PrintPage() {
    const [history, dispatch] = useReducer(
        historyReducer,
        INITIAL_DESIGNER,
        makeInitialHistory,
    );
    const state = history.present;
    const canUndo = history.past.length > 0;
    const canRedo = history.future.length > 0;
    const [step, setStep] = useState<Step>("choose");
    const [printBusy, setPrintBusy] = useState(false);
    const printBusyRef = useRef(false);
    const onPrintBusyChange = useCallback((busy: boolean) => { printBusyRef.current = busy; setPrintBusy(busy); }, []);
    const [zoomMode, setZoomMode] = useState<"manual" | "fit" | "native-dot">("manual");
    const [snapUnit, setSnapUnit] = useState<"mm" | "dot">("mm");
    const [gridUnit, setGridUnit] = useState<"mm" | "dot">("mm");
    const [printFidelity, setPrintFidelity] = useState(false);
    // Tied to step. Pushes a history entry whenever the user moves forward
    // (e.g. "Continue" → print, picking a template → edit, Stepper jump) so
    // the browser Back button steps back through choose → edit → print
    // instead of leaving the page entirely.
    const stepRef = useRef<Step>("choose");
    useEffect(() => {
        stepRef.current = step;
    }, [step]);
    const navigateStep = useCallback((next: Step) => {
        if (printBusyRef.current && next !== "print") return;
        const prev = stepRef.current;
        if (prev !== next) track("step_changed", { from: prev, to: next });
        setStep(next);
        if (typeof window !== "undefined") {
            try {
                window.history.pushState(
                    { __nwStep: next },
                    "",
                    `/?step=${next}`,
                );
            } catch {
                /* ignore */
            }
        }
    }, []);
    const [hasDoc, setHasDoc] = useState(false);
    const [custom, setCustom] = useState<LabelDoc[]>([]);
    const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);
    const [leftPanelOpen, setLeftPanelOpen] = useState(true);
    const [rightPanelOpen, setRightPanelOpen] = useState(true);
    // Printer-profile settings. Persistent in localStorage so physical-label
    // calibration and connection settings survive templates and reloads.
    const [printerSwitchBusy, setPrinterSwitchBusy] = useState(false);
    const [printerSettings, setPrinterSettings] = useState<PrinterSettings>({
        labelTopDots: 0,
        leftPositionDots: 0,
        embedAlignmentInJobs: false,
        embedTearOffInJobs: false,
        connectionMode: "windowsRaw",
        baudRate: DEFAULT_PRINTER_BAUD_RATE,
        serialFlowControl: "none",
        language: "zpl",
        printerName: "",
        printAgentUrl: DEFAULT_PRINT_CONNECTOR_URL,
        tcpHost: "",
        tcpPort: 9100,
        tcpExecutionMode: "auto",
        headWidthMm: 0,
        hAlign: "left",
    });
    useEffect(() => {
        setPrinterSettings(loadPrinterSettings());
    }, []);
    const updatePrinterSettings = useCallback((patch: Partial<PrinterSettings>) => {
        setPrinterSettings((prev) => {
            const merged = { ...prev, ...patch };
            const next = {
                ...merged,
                baudRate: normalizePrinterBaudRate(merged.baudRate),
            };
            savePrinterSettings(next);
            return next;
        });
    }, []);
    const clipboardRef = useRef<LabelElement[]>([]);

    const canvasViewportRef = useRef<HTMLDivElement | null>(null);
    const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);

    useEffect(() => {
        setCustom(loadCustomTemplates());
        const session = loadSession();
        // Decide initial step. Order of preference:
        //   1. Existing ?step= query param (e.g. user reloaded mid-flow).
        //   2. Saved session step (if a doc is in progress).
        //   3. Default "choose".
        const search = new URLSearchParams(window.location.search);
        const urlStep = search.get("step") as Step | null;
        let initial: Step = "choose";
        if (session && session.hasDoc) {
            dispatch({ type: "load", doc: session.doc });
            setHasDoc(true);
            initial = session.step;
            if (typeof session.zoom === "number") {
                dispatch({ type: "setZoom", zoom: session.zoom });
            }
            if (
                typeof session.scrollLeft === "number" &&
                typeof session.scrollTop === "number"
            ) {
                pendingScrollRef.current = {
                    left: session.scrollLeft,
                    top: session.scrollTop,
                };
            }
        }
        if (urlStep === "choose" || urlStep === "edit" || urlStep === "print") {
            initial = urlStep;
        }
        setStep(initial);
        // Replace (don't push) so the *first* history entry already carries
        // the step. That way the user's first Back press takes them off the
        // page entirely, not to a placeholder URL we created.
        try {
            window.history.replaceState(
                { __nwStep: initial },
                "",
                `/?step=${initial}`,
            );
        } catch {
            /* ignore */
        }
    }, []);

    // Browser back/forward → roll step back/forward in lock-step with the
    // entries we pushed via navigateStep().
    useEffect(() => {
        const onPop = (e: PopStateEvent) => {
            if (printBusyRef.current) {
                window.history.pushState({ __nwStep: "print" }, "", "/?step=print");
                return;
            }
            const s = e.state?.__nwStep as Step | undefined;
            if (s === "choose" || s === "edit" || s === "print") {
                setStep(s);
                return;
            }
            // No tagged state on this entry — try the URL.
            const fromUrl = new URLSearchParams(window.location.search).get(
                "step",
            ) as Step | null;
            if (fromUrl === "choose" || fromUrl === "edit" || fromUrl === "print") {
                setStep(fromUrl);
            }
        };
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);

    // PWA File Handling API — when the OS launches the installed app to
    // open a .nwl file (Finder/Explorer/xdg-open), Chromium delivers the
    // file handles via window.launchQueue. We parse the first valid one,
    // load it as the active doc, and jump to the editor.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const queue = window.launchQueue;
        if (!queue) return;
        queue.setConsumer(async (params) => {
            if (!params.files || params.files.length === 0) return;
            for (const handle of params.files) {
                try {
                    const file = await handle.getFile();
                    const text = await file.text();
                    const doc = parseImportedJson(text);
                    if (!doc) continue;
                    dispatch({
                        type: "load",
                        doc: { ...doc, id: `usr_${uid("tpl")}`, builtIn: false },
                    });
                    setHasDoc(true);
                    navigateStep("edit");
                    return;
                } catch {
                    /* try next file */
                }
            }
        });
    }, [navigateStep]);

    useEffect(() => {
        if (!hasDoc) return;
        const handle = window.setTimeout(() => {
            const node = canvasViewportRef.current;
            saveSession({
                doc: state.doc,
                step,
                hasDoc,
                zoom: state.zoom,
                scrollLeft: node?.scrollLeft,
                scrollTop: node?.scrollTop,
            });
        }, 250);
        return () => window.clearTimeout(handle);
    }, [state.doc, step, hasDoc, state.zoom]);

    // Restore the saved scroll position once the canvas viewport is rendered
    // and the canvas has had a layout pass at the restored zoom. Two rAFs is
    // enough for the inner canvas to size itself before we set scroll.
    useEffect(() => {
        if (step !== "edit") return;
        const pending = pendingScrollRef.current;
        if (!pending) return;
        const node = canvasViewportRef.current;
        if (!node) return;
        let raf2 = 0;
        const raf1 = window.requestAnimationFrame(() => {
            raf2 = window.requestAnimationFrame(() => {
                node.scrollLeft = pending.left;
                node.scrollTop = pending.top;
                pendingScrollRef.current = null;
            });
        });
        return () => {
            window.cancelAnimationFrame(raf1);
            if (raf2) window.cancelAnimationFrame(raf2);
        };
    }, [step, hasDoc]);

    // Persist scroll position as the user pans the canvas (throttled).
    useEffect(() => {
        if (step !== "edit" || !hasDoc) return;
        const node = canvasViewportRef.current;
        if (!node) return;
        let handle = 0;
        const onScroll = () => {
            if (handle) return;
            handle = window.setTimeout(() => {
                handle = 0;
                saveSession({
                    doc: state.doc,
                    step,
                    hasDoc,
                    zoom: state.zoom,
                    scrollLeft: node.scrollLeft,
                    scrollTop: node.scrollTop,
                });
            }, 250);
        };
        node.addEventListener("scroll", onScroll, { passive: true });
        return () => {
            node.removeEventListener("scroll", onScroll);
            if (handle) window.clearTimeout(handle);
        };
    }, [step, hasDoc, state.doc, state.zoom]);

    // Variables for the autocomplete + highlight: feed columns.
    const variables = useMemo<VariableSuggestion[]>(() => {
        const feed = state.doc.dataFeed;
        const items: VariableSuggestion[] = feed
            ? feed.columns.filter((c) => !c.system).map((c) => ({
                name: c.name,
                source: c.formula ? ("formula" as const) : ("column" as const),
                description: c.formula ? `Formula: ${c.formula}` : undefined,
            }))
            : [];
        const readFieldName = (state.doc.settings.rfid.readFieldName ?? "rfid_read").trim();
        if (state.doc.settings.rfid.readEnabled && readFieldName) {
            items.push({
                name: readFieldName,
                source: "builtin",
                description: `RFID ${state.doc.settings.rfid.readBank ?? "EPC"} read variable`,
            });
        }
        return items;
    }, [
        state.doc.dataFeed,
        state.doc.settings.rfid.readBank,
        state.doc.settings.rfid.readEnabled,
        state.doc.settings.rfid.readFieldName,
    ]);

    // The doc rendered on the canvas. When the user has selected a row in the
    // data feed for preview, substitute its variables into element data so the
    // canvas shows the real values for that row.
    // Editing must stay independent of the print quantity. Compile the full
    // batch only in the PrintStep print/export actions, never during page render.
    const canvasDoc = useMemo(() => {
        const feed = state.doc.dataFeed;
        const fieldVars = templateFieldVars(state.doc) ?? {};
        const resolveCanvasDoc = (copyIndex: number, vars: Record<string, string>) => {
            const resolved = resolveDocForCopy(state.doc, copyIndex, vars);
            const editing = state.doc.elements.find((el) => el.id === state.editingId);
            if (editing?.kind !== "text" || !rfidTextLastChars(editing, state.doc.settings.rfid)) return resolved;
            // Edit the source reference, even while a row preview displays its suffix.
            return { ...resolved, elements: resolved.elements.map((el) => el.id === editing.id ? editing : el) };
        };
        if (!state.previewRowId || !feed) {
            return Object.keys(fieldVars).length > 0
                ? resolveCanvasDoc(0, fieldVars)
                : state.doc;
        }
        const idx = feed.rows.findIndex((r) => r.id === state.previewRowId);
        if (idx < 0) {
            return Object.keys(fieldVars).length > 0
                ? resolveCanvasDoc(0, fieldVars)
                : state.doc;
        }
        const vars = { ...fieldVars, ...evaluateRow(feed, idx) };
        return resolveCanvasDoc(idx, vars);
    }, [state.doc, state.previewRowId, state.editingId]);
    const selectedEl = useMemo(
        () => state.doc.elements.find((e) => e.id === state.selectedId) ?? null,
        [state.doc.elements, state.selectedId],
    );
    const selectedEls = useMemo(() => {
        const ids = new Set(state.selectedIds);
        return state.doc.elements.filter((e) => ids.has(e.id));
    }, [state.doc.elements, state.selectedIds]);

    const canVisit: Record<Step, boolean> = {
        choose: true,
        edit: hasDoc,
        print: hasDoc && state.doc.elements.length > 0,
    };

    const onPickFromChooser = useCallback(
        (doc: LabelDoc) => {
            track("template_selected", {
                template_id: doc.id,
                template_name: doc.name,
                built_in: !!doc.builtIn,
                has_rfid: !!doc.settings.rfid?.enabled,
            });
            dispatch({ type: "load", doc });
            setHasDoc(true);
            navigateStep("edit");
        },
        [navigateStep],
    );

    const onDeleteCustom = useCallback((id: string) => {
        track("custom_template_deleted", { template_id: id });
        const next = removeCustomTemplate(id);
        setCustom(next);
    }, []);

    const onAdd = useCallback(
        (kind: ElementKind) => {
            track("element_added", { kind });
            const el = makeNewElement(kind, {
                w: state.doc.settings.widthMm,
                h: state.doc.settings.heightMm,
            });
            dispatch({ type: "addElement", element: el });
        },
        [state.doc.settings.widthMm, state.doc.settings.heightMm],
    );

    // Add an empty image placeholder; the user clicks it on the canvas to
    // pick a file, so size/threshold/etc. set first are preserved when the
    // source is finally chosen.
    const onAddImage = useCallback(() => {
        track("element_added", { kind: "image" });
        const el = makeNewElement("image", {
            w: state.doc.settings.widthMm,
            h: state.doc.settings.heightMm,
        });
        dispatch({ type: "addElement", element: el });
    }, [state.doc.settings.widthMm, state.doc.settings.heightMm]);

    const onAddIcon = useCallback(
        (icon: IconDef) => {
            track("element_added", { kind: "icon", icon_id: icon.id });
            const cx = Math.max(2, state.doc.settings.widthMm / 2 - 6);
            const cy = Math.max(2, state.doc.settings.heightMm / 2 - 6);
            const el: LabelElement = {
                id: uid("image"),
                kind: "image",
                pos: { x: cx, y: cy },
                size: { w: 12, h: 12 },
                src: svgToDataUrl(renderIconSvg(icon.svg, DEFAULT_ICON_WEIGHT)),
                fileName: `${icon.id}.svg`,
                threshold: 0,
                iconId: icon.id,
                iconWeight: DEFAULT_ICON_WEIGHT,
            };
            dispatch({ type: "addElement", element: el });
        },
        [state.doc.settings.widthMm, state.doc.settings.heightMm],
    );

    const ZOOM_MIN = 2;
    const ZOOM_MAX = 32;

    const setZoomTo = useCallback((next: number) => {
        const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
        dispatch({ type: "setZoom", zoom: clamped });
    }, []);

    const onZoomIn = useCallback(() => {
        track("zoom_changed", { action: "in" });
        setZoomMode("manual");
        const idx = ZOOM_STEPS.indexOf(state.zoom);
        const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, (idx < 0 ? 4 : idx) + 1)];
        dispatch({ type: "setZoom", zoom: next });
    }, [state.zoom]);
    const onZoomOut = useCallback(() => {
        track("zoom_changed", { action: "out" });
        setZoomMode("manual");
        const idx = ZOOM_STEPS.indexOf(state.zoom);
        const next = ZOOM_STEPS[Math.max(0, (idx < 0 ? 4 : idx) - 1)];
        dispatch({ type: "setZoom", zoom: next });
    }, [state.zoom]);
    const zoomPercent = Math.round((state.zoom / REFERENCE_ZOOM) * 100);

    const setZoomPercent = useCallback(
        (percent: number) => {
            setZoomMode("manual");
            setZoomTo((percent / 100) * REFERENCE_ZOOM);
        },
        [setZoomTo],
    );

    const onZoomFit = useCallback(() => {
        track("zoom_changed", { action: "fit" });
        setZoomMode("fit");
        const node = canvasViewportRef.current;
        if (!node) return;
        const padding = 32;
        const widthMm = state.doc.settings.widthMm;
        const heightMm = state.doc.settings.heightMm;
        if (!widthMm || !heightMm) return;
        const availW = Math.max(50, node.clientWidth - padding);
        const availH = Math.max(50, node.clientHeight - padding);
        const fit = Math.min(availW / widthMm, availH / heightMm);
        setZoomTo(fit);
    }, [setZoomTo, state.doc.settings.widthMm, state.doc.settings.heightMm]);

    const onPreviewNativeDots = useCallback(
        (dpi = state.doc.settings.dpi) => {
            track("zoom_changed", { action: "native_dots", dpi });
            setZoomMode("native-dot");
            setZoomTo(dotsPerMm(dpi));
        },
        [setZoomTo, state.doc.settings.dpi],
    );
    const nativeDotPreview =
        zoomMode === "native-dot" &&
        Math.abs(state.zoom - dotsPerMm(state.doc.settings.dpi)) < 0.001;

    useEffect(() => {
        if (zoomMode !== "native-dot") return;
        setZoomTo(dotsPerMm(state.doc.settings.dpi));
    }, [setZoomTo, state.doc.settings.dpi, zoomMode]);

    const snapStepMm = snapUnit === "dot" ? 1 / dotsPerMm(state.doc.settings.dpi) : 1;
    const gridStepMm = gridUnit === "dot" ? 1 / dotsPerMm(state.doc.settings.dpi) : 1;
    const dotGridTooDense =
        gridUnit === "dot" && state.zoom * gridStepMm < 3;

    const cycleSnapMode = useCallback(() => {
        if (!state.snapToGrid) {
            setSnapUnit("mm");
            dispatch({ type: "toggleSnap" });
            return;
        }
        if (snapUnit === "mm") {
            setSnapUnit("dot");
            return;
        }
        dispatch({ type: "toggleSnap" });
    }, [snapUnit, state.snapToGrid]);

    const cycleGridMode = useCallback(() => {
        if (!state.showGrid) {
            setGridUnit("mm");
            dispatch({ type: "toggleGrid" });
            return;
        }
        if (gridUnit === "mm") {
            setGridUnit("dot");
            return;
        }
        setGridUnit("mm");
        dispatch({ type: "toggleGrid" });
    }, [gridUnit, state.showGrid]);

    // Mouse-wheel + pinch (trackpad pinch produces wheel events with ctrlKey).
    // Ctrl/Cmd+wheel zooms; plain wheel scrolls (default).
    useEffect(() => {
        if (step !== "edit") return;
        const node = canvasViewportRef.current;
        if (!node) return;
        const onWheel = (e: WheelEvent) => {
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            // Negative deltaY = scroll up = zoom in.
            const factor = Math.exp(-e.deltaY * 0.01);
            setZoomMode("manual");
            setZoomTo(state.zoom * factor);
        };
        node.addEventListener("wheel", onWheel, { passive: false });
        return () => node.removeEventListener("wheel", onWheel);
    }, [step, state.zoom, setZoomTo]);

    const onDuplicateSelected = useCallback(() => {
        if (selectedEls.length === 0) return;
        track("element_duplicated", { count: selectedEls.length });
        const canvasMm = {
            w: state.doc.settings.widthMm,
            h: state.doc.settings.heightMm,
        };
        for (const el of selectedEls) {
            dispatch({
                type: "addElement",
                element: duplicateElement(el, canvasMm),
            });
        }
    }, [selectedEls, state.doc.settings.widthMm, state.doc.settings.heightMm]);

    const onDeleteSelected = useCallback(() => {
        if (state.selectedIds.length === 0) return;
        track("element_deleted", { count: state.selectedIds.length });
        dispatch({ type: "removeElements", ids: state.selectedIds });
    }, [state.selectedIds]);

    const onCopySelected = useCallback(() => {
        if (selectedEls.length === 0) return;
        clipboardRef.current = selectedEls.slice();
    }, [selectedEls]);

    const onPasteFromClipboard = useCallback(() => {
        const src = clipboardRef.current;
        if (!src.length) return;
        const canvasMm = {
            w: state.doc.settings.widthMm,
            h: state.doc.settings.heightMm,
        };
        const dups = src.map((s) => duplicateElement(s, canvasMm));
        for (const dup of dups) dispatch({ type: "addElement", element: dup });
        // Update clipboard so consecutive pastes keep cascading.
        clipboardRef.current = dups;
    }, [state.doc.settings.widthMm, state.doc.settings.heightMm]);

    const onToggleLockSelected = useCallback(() => {
        if (selectedEls.length === 0) return;
        // If any are unlocked, lock all; otherwise unlock all.
        const next = selectedEls.some((el) => !el.locked);
        track("elements_locked_toggled", { count: selectedEls.length, locked: next });
        for (const el of selectedEls) {
            dispatch({
                type: "updateElement",
                id: el.id,
                patch: { locked: next } as Partial<LabelElement>,
            });
        }
    }, [selectedEls]);

    const onReorderSelected = useCallback(
        (direction: "up" | "down") => {
            if (state.selectedIds.length === 0) return;
            for (const id of state.selectedIds) {
                dispatch({ type: "reorder", id, direction });
            }
        },
        [state.selectedIds],
    );

    const onCenterSelected = useCallback(
        (axis: "h" | "v") => {
            const movable = selectedEls.filter((el) => !el.locked);
            if (movable.length === 0) return;
            const { widthMm, heightMm } = state.doc.settings;
            // Single element: center the element itself.
            if (movable.length === 1) {
                const el = movable[0];
                const pos = {
                    x: axis === "h" ? Math.max(0, (widthMm - el.size.w) / 2) : el.pos.x,
                    y: axis === "v" ? Math.max(0, (heightMm - el.size.h) / 2) : el.pos.y,
                };
                dispatch({ type: "moveElement", id: el.id, pos });
                return;
            }
            // Multi: center the group's bounding box; preserve relative layout.
            const minX = Math.min(...movable.map((el) => el.pos.x));
            const maxX = Math.max(...movable.map((el) => el.pos.x + el.size.w));
            const minY = Math.min(...movable.map((el) => el.pos.y));
            const maxY = Math.max(...movable.map((el) => el.pos.y + el.size.h));
            const dx =
                axis === "h" ? (widthMm - (maxX - minX)) / 2 - minX : 0;
            const dy =
                axis === "v" ? (heightMm - (maxY - minY)) / 2 - minY : 0;
            const deltas = movable.map((el) => ({
                id: el.id,
                pos: { x: el.pos.x + dx, y: el.pos.y + dy },
            }));
            dispatch({ type: "moveElements", deltas });
        },
        [selectedEls, state.doc.settings],
    );

    const onElementContextMenu = useCallback(
        (id: string, clientX: number, clientY: number) => {
            const el = state.doc.elements.find((e) => e.id === id);
            if (!el) return;
            // Commit any active text edit so the textarea unmounts and selection clears.
            if (state.editingId) dispatch({ type: "endEdit" });
            // If the right-clicked element is part of a multi-selection,
            // pass the whole selection so menu actions affect all of it.
            const inSelection = state.selectedIds.includes(id);
            const els =
                inSelection && state.selectedIds.length > 1
                    ? state.doc.elements.filter((e) =>
                          state.selectedIds.includes(e.id),
                      )
                    : [el];
            setContextMenu({ el, els, clientX, clientY });
        },
        [state.doc.elements, state.editingId, state.selectedIds],
    );

    const onUndo = useCallback(() => {
        track("undo");
        dispatch({ type: "undo" });
    }, []);
    const onRedo = useCallback(() => {
        track("redo");
        dispatch({ type: "redo" });
    }, []);

    const onSaveCurrent = useCallback((): LabelDoc => {
        const isUpdate = state.doc.id.startsWith("usr_");
        const id = isUpdate ? state.doc.id : `usr_${uid("tpl")}`;
        const name = isUpdate
            ? state.doc.name
            : `${state.doc.name} ${nameTimestamp()}`;
        const toSave: LabelDoc = { ...state.doc, id, name, builtIn: false };
        track("template_saved", {
            template_id: id,
            template_name: name,
            element_count: state.doc.elements.length,
            is_update: isUpdate,
        });
        const next = upsertCustomTemplate(toSave);
        setCustom(next);
        dispatch({ type: "load", doc: toSave });
        return toSave;
    }, [state.doc]);

    const onDownloadJson = useCallback(() => {
        const safeName =
            (state.doc.name || "label-template")
                .replace(/[^A-Za-z0-9_\-]+/g, "-")
                .replace(/^-+|-+$/g, "")
                .toLowerCase() || "label-template";
        track("template_exported", {
            template_id: state.doc.id,
            template_name: state.doc.name,
            filename: `${safeName}.nwl`,
        });
        downloadFile(`${safeName}.nwl`, exportToJson(state.doc), "application/json");
    }, [state.doc]);

    // Keyboard shortcuts only fire when editing
    useEffect(() => {
        if (step !== "edit") return;
        const handler = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const tag = target?.tagName;
            const isEditable =
                tag === "INPUT" ||
                tag === "TEXTAREA" ||
                tag === "SELECT" ||
                target?.isContentEditable;
            const isMod = e.metaKey || e.ctrlKey;
            if (isMod && e.key.toLowerCase() === "z" && !isEditable) {
                e.preventDefault();
                if (e.shiftKey) onRedo();
                else onUndo();
                return;
            }
            if (isMod && e.key.toLowerCase() === "y" && !isEditable) {
                e.preventDefault();
                onRedo();
                return;
            }
            if (isMod && e.key.toLowerCase() === "s" && !isEditable) {
                e.preventDefault();
                onSaveCurrent();
                return;
            }
            if (isEditable) return;
            // Select-all works without prior selection.
            if (isMod && e.key.toLowerCase() === "a") {
                e.preventDefault();
                dispatch({
                    type: "selectMany",
                    ids: state.doc.elements.map((el) => el.id),
                });
                return;
            }
            // Paste works without selection (uses clipboardRef).
            if (isMod && e.key.toLowerCase() === "v") {
                if (!clipboardRef.current.length) return;
                e.preventDefault();
                onPasteFromClipboard();
                return;
            }
            if (state.selectedIds.length === 0) return;
            if (isMod && e.key.toLowerCase() === "c") {
                e.preventDefault();
                onCopySelected();
                return;
            }
            if (isMod && e.key.toLowerCase() === "x") {
                e.preventDefault();
                onCopySelected();
                onDeleteSelected();
                return;
            }
            if (e.key === "Delete" || e.key === "Backspace") {
                e.preventDefault();
                onDeleteSelected();
                return;
            }
            if (isMod && e.key.toLowerCase() === "d") {
                e.preventDefault();
                onDuplicateSelected();
                return;
            }
            if (e.key === "Enter" || e.key === "F2") {
                if (state.selectedIds.length !== 1) return;
                const sel = state.doc.elements.find(
                    (el) => el.id === state.selectedIds[0],
                );
                if (sel?.kind === "text") {
                    e.preventDefault();
                    dispatch({ type: "beginEdit", id: sel.id });
                    return;
                }
            }
            const selIds = new Set(state.selectedIds);
            const sels = state.doc.elements.filter(
                (el) => selIds.has(el.id) && !el.locked,
            );
            if (sels.length === 0) return;
            const stepMm = e.shiftKey ? 5 : 1;
            const max = { w: state.doc.settings.widthMm, h: state.doc.settings.heightMm };
            const isArrow =
                e.key === "ArrowLeft" ||
                e.key === "ArrowRight" ||
                e.key === "ArrowUp" ||
                e.key === "ArrowDown";
            if (!isArrow) return;
            e.preventDefault();
            // Constrain group delta so no element crosses canvas edge.
            let dx = 0;
            let dy = 0;
            if (e.key === "ArrowLeft") dx = -stepMm;
            else if (e.key === "ArrowRight") dx = stepMm;
            else if (e.key === "ArrowUp") dy = -stepMm;
            else if (e.key === "ArrowDown") dy = stepMm;
            if (dx < 0) dx = -Math.min(-dx, ...sels.map((el) => el.pos.x));
            if (dx > 0)
                dx = Math.min(
                    dx,
                    ...sels.map((el) => max.w - (el.pos.x + el.size.w)),
                );
            if (dy < 0) dy = -Math.min(-dy, ...sels.map((el) => el.pos.y));
            if (dy > 0)
                dy = Math.min(
                    dy,
                    ...sels.map((el) => max.h - (el.pos.y + el.size.h)),
                );
            if (dx === 0 && dy === 0) return;
            dispatch({
                type: "moveElements",
                deltas: sels.map((el) => ({
                    id: el.id,
                    pos: { x: el.pos.x + dx, y: el.pos.y + dy },
                })),
            });
        };
        window.addEventListener("keydown", handler);
        return () => window.removeEventListener("keydown", handler);
    }, [
        step,
        state.selectedIds,
        state.doc.elements,
        state.doc.settings.widthMm,
        state.doc.settings.heightMm,
        onDeleteSelected,
        onDuplicateSelected,
        onCopySelected,
        onPasteFromClipboard,
        onUndo,
        onRedo,
        onSaveCurrent,
    ]);

    // Ctrl/Cmd + B to toggle bold on selected text. Capture phase so it fires
    // before the in-place text editor's textarea swallows the event with
    // stopPropagation (lets the user bold mid-edit, not just when selected).
    // ZPL bitmap fonts don't have a weight axis, so we skip those — only
    // web-font (system / google / custom) elements toggle.
    useEffect(() => {
        if (step !== "edit") return;
        const handler = (e: KeyboardEvent) => {
            const isMod = e.metaKey || e.ctrlKey;
            if (!isMod) return;
            if (e.key.toLowerCase() !== "b") return;
            if (e.altKey) return;
            const ids = new Set<string>();
            if (state.editingId) ids.add(state.editingId);
            for (const id of state.selectedIds) ids.add(id);
            const eligible = state.doc.elements.filter(
                (el): el is TextEl =>
                    ids.has(el.id) &&
                    el.kind === "text" &&
                    !el.locked &&
                    !!el.fontSource &&
                    el.fontSource !== "zpl",
            );
            if (eligible.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            const allBold = eligible.every((el) => (el.fontWeight ?? 400) >= 600);
            const nextWeight: FontWeight = allBold ? 400 : 700;
            for (const el of eligible) {
                dispatch({
                    type: "updateElement",
                    id: el.id,
                    patch: { fontWeight: nextWeight } as Partial<LabelElement>,
                });
            }
        };
        window.addEventListener("keydown", handler, true);
        return () => window.removeEventListener("keydown", handler, true);
    }, [step, state.selectedIds, state.editingId, state.doc.elements]);

    // Ctrl/Cmd + "=" / "-" to bump font size on selected text or table
    // elements. Capture phase so it works mid-edit (the in-place text editor
    // and table-cell editor would otherwise swallow the keydown). For tables
    // we update the table-level fontSizeMm, which all cells inherit unless
    // they have a per-cell override; per-cell tweaks live in the floating
    // toolbar. Browser zoom (Cmd +/-) is preempted, which is the expected
    // tradeoff once a label element is active.
    useEffect(() => {
        if (step !== "edit") return;
        const FONT_STEP = 0.5;
        const FONT_MIN = 0.5;
        const FONT_MAX = 40;
        const round2 = (n: number) => Math.round(n * 100) / 100;
        const handler = (e: KeyboardEvent) => {
            const isMod = e.metaKey || e.ctrlKey;
            if (!isMod) return;
            const k = e.key;
            // "=" is the unshifted physical key for "+"; accept both spellings
            // plus "_" so Shift-Cmd-- still decreases.
            const isPlus = k === "+" || k === "=";
            const isMinus = k === "-" || k === "_";
            if (!isPlus && !isMinus) return;
            const delta = isPlus ? FONT_STEP : -FONT_STEP;
            const ids = new Set<string>();
            if (state.editingId) ids.add(state.editingId);
            for (const id of state.selectedIds) ids.add(id);
            if (ids.size === 0) return;
            const targets = state.doc.elements.filter(
                (el) =>
                    ids.has(el.id) &&
                    !el.locked &&
                    (el.kind === "text" || el.kind === "table"),
            );
            if (targets.length === 0) return;
            e.preventDefault();
            e.stopPropagation();
            for (const el of targets) {
                const cur =
                    el.kind === "text"
                        ? (el as TextEl).fontSizeMm ?? 4
                        : (el as TableEl).fontSizeMm;
                const next = round2(
                    Math.max(FONT_MIN, Math.min(FONT_MAX, cur + delta)),
                );
                if (next === cur) continue;
                dispatch({
                    type: "updateElement",
                    id: el.id,
                    patch: { fontSizeMm: next } as Partial<LabelElement>,
                });
            }
        };
        window.addEventListener("keydown", handler, true);
        return () => window.removeEventListener("keydown", handler, true);
    }, [step, state.selectedIds, state.editingId, state.doc.elements]);

    const stepSubtitle =
        step === "choose"
            ? "Pick a template or start blank"
            : step === "edit"
              ? state.doc.name
              : "Review and print";

    return (
        <SerialSessionProvider>
        <div className="flex h-screen flex-col bg-background">
            <header className="sticky top-0 z-30 bg-background/80 backdrop-blur border-b border-black/[0.06] dark:border-white/[0.06]">
                <div className="px-6 py-3 grid grid-cols-[1fr_auto_1fr] items-center gap-4">
                    <div className="flex items-center gap-3 min-w-0 justify-self-start">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                            src="/logo/logo-black.png"
                            alt="Nextwaves"
                            className="h-7 w-auto select-none dark:invert"
                            draggable={false}
                        />
                        <div className="min-w-0">
                            <h1 className="text-lg font-semibold tracking-tight text-foreground truncate">
                                Nextwaves Label
                            </h1>
                            <p className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                <span className="truncate">{stepSubtitle}</span>
                                {state.doc.settings.rfid.enabled && (
                                    <span
                                        className="shrink-0 rounded-full border border-blue-500/30 bg-blue-500/12 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-blue-700 dark:text-blue-300"
                                        title="This template writes RFID EPC data"
                                    >
                                        RFID
                                    </span>
                                )}
                            </p>
                        </div>
                    </div>

                    <div className="justify-self-center">
                        <Stepper
                            current={step}
                            canVisit={canVisit}
                            onJump={navigateStep}
                        />
                    </div>

                    <div className="flex items-center gap-2 justify-self-end">
                        {step === "edit" && (
                            <>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={!canUndo}
                                    onClick={onUndo}
                                    title="Undo (⌘Z)"
                                >
                                    <Undo2 className="w-4 h-4" />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    disabled={!canRedo}
                                    onClick={onRedo}
                                    title="Redo (⌘⇧Z)"
                                >
                                    <Redo2 className="w-4 h-4" />
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={onSaveCurrent}
                                    title="Save (⌘S)"
                                >
                                    <Save className="w-3.5 h-3.5" />
                                    <span className="hidden lg:inline">Save</span>
                                </Button>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={onDownloadJson}
                                    title="Download Nextwaves Label (.nwl)"
                                >
                                    <Download className="w-3.5 h-3.5" />
                                    <span className="hidden lg:inline">Download .nwl</span>
                                </Button>
                                <Button
                                    onClick={() => navigateStep("print")}
                                    disabled={!canVisit.print}
                                    size="sm"
                                    className="ml-1"
                                >
                                    <span>Continue</span>
                                    <ArrowRight className="w-4 h-4" />
                                </Button>
                            </>
                        )}
                        {step === "print" && (
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={printBusy}
                                onClick={() => navigateStep("edit")}
                            >
                                <ArrowLeft className="w-4 h-4" />
                                <span>Edit again</span>
                            </Button>
                        )}
                        <Button
                            asChild
                            variant="outline"
                            size="icon"
                            className="h-11 w-11 rounded-full bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md"
                            title="Open integration guide"
                        >
                            <Link
                                href="/integration-guide"
                                target="_blank"
                                rel="noreferrer"
                                aria-label="Open integration guide"
                            >
                                <BookOpen className="w-5 h-5" />
                            </Link>
                        </Button>
                        <PrinterSetupDialog
                            agentUrl={printerSettings.printAgentUrl}
                            onAgentUrlChange={(printAgentUrl) =>
                                updatePrinterSettings({ printAgentUrl })
                            }
                        />
                        <ThemeToggle variant="inline" />
                    </div>
                </div>
            </header>
            <FleetConsole settings={printerSettings} doc={state.doc} preparing={printBusy} onSwitching={setPrinterSwitchBusy}
                onSelect={(settings, doc) => { updatePrinterSettings(settings); if (doc) dispatch({ type: "load", doc }); }} />

            {step === "choose" && (
                <ChooseStep
                    custom={custom}
                    onPick={onPickFromChooser}
                    onDeleteCustom={onDeleteCustom}
                />
            )}

            {step === "edit" && (
                <div className="relative flex flex-1 min-h-0 overflow-hidden">
                    <div className="absolute inset-x-0 top-0 bottom-10 flex min-h-0 overflow-hidden">
                    {leftPanelOpen ? (
                        <aside className="relative z-30 h-full min-h-0 w-[300px] flex-shrink-0 overflow-visible border-r border-black/[0.06] dark:border-white/[0.06] bg-neutral-50 dark:bg-neutral-900">
                            <LabelSidebar
                                doc={state.doc}
                                printerSettings={printerSettings}
                                onUpdatePrinterSettings={updatePrinterSettings}
                                onUpdateSettings={(patch) =>
                                    dispatch({ type: "updateSettings", patch })
                                }
                                onUpdateSerial={(patch) =>
                                    dispatch({ type: "updateSerial", patch })
                                }
                                onUpdateRfid={(patch) =>
                                    dispatch({ type: "updateRfid", patch })
                                }
                                onRename={(name) => dispatch({ type: "rename", name })}
                            />
                            <button
                                onClick={() => setLeftPanelOpen(false)}
                                className="absolute top-3 -right-3 z-50 w-6 h-6 rounded-full bg-background border border-black/[0.08] dark:border-white/[0.1] shadow-sm flex items-center justify-center hover:bg-muted text-muted-foreground"
                                title="Hide label panel"
                                aria-label="Hide label panel"
                            >
                                <ChevronLeft className="w-3.5 h-3.5" />
                            </button>
                        </aside>
                    ) : (
                        <button
                            onClick={() => setLeftPanelOpen(true)}
                            className="w-7 flex-shrink-0 border-r border-black/[0.06] dark:border-white/[0.06] bg-neutral-50 dark:bg-neutral-900 hover:bg-muted/60 text-muted-foreground flex items-start justify-center pt-3"
                            title="Show label panel"
                            aria-label="Show label panel"
                        >
                            <ChevronRight className="w-4 h-4" />
                        </button>
                    )}

                    <main className="flex-1 flex min-h-0 min-w-0 flex-col overflow-hidden">
                        <Toolbar
                            onAdd={onAdd}
                            onAddImage={onAddImage}
                            onAddIcon={onAddIcon}
                        />
                        <div className="flex-1 relative min-h-0">
                            <div
                                ref={canvasViewportRef}
                                className="absolute inset-0 overflow-auto bg-muted/40 canvas-dot-bg"
                                onPointerDown={(e) => {
                                    // Click on the viewport background — anywhere
                                    // outside the white label paper — clears the
                                    // current selection. Element clicks bubble
                                    // up but stopPropagation in ElementBox keeps
                                    // them from triggering this.
                                    if (e.target === e.currentTarget) {
                                        dispatch({ type: "select", id: null });
                                    }
                                }}
                            >
                                <DesignerCanvas
                                    doc={canvasDoc}
                                    selectedId={state.selectedId}
                                    selectedIds={state.selectedIds}
                                    editingId={state.editingId}
                                    pxPerMm={state.zoom}
                                    snapToGrid={state.snapToGrid}
                                    snapStepMm={snapStepMm}
                                    showGrid={state.showGrid}
                                    gridStepMm={gridStepMm}
                                    rulerUnit={gridUnit}
                                    printFidelity={printFidelity}
                                    readOnly={printFidelity}
                                    highlightVars={state.highlightVars}
                                    variables={variables}
                                    onSelect={(id, mode) => {
                                        if (id == null) {
                                            dispatch({ type: "select", id: null });
                                            return;
                                        }
                                        if (mode === "add") {
                                            dispatch({ type: "selectAdd", id });
                                        } else if (mode === "toggle") {
                                            dispatch({ type: "selectToggle", id });
                                        } else {
                                            dispatch({ type: "select", id });
                                        }
                                    }}
                                    onSelectMany={(ids, mode) => {
                                        if (mode === "add") {
                                            const merged = Array.from(
                                                new Set([
                                                    ...state.selectedIds,
                                                    ...ids,
                                                ]),
                                            );
                                            dispatch({ type: "selectMany", ids: merged });
                                        } else {
                                            dispatch({ type: "selectMany", ids });
                                        }
                                    }}
                                    onMove={(id, pos) =>
                                        dispatch({ type: "moveElement", id, pos })
                                    }
                                    onMoveMany={(deltas) =>
                                        dispatch({ type: "moveElements", deltas })
                                    }
                                    onResize={(id, pos, size) =>
                                        dispatch({
                                            type: "resizeElement",
                                            id,
                                            pos,
                                            size,
                                        })
                                    }
                                    onBeginEdit={(id) =>
                                        dispatch({ type: "beginEdit", id })
                                    }
                                    onEndEdit={() => dispatch({ type: "endEdit" })}
                                    onUpdateElement={(id, patch) =>
                                        dispatch({ type: "updateElement", id, patch })
                                    }
                                    onContextMenu={onElementContextMenu}
                                />
                            </div>

                            {/* Canvas controls overlay — floats over the bottom of the canvas viewport */}
                            <div className="absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none z-20">
                                <div className="pointer-events-auto flex items-center gap-1 px-2 py-1 rounded-full bg-background/95 backdrop-blur-md ring-1 ring-black/[0.08] dark:ring-white/10 shadow-lg">
                                    <Button
                                        variant={state.snapToGrid ? "default" : "ghost"}
                                        size="sm"
                                        className="h-8 px-2.5 rounded-full"
                                        onClick={cycleSnapMode}
                                        title={
                                            !state.snapToGrid
                                                ? "Snap off · click for 1 mm"
                                                : snapUnit === "mm"
                                                  ? "Snap 1 mm · click for 1 printer dot"
                                                  : "Snap 1 printer dot · click to turn off"
                                        }
                                        data-testid="snap-mode"
                                    >
                                        <Magnet className="w-3.5 h-3.5" />
                                        <span className="ml-1.5 text-xs hidden md:inline">
                                            {!state.snapToGrid
                                                ? "Snap off"
                                                : snapUnit === "dot"
                                                  ? "Snap 1 dot"
                                                  : "Snap 1 mm"}
                                        </span>
                                    </Button>
                                    <Button
                                        variant={state.showGrid ? "default" : "ghost"}
                                        size="sm"
                                        className="h-8 px-2.5 rounded-full"
                                        onClick={cycleGridMode}
                                        title={
                                            !state.showGrid
                                                ? "Grid off · click for millimetres"
                                                : gridUnit === "mm"
                                                  ? "Millimetre grid · click for printer dots"
                                                  : dotGridTooDense
                                                    ? "Printer-dot grid hidden at this zoom · click to turn off"
                                                    : "Printer-dot grid · click to turn off"
                                        }
                                        data-testid="grid-mode"
                                    >
                                        <Grid3x3 className="w-3.5 h-3.5" />
                                        <span className="ml-1.5 text-xs hidden md:inline">
                                            {!state.showGrid
                                                ? "Grid off"
                                                : gridUnit === "dot"
                                                  ? dotGridTooDense
                                                      ? "Dots · zoom in"
                                                      : "Grid dots"
                                                  : "Grid mm"}
                                        </span>
                                    </Button>
                                    <Button
                                        variant={printFidelity ? "default" : "ghost"}
                                        size="sm"
                                        className="h-8 px-2.5 rounded-full"
                                        onClick={() => setPrintFidelity((value) => !value)}
                                        title={
                                            printFidelity
                                                ? "Return to editable vector design"
                                                : "Render the label at the selected printer DPI"
                                        }
                                        data-testid="print-fidelity-toggle"
                                    >
                                        <Eye className="w-3.5 h-3.5" />
                                        <span className="ml-1.5 text-xs hidden md:inline">
                                            {printFidelity ? "Fidelity on" : "Fidelity"}
                                        </span>
                                    </Button>
                                    <Button
                                        variant={
                                            state.highlightVars ? "default" : "ghost"
                                        }
                                        size="sm"
                                        className="h-8 px-2.5 rounded-full"
                                        onClick={() =>
                                            dispatch({ type: "toggleHighlightVars" })
                                        }
                                        title={
                                            state.highlightVars
                                                ? "Hide variables"
                                                : "Highlight variables"
                                        }
                                    >
                                        <Braces className="w-3.5 h-3.5" />
                                        <span className="ml-1.5 text-xs hidden md:inline">
                                            Highlight
                                        </span>
                                    </Button>
                                    {(() => {
                                        const rows = state.doc.dataFeed?.rows ?? [];
                                        const previewing = state.previewRowId != null;
                                        const disabled = rows.length === 0;
                                        return (
                                            <Button
                                                variant={previewing ? "default" : "ghost"}
                                                size="sm"
                                                className="h-8 px-2.5 rounded-full"
                                                disabled={disabled}
                                                onClick={() =>
                                                    dispatch({
                                                        type: "feed/setPreviewRow",
                                                        rowId: previewing
                                                            ? null
                                                            : rows[0].id,
                                                    })
                                                }
                                                title={
                                                    disabled
                                                        ? "Add a data feed row to preview"
                                                        : previewing
                                                          ? "Stop preview"
                                                          : "Preview first record"
                                                }
                                            >
                                                <Eye className="w-3.5 h-3.5" />
                                                <span className="ml-1.5 text-xs hidden md:inline">
                                                    Preview
                                                </span>
                                            </Button>
                                        );
                                    })()}
                                    <div className="w-px h-5 bg-black/[0.08] dark:bg-white/10 mx-1" />
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 p-0 rounded-full"
                                        onClick={onZoomOut}
                                        title="Zoom out"
                                    >
                                        <ZoomOut className="w-3.5 h-3.5" />
                                    </Button>
                                    <DropdownMenu>
                                        <DropdownMenuTrigger asChild>
                                            <button
                                                type="button"
                                                title="Zoom presets"
                                                data-testid="zoom-percent"
                                                className="text-[11px] font-mono tabular-nums w-12 text-center text-muted-foreground hover:text-foreground select-none rounded px-1 py-0.5 hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring"
                                            >
                                                {zoomPercent}%
                                            </button>
                                        </DropdownMenuTrigger>
                                        <DropdownMenuContent align="center" className="min-w-[100px]">
                                            <DropdownMenuItem onSelect={() => setZoomPercent(50)}>
                                                50%
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onSelect={() => setZoomPercent(100)}>
                                                100%
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onSelect={() => setZoomPercent(200)}>
                                                200%
                                            </DropdownMenuItem>
                                            <DropdownMenuItem onSelect={onZoomFit}>
                                                Fit
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                onSelect={() => onPreviewNativeDots(state.doc.settings.dpi)}
                                            >
                                                {nativeDotPreview ? "✓ " : ""}1 dot = 1 px
                                            </DropdownMenuItem>
                                        </DropdownMenuContent>
                                    </DropdownMenu>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-8 w-8 p-0 rounded-full"
                                        onClick={onZoomIn}
                                        title="Zoom in"
                                    >
                                        <ZoomIn className="w-3.5 h-3.5" />
                                    </Button>
                                </div>
                            </div>
                        </div>
                    </main>

                    {rightPanelOpen ? (
                        <aside className="relative z-30 h-full min-h-0 w-[280px] flex-shrink-0 overflow-visible border-l border-black/[0.06] dark:border-white/[0.06] bg-neutral-50 dark:bg-neutral-900">
                            <ElementSidebar
                                doc={state.doc}
                                selected={selectedEl}
                                onUpdateElement={(id, patch) =>
                                    dispatch({ type: "updateElement", id, patch })
                                }
                                onSelectElement={(id) => dispatch({ type: "select", id })}
                                onRemoveElement={(id) =>
                                    dispatch({ type: "removeElement", id })
                                }
                                onMoveLayer={(id, toIndex) =>
                                    dispatch({ type: "moveLayerTo", id, toIndex })
                                }
                                variables={variables}
                            />
                            <button
                                onClick={() => setRightPanelOpen(false)}
                                className="absolute top-3 -left-3 z-50 w-6 h-6 rounded-full bg-background border border-black/[0.08] dark:border-white/[0.1] shadow-sm flex items-center justify-center hover:bg-muted text-muted-foreground"
                                title="Hide element panel"
                                aria-label="Hide element panel"
                            >
                                <ChevronRight className="w-3.5 h-3.5" />
                            </button>
                        </aside>
                    ) : (
                        <button
                            onClick={() => setRightPanelOpen(true)}
                            className="w-7 flex-shrink-0 border-l border-black/[0.06] dark:border-white/[0.06] bg-neutral-50 dark:bg-neutral-900 hover:bg-muted/60 text-muted-foreground flex items-start justify-center pt-3"
                            title="Show element panel"
                            aria-label="Show element panel"
                        >
                            <ChevronLeft className="w-4 h-4" />
                        </button>
                    )}
                    </div>
                    <div className="absolute inset-x-0 bottom-0 z-40">
                        <BottomDock
                            settings={state.doc.settings}
                            feed={state.doc.dataFeed ?? { columns: [], rows: [] }}
                            printerSettings={printerSettings}
                            onUpdatePrinterSettings={updatePrinterSettings}
                            feedOpen={state.feedOpen}
                            feedFullscreen={state.feedFullscreen}
                            previewRowId={state.previewRowId}
                            serial={state.doc.settings.serial}
                            rfid={state.doc.settings.rfid}
                            showControlTab={false}
                            dispatch={dispatch}
                        />
                    </div>
                </div>
            )}

            {step === "print" && (
                <div className="relative flex flex-1 min-h-0 overflow-hidden">
                    <div className="absolute inset-x-0 top-0 bottom-10 flex min-h-0 overflow-hidden">
                        <PrintStep
                            key={`${printerSettings.printAgentUrl}:${printerSettings.tcpHost}:${printerSettings.tcpPort}`}
                            switchingPrinter={printerSwitchBusy}
                            onBusyChange={onPrintBusyChange}
                            doc={state.doc}
                            printerSettings={printerSettings}
                            onUpdatePrinterSettings={updatePrinterSettings}
                            onUpdateSettings={(patch) =>
                                dispatch({ type: "updateSettings", patch })
                            }
                            onSaveCurrent={onSaveCurrent}
                        />
                    </div>
                    <div className="absolute inset-x-0 bottom-0 z-40">
                        <BottomDock
                            settings={state.doc.settings}
                            printerSettings={printerSettings}
                            onUpdatePrinterSettings={updatePrinterSettings}
                            feed={state.doc.dataFeed ?? { columns: [], rows: [] }}
                            feedOpen={false}
                            feedFullscreen={false}
                            previewRowId={state.previewRowId}
                            serial={state.doc.settings.serial}
                            rfid={state.doc.settings.rfid}
                            showDataTab={false}
                            showConfigTab={false}
                            showControlTab
                            dispatch={dispatch}
                        />
                    </div>
                </div>
            )}

            {contextMenu && step === "edit" && (
                <ElementContextMenu
                    target={contextMenu}
                    onClose={() => setContextMenu(null)}
                    onEdit={
                        contextMenu.el.kind === "text"
                            ? () => dispatch({ type: "beginEdit", id: contextMenu.el.id })
                            : undefined
                    }
                    onCopy={onCopySelected}
                    onDuplicate={onDuplicateSelected}
                    onDelete={onDeleteSelected}
                    onReorder={onReorderSelected}
                    onToggleLock={onToggleLockSelected}
                    onCenter={onCenterSelected}
                    onSetLineOrientation={(orientation) => {
                        if (contextMenu.el.kind !== "line") return;
                        if (contextMenu.el.orientation === orientation) return;
                        dispatch({
                            type: "updateElement",
                            id: contextMenu.el.id,
                            patch: {
                                orientation,
                                size: {
                                    w: contextMenu.el.size.h,
                                    h: contextMenu.el.size.w,
                                },
                            },
                        });
                    }}
                />
            )}
        </div>
        </SerialSessionProvider>
    );
}
