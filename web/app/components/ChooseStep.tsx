"use client";

import { useMemo, useRef, useState } from "react";
import {
    Plus,
    Upload,
    Trash2,
    ArrowRight,
    Search,
    X,
    FolderOpen,
    ArrowLeft,
    FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { LabelDoc, LabelSettings, TemplateCategory } from "../types";
import {
    BUILT_IN_TEMPLATES,
    CATEGORY_LABELS,
    CATEGORY_ORDER,
    cloneTemplate,
} from "../templates";
import { parseImportedJson } from "../storage";
import { uid } from "../units";
import { TemplateThumbnail } from "./TemplateThumbnail";

const PRESET_SIZES: Array<{ label: string; w: number; h: number }> = [
    { label: "60×40", w: 60, h: 40 },
    { label: "50×30", w: 50, h: 30 },
    { label: "40×25", w: 40, h: 25 },
    { label: "100×60", w: 100, h: 60 },
];

type Tab = "all" | "non-rfid" | "rfid" | "nws-label";

const TABS: Array<{ value: Tab; label: string }> = [
    { value: "all", label: "All" },
    { value: "non-rfid", label: "Non-RFID" },
    { value: "rfid", label: "RFID" },
    { value: "nws-label", label: "NWS Label" },
];

function nowStamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function defaultSettings(widthMm: number, heightMm: number): LabelSettings {
    return {
        widthMm,
        heightMm,
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
    };
}

interface Props {
    custom: LabelDoc[];
    onPick: (doc: LabelDoc) => void;
    onDeleteCustom: (id: string) => void;
}

export function ChooseStep({ custom, onPick, onDeleteCustom }: Props) {
    const [blankW, setBlankW] = useState(60);
    const [blankH, setBlankH] = useState(40);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const [tab, setTab] = useState<Tab>("all");
    const [chip, setChip] = useState<TemplateCategory | "all">("all");
    const [query, setQuery] = useState("");

    // Two views: the default "history" (saved files as rows) and the
    // "templates" picker (built-in grid + Start Blank). Skip history when
    // there's nothing saved yet so first-time users land on the picker.
    const [view, setView] = useState<"history" | "templates">(
        custom.length > 0 ? "history" : "templates",
    );
    const [historyQuery, setHistoryQuery] = useState("");

    const onStartBlank = () => {
        const w = Math.max(15, Math.min(200, Math.round(blankW)));
        const h = Math.max(10, Math.min(200, Math.round(blankH)));
        const doc: LabelDoc = {
            id: `blank_${uid("doc")}`,
            name: `Blank ${w}×${h} ${nowStamp()}`,
            settings: defaultSettings(w, h),
            elements: [],
        };
        onPick(doc);
    };

    // Built-in templates spawn a fresh, distinguishable label each time
    // (timestamp + new id). User-saved labels are opened in place.
    const onUseTemplate = (doc: LabelDoc) => {
        if (doc.builtIn) {
            onPick(
                cloneTemplate(
                    doc,
                    `usr_${uid("doc")}`,
                    `${doc.name} ${nowStamp()}`,
                ),
            );
        } else {
            onPick(cloneTemplate(doc, doc.id, doc.name));
        }
    };

    const onImportClick = () => fileInputRef.current?.click();

    const onImportChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const text = await file.text();
        const doc = parseImportedJson(text);
        if (!doc) {
            alert("That file is not a valid Nextwaves Label (.nwl).");
            return;
        }
        onPick({ ...doc, id: `usr_${uid("tpl")}`, builtIn: false });
    };

    // Filter pipeline: tab → category chip → search query.
    const byTab = useMemo(() => {
        if (tab === "nws-label") {
            return BUILT_IN_TEMPLATES.filter((d) => d.nwsLabel);
        }
        if (tab === "rfid") {
            return BUILT_IN_TEMPLATES.filter((d) => d.settings.rfid.enabled);
        }
        if (tab === "non-rfid") {
            return BUILT_IN_TEMPLATES.filter((d) => !d.settings.rfid.enabled);
        }
        return BUILT_IN_TEMPLATES;
    }, [tab]);

    const categoriesInTab = useMemo(() => {
        if (tab === "nws-label") return [];
        const set = new Set<TemplateCategory>();
        for (const d of byTab) if (d.category) set.add(d.category);
        return CATEGORY_ORDER.filter((c) => set.has(c));
    }, [byTab, tab]);

    // If the selected chip leaves the visible category set after a tab switch,
    // reset it. We keep this side-effect-free by resolving at render time.
    const effectiveChip: TemplateCategory | "all" =
        chip !== "all" && !categoriesInTab.includes(chip) ? "all" : chip;

    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return byTab.filter((d) => {
            if (effectiveChip !== "all" && d.category !== effectiveChip) {
                return false;
            }
            if (!q) return true;
            const hay: string[] = [d.name];
            if (d.tags) hay.push(...d.tags);
            if (d.category) hay.push(CATEGORY_LABELS[d.category]);
            if (d.nwsLabel) {
                hay.push(
                    d.nwsLabel.sizeLabel,
                    d.nwsLabel.profileId,
                    String(d.nwsLabel.rfid.power),
                    String(d.nwsLabel.rfid.writePositionMm),
                );
            }
            return hay.some((s) => s.toLowerCase().includes(q));
        });
    }, [byTab, effectiveChip, query]);

    const showBlankCard = tab !== "nws-label";

    const resetFilters = () => {
        setTab("all");
        setChip("all");
        setQuery("");
    };

    // Sort saved files by recency (most recently saved first), then filter by
    // the row-list search box. Files without updatedAt sink to the bottom.
    const sortedCustom = useMemo(() => {
        return [...custom].sort(
            (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
        );
    }, [custom]);

    const filteredCustom = useMemo(() => {
        const q = historyQuery.trim().toLowerCase();
        if (!q) return sortedCustom;
        return sortedCustom.filter((d) => d.name.toLowerCase().includes(q));
    }, [sortedCustom, historyQuery]);

    if (view === "history") {
        return (
            <div className="flex-1 overflow-auto bg-muted/30">
                <div className="max-w-5xl mx-auto px-6 py-10">
                    <div className="mb-6 flex items-start justify-between gap-4">
                        <div>
                            <h2 className="text-2xl font-semibold tracking-tight">
                                Your labels
                            </h2>
                            <p className="text-sm text-muted-foreground mt-1">
                                Open a recently saved label, or create a new one from a template.
                            </p>
                        </div>
                        <div className="flex items-center gap-2">
                            <Button
                                variant="outline"
                                onClick={onImportClick}
                                className="flex-shrink-0"
                            >
                                <FolderOpen className="w-4 h-4" />
                                Open .nwl
                            </Button>
                            <Button
                                onClick={() => setView("templates")}
                                className="flex-shrink-0"
                            >
                                <Plus className="w-4 h-4" />
                                Create new
                            </Button>
                        </div>
                    </div>

                    {custom.length > 0 ? (
                        <>
                            <div className="mb-4 relative w-full sm:w-72">
                                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                                <Input
                                    value={historyQuery}
                                    onChange={(e) => setHistoryQuery(e.target.value)}
                                    placeholder="Search your labels…"
                                    className="pl-8 h-9"
                                />
                                {historyQuery && (
                                    <button
                                        type="button"
                                        onClick={() => setHistoryQuery("")}
                                        className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                        title="Clear"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                )}
                            </div>

                            <div className="rounded-[10px] ring-1 ring-black/[0.08] dark:ring-white/10 bg-white dark:bg-neutral-900 overflow-hidden">
                                {filteredCustom.map((doc, i) => (
                                    <SavedFileRow
                                        key={doc.id}
                                        doc={doc}
                                        isFirst={i === 0}
                                        onPick={() => onUseTemplate(doc)}
                                        onDelete={() => onDeleteCustom(doc.id)}
                                    />
                                ))}
                                {filteredCustom.length === 0 && (
                                    <div className="px-4 py-10 text-center text-sm text-muted-foreground">
                                        No labels match “{historyQuery}”.
                                    </div>
                                )}
                            </div>

                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".nwl,application/json,.json"
                                className="hidden"
                                onChange={onImportChange}
                            />
                        </>
                    ) : (
                        <div className="rounded-[10px] ring-1 ring-black/[0.08] dark:ring-white/10 bg-white dark:bg-neutral-900 p-10 text-center">
                            <div className="mx-auto w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                                <FileText className="w-6 h-6 text-muted-foreground" />
                            </div>
                            <h3 className="text-base font-semibold">No saved labels yet</h3>
                            <p className="text-sm text-muted-foreground mt-1">
                                Create a label from a template — saved labels show up here.
                            </p>
                            <Button
                                onClick={() => setView("templates")}
                                className="mt-4"
                            >
                                <Plus className="w-4 h-4" />
                                Create new
                            </Button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".nwl,application/json,.json"
                                className="hidden"
                                onChange={onImportChange}
                            />
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <div className="flex-1 overflow-auto bg-muted/30">
            <div className="max-w-6xl mx-auto px-6 py-10">
                <div className="mb-6 flex items-start justify-between gap-4">
                    <div>
                        {custom.length > 0 && (
                            <button
                                type="button"
                                onClick={() => setView("history")}
                                className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground mb-2"
                            >
                                <ArrowLeft className="w-4 h-4" />
                                Back to your labels
                            </button>
                        )}
                        <h2 className="text-2xl font-semibold tracking-tight">
                            How do you want to start?
                        </h2>
                        <p className="text-sm text-muted-foreground mt-1">
                            Pick a template, start blank with custom dimensions, or open a saved
                            label.
                        </p>
                    </div>
                    <Button
                        variant="outline"
                        onClick={onImportClick}
                        className="flex-shrink-0"
                    >
                        <FolderOpen className="w-4 h-4" />
                        Open Nextwaves Label (.nwl)
                    </Button>
                </div>

                {/* Filter bar: tabs + category chips + search */}
                <div className="mb-6 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="inline-flex rounded-lg bg-muted p-0.5">
                            {TABS.map((t) => (
                                <button
                                    key={t.value}
                                    type="button"
                                    onClick={() => setTab(t.value)}
                                    className={cn(
                                        "px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
                                        tab === t.value
                                            ? "bg-background text-foreground shadow-sm"
                                            : "text-muted-foreground hover:text-foreground",
                                    )}
                                >
                                    {t.label}
                                </button>
                            ))}
                        </div>
                        <div className="relative ml-auto w-full sm:w-72">
                            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                            <Input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search templates…"
                                className="pl-8 h-9"
                            />
                            {query && (
                                <button
                                    type="button"
                                    onClick={() => setQuery("")}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                    title="Clear"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                    </div>

                    {categoriesInTab.length > 0 && (
                        <div className="flex flex-wrap gap-1.5">
                            <CategoryChip
                                label="All"
                                active={effectiveChip === "all"}
                                onClick={() => setChip("all")}
                            />
                            {categoriesInTab.map((c) => (
                                <CategoryChip
                                    key={c}
                                    label={CATEGORY_LABELS[c]}
                                    active={effectiveChip === c}
                                    onClick={() => setChip(c)}
                                />
                            ))}
                        </div>
                    )}

                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                        <span>
                            {filtered.length} {filtered.length === 1 ? "template" : "templates"}
                        </span>
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {/* Blank card — always visible regardless of filter */}
                    {showBlankCard && (
                        <div className="group rounded-[16px] border border-dashed border-black/[0.16] dark:border-white/[0.16] bg-white dark:bg-neutral-900 hover:border-primary/40 hover:bg-primary/5 transition-colors p-5 flex flex-col">
                        <div className="flex-1 flex items-center justify-center mb-4 min-h-[120px]">
                            <div className="w-14 h-14 rounded-full bg-primary/10 group-hover:bg-primary/20 flex items-center justify-center transition-colors">
                                <Plus className="w-7 h-7 text-primary" />
                            </div>
                        </div>
                        <div className="space-y-3">
                            <div>
                                <h3 className="font-semibold text-base">Start Blank</h3>
                                <p className="text-xs text-muted-foreground">
                                    Empty canvas with your dimensions.
                                </p>
                            </div>
                            <div className="flex flex-wrap gap-1">
                                {PRESET_SIZES.map((p) => (
                                    <button
                                        key={p.label}
                                        type="button"
                                        onClick={() => {
                                            setBlankW(p.w);
                                            setBlankH(p.h);
                                        }}
                                        className={cn(
                                            "px-2 py-0.5 rounded-md text-[11px] font-mono transition-colors",
                                            blankW === p.w && blankH === p.h
                                                ? "bg-primary text-primary-foreground"
                                                : "bg-muted hover:bg-muted/70",
                                        )}
                                    >
                                        {p.label}
                                    </button>
                                ))}
                            </div>
                            <div className="grid grid-cols-2 gap-2">
                                <div>
                                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                        Width mm
                                    </Label>
                                    <Input
                                        type="number"
                                        min={15}
                                        max={200}
                                        value={blankW}
                                        onChange={(e) => setBlankW(Number(e.target.value))}
                                        className="h-9 mt-0.5"
                                    />
                                </div>
                                <div>
                                    <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                                        Height mm
                                    </Label>
                                    <Input
                                        type="number"
                                        min={10}
                                        max={200}
                                        value={blankH}
                                        onChange={(e) => setBlankH(Number(e.target.value))}
                                        className="h-9 mt-0.5"
                                    />
                                </div>
                            </div>
                            <Button onClick={onStartBlank} className="w-full">
                                Start
                                <ArrowRight className="w-4 h-4" />
                            </Button>
                        </div>
                        </div>
                    )}

                    {filtered.map((doc) => (
                        <TemplateCard
                            key={doc.id}
                            doc={doc}
                            onPick={() => onUseTemplate(doc)}
                        />
                    ))}
                </div>

                {filtered.length === 0 && (
                    <div className="mt-6 rounded-[10px] ring-1 ring-black/[0.08] dark:ring-white/10 bg-white dark:bg-neutral-900 p-10 text-center">
                        <p className="text-sm text-muted-foreground">
                            No templates match your filters.
                        </p>
                        <Button variant="outline" onClick={resetFilters} className="mt-3">
                            Reset filters
                        </Button>
                    </div>
                )}

                <div className="mt-10 flex items-center gap-3 border-t border-black/[0.06] dark:border-white/[0.06] pt-6">
                    <p className="text-sm text-muted-foreground">
                        Have a Nextwaves Label file?
                    </p>
                    <Button variant="outline" onClick={onImportClick}>
                        <Upload className="w-4 h-4" />
                        Open .nwl
                    </Button>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".nwl,application/json,.json"
                        className="hidden"
                        onChange={onImportChange}
                    />
                </div>
            </div>
        </div>
    );
}

function CategoryChip({
    label,
    active,
    onClick,
}: {
    label: string;
    active: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "px-2.5 py-1 rounded-full text-xs font-medium transition-colors",
                active
                    ? "bg-foreground text-background"
                    : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground",
            )}
        >
            {label}
        </button>
    );
}

function TemplateCard({
    doc,
    onPick,
    onDelete,
    saved,
}: {
    doc: LabelDoc;
    onPick: () => void;
    onDelete?: () => void;
    saved?: boolean;
}) {
    const isRfid = doc.settings.rfid.enabled;
    const isNwsLabel = Boolean(doc.nwsLabel);
    const categoryLabel = doc.category ? CATEGORY_LABELS[doc.category] : null;
    const sectionLabel = saved
        ? "Saved"
        : isNwsLabel
        ? "NWS Label - Lab calibrated"
        : categoryLabel
        ? `Built-in · ${categoryLabel}`
        : "Built-in";
    return (
        <div className="group rounded-[10px] ring-1 ring-black/[0.08] dark:ring-white/10 bg-white dark:bg-neutral-900 hover:ring-foreground/30 hover:shadow-md transition-all p-4 flex flex-col">
            <div className="flex-1 flex items-center justify-center mb-3 min-h-[120px]">
                <TemplateThumbnail doc={doc} targetWidthPx={200} />
            </div>
            <div className="flex items-start justify-between gap-2 mb-2">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground truncate">
                            {sectionLabel}
                        </p>
                        {isRfid && (
                            <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-px rounded bg-primary/10 text-primary">
                                RFID
                            </span>
                        )}
                        {isNwsLabel && (
                            <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-px rounded bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
                                NWS
                            </span>
                        )}
                    </div>
                    <h3 className="font-semibold text-base truncate">{doc.name}</h3>
                    <p className="text-xs text-muted-foreground font-mono">
                        {doc.settings.widthMm}×{doc.settings.heightMm} mm · {doc.elements.length}{" "}
                        elements
                    </p>
                    {doc.nwsLabel && (
                        <p className="mt-1 text-[11px] text-muted-foreground font-mono truncate">
                            Gap {doc.nwsLabel.media.gapMm}mm - PWR {doc.nwsLabel.rfid.power} - W.P{" "}
                            {doc.nwsLabel.rfid.writePositionMm}
                        </p>
                    )}
                </div>
                {onDelete && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            if (confirm(`Delete "${doc.name}"?`)) onDelete();
                        }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1"
                        title="Delete"
                    >
                        <Trash2 className="w-4 h-4" />
                    </button>
                )}
            </div>
            <Button onClick={onPick} className="w-full">
                Use this
                <ArrowRight className="w-4 h-4" />
            </Button>
        </div>
    );
}

function formatRelativeTime(ms: number): string {
    const diff = Date.now() - ms;
    const minutes = Math.floor(diff / 60_000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ms).toLocaleDateString();
}

function SavedFileRow({
    doc,
    isFirst,
    onPick,
    onDelete,
}: {
    doc: LabelDoc;
    isFirst: boolean;
    onPick: () => void;
    onDelete: () => void;
}) {
    const isRfid = doc.settings.rfid.enabled;
    const updated = doc.updatedAt ? formatRelativeTime(doc.updatedAt) : "—";
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onPick}
            onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onPick();
                }
            }}
            className={cn(
                "group flex items-center gap-4 px-4 py-3 cursor-pointer transition-colors hover:bg-muted/50 focus:bg-muted/50 focus:outline-none",
                !isFirst && "border-t border-black/[0.06] dark:border-white/[0.06]",
            )}
        >
            <div className="flex-shrink-0 w-9 h-9 rounded-md bg-muted flex items-center justify-center">
                <FileText className="w-4 h-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <h3 className="font-medium text-sm truncate">{doc.name}</h3>
                    {isRfid && (
                        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-px rounded bg-primary/10 text-primary flex-shrink-0">
                            RFID
                        </span>
                    )}
                </div>
                <p className="text-xs text-muted-foreground font-mono mt-0.5">
                    {doc.settings.widthMm}×{doc.settings.heightMm} mm · {doc.elements.length}{" "}
                    {doc.elements.length === 1 ? "element" : "elements"}
                </p>
            </div>
            <div className="hidden sm:block text-xs text-muted-foreground flex-shrink-0 w-24 text-right">
                {updated}
            </div>
            <button
                onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete "${doc.name}"?`)) onDelete();
                }}
                className="opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-muted-foreground hover:text-destructive p-1 flex-shrink-0"
                title="Delete"
                aria-label={`Delete ${doc.name}`}
            >
                <Trash2 className="w-4 h-4" />
            </button>
            <ArrowRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />
        </div>
    );
}
