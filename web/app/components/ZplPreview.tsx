"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

interface Props {
    zpl: string;
    title?: string;
    defaultOpen?: boolean;
}

export function ZplPreview({ zpl, title = "ZPL Source", defaultOpen = false }: Props) {
    const [open, setOpen] = useState(defaultOpen);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(zpl);
        } catch {
            /* no-op */
        }
    };

    return (
        <div className="border-t bg-muted/30">
            <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                <button
                    onClick={() => setOpen((value) => !value)}
                    className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground"
                >
                    {open ? (
                        <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                        <ChevronUp className="h-3.5 w-3.5" />
                    )}
                    {title} ({zpl.length} chars)
                </button>
                {open && (
                    <Button size="sm" variant="ghost" onClick={copy} className="h-7">
                        <Copy className="h-3.5 w-3.5" />
                        <span className="ml-1.5 text-xs">Copy</span>
                    </Button>
                )}
            </div>
            {open && (
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all px-3 pb-3 font-mono text-[11px] leading-snug">
                    {zpl}
                </pre>
            )}
        </div>
    );
}
