/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { QRCodeSVG } = require("qrcode.react");

// Exercise the real TypeScript helpers and ZPL generator without adding a
// second test runner to this small project.
require.extensions[".ts"] = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
            jsx: ts.JsxEmit.ReactJSX,
        },
        fileName: filename,
    }).outputText;
    module._compile(output, filename);
};
require.extensions[".tsx"] = require.extensions[".ts"];

const {
    DEFAULT_QR_MIN_MODULE_MM,
    QR_MIN_QUIET_ZONE_MODULES,
    encodeQrMatrix,
    fitQrToFrameDots,
    nativeQrSizing,
    qrModuleCount,
} = require(path.join(__dirname, "..", "app", "qr-sizing.ts"));
const { dotsToMm, mmToDots } = require(path.join(__dirname, "..", "app", "units.ts"));
const { buildZpl } = require(path.join(__dirname, "..", "app", "zpl.ts"));
const { QrElement } = require(
    path.join(__dirname, "..", "app", "components", "elements", "QrElement.tsx"),
);

function qrcodeReactModuleCount(data, ecc, minVersion) {
    const svg = renderToStaticMarkup(React.createElement(QRCodeSVG, {
        value: data || "QR",
        size: 21,
        level: ecc,
        minVersion,
        boostLevel: false,
        marginSize: 0,
    }));
    const match = svg.match(/viewBox="0 0 ([0-9.]+) ([0-9.]+)"/i);
    assert.ok(match, "qrcode.react SVG must expose its matrix width in viewBox");
    return Number(match[1]);
}

const helperSource = fs.readFileSync(
    path.join(__dirname, "..", "app", "qr-sizing.ts"),
    "utf8",
);
assert.doesNotMatch(
    helperSource,
    /(?:from|require\s*\()\s*["'](?:react|react-dom|qrcode\.react)/,
    "shared QR sizing helper must stay framework-independent for client/API bundles",
);

// Verify exact version selection against qrcode.react's bundled Nayuki
// encoder. These cover mode selection, v1 capacity boundaries, UTF-8 byte
// counts, all ECC levels, and an explicit minimum version.
const encoderParityCases = [
    ["1".repeat(34), "M"],
    ["1".repeat(35), "M"],
    ["A".repeat(20), "M"],
    ["A".repeat(21), "M"],
    ["a".repeat(14), "M"],
    ["a".repeat(15), "M"],
    ["Zebra Việt Nam 🦓", "M"],
    ["漢字とemoji🙂".repeat(12), "Q"],
    ["0123456789".repeat(80), "L"],
    ["mixed-case-byte-mode".repeat(25), "H"],
    ["MIN VERSION", "M", 12],
];
for (const [data, ecc, minVersion] of encoderParityCases) {
    const expectedModules = qrcodeReactModuleCount(data, ecc, minVersion);
    assert.equal(
        qrModuleCount(data, ecc, minVersion),
        expectedModules,
        `module count must match qrcode.react for ${ecc}/${minVersion ?? "auto"}: ${data.slice(0, 24)}`,
    );
    const matrix = encodeQrMatrix(data, ecc, minVersion);
    assert.equal(matrix.columns, expectedModules);
    assert.equal(matrix.rows, expectedModules);
    assert.equal(matrix.pixels.length, expectedModules * expectedModules);
}

assert.equal(qrModuleCount("1".repeat(34), "M"), 21);
assert.equal(qrModuleCount("1".repeat(35), "M"), 25);
assert.equal(qrModuleCount("A".repeat(20), "M"), 21);
assert.equal(qrModuleCount("A".repeat(21), "M"), 25);
assert.equal(qrModuleCount("a".repeat(14), "M"), 21);
assert.equal(qrModuleCount("a".repeat(15), "M"), 25);

const exactM = encodeQrMatrix("QR", "M");
assert.equal(exactM.columns, 21);
assert.equal(exactM.rows, 21);
assert.equal(exactM.pixels.length, 21 * 21);
assert.ok(exactM.pixels.some(Boolean), "encoded QR matrix must contain black modules");
const exactH = encodeQrMatrix("A".repeat(20), "H");
assert.equal(exactH.columns, qrModuleCount("A".repeat(20), "H"));
assert.equal(exactH.rows, exactH.columns);
assert.ok(exactH.columns > encodeQrMatrix("A".repeat(20), "M").columns);
const exactV5 = encodeQrMatrix("QR", "M", 5);
assert.equal(exactV5.columns, 37);
assert.equal(exactV5.rows, 37);
assert.throws(() => encodeQrMatrix("", "M"), /must not be empty/i);

const shortPayload = "QR";
const longPayload = "A".repeat(100);
const shortModules = qrModuleCount(shortPayload, "M");
const longModules = qrModuleCount(longPayload, "M");

assert.equal(shortModules, 21, "short ECC-M payload should select QR version 1");
assert.ok(longModules > shortModules, "payload length must affect the real module count");
assert.notEqual(longModules, 29, "long-payload sizing must not use the former fixed 29-module estimate");
assert.equal(qrModuleCount(shortPayload, "M", 5), 37, "minimum version 5 is a 37-module matrix");

// The QR frame remains 14 mm at every printer DPI. Auto sizing fits the Model
// 2 matrix plus the mandatory four-module quiet zone on every edge.
for (const dpi of [203, 300, 600]) {
    const frameDots = mmToDots(14, dpi);
    const layout = fitQrToFrameDots(frameDots, frameDots, shortModules, { dpi });
    const outerModules = shortModules + QR_MIN_QUIET_ZONE_MODULES * 2;
    assert.equal(layout.frameWidthDots, frameDots);
    assert.equal(layout.frameHeightDots, frameDots);
    assert.equal(layout.moduleDots, Math.floor(frameDots / outerModules));
    assert.equal(layout.quietZoneModules, QR_MIN_QUIET_ZONE_MODULES);
    assert.equal(layout.outerModuleCount, outerModules);
    assert.equal(layout.quietZoneDots, QR_MIN_QUIET_ZONE_MODULES * layout.moduleDots);
    assert.equal(layout.dataSideDots, shortModules * layout.moduleDots);
    assert.equal(layout.outerSideDots, outerModules * layout.moduleDots);
    assert.equal(layout.renderedSideDots, layout.dataSideDots);
    assert.equal(layout.offsetXDots, layout.dataOffsetXDots);
    assert.equal(layout.offsetYDots, layout.dataOffsetYDots);
    assert.ok(layout.fitsFrame);
    assert.ok(layout.outerSideDots <= frameDots);
    assert.ok(frameDots - layout.outerSideDots < outerModules);
}

// At 300 dpi, crossing an outer-matrix boundary changes size by exactly one
// whole printer dot per module. Four dots/module is just above the default
// 0.33 mm scan-safety threshold; three dots/module is below it.
const v1OuterModules = shortModules + QR_MIN_QUIET_ZONE_MODULES * 2;
const fourDotFrame = v1OuterModules * 4;
const fourDotLayout = fitQrToFrameDots(
    fourDotFrame,
    fourDotFrame + 7,
    shortModules,
    { dpi: 300 },
);
assert.equal(fourDotLayout.moduleDots, 4);
assert.equal(fourDotLayout.outerSideDots, fourDotFrame);
assert.equal(fourDotLayout.dataSideDots, shortModules * 4);
assert.equal(fourDotLayout.outerOffsetXDots, 0);
assert.equal(fourDotLayout.dataOffsetXDots, QR_MIN_QUIET_ZONE_MODULES * 4);
assert.equal(fourDotLayout.moduleSizeMm, dotsToMm(4, 300));
assert.equal(fourDotLayout.minModuleMm, DEFAULT_QR_MIN_MODULE_MM);
assert.equal(fourDotLayout.scanSafe, true);

const threeDotLayout = fitQrToFrameDots(
    fourDotFrame - 1,
    fourDotFrame - 1,
    shortModules,
    { dpi: 300 },
);
assert.equal(threeDotLayout.moduleDots, 3);
assert.equal(threeDotLayout.outerSideDots, v1OuterModules * 3);
assert.equal(threeDotLayout.fitsFrame, true);
assert.equal(threeDotLayout.moduleSizeMm, dotsToMm(3, 300));
assert.equal(threeDotLayout.scanSafe, false);
assert.equal(
    fitQrToFrameDots(fourDotFrame - 1, fourDotFrame - 1, shortModules, {
        dpi: 300,
        minModuleMm: 0.25,
    }).scanSafe,
    true,
    "the physical scan threshold must be configurable for a qualified application",
);

const leftTop = fitQrToFrameDots(200, 180, shortModules, {
    dpi: 300,
    requestedMagnification: 5,
    align: "left",
    verticalAlign: "top",
});
assert.equal(leftTop.outerOffsetXDots, 0);
assert.equal(leftTop.outerOffsetYDots, 0);
assert.equal(leftTop.align, "left");
assert.equal(leftTop.verticalAlign, "top");
const rightBottom = fitQrToFrameDots(200, 180, shortModules, {
    dpi: 300,
    requestedMagnification: 5,
    align: "right",
    verticalAlign: "bottom",
});
assert.equal(rightBottom.outerOffsetXDots, 200 - rightBottom.outerSideDots);
assert.equal(rightBottom.outerOffsetYDots, 180 - rightBottom.outerSideDots);
const centered = fitQrToFrameDots(200, 180, shortModules, {
    dpi: 300,
    requestedMagnification: 5,
});
assert.equal(centered.outerOffsetXDots, Math.floor((200 - centered.outerSideDots) / 2));
assert.equal(centered.outerOffsetYDots, Math.floor((180 - centered.outerSideDots) / 2));

const enlargedQuietZone = fitQrToFrameDots(200, 200, shortModules, {
    dpi: 300,
    quietZoneModules: 5,
});
assert.equal(enlargedQuietZone.quietZoneModules, 5);
assert.equal(enlargedQuietZone.outerModuleCount, shortModules + 10);
assert.equal(
    fitQrToFrameDots(200, 200, shortModules, { quietZoneModules: 0 }).quietZoneModules,
    QR_MIN_QUIET_ZONE_MODULES,
    "callers cannot request less than the Model 2 minimum quiet zone",
);

const manualOverflow = fitQrToFrameDots(200, 200, shortModules, {
    dpi: 300,
    requestedMagnification: 8,
});
assert.equal(manualOverflow.auto, false);
assert.equal(manualOverflow.desiredModuleDots, 8);
assert.equal(manualOverflow.moduleDots, 8);
assert.equal(manualOverflow.dataSideDots, shortModules * 8);
assert.equal(manualOverflow.outerSideDots, v1OuterModules * 8);
assert.equal(manualOverflow.fitsFrame, false);
assert.equal(manualOverflow.scanSafe, false);

// Auto native ^BQN magnification reserves the same external quiet zone. At
// 600 DPI the desired value is 11, and the legacy/native maximum forces 10.
const expectedNative = new Map([
    [203, { desired: 3, emitted: 3, limited: false }],
    [300, { desired: 5, emitted: 5, limited: false }],
    [600, { desired: 11, emitted: 10, limited: true }],
]);
for (const dpi of [203, 300, 600]) {
    const result = nativeQrSizing({
        frameWidthDots: mmToDots(14, dpi),
        frameHeightDots: mmToDots(14, dpi),
        moduleCount: shortModules,
        dpi,
    });
    const expected = expectedNative.get(dpi);
    assert.equal(result.auto, true);
    assert.equal(result.desiredMagnification, expected.desired);
    assert.equal(result.magnification, expected.emitted);
    assert.equal(result.limitedByNativeMax, expected.limited);
    assert.equal(result.outerModuleCount, v1OuterModules);
    assert.equal(result.outerSideDots, v1OuterModules * expected.emitted);
    assert.equal(result.dataSideDots, shortModules * expected.emitted);
    assert.equal(result.dataOffsetXDots, result.outerOffsetXDots + result.quietZoneDots);
    assert.equal(result.dataOffsetYDots, result.outerOffsetYDots + result.quietZoneDots);
    assert.equal(result.renderedSideDots, result.dataSideDots);
    assert.equal(result.fitsFrame, true);
    assert.equal(result.scanSafe, true);
}

const legacyOversize = nativeQrSizing({
    frameWidthDots: 500,
    frameHeightDots: 500,
    moduleCount: shortModules,
    requestedMagnification: 40,
});
assert.equal(legacyOversize.auto, false);
assert.equal(legacyOversize.magnification, 10);
assert.equal(legacyOversize.limitedByNativeMax, true);

const tooSmall = nativeQrSizing({
    frameWidthDots: 20,
    frameHeightDots: 20,
    moduleCount: shortModules,
    dpi: 300,
});
assert.equal(tooSmall.frameTooSmall, true);
assert.equal(tooSmall.fitsFrame, false);
assert.equal(tooSmall.scanSafe, false);

const nativeManualOverflow = nativeQrSizing({
    frameWidthDots: 200,
    frameHeightDots: 200,
    moduleCount: shortModules,
    requestedMagnification: 8,
    dpi: 300,
});
assert.equal(nativeManualOverflow.auto, false);
assert.equal(nativeManualOverflow.magnification, 8);
assert.equal(nativeManualOverflow.outerSideDots, v1OuterModules * 8);
assert.equal(nativeManualOverflow.fitsFrame, false);
assert.equal(nativeManualOverflow.scanSafe, false);

const previewEl = {
    id: "qr-preview",
    kind: "qr",
    pos: { x: 0, y: 0 },
    size: { w: 3, h: 3 },
    data: "ROTATE-ME",
    ecc: "M",
    cell: 4,
    sizeMode: "manual",
    magnification: 10,
    quietZoneModules: 4,
    minModuleMm: 0.25,
    align: "left",
    verticalAlign: "top",
};
const preview0 = renderToStaticMarkup(React.createElement(QrElement, {
    el: { ...previewEl, rotation: 0 },
    pxPerMm: 8,
    dpi: 300,
}));
const preview90 = renderToStaticMarkup(React.createElement(QrElement, {
    el: { ...previewEl, rotation: 90 },
    pxPerMm: 8,
    dpi: 300,
}));
assert.match(preview90, /data-rotation="90"/);
assert.match(preview90, /fill="#fff"/);
assert.match(preview90, /overflow-hidden/);
const previewPath0 = preview0.match(/<path d="([^"]+)" fill="#000"/);
const previewPath90 = preview90.match(/<path d="([^"]+)" fill="#000"/);
assert.ok(previewPath0 && previewPath90);
assert.notEqual(previewPath0[1], previewPath90[1], "90-degree preview must rotate the module grid");
assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(QrElement, {
    el: { ...previewEl, data: "A".repeat(10000), rotation: 270 },
    pxPerMm: 8,
    dpi: 300,
})));
const invalidPreview = renderToStaticMarkup(React.createElement(QrElement, {
    el: { ...previewEl, data: "A".repeat(10000), rotation: 270 },
    pxPerMm: 8,
    dpi: 300,
}));
assert.match(invalidPreview, /Invalid QR data/);

const baseRfid = {
    enabled: false,
    chip: "epc_96",
    epcBits: 96,
    format: "H",
    retries: 3,
    block: 2,
    words: 6,
    data: "",
    readEnabled: false,
};

function qrDoc(dpi, data, sizeMm = 14, patch = {}) {
    return {
        id: `qr-${dpi}`,
        name: `QR ${dpi}`,
        settings: {
            widthMm: 60,
            heightMm: 40,
            gapMm: 3,
            dpi,
            copies: 1,
            speed: 4,
            darkness: 10,
            serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
            rfid: baseRfid,
        },
        elements: [{
            id: "qr-test",
            kind: "qr",
            pos: { x: 2, y: 2 },
            size: { w: sizeMm, h: sizeMm },
            data,
            ecc: "M",
            cell: 4,
            version: 0,
            ...patch,
        }],
    };
}

const zpl600 = buildZpl(qrDoc(600, shortPayload));
assert.match(zpl600, /\^GFA,/);
assert.doesNotMatch(zpl600, /\^BQN/);

// Host-resolved QR output must always use the exact matrix shown by the
// designer instead of allowing firmware to choose a different mask/version.
const longZpl = buildZpl(qrDoc(300, longPayload, 30));
assert.match(longZpl, /\^GFA,/);
assert.doesNotMatch(longZpl, /\^BQN/);

const versionedNativeZpl = buildZpl(qrDoc(300, shortPayload, 15, { version: 5 }));
assert.match(versionedNativeZpl, /\^GFA,/);
assert.doesNotMatch(versionedNativeZpl, /\^BQN/);

const rotatedZpl = buildZpl(qrDoc(300, shortPayload, 14, { rotation: 90 }));
assert.match(rotatedZpl, /\^GFA,/);
assert.doesNotMatch(rotatedZpl, /\^BQN/);

const unicodeZpl = buildZpl(qrDoc(300, "Zebra Việt Nam 🦓", 30));
assert.match(unicodeZpl, /\^GFA,/);
assert.doesNotMatch(
    unicodeZpl,
    /\^BQN/,
    "UTF-8 QR data must use the exact host matrix because Zebra automatic ^BQ input is not general UTF-8",
);

const commandCharactersZpl = buildZpl(qrDoc(300, "A^B~C\\D", 20));
assert.match(commandCharactersZpl, /\^GFA,/);
assert.doesNotMatch(commandCharactersZpl, /\^BQN|A\^B~C/);

const overNativeFieldLimitZpl = buildZpl(qrDoc(300, "1".repeat(3100), 100));
assert.match(overNativeFieldLimitZpl, /\^GFA,/);
assert.doesNotMatch(overNativeFieldLimitZpl, /\^BQN/);

console.log("QR sizing regression tests passed (Model 2, quiet zone, scan safety, native limit).");
