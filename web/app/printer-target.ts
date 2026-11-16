import {
    compatiblePrinterDpi,
    zebraPrinterModelProfile,
} from "./printer-models";
import type {
    LabelDoc,
    PrinterDpi,
    ZebraRfidModel,
} from "./types";
import { inferWindowsPrinterDpi } from "./windows-raw-print";
import { ZEBRA_RFID_MODELS } from "./zebra-rfid";

export type PrinterTargetInput = {
    // modelId is the canonical routing-config field. targetPrinterModel is
    // accepted as a compatibility alias and mirrors LabelSettings.
    modelId?: ZebraRfidModel;
    targetPrinterModel?: ZebraRfidModel;
    dpi?: PrinterDpi;
};

export type PrinterTargetMetadata = {
    modelId: ZebraRfidModel;
    targetPrinterModel: ZebraRfidModel;
    dpi: PrinterDpi;
};

export type PrinterQueueDpiMismatch = {
    printerName: string;
    queueDpi: PrinterDpi;
    targetDpi: PrinterDpi;
    message: string;
};

export function printerDpiFromUnknown(value: unknown): PrinterDpi | undefined {
    const parsed = typeof value === "string" && value.trim()
        ? Number(value)
        : value;
    if (parsed === 200 || parsed === 203) return 203;
    if (parsed === 300) return 300;
    if (parsed === 600) return 600;
    return undefined;
}

export function zebraPrinterModelFromUnknown(value: unknown): ZebraRfidModel | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim().toLowerCase();
    return ZEBRA_RFID_MODELS.find((model) => model.value === normalized)?.value;
}

export function resolvePrinterTargetMetadata(
    doc: LabelDoc,
    input: PrinterTargetInput = {},
): PrinterTargetMetadata {
    if (
        input.modelId
        && input.targetPrinterModel
        && input.modelId !== input.targetPrinterModel
    ) {
        throw new Error(
            `Printer target is ambiguous: modelId=${input.modelId} but targetPrinterModel=${input.targetPrinterModel}.`,
        );
    }

    const modelId = input.modelId
        ?? input.targetPrinterModel
        ?? doc.settings.targetPrinterModel
        ?? doc.settings.rfid.zebraModel
        ?? "auto";
    const dpi = input.dpi ?? doc.settings.dpi;
    const compatibleDpi = compatiblePrinterDpi(modelId, dpi);
    if (compatibleDpi !== dpi) {
        const profile = zebraPrinterModelProfile(modelId);
        throw new Error(
            `${profile.label} does not support ${dpi} dpi. Supported resolutions: ${profile.supportedDpis.join(", ")} dpi.`,
        );
    }

    return {
        modelId,
        targetPrinterModel: modelId,
        dpi,
    };
}

export function applyPrinterTargetMetadata(
    doc: LabelDoc,
    target: PrinterTargetMetadata,
): LabelDoc {
    return {
        ...doc,
        settings: {
            ...doc.settings,
            // Positions and sizes remain in millimetres. Only dot conversion
            // at render/compile time changes with the selected printhead DPI.
            dpi: target.dpi,
            targetPrinterModel: target.targetPrinterModel,
            rfid: {
                ...doc.settings.rfid,
                zebraModel: target.targetPrinterModel,
            },
        },
    };
}

export function printerQueueDpiMismatch(
    printerName: string,
    targetDpi: PrinterDpi,
): PrinterQueueDpiMismatch | null {
    const queueDpi = inferWindowsPrinterDpi({
        name: printerName,
        isDefault: false,
    });
    if (!queueDpi || queueDpi === targetDpi) return null;

    return {
        printerName,
        queueDpi,
        targetDpi,
        message:
            `Windows queue "${printerName}" explicitly identifies ${queueDpi} dpi, `
            + `but the authoritative printer target is ${targetDpi} dpi. `
            + "Select the matching queue or correct the printer route; DPI is not changed automatically.",
    };
}
