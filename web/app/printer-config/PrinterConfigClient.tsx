"use client";

import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Save, Settings2 } from "lucide-react";

import {
    compatiblePrinterDpi,
    zebraPrinterModelProfile,
    ZEBRA_PRINTER_MODELS,
} from "../printer-models";
import type { PrinterDpi, ZebraRfidModel } from "../types";

type AliasConfig = {
    label?: string;
    printerName?: string;
    portName?: string;
    templatePath?: string;
    modelId?: ZebraRfidModel;
    targetPrinterModel?: ZebraRfidModel;
    dpi?: PrinterDpi;
};

type ConfigResponse = {
    ok: boolean;
    path?: string;
    config?: {
        agentUrl?: string;
        aliases?: Record<string, AliasConfig>;
    };
    error?: string;
};

type WindowsPrinterInfo = {
    name: string;
    isDefault: boolean;
    portName?: string;
    driverName?: string;
};

const ALIASES = [
    {
        key: "tem_loai_a",
        label: "Tem loai A",
        aliases: ["tem_loai_a", "tem loai a", "temloaia"],
        templatePath: "template/Generic_Label_A.nwl",
    },
    {
        key: "tem_loai_b",
        label: "Tem loai B",
        aliases: ["tem_loai_b", "tem loai b", "temloaib"],
        templatePath: "template/Generic_Label_B.nwl",
    },
];

function normalizeAgentUrl(value: string): string {
    return value.trim().replace(/\/+$/, "") || "http://127.0.0.1:17917";
}

function optionLabel(printer: WindowsPrinterInfo): string {
    const parts = [printer.name];
    if (printer.portName) parts.push(printer.portName);
    if (printer.isDefault) parts.push("Default");
    return parts.join(" - ");
}

export function PrinterConfigClient() {
    const [agentUrl, setAgentUrl] = useState("http://127.0.0.1:17917");
    const [aliases, setAliases] = useState<Record<string, AliasConfig>>({});
    const [printers, setPrinters] = useState<WindowsPrinterInfo[]>([]);
    const [configPath, setConfigPath] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState("");

    const sortedPrinters = useMemo(
        () =>
            [...printers].sort((a, b) => {
                if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
                return a.name.localeCompare(b.name);
            }),
        [printers],
    );

    function updateAlias(key: string, patch: AliasConfig): void {
        setAliases((current) => ({
            ...current,
            [key]: {
                ...current[key],
                ...patch,
            },
        }));
    }

    function aliasValue(alias: (typeof ALIASES)[number]): AliasConfig {
        for (const key of alias.aliases) {
            if (aliases[key]) return aliases[key];
        }
        return {};
    }

    async function loadConfig(): Promise<string> {
        const res = await fetch("/api/integration/printer-routing", { cache: "no-store" });
        const data = (await res.json()) as ConfigResponse;
        if (!res.ok || !data.ok || !data.config) {
            throw new Error(data.error || `Config HTTP ${res.status}`);
        }
        const nextAgentUrl = data.config.agentUrl || "http://127.0.0.1:17917";
        setAgentUrl(nextAgentUrl);
        setAliases(data.config.aliases || {});
        setConfigPath(data.path || "");
        return nextAgentUrl;
    }

    async function loadPrinters(nextAgentUrl = agentUrl): Promise<void> {
        const base = normalizeAgentUrl(nextAgentUrl);
        const res = await fetch(`${base}/printers`, { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as
            | { printers?: WindowsPrinterInfo[]; error?: string }
            | null;
        if (!res.ok || !Array.isArray(data?.printers)) {
            throw new Error(data?.error || `Print agent HTTP ${res.status}`);
        }
        setPrinters(data.printers);
    }

    async function refreshAll(): Promise<void> {
        setBusy(true);
        setMessage("");
        try {
            const nextAgentUrl = await loadConfig();
            await loadPrinters(nextAgentUrl);
            setMessage("Loaded printer config.");
        } catch (err) {
            setMessage(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    async function saveConfig(): Promise<void> {
        setBusy(true);
        setMessage("");
        try {
            const payloadAliases: Record<string, AliasConfig> = {};
            for (const alias of ALIASES) {
                const value = {
                    label: alias.label,
                    templatePath: alias.templatePath,
                    ...aliasValue(alias),
                };
                for (const key of alias.aliases) payloadAliases[key] = value;
            }

            const res = await fetch("/api/integration/printer-routing", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    agentUrl: normalizeAgentUrl(agentUrl),
                    aliases: payloadAliases,
                }),
            });
            const data = (await res.json()) as ConfigResponse;
            if (!res.ok || !data.ok || !data.config) {
                throw new Error(data.error || `Save HTTP ${res.status}`);
            }
            setAliases(data.config.aliases || {});
            setConfigPath(data.path || "");
            setMessage("Saved. New /print calls will use this mapping.");
        } catch (err) {
            setMessage(err instanceof Error ? err.message : String(err));
        } finally {
            setBusy(false);
        }
    }

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void refreshAll();
        }, 0);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <main className="min-h-screen bg-background px-6 py-6 text-foreground">
            <div className="mx-auto flex max-w-5xl flex-col gap-5">
                <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                            <div className="flex items-center gap-3">
                                <Settings2 className="h-6 w-6" />
                                <h1 className="text-2xl font-semibold">Printer Config</h1>
                            </div>
                            <p className="mt-2 text-sm text-muted-foreground">
                                Map each alias to a physical printer model, printhead DPI, Windows queue,
                                and template. Model/DPI control rendering; the queue name only validates them.
                            </p>
                        </div>
                        <div className="flex gap-2">
                            <button
                                type="button"
                                onClick={refreshAll}
                                disabled={busy}
                                className="inline-flex h-10 items-center gap-2 rounded-md border border-border px-4 text-sm font-medium hover:bg-accent disabled:opacity-60"
                            >
                                <RefreshCw className="h-4 w-4" />
                                Reload
                            </button>
                            <button
                                type="button"
                                onClick={saveConfig}
                                disabled={busy}
                                className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-60"
                            >
                                <Save className="h-4 w-4" />
                                Save
                            </button>
                        </div>
                    </div>

                    <label className="mt-5 block text-sm font-medium">
                        Local print agent URL
                        <input
                            value={agentUrl}
                            onChange={(event) => setAgentUrl(event.target.value)}
                            className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm"
                        />
                    </label>
                    {message ? (
                        <div className="mt-4 rounded-md border border-border bg-background p-3 text-sm">
                            {message}
                        </div>
                    ) : null}
                    {configPath ? (
                        <div className="mt-3 text-xs text-muted-foreground">
                            Config file: <span className="font-mono">{configPath}</span>
                        </div>
                    ) : null}
                </section>

                <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
                    <div className="grid gap-4">
                        {ALIASES.map((alias) => {
                            const value = aliasValue(alias);
                            const modelId = value.modelId ?? value.targetPrinterModel ?? "auto";
                            const modelProfile = zebraPrinterModelProfile(modelId);
                            const dpi = compatiblePrinterDpi(
                                modelId,
                                value.dpi ?? modelProfile.defaultDpi,
                            );
                            return (
                                <div
                                    key={alias.key}
                                    className="grid gap-3 rounded-md border border-border bg-background p-4 md:grid-cols-[160px_1fr_140px]"
                                >
                                    <div>
                                        <div className="text-sm text-muted-foreground">Printer alias</div>
                                        <div className="mt-1 font-mono text-lg font-semibold">{alias.key}</div>
                                        <div className="mt-1 text-xs text-muted-foreground">{alias.label}</div>
                                    </div>
                                    <label className="block text-sm font-medium">
                                        Windows printer queue
                                        <select
                                            value={value.printerName || ""}
                                            onChange={(event) => {
                                                const printer = sortedPrinters.find(
                                                    (item) => item.name === event.target.value,
                                                );
                                                updateAlias(alias.key, {
                                                    label: alias.label,
                                                    printerName: event.target.value,
                                                    portName: printer?.portName || "",
                                                });
                                            }}
                                            className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                                        >
                                            <option value="">Select printer...</option>
                                            {sortedPrinters.map((printer) => (
                                                <option key={printer.name} value={printer.name}>
                                                    {optionLabel(printer)}
                                                </option>
                                            ))}
                                        </select>
                                    </label>
                                    <label className="block text-sm font-medium">
                                        USB/port
                                        <input
                                            value={value.portName || ""}
                                            onChange={(event) =>
                                                updateAlias(alias.key, {
                                                    label: alias.label,
                                                    portName: event.target.value,
                                                })
                                            }
                                            placeholder="USB001"
                                            className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm"
                                        />
                                    </label>
                                    <label className="block text-sm font-medium md:col-start-2">
                                        Physical printer model
                                        <select
                                            value={modelId}
                                            onChange={(event) => {
                                                const nextModel = event.target.value as ZebraRfidModel;
                                                const nextDpi = compatiblePrinterDpi(nextModel, dpi);
                                                updateAlias(alias.key, {
                                                    label: alias.label,
                                                    modelId: nextModel,
                                                    targetPrinterModel: nextModel,
                                                    dpi: nextDpi,
                                                });
                                            }}
                                            className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                                        >
                                            {ZEBRA_PRINTER_MODELS.map((model) => (
                                                <option key={model.id} value={model.id}>
                                                    {model.label}
                                                </option>
                                            ))}
                                        </select>
                                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                                            {modelProfile.family}
                                        </span>
                                    </label>
                                    <label className="block text-sm font-medium">
                                        Printhead DPI
                                        <select
                                            value={dpi}
                                            onChange={(event) => {
                                                const nextDpi = Number(event.target.value) as PrinterDpi;
                                                updateAlias(alias.key, {
                                                    label: alias.label,
                                                    modelId,
                                                    targetPrinterModel: modelId,
                                                    dpi: nextDpi,
                                                });
                                            }}
                                            className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 text-sm"
                                        >
                                            {modelProfile.supportedDpis.map((option) => (
                                                <option key={option} value={option}>
                                                    {option} dpi
                                                </option>
                                            ))}
                                        </select>
                                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                                            Geometry stays in mm; output dots are recalculated.
                                        </span>
                                    </label>
                                    <label className="block text-sm font-medium md:col-span-3">
                                        Template file
                                        <input
                                            value={value.templatePath || alias.templatePath}
                                            onChange={(event) =>
                                                updateAlias(alias.key, {
                                                    label: alias.label,
                                                    templatePath: event.target.value,
                                                })
                                            }
                                            className="mt-2 h-11 w-full rounded-md border border-border bg-background px-3 font-mono text-sm"
                                        />
                                    </label>
                                </div>
                            );
                        })}
                    </div>
                </section>

                <section className="rounded-lg border border-border bg-card p-5 shadow-sm">
                    <h2 className="text-lg font-semibold">Detected Printers</h2>
                    <div className="mt-4 divide-y divide-border rounded-md border border-border bg-background">
                        {sortedPrinters.length === 0 ? (
                            <div className="p-4 text-sm text-muted-foreground">No printers loaded.</div>
                        ) : (
                            sortedPrinters.map((printer) => (
                                <div key={printer.name} className="grid gap-2 p-3 text-sm md:grid-cols-[1fr_120px_1fr]">
                                    <div className="font-medium">{printer.name}</div>
                                    <div className="font-mono">{printer.portName || "-"}</div>
                                    <div className="truncate text-muted-foreground">
                                        {printer.driverName || "-"}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </section>
            </div>
        </main>
    );
}
