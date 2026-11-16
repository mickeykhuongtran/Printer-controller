import { promises as fs } from "node:fs";
import path from "node:path";

import { cleanString, isRecord } from "./api/integration/_common";
import {
    printerDpiFromUnknown,
    zebraPrinterModelFromUnknown,
} from "./printer-target";
import type { PrinterDpi, ZebraRfidModel } from "./types";

export type PrinterAliasConfig = {
    label?: string;
    printerName?: string;
    portName?: string;
    templatePath?: string;
    modelId?: ZebraRfidModel;
    targetPrinterModel?: ZebraRfidModel;
    dpi?: PrinterDpi;
};

export type PrinterRoutingConfig = {
    agentUrl?: string;
    aliases: Record<string, PrinterAliasConfig>;
};

type WindowsPrinterInfo = {
    name: string;
    isDefault?: boolean;
    portName?: string;
    driverName?: string;
    description?: string;
    comment?: string;
};

function configuredDataPath(
    explicitPath: string | undefined,
    ...fallbackSegments: string[]
): string {
    const configured = explicitPath?.trim();
    if (configured) return path.resolve(configured);

    const dataRoot = process.env.NEXTWAVES_DATA_DIR?.trim();
    return dataRoot
        ? path.resolve(dataRoot, ...fallbackSegments)
        : path.join(process.cwd(), "data", ...fallbackSegments);
}

const CONFIG_PATH = configuredDataPath(
    process.env.NEXTWAVES_PRINTER_CONFIG_PATH,
    "printer-routing.json",
);

export const DEFAULT_PRINTER_ROUTING_CONFIG: PrinterRoutingConfig = {
    agentUrl: "http://127.0.0.1:17917",
    aliases: {
        tem_loai_a: {
            label: "Tem loai A",
            printerName: "Zebra ZT610R",
            templatePath: "template/Generic_Label_A.nwl",
            modelId: "zt610r",
            targetPrinterModel: "zt610r",
            dpi: 300,
        },
        "tem loai a": {
            label: "Tem loai A",
            printerName: "Zebra ZT610R",
            templatePath: "template/Generic_Label_A.nwl",
            modelId: "zt610r",
            targetPrinterModel: "zt610r",
            dpi: 300,
        },
        tem_loai_b: {
            label: "Tem loai B",
            templatePath: "template/Generic_Label_B.nwl",
            modelId: "auto",
            targetPrinterModel: "auto",
            dpi: 203,
        },
    },
};

export function printerAliasKey(value: string): string {
    return value
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ");
}

function compactAliasKey(value: string): string {
    return printerAliasKey(value).replace(/\s+/g, "");
}

function normalizeAgentUrl(url: string): string {
    return (url || "http://127.0.0.1:17917").trim().replace(/\/+$/, "")
        || "http://127.0.0.1:17917";
}

function sanitizeAliasConfig(value: unknown): PrinterAliasConfig {
    if (!isRecord(value)) return {};
    const modelId = zebraPrinterModelFromUnknown(value.modelId)
        ?? zebraPrinterModelFromUnknown(value.targetPrinterModel);
    const dpi = printerDpiFromUnknown(value.dpi);
    return {
        label: cleanString(value.label),
        printerName: cleanString(value.printerName),
        portName: cleanString(value.portName),
        templatePath: cleanString(value.templatePath),
        ...(modelId ? { modelId, targetPrinterModel: modelId } : {}),
        ...(dpi ? { dpi } : {}),
    };
}

function normalizeConfig(value: unknown): PrinterRoutingConfig {
    const aliases: Record<string, PrinterAliasConfig> = {};
    const rawAliases = isRecord(value) && isRecord(value.aliases) ? value.aliases : {};
    for (const [key, rawConfig] of Object.entries(rawAliases)) {
        const normalized = printerAliasKey(key);
        if (!normalized) continue;
        const sanitized = sanitizeAliasConfig(rawConfig);
        aliases[normalized] = sanitized;
        aliases[compactAliasKey(normalized)] = sanitized;
    }
    return {
        agentUrl: isRecord(value) ? cleanString(value.agentUrl) : "",
        aliases,
    };
}

function mergeConfigs(
    base: PrinterRoutingConfig,
    override: PrinterRoutingConfig,
): PrinterRoutingConfig {
    const aliases: Record<string, PrinterAliasConfig> = { ...base.aliases };
    for (const [key, config] of Object.entries(override.aliases)) {
        aliases[key] = {
            ...aliases[key],
            ...config,
        };
    }
    return {
        agentUrl: override.agentUrl || base.agentUrl,
        aliases,
    };
}

export async function readPrinterRoutingConfig(): Promise<PrinterRoutingConfig> {
    try {
        const raw = await fs.readFile(CONFIG_PATH, "utf8");
        return mergeConfigs(DEFAULT_PRINTER_ROUTING_CONFIG, normalizeConfig(JSON.parse(raw)));
    } catch {
        return DEFAULT_PRINTER_ROUTING_CONFIG;
    }
}

export async function writePrinterRoutingConfig(config: PrinterRoutingConfig): Promise<PrinterRoutingConfig> {
    const normalized = normalizeConfig(config);
    await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
    await fs.writeFile(CONFIG_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return mergeConfigs(DEFAULT_PRINTER_ROUTING_CONFIG, normalized);
}

function addEnvAlias(
    aliases: Record<string, string>,
    key: string,
    value: string,
): void {
    const normalized = printerAliasKey(key);
    if (!normalized || !value) return;
    aliases[normalized] = value;
    aliases[compactAliasKey(normalized)] = value;
}

function parseEnvPrinterAliases(): Record<string, string> {
    const raw = process.env.NEXTWAVES_PRINTER_ALIASES || "";
    const aliases: Record<string, string> = {};
    if (!raw.trim()) return aliases;

    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!isRecord(parsed)) return aliases;
        for (const [key, value] of Object.entries(parsed)) {
            addEnvAlias(aliases, key, cleanString(value));
        }
        return aliases;
    } catch {
        for (const pair of raw.split(/[;\n]/)) {
            const [key, ...rest] = pair.split("=");
            addEnvAlias(aliases, key ?? "", rest.join("=").trim());
        }
        return aliases;
    }
}

async function listAgentPrinters(agentUrl: string): Promise<WindowsPrinterInfo[]> {
    const response = await fetch(`${normalizeAgentUrl(agentUrl)}/printers`, { cache: "no-store" });
    if (!response.ok) return [];
    const json = (await response.json().catch(() => null)) as unknown;
    if (!isRecord(json) || !Array.isArray(json.printers)) return [];
    return json.printers
        .filter(isRecord)
        .map((printer) => ({
            name: cleanString(printer.name),
            isDefault: printer.isDefault === true,
            portName: cleanString(printer.portName),
            driverName: cleanString(printer.driverName),
            description: cleanString(printer.description),
            comment: cleanString(printer.comment),
        }))
        .filter((printer) => printer.name);
}

async function resolvePrinterByPort(
    portName: string,
    agentUrl: string,
): Promise<string> {
    const portKey = portName.trim().toLowerCase();
    if (!portKey) return "";
    const printers = await listAgentPrinters(agentUrl).catch(() => []);
    return printers.find((printer) => printer.portName?.toLowerCase() === portKey)?.name || "";
}

export async function resolvePrinterNameAlias(
    requested: string,
    agentUrl: string,
): Promise<string> {
    const config = await readPrinterRoutingConfig();
    const envAliases = parseEnvPrinterAliases();
    const key = printerAliasKey(requested);
    const compactKey = compactAliasKey(requested);
    const configured = config.aliases[key] || config.aliases[compactKey];

    if (configured?.portName) {
        const byPort = await resolvePrinterByPort(configured.portName, agentUrl);
        if (byPort) return byPort;
    }
    if (configured?.printerName) return configured.printerName;
    if (envAliases[key]) return envAliases[key];
    if (envAliases[compactKey]) return envAliases[compactKey];
    return requested;
}

export async function resolvePrinterAliasConfig(requested: string): Promise<PrinterAliasConfig | null> {
    const config = await readPrinterRoutingConfig();
    const key = printerAliasKey(requested);
    const compactKey = compactAliasKey(requested);
    return config.aliases[key] || config.aliases[compactKey] || null;
}

export function printerRoutingConfigPath(): string {
    return CONFIG_PATH;
}
