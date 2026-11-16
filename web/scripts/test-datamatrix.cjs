/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

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
    encodeDataMatrix,
    fitDataMatrixToFrameDots,
} = require(path.join(__dirname, "..", "app", "datamatrix.ts"));
const { dotsToMm } = require(path.join(__dirname, "..", "app", "units.ts"));
const { preflightLabelForPrinter } = require(
    path.join(__dirname, "..", "app", "dpi-preflight.ts"),
);
const { buildZpl } = require(path.join(__dirname, "..", "app", "zpl.ts"));
const { DataMatrixElement } = require(
    path.join(__dirname, "..", "app", "components", "elements", "DataMatrixElement.tsx"),
);

const square = encodeDataMatrix("0123456789");
assert.equal(square.columns, 12);
assert.equal(square.rows, 12);
assert.equal(square.pixels.length, 144);

const rectangle = encodeDataMatrix("0123456789", { shape: "rectangle" });
assert.equal(rectangle.columns, 18);
assert.equal(rectangle.rows, 8);
assert.equal(rectangle.pixels.length, 144);

const fixedSquare = encodeDataMatrix("0123456789", {
    shape: "square",
    symbolRows: 16,
    symbolColumns: 16,
});
assert.equal(fixedSquare.columns, 16);
assert.equal(fixedSquare.rows, 16);
assert.notEqual(fixedSquare, square, "fixed size must not reuse the auto-size cache entry");
assert.equal(
    encodeDataMatrix("0123456789", {
        shape: "square",
        symbolRows: 16,
        symbolColumns: 16,
    }),
    fixedSquare,
    "identical fixed-size requests should use the matrix cache",
);
const fixedRectangle = encodeDataMatrix("0123456789", {
    shape: "rectangle",
    symbolRows: 8,
    symbolColumns: 18,
});
assert.equal(fixedRectangle.columns, 18);
assert.equal(fixedRectangle.rows, 8);
assert.throws(
    () => encodeDataMatrix("DM", { shape: "square", symbolRows: 8, symbolColumns: 18 }),
    /not a supported square Data Matrix ECC 200 size/i,
);
assert.throws(
    () => encodeDataMatrix("DM", { shape: "rectangle", symbolRows: 18, symbolColumns: 8 }),
    /not a supported rectangle Data Matrix ECC 200 size/i,
);
assert.throws(
    () => encodeDataMatrix("DM", { symbolRows: 12 }),
    /requires both rows and columns/i,
);
assert.throws(
    () => encodeDataMatrix("A".repeat(100), {
        shape: "square",
        symbolRows: 10,
        symbolColumns: 10,
    }),
    /Maximum length exceeded|invalid size/i,
);

const gs1 = encodeDataMatrix("(01)09501101530003(17)251231(10)ABC123", {
    contentFormat: "gs1",
});
assert.equal(gs1.columns, 20);
assert.equal(gs1.rows, 20);
assert.throws(
    () => encodeDataMatrix("09501101530003", { contentFormat: "gs1" }),
    /AIs must start with/i,
);

const digitalLink = encodeDataMatrix(
    "https://id.gs1.org/01/09501101530003/10/ABC123",
    { contentFormat: "gs1_digital_link" },
);
assert.equal(digitalLink.columns, 24);
assert.equal(digitalLink.rows, 24);
assert.throws(
    () => encodeDataMatrix("https://example.com", { contentFormat: "gs1_digital_link" }),
    /domain and path/i,
);

assert.doesNotThrow(() => encodeDataMatrix("café", { textEncoding: "latin1" }));
assert.throws(
    () => encodeDataMatrix("漢字", { textEncoding: "latin1" }),
    /ISO-8859-1/,
);
assert.throws(
    () => encodeDataMatrix("(01)09501101530003", {
        contentFormat: "gs1",
        textEncoding: "latin1",
    }),
    /require UTF-8/i,
);

const autoLayout = fitDataMatrixToFrameDots(168, 168, 12, 12, {
    dpi: 300,
    quietZoneModules: 1,
});
assert.equal(autoLayout.moduleDots, 12);
assert.equal(autoLayout.outerWidthDots, 168);
assert.equal(autoLayout.outerHeightDots, 168);
assert.equal(autoLayout.fitsFrame, true);
assert.equal(autoLayout.scanSafe, true);
assert.equal(autoLayout.moduleSizeMm, dotsToMm(12, 300));

const leftTop = fitDataMatrixToFrameDots(120, 100, 12, 12, {
    dpi: 300,
    quietZoneModules: 1,
    requestedMagnification: 5,
    align: "left",
    verticalAlign: "top",
});
assert.equal(leftTop.outerOffsetXDots, 0);
assert.equal(leftTop.outerOffsetYDots, 0);
const rightBottom = fitDataMatrixToFrameDots(120, 100, 12, 12, {
    dpi: 300,
    quietZoneModules: 1,
    requestedMagnification: 5,
    align: "right",
    verticalAlign: "bottom",
});
assert.equal(rightBottom.outerOffsetXDots, 120 - rightBottom.outerWidthDots);
assert.equal(rightBottom.outerOffsetYDots, 100 - rightBottom.outerHeightDots);

const fixedOverflow = fitDataMatrixToFrameDots(100, 100, 20, 20, {
    dpi: 300,
    quietZoneModules: 1,
    requestedMagnification: 5,
});
assert.equal(fixedOverflow.auto, false);
assert.equal(fixedOverflow.outerWidthDots, 110);
assert.equal(fixedOverflow.fitsFrame, false);

const previewElement = {
    id: "dm-preview",
    kind: "datamatrix",
    pos: { x: 0, y: 0 },
    size: { w: 18, h: 10 },
    data: "0123456789",
    contentFormat: "standard",
    shape: "rectangle",
    textEncoding: "utf8",
    sizeMode: "manual",
    magnification: 5,
    quietZoneModules: 1,
    minModuleMm: 0.25,
    align: "left",
    verticalAlign: "top",
};
const preview0 = renderToStaticMarkup(React.createElement(DataMatrixElement, {
    el: { ...previewElement, rotation: 0 },
    pxPerMm: 8,
    dpi: 300,
}));
const preview90 = renderToStaticMarkup(React.createElement(DataMatrixElement, {
    el: { ...previewElement, rotation: 90 },
    pxPerMm: 8,
    dpi: 300,
}));
assert.match(preview0, /data-symbol-size="8x18"/);
assert.match(preview90, /data-symbol-size="18x8"/);
assert.match(preview90, /data-rotation="90"/);
assert.match(preview90, /fill="#fff"/);
const previewPath0 = preview0.match(/<path d="([^"]+)" fill="#000"/);
const previewPath90 = preview90.match(/<path d="([^"]+)" fill="#000"/);
assert.ok(previewPath0 && previewPath90);
assert.notEqual(
    previewPath0[1],
    previewPath90[1],
    "rectangular Data Matrix preview must rotate and swap its module dimensions",
);

const settings = {
    widthMm: 60,
    heightMm: 40,
    gapMm: 3,
    dpi: 300,
    targetPrinterModel: "zt610r",
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

function element(patch = {}) {
    return {
        id: "dm",
        kind: "datamatrix",
        pos: { x: 2, y: 2 },
        size: { w: 18, h: 18 },
        data: "DM_DATA^~",
        contentFormat: "standard",
        shape: "square",
        textEncoding: "utf8",
        sizeMode: "auto",
        quietZoneModules: 1,
        minModuleMm: 0.25,
        ...patch,
    };
}

const standardDoc = {
    id: "dm-zpl",
    name: "Data Matrix ZPL",
    settings,
    elements: [element()],
};
assert.deepEqual(preflightLabelForPrinter(standardDoc), []);
const nativeZpl = buildZpl(standardDoc);
assert.match(nativeZpl, /\^GFA,/);
assert.doesNotMatch(nativeZpl, /\^BXN/);
assert.doesNotMatch(nativeZpl, /DM_DATA/);

const gs1Doc = {
    ...standardDoc,
    id: "dm-gs1-zpl",
    elements: [element({
        data: "(01)09501101530003(17)251231(10)ABC123",
        contentFormat: "gs1",
    })],
};
const gs1Zpl = buildZpl(gs1Doc);
assert.match(gs1Zpl, /\^GFA,/);
assert.doesNotMatch(gs1Zpl, /\^BXN/);

const rectangularZpl = buildZpl({
    ...standardDoc,
    id: "dm-rectangle-zpl",
    elements: [element({
        data: "RECTANGLE",
        shape: "rectangle",
        size: { w: 24, h: 14 },
    })],
});
assert.match(rectangularZpl, /\^GFA,/);
assert.doesNotMatch(
    rectangularZpl,
    /\^BX/,
    "rectangular ECC 200 must use an exact graphic across Zebra firmware generations",
);

const rotatedDataMatrixZpl = buildZpl({
    ...standardDoc,
    id: "dm-rotated-zpl",
    elements: [element({ rotation: 270 })],
});
assert.match(rotatedDataMatrixZpl, /\^GFA,/);
assert.doesNotMatch(rotatedDataMatrixZpl, /\^BX/);

const rowDoc = {
    ...standardDoc,
    id: "dm-row-zpl",
    elements: [element({ data: "LOT-{lot}", fieldName: undefined })],
    dataFeed: {
        columns: [{ id: "lot", name: "lot" }],
        rows: [{ id: "row-1", cells: { lot: "A123" } }],
    },
};
const rowZpl = buildZpl(rowDoc);
assert.match(rowZpl, /\^GFA,/);
assert.doesNotMatch(rowZpl, /\^BX/);
assert.doesNotMatch(rowZpl, /\{lot\}/);

const rfidReadDoc = {
    ...standardDoc,
    id: "dm-rfid-read-zpl",
    settings: {
        ...settings,
        rfid: {
            ...settings.rfid,
            readEnabled: true,
            readBank: "EPC",
            readFieldName: "rfid_read",
        },
    },
    elements: [element({ data: "{rfid_read}", fieldName: "rfid_read" })],
};
const rfidReadZpl = buildZpl(rfidReadDoc);
assert.match(rfidReadZpl, /\^BXN,\d+,200,\d+,\d+,,_,1\^FN1\^FS/);
assert.match(rfidReadZpl, /\^RFR,H,,,E\^FN1\^FS/);

const tooSmallDoc = {
    ...standardDoc,
    id: "dm-too-small",
    elements: [element({ size: { w: 1, h: 1 }, data: "LONG-DATA-MATRIX-PAYLOAD" })],
};
assert.ok(
    preflightLabelForPrinter(tooSmallDoc).some(
        (issue) => issue.code === "DATAMATRIX_DOES_NOT_FIT",
    ),
);

console.log("Data Matrix encoding, sizing, preflight, and ZPL tests passed.");
