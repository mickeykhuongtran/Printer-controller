"use client";

import {
    Type,
    QrCode,
    Barcode,
    Grid3X3,
    Square,
    Minus,
    ImageIcon,
    Table as TableIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ElementKind } from "../types";
import type { IconDef } from "../icons";
import { IconPickerPopover } from "./IconPickerPopover";

interface ToolbarProps {
    onAdd: (kind: ElementKind) => void;
    onAddImage: () => void;
    onAddIcon: (icon: IconDef) => void;
}

export function Toolbar({
    onAdd,
    onAddImage,
    onAddIcon,
}: ToolbarProps) {
    const tools: Array<{ kind: ElementKind; label: string; icon: React.ReactNode }> = [
        { kind: "text", label: "Text", icon: <Type className="w-4 h-4" /> },
        { kind: "qr", label: "QR", icon: <QrCode className="w-4 h-4" /> },
        { kind: "barcode", label: "Barcode", icon: <Barcode className="w-4 h-4" /> },
        { kind: "datamatrix", label: "Data Matrix", icon: <Grid3X3 className="w-4 h-4" /> },
        { kind: "rect", label: "Rectangle", icon: <Square className="w-4 h-4" /> },
        { kind: "line", label: "Line", icon: <Minus className="w-4 h-4" /> },
        { kind: "table", label: "Table", icon: <TableIcon className="w-4 h-4" /> },
    ];

    return (
        <TooltipProvider delayDuration={150}>
            <div className="flex items-center gap-1 px-3 py-2 border-b border-black/[0.06] dark:border-white/[0.06] flex-shrink-0 min-h-[48px] overflow-x-auto">
                {tools.map((t) => (
                    <Tooltip key={t.kind}>
                        <TooltipTrigger asChild>
                            <Button variant="outline" size="sm" onClick={() => onAdd(t.kind)}>
                                {t.icon}
                                <span className="ml-1.5 hidden sm:inline">{t.label}</span>
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent>Add {t.label}</TooltipContent>
                    </Tooltip>
                ))}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button variant="outline" size="sm" onClick={onAddImage}>
                            <ImageIcon className="w-4 h-4" />
                            <span className="ml-1.5 hidden sm:inline">Image</span>
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent>Upload an image (preview only)</TooltipContent>
                </Tooltip>
                <IconPickerPopover onSelect={onAddIcon} />
            </div>
        </TooltipProvider>
    );
}
