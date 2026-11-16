"use client";

import { useMemo } from "react";
import type { LabelDoc } from "../types";
import { resolveDocForThumbnail } from "../sample-data";
import { DesignerCanvas } from "./DesignerCanvas";

interface Props {
    doc: LabelDoc;
    targetWidthPx?: number;
}

export function TemplateThumbnail({ doc, targetWidthPx = 220 }: Props) {
    const pxPerMm = Math.max(2, targetWidthPx / doc.settings.widthMm);
    const heightPx = doc.settings.heightMm * pxPerMm;
    const previewDoc = useMemo(() => resolveDocForThumbnail(doc), [doc]);
    return (
        <div
            className="rounded-[8px] overflow-hidden bg-neutral-100 dark:bg-neutral-800/50 ring-1 ring-black/[0.08] dark:ring-white/10 flex items-center justify-center"
            style={{
                width: targetWidthPx,
                height: Math.max(72, heightPx),
                aspectRatio: `${doc.settings.widthMm} / ${doc.settings.heightMm}`,
            }}
        >
            <DesignerCanvas
                doc={previewDoc}
                pxPerMm={pxPerMm}
                readOnly
                showRulers={false}
                showGrid={false}
                padding={0}
            />
        </div>
    );
}
