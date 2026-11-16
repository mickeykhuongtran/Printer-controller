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

const {
    barcodeHeightLayout,
    barcodeNarrowDotsForMm,
    barcodeModuleLayout,
    ean13CheckDigit,
    isSupportedCode128Data,
    normalizeEan13,
    renderBarcode,
} = require(path.join(__dirname, "..", "app", "barcode.ts"));
const { buildZpl } = require(path.join(__dirname, "..", "app", "zpl.ts"));

assert.equal(barcodeNarrowDotsForMm(300, 0.33), 4);
assert.equal(barcodeNarrowDotsForMm(600, 0.33), 8);

const numeric24 = renderBarcode("123456789012345678901234", "CODE128");
const epcHex24 = renderBarcode("E2800300000000F13021ADE1", "CODE128");
assert.ok(numeric24);
assert.ok(epcHex24);
assert.equal(numeric24.symbolModules, 167);
assert.equal(numeric24.totalModules, 187);
assert.equal(epcHex24.symbolModules, 255);
assert.equal(epcHex24.totalModules, 275);
assert.equal(
    epcHex24.totalModules - numeric24.totalModules,
    88,
    "numeric Code Set C packing must be narrower than the same-length EPC HEX payload",
);

const numericSuffix = renderBarcode("ABC5434", "CODE128");
const alphaSuffix = renderBarcode("ABCWXYZ", "CODE128");
assert.ok(numericSuffix);
assert.ok(alphaSuffix);
assert.equal(
    alphaSuffix.totalModules - numericSuffix.totalModules,
    11,
    "a four-digit suffix must save one Code 128 codeword by switching to Set C",
);

assert.equal(isSupportedCode128Data("ASCII 123 > TEST"), true);
assert.equal(isSupportedCode128Data(""), false);
assert.equal(isSupportedCode128Data("line\nbreak"), false);
assert.equal(isSupportedCode128Data("café"), false);
assert.equal(isSupportedCode128Data(`DEL${String.fromCharCode(127)}`), false);
assert.equal(renderBarcode("line\nbreak", "CODE128"), null);
assert.equal(renderBarcode("café", "CODE128"), null);

assert.equal(ean13CheckDigit("590123412345"), 7);
assert.equal(normalizeEan13("590123412345"), "5901234123457");
assert.equal(normalizeEan13("5901234123457"), "5901234123457");
assert.equal(normalizeEan13("5901234123458"), null);
assert.equal(normalizeEan13("590-123412345"), null);
assert.equal(normalizeEan13(" 590123412345"), null);
assert.equal(normalizeEan13("59012341234A"), null);
assert.equal(ean13CheckDigit("59012341234A"), null);
assert.equal(renderBarcode("5901234123458", "EAN13"), null);
assert.equal(renderBarcode("590-1234123457", "EAN13"), null);

const ean = renderBarcode("590123412345", "EAN13");
assert.ok(ean);
assert.equal(ean.render, "5901234123457");
assert.equal(ean.symbolModules, 95);
assert.equal(ean.quietZoneLeftModules, 11);
assert.equal(ean.quietZoneRightModules, 7);
assert.equal(ean.quietZoneModules, 11, "legacy alias must retain the leading quiet zone");
assert.equal(ean.totalModules, 113);

const auto34mm300 = barcodeModuleLayout({
    containerDots: 34 * 12,
    totalModules: epcHex24.totalModules,
    quietZoneLeftModules: epcHex24.quietZoneLeftModules,
    quietZoneRightModules: epcHex24.quietZoneRightModules,
    dpi: 300,
    mode: "auto",
});
assert.equal(auto34mm300.mode, "auto");
assert.equal(auto34mm300.containerDots, 408);
assert.equal(auto34mm300.totalModules, 275);
assert.equal(auto34mm300.dotsPerModule, 1);
assert.equal(auto34mm300.narrowDots, 1, "legacy narrowDots alias must remain available");
assert.equal(auto34mm300.xDimensionMm, 1 / 12);
assert.equal(auto34mm300.printedWidthDots, 275);
assert.equal(auto34mm300.printedWidthMm, 275 / 12);
assert.equal(auto34mm300.fitsFrame, true);
assert.equal(auto34mm300.scanSafe, false);
assert.equal(auto34mm300.overflow, false);
assert.equal(auto34mm300.overflowDots, 0);
assert.equal(auto34mm300.overflowMm, 0);
assert.equal(auto34mm300.requiredSafeWidthDots, 825);
assert.equal(auto34mm300.requiredSafeWidthMm, 68.75);

const fixed34mm300 = barcodeModuleLayout({
    containerDots: 34 * 12,
    totalModules: epcHex24.totalModules,
    quietZoneLeftModules: epcHex24.quietZoneLeftModules,
    quietZoneRightModules: epcHex24.quietZoneRightModules,
    dpi: 300,
    mode: "fixed",
    requestedDotsPerModule: 3,
});
assert.equal(fixed34mm300.mode, "fixed");
assert.equal(fixed34mm300.dotsPerModule, 3);
assert.equal(fixed34mm300.xDimensionMm, 0.25);
assert.equal(fixed34mm300.printedWidthDots, 825);
assert.equal(fixed34mm300.printedWidthMm, 68.75);
assert.equal(fixed34mm300.fitsFrame, false);
assert.equal(fixed34mm300.scanSafe, false);
assert.equal(fixed34mm300.overflow, true);
assert.equal(fixed34mm300.overflowDots, 417);
assert.equal(fixed34mm300.overflowMm, 34.75);

const legacyManual = barcodeModuleLayout({
    containerDots: 34 * 12,
    totalModules: epcHex24.totalModules,
    quietZoneModules: epcHex24.quietZoneModules,
    dpi: 300,
    manualNarrowDots: 3,
});
assert.equal(legacyManual.mode, "fixed");
assert.equal(legacyManual.narrowDots, fixed34mm300.narrowDots);
assert.equal(legacyManual.printedWidthDots, fixed34mm300.printedWidthDots);
assert.equal(legacyManual.overflowDots, fixed34mm300.overflowDots);

const hriHeight = barcodeHeightLayout({
    frameHeightDots: 180,
    dpi: 300,
    humanReadable: true,
    barHeightMm: 10,
    textSizeMm: 2,
    textPaddingMm: 0.5,
    textPosition: "above",
});
assert.equal(hriHeight.barHeightDots, 120);
assert.equal(hriHeight.textHeightDots, 24);
assert.equal(hriHeight.textPaddingDots, 6);
assert.equal(hriHeight.barsOffsetDots, 30);
assert.equal(hriHeight.textOffsetDots, 0);
assert.equal(hriHeight.totalHeightDots, 150);
assert.equal(hriHeight.fitsFrame, true);

const eanZpl = buildZpl({
    id: "ean-zpl",
    name: "EAN ZPL",
    settings: {
        widthMm: 60,
        heightMm: 30,
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
    },
    elements: [{
        id: "ean",
        kind: "barcode",
        pos: { x: 2, y: 2 },
        size: { w: 50, h: 15 },
        data: "5901234123457",
        symbology: "EAN13",
        humanReadable: true,
    }],
});
assert.match(eanZpl, /\^GFA,/);
assert.doesNotMatch(
    eanZpl,
    /\^BE/,
    "host-resolved EAN-13 must use exact bars instead of firmware-dependent native HRI",
);
assert.match(eanZpl, /\^FD5\^FS/);
assert.match(eanZpl, /\^FD901234\^FS/);
assert.match(eanZpl, /\^FD123457\^FS/);

const specialCode128Zpl = buildZpl({
    id: "code128-special",
    name: "Code 128 special characters",
    settings: {
        widthMm: 120,
        heightMm: 30,
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
    },
    elements: [{
        id: "special",
        kind: "barcode",
        pos: { x: 2, y: 2 },
        size: { w: 100, h: 15 },
        data: "A^B>C~D\\E",
        symbology: "CODE128",
        humanReadable: false,
    }],
});
assert.match(specialCode128Zpl, /\^GFA,/);
assert.doesNotMatch(
    specialCode128Zpl,
    /\^BC|A\^B>C~D/,
    "host-resolved Code 128 must be emitted as the exact safe graphic shown by the designer",
);

const customHriZpl = buildZpl({
    id: "code128-hri",
    name: "Code 128 custom HRI",
    settings: {
        widthMm: 120,
        heightMm: 30,
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
    },
    elements: [{
        id: "hri",
        kind: "barcode",
        pos: { x: 2, y: 2 },
        size: { w: 100, h: 15 },
        data: "ABC123",
        symbology: "CODE128",
        humanReadable: true,
        textAlign: "right",
        textSizeMm: 2,
        textPaddingMm: 0.5,
    }],
});
assert.match(customHriZpl, /\^GFA,/);
assert.doesNotMatch(customHriZpl, /\^BC/);
assert.match(customHriZpl, /\^FO24,180\^A0N,24,24\^FB1200,1,0,R,0\^FH\\\^FDABC123\^FS/);

const rotatedCode128Zpl = buildZpl({
    id: "code128-rotated",
    name: "Rotated Code 128",
    settings: {
        widthMm: 70,
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
    },
    elements: [{
        id: "rotated",
        kind: "barcode",
        pos: { x: 2, y: 3 },
        size: { w: 50, h: 30 },
        data: "123456",
        symbology: "CODE128",
        humanReadable: false,
        rotation: 90,
        sizeMode: "manual",
        narrowDots: 3,
        align: "left",
        minModuleMm: 0.25,
    }],
});
assert.match(rotatedCode128Zpl, /\^FO24,36\^GFA,/);
assert.doesNotMatch(rotatedCode128Zpl, /\^BCR|\^BY/);

console.log("Barcode core tests passed.");
