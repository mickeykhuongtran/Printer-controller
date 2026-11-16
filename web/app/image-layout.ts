/** Image frames are editable independently; the source is always contained,
 * centered and uncropped. Use the same printer-dot geometry in every renderer. */
export function imageFitRect(
    sourceWidth: number,
    sourceHeight: number,
    frameWidth: number,
    frameHeight: number,
): { x: number; y: number; w: number; h: number } {
    const scale = Math.min(frameWidth / sourceWidth, frameHeight / sourceHeight);
    const w = Math.max(1, Math.min(frameWidth, Math.round(sourceWidth * scale)));
    const h = Math.max(1, Math.min(frameHeight, Math.round(sourceHeight * scale)));
    return {
        x: Math.round((frameWidth - w) / 2),
        y: Math.round((frameHeight - h) / 2),
        w,
        h,
    };
}

const sourceSizes = new WeakMap<HTMLImageElement, { w: number; h: number }>();

// A viewBox-only SVG otherwise gets a browser-default viewport (e.g. 38×150
// for a 1:4 source). Do not derive its ratio from those rounded dimensions.
function svgSource(src: string): { src: string; size?: { w: number; h: number } } {
    if (!/^data:image\/svg\+xml[;,]/i.test(src)) return { src };
    try {
        const comma = src.indexOf(",");
        const payload = src.slice(comma + 1);
        const xml = /;base64/i.test(src.slice(0, comma))
            ? new TextDecoder().decode(Uint8Array.from(atob(payload), (c) => c.charCodeAt(0)))
            : decodeURIComponent(payload);
        const doc = new DOMParser().parseFromString(xml, "image/svg+xml");
        if (doc.querySelector("parsererror") || doc.documentElement.localName !== "svg") return { src };
        const svg = doc.documentElement as unknown as SVGSVGElement;
        const viewBox = svg.viewBox.baseVal;
        const aspect = viewBox.width > 0 && viewBox.height > 0 ? viewBox.width / viewBox.height : 0;
        const dimension = (name: "width" | "height") => {
            const value = svg.getAttribute(name);
            if (!value || value.includes("%") || value === "auto") return 0;
            return svg[name].baseVal.value;
        };
        let w = dimension("width"), h = dimension("height");
        if (aspect > 0) {
            if (!(w > 0) && !(h > 0)) {
                w = viewBox.width;
                h = viewBox.height;
            } else if (!(w > 0)) w = h * aspect;
            else if (!(h > 0)) h = w / aspect;
        }
        if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return { src };
        // Set a viewport in source units, never in destination-frame units.
        svg.setAttribute("width", String(w));
        svg.setAttribute("height", String(h));
        return {
            src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`,
            size: { w, h },
        };
    } catch {
        return { src };
    }
}

export function decodeImage(src: string): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
        const source = svgSource(src);
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
            if (source.size) sourceSizes.set(img, source.size);
            resolve(img);
        };
        img.onerror = () => reject(new Error("Failed to decode image"));
        // Keep the original SVG viewport/viewBox as well as raster dimensions.
        // Rewriting SVG width/height to the frame changes the source's ratio.
        img.src = source.src;
    });
}

export function drawContainedImage(
    ctx: CanvasRenderingContext2D,
    img: HTMLImageElement,
    x: number,
    y: number,
    frameWidth: number,
    frameHeight: number,
): void {
    const source = sourceSizes.get(img);
    const fit = imageFitRect(
        source?.w ?? (img.naturalWidth || img.width),
        source?.h ?? (img.naturalHeight || img.height),
        frameWidth,
        frameHeight,
    );
    ctx.save();
    try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, x + fit.x, y + fit.y, fit.w, fit.h);
    } finally {
        ctx.restore();
    }
}
