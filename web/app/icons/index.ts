import { ICON_LIBRARY, type IconCategory, type IconDef } from "./library";

export type { IconCategory, IconDef } from "./library";
export { ICON_LIBRARY } from "./library";

export const CATEGORY_LABELS: Record<IconCategory, string> = {
    rfid: "RFID & Tracking",
    logistics: "Logistics",
    retail: "Retail / POS",
    editing: "Editing",
    status: "Status",
    food: "Food & Cold Chain",
    time: "Time & Date",
    measurement: "Measurement",
    security: "Security",
    general: "General",
};

export const CATEGORY_ORDER: IconCategory[] = [
    "rfid",
    "logistics",
    "retail",
    "status",
    "editing",
    "food",
    "time",
    "measurement",
    "security",
    "general",
];

export function svgToDataUrl(svg: string): string {
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const DEFAULT_ICON_WEIGHT = 1.5;

/**
 * Make an icon visually heavier or lighter regardless of whether it uses
 * stroke or fill. We do two things in one pass:
 *   1. If the SVG declares a stroke-width on the root, scale it.
 *   2. Wrap the SVG in an feMorphology filter (dilate when bolder, erode when
 *      thinner) — this is what actually changes solid/fill-only icons like
 *      the RFID and NFC badges.
 *
 * The dilation radius is sized relative to the icon's viewBox so the visual
 * effect is consistent across icons authored at different unit scales
 * (viewBox 0 0 24 24 vs. 0 0 512 512).
 */
export function renderIconSvg(svg: string, weight: number = DEFAULT_ICON_WEIGHT): string {
    const w = Number.isFinite(weight) && weight > 0 ? weight : DEFAULT_ICON_WEIGHT;
    const openingMatch = svg.match(/^<svg\b[^>]*>/);
    if (!openingMatch) return svg;
    const tag = openingMatch[0];

    // 1. If a stroke-width is declared on the root, scale it proportionally.
    //    Stroke-based icons get all of their boldness from this — we do NOT
    //    also apply morphology to them, otherwise the effect compounds.
    let nextTag = tag;
    const strokeMatch = nextTag.match(/stroke-width="([^"]*)"/);
    let scaledStroke = false;
    if (strokeMatch) {
        const base = parseFloat(strokeMatch[1]);
        const scaled = Number.isFinite(base) ? (base * w) / DEFAULT_ICON_WEIGHT : w;
        nextTag = nextTag.replace(
            /stroke-width="[^"]*"/,
            `stroke-width="${scaled.toFixed(3)}"`,
        );
        scaledStroke = true;
    }

    // No-op when at the default weight.
    if (Math.abs(w - DEFAULT_ICON_WEIGHT) < 0.01) {
        return nextTag + svg.slice(tag.length);
    }

    // Stroke-based icons are already adjusted via stroke-width.
    if (scaledStroke) {
        return nextTag + svg.slice(tag.length);
    }

    // 2. Fill-based icons: wrap with an feMorphology filter sized to the viewBox.
    const vbMatch = nextTag.match(
        /viewBox="\s*([\-\d.]+)\s+([\-\d.]+)\s+([\-\d.]+)\s+([\-\d.]+)\s*"/,
    );
    const vbW = vbMatch ? parseFloat(vbMatch[3]) : 24;
    const vbH = vbMatch ? parseFloat(vbMatch[4]) : 24;
    const baseSize = Math.max(1, Math.min(vbW, vbH));

    // Map weight (0.5..4) → radius. 1.5 is neutral (0). Each step of weight
    // gives roughly 2.5% of the viewBox in dilation.
    const delta = w - DEFAULT_ICON_WEIGHT;
    const radius = Math.abs(delta) * baseSize * 0.025;
    if (radius < baseSize * 0.001) {
        return nextTag + svg.slice(tag.length);
    }
    const operator = delta > 0 ? "dilate" : "erode";

    const filterId = `iw_${operator}_${radius.toFixed(3).replace(".", "_")}`;
    const filteredTag = nextTag.replace(
        /\s*\/?>$/,
        ` style="overflow:visible">`,
    );
    const filterDefs =
        `<defs><filter id="${filterId}" x="-25%" y="-25%" width="150%" height="150%">` +
        `<feMorphology operator="${operator}" radius="${radius.toFixed(3)}"/>` +
        `</filter></defs>` +
        `<g filter="url(#${filterId})">`;
    const inner = svg.slice(tag.length).replace(/<\/svg>\s*$/i, "</g></svg>");
    return filteredTag + filterDefs + inner;
}

export function findIconById(id: string): IconDef | undefined {
    return ICON_LIBRARY.find((i) => i.id === id);
}

export function searchIcons(query: string): IconDef[] {
    const q = query.trim().toLowerCase();
    if (!q) return ICON_LIBRARY;
    return ICON_LIBRARY.filter((icon) => {
        if (icon.id.includes(q)) return true;
        if (icon.name.toLowerCase().includes(q)) return true;
        if (icon.category.includes(q)) return true;
        return icon.keywords.some((k) => k.toLowerCase().includes(q));
    });
}

export function groupByCategory(icons: IconDef[]): Array<{ category: IconCategory; icons: IconDef[] }> {
    const groups = new Map<IconCategory, IconDef[]>();
    for (const icon of icons) {
        const arr = groups.get(icon.category) ?? [];
        arr.push(icon);
        groups.set(icon.category, arr);
    }
    return CATEGORY_ORDER.filter((c) => groups.has(c)).map((category) => ({
        category,
        icons: groups.get(category)!,
    }));
}
