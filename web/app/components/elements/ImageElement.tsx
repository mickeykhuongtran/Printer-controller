"use client";

import { useEffect, useRef } from "react";
import { ImagePlus } from "lucide-react";
import type { ImageEl } from "../../types";
import { dotsPerMm } from "../../units";
import { decodeImage, drawContainedImage } from "../../image-layout";
import { rotationFrame } from "../../rotation";

interface Props {
    el: ImageEl;
    pxPerMm: number;
    dpi?: number;
    onUpdate?: (patch: Partial<ImageEl>) => void;
}

export function ImageElement({ el, pxPerMm, dpi = 203, onUpdate }: Props) {
    const widthPx = el.size.w * pxPerMm;
    const heightPx = el.size.h * pxPerMm;
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    // Match the backing store to the selected Zebra printhead. CSS dimensions
    // remain physical/zoom based, while each backing pixel represents one
    // printer dot at 8, 12, or 24 dpmm.
    const nativeDotsPerMm = dotsPerMm(dpi);
    const rasterW = Math.max(1, Math.round(el.size.w * nativeDotsPerMm));
    const rasterH = Math.max(1, Math.round(el.size.h * nativeDotsPerMm));
    const src = el.src;
    const threshold = el.threshold;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !src) return;
        canvas.width = rasterW;
        canvas.height = rasterH;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        let cancelled = false;
        void decodeImage(src).then((img) => {
            if (cancelled) return;
            ctx.clearRect(0, 0, rasterW, rasterH);
            const frame = rotationFrame({ w: rasterW, h: rasterH }, el.rotation);
            ctx.save();
            ctx.translate(frame.x, frame.y);
            ctx.rotate(frame.radians);
            drawContainedImage(ctx, img, 0, 0, frame.w, frame.h);
            ctx.restore();
        }).catch(() => {
            // An invalid source leaves an empty frame, as on the print path.
        });
        return () => {
            cancelled = true;
        };
    }, [src, rasterW, rasterH, el.rotation]);

    const onFile = (file: File) => {
        if (!onUpdate) return;
        const reader = new FileReader();
        reader.onload = () => {
            onUpdate({
                src: String(reader.result),
                fileName: file.name,
                iconId: undefined,
                iconWeight: undefined,
            });
        };
        reader.readAsDataURL(file);
    };

    if (!src) {
        // Read-only contexts (thumbnails) get a quiet dashed outline only —
        // no "Choose image" chrome, since the user can't act on it there.
        if (!onUpdate) {
            return (
                <div
                    className="bg-white border border-dashed border-black/20 dark:border-white/20"
                    style={{ width: widthPx, height: heightPx }}
                />
            );
        }
        // Editor chrome: scale icon and label so a 10×6mm LOGO holder doesn't
        // render full-size 16px icon + 10px text and overflow neighbouring
        // elements. Small boxes show only an icon; tiny boxes show nothing.
        const minDim = Math.min(widthPx, heightPx);
        const showText = widthPx >= 64 && heightPx >= 28;
        const showIcon = minDim >= 14;
        const iconSize = Math.max(8, Math.min(16, Math.floor(minDim * 0.35)));
        const fontPx = Math.max(8, Math.min(10, Math.floor(minDim * 0.18)));
        return (
            <div
                className="bg-white text-muted-foreground flex flex-col items-center justify-center gap-0.5 border border-dashed cursor-pointer hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors select-none overflow-hidden"
                style={{ width: widthPx, height: heightPx, fontSize: `${fontPx}px` }}
                onClick={(e) => {
                    e.stopPropagation();
                    fileInputRef.current?.click();
                }}
                title="Click to choose an image"
            >
                {showIcon && <ImagePlus style={{ width: iconSize, height: iconSize }} />}
                {showText && <span>Choose image</span>}
                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        e.target.value = "";
                        if (file) onFile(file);
                    }}
                />
            </div>
        );
    }
    return (
        <div
            className="overflow-hidden flex items-center justify-center"
            style={{ width: widthPx, height: heightPx }}
            onDoubleClick={(e) => {
                e.stopPropagation();
                fileInputRef.current?.click();
            }}
            title="Double-click to replace image"
        >
            <canvas
                ref={canvasRef}
                style={{
                    width: "100%",
                    height: "100%",
                    filter: `grayscale(1) contrast(${100 + threshold}%) brightness(${100 - threshold / 2}%)`,
                    imageRendering: "pixelated",
                }}
            />
            <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (file) onFile(file);
                }}
            />
        </div>
    );
}
