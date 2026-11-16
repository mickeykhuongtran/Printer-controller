import type { PrinterDpi, ZebraRfidModel } from "./types";
import { mmToDots } from "./units";

export type ZebraPrinterModelProfile = {
    id: ZebraRfidModel;
    label: string;
    family: string;
    rfid: boolean;
    supportedDpis: readonly PrinterDpi[];
    defaultDpi: PrinterDpi;
    maxPrintWidthMmByDpi: Partial<Record<PrinterDpi, number>>;
    maxSpeedIpsByDpi: Partial<Record<PrinterDpi, number>>;
    note?: string;
};

// One catalog drives both the model selector and DPI validation. Physical
// limits below follow Zebra's published specifications; generic Link-OS
// profiles remain permissive for models that are not listed explicitly.
export const ZEBRA_PRINTER_MODELS: readonly ZebraPrinterModelProfile[] = [
    {
        id: "auto",
        label: "Auto / Other",
        family: "Zebra Link-OS",
        rfid: true,
        supportedDpis: [203, 300, 600],
        defaultDpi: 300,
        maxPrintWidthMmByDpi: {},
        maxSpeedIpsByDpi: {},
        note: "Select the installed printhead resolution or detect it through COM/TCP.",
    },
    {
        id: "zd611r",
        label: "ZD611R",
        family: "ZD600 RFID",
        rfid: true,
        supportedDpis: [203, 300],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 56, 300: 54 },
        maxSpeedIpsByDpi: { 203: 8, 300: 6 },
    },
    {
        id: "zd621r",
        label: "ZD621R",
        family: "ZD600 RFID",
        rfid: true,
        supportedDpis: [203, 300],
        defaultDpi: 300,
        maxPrintWidthMmByDpi: { 203: 104, 300: 108 },
        maxSpeedIpsByDpi: { 203: 8, 300: 6 },
    },
    {
        id: "zd500r",
        label: "ZD500R",
        family: "ZD500 RFID",
        rfid: true,
        supportedDpis: [203, 300],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 104, 300: 104 },
        maxSpeedIpsByDpi: { 203: 6, 300: 4 },
    },
    {
        id: "zd421r",
        label: "ZD421R",
        family: "ZD400 RFID",
        rfid: true,
        supportedDpis: [203, 300],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 104, 300: 104 },
        maxSpeedIpsByDpi: { 203: 6, 300: 4 },
    },
    {
        id: "zt231r",
        label: "ZT231R",
        family: "ZT200 RFID",
        rfid: true,
        supportedDpis: [203, 300],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 104, 300: 104 },
        maxSpeedIpsByDpi: { 203: 12, 300: 8 },
    },
    {
        id: "zt411r",
        label: "ZT411R",
        family: "ZT400 RFID",
        rfid: true,
        supportedDpis: [203, 300, 600],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 104, 300: 104, 600: 104 },
        maxSpeedIpsByDpi: { 203: 14, 300: 10, 600: 4 },
    },
    {
        id: "zt421r",
        label: "ZT421R",
        family: "ZT400 RFID",
        rfid: true,
        supportedDpis: [203, 300],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 168, 300: 168 },
        maxSpeedIpsByDpi: { 203: 12, 300: 10 },
    },
    {
        id: "zt610r",
        label: "ZT610R",
        family: "ZT600 RFID",
        rfid: true,
        supportedDpis: [203, 300, 600],
        defaultDpi: 300,
        maxPrintWidthMmByDpi: { 203: 104, 300: 104, 600: 104 },
        maxSpeedIpsByDpi: { 203: 14, 300: 12, 600: 6 },
        note: "ZT610 supports 203, 300, and 600 dpi printheads.",
    },
    {
        id: "zt620r",
        label: "ZT620R",
        family: "ZT600 RFID",
        rfid: true,
        supportedDpis: [203, 300],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 168, 300: 168 },
        maxSpeedIpsByDpi: { 203: 12, 300: 8 },
    },
    {
        id: "zq511r",
        label: "ZQ511R",
        family: "ZQ500 RFID",
        rfid: true,
        supportedDpis: [203],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 72 },
        maxSpeedIpsByDpi: { 203: 5 },
    },
    {
        id: "zq521r",
        label: "ZQ521R",
        family: "ZQ500 RFID",
        rfid: true,
        supportedDpis: [203],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 104 },
        maxSpeedIpsByDpi: { 203: 5 },
    },
    {
        id: "zq630r",
        label: "ZQ630R Plus",
        family: "ZQ600 RFID",
        rfid: true,
        supportedDpis: [203],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 104 },
        maxSpeedIpsByDpi: { 203: 4.5 },
    },
    {
        id: "ze511r",
        label: "ZE511R",
        family: "ZE500 RFID",
        rfid: true,
        supportedDpis: [203, 300, 600],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 104, 300: 104, 600: 104 },
        maxSpeedIpsByDpi: { 203: 18, 300: 14, 600: 6 },
    },
    {
        id: "ze521r",
        label: "ZE521R",
        family: "ZE500 RFID",
        rfid: true,
        supportedDpis: [203, 300],
        defaultDpi: 203,
        maxPrintWidthMmByDpi: { 203: 168, 300: 168 },
        maxSpeedIpsByDpi: { 203: 14, 300: 12 },
    },
    {
        id: "other_link_os",
        label: "Other Link-OS",
        family: "Zebra Link-OS",
        rfid: true,
        supportedDpis: [203, 300, 600],
        defaultDpi: 300,
        maxPrintWidthMmByDpi: {},
        maxSpeedIpsByDpi: {},
    },
] as const;

export function zebraPrinterModelProfile(
    model: ZebraRfidModel | undefined,
): ZebraPrinterModelProfile {
    return (
        ZEBRA_PRINTER_MODELS.find((profile) => profile.id === model) ??
        ZEBRA_PRINTER_MODELS[0]
    );
}

export function compatiblePrinterDpi(
    model: ZebraRfidModel | undefined,
    requested: PrinterDpi,
): PrinterDpi {
    const profile = zebraPrinterModelProfile(model);
    return profile.supportedDpis.includes(requested)
        ? requested
        : profile.defaultDpi;
}

export function printerDotSize(
    widthMm: number,
    heightMm: number,
    dpi: PrinterDpi,
): { widthDots: number; heightDots: number } {
    return {
        widthDots: mmToDots(widthMm, dpi),
        heightDots: mmToDots(heightMm, dpi),
    };
}

export function maxPrintWidthMm(
    model: ZebraRfidModel | undefined,
    dpi: PrinterDpi,
): number | undefined {
    return zebraPrinterModelProfile(model).maxPrintWidthMmByDpi[dpi];
}

export function maxPrintSpeedIps(
    model: ZebraRfidModel | undefined,
    dpi: PrinterDpi,
): number | undefined {
    return zebraPrinterModelProfile(model).maxSpeedIpsByDpi[dpi];
}

export function inferPrinterDpiFromDotsPerMm(value: number): PrinterDpi | undefined {
    if (value === 8) return 203;
    if (value === 12) return 300;
    if (value === 24) return 600;
    return undefined;
}
