// Font catalog + loaders for the label designer.

export type FontSourceKind = "zpl" | "system" | "google" | "custom";

// System font stack — fonts safely available on macOS, Windows, Linux.
export const SYSTEM_FONTS: Array<{ name: string; stack: string }> = [
    { name: "System Sans", stack: "system-ui, -apple-system, Segoe UI, sans-serif" },
    { name: "Arial", stack: "Arial, Helvetica, sans-serif" },
    { name: "Helvetica", stack: "Helvetica, Arial, sans-serif" },
    { name: "Verdana", stack: "Verdana, Geneva, sans-serif" },
    { name: "Tahoma", stack: "Tahoma, Geneva, sans-serif" },
    { name: "Trebuchet MS", stack: "'Trebuchet MS', Tahoma, sans-serif" },
    { name: "Times New Roman", stack: "'Times New Roman', Times, serif" },
    { name: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
    { name: "Courier New", stack: "'Courier New', Courier, monospace" },
    { name: "Menlo", stack: "Menlo, Consolas, monospace" },
];

// Curated Google Fonts that all support extended Latin (Vietnamese, etc.)
// `weights` is the list of axis values we'll request from the API.
export const GOOGLE_FONTS: Array<{
    name: string;
    weights: number[];
    description?: string;
}> = [
    { name: "Roboto", weights: [400, 500, 700], description: "Google's default sans" },
    { name: "Open Sans", weights: [400, 600, 700] },
    { name: "Lato", weights: [400, 700, 900] },
    { name: "Montserrat", weights: [400, 600, 700] },
    { name: "Inter", weights: [400, 500, 600, 700] },
    { name: "Be Vietnam Pro", weights: [400, 500, 700], description: "Designed for Vietnamese" },
    { name: "Noto Sans", weights: [400, 700] },
    { name: "Noto Serif", weights: [400, 700] },
    { name: "Source Sans 3", weights: [400, 600, 700] },
    { name: "Poppins", weights: [400, 500, 600, 700] },
    { name: "Nunito", weights: [400, 600, 700] },
    { name: "Rubik", weights: [400, 500, 700] },
    { name: "Work Sans", weights: [400, 500, 700] },
    { name: "Raleway", weights: [400, 600, 700] },
    { name: "DM Sans", weights: [400, 500, 700] },
    { name: "Manrope", weights: [400, 600, 700] },
    { name: "Quicksand", weights: [400, 500, 700] },
    { name: "Anton", weights: [400], description: "Bold display" },
    { name: "Bebas Neue", weights: [400], description: "Tall condensed display" },
    { name: "Playfair Display", weights: [400, 700], description: "Elegant serif" },
    { name: "Merriweather", weights: [400, 700], description: "Readable serif" },
    { name: "JetBrains Mono", weights: [400, 700], description: "Code monospace" },
    { name: "Fira Code", weights: [400, 700] },
];

const loadedGoogleFonts = new Set<string>();

export function loadGoogleFont(family: string, weights?: number[]): void {
    if (typeof document === "undefined") return;
    const cfg = GOOGLE_FONTS.find((f) => f.name === family);
    const weightList = weights ?? cfg?.weights ?? [400, 700];
    const key = `${family}:${weightList.join(",")}`;
    if (loadedGoogleFonts.has(key)) return;
    loadedGoogleFonts.add(key);

    const familyParam = family.replace(/\s+/g, "+");
    const weightsParam = weightList.join(";");
    const href = `https://fonts.googleapis.com/css2?family=${familyParam}:wght@${weightsParam}&display=swap&subset=latin,latin-ext,vietnamese`;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    link.dataset.googleFont = family;
    document.head.appendChild(link);
}

const customFontStyles = new Map<string, HTMLStyleElement>();

export function registerCustomFont(name: string, dataUrl: string): void {
    if (typeof document === "undefined") return;
    const safeName = name.replace(/['"]/g, "");
    if (customFontStyles.has(safeName)) {
        const old = customFontStyles.get(safeName);
        old?.remove();
    }
    const style = document.createElement("style");
    style.dataset.customFont = safeName;
    style.textContent = `
@font-face {
    font-family: "${safeName}";
    src: url("${dataUrl}");
    font-display: swap;
}
`;
    document.head.appendChild(style);
    customFontStyles.set(safeName, style);
}

export function fontStackFor(
    source: FontSourceKind,
    family: string | undefined,
): string {
    if (!family) return "system-ui, sans-serif";
    if (source === "system") {
        const sys = SYSTEM_FONTS.find((f) => f.name === family);
        return sys?.stack ?? `"${family}", system-ui, sans-serif`;
    }
    if (source === "google") {
        return `"${family}", system-ui, sans-serif`;
    }
    if (source === "custom") {
        return `"${family}", system-ui, sans-serif`;
    }
    // Zebra built-in-font preview fallback.
    return "ui-monospace, SFMono-Regular, Menlo, monospace";
}
