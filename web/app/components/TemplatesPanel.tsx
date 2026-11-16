"use client";

import { useRef } from "react";
import { Download, FilePlus, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { LabelDoc } from "../types";
import { downloadFile, exportToJson, parseImportedJson } from "../storage";

interface Props {
    builtIns: LabelDoc[];
    custom: LabelDoc[];
    activeId: string;
    onLoad: (doc: LabelDoc) => void;
    onSaveCurrent: () => void;
    onImport: (doc: LabelDoc) => void;
    onDelete: (id: string) => void;
    currentDoc: LabelDoc;
}

export function TemplatesPanel({
    builtIns,
    custom,
    activeId,
    onLoad,
    onSaveCurrent,
    onImport,
    onDelete,
    currentDoc,
}: Props) {
    const fileInput = useRef<HTMLInputElement | null>(null);

    const onPickFile = () => fileInput.current?.click();

    const onFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = "";
        if (!file) return;
        const text = await file.text();
        const doc = parseImportedJson(text);
        if (!doc) {
            alert("That file is not a valid Nextwaves Label (.nwl).");
            return;
        }
        onImport(doc);
    };

    const onExport = () => {
        downloadFile(
            `${currentDoc.name.replace(/\s+/g, "_")}.nwl`,
            exportToJson(currentDoc),
            "application/json",
        );
    };

    return (
        <ScrollArea className="h-full">
            <div className="p-3 space-y-3">
                <div className="space-y-2">
                    <Button onClick={onSaveCurrent} className="w-full" variant="default" size="sm">
                        <FilePlus className="w-4 h-4" />
                        <span>Save as new template</span>
                    </Button>
                    <div className="grid grid-cols-2 gap-2">
                        <Button onClick={onExport} variant="outline" size="sm">
                            <Download className="w-4 h-4" />
                            <span>Export</span>
                        </Button>
                        <Button onClick={onPickFile} variant="outline" size="sm">
                            <Upload className="w-4 h-4" />
                            <span>Import</span>
                        </Button>
                        <input
                            ref={fileInput}
                            type="file"
                            accept=".nwl,application/json,.json"
                            className="hidden"
                            onChange={onFileChange}
                        />
                    </div>
                </div>

                <Separator />

                <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
                        Built-in
                    </h3>
                    <ul className="space-y-1">
                        {builtIns.map((doc) => (
                            <li key={doc.id}>
                                <button
                                    onClick={() => onLoad(doc)}
                                    className={cn(
                                        "w-full text-left px-3 py-2 rounded-md text-sm transition-colors",
                                        doc.id === activeId
                                            ? "bg-primary text-primary-foreground"
                                            : "hover:bg-muted",
                                    )}
                                >
                                    <div className="font-medium">{doc.name}</div>
                                    <div className="text-[11px] opacity-70 font-mono">
                                        {doc.settings.widthMm}×{doc.settings.heightMm} mm · {doc.elements.length} els
                                    </div>
                                </button>
                            </li>
                        ))}
                    </ul>
                </div>

                {custom.length > 0 && (
                    <div>
                        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2 px-1">
                            Saved
                        </h3>
                        <ul className="space-y-1">
                            {custom.map((doc) => (
                                <li key={doc.id} className="group flex items-stretch gap-1">
                                    <button
                                        onClick={() => onLoad(doc)}
                                        className={cn(
                                            "flex-1 text-left px-3 py-2 rounded-md text-sm transition-colors",
                                            doc.id === activeId
                                                ? "bg-primary text-primary-foreground"
                                                : "hover:bg-muted",
                                        )}
                                    >
                                        <div className="font-medium">{doc.name}</div>
                                        <div className="text-[11px] opacity-70 font-mono">
                                            {doc.settings.widthMm}×{doc.settings.heightMm} mm · {doc.elements.length} els
                                        </div>
                                    </button>
                                    <button
                                        onClick={() => onDelete(doc.id)}
                                        className="px-2 rounded-md text-muted-foreground hover:bg-destructive hover:text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                        title="Delete saved template"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                )}
            </div>
        </ScrollArea>
    );
}
