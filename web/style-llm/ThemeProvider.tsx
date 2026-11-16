"use client";

/* eslint-disable react-hooks/set-state-in-effect -- persisted theme state is restored after hydration. */

import React, { createContext, useContext, useState, useEffect, useCallback } from "react";

type Theme = "light" | "dark" | "system";

interface ThemeContextType {
    theme: Theme;
    toggleTheme: () => void;
    setTheme: (theme: Theme) => void;
}

const ThemeContext = createContext<ThemeContextType | null>(null);

export function useTheme() {
    const ctx = useContext(ThemeContext);
    if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>");
    return ctx;
}

export function ThemeProvider({ children, defaultTheme = "system" }: { children: React.ReactNode; defaultTheme?: Theme }) {
    const [theme, setThemeState] = useState<Theme>(defaultTheme);
    const [mounted, setMounted] = useState(false);

    useEffect(() => {
        try {
            const stored = localStorage.getItem("theme");
            if (stored === "light" || stored === "dark" || stored === "system") {
                setThemeState(stored);
            }
        } catch {
            // Continue with the default/system theme when browser privacy
            // settings deny persistent storage.
        }
        setMounted(true);
    }, []);

    useEffect(() => {
        if (!mounted) return;

        const root = document.documentElement;
        const media = window.matchMedia("(prefers-color-scheme: dark)");
        const applyTheme = () => {
            const resolved = theme === "system"
                ? media.matches ? "dark" : "light"
                : theme;
            root.classList.remove("light", "dark");
            root.classList.add(resolved);
            root.style.colorScheme = resolved;
        };

        applyTheme();
        try {
            localStorage.setItem("theme", theme);
        } catch {
            // Theme selection remains valid for this session without storage.
        }

        if (theme !== "system") return;
        media.addEventListener("change", applyTheme);
        return () => media.removeEventListener("change", applyTheme);
    }, [theme, mounted]);

    const toggleTheme = useCallback(() => {
        setThemeState((prev) => {
            if (prev === "system") return "light";
            if (prev === "light") return "dark";
            return "system";
        });
    }, []);

    const setTheme = useCallback((t: Theme) => {
        setThemeState(t);
    }, []);

    return (
        <ThemeContext.Provider value={{ theme, toggleTheme, setTheme }}>
            {children}
        </ThemeContext.Provider>
    );
}
