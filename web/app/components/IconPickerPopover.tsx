"use client";

import { useMemo, useState } from "react";
import { Shapes, ChevronDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
    CATEGORY_LABELS,
    groupByCategory,
    ICON_LIBRARY,
    searchIcons,
    type IconDef,
} from "../icons";

interface Props {
    onSelect: (icon: IconDef) => void;
}

export function IconPickerPopover({ onSelect }: Props) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");

    const filtered = useMemo(() => searchIcons(query), [query]);
    const groups = useMemo(() => groupByCategory(filtered), [filtered]);
    const isSearching = query.trim().length > 0;

    const handleSelect = (icon: IconDef) => {
        onSelect(icon);
        setOpen(false);
        setQuery("");
    };

    return (
        <TooltipProvider delayDuration={250}>
            <Popover open={open} onOpenChange={setOpen}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <PopoverTrigger asChild>
                            <Button variant="outline" size="sm">
                                <Shapes className="w-4 h-4" />
                                <span className="ml-1.5 hidden sm:inline">Icon</span>
                                <ChevronDown className="ml-1 w-3 h-3 opacity-60" />
                            </Button>
                        </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Insert icon from library</TooltipContent>
                </Tooltip>
                <PopoverContent
                    align="start"
                    sideOffset={6}
                    className="w-[360px] p-0"
                >
                    <div className="p-2 border-b">
                        <div className="relative">
                            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
                            <Input
                                autoFocus
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder={`Search ${ICON_LIBRARY.length} icons…`}
                                className="pl-8 h-8"
                            />
                        </div>
                    </div>
                    <ScrollArea className="h-[340px]">
                        <div className="p-2">
                            {filtered.length === 0 ? (
                                <div className="py-10 text-center text-sm text-muted-foreground">
                                    No icons match &ldquo;{query}&rdquo;
                                </div>
                            ) : isSearching ? (
                                <IconGrid icons={filtered} onPick={handleSelect} />
                            ) : (
                                groups.map(({ category, icons }) => (
                                    <div key={category} className="mb-3 last:mb-0">
                                        <div className="px-1 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                                            {CATEGORY_LABELS[category]}
                                        </div>
                                        <IconGrid icons={icons} onPick={handleSelect} />
                                    </div>
                                ))
                            )}
                        </div>
                    </ScrollArea>
                </PopoverContent>
            </Popover>
        </TooltipProvider>
    );
}

function IconGrid({
    icons,
    onPick,
}: {
    icons: IconDef[];
    onPick: (icon: IconDef) => void;
}) {
    return (
        <div className="grid grid-cols-6 gap-1">
            {icons.map((icon) => (
                <Tooltip key={icon.id}>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={() => onPick(icon)}
                            className="aspect-square rounded-[6px] hover:bg-black/[0.04] dark:hover:bg-white/[0.06] hover:ring-1 hover:ring-black/[0.08] dark:hover:ring-white/10 flex items-center justify-center text-foreground transition-colors"
                            aria-label={icon.name}
                        >
                            <span
                                className="block w-6 h-6"
                                dangerouslySetInnerHTML={{ __html: icon.svg }}
                            />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent>{icon.name}</TooltipContent>
                </Tooltip>
            ))}
        </div>
    );
}
