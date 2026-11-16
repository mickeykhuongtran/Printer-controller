/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
        fileName: filename,
    }).outputText;
    module._compile(output, filename);
};
const { preflightLabelForPrinter } = require("../app/dpi-preflight.ts");
const { buildZpl, buildFullPageZpl } = require("../app/zpl.ts");
const { compileZplNativeChunks } = require("../app/integration.ts");

// Reproduce the 45 x 18 mm / 300 dpi imported-EPC label from the report.
const doc = {
    id: "calibration", name: "Print calibration",
    settings: {
        widthMm: 45, heightMm: 18, gapMm: 3, dpi: 300,
        targetPrinterModel: "zt610r", copies: 2, speed: 4, darkness: 10,
        serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
        rfid: {
            enabled: false, chip: "epc_96", epcBits: 96, format: "H",
            retries: 3, block: 2, words: 6, data: "",
        },
    },
    elements: [
        {
            id: "barcode", kind: "barcode", pos: { x: 3, y: 3 }, size: { w: 39, h: 5 },
            data: "{RFID}", symbology: "CODE128", humanReadable: false, minModuleMm: 0.15,
        },
        {
            id: "qr", kind: "qr", pos: { x: 35, y: 10 }, size: { w: 5.75, h: 5.75 },
            data: "{RFID}", ecc: "M", cell: 3, sizeMode: "manual", magnification: 3,
            minModuleMm: 0.33,
        },
    ],
    dataFeed: {
        columns: [{ id: "epc", name: "RFID" }],
        rows: [
            { id: "row1", cells: { epc: "E280F3021788757218010001" } },
            { id: "row2", cells: { epc: "FFFFFFFFFFFFFFFFFFFFFFFF" } },
        ],
    },
};

function checkWarnings(document, codes, copyIndex = 0) {
    const issues = preflightLabelForPrinter(document, { copyIndex });
    assert.deepEqual(issues.filter((issue) => issue.severity === "error"), []);
    for (const code of codes) {
        assert.ok(issues.some((issue) => issue.code === code && issue.severity === "warning"), code);
    }
}
for (let row = 0; row < 2; row++) {
    checkWarnings(doc, ["BARCODE_NARROW_DOTS_UNSAFE", "QR_TOO_SMALL_FOR_MODULE_MATRIX", "QR_MODULE_SIZE_UNSAFE"], row);
}
const before = JSON.stringify(doc);
const chunks = compileZplNativeChunks(doc, {}, { copies: 2, labelsPerChunk: 1 });
assert.equal(chunks.length, 2);
assert.deepEqual(chunks.map((chunk) => [chunk.labelFrom, chunk.labelTo]), [[1, 1], [2, 2]]);
const firstRow = buildZpl({ ...doc, settings: { ...doc.settings, copies: 1 } }, 0);
const secondRow = buildZpl({ ...doc, settings: { ...doc.settings, copies: 1 } }, 1);
assert.notEqual(firstRow, secondRow, "imported rows must keep their own EPC payload");
assert.ok(chunks.every((chunk) => chunk.payload.byteLength > 0 && chunk.zpl.includes("^GFA")));
assert.equal(JSON.stringify(doc), before, "calibration must not rewrite imported values or manual sizing");

const printerRead = structuredClone(doc);
delete printerRead.dataFeed;
printerRead.settings.copies = 1;
Object.assign(printerRead.settings.rfid, {
    readEnabled: true, readFieldName: "read_epc", readBank: "EPC",
    zebraEpcReadMode: "pc", readLength: 24,
});
for (const element of printerRead.elements) element.data = "{read_epc}";
Object.assign(printerRead.elements[0], { sizeMode: "manual", narrowDots: 2 });
checkWarnings(printerRead, ["RFID_SYMBOL_SIZE_ESTIMATED", "BARCODE_DOES_NOT_FIT", "QR_TOO_SMALL_FOR_MODULE_MATRIX"]);
const native = buildZpl(printerRead);
const blankBitmap = { widthDots: 8, heightDots: 1, widthBytes: 1, bytes: new Uint8Array(1) };
const fullPage = buildFullPageZpl(printerRead.settings, blankBitmap, 1, {
    elements: printerRead.elements, sn: "", vars: {},
});
for (const zpl of [native, fullPage]) {
    assert.match(zpl, /\^BY2,2\.0,/, "preserve manual barcode dots/module");
    assert.match(zpl, /\^BQN,2,3/, "preserve manual QR magnification");
    assert.match(zpl, /\^RF/, "EPC must still be read on the printer");
    assert.match(zpl, /\^FN/, "printer field binding must be kept");
    assert.doesNotMatch(zpl, /\{read_epc\}|FFFFFFFFFFFFFFFFFFFFFFFF/, "never print the estimated EPC as real data");
}
assert.equal(compileZplNativeChunks(printerRead, {}, { copies: 3, labelsPerChunk: 1 }).length, 3);

// Both automatic one-dot sizing and manual height overflow remain printable.
const automatic = structuredClone(printerRead);
Object.assign(automatic.elements[0], { sizeMode: "auto", narrowDots: undefined, humanReadable: true, barHeightMm: 8 });
checkWarnings(automatic, ["BARCODE_NARROW_DOTS_UNSAFE", "BARCODE_HEIGHT_DOES_NOT_FIT"]);
assert.match(buildZpl(automatic), /\^BY1,2\.0,/);

// A QR extending past the label boundary is allowed for physical calibration.
const overlap = structuredClone(doc);
overlap.elements[1].pos.x = 43;
checkWarnings(overlap, ["ELEMENT_OUTSIDE_LABEL"]);
assert.doesNotThrow(() => compileZplNativeChunks(overlap, {}));

// True encoding/configuration failures must still stop before any bytes are sent.
for (const payload of ["", "Tiếng Việt"]) {
    const invalid = structuredClone(doc);
    invalid.dataFeed.rows[0].cells.epc = payload;
    assert.throws(() => compileZplNativeChunks(invalid, {}), /Print blocked.*Code 128/);
}
const overCapacity = structuredClone(doc);
overCapacity.elements = [{ ...doc.elements[1], data: "x".repeat(4000), fieldName: undefined }];
assert.ok(preflightLabelForPrinter(overCapacity, { copyIndex: 0 })
    .some((issue) => issue.code === "QR_INVALID_DATA" && issue.severity === "error"));
assert.throws(() => compileZplNativeChunks(overCapacity, {}), /Print blocked/);
const unsupported = structuredClone(printerRead);
unsupported.elements[1].rotation = 90;
assert.throws(() => compileZplNativeChunks(unsupported, {}), /0-degree rotation/);

console.log("Print calibration tests passed: imported EPC rows, native/full-page read_epc, manual sizing and encoding errors.");
