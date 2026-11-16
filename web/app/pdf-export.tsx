"use client";

import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import type { LabelDoc } from "./types";
import { resolveDocForCopy, variablesForCopy } from "./label-data";
import { DesignerCanvas } from "./components/DesignerCanvas";
import { printRowIndexAt, selectPrintRowRange } from "./print-row-range";

// CSS reference DPI is 96, so 1mm = 96/25.4 CSS px. Sizing the inner content
// in these units lets the browser map it 1:1 to the @page mm-sized sheet.
const PX_PER_MM = 96 / 25.4;

export type PdfExportRange =
    | { kind: "copies"; count: number }
    | { kind: "feed"; fromIdx: number; toIdx: number };

interface Props {
    doc: LabelDoc;
    range: PdfExportRange;
    onDone: () => void;
    fileName?: string;
    // Fixed print-head width in mm (0 = auto, use the label width). Lets a
    // narrow label be placed within a wider fixed head instead of hugging the
    // left edge — for printers whose head can't narrow to the media.
    headWidthMm?: number;
    hAlign?: "left" | "center" | "right";
}

export function PdfExportFrame({
    doc,
    range,
    onDone,
    fileName,
    headWidthMm = 0,
    hAlign = "left",
}: Props) {
    const labels = useMemo(() => {
        if (range.kind === "feed") {
            const out: LabelDoc[] = [];
            const total = doc.dataFeed?.rows.length ?? 0;
            const selected = selectPrintRowRange(total, range.fromIdx + 1, range.toIdx + 1);
            for (let offset = 0; offset < selected.quantity; offset += 1) {
                const i = printRowIndexAt(selected, offset);
                out.push(resolveDocForCopy(doc, i, variablesForCopy(doc, i)));
            }
            return out;
        }
        const count = Math.max(1, Math.floor(range.count));
        return Array.from({ length: count }, (_, i) => {
            return resolveDocForCopy(doc, i, variablesForCopy(doc, i));
        });
    }, [doc, range]);

    useEffect(() => {
        if (typeof window === "undefined") return;

        const prevTitle = document.title;
        if (fileName) document.title = fileName;

        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            window.removeEventListener("afterprint", onAfterPrint);
            document.title = prevTitle;
            onDone();
        };
        const onAfterPrint = () => finish();
        window.addEventListener("afterprint", onAfterPrint);

        // Wait two frames so the portal has actually painted before the browser
        // freezes layout for the print dialog. Using rAF avoids the brittle
        // setTimeout(0) race seen on slower devices.
        const r1 = requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                try {
                    window.print();
                } finally {
                    // Some browsers (Safari) don't fire afterprint reliably; fall
                    // back to a microtask after print() returns. afterprint will
                    // still no-op due to the `finished` guard.
                    queueMicrotask(finish);
                }
            });
        });

        return () => {
            cancelAnimationFrame(r1);
            window.removeEventListener("afterprint", onAfterPrint);
            document.title = prevTitle;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (typeof document === "undefined") return null;

    // Clean any floating-point noise off the dimensions (e.g. 40.00000001 →
    // 40) but keep genuine fractional sizes like 101.6 mm (4"). A ragged
    // value can make some label drivers (Citizen) reject the requested page
    // size and silently fall back to their default stock — which is why a
    // small label ends up tiny in the corner of a Letter/A4 sheet.
    const w = Math.round(doc.settings.widthMm * 100) / 100;
    const h = Math.round(doc.settings.heightMm * 100) / 100;

    // Fixed-head support: when the print head is wider than the label, make the
    // printed page as wide as the head and place the label within it, instead of
    // requesting a narrow page the head can't honour (which leaves the label
    // stuck at the left of the full-width head).
    const headW = Math.round(Math.max(0, headWidthMm) * 100) / 100;
    const pageW = headW > w ? headW : w;
    const slack = Math.max(0, pageW - w);
    const leftMm =
        hAlign === "center" ? Math.round((slack / 2) * 100) / 100
        : hAlign === "right" ? slack
        : 0;

    return createPortal(
        <div className="pdf-export-frame" aria-hidden>
            <style>{`
                @page { size: ${pageW}mm ${h}mm; margin: 0; }
                @media screen {
                    .pdf-export-frame {
                        position: fixed;
                        left: -99999px;
                        top: 0;
                        width: 0;
                        height: 0;
                        overflow: hidden;
                        pointer-events: none;
                    }
                }
                @media print {
                    html, body {
                        background: #fff !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        /* Pin the body to the page width so the page doesn't
                           reflow against a wider default sheet when the driver
                           keeps its own stock size. */
                        width: ${pageW}mm !important;
                    }
                    body > *:not(.pdf-export-frame) { display: none !important; }
                    .pdf-export-frame {
                        position: static !important;
                        left: auto !important;
                        top: auto !important;
                        width: auto !important;
                        height: auto !important;
                        overflow: visible !important;
                        pointer-events: auto !important;
                    }
                    .pdf-export-frame .pdf-page {
                        box-sizing: border-box;
                        width: ${pageW}mm;
                        height: ${h}mm;
                        padding-left: ${leftMm}mm;
                        overflow: hidden;
                        page-break-inside: avoid;
                        break-inside: avoid;
                        page-break-after: always;
                        break-after: page;
                        background: #fff;
                    }
                    .pdf-export-frame .pdf-page:last-child {
                        page-break-after: auto;
                        break-after: auto;
                    }
                    /* Strip the on-screen rounded ring/border from the canvas
                       so the printed page edges are flush with the @page box. */
                    .pdf-export-frame .pdf-page > * { box-shadow: none !important; }
                    .pdf-export-frame .pdf-page [class*="rounded"] {
                        border-radius: 0 !important;
                    }
                    .pdf-export-frame .pdf-page [class*="ring"] {
                        box-shadow: none !important;
                    }
                }
            `}</style>
            {labels.map((labelDoc, i) => (
                <div key={i} className="pdf-page">
                    <DesignerCanvas
                        doc={labelDoc}
                        pxPerMm={PX_PER_MM}
                        readOnly
                        showRulers={false}
                        showGrid={false}
                        padding={0}
                    />
                </div>
            ))}
        </div>,
        document.body,
    );
}
