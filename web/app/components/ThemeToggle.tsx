"use client";

/* eslint-disable react-hooks/set-state-in-effect -- mounted state intentionally guards client-only theme UI. */

import React, { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme } from "../../style-llm/ThemeProvider";
import { cn } from "@/lib/utils";
import { track } from "../lib/analytics";

interface ThemeToggleProps {
    className?: string;
    variant?: "floating" | "inline";
}

const PAGES_WITH_INLINE_TOGGLE = ["/"];

export function ThemeToggle({ className, variant = "floating" }: ThemeToggleProps) {
    const { theme, toggleTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const pathname = usePathname();

    const handleToggle = () => {
        track("theme_changed", { from: theme });
        toggleTheme();
    };

    useEffect(() => setMounted(true), []);

    const Icon = theme === "dark" ? Moon : theme === "light" ? Sun : Monitor;
    const label =
        theme === "dark" ? "Dark mode" : theme === "light" ? "Light mode" : "System theme";

    const baseBtn =
        "group relative flex items-center justify-center w-11 h-11 rounded-full " +
        "bg-white/85 dark:bg-neutral-900/85 backdrop-blur-md " +
        "border border-black/[0.08] dark:border-white/10 " +
        "text-neutral-700 dark:text-neutral-200 " +
        "shadow-lg shadow-black/5 dark:shadow-black/40 hover:shadow-xl " +
        "hover:bg-white dark:hover:bg-neutral-800 " +
        "transition-all duration-300 active:scale-95";

    if (variant === "inline") {
        return (
            <button
                type="button"
                aria-label={`Toggle theme (current: ${label})`}
                onClick={handleToggle}
                className={cn(baseBtn, className)}
            >
                {mounted ? (
                    <Icon className="w-5 h-5 stroke-[1.75px] transition-transform duration-300 group-hover:rotate-12" />
                ) : (
                    <span className="w-5 h-5" />
                )}
            </button>
        );
    }

    if (PAGES_WITH_INLINE_TOGGLE.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
        return null;
    }

    return (
        <button
            type="button"
            aria-label={`Toggle theme (current: ${label})`}
            onClick={handleToggle}
            className={cn(
                "fixed bottom-6 right-6 z-[60] print:hidden",
                baseBtn,
                className
            )}
        >
            {mounted ? (
                <Icon className="w-5 h-5 stroke-[1.75px] transition-transform duration-300 group-hover:rotate-12" />
            ) : (
                <span className="w-5 h-5" />
            )}
            <span className="pointer-events-none absolute -top-9 right-0 px-2 py-1 rounded-md text-[10px] font-medium uppercase tracking-wider whitespace-nowrap bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 opacity-0 group-hover:opacity-100 transition-opacity">
                {label}
            </span>
        </button>
    );
}
