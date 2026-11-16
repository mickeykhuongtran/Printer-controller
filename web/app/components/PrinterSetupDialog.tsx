"use client";

import { useState, type ReactNode } from "react";
import {
    Apple,
    CheckCircle2,
    Download,
    Loader2,
    Network,
    ShieldCheck,
    Usb,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@/components/ui/dialog";
import {
    DEFAULT_LOCAL_PRINT_AGENT_URL,
    getLocalPrintAgentHealth,
    pairLocalPrintAgent,
} from "../local-print-agent";
import { listWindowsPrinters } from "../windows-raw-print";

const WINDOWS_AGENT_URL =
    process.env.NEXT_PUBLIC_AGENT_WINDOWS_URL
    || "/agent/ZbrePrinterLocalPrintAgent-windows-x64.exe";
const MACOS_ARM64_AGENT_URL =
    process.env.NEXT_PUBLIC_AGENT_MACOS_ARM64_URL
    || "/agent/ZbrePrinterLocalPrintAgent-macos-arm64";
const MACOS_X64_AGENT_URL =
    process.env.NEXT_PUBLIC_AGENT_MACOS_X64_URL
    || "/agent/ZbrePrinterLocalPrintAgent-macos-x64";

type ConnectorStatus = {
    kind: "idle" | "loading" | "ok" | "error";
    message: string;
};

export function PrinterSetupDialog({
    agentUrl = DEFAULT_LOCAL_PRINT_AGENT_URL,
    onAgentUrlChange,
}: {
    agentUrl?: string;
    onAgentUrlChange?: (value: string) => void;
}) {
    const [pairingCode, setPairingCode] = useState("");
    const [status, setStatus] = useState<ConnectorStatus>({
        kind: "idle",
        message: "",
    });

    const checkConnector = async () => {
        setStatus({ kind: "loading", message: "Checking local connector..." });
        try {
            const health = await getLocalPrintAgentHealth(agentUrl);
            // This protected call verifies that a hosted origin is paired;
            // health alone is intentionally public for discovery.
            await listWindowsPrinters(agentUrl);
            const capabilities = [
                health.windowsRaw === true || health.win32print === true
                    ? "Windows RAW"
                    : "",
                health.tcp === true ? "TCP" : "",
            ].filter(Boolean);
            const connectorProtocol = new URL(agentUrl).protocol;
            const gatewayLabel =
                health.siteMode || health.requireOriginToken
                    ? connectorProtocol === "https:"
                        ? " · secured HTTPS site gateway"
                        : health.siteMode
                            ? " · paired HTTP site gateway (traffic is not encrypted)"
                            : " · strict local connector"
                    : "";
            setStatus({
                kind: "ok",
                message:
                    `Connector ${health.version || "legacy"} is paired and ready on `
                    + `${health.platform || "this computer"}`
                    + gatewayLabel
                    + (capabilities.length ? ` · ${capabilities.join(", ")}` : ""),
            });
        } catch (error) {
            setStatus({
                kind: "error",
                message:
                    error instanceof Error
                        ? error.message
                        : "Could not connect to the local print connector.",
            });
        }
    };

    const pairConnector = async () => {
        setStatus({ kind: "loading", message: "Pairing this website..." });
        try {
            const pair = await pairLocalPrintAgent(
                agentUrl,
                pairingCode,
            );
            // Confirm the token works before reporting success. This also
            // catches managed browsers that reject Authorization or PNA.
            await listWindowsPrinters(agentUrl);
            setPairingCode("");
            setStatus({
                kind: "ok",
                message: pair.persisted
                    ? "Paired successfully. This website can now use the local connector."
                    : "Paired for this tab. Browser storage is blocked, so pair again after reloading.",
            });
        } catch (error) {
            setStatus({
                kind: "error",
                message:
                    error instanceof Error
                        ? error.message
                        : "Could not pair with the local connector.",
            });
        }
    };

    return (
        <Dialog>
            <DialogTrigger asChild>
                <Button
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 rounded-full bg-white/85 backdrop-blur-md dark:bg-neutral-900/85"
                    title="Set up the local printer connector"
                    aria-label="Set up the local printer connector"
                >
                    <Usb className="h-5 w-5" />
                </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[620px]">
                <DialogHeader>
                    <DialogTitle>Local printer connector</DialogTitle>
                    <DialogDescription>
                        COM uses Web Serial directly. Install this connector for Windows USB-B
                        queues and for TCP/IP printing from a cloud-hosted web app.
                    </DialogDescription>
                </DialogHeader>

                <div className="grid gap-3 sm:grid-cols-2">
                    <SetupDownloadCard
                        title="Windows x64 connector"
                        description="Windows RAW USB-B spooler and Zebra TCP/IP."
                        href={WINDOWS_AGENT_URL}
                        icon={<Usb className="h-5 w-5" />}
                    />
                    <SetupDownloadCard
                        title="macOS Apple Silicon"
                        description="TCP/IP connector for M1/M2/M3/M4 and newer Macs."
                        href={MACOS_ARM64_AGENT_URL}
                        icon={<Apple className="h-5 w-5" />}
                    />
                    <SetupDownloadCard
                        title="macOS Intel"
                        description="TCP/IP connector for Intel-based Macs."
                        href={MACOS_X64_AGENT_URL}
                        icon={<Apple className="h-5 w-5" />}
                    />
                </div>

                <div className="space-y-3 rounded-[10px] border border-border bg-muted/25 p-3">
                    <div className="flex items-start gap-2">
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-blue-700 dark:text-blue-300" />
                        <div>
                            <p className="text-sm font-semibold">Pair this website</p>
                            <p className="text-xs leading-5 text-muted-foreground">
                                Start the connector, enter the pairing code shown in its window,
                                and allow Chrome/Edge Local Network Access when prompted.
                            </p>
                        </div>
                    </div>
                    <div className="space-y-1">
                        <label
                            htmlFor="connector-url"
                            className="text-xs font-medium text-foreground"
                        >
                            Connector URL
                        </label>
                        <Input
                            id="connector-url"
                            value={agentUrl}
                            onChange={(event) => onAgentUrlChange?.(event.target.value)}
                            readOnly={!onAgentUrlChange}
                            placeholder="http://127.0.0.1:17917"
                            className="h-9 font-mono text-xs"
                            spellCheck={false}
                        />
                    </div>
                    <div className="grid grid-cols-[1fr_auto] gap-2">
                        <Input
                            value={pairingCode}
                            onChange={(event) => setPairingCode(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter" && pairingCode.trim()) {
                                    void pairConnector();
                                }
                            }}
                            placeholder="Pairing code"
                            className="h-9 font-mono uppercase tracking-[0.18em]"
                            autoComplete="one-time-code"
                        />
                        <Button
                            type="button"
                            onClick={() => void pairConnector()}
                            disabled={!pairingCode.trim() || status.kind === "loading"}
                        >
                            Pair
                        </Button>
                    </div>
                    <Button
                        type="button"
                        variant="outline"
                        className="w-full"
                        onClick={() => void checkConnector()}
                        disabled={status.kind === "loading"}
                    >
                        {status.kind === "loading" ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : status.kind === "ok" ? (
                            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                        ) : (
                            <Network className="h-4 w-4" />
                        )}
                        Test local connector
                    </Button>
                    {status.message ? (
                        <p
                            className={
                                status.kind === "error"
                                    ? "text-xs leading-5 text-destructive"
                                    : status.kind === "ok"
                                      ? "text-xs leading-5 text-emerald-700 dark:text-emerald-300"
                                      : "text-xs leading-5 text-muted-foreground"
                            }
                        >
                            {status.message}
                        </p>
                    ) : null}
                </div>

                <div className="space-y-1 rounded-[8px] bg-muted/60 px-3 py-2 text-xs leading-5 text-muted-foreground">
                    <p>
                        Windows USB-B requires a Zebra/ZDesigner/Seagull driver and printer
                        queue. TCP/IP requires this computer to have a route to the printer IP.
                    </p>
                    <p>
                        Bundled downloads are unsigned pilot builds. Company rollout should use
                        Authenticode-signed Windows and Developer ID-notarized macOS release URLs.
                        A raw macOS download may require{" "}
                        <span className="font-mono text-foreground">chmod +x</span>.
                    </p>
                    <p>
                        Connector endpoint:{" "}
                        <span className="break-all font-mono text-foreground">
                            {agentUrl.replace(/^https?:\/\//, "")}
                        </span>
                        . It does not expose Zebra port 9100 to the Internet.
                    </p>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function SetupDownloadCard({
    title,
    description,
    href,
    icon,
}: {
    title: string;
    description: string;
    href: string;
    icon: ReactNode;
}) {
    return (
        <a
            href={href}
            download
            className="group flex items-center gap-3 rounded-[10px] border border-black/[0.08] bg-muted/30 p-3 transition-colors hover:bg-muted dark:border-white/10"
        >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-background text-blue-700 ring-1 ring-black/[0.06] dark:text-blue-300 dark:ring-white/10">
                {icon}
            </span>
            <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">{title}</span>
                <span className="block text-xs leading-5 text-muted-foreground">{description}</span>
            </span>
            <Download className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
        </a>
    );
}
