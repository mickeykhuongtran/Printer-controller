"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
    previewBackingSize,
    renderLabelToPreviewCanvas,
} from "../full-page-raster";
import type { LabelDoc } from "../types";
import { DEFAULT_DPI, mmToDots } from "../units";

interface PrintFidelityPreviewProps {
    doc: LabelDoc;
    copyIndex?: number;
    displayWidthPx: number;
    displayHeightPx: number;
    /** Omit for exact native-dot fidelity; set for memory-bounded thumbnails. */
    maxBackingPixels?: number;
    className?: string;
    ariaLabel?: string;
}

type RenderResult = {
    doc: LabelDoc;
    copyIndex: number;
    backingWidthPx: number;
    backingHeightPx: number;
    status: "ready" | "error";
};

/**
 * Printer-dot-accurate label preview.
 *
 * By default the canvas bitmap stays at the printer's native dot dimensions.
 * Thumbnail callers can provide a pixel budget; native dimensions remain
 * exposed as metadata while the allocated backing bitmap stays bounded.
 */
export function PrintFidelityPreview({
    doc,
    copyIndex = 0,
    displayWidthPx,
    displayHeightPx,
    maxBackingPixels,
    className,
    ariaLabel = "Print-fidelity label preview",
}: PrintFidelityPreviewProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const [renderResult, setRenderResult] = useState<RenderResult | null>(null);
    const dpi = doc.settings.dpi ?? DEFAULT_DPI;
    const nativeWidthDots = Math.max(1, mmToDots(doc.settings.widthMm, dpi));
    const nativeHeightDots = Math.max(1, mmToDots(doc.settings.heightMm, dpi));
    const bounded = maxBackingPixels !== undefined;
    const maxBackingWidthPx = bounded
        ? Math.max(1, Math.ceil(Number.isFinite(displayWidthPx) ? displayWidthPx : 1))
        : undefined;
    const maxBackingHeightPx = bounded
        ? Math.max(1, Math.ceil(Number.isFinite(displayHeightPx) ? displayHeightPx : 1))
        : undefined;
    const backing = previewBackingSize(nativeWidthDots, nativeHeightDots, {
        maxBackingPixels,
        maxBackingWidthPx,
        maxBackingHeightPx,
    });
    const resultIsCurrent =
        renderResult?.doc === doc &&
        renderResult.copyIndex === copyIndex &&
        renderResult.backingWidthPx === backing.widthPx &&
        renderResult.backingHeightPx === backing.heightPx;
    const previewState = resultIsCurrent ? renderResult.status : "loading";

    useEffect(() => {
        let cancelled = false;

        const render = async () => {
            try {
                const source = await renderLabelToPreviewCanvas(
                    doc,
                    copyIndex,
                    bounded
                        ? {
                              maxBackingPixels,
                              maxBackingWidthPx,
                              maxBackingHeightPx,
                          }
                        : undefined,
                );
                if (cancelled) return;
                if (!source) {
                    throw new Error("The browser could not create a preview canvas.");
                }

                const target = canvasRef.current;
                if (!target) return;

                // React normally sets the expected backing attributes first;
                // this also guards against a renderer returning a differently
                // rounded native or bounded size.
                if (target.width !== source.width) target.width = source.width;
                if (target.height !== source.height) target.height = source.height;
                const ctx = target.getContext("2d");
                if (!ctx) {
                    throw new Error("The browser could not open the preview canvas.");
                }
                ctx.imageSmoothingEnabled = false;
                ctx.clearRect(0, 0, target.width, target.height);
                ctx.drawImage(source, 0, 0);

                if (!cancelled) {
                    setRenderResult({
                        doc,
                        copyIndex,
                        backingWidthPx: source.width,
                        backingHeightPx: source.height,
                        status: "ready",
                    });
                }
            } catch (error) {
                if (cancelled) return;
                console.error("[preview] print-fidelity render failed:", error);
                setRenderResult({
                    doc,
                    copyIndex,
                    backingWidthPx: backing.widthPx,
                    backingHeightPx: backing.heightPx,
                    status: "error",
                });
            }
        };

        void render();
        return () => {
            cancelled = true;
        };
    }, [
        backing.heightPx,
        backing.widthPx,
        bounded,
        copyIndex,
        doc,
        maxBackingHeightPx,
        maxBackingPixels,
        maxBackingWidthPx,
    ]);

    return (
        <div
            className={cn(
                "relative shrink-0 overflow-hidden rounded-[10px] bg-white ring-1 ring-black/[0.08] dark:ring-white/10",
                className,
            )}
            style={{ width: displayWidthPx, height: displayHeightPx }}
            data-native-width-dots={nativeWidthDots}
            data-native-height-dots={nativeHeightDots}
            data-backing-width-px={backing.widthPx}
            data-backing-height-px={backing.heightPx}
            data-preview-resolution={bounded ? "bounded" : "native"}
            data-preview-state={previewState}
            aria-busy={previewState === "loading"}
        >
            <canvas
                ref={canvasRef}
                width={backing.widthPx}
                height={backing.heightPx}
                className={cn(
                    "block",
                    previewState !== "ready" && "invisible",
                )}
                style={{
                    width: displayWidthPx,
                    height: displayHeightPx,
                    imageRendering: "pixelated",
                }}
                data-native-width-dots={nativeWidthDots}
                data-native-height-dots={nativeHeightDots}
                data-backing-width-px={backing.widthPx}
                data-backing-height-px={backing.heightPx}
                data-preview-resolution={bounded ? "bounded" : "native"}
                data-copy-index={copyIndex}
                aria-label={ariaLabel}
            />
            {previewState !== "ready" && (
                <div
                    className="absolute inset-0 flex items-center justify-center bg-white px-2 text-center text-[10px] text-neutral-600"
                    role={previewState === "error" ? "alert" : "status"}
                >
                    {previewState === "error" ? "Preview unavailable" : "Rendering…"}
                </div>
            )}
        </div>
    );
}
