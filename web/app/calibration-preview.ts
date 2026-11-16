import type { LabelSettings } from "./types";

// SVG-only preview of the ruler calibration label. Printer output is generated
// separately as Zebra ZPL by buildCalibrationZpl().
export function buildCalibrationSvg(settings: LabelSettings): string {
    const widthMm = Math.max(10, settings.widthMm);
    const heightMm = Math.max(10, settings.heightMm);
    const width = widthMm * 8;
    const height = heightMm * 8;
    const mm = (value: number) => value * 8;

    const xAxisYmm = 3;
    const yAxisXmm = widthMm - 3;
    const parts: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet" style="display:block;background:#fff;border-radius:8px">`,
        `<line x1="0" y1="${mm(xAxisYmm)}" x2="${mm(widthMm)}" y2="${mm(xAxisYmm)}" stroke="#000" stroke-width="${mm(0.3)}"/>`,
    ];

    for (let xMm = 0; xMm <= widthMm; xMm += 1) {
        const major = xMm % 5 === 0;
        parts.push(
            `<line x1="${mm(xMm)}" y1="${mm(xAxisYmm)}" x2="${mm(xMm)}" y2="${mm(xAxisYmm + (major ? 1.4 : 0.6))}" stroke="#000" stroke-width="${mm(0.2)}"/>`,
        );
        if (major && xMm > 1 && xMm < yAxisXmm - 1) {
            parts.push(
                `<text x="${mm(xMm)}" y="${mm(xAxisYmm + 4)}" font-family="ui-monospace,monospace" font-size="${mm(1.8)}" text-anchor="middle" fill="#000">${xMm}</text>`,
            );
        }
    }

    parts.push(
        `<line x1="${mm(yAxisXmm)}" y1="0" x2="${mm(yAxisXmm)}" y2="${mm(heightMm)}" stroke="#000" stroke-width="${mm(0.3)}"/>`,
    );
    for (let yMm = 0; yMm <= heightMm; yMm += 1) {
        const major = yMm % 5 === 0;
        parts.push(
            `<line x1="${mm(yAxisXmm)}" y1="${mm(yMm)}" x2="${mm(yAxisXmm + (major ? 1.4 : 0.6))}" y2="${mm(yMm)}" stroke="#000" stroke-width="${mm(0.2)}"/>`,
        );
        if (major && yMm > xAxisYmm + 1 && yMm <= heightMm - 2) {
            parts.push(
                `<text x="${mm(yAxisXmm - 1)}" y="${mm(yMm + 0.7)}" font-family="ui-monospace,monospace" font-size="${mm(1.8)}" text-anchor="end" fill="#000">${yMm}</text>`,
            );
        }
    }

    parts.push(
        `<text x="${mm(yAxisXmm - 1)}" y="${mm(xAxisYmm - 0.6)}" font-family="ui-monospace,monospace" font-size="${mm(1.8)}" font-weight="700" text-anchor="end" fill="#000">0</text>`,
        "</svg>",
    );
    return parts.join("");
}
