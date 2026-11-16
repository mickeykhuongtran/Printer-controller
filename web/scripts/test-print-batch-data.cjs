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
    hasPerCopyBuiltins,
    hasPerCopyPrintData,
    resolveDocForCopy,
    variablesForCopy,
} = require(path.join(__dirname, "..", "app", "label-data.ts"));
const {
    MAX_PRINT_BATCH_QUANTITY,
    assertCompletePrintWrite,
    assertPrintBatchQuantity,
    planPrintBatchChunks,
    printBatchLabelRange,
} = require(path.join(__dirname, "..", "app", "print-batch.ts"));
const {
    buildFullPageZpl,
} = require(path.join(__dirname, "..", "app", "zpl.ts"));
const {
    applyTemplateValues,
    compileZplNativeChunks,
    extractTemplateFields,
} = require(path.join(__dirname, "..", "app", "integration.ts"));

assert.equal(MAX_PRINT_BATCH_QUANTITY, Number.MAX_SAFE_INTEGER);
for (const quantity of [1, 250, 251, 2500, 2501, 10000, 50000]) {
    assert.doesNotThrow(() => assertPrintBatchQuantity(quantity));
}
assert.throws(() => assertPrintBatchQuantity(0), /positive safe integer/);
assert.throws(() => assertPrintBatchQuantity(Number.MAX_SAFE_INTEGER + 1), /positive safe integer/);
assert.deepEqual(
    planPrintBatchChunks(251, 250).map((chunk) => chunk.quantity),
    [250, 1],
);
assert.deepEqual(
    planPrintBatchChunks(2500, 250).map((chunk) => chunk.quantity),
    Array(10).fill(250),
);
assert.deepEqual(
    planPrintBatchChunks(2500, 137)
        .flatMap((chunk) =>
            Array.from(
                { length: chunk.quantity },
                (_, index) => chunk.startIndex + index,
            ),
        ),
    Array.from({ length: 2500 }, (_, index) => index),
    "dynamic chunks must cover every copy index exactly once and in order",
);
const importedRangeChunks = planPrintBatchChunks(250, 100);
assert.deepEqual(
    importedRangeChunks.map((chunk) => printBatchLabelRange(chunk, 251)),
    [
        { labelFrom: 251, labelTo: 350 },
        { labelFrom: 351, labelTo: 450 },
        { labelFrom: 451, labelTo: 500 },
    ],
    "an imported From–To range must retain absolute row numbers across chunks",
);
assert.doesNotThrow(() => assertCompletePrintWrite(1024, 1024));
assert.throws(
    () => assertCompletePrintWrite(1024, 1000),
    /Short write: accepted 1000 of 1024 bytes/,
);

function settings() {
    return {
        widthMm: 60,
        heightMm: 40,
        gapMm: 3,
        dpi: 203,
        copies: 2500,
        speed: 4,
        darkness: 10,
        serial: { enabled: true, start: 1, step: 1, pad: 4, prefix: "" },
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
}

const staticSettings = {
    ...settings(),
    serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
};
const staticDoc = {
    id: "static",
    name: "Static template",
    settings: staticSettings,
    elements: [{
        id: "fixed",
        kind: "text",
        pos: { x: 0, y: 0 },
        size: { w: 20, h: 5 },
        rotation: 0,
        text: "FIXED",
        font: "D",
        scaleX: 1,
        scaleY: 1,
    }],
    dataFeed: {
        columns: [{ id: "col_step", name: "step", formula: "=ROW()", system: true }],
        rows: Array.from({ length: 5 }, (_, index) => ({
            id: `row-${index + 1}`,
            cells: {},
        })),
    },
};
const explicitBindingDoc = {
    ...staticDoc,
    id: "explicit-bindings",
    elements: [
        { ...staticDoc.elements[0], id: "bound-text", fieldName: "TITLE" },
        {
            id: "bound-qr",
            kind: "qr",
            pos: { x: 0, y: 6 },
            size: { w: 14, h: 14 },
            data: "fallback",
            fieldName: "QR_VALUE",
            ecc: "M",
            cell: 4,
        },
        {
            id: "bound-barcode",
            kind: "barcode",
            pos: { x: 15, y: 6 },
            size: { w: 40, h: 10 },
            data: "fallback",
            fieldName: "BAR_VALUE",
            symbology: "CODE128",
            humanReadable: false,
        },
        {
            id: "bound-dm",
            kind: "datamatrix",
            pos: { x: 0, y: 21 },
            size: { w: 14, h: 14 },
            data: "fallback",
            fieldName: "DM_VALUE",
        },
    ],
};
assert.deepEqual(
    extractTemplateFields(explicitBindingDoc).map(({ name, sources }) => ({ name, sources })),
    [
        { name: "TITLE", sources: ["text"] },
        { name: "QR_VALUE", sources: ["qr"] },
        { name: "BAR_VALUE", sources: ["barcode"] },
        { name: "DM_VALUE", sources: ["datamatrix"] },
    ],
    "integration fields must include explicit bindings even when fallback content has no placeholder",
);
const templateDefaultBindingDoc = {
    ...staticDoc,
    id: "template-default-binding",
    templateFields: [{ id: "payload", name: "PAYLOAD", value: "DEFAULT-QR" }],
    elements: [{
        id: "template-default-qr",
        kind: "qr",
        pos: { x: 1, y: 1 },
        size: { w: 20, h: 20 },
        data: "{PAYLOAD}",
        ecc: "M",
        cell: 4,
    }],
};
assert.equal(
    extractTemplateFields(templateDefaultBindingDoc)[0].defaultValue,
    "DEFAULT-QR",
    "integration schema must preserve an explicit template-field default",
);
assert.doesNotThrow(
    () => compileZplNativeChunks(templateDefaultBindingDoc, {}, { copies: 1 }),
    "a valid template-field default must resolve before native compilation",
);

for (const { element, validValue } of [
    { element: {
        id: "missing-qr",
        kind: "qr",
        pos: { x: 1, y: 1 },
        size: { w: 20, h: 20 },
        data: "{missing_qr}",
        ecc: "M",
        cell: 4,
    }, validValue: "123456" },
    { element: {
        id: "missing-barcode",
        kind: "barcode",
        pos: { x: 1, y: 1 },
        size: { w: 55, h: 15 },
        data: "{missing_barcode}",
        symbology: "CODE128",
        humanReadable: false,
    }, validValue: "123456" },
    { element: {
        id: "missing-ean",
        kind: "barcode",
        pos: { x: 1, y: 1 },
        size: { w: 55, h: 15 },
        data: "{missing_ean}",
        symbology: "EAN13",
        humanReadable: true,
    }, validValue: "5901234123457" },
    { element: {
        id: "missing-dm",
        kind: "datamatrix",
        pos: { x: 1, y: 1 },
        size: { w: 20, h: 20 },
        data: "{missing_dm}",
    }, validValue: "123456" },
]) {
    const missingBindingDoc = {
        ...staticDoc,
        id: element.id,
        elements: [element],
    };
    assert.throws(
        () => compileZplNativeChunks(missingBindingDoc, {}, { copies: 1 }),
        /Print blocked by target-printer preflight.*(?:empty|non-empty|EAN-13 requires)/i,
        `${element.kind} must not compile when an API/template variable is omitted`,
    );
    const fieldName = element.data.slice(1, -1);
    assert.doesNotThrow(
        () => compileZplNativeChunks(missingBindingDoc, { [fieldName]: validValue }, { copies: 1 }),
        `${element.kind} must compile after its binding is supplied`,
    );
}
assert.equal(hasPerCopyPrintData(staticDoc), false);
const staticZpl = buildFullPageZpl(
    staticSettings,
    {
        widthDots: 8,
        heightDots: 1,
        widthBytes: 1,
        bytes: new Uint8Array([0]),
    },
    2500,
    { elements: [] },
);
assert.match(staticZpl, /\^PQ2500\b/);
assert.equal(
    (staticZpl.match(/\^GFA,/g) ?? []).length,
    1,
    "a static 2,500-label batch must contain one bitmap and one printer-side quantity",
);
assert.doesNotThrow(() => applyTemplateValues(staticDoc, {}, { copies: 2500 }));
assert.throws(
    () => applyTemplateValues(staticDoc, {}, { copies: Infinity }),
    /positive safe integer/,
);
const nativeWindows = compileZplNativeChunks(staticDoc, {}, {
    copies: 1000,
    labelsPerChunk: 25,
});
assert.throws(
    () => compileZplNativeChunks(staticDoc, {}, { copies: 1000.5, labelsPerChunk: 25 }),
    /positive safe integer/,
    "fractional API quantities must be rejected instead of silently floored",
);
assert.equal(nativeWindows.length, 40);
assert.deepEqual(
    nativeWindows.map(({ labelFrom, labelTo }) => ({ labelFrom, labelTo })).slice(0, 2),
    [
        { labelFrom: 1, labelTo: 25 },
        { labelFrom: 26, labelTo: 50 },
    ],
);
assert.deepEqual(
    {
        labelFrom: nativeWindows.at(-1).labelFrom,
        labelTo: nativeWindows.at(-1).labelTo,
    },
    { labelFrom: 976, labelTo: 1000 },
);
assert.equal(
    nativeWindows.reduce(
        (total, chunk) => total + (chunk.zpl.match(/\^XA\b/g) ?? []).length,
        0,
    ),
    1000,
    "native integration must cover all labels across bounded complete-format windows",
);

const serialText = {
    id: "serial",
    kind: "text",
    pos: { x: 0, y: 0 },
    size: { w: 20, h: 5 },
    rotation: 0,
    text: "{step}",
    fieldName: "step",
    font: "D",
    scaleX: 1,
    scaleY: 1,
};

const defaultSystemFeedDoc = {
    id: "default-feed",
    name: "Default feed must not limit a batch",
    settings: settings(),
    elements: [
        serialText,
        { ...serialText, id: "serial-inline", fieldName: undefined, text: "ID {serial}" },
        { ...serialText, id: "serial-braced", fieldName: "{SERIAL}", text: "fallback" },
        { ...serialText, id: "row-inline", fieldName: undefined, text: "ROW {row}" },
    ],
    dataFeed: {
        columns: [{ id: "col_step", name: "step", formula: "=ROW()", system: true }],
        rows: Array.from({ length: 5 }, (_, index) => ({
            id: `row-${index + 1}`,
            cells: {},
        })),
    },
};

const label2500 = resolveDocForCopy(defaultSystemFeedDoc, 2499);
assert.equal(
    label2500.elements[0].text,
    "2500",
    "the default five-row system feed must not clamp a 2,500-label serial batch",
);
assert.equal(label2500.elements[1].text, "ID 2500");
assert.equal(
    label2500.elements[2].text,
    "2500",
    "braced, case-insensitive built-in field names must not suppress the serial value",
);
assert.equal(label2500.elements[3].text, "ROW 2500");
assert.equal(variablesForCopy(defaultSystemFeedDoc, 2499).step, "2500");

const rawStepDoc = {
    ...defaultSystemFeedDoc,
    settings: {
        ...settings(),
        serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
    },
};
const rawStepLabel2500 = resolveDocForCopy(
    rawStepDoc,
    2499,
    variablesForCopy(rawStepDoc, 2499),
);
assert.equal(
    rawStepLabel2500.elements[0].text,
    "2500",
    "legacy field-bound system counters must advance even when serial formatting is disabled",
);
assert.equal(hasPerCopyBuiltins(rawStepDoc), true);
assert.equal(hasPerCopyPrintData(rawStepDoc), true);

const importedFeedDoc = {
    ...defaultSystemFeedDoc,
    id: "imported-feed",
    dataFeed: {
        columns: [
            { id: "col_step", name: "step", formula: "=ROW()", system: true },
            { id: "col_sku", name: "sku" },
        ],
        rows: [
            { id: "row-1", cells: { col_sku: "SKU-A" } },
            { id: "row-2", cells: { col_sku: "SKU-B" } },
        ],
    },
};

const importedVars = variablesForCopy(importedFeedDoc, 1);
assert.equal(importedVars.sku, "SKU-B", "real imported data must remain row-driven");
assert.equal(
    importedVars.step,
    "0002",
    "the system step field must retain the configured serial padding in imported rows",
);

const importedBuiltinNameDoc = {
    ...defaultSystemFeedDoc,
    id: "imported-built-in-name-feed",
    dataFeed: {
        columns: [
            { id: "col_step", name: "step", formula: "=ROW()", system: true },
            { id: "col_serial", name: "serial" },
            { id: "col_row", name: "row" },
        ],
        rows: [{
            id: "row-1",
            cells: { col_serial: "CUSTOM-SERIAL", col_row: "CUSTOM-ROW" },
        }],
    },
};
const importedBuiltinVars = variablesForCopy(importedBuiltinNameDoc, 0);
assert.equal(importedBuiltinVars.serial, "CUSTOM-SERIAL");
assert.equal(importedBuiltinVars.row, "CUSTOM-ROW");
assert.equal(importedBuiltinVars.step, "0001");

const importedCaseBuiltinDoc = {
    ...staticDoc,
    id: "imported-case-built-in-name",
    elements: [{
        ...staticDoc.elements[0],
        fieldName: "serial",
        text: "fallback",
    }],
    dataFeed: {
        columns: [{ id: "col_serial", name: "Serial" }],
        rows: [{
            id: "row-1",
            cells: { col_serial: "CASE-SENSITIVE-DATA" },
        }],
    },
};
const importedCaseVars = variablesForCopy(importedCaseBuiltinDoc, 0);
assert.equal(
    resolveDocForCopy(importedCaseBuiltinDoc, 0, importedCaseVars).elements[0].text,
    "CASE-SENSITIVE-DATA",
);
assert.equal(
    hasPerCopyPrintData(importedCaseBuiltinDoc),
    false,
    "one imported row named like a built-in remains a constant field, not a generated counter",
);

console.log(
    "General batch data tests passed: 2,500 serial copies are independent of the default feed while imported rows remain intact.",
);
