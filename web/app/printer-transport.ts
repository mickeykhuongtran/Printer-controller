"use client";

import type { PrinterConnectionMode, PrinterSettings } from "./storage";
import { sendTcpBytes, sendTcpTextAndRead } from "./tcp-print";
import {
    disconnect,
    isWebSerialSupported,
    requestAndOpen,
    sendBytes,
    sendTextAndRead,
    type ConnectedPort,
} from "./webserial";
import { sendWindowsRawPrint } from "./windows-raw-print";
import {
    runExclusivePrinterJob,
    tcpPrinterQueueKey,
    windowsPrinterQueueKey,
} from "./print-job-coordinator";

export type PrinterTransportCapabilities = {
    mode: PrinterConnectionMode;
    label: string;
    canSet: true;
    canGet: boolean;
    reason?: string;
};

export type PrinterWriteResult = {
    bytesWritten: number;
    delivery: "written" | "queued";
    verification: "none";
    jobId?: number | null;
};

const CAPABILITIES: Record<PrinterConnectionMode, PrinterTransportCapabilities> = {
    webserial: {
        mode: "webserial",
        label: "COM / Serial",
        canSet: true,
        canGet: true,
    },
    tcp: {
        mode: "tcp",
        label: "Direct TCP/IP",
        canSet: true,
        canGet: true,
    },
    windowsRaw: {
        mode: "windowsRaw",
        label: "Windows printer",
        canSet: true,
        canGet: false,
        reason: "Windows printing does not support GET commands or status read-back. Use Direct TCP/IP or COM / Serial for printer configuration queries.",
    },
};

export function printerTransportCapabilities(
    mode: PrinterConnectionMode,
): PrinterTransportCapabilities {
    return CAPABILITIES[mode];
}

function validateTransportSettings(settings: PrinterSettings): void {
    if (settings.connectionMode === "tcp" && !settings.tcpHost.trim()) {
        throw new Error("Enter the Zebra printer IP address first.");
    }
    if (settings.connectionMode === "windowsRaw" && !settings.printerName.trim()) {
        throw new Error("Select a Windows Zebra printer queue first.");
    }
    if (settings.connectionMode === "webserial" && !isWebSerialSupported()) {
        throw new Error("Web Serial is not supported in this browser. Use Chrome/Edge, TCP/IP, or a Windows queue.");
    }
}

export async function writePrinterBytes(options: {
    settings: PrinterSettings;
    payload: Uint8Array;
    documentName: string;
    language?: "zpl";
    connection?: ConnectedPort;
}): Promise<PrinterWriteResult> {
    const { settings, payload, documentName } = options;
    validateTransportSettings(settings);

    const queueKey = settings.connectionMode === "tcp"
        ? tcpPrinterQueueKey(settings.tcpHost, settings.tcpPort)
        : settings.connectionMode === "windowsRaw"
            ? windowsPrinterQueueKey(settings.printAgentUrl, settings.printerName)
            : options.connection?.port ?? "webserial:port-selection";

    return runExclusivePrinterJob(queueKey, async () => {

        if (settings.connectionMode === "windowsRaw") {
            const result = await sendWindowsRawPrint({
                agentUrl: settings.printAgentUrl,
                printerName: settings.printerName,
                documentName,
                payload,
                language: "zpl",
            });
            return {
                bytesWritten: result.bytesWritten,
                delivery: "queued",
                verification: "none",
                jobId: result.jobId,
            };
        }

        if (settings.connectionMode === "tcp") {
            const result = await sendTcpBytes({
                host: settings.tcpHost.trim(),
                port: settings.tcpPort,
                payload,
                agentUrl: settings.printAgentUrl,
                executionMode: settings.tcpExecutionMode,
                connectTimeoutMs: 30_000,
            });
            return {
                bytesWritten: result.bytesWritten,
                delivery: "written",
                verification: "none",
            };
        }

        if (options.connection) {
            return {
                bytesWritten: await sendBytes(options.connection, payload),
                delivery: "written",
                verification: "none",
            };
        }

        const connection = await requestAndOpen(
            settings.baudRate,
            settings.serialFlowControl,
        );
        try {
            return {
                bytesWritten: await sendBytes(connection, payload),
                delivery: "written",
                verification: "none",
            };
        } finally {
            await disconnect(connection).catch(() => undefined);
        }
    });
}

export async function queryPrinterText(options: {
    settings: PrinterSettings;
    text: string;
    readWindowMs?: number;
    readIdleMs?: number;
    connection?: ConnectedPort;
}): Promise<{ bytesWritten: number; response: string }> {
    const { settings } = options;
    const capabilities = printerTransportCapabilities(settings.connectionMode);
    if (!capabilities.canGet) {
        throw new Error(capabilities.reason);
    }
    validateTransportSettings(settings);

    const queueKey = settings.connectionMode === "tcp"
        ? tcpPrinterQueueKey(settings.tcpHost, settings.tcpPort)
        : options.connection?.port ?? "webserial:port-selection";

    return runExclusivePrinterJob(queueKey, async () => {

        if (settings.connectionMode === "tcp") {
            return sendTcpTextAndRead({
                host: settings.tcpHost.trim(),
                port: settings.tcpPort,
                text: options.text,
                agentUrl: settings.printAgentUrl,
                executionMode: settings.tcpExecutionMode,
                readWindowMs: options.readWindowMs ?? 3500,
                readIdleMs: options.readIdleMs ?? 250,
            });
        }

        if (options.connection) {
            const response = await sendTextAndRead(
                options.connection,
                options.text,
                options.readWindowMs ?? 3500,
                options.readIdleMs ?? 250,
            );
            return {
                bytesWritten: new TextEncoder().encode(options.text).byteLength,
                response,
            };
        }

        const connection = await requestAndOpen(
            settings.baudRate,
            settings.serialFlowControl,
        );
        try {
            const response = await sendTextAndRead(
                connection,
                options.text,
                options.readWindowMs ?? 3500,
                options.readIdleMs ?? 250,
            );
            return {
                bytesWritten: new TextEncoder().encode(options.text).byteLength,
                response,
            };
        } finally {
            await disconnect(connection).catch(() => undefined);
        }
    });
}
