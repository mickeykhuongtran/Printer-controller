/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
        fileName: filename,
    }).outputText;
    module._compile(output, filename);
};

const { normalizeZebraDocument } = require(
    path.join(__dirname, "..", "app", "zebra-document.ts"),
);

const baseSettings = {
    widthMm: 60,
    heightMm: 40,
    gapMm: 3,
    dpi: 300,
    copies: 1,
    speed: 4,
    darkness: 10,
    serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
    rfid: {
        enabled: false,
        chip: "epc_96",
        epcBits: 96,
        format: "H",
        retries: 3,
        block: 2,
        words: 6,
        data: "",
    },
};

const legacy = {
    id: "legacy-symbols",
    name: "Legacy symbols",
    settings: baseSettings,
    elements: [
        {
            id: "qr-fixed",
            kind: "qr",
            pos: { x: 1, y: 1 },
            size: { w: 14, h: 14 },
            data: "QR",
            ecc: "M",
            cell: 4,
            magnification: 5,
        },
        {
            id: "qr-auto",
            kind: "qr",
            pos: { x: 16, y: 1 },
            size: { w: 14, h: 14 },
            data: "QR",
            ecc: "M",
            cell: 4,
        },
        {
            id: "barcode-wide-only",
            kind: "barcode",
            pos: { x: 1, y: 18 },
            size: { w: 50, h: 12 },
            data: "123456",
            symbology: "CODE128",
            humanReadable: true,
            wideDots: 6,
            textSize: 2,
            textPadding: 0.3,
        },
        {
            id: "barcode-editor-px",
            kind: "barcode",
            pos: { x: 1, y: 32 },
            size: { w: 50, h: 12 },
            data: "123456",
            symbology: "CODE128",
            humanReadable: true,
            textSize: 10,
            textPadding: 1,
        },
        {
            id: "barcode-rotated-height",
            kind: "barcode",
            pos: { x: 54, y: 1 },
            size: { w: 8, h: 20 },
            data: "ROTATED",
            symbology: "CODE128",
            humanReadable: false,
            rotation: 90,
            barHeightMm: 15,
        },
        {
            id: "datamatrix-legacy",
            kind: "datamatrix",
            pos: { x: 40, y: 1 },
            size: { w: 14, h: 14 },
            data: "DM",
            magnification: 99,
            quietZoneModules: 0,
            contentFormat: "unknown",
            shape: "unknown",
            textEncoding: "unknown",
        },
    ],
};

const normalized = normalizeZebraDocument(legacy);
assert.equal(normalized.symbolConfigVersion, 2);

const qrFixed = normalized.elements.find((element) => element.id === "qr-fixed");
assert.equal(qrFixed.sizeMode, "manual");
assert.equal(qrFixed.magnification, 5);
assert.equal(qrFixed.quietZoneModules, 4);
assert.equal(qrFixed.minModuleMm, 0.33);
assert.equal(qrFixed.version, 0);

const qrAuto = normalized.elements.find((element) => element.id === "qr-auto");
assert.equal(qrAuto.sizeMode, "auto");
assert.equal(qrAuto.magnification, undefined);
assert.equal(qrAuto.quietZoneModules, 4);
assert.equal(qrAuto.minModuleMm, 0.33);
assert.equal(qrAuto.version, 0);

const barcode = normalized.elements.find((element) => element.id === "barcode-wide-only");
assert.equal(barcode.sizeMode, "manual");
assert.equal(barcode.narrowDots, 3, "300 dpi migration must use a scan-safe 3-dot X-dimension");
assert.equal(barcode.wideDots, undefined);
assert.equal(barcode.minModuleMm, 0.25);
assert.equal(barcode.textSizeMm, 2);
assert.equal(barcode.textPaddingMm, 0.3);
assert.equal(barcode.textSize, undefined);
assert.equal(barcode.textPadding, undefined);

const editorPxBarcode = normalized.elements.find((element) => element.id === "barcode-editor-px");
assert.equal(editorPxBarcode.textSizeMm, 1.25);
assert.equal(editorPxBarcode.textPaddingMm, 0.125);

const rotatedBarcode = normalized.elements.find((element) => element.id === "barcode-rotated-height");
assert.equal(rotatedBarcode.rotation, 90);
assert.equal(
    rotatedBarcode.barHeightMm,
    8,
    "Quarter-turn bar height must be clamped against the frame width/logical symbol height",
);

const dataMatrix = normalized.elements.find((element) => element.id === "datamatrix-legacy");
assert.equal(dataMatrix.contentFormat, "standard");
assert.equal(dataMatrix.shape, "square");
assert.equal(dataMatrix.textEncoding, "utf8");
assert.equal(dataMatrix.sizeMode, "manual");
assert.equal(dataMatrix.magnification, 40);
assert.equal(dataMatrix.quietZoneModules, 1);
assert.equal(dataMatrix.minModuleMm, 0.25);
assert.equal(dataMatrix.align, "center");
assert.equal(dataMatrix.verticalAlign, "center");

assert.deepEqual(
    normalizeZebraDocument(normalized),
    normalized,
    "Symbol Config V2 normalization must be idempotent",
);

console.log("Symbol Config V2 migration tests passed.");
