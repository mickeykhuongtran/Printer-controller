"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
    Pencil,
    Copy,
    ClipboardCopy,
    Trash2,
    ArrowUp,
    ArrowDown,
    Lock,
    Unlock,
    AlignHorizontalJustifyCenter,
    AlignVerticalJustifyCenter,
    MoveHorizontal,
    MoveVertical,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { LabelElement } from "../types";

export interface ContextMenuTarget {
    el: LabelElement;
    els: LabelElement[];
    clientX: number;
    clientY: number;
}

interface Props {
    target: ContextMenuTarget;
    onClose: () => void;
    onEdit?: () => void;
    onCopy: () => void;
    onDuplicate: () => void;
    onDelete: () => void;
    onReorder: (direction: "up" | "down") => void;
    onToggleLock: () => void;
    onCenter: (axis: "h" | "v") => void;
    onSetLineOrientation?: (orientation: "h" | "v") => void;
}

export function ElementContextMenu({
    target,
    onClose,
    onEdit,
    onCopy,
    onDuplicate,
    onDelete,
    onReorder,
    onToggleLock,
    onCenter,
    onSetLineOrientation,
}: Props) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [pos, setPos] = useState({ x: target.clientX, y: target.clientY });

    useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return;
        const rect = node.getBoundingClientRect();
        const margin = 8;
        const maxX = window.innerWidth - rect.width - margin;
        const maxY = window.innerHeight - rect.height - margin;
        setPos({
            x: Math.max(margin, Math.min(target.clientX, maxX)),
            y: Math.max(margin, Math.min(target.clientY, maxY)),
        });
    }, [target.clientX, target.clientY]);

    useEffect(() => {
        const onDown = (e: PointerEvent) => {
            if (!ref.current) return;
            if (!ref.current.contains(e.target as Node)) onClose();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        // Capture phase so we see the event before child handlers can preventDefault.
        window.addEventListener("pointerdown", onDown, true);
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("pointerdown", onDown, true);
            window.removeEventListener("keydown", onKey);
        };
    }, [onClose]);

    const isMulti = target.els.length > 1;
    const isText = !isMulti && target.el.kind === "text";
    // For multi: locked = "all locked"; lock toggle says "Lock" if any unlocked, "Unlock" if all locked.
    const allLocked = target.els.every((e) => !!e.locked);
    const locked = isMulti ? allLocked : !!target.el.locked;

    const items: Array<
        | {
              label: string;
              icon: React.ReactNode;
              onClick: () => void;
              shortcut?: string;
              danger?: boolean;
              disabled?: boolean;
          }
        | { divider: true }
    > = [];

    if (isText && !locked) {
        items.push({
            label: "Edit text",
            icon: <Pencil className="w-3.5 h-3.5" />,
            onClick: () => {
                onEdit?.();
                onClose();
            },
            shortcut: "Enter",
        });
        items.push({ divider: true });
    }

    items.push({
        label: "Copy",
        icon: <ClipboardCopy className="w-3.5 h-3.5" />,
        onClick: () => {
            onCopy();
            onClose();
        },
        shortcut: "⌘C",
    });
    items.push({
        label: "Duplicate",
        icon: <Copy className="w-3.5 h-3.5" />,
        onClick: () => {
            onDuplicate();
            onClose();
        },
        shortcut: "⌘D",
    });
    items.push({ divider: true });
    items.push({
        label: "Bring forward",
        icon: <ArrowUp className="w-3.5 h-3.5" />,
        onClick: () => {
            onReorder("up");
            onClose();
        },
    });
    items.push({
        label: "Send backward",
        icon: <ArrowDown className="w-3.5 h-3.5" />,
        onClick: () => {
            onReorder("down");
            onClose();
        },
    });
    items.push({ divider: true });
    items.push({
        label: "Center horizontally",
        icon: <AlignHorizontalJustifyCenter className="w-3.5 h-3.5" />,
        onClick: () => {
            onCenter("h");
            onClose();
        },
        disabled: locked,
    });
    items.push({
        label: "Center vertically",
        icon: <AlignVerticalJustifyCenter className="w-3.5 h-3.5" />,
        onClick: () => {
            onCenter("v");
            onClose();
        },
        disabled: locked,
    });
    if (!isMulti && target.el.kind === "line" && onSetLineOrientation) {
        const next = target.el.orientation === "h" ? "v" : "h";
        items.push({ divider: true });
        items.push({
            label: next === "h" ? "Make horizontal" : "Make vertical",
            icon:
                next === "h" ? (
                    <MoveHorizontal className="w-3.5 h-3.5" />
                ) : (
                    <MoveVertical className="w-3.5 h-3.5" />
                ),
            onClick: () => {
                onSetLineOrientation(next);
                onClose();
            },
            disabled: locked,
        });
    }
    items.push({ divider: true });
    items.push({
        label: locked ? "Unlock" : "Lock",
        icon: locked ? (
            <Unlock className="w-3.5 h-3.5" />
        ) : (
            <Lock className="w-3.5 h-3.5" />
        ),
        onClick: () => {
            onToggleLock();
            onClose();
        },
    });
    items.push({ divider: true });
    items.push({
        label: "Delete",
        icon: <Trash2 className="w-3.5 h-3.5" />,
        onClick: () => {
            onDelete();
            onClose();
        },
        shortcut: "Del",
        danger: true,
    });

    return (
        <div
            ref={ref}
            role="menu"
            className="fixed z-[80] min-w-[200px] rounded-[8px] ring-1 ring-black/[0.08] dark:ring-white/10 bg-popover/95 backdrop-blur text-foreground shadow-xl py-1 text-sm"
            style={{ left: pos.x, top: pos.y }}
            onContextMenu={(e) => e.preventDefault()}
        >
            {isMulti && (
                <div className="px-3 py-1 text-[10px] font-medium uppercase tracking-wide opacity-60">
                    {target.els.length} selected
                </div>
            )}
            {items.map((item, i) =>
                "divider" in item ? (
                    <div key={`d${i}`} className="my-1 border-t border-black/[0.06] dark:border-white/[0.06]" />
                ) : (
                    <button
                        key={item.label}
                        type="button"
                        role="menuitem"
                        disabled={item.disabled}
                        onClick={item.onClick}
                        className={cn(
                            "w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
                            "disabled:opacity-50 disabled:cursor-not-allowed",
                            !item.disabled && "hover:bg-accent",
                            item.danger
                                ? "text-destructive hover:bg-destructive/10"
                                : "",
                        )}
                    >
                        <span className="flex-shrink-0 opacity-80">{item.icon}</span>
                        <span className="flex-1">{item.label}</span>
                        {item.shortcut && (
                            <span className="text-[10px] font-mono opacity-60 ml-2">
                                {item.shortcut}
                            </span>
                        )}
                    </button>
                ),
            )}
        </div>
    );
}
