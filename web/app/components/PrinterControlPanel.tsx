"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import {
    Activity,
    CircleCheck,
    CircleHelp,
    OctagonAlert,
    PauseCircle,
    PlayCircle,
    Printer,
    RefreshCw,
    ScanSearch,
    TriangleAlert,
    XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
    printerTransportCapabilities,
    queryPrinterText,
    writePrinterBytes,
} from "../printer-transport";
import type { PrinterSettings } from "../storage";
import { useSerialSession } from "../serial-session";
import {
    cleanZebraPrinterResponse,
    parseZebraPrinterStatus,
    ZEBRA_SYSTEM_STATUS_COMMAND,
} from "../zebra-printer-status";
import type { ZebraPrinterStatusLevel } from "../zebra-printer-status";

type ControlActionId =
    | "status-check"
    | "feed"
    | "pause"
    | "resume"
    | "cancel-current";

type ControlAction = {
    id: ControlActionId;
    label: string;
    command: string;
    icon: typeof Activity;
    kind: "query" | "write";
};

const CONTROL_ACTIONS: readonly ControlAction[] = [
    {
        id: "status-check",
        label: "Refresh Status",
        command: ZEBRA_SYSTEM_STATUS_COMMAND,
        icon: ScanSearch,
        kind: "query",
    },
    {
        id: "feed",
        label: "Feed",
        command: "~PH",
        icon: Printer,
        kind: "write",
    },
    {
        id: "pause",
        label: "Pause",
        command: "~PP",
        icon: PauseCircle,
        kind: "write",
    },
    {
        id: "resume",
        label: "Resume",
        command: "~PS",
        icon: PlayCircle,
        kind: "write",
    },
    {
        id: "cancel-current",
        label: "Cancel Current",
        command: "~JP",
        icon: XCircle,
        kind: "write",
    },
];

type ControlState = {
    target: ControlActionId | null;
    status: "idle" | "loading" | "ok" | "error";
    message: string;
};

type MonitorLevel = ZebraPrinterStatusLevel | "unverified";

type MonitorSnapshot = {
    level: MonitorLevel;
    paused: boolean | null;
    checkedAt: string | null;
    reasons: string[];
    raw: string;
    targetKey: string | null;
};

const EMPTY_CONTROL_STATE: ControlState = {
    target: null,
    status: "idle",
    message: "",
};

const EMPTY_MONITOR_SNAPSHOT: MonitorSnapshot = {
    level: "unverified",
    paused: null,
    checkedAt: null,
    reasons: ["Status has not been checked yet."],
    raw: "",
    targetKey: null,
};

const STATUS_META: Record<
    MonitorLevel,
    {
        label: string;
        icon: typeof Activity;
        panelClassName: string;
        badgeClassName: string;
    }
> = {
    ready: {
        label: "Ready",
        icon: CircleCheck,
        panelClassName:
            "border-emerald-500/25 bg-emerald-500/[0.06] dark:bg-emerald-500/10",
        badgeClassName:
            "bg-emerald-600 text-white dark:bg-emerald-500 dark:text-emerald-950",
    },
    paused: {
        label: "Paused",
        icon: PauseCircle,
        panelClassName:
            "border-sky-500/25 bg-sky-500/[0.06] dark:bg-sky-500/10",
        badgeClassName: "bg-sky-600 text-white dark:bg-sky-400 dark:text-sky-950",
    },
    warning: {
        label: "Warning",
        icon: TriangleAlert,
        panelClassName:
            "border-amber-500/30 bg-amber-500/[0.07] dark:bg-amber-500/10",
        badgeClassName:
            "bg-amber-500 text-amber-950 dark:bg-amber-400 dark:text-amber-950",
    },
    error: {
        label: "Error",
        icon: OctagonAlert,
        panelClassName: "border-red-500/30 bg-red-500/[0.06] dark:bg-red-500/10",
        badgeClassName: "bg-red-600 text-white dark:bg-red-500",
    },
    unverified: {
        label: "Unverified",
        icon: CircleHelp,
        panelClassName:
            "border-black/[0.08] bg-black/[0.025] dark:border-white/10 dark:bg-white/[0.04]",
        badgeClassName:
            "bg-slate-200 text-slate-700 dark:bg-slate-700 dark:text-slate-100",
    },
};

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function printerTargetKey(settings: PrinterSettings): string {
    switch (settings.connectionMode) {
        case "tcp":
            return `tcp:${settings.tcpHost.trim()}:${settings.tcpPort}`;
        case "windowsRaw":
            return `windows:${settings.printerName.trim()}`;
        default:
            return `serial:${settings.baudRate}`;
    }
}

function formatTimestamp(timestamp: string): string {
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "medium",
    }).format(new Date(timestamp));
}

type PrinterControlPanelProps = {
    fullscreen?: boolean;
    printerSettings: PrinterSettings;
};

export function PrinterControlPanel({
    fullscreen = false,
    printerSettings,
}: PrinterControlPanelProps) {
    const serialSession = useSerialSession();
    const [state, setState] = useState<ControlState>(EMPTY_CONTROL_STATE);
    const [monitor, setMonitor] = useState<MonitorSnapshot>(EMPTY_MONITOR_SNAPSHOT);
    const capabilities = printerTransportCapabilities(printerSettings.connectionMode);
    const targetKey = printerTargetKey(printerSettings);
    const anyActionRunning = state.status === "loading";
    const sharedSerialConnection =
        printerSettings.connectionMode === "webserial"
            ? serialSession.connection ?? undefined
            : undefined;
    const visibleMonitor: MonitorSnapshot =
        monitor.targetKey === targetKey
            ? monitor
            : {
                  ...EMPTY_MONITOR_SNAPSHOT,
                  reasons: [
                      capabilities.canGet
                          ? "Run Refresh Status to read this Zebra printer."
                          : "A Windows spooler queue cannot return live printer status. Use TCP/IP or COM for monitoring.",
                  ],
              };

    const runAction = async (action: ControlAction) => {
        if (
            action.id === "cancel-current" &&
            !window.confirm(
                "Cancel the current/next Zebra format? The ~JP command also pauses the printer. Use Resume when you are ready to continue.",
            )
        ) {
            return;
        }

        setState({
            target: action.id,
            status: "loading",
            message:
                action.kind === "query"
                    ? `Reading Zebra status over ${capabilities.label}...`
                    : `${action.label} over ${capabilities.label}...`,
        });

        let queryRaw = "";
        try {
            if (action.kind === "query") {
                const result = await queryPrinterText({
                    settings: printerSettings,
                    text: action.command,
                    readWindowMs: 3500,
                    readIdleMs: 250,
                    connection: sharedSerialConnection,
                });
                queryRaw = cleanZebraPrinterResponse(result.response);
                const parsed = parseZebraPrinterStatus(result.response);
                setMonitor({
                    level: parsed.level,
                    paused: parsed.paused,
                    checkedAt: new Date().toISOString(),
                    reasons: parsed.reasons,
                    raw: parsed.raw,
                    targetKey,
                });
                setState({
                    target: action.id,
                    status: "ok",
                    message: `Status read directly over ${capabilities.label}.`,
                });
                return;
            }

            const result = await writePrinterBytes({
                settings: printerSettings,
                payload: new TextEncoder().encode(action.command),
                documentName: `Zebra Control - ${action.label}`,
                language: "zpl",
                connection: sharedSerialConnection,
            });
            const queued = result.delivery === "queued";
            const sentAt = new Date().toISOString();
            setMonitor({
                level: "unverified",
                paused: null,
                checkedAt: sentAt,
                reasons: [
                    queued
                        ? `${action.label} is queued in Windows; printer execution is not confirmed.`
                        : `${action.label} was sent; refresh status to verify the printer state.`,
                ],
                raw: "",
                targetKey,
            });
            setState({
                target: action.id,
                status: "ok",
                message: queued
                    ? `${action.label} queued (${result.bytesWritten} bytes). Delivery remains unverified because the Windows queue is write-only.`
                    : `${action.label} sent directly over ${capabilities.label} (${result.bytesWritten} bytes).`,
            });
        } catch (error) {
            const message = errorMessage(error);
            setState({
                target: action.id,
                status: "error",
                message,
            });
            if (action.kind === "query") {
                setMonitor({
                    level: "unverified",
                    paused: null,
                    checkedAt: new Date().toISOString(),
                    reasons: [message],
                    raw: queryRaw,
                    targetKey,
                });
            }
        }
    };

    return (
        <div
            className={cn(
                "h-full min-h-0 overflow-auto overscroll-contain bg-background px-3 py-3",
                fullscreen && "px-4 py-4",
            )}
        >
            <ControlCard
                icon={<Activity className="h-4 w-4" />}
                title="Printer Control"
                caption="Operator-safe Zebra ZPL controls"
            >
                <div className="flex flex-wrap items-center gap-2 rounded-[6px] border border-black/[0.06] bg-black/[0.025] px-3 py-2 text-[11px] dark:border-white/10 dark:bg-white/[0.04]">
                    <span className="font-semibold text-foreground">{capabilities.label}</span>
                    <span
                        className={cn(
                            "rounded-full px-2 py-0.5 font-medium",
                            capabilities.canGet
                                ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                : "bg-amber-500/10 text-amber-700 dark:text-amber-300",
                        )}
                    >
                        {capabilities.canGet ? "Direct read/write" : "Queued / unverified"}
                    </span>
                    {!capabilities.canGet && (
                        <span className="basis-full text-muted-foreground">
                            Live status is unavailable through a Windows spooler queue. Select TCP/IP or COM.
                        </span>
                    )}
                </div>

                <StatusMonitor snapshot={visibleMonitor} />

                <div className="grid grid-cols-2 gap-2 xl:grid-cols-3">
                    {CONTROL_ACTIONS.map((action) => {
                        const Icon = action.icon;
                        const busy = anyActionRunning && state.target === action.id;
                        const statusUnavailable = action.kind === "query" && !capabilities.canGet;
                        return (
                            <Button
                                key={action.id}
                                type="button"
                                size="sm"
                                variant="outline"
                                onClick={() => runAction(action)}
                                disabled={anyActionRunning || statusUnavailable}
                                title={statusUnavailable ? capabilities.reason : undefined}
                                className="h-10 justify-center"
                            >
                                {busy ? (
                                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Icon className="h-3.5 w-3.5" />
                                )}
                                {busy ? "Running..." : action.label}
                            </Button>
                        );
                    })}
                </div>

                <p className="text-[10px] leading-relaxed text-muted-foreground">
                    Cancel Current (~JP) clears the current/next format and leaves the Zebra printer paused. Use Resume to continue.
                </p>
                <p
                    aria-live="polite"
                    className={cn(
                        "text-[11px]",
                        state.status === "error"
                            ? "text-red-600 dark:text-red-300"
                            : state.status === "ok"
                              ? "text-emerald-700 dark:text-emerald-400"
                              : "text-muted-foreground",
                    )}
                >
                    {state.message || "Ready for an operator command."}
                </p>
            </ControlCard>
        </div>
    );
}

function StatusMonitor({ snapshot }: { snapshot: MonitorSnapshot }) {
    const meta = STATUS_META[snapshot.level];
    const StatusIcon = meta.icon;
    return (
        <section className={cn("rounded-[7px] border p-3", meta.panelClassName)}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                    <StatusIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                            Printer status
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted-foreground">
                            {snapshot.checkedAt
                                ? `${snapshot.level === "unverified" ? "Changed" : "Checked"} ${formatTimestamp(snapshot.checkedAt)}`
                                : "Not checked"}
                        </div>
                    </div>
                </div>
                <span
                    className={cn(
                        "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold",
                        meta.badgeClassName,
                    )}
                >
                    {meta.label}
                </span>
            </div>

            <ul className="mt-2 space-y-1 text-[11px] leading-relaxed text-foreground">
                {snapshot.reasons.map((reason, index) => (
                    <li key={`${reason}-${index}`} className="flex gap-2">
                        <span aria-hidden="true">•</span>
                        <span>{reason}</span>
                    </li>
                ))}
            </ul>

            {snapshot.raw && (
                <details className="mt-2 text-[10px] text-muted-foreground">
                    <summary className="cursor-pointer select-none font-medium">
                        Raw Zebra response
                    </summary>
                    <pre className="mt-1 max-h-28 overflow-auto whitespace-pre-wrap rounded-[5px] bg-black/[0.04] px-2 py-1.5 font-mono text-[10px] text-foreground dark:bg-black/20">
                        {snapshot.raw}
                    </pre>
                </details>
            )}
        </section>
    );
}

function ControlCard({
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
        <section className="flex min-h-0 flex-col gap-3 rounded-[8px] border border-black/[0.08] bg-white/70 p-3 shadow-sm dark:border-white/10 dark:bg-white/[0.03]">
            <div className="flex items-start gap-2">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[6px] bg-black/[0.04] text-muted-foreground dark:bg-white/[0.06]">
                    {icon}
                </div>
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-foreground">{title}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-3">{children}</div>
        </section>
    );
}
