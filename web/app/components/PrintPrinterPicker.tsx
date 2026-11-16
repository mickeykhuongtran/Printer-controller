"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { PrinterSettings } from "../storage";
import type { WindowsPrinterInfo } from "../windows-raw-print";

export function PrintPrinterPicker({ settings, onChange, printers, loading, disabled, onRefresh }: {
    settings: PrinterSettings;
    onChange: (patch: Partial<PrinterSettings>) => void;
    printers: WindowsPrinterInfo[];
    loading: boolean;
    disabled: boolean;
    onRefresh: () => void;
}) {
    return <div className="space-y-2 text-xs">
        <label className="block space-y-1">
            <span>Connection</span>
            <select aria-label="Print connection" value={settings.connectionMode} disabled={disabled}
                onChange={(event) => onChange({ connectionMode: event.target.value as PrinterSettings["connectionMode"] })}
                className="h-9 w-full rounded-md border bg-background px-2">
                <option value="windowsRaw">Windows printer</option>
                <option value="tcp">Direct TCP/IP</option>
                <option value="webserial">COM / Serial</option>
            </select>
        </label>
        {settings.connectionMode === "windowsRaw" && <>
            <div className="flex gap-2">
                <select aria-label="Windows printer" value={settings.printerName} disabled={disabled || loading}
                    onChange={(event) => onChange({ printerName: event.target.value })}
                    className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2">
                    <option value="">{loading ? "Loading printers…" : "Select a printer"}</option>
                    {settings.printerName && !printers.some((p) => p.name === settings.printerName) &&
                        <option value={settings.printerName}>{settings.printerName} (unavailable)</option>}
                    {printers.map((printer) => <option key={printer.name} value={printer.name}>{printer.name}</option>)}
                </select>
                <Button variant="outline" size="sm" disabled={disabled || loading} onClick={onRefresh}>Refresh</Button>
            </div>
            <details className="text-muted-foreground">
                <summary className="cursor-pointer">Add a printer</summary>
                <p className="mt-2">In Windows Settings → Printers &amp; scanners, install the Zebra ZPL driver. For Ethernet, add the printer by its IP address using a Standard TCP/IP port (RAW, port 9100). Then click Refresh here.</p>
            </details>
        </>}
        {settings.connectionMode === "tcp" && <>
            <div className="flex gap-2">
                <Input aria-label="Printer IP address" placeholder="Printer IP address" value={settings.tcpHost} disabled={disabled}
                    onChange={(event) => onChange({ tcpHost: event.target.value })} />
                <Input aria-label="Printer TCP port" type="number" min={1} max={65535} value={settings.tcpPort} disabled={disabled}
                    className="w-24" onChange={(event) => onChange({ tcpPort: Math.max(1, Math.min(65535, Number(event.target.value) || 9100)) })} />
            </div>
            <p className="text-muted-foreground">Keep this app open while printing.</p>
        </>}
    </div>;
}
