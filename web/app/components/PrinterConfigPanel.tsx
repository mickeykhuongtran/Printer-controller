"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Cpu, FileCode2, Printer, RefreshCw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type {
    LabelSettings,
    PrinterDpi,
    RfidReadBank,
    RfidSettings,
    SensorMode,
    ZebraRfidEpcReadMode,
    ZebraRfidErrorHandling,
    ZebraRfidModel,
    ZebraRfidPositionMode,
} from "../types";
import type { PrinterSettings } from "../storage";
import { useSerialSession } from "../serial-session";
import {
    printerTransportCapabilities,
    queryPrinterText,
    writePrinterBytes,
} from "../printer-transport";
import {
    inferPrinterDpiFromDotsPerMm,
    maxPrintSpeedIps,
} from "../printer-models";
import { dotsToMm, mmToDots } from "../units";
import {
    buildZebraTearOffDotsCommand,
    normalizeZebraTearOffDots,
    ZEBRA_TEAR_OFF_DOTS_LIMIT,
} from "../zebra-media";
import {
    buildZebraRfidHostReadCommand,
    buildZebraRfidSetupLines,
    buildZebraRfidWriteCommand,
    encodeZpl,
} from "../zpl";
import { validateRfidHexValue } from "../rfid";
import {
    ZEBRA_ANTENNAS,
    ZEBRA_ADAPTIVE_ANTENNA_MIN_LABEL_MM,
    ZEBRA_MEDIA_QUERY_KEYS,
    ZEBRA_RFID_QUERY_KEYS,
    buildZebraJsonGetCommand,
    buildZebraRfidSgdConfigCommand,
    buildZebraSgdGetCommand,
    inferZebraRfidModel,
    parseZebraJsonMap,
    parseZebraRfidHostReadData,
    parseZebraSgdMap,
    zebraRfidConfigMismatches,
    zebraRfidModelOption,
    zebraRfidSgdConfigValues,
    zebraRfidSnapshotFromValues,
    type ZebraRfidPrinterSnapshot,
} from "../zebra-rfid";

const SENSOR_OPTIONS: Array<{
    value: SensorMode;
    label: string;
    command: string;
}> = [
    { value: 1, label: "Transmissive (gap / web)", command: "Y" },
    { value: 0, label: "Reflective (black mark)", command: "M" },
    { value: 2, label: "Continuous (no sensor)", command: "N" },
];

const RFID_READ_OPTIONS: Array<{ value: RfidReadBank; label: string }> = [
    { value: "EPC", label: "EPC" },
    { value: "TID", label: "TID" },
];

const HEAD_DPI_SGD_KEY = "head.resolution.in_dpi";
const MEDIA_WITH_HEAD_QUERY_KEYS = [
    HEAD_DPI_SGD_KEY,
    ...ZEBRA_MEDIA_QUERY_KEYS,
] as const;

interface Props {
    settings: LabelSettings;
    printerSettings: PrinterSettings;
    rfid?: RfidSettings;
    fullscreen?: boolean;
    onUpdateSettings: (
        patch: Partial<LabelSettings>,
        options?: { resizePolicy?: "scale" | "keep" },
    ) => void;
    onUpdatePrinterSettings: (patch: Partial<PrinterSettings>) => void;
    onUpdateRfid: (patch: Partial<RfidSettings>) => void;
}

function finite(value: number | undefined, fallback: number): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function intValue(value: number | undefined, fallback: number): number {
    return Math.round(finite(value, fallback));
}

function parseNumber(value: string, fallback: number): number {
    const parsed = Number(value.trim().replace(",", "."));
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDraftNumber(value: string): number | null {
    const normalized = value.trim().replace(",", ".");
    if (
        normalized === "" ||
        normalized === "-" ||
        normalized === "+" ||
        normalized === "." ||
        normalized === "-." ||
        normalized === "+."
    ) {
        return null;
    }
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function defaultReadStartBlock(bank: RfidReadBank): number {
    return bank === "TID" ? 0 : 2;
}

function sanitizeFieldName(value: string): string {
    const trimmed = value.trim().replace(/^\{|\}$/g, "");
    const cleaned = trimmed.replace(/[^A-Za-z0-9_]/g, "_");
    return /^[A-Za-z_]/.test(cleaned) ? cleaned : `rfid_${cleaned}`.replace(/_+$/g, "");
}

type PrinterParamItem = { label: string; value: string };

type PrinterParamState = {
    status: "idle" | "loading" | "ok" | "error";
    message: string;
    config: PrinterParamItem[];
};

type ConfigSendTarget =
    | "media"
    | "print"
    | "calibration"
    | "rfid"
    | "encode"
    | "rfidCalibration"
    | "rfidRestore";

type ConfigSendState = {
    target: ConfigSendTarget | null;
    status: "idle" | "loading" | "ok" | "error";
    message: string;
};

type ZebraRfidQueryResult = {
    values: Record<string, string>;
    failedKeys: string[];
};

const EMPTY_PARAM_STATE: PrinterParamState = {
    status: "idle",
    message: "No printer parameter read yet.",
    config: [],
};

const EMPTY_SEND_STATE: ConfigSendState = {
    target: null,
    status: "idle",
    message: "",
};

function cleanResponse(text: string): string {
    return text
        .replace(/\0/g, "")
        .replace(/[\x01-\x09\x0B\x0C\x0E-\x1F\x7F]/g, "")
        .replace(/\r/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function zplNumber(value: number): string {
    if (!Number.isFinite(value)) return "0";
    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded)
        ? String(rounded)
        : rounded.toFixed(2).replace(/\.?0+$/, "");
}

function commandForSensorMode(sensorMode: SensorMode): string {
    const tracking = SENSOR_OPTIONS.find((option) => option.value === sensorMode)?.command ?? "Y";
    return ["^XA", `^MN${tracking}`, "^XZ", "~JC"].join("\n");
}

function addParam(items: PrinterParamItem[], label: string, value: string | undefined): void {
    if (!value) return;
    items.push({ label, value });
}

function rfidSnapshotItems(snapshot: ZebraRfidPrinterSnapshot): PrinterParamItem[] {
    const items: PrinterParamItem[] = [];
    addParam(items, "State", snapshot.state.replaceAll("_", " "));
    addParam(
        items,
        "RFID enabled",
        snapshot.enabled === undefined ? "Unknown" : snapshot.enabled ? "On" : "Off",
    );
    addParam(items, "Reader", snapshot.readerModel ?? "Not reported");
    addParam(items, "Reader firmware", snapshot.readerFirmware);
    addParam(items, "Reader hardware", snapshot.readerHardware);
    addParam(items, "Program position", snapshot.programPosition ?? "Unavailable");
    addParam(
        items,
        "Read power",
        snapshot.readPower === undefined ? "Unavailable" : String(snapshot.readPower),
    );
    addParam(
        items,
        "Write power",
        snapshot.writePower === undefined ? "Unavailable" : String(snapshot.writePower),
    );
    addParam(items, "Antenna", snapshot.antenna ?? "Unavailable");
    addParam(items, "Adaptive", snapshot.adaptiveAntenna ?? "Unavailable");
    addParam(items, "Region", snapshot.region);
    addParam(items, "RFID status", snapshot.errorStatus);
    addParam(
        items,
        "Valid labels",
        snapshot.validCount === undefined ? undefined : String(snapshot.validCount),
    );
    addParam(
        items,
        "VOID labels",
        snapshot.voidCount === undefined ? undefined : String(snapshot.voidCount),
    );
    if (snapshot.unavailableKeys.length > 0) {
        addParam(items, "Unavailable keys", String(snapshot.unavailableKeys.length));
    }
    return items;
}

type ParsedPrinterIdentity = Pick<PrinterParamState, "config"> & {
    model?: string;
    firmware?: string;
    dotsPerMm?: number;
    dpi?: PrinterDpi;
};

function parsePrinterParams(raw: string): ParsedPrinterIdentity {
    const text = cleanResponse(raw);
    const line = text
        .split("\n")
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate.split(",").length >= 4);
    const config: PrinterParamItem[] = [];
    if (!line) return { config };

    const values = line.split(",").map((value) => value.trim());
    const model = values[0];
    const dotsPerMm = Number(values[2]);
    const dpi = inferPrinterDpiFromDotsPerMm(dotsPerMm);
    addParam(config, "Model", model);
    addParam(config, "Firmware", values[1]);
    addParam(
        config,
        "Resolution",
        Number.isFinite(dotsPerMm)
            ? `${dotsPerMm} dots/mm${dpi ? ` (${dpi} dpi)` : ""}`
            : undefined,
    );
    addParam(config, "Memory", values[3]);
    addParam(config, "Options", values.slice(4).filter(Boolean).join(", ") || undefined);
    return {
        config,
        model,
        firmware: values[1] || undefined,
        dotsPerMm: Number.isFinite(dotsPerMm) ? dotsPerMm : undefined,
        dpi,
    };
}

function parseMediaParams(
    raw: string,
    dpi: number,
    queryKeys: readonly string[] = ZEBRA_MEDIA_QUERY_KEYS,
): Partial<LabelSettings> {
    const values = parseZebraSgdMap(raw, queryKeys);
    const patch: Partial<LabelSettings> = {};
    const parseDotsToMm = (value: string | undefined): number | undefined => {
        const dots = Number(value);
        return Number.isFinite(dots) ? dotsToMm(dots, dpi) : undefined;
    };
    const widthMm = parseDotsToMm(values["ezpl.print_width"]);
    const heightMm = parseDotsToMm(values["zpl.label_length"]);
    if (widthMm !== undefined) patch.widthMm = clamp(widthMm, 10, 220);
    if (heightMm !== undefined) patch.heightMm = clamp(heightMm, 10, 300);

    const speed = Number(values["media.speed"]);
    if (Number.isFinite(speed)) patch.speed = clamp(speed, 1, 14);
    const darkness = Number(values["print.tone"]);
    if (Number.isFinite(darkness)) patch.darkness = clamp(darkness, 0, 30);

    const mediaType = (values["ezpl.media_type"] ?? "").toLowerCase();
    if (mediaType.includes("mark")) patch.sensorMode = 0;
    else if (mediaType.includes("gap") || mediaType.includes("notch")) patch.sensorMode = 1;
    else if (mediaType.includes("continuous")) patch.sensorMode = 2;
    const printMethod = (values["ezpl.print_method"] ?? "").toLowerCase();
    if (printMethod.includes("direct")) patch.printMode = "direct_thermal";
    else if (printMethod.includes("thermal")) patch.printMode = "thermal_transfer";
    return patch;
}

function printerDpiFromSgd(value: string | undefined): PrinterDpi | undefined {
    const dpi = Number(value);
    if (dpi === 200 || dpi === 203) return 203;
    if (dpi === 300) return 300;
    if (dpi === 600) return 600;
    return undefined;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function PrinterConfigPanel({
    settings,
    printerSettings,
    rfid,
    fullscreen = false,
    onUpdateSettings,
    onUpdatePrinterSettings,
    onUpdateRfid,
}: Props) {
    const serialSession = useSerialSession();
    const storedSensorMode = (settings.sensorMode ?? 1) as SensorMode;
    const sensorMode = storedSensorMode === 2 && settings.gapMm > 0 ? 1 : storedSensorMode;
    const [paramState, setParamState] = useState<PrinterParamState>(EMPTY_PARAM_STATE);
    const [sendState, setSendState] = useState<ConfigSendState>(EMPTY_SEND_STATE);
    const [mediaGetState, setMediaGetState] = useState<Omit<PrinterParamState, "config">>({
        status: "idle",
        message: "",
    });
    const [rfidGetState, setRfidGetState] = useState<Omit<PrinterParamState, "config">>({
        status: "idle",
        message: "",
    });
    const [rfidReadTestState, setRfidReadTestState] = useState<Omit<PrinterParamState, "config">>({
        status: "idle",
        message: "",
    });
    const [rfidSnapshot, setRfidSnapshot] = useState<ZebraRfidPrinterSnapshot | null>(null);
    const [rfidTestData, setRfidTestData] = useState(rfid?.data ?? "");

    useEffect(() => {
        // Keep the editable test value aligned when the active template changes.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRfidTestData(rfid?.data ?? "");
    }, [rfid?.data]);

    const readBank = (rfid?.readBank ?? "EPC") as RfidReadBank;
    const zebraModel = (settings.targetPrinterModel ?? rfid?.zebraModel ?? "auto") as ZebraRfidModel;
    const zebraProfile = zebraRfidModelOption(zebraModel);
    const zebraUsePrinterSettings = rfid?.zebraUsePrinterSettings !== false;
    const continuousRfidPolicy = !!rfid?.readEnabled || (!!rfid?.enabled && !!rfid?.captureToHost);
    const zebraPositionMode = (rfid?.zebraPositionMode ?? "calibrated") as ZebraRfidPositionMode;
    const programPositionMax = zebraPositionMode === "backward"
        ? 30
        : Math.min(999, Math.max(0, Math.floor(settings.heightMm)));
    const programPositionMm = Math.round(
        clamp(finite(rfid?.writePositionMm, 0), 0, programPositionMax),
    );
    const programPositionOptions = Array.from(
        { length: programPositionMax + 1 },
        (_, distance) => distance,
    );
    const zebraEpcReadMode = (rfid?.zebraEpcReadMode ?? "pc") as ZebraRfidEpcReadMode;
    const zebraReadPower = Math.round(clamp(finite(rfid?.zebraReadPower, -1), -1, 30));
    const zebraWritePower = Math.round(clamp(finite(rfid?.zebraWritePower, -1), -1, 30));
    const supportsMultipleRfidAntennas =
        zebraProfile.multiAntenna || zebraModel === "auto";
    const adaptiveAntennaAllowed =
        supportsMultipleRfidAntennas
        && settings.heightMm >= ZEBRA_ADAPTIVE_ANTENNA_MIN_LABEL_MM;
    const rfidSnapshotNeedsAttention =
        !!rfidSnapshot
        && rfidSnapshot.state !== "ready";
    const readStartBlock = intValue(
        rfid?.readStartBlock,
        defaultReadStartBlock(readBank),
    );
    const readLength = Math.round(clamp(intValue(rfid?.readLength, 24), 1, 124));
    const zebraReadByteCount = Math.round(
        clamp(intValue(rfid?.zebraReadByteCount, Math.max(1, Math.ceil(readLength / 2))), 1, 64),
    );
    const readFieldName = rfid?.readFieldName || "rfid_read";
    const transportCapabilities = printerTransportCapabilities(
        printerSettings.connectionMode,
    );
    const transportReady =
        printerSettings.connectionMode === "tcp"
            ? printerSettings.tcpHost.trim().length > 0
            : printerSettings.connectionMode === "windowsRaw"
                ? printerSettings.printerName.trim().length > 0
                : true;
    const transportSetupReason =
        printerSettings.connectionMode === "tcp"
            ? "Enter the Zebra IP/host in Target printer before using Printer Config."
            : printerSettings.connectionMode === "windowsRaw"
                ? "Select a USB-B Windows printer queue in Target printer before sending SET commands."
                : undefined;
    const getCommandNotice = !transportCapabilities.canGet
        ? transportCapabilities.reason
        : !transportReady
            ? transportSetupReason
            : undefined;
    const maxSpeed =
        maxPrintSpeedIps(
            settings.targetPrinterModel ?? zebraModel,
            settings.dpi,
        ) ?? 14;
    const tearOffDots = typeof printerSettings.tearOffDots === "number"
        ? normalizeZebraTearOffDots(printerSettings.tearOffDots)
        : undefined;
    const operationBusy =
        sendState.status === "loading" ||
        paramState.status === "loading" ||
        mediaGetState.status === "loading" ||
        rfidGetState.status === "loading" ||
        rfidReadTestState.status === "loading";
    const sharedSerialConnection =
        printerSettings.connectionMode === "webserial"
            ? serialSession.connection ?? undefined
            : undefined;

    const updateReadBank = (value: RfidReadBank) => {
        onUpdateRfid({
            readBank: value,
            readStartBlock: defaultReadStartBlock(value),
            readLength: value === "TID" ? 8 : 24,
            zebraReadByteCount: value === "TID" ? 4 : 12,
            zebraEpcReadMode: value === "EPC" ? zebraEpcReadMode : "fixed",
            readFieldName,
        });
    };

    const toggleReadRfid = (enabled: boolean) => {
        onUpdateRfid({
            readEnabled: enabled,
            readBank,
            readStartBlock,
            readLength,
            zebraReadByteCount,
            zebraEpcReadMode,
            readFieldName,
        });
    };

    const updateSettingNumber = (
        key: keyof Pick<
            LabelSettings,
            | "widthMm"
            | "heightMm"
            | "gapMm"
            | "speed"
            | "darkness"
        >,
        value: string,
        fallback: number,
        min: number,
        max: number,
        integer = false,
    ) => {
        const parsed = clamp(parseNumber(value, fallback), min, max);
        onUpdateSettings({ [key]: integer ? Math.round(parsed) : parsed } as Partial<LabelSettings>);
    };

    const sendConfigCommand = async (
        target: ConfigSendTarget,
        label: string,
        command: string,
    ) => {
        try {
            setSendState({
                target,
                status: "loading",
                message: `Sending ${label.toLowerCase()} through ${transportCapabilities.label}...`,
            });
            const result = await writePrinterBytes({
                settings: printerSettings,
                payload: encodeZpl(command),
                documentName: `ZbrePrinter ${label}`,
                language: "zpl",
                connection: sharedSerialConnection,
            });
            setSendState({
                target,
                status: "ok",
                message:
                    result.delivery === "queued"
                        ? `${label} queued - ${result.bytesWritten} bytes (printer application is not verified)`
                        : `${label} written - ${result.bytesWritten} bytes`,
            });
        } catch (error) {
            setSendState({
                target,
                status: "error",
                message: errorMessage(error),
            });
        }
    };

    const buildMediaConfigCommand = () => {
        const lines = [
            "^XA",
            `^PW${Math.max(2, mmToDots(settings.widthMm, settings.dpi))}`,
            `^LL${Math.max(1, mmToDots(settings.heightMm, settings.dpi))}`,
            `^MN${SENSOR_OPTIONS.find((option) => option.value === sensorMode)?.command ?? "Y"}`,
            settings.printMode === "direct_thermal" ? "^MTD" : "^MTT",
            "^XZ",
            "",
        ];
        if (tearOffDots !== undefined) {
            lines.unshift(buildZebraTearOffDotsCommand(tearOffDots));
        }
        return lines.join("\n");
    };

    const buildRfidConfigCommand = (): string => {
        if (!rfid) return "";
        return buildZebraRfidSgdConfigCommand(
            { ...rfid, zebraModel, enabled: true },
            { allowAdaptiveAntenna: adaptiveAntennaAllowed },
        );
    };

    const buildPrintConfigCommand = (): string => [
        "^XA",
        `^PR${Math.round(clamp(intValue(settings.speed, 4), 1, maxSpeed))}`,
        `~SD${String(Math.round(clamp(intValue(settings.darkness, 10), 0, 30))).padStart(2, "0")}`,
        "^XZ",
        "",
    ].join("\n");

    const buildPaperCalibrationCommand = (): string => commandForSensorMode(sensorMode);

    const buildRfidCalibrationCommand = (): string =>
        `! U1 setvar "rfid.tag.calibrate" "run"`;

    const buildRfidRestoreCommand = (): string =>
        `! U1 setvar "rfid.tag.calibrate" "restore"`;

    const buildRfidEncodeCommand = (): string => {
        const data = rfidTestData.trim();
        if (!rfid || !data) return "";
        const encodeSettings: RfidSettings = {
            ...rfid,
            zebraModel,
            enabled: true,
            data,
        };
        const lines = [
            "^XA",
            "^CI28",
            "^MMF",
            ...buildZebraRfidSetupLines(encodeSettings),
            buildZebraRfidWriteCommand(encodeSettings, data),
            "^PQ1",
            "^XZ",
            "",
        ];
        return lines.join("\n");
    };

    const sendTargetBusy = (target: ConfigSendTarget) =>
        sendState.status === "loading" && sendState.target === target;
    const configButtonDisabled = (target: ConfigSendTarget) =>
        sendTargetBusy(target) || operationBusy || !transportReady;
    const rfidTestValidation = rfid && rfid.format === "H" && rfidTestData.trim().length > 0
        ? validateRfidHexValue(
              rfidTestData,
              rfid.autoEpcBitsFromData
                  ? undefined
                  : (rfid.epcBits > 0 ? rfid.epcBits : rfid.words * 16),
          )
        : null;
    const canEncodeRfid = !!rfid
        && rfidTestData.trim().length > 0
        && (!rfidTestValidation || rfidTestValidation.valid);

    const readRfidValues = async (
        keys: readonly string[] = ZEBRA_RFID_QUERY_KEYS,
    ): Promise<ZebraRfidQueryResult> => {
        const values: Record<string, string> = {};
        const failedKeys: string[] = [];

        // Link-OS JSON returns values with their SGD names, avoiding the
        // positional ambiguity of a multiline response. Some older RF cards
        // omit JSON fields, so only missing fields fall back to U1 getvar.
        try {
            const result = await queryPrinterText({
                settings: printerSettings,
                text: buildZebraJsonGetCommand(keys),
                readWindowMs: 6000,
                readIdleMs: 1000,
                connection: sharedSerialConnection,
            });
            Object.assign(values, parseZebraJsonMap(result.response, keys));
        } catch {
            // The per-key fallback below also covers firmware without JSON SGD.
        }

        for (const key of keys) {
            if (Object.prototype.hasOwnProperty.call(values, key)) continue;
            try {
                const result = await queryPrinterText({
                    settings: printerSettings,
                    text: buildZebraSgdGetCommand([key]),
                    readWindowMs: 3000,
                    readIdleMs: 750,
                    connection: sharedSerialConnection,
                });
                const parsed = parseZebraSgdMap(result.response, [key]);
                if (Object.prototype.hasOwnProperty.call(parsed, key)) {
                    values[key] = parsed[key];
                } else {
                    failedKeys.push(key);
                }
            } catch {
                failedKeys.push(key);
            }
        }

        return { values, failedKeys };
    };

    const setRfidConfig = async () => {
        try {
            if (!rfid) throw new Error("RFID settings are unavailable.");
            const configSettings: RfidSettings = {
                ...rfid,
                zebraModel,
                enabled: true,
            };
            const configOptions = {
                allowAdaptiveAntenna: adaptiveAntennaAllowed,
            };
            const expected = zebraRfidSgdConfigValues(configSettings, configOptions);
            const command = buildZebraRfidSgdConfigCommand(configSettings, configOptions);
            if (!command.trim()) {
                throw new Error("Select at least one explicit printer RFID value before SET RFID.");
            }

            setSendState({
                target: "rfid",
                status: "loading",
                message: `Writing RFID config through ${transportCapabilities.label}...`,
            });
            const result = await writePrinterBytes({
                settings: printerSettings,
                payload: encodeZpl(command),
                documentName: "ZbrePrinter RFID config",
                language: "zpl",
                connection: sharedSerialConnection,
            });

            if (result.delivery === "queued" || !transportCapabilities.canGet) {
                setSendState({
                    target: "rfid",
                    status: "ok",
                    message: `RFID config queued - ${result.bytesWritten} bytes; read-back is unavailable on this transport.`,
                });
                return;
            }

            const readBack = await readRfidValues(Object.keys(expected));
            const mismatches = zebraRfidConfigMismatches(expected, readBack.values);
            const mergedValues = {
                ...(rfidSnapshot?.values ?? {}),
                ...readBack.values,
            };
            const nextSnapshot = zebraRfidSnapshotFromValues(mergedValues);
            setRfidSnapshot(nextSnapshot);
            if (Object.keys(nextSnapshot.patch).length > 0) {
                onUpdateRfid(nextSnapshot.patch);
            }
            if (mismatches.length > 0) {
                const details = mismatches
                    .slice(0, 3)
                    .map(({ key, expected: expectedValue, actual }) =>
                        `${key}: expected ${expectedValue}, got ${actual ?? "no response"}`,
                    )
                    .join("; ");
                throw new Error(
                    `RFID config was written but read-back did not match. ${details}`,
                );
            }
            setSendState({
                target: "rfid",
                status: "ok",
                message: `RFID config verified (${Object.keys(expected).length} setting(s)) - ${new Date().toLocaleTimeString()}`,
            });
        } catch (error) {
            setSendState({
                target: "rfid",
                status: "error",
                message: errorMessage(error),
            });
        }
    };

    const readPrinterParam = async () => {
        try {
            setParamState({
                status: "loading",
                message: `Reading printer identity through ${transportCapabilities.label}...`,
                config: [],
            });
            const result = await queryPrinterText({
                settings: printerSettings,
                text: "~HI",
                readWindowMs: 3500,
                connection: sharedSerialConnection,
            });
            const raw = result.response;
            const cleaned = cleanResponse(raw);
            if (!cleaned) throw new Error("Printer returned no data.");
            const parsed = parsePrinterParams(cleaned);
            const inferredModel = inferZebraRfidModel(parsed.model ?? "");
            const settingsPatch: Partial<LabelSettings> = {};
            if (parsed.dpi) settingsPatch.dpi = parsed.dpi;
            if (inferredModel !== "auto") {
                settingsPatch.targetPrinterModel = inferredModel;
                onUpdateRfid({ zebraModel: inferredModel });
            }
            const detectedMaxSpeed = maxPrintSpeedIps(
                inferredModel !== "auto"
                    ? inferredModel
                    : (settings.targetPrinterModel ?? zebraModel),
                parsed.dpi ?? settings.dpi,
            );
            if (detectedMaxSpeed !== undefined && settings.speed > detectedMaxSpeed) {
                settingsPatch.speed = detectedMaxSpeed;
            }
            if (Object.keys(settingsPatch).length > 0) onUpdateSettings(settingsPatch);
            setParamState({
                status: "ok",
                message: `Detected ${parsed.model ?? "Zebra printer"}${parsed.dpi ? ` at ${parsed.dpi} dpi` : ""} - ${new Date().toLocaleTimeString()}`,
                config: parsed.config,
            });
        } catch (error) {
            setParamState({
                status: "error",
                message: errorMessage(error),
                config: [],
            });
        }
    };

    const readMediaParam = async () => {
        try {
            setMediaGetState({
                status: "loading",
                message: `Detecting printhead, then reading media through ${transportCapabilities.label}...`,
            });
            const result = await queryPrinterText({
                settings: printerSettings,
                text: buildZebraSgdGetCommand(MEDIA_WITH_HEAD_QUERY_KEYS),
                readWindowMs: 5000,
                connection: sharedSerialConnection,
            });
            const raw = result.response;
            const cleaned = cleanResponse(raw);
            if (!cleaned) throw new Error("Printer returned no config data.");
            const values = parseZebraSgdMap(cleaned, MEDIA_WITH_HEAD_QUERY_KEYS);
            const detectedDpi = printerDpiFromSgd(values[HEAD_DPI_SGD_KEY]);
            const effectiveDpi = detectedDpi ?? settings.dpi ?? 203;
            const detectedTearOffDots = Number(values["ezpl.tear_off"]);
            if (Number.isFinite(detectedTearOffDots)) {
                onUpdatePrinterSettings({
                    tearOffDots: normalizeZebraTearOffDots(detectedTearOffDots),
                });
            }
            const mediaPatch = parseMediaParams(
                cleaned,
                effectiveDpi,
                MEDIA_WITH_HEAD_QUERY_KEYS,
            );
            if (Object.keys(mediaPatch).length === 0) {
                throw new Error("Response did not include Zebra media settings.");
            }
            const detectedMaxSpeed = maxPrintSpeedIps(
                settings.targetPrinterModel ?? zebraModel,
                effectiveDpi,
            );
            if (
                detectedMaxSpeed !== undefined &&
                mediaPatch.speed !== undefined &&
                mediaPatch.speed > detectedMaxSpeed
            ) {
                mediaPatch.speed = detectedMaxSpeed;
            }
            const geometryChanged =
                (mediaPatch.widthMm !== undefined && mediaPatch.widthMm !== settings.widthMm) ||
                (mediaPatch.heightMm !== undefined && mediaPatch.heightMm !== settings.heightMm);
            onUpdateSettings(
                {
                    ...mediaPatch,
                    dpi: effectiveDpi,
                },
                { resizePolicy: "keep" },
            );
            setMediaGetState({
                status: "ok",
                message: `${detectedDpi ? `Detected ${detectedDpi} dpi; ` : ""}media imported${geometryChanged ? "; objects kept at their physical size" : ""} - ${new Date().toLocaleTimeString()}`,
            });
        } catch (error) {
            setMediaGetState({
                status: "error",
                message: errorMessage(error),
            });
        }
    };

    const readRfidParam = async () => {
        try {
            setRfidGetState({
                status: "loading",
                message: `Reading keyed RFID settings through ${transportCapabilities.label}...`,
            });
            const { values, failedKeys } = await readRfidValues();
            if (Object.keys(values).length === 0) {
                throw new Error("Printer returned no keyed RFID data.");
            }
            const snapshot = zebraRfidSnapshotFromValues(values);
            setRfidSnapshot(snapshot);

            if (snapshot.state === "reader_unavailable") {
                throw new Error(
                    "The printer did not report a connected RFID reader. Check rfid.enable, the RFID option board, and reader firmware.",
                );
            }
            if (Object.keys(snapshot.patch).length > 0) {
                onUpdateRfid(snapshot.patch);
            }

            const failureSuffix = failedKeys.length > 0
                ? `; ${failedKeys.length} key(s) did not respond`
                : "";
            const stateMessage = snapshot.state === "ready"
                ? "RFID reader and calibrated tuning imported"
                : snapshot.state === "partial"
                    ? "RFID reader detected; only part of the tuning was available"
                    : snapshot.state === "disabled"
                        ? "RFID is disabled in the printer"
                        : "RFID reader detected, but tuning is unconfigured; run RFID CALIBRATION";
            setRfidGetState({
                status: "ok",
                message: `${stateMessage}${failureSuffix} - ${new Date().toLocaleTimeString()}`,
            });
        } catch (error) {
            setRfidGetState({
                status: "error",
                message: errorMessage(error),
            });
        }
    };

    const readRfidTag = async () => {
        try {
            if (!rfid) throw new Error("RFID settings are unavailable.");
            setRfidReadTestState({ status: "loading", message: `Reading ${readBank}...` });
            const readSettings: RfidSettings = {
                ...rfid,
                readEnabled: true,
                readBank,
                readStartBlock,
                readLength: zebraReadByteCount * 2,
                zebraReadByteCount,
                zebraEpcReadMode,
            };
            const command = buildZebraRfidHostReadCommand(readSettings);
            const result = await queryPrinterText({
                settings: printerSettings,
                text: command,
                readWindowMs: 5000,
                readIdleMs: 750,
                connection: sharedSerialConnection,
            });
            const raw = result.response;
            const data = parseZebraRfidHostReadData(raw);
            if (!data) throw new Error(`Printer did not return ${readBank} data.`);
            const fixedLength = readBank === "TID" || zebraEpcReadMode === "fixed";
            const expectedHexChars = zebraReadByteCount * 2;
            if (fixedLength && data.length !== expectedHexChars) {
                throw new Error(
                    `Expected ${expectedHexChars} HEX characters, received ${data.length}.`,
                );
            }
            setRfidReadTestState({ status: "ok", message: data });
        } catch (error) {
            setRfidReadTestState({ status: "error", message: errorMessage(error) });
        }
    };

    return (
        <div
            className={cn(
                "h-full min-h-0 overflow-auto overscroll-contain bg-background px-3 py-3 text-foreground [color-scheme:light] dark:[color-scheme:dark] lg:overflow-hidden",
                fullscreen && "px-4 py-4",
            )}
            data-testid="printer-config-panel"
        >
            <div className="grid min-h-0 gap-3 lg:h-full lg:grid-cols-3">
                <ConfigCard
                    icon={<Printer className="h-4 w-4" />}
                    title="Media & Print"
                    caption="Label geometry, speed and calibration"
                >
                    <GetCommandNotice message={getCommandNotice} />
                    <SectionLabel>Media</SectionLabel>
                    <div className="grid grid-cols-2 gap-2">
                        <NumberField
                            label="Width mm"
                            value={settings.widthMm}
                            min={10}
                            max={220}
                            step={0.1}
                            onChange={(value) =>
                                updateSettingNumber("widthMm", value, settings.widthMm, 10, 220)
                            }
                        />
                        <NumberField
                            label="Length mm"
                            value={settings.heightMm}
                            min={10}
                            max={300}
                            step={0.1}
                            onChange={(value) =>
                                updateSettingNumber("heightMm", value, settings.heightMm, 10, 300)
                            }
                        />
                        <NumberField
                            label="Gap mm"
                            value={settings.gapMm}
                            min={0}
                            max={30}
                            step={0.1}
                            onChange={(value) =>
                                updateSettingNumber("gapMm", value, settings.gapMm, 0, 30)
                            }
                        />
                        <NumberField
                            label="Tear-off (dots)"
                            value={tearOffDots ?? 0}
                            min={-ZEBRA_TEAR_OFF_DOTS_LIMIT}
                            max={ZEBRA_TEAR_OFF_DOTS_LIMIT}
                            step={1}
                            onChange={(value) =>
                                onUpdatePrinterSettings({
                                    tearOffDots: normalizeZebraTearOffDots(
                                        parseNumber(value, tearOffDots ?? 0),
                                    ),
                                })
                            }
                        />
                    </div>
                    <div className="rounded-md border border-border bg-muted/30 px-2.5 py-2">
                        <div className="flex items-center justify-between gap-3">
                            <div className="min-w-0">
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                    Override in print jobs
                                </p>
                                <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                                    {tearOffDots === undefined
                                        ? "GET MEDIA or enter a dot value first. SET MEDIA will preserve the current printer Tear-off until then."
                                        : `${tearOffDots} dots ≈ ${zplNumber(dotsToMm(tearOffDots, settings.dpi))} mm at ${settings.dpi} dpi. ~TA persists in the printer after the job.`}
                                </p>
                            </div>
                            <Switch
                                checked={
                                    printerSettings.embedTearOffInJobs
                                    && tearOffDots !== undefined
                                }
                                disabled={tearOffDots === undefined}
                                onCheckedChange={(embedTearOffInJobs) =>
                                    onUpdatePrinterSettings({ embedTearOffInJobs })
                                }
                            />
                        </div>
                    </div>
                    <SelectField
                        label="Print method"
                        value={settings.printMode ?? "thermal_transfer"}
                        onValueChange={(value) =>
                            onUpdateSettings({
                                printMode: value as NonNullable<LabelSettings["printMode"]>,
                            })
                        }
                    >
                        <SelectItem value="thermal_transfer">Thermal transfer</SelectItem>
                        <SelectItem value="direct_thermal">Direct thermal</SelectItem>
                    </SelectField>
                    <p className="text-[10px] leading-snug text-muted-foreground">
                        Gap is template pitch. The printer learns the physical gap or mark during media calibration.
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={readMediaParam}
                            disabled={
                                operationBusy ||
                                !transportReady ||
                                !transportCapabilities.canGet
                            }
                            title={transportCapabilities.canGet ? undefined : transportCapabilities.reason}
                            className="h-8 justify-center"
                        >
                            <RefreshCw
                                className={cn(
                                    "h-3.5 w-3.5",
                                    mediaGetState.status === "loading" && "animate-spin",
                                )}
                            />
                            {mediaGetState.status === "loading" ? "Reading..." : "GET MEDIA"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                                sendConfigCommand("media", "Media config", buildMediaConfigCommand())
                            }
                            disabled={configButtonDisabled("media")}
                            className="h-8 justify-center"
                        >
                            <Send className="h-3.5 w-3.5" />
                            {sendTargetBusy("media") ? "Sending..." : "SET MEDIA"}
                        </Button>
                    </div>
                    <p
                        className={cn(
                            "text-[11px]",
                            mediaGetState.status === "error"
                                ? "text-red-600 dark:text-red-300"
                                : mediaGetState.status === "ok"
                                    ? "text-emerald-700 dark:text-emerald-400"
                                    : "text-muted-foreground",
                        )}
                    >
                        {mediaGetState.message}
                    </p>
                    <SendStatus state={sendState} target="media" />
                    <div className="space-y-3 border-t border-border pt-3">
                    <SectionLabel>Print</SectionLabel>
                    <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
                        <NumberField
                            label="Speed"
                            value={settings.speed}
                            min={1}
                            max={maxSpeed}
                            step={1}
                            onChange={(value) =>
                                updateSettingNumber("speed", value, settings.speed, 1, maxSpeed, true)
                            }
                        />
                        <NumberField
                            label="Darkness"
                            value={settings.darkness}
                            min={0}
                            max={30}
                            step={1}
                            onChange={(value) =>
                                updateSettingNumber(
                                    "darkness",
                                    value,
                                    settings.darkness,
                                    0,
                                    30,
                                    true,
                                )
                            }
                        />
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                                sendConfigCommand("print", "Print config", buildPrintConfigCommand())
                            }
                            disabled={configButtonDisabled("print")}
                            className="h-9 px-4 font-semibold"
                        >
                            <Send className="h-3.5 w-3.5" />
                            {sendTargetBusy("print") ? "..." : "SET"}
                        </Button>
                    </div>
                    <SendStatus state={sendState} target="print" />
                    <SelectField
                        label="Sensor"
                        value={String(sensorMode)}
                        onValueChange={(value) => {
                            const nextSensorMode = Number(value) as SensorMode;
                            onUpdateSettings({
                                sensorMode: nextSensorMode,
                                ...(nextSensorMode === 2 ? { gapMm: 0 } : {}),
                            });
                        }}
                    >
                        {SENSOR_OPTIONS.map((option) => (
                            <SelectItem key={option.value} value={String(option.value)}>
                                {option.label}
                            </SelectItem>
                        ))}
                    </SelectField>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() =>
                            sendConfigCommand(
                                "calibration",
                                "Paper calibration",
                                buildPaperCalibrationCommand(),
                            )
                        }
                        disabled={configButtonDisabled("calibration")}
                        className="h-8 w-full justify-center"
                    >
                        <Send className="h-3.5 w-3.5" />
                        {sendTargetBusy("calibration") ? "Sending..." : "PAPER CALIBRATION"}
                    </Button>
                    <SendStatus state={sendState} target="calibration" />
                    </div>
                </ConfigCard>

                <ConfigCard
                    icon={<Cpu className="h-4 w-4" />}
                    title="Zebra RFID"
                    caption="Link-OS read, write and calibration"
                >
                    <GetCommandNotice message={getCommandNotice} />
                    <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                            <SectionLabel>Override printer RFID tuning in jobs</SectionLabel>
                            <p className="mt-1 text-[10px] leading-snug text-muted-foreground">
                                Off: use printer calibration. On: use template position, power and antenna.
                            </p>
                        </div>
                        <Switch
                            className="mt-0.5 shrink-0"
                            checked={!zebraUsePrinterSettings}
                            onCheckedChange={(checked) =>
                                onUpdateRfid({
                                    zebraUsePrinterSettings: !checked,
                                    ...(checked && !rfid?.zebraErrorHandling
                                        ? { zebraErrorHandling: "P" as const }
                                        : {}),
                                })
                            }
                        />
                    </div>

                    <SelectField
                        label="Program position"
                        value={zebraPositionMode}
                        onValueChange={(value) =>
                            onUpdateRfid({
                                zebraPositionMode: value as ZebraRfidPositionMode,
                                writePositionMm: Math.min(
                                    value === "backward"
                                        ? 30
                                        : Math.min(999, Math.max(0, Math.floor(settings.heightMm))),
                                    Math.max(0, Math.round(finite(rfid?.writePositionMm, 0))),
                                ),
                            })
                        }
                    >
                        <SelectItem value="calibrated">Printer calibrated</SelectItem>
                        <SelectItem value="forward">Forward (F)</SelectItem>
                        <SelectItem value="backward">Backward (B)</SelectItem>
                    </SelectField>
                    {zebraPositionMode !== "calibrated" && (
                        <SelectField
                            label="Position"
                            value={String(programPositionMm)}
                            onValueChange={(value) =>
                                onUpdateRfid({ writePositionMm: Number(value) })
                            }
                        >
                            {programPositionOptions.map((distance) => (
                                <SelectItem key={distance} value={String(distance)}>
                                    {zebraPositionMode === "forward" ? "F" : "B"}{distance} · {distance} mm
                                </SelectItem>
                            ))}
                        </SelectField>
                    )}
                    <p className="text-[10px] leading-snug text-muted-foreground">
                        Power -1: use printer calibration.
                    </p>

                    <div className="grid grid-cols-2 gap-2">
                        <NumberField
                            label="Read power"
                            value={zebraReadPower}
                            min={-1}
                            max={30}
                            step={1}
                            onChange={(value) =>
                                onUpdateRfid({
                                    zebraReadPower: Math.round(
                                        clamp(parseNumber(value, -1), -1, 30),
                                    ),
                                })
                            }
                        />
                        <NumberField
                            label="Write power"
                            value={zebraWritePower}
                            min={-1}
                            max={30}
                            step={1}
                            onChange={(value) =>
                                onUpdateRfid({
                                    zebraWritePower: Math.round(
                                        clamp(parseNumber(value, -1), -1, 30),
                                    ),
                                })
                            }
                        />
                    </div>

                    <div className="space-y-2 rounded-md border border-border bg-muted/20 px-2.5 py-2">
                        <div>
                            <SectionLabel>RFID failure handling</SectionLabel>
                        </div>
                        {continuousRfidPolicy ? <p className="text-xs font-medium" data-testid="rfid-effective-failure-policy">1 label per format · Continue after VOID</p> : <div className="grid grid-cols-2 gap-2">
                            <NumberField
                                label="Labels to try"
                                value={intValue(rfid?.retries, 3)}
                                min={1}
                                max={10}
                                step={1}
                                onChange={(value) =>
                                    onUpdateRfid({
                                        retries: Math.round(clamp(parseNumber(value, 3), 1, 10)),
                                    })
                                }
                            />
                            <SelectField
                                label="After attempts"
                                value={(rfid?.zebraErrorHandling ?? "P") as ZebraRfidErrorHandling}
                                onValueChange={(value) =>
                                    onUpdateRfid({
                                        zebraErrorHandling: value as ZebraRfidErrorHandling,
                                    })
                                }
                            >
                                <SelectItem value="N">No action / drop</SelectItem>
                                <SelectItem value="P">Pause / retain</SelectItem>
                                <SelectItem value="E">Error / retain</SelectItem>
                            </SelectField>
                        </div>}
                    </div>

                    {supportsMultipleRfidAntennas && (
                        <div className="space-y-2">
                            <SelectField
                                label="Antenna element"
                                value={rfid?.zebraAntenna ?? "printer"}
                                onValueChange={(value) =>
                                    onUpdateRfid({
                                        zebraAntenna: value === "printer" ? undefined : value,
                                    })
                                }
                            >
                                <SelectItem value="printer">Printer calibrated</SelectItem>
                                {ZEBRA_ANTENNAS.map((antenna) => (
                                    <SelectItem key={antenna} value={antenna}>
                                        {antenna}
                                    </SelectItem>
                                ))}
                            </SelectField>
                            <div className="flex items-center justify-between rounded-md border border-border px-2.5 py-2">
                                <div>
                                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                        Adaptive antenna
                                    </p>
                                    <p className="text-[10px] leading-snug text-muted-foreground">
                                        Minimum label length: {ZEBRA_ADAPTIVE_ANTENNA_MIN_LABEL_MM} mm.
                                    </p>
                                </div>
                                <Switch
                                    checked={
                                        adaptiveAntennaAllowed
                                        && rfid?.zebraAdaptiveAntenna === true
                                    }
                                    disabled={!adaptiveAntennaAllowed}
                                    title={
                                        adaptiveAntennaAllowed
                                            ? undefined
                                            : `Requires a label length of at least ${ZEBRA_ADAPTIVE_ANTENNA_MIN_LABEL_MM} mm.`
                                    }
                                    onCheckedChange={(zebraAdaptiveAntenna) =>
                                        onUpdateRfid({ zebraAdaptiveAntenna })
                                    }
                                />
                            </div>
                            {!adaptiveAntennaAllowed && (
                                <p className="text-[10px] leading-snug text-amber-700 dark:text-amber-300">
                                    Label length {zplNumber(settings.heightMm)} mm is below the {ZEBRA_ADAPTIVE_ANTENNA_MIN_LABEL_MM} mm minimum.
                                </p>
                            )}
                        </div>
                    )}

                    <div className="grid grid-cols-2 gap-2">
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={readRfidParam}
                            disabled={
                                operationBusy ||
                                !transportReady ||
                                !transportCapabilities.canGet
                            }
                            title={transportCapabilities.canGet ? undefined : transportCapabilities.reason}
                            className="h-8 justify-center"
                        >
                            <RefreshCw
                                className={cn(
                                    "h-3.5 w-3.5",
                                    rfidGetState.status === "loading" && "animate-spin",
                                )}
                            />
                            {rfidGetState.status === "loading" ? "Reading..." : "GET RFID"}
                        </Button>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={setRfidConfig}
                            disabled={
                                configButtonDisabled("rfid") ||
                                buildRfidConfigCommand().trim().length === 0
                            }
                            className="h-8 justify-center"
                        >
                            <Send className="h-3.5 w-3.5" />
                            {sendTargetBusy("rfid") ? "Sending..." : "SET RFID"}
                        </Button>
                    </div>
                    <p
                        className={cn(
                            "text-[11px]",
                            rfidGetState.status === "error"
                                ? "text-red-600 dark:text-red-300"
                                : rfidGetState.status === "ok"
                                    ? rfidSnapshotNeedsAttention
                                        ? "text-amber-700 dark:text-amber-300"
                                        : "text-emerald-700 dark:text-emerald-400"
                                    : "text-muted-foreground",
                        )}
                    >
                        {rfidGetState.message}
                    </p>
                    <SendStatus state={sendState} target="rfid" />
                    {rfidSnapshot && (
                        <ParamGroup
                            title="Printer RFID snapshot"
                            items={rfidSnapshotItems(rfidSnapshot)}
                            empty="No RFID snapshot values."
                        />
                    )}

                    <div className="space-y-2 border-t border-border pt-3">
                        <div className="flex items-center justify-between gap-2">
                            <SectionLabel>Read RFID</SectionLabel>
                            <Switch
                                checked={!!rfid?.readEnabled}
                                onCheckedChange={toggleReadRfid}
                            />
                        </div>
                        {rfid?.readEnabled && <label className="flex items-start gap-2 text-xs">
                            <input type="checkbox" checked={!!rfid.captureToHost} disabled={operationBusy}
                                onChange={(event) => onUpdateRfid({ captureToHost: event.target.checked })} />
                            <span>Lưu dữ liệu / xuất CSV</span>
                        </label>}
                        {rfid?.readEnabled && (
                            <div className="space-y-2">
                                <div className="grid grid-cols-2 gap-2">
                                    <SelectField
                                        label="Bank"
                                        value={readBank}
                                        onValueChange={(value) =>
                                            updateReadBank(value as RfidReadBank)
                                        }
                                    >
                                        {RFID_READ_OPTIONS.map((option) => (
                                            <SelectItem key={option.value} value={option.value}>
                                                {option.label}
                                            </SelectItem>
                                        ))}
                                    </SelectField>
                                    {readBank === "EPC" && (
                                        <SelectField
                                            label="EPC length"
                                            value={zebraEpcReadMode}
                                            onValueChange={(value) => {
                                                const mode = value as ZebraRfidEpcReadMode;
                                                onUpdateRfid({
                                                    zebraEpcReadMode: mode,
                                                    ...(mode === "fixed"
                                                        ? {
                                                              readStartBlock,
                                                              zebraReadByteCount,
                                                              readLength: zebraReadByteCount * 2,
                                                          }
                                                        : {}),
                                                });
                                            }}
                                        >
                                            <SelectItem value="pc">From PC bits</SelectItem>
                                            <SelectItem value="fixed">Fixed range</SelectItem>
                                        </SelectField>
                                    )}
                                </div>
                                {(readBank === "TID" || zebraEpcReadMode === "fixed") && (
                                    <div className="grid grid-cols-2 gap-2">
                                        <NumberField
                                            label="Start word"
                                            value={readStartBlock}
                                            min={0}
                                            max={255}
                                            step={1}
                                            onChange={(value) =>
                                                onUpdateRfid({
                                                    readStartBlock: Math.round(
                                                        clamp(
                                                            parseNumber(
                                                                value,
                                                                defaultReadStartBlock(readBank),
                                                            ),
                                                            0,
                                                            255,
                                                        ),
                                                    ),
                                                })
                                            }
                                        />
                                        <NumberField
                                            label="Read bytes"
                                            value={zebraReadByteCount}
                                            min={1}
                                            max={64}
                                            step={1}
                                            onChange={(value) => {
                                                const bytes = Math.round(
                                                    clamp(parseNumber(value, 12), 1, 64),
                                                );
                                                onUpdateRfid({
                                                    zebraReadByteCount: bytes,
                                                    readLength: bytes * 2,
                                                });
                                            }}
                                        />
                                    </div>
                                )}
                                {readBank === "EPC" && zebraEpcReadMode === "fixed" && (
                                    <p className="rounded bg-muted/50 px-2 py-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                                        {zebraReadByteCount * 2} HEX chars = {zebraReadByteCount} bytes · {" "}
                                        <code>^RFR,H,{readStartBlock},{zebraReadByteCount},1</code>
                                    </p>
                                )}
                                <div className="space-y-1">
                                    <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                                        Template field
                                    </Label>
                                    <Input
                                        value={readFieldName}
                                        onChange={(event) =>
                                            onUpdateRfid({
                                                readFieldName: sanitizeFieldName(event.target.value),
                                            })
                                        }
                                        className="h-9 bg-muted/60 font-mono text-sm text-foreground ring-border dark:bg-muted/60"
                                    />
                                </div>
                                <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={readRfidTag}
                                    disabled={
                                        operationBusy ||
                                        !transportReady ||
                                        !transportCapabilities.canGet
                                    }
                                    title={transportCapabilities.canGet ? undefined : transportCapabilities.reason}
                                    className="h-8 w-full justify-center"
                                >
                                    <RefreshCw
                                        className={cn(
                                            "h-3.5 w-3.5",
                                            rfidReadTestState.status === "loading" && "animate-spin",
                                        )}
                                    />
                                    {rfidReadTestState.status === "loading"
                                        ? "Reading tag..."
                                        : `READ ${readBank}`}
                                </Button>
                                <p
                                    className={cn(
                                        "break-all font-mono text-[11px]",
                                        rfidReadTestState.status === "error"
                                            ? "text-red-600 dark:text-red-300"
                                            : rfidReadTestState.status === "ok"
                                                ? "text-emerald-700 dark:text-emerald-400"
                                                : "text-muted-foreground",
                                    )}
                                >
                                    {rfidReadTestState.message}
                                </p>
                            </div>
                        )}
                    </div>

                    <div className="space-y-2 border-t border-border pt-3">
                        <SectionLabel>Write RFID</SectionLabel>
                        <div className="grid grid-cols-[1fr_auto] gap-2">
                            <Input
                                value={rfidTestData}
                                onChange={(event) => setRfidTestData(event.target.value)}
                                placeholder="EPC/Data"
                                className="h-9 bg-muted/60 font-mono text-sm text-foreground ring-border dark:bg-muted/60"
                            />
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                disabled={!canEncodeRfid || configButtonDisabled("encode")}
                                className="h-9 px-3 font-semibold"
                                onClick={() =>
                                    sendConfigCommand(
                                        "encode",
                                        "RFID encode",
                                        buildRfidEncodeCommand(),
                                    )
                                }
                            >
                                {sendTargetBusy("encode") ? "Sending..." : "ENCODE"}
                            </Button>
                        </div>
                        {rfidTestValidation && (
                            <p
                                className={cn(
                                    "text-[10px] leading-snug",
                                    rfidTestValidation.valid
                                        ? "text-emerald-700 dark:text-emerald-400"
                                        : "text-red-700 dark:text-red-400",
                                )}
                            >
                                {rfidTestValidation.valid
                                    ? `${rfidTestValidation.normalized.length} HEX chars ready to encode`
                                    : `${rfidTestValidation.reason}. Nothing will be sent.`}
                            </p>
                        )}
                        <SendStatus state={sendState} target="encode" />
                    </div>

                    <div className="space-y-2 border-t border-border pt-3">
                        <SectionLabel>RFID calibration</SectionLabel>
                        <div className="grid grid-cols-2 gap-2">
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                    sendConfigCommand(
                                        "rfidCalibration",
                                        "RFID calibration",
                                        buildRfidCalibrationCommand(),
                                    )
                                }
                                disabled={configButtonDisabled("rfidCalibration")}
                                className="h-8 justify-center"
                                title="Calibrate RFID tag position, antenna and read/write power for the loaded media"
                            >
                                <Send className="h-3.5 w-3.5" />
                                {sendTargetBusy("rfidCalibration") ? "Sending..." : "CALIBRATE"}
                            </Button>
                            <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                    sendConfigCommand(
                                        "rfidRestore",
                                        "RFID default position",
                                        buildRfidRestoreCommand(),
                                    )
                                }
                                disabled={configButtonDisabled("rfidRestore")}
                                className="h-8 justify-center"
                                title="Restore only the printer's default RFID programming position"
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                                {sendTargetBusy("rfidRestore") ? "Sending..." : "RESET POSITION"}
                            </Button>
                        </div>
                        <p className="text-[10px] leading-snug text-muted-foreground">
                            After changing media: run Paper Calibration, then RFID CALIBRATE.
                        </p>
                        <SendStatus state={sendState} target="rfidCalibration" />
                        <SendStatus state={sendState} target="rfidRestore" />
                    </div>
                </ConfigCard>

                <ConfigCard
                    icon={<FileCode2 className="h-4 w-4" />}
                    title="Printer Param"
                    caption="Read current printer configuration"
                >
                    <GetCommandNotice message={getCommandNotice} />
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={readPrinterParam}
                        disabled={
                            operationBusy ||
                            !transportReady ||
                            !transportCapabilities.canGet
                        }
                        title={transportCapabilities.canGet ? undefined : transportCapabilities.reason}
                        className="h-8 w-full justify-center"
                    >
                        <RefreshCw
                            className={cn(
                                "h-3.5 w-3.5",
                                paramState.status === "loading" && "animate-spin",
                            )}
                        />
                        Read printer param
                    </Button>
                    <p
                        className={cn(
                            "text-[11px]",
                            paramState.status === "error"
                                ? "text-red-600 dark:text-red-300"
                                : "text-muted-foreground",
                        )}
                    >
                        {paramState.message}
                    </p>
                    <div className="min-h-0 flex-1 space-y-3">
                        <ParamGroup
                            title="Config"
                            items={paramState.config}
                            empty="No config response yet."
                        />
                    </div>
                </ConfigCard>
            </div>
        </div>
    );
}

function GetCommandNotice({ message }: { message?: string }) {
    if (!message) return null;
    return (
        <p
            className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[10px] leading-snug text-amber-700 dark:text-amber-300"
            role="status"
        >
            {message}
        </p>
    );
}

function ConfigCard({
    icon,
    title,
    caption,
    children,
}: {
    icon: ReactNode;
    title: string;
    caption: string;
    children: ReactNode;
}) {
    return (
        <section className="flex min-h-0 flex-col gap-3 rounded-[8px] border border-border bg-card p-3 text-card-foreground shadow-sm lg:h-full lg:overflow-hidden">
            <div className="flex shrink-0 items-start gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-muted text-muted-foreground">
                    {icon}
                </div>
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3 lg:overflow-x-hidden lg:overflow-y-auto lg:overscroll-contain lg:pb-2 lg:pr-2 lg:pt-0.5 lg:[scrollbar-gutter:stable] lg:[&>*]:shrink-0">
                {children}
            </div>
        </section>
    );
}

function SectionLabel({ children }: { children: ReactNode }) {
    return (
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {children}
        </div>
    );
}

function NumberField({
    label,
    value,
    min,
    max,
    step,
    disabled = false,
    onChange,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    disabled?: boolean;
    onChange: (value: string) => void;
}) {
    const formatValue = (next: number) => (Number.isFinite(next) ? zplNumber(next) : "");
    const [draft, setDraft] = useState(formatValue(value));
    const [focused, setFocused] = useState(false);

    useEffect(() => {
        // External setting changes should refresh an input that is not being edited.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (!focused) setDraft(formatValue(value));
    }, [focused, value]);

    const commit = (raw: string) => {
        const parsed = parseDraftNumber(raw);
        if (parsed === null) {
            setDraft(formatValue(value));
            return;
        }
        const clamped = clamp(parsed, min, max);
        const stepped = Number.isInteger(step) ? Math.round(clamped) : clamped;
        const next = formatValue(stepped);
        setDraft(next);
        onChange(next);
    };

    return (
        <div className="space-y-1">
            <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
            </Label>
            <Input
                type="text"
                inputMode={step < 1 || min < 0 ? "decimal" : "numeric"}
                value={draft}
                disabled={disabled}
                onFocus={() => setFocused(true)}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={(e) => {
                    setFocused(false);
                    commit(e.target.value);
                }}
                onKeyDown={(e) => {
                    if (e.key === "Enter") {
                        e.currentTarget.blur();
                    } else if (e.key === "Escape") {
                        setDraft(formatValue(value));
                        e.currentTarget.blur();
                    }
                }}
                className="h-9 bg-muted/60 font-mono text-sm text-foreground ring-border dark:bg-muted/60"
                title={`${label}: ${min} to ${max}`}
            />
        </div>
    );
}

function SelectField({
    label,
    value,
    disabled = false,
    onValueChange,
    children,
}: {
    label: string;
    value: string;
    disabled?: boolean;
    onValueChange: (value: string) => void;
    children: ReactNode;
}) {
    return (
        <div className="space-y-1">
            <Label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {label}
            </Label>
            <Select value={value} disabled={disabled} onValueChange={onValueChange}>
                <SelectTrigger className="h-9 bg-muted/60 text-foreground ring-border dark:bg-muted/60">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>{children}</SelectContent>
            </Select>
        </div>
    );
}

function SendStatus({
    state,
    target,
}: {
    state: ConfigSendState;
    target: ConfigSendTarget;
}) {
    if (state.target !== target || state.status === "idle" || !state.message) return null;
    return (
        <p
            className={cn(
                "text-[11px]",
                state.status === "error"
                    ? "text-red-600 dark:text-red-300"
                    : state.status === "ok"
                        ? "text-emerald-700 dark:text-emerald-400"
                        : "text-muted-foreground",
            )}
        >
            {state.message}
        </p>
    );
}

function ParamGroup({
    title,
    items,
    empty,
}: {
    title: string;
    items: PrinterParamItem[];
    empty: string;
}) {
    return (
        <div className="space-y-2">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {title}
            </div>
            {items.length === 0 ? (
                <div className="rounded-[6px] bg-muted/50 px-3 py-2 text-[11px] text-muted-foreground">
                    {empty}
                </div>
            ) : (
                <div className="grid grid-cols-2 gap-1.5">
                    {items.map((item) => (
                        <div
                            key={`${title}-${item.label}`}
                            className="min-w-0 rounded-[6px] bg-muted/50 px-2 py-1.5"
                        >
                            <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                                {item.label}
                            </div>
                            <div className="truncate font-mono text-xs text-foreground">
                                {item.value}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
