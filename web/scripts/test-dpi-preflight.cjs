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

const { preflightLabelForPrinter } = require(
    path.join(__dirname, "..", "app", "dpi-preflight.ts"),
);
const { buildZpl } = require(path.join(__dirname, "..", "app", "zpl.ts"));
const { qrModuleCount } = require(path.join(__dirname, "..", "app", "qr-sizing.ts"));
const { defaultDataFeed, labelReducer } = require(
    path.join(__dirname, "..", "app", "reducer.ts"),
);

const serial = { enabled: false, start: 1, step: 1, pad: 4, prefix: "" };
const rfid = {
    enabled: false,
    chip: "epc_96",
    epcBits: 96,
    format: "H",
    retries: 3,
    block: 2,
    words: 6,
    data: "",
};

function labelDoc(elements = [], settingsPatch = {}) {
    return {
        id: "preflight-test",
        name: "Preflight test",
        settings: {
            widthMm: 60,
            heightMm: 40,
            gapMm: 3,
            dpi: 300,
            targetPrinterModel: "zt610r",
            copies: 1,
            speed: 4,
            darkness: 10,
            serial,
            rfid,
            ...settingsPatch,
        },
        elements,
    };
}

function issueByCode(doc, code) {
    return preflightLabelForPrinter(doc).filter((issue) => issue.code === code);
}

function assertNativeCompileFailureIsPreflighted(doc, issueCode, errorPattern) {
    const blocking = issueByCode(doc, issueCode);
    assert.equal(blocking.length, 1, `${issueCode} must be reported before ZPL generation`);
    assert.equal(blocking[0].severity, "error");
    assert.throws(() => buildZpl(doc), errorPattern);
}

function assertCalibrationWarningAllowsPrint(doc, issueCode, zplPattern) {
    const warnings = issueByCode(doc, issueCode);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].severity, "warning");
    assert.equal(preflightLabelForPrinter(doc).some((issue) => issue.severity === "error"), false);
    assert.match(buildZpl(doc), zplPattern);
}

const cleanElements = [
    {
        id: "text-ok",
        kind: "text",
        pos: { x: 2, y: 2 },
        size: { w: 20, h: 5 },
        text: "Zebra",
        rotation: 0,
        font: "D",
        scaleX: 1,
        scaleY: 1,
        fontSizeMm: 3,
    },
    {
        id: "qr-ok",
        kind: "qr",
        pos: { x: 2, y: 10 },
        size: { w: 14, h: 14 },
        data: "OK",
        ecc: "M",
        cell: 1,
    },
    {
        id: "barcode-ok",
        kind: "barcode",
        pos: { x: 10, y: 10 },
        size: { w: 40, h: 12 },
        data: "123456",
        symbology: "CODE128",
        humanReadable: false,
        narrowDots: 3,
    },
    {
        id: "rect-ok",
        kind: "rect",
        pos: { x: 1, y: 1 },
        size: { w: 58, h: 38 },
        thickness: 0.2,
        filled: false,
    },
];

assert.deepEqual(preflightLabelForPrinter(labelDoc(cleanElements)), []);

const tooWide = issueByCode(
    labelDoc([], { widthMm: 105 }),
    "LABEL_EXCEEDS_PRINTABLE_WIDTH",
);
assert.equal(tooWide.length, 1);
assert.equal(tooWide[0].severity, "error");

const unsupportedDpi = issueByCode(
    labelDoc([], { targetPrinterModel: "zd621r", dpi: 600 }),
    "MODEL_DPI_UNSUPPORTED",
);
assert.equal(unsupportedDpi.length, 1);
assert.equal(unsupportedDpi[0].severity, "error");

const outside = issueByCode(
    labelDoc([
        {
            id: "outside",
            kind: "image",
            pos: { x: 59, y: 5 },
            size: { w: 2, h: 2 },
            src: "data:image/png;base64,",
            threshold: 128,
        },
    ]),
    "ELEMENT_OUTSIDE_LABEL",
);
assert.equal(outside.length, 1);
assert.equal(outside[0].elementId, "outside");
assert.equal(
    outside[0].severity,
    "warning",
    "intentional calibration overflow must warn without blocking print",
);
assert.match(outside[0].message, /printing is allowed for calibration/);

const calibrationBarcode = labelDoc([
    {
        id: "rfid-read-calibration-barcode",
        kind: "barcode",
        pos: { x: 2, y: 9 },
        size: { w: 60, h: 9 },
        data: "{rfid_read}",
        symbology: "CODE128",
        humanReadable: false,
    },
], {
    widthMm: 56,
    heightMm: 33,
    dpi: 203,
    targetPrinterModel: "auto",
    rfid: {
        ...rfid,
        readEnabled: true,
        readBank: "EPC",
        zebraEpcReadMode: "pc",
        readFieldName: "rfid_read",
    },
});
const calibrationOverflow = issueByCode(
    calibrationBarcode,
    "ELEMENT_OUTSIDE_LABEL",
);
assert.equal(calibrationOverflow.length, 1);
assert.equal(calibrationOverflow[0].severity, "warning");
assert.match(calibrationOverflow[0].message, /Printing is allowed for calibration/);

for (const fullyOutside of [
    {
        id: "fully-right",
        kind: "image",
        pos: { x: 61, y: 5 },
        size: { w: 2, h: 2 },
        src: "data:image/png;base64,",
        threshold: 128,
    },
    {
        id: "fully-left",
        kind: "image",
        pos: { x: -3, y: 5 },
        size: { w: 2, h: 2 },
        src: "data:image/png;base64,",
        threshold: 128,
    },
]) {
    const issues = issueByCode(
        labelDoc([fullyOutside]),
        "ELEMENT_OUTSIDE_LABEL",
    );
    assert.equal(issues.length, 1);
    assert.equal(
        issues[0].severity,
        "error",
        "a fully invisible element must remain a blocking design error",
    );
}

const calibrationWithRealError = labelDoc(
    calibrationBarcode.elements,
    {
        ...calibrationBarcode.settings,
        targetPrinterModel: "zd621r",
        dpi: 600,
    },
);
const combinedIssues = preflightLabelForPrinter(calibrationWithRealError);
assert.ok(
    combinedIssues.some(
        (issue) =>
            issue.code === "ELEMENT_OUTSIDE_LABEL"
            && issue.severity === "warning",
    ),
);
assert.ok(
    combinedIssues.some(
        (issue) =>
            issue.code === "MODEL_DPI_UNSUPPORTED"
            && issue.severity === "error",
    ),
    "symbol overflow must not suppress genuine printer incompatibility",
);

const thinStrokes = issueByCode(
    labelDoc([
        {
            id: "thin-line",
            kind: "line",
            pos: { x: 1, y: 1 },
            size: { w: 10, h: 0.05 },
            thickness: 0.05,
            orientation: "h",
        },
        {
            id: "thin-frame",
            kind: "rect",
            pos: { x: 1, y: 2 },
            size: { w: 10, h: 5 },
            thickness: 0.05,
            filled: false,
        },
        {
            id: "filled-rect",
            kind: "rect",
            pos: { x: 1, y: 8 },
            size: { w: 10, h: 5 },
            thickness: 0,
            filled: true,
        },
    ]),
    "STROKE_BELOW_ONE_DOT",
);
assert.deepEqual(
    thinStrokes.map((issue) => issue.elementId),
    ["thin-line", "thin-frame"],
);
assert.ok(thinStrokes.every((issue) => issue.severity === "warning"));

const unsafeBarcode = issueByCode(
    labelDoc([
        {
            id: "unsafe-barcode",
            kind: "barcode",
            pos: { x: 1, y: 1 },
            size: { w: 40, h: 12 },
            data: "ABC123",
            symbology: "CODE128",
            humanReadable: false,
            narrowDots: 2,
        },
    ]),
    "BARCODE_NARROW_DOTS_UNSAFE",
);
assert.equal(unsafeBarcode.length, 1);
assert.equal(unsafeBarcode[0].severity, "warning");
assert.match(unsafeBarcode[0].message, /0\.167 mm/);
assert.match(unsafeBarcode[0].message, /0\.25 mm minimum/);
assert.match(unsafeBarcode[0].message, /^Manual barcode sizing/);

const unsafeAutomaticBarcode = issueByCode(
    labelDoc([
        {
            id: "unsafe-auto-barcode",
            kind: "barcode",
            pos: { x: 1, y: 1 },
            size: { w: 55, h: 12 },
            data: "THIS-IS-A-LONG-CODE128-PAYLOAD-1234567890",
            symbology: "CODE128",
            humanReadable: false,
        },
    ]),
    "BARCODE_NARROW_DOTS_UNSAFE",
);
assert.equal(unsafeAutomaticBarcode.length, 1);
assert.equal(unsafeAutomaticBarcode[0].severity, "warning");
assert.equal(unsafeAutomaticBarcode[0].elementId, "unsafe-auto-barcode");
assert.match(unsafeAutomaticBarcode[0].message, /^Automatic barcode sizing/);
assert.match(unsafeAutomaticBarcode[0].message, /frame provides 55 mm along the barcode axis/);

const safeAutomaticBarcode = issueByCode(
    labelDoc([
        {
            id: "safe-auto-barcode",
            kind: "barcode",
            pos: { x: 1, y: 1 },
            size: { w: 50, h: 12 },
            data: "123456",
            symbology: "CODE128",
            humanReadable: false,
        },
    ]),
    "BARCODE_NARROW_DOTS_UNSAFE",
);
assert.deepEqual(safeAutomaticBarcode, []);

const numericVsHex = labelDoc([
    {
        id: "numeric-34mm",
        kind: "barcode",
        pos: { x: 1, y: 1 },
        size: { w: 34, h: 12 },
        data: "123456789012345678901234",
        symbology: "CODE128",
        humanReadable: false,
        minModuleMm: 0.16,
    },
    {
        id: "hex-34mm",
        kind: "barcode",
        pos: { x: 1, y: 15 },
        size: { w: 34, h: 12 },
        data: "E2800300000000F13021ADE1",
        symbology: "CODE128",
        humanReadable: false,
        minModuleMm: 0.16,
    },
]);
assert.equal(
    preflightLabelForPrinter(numericVsHex)
        .some((issue) => issue.elementId === "numeric-34mm" && issue.severity === "error"),
    false,
    "24 numeric characters fit 34 mm at two dots/module under the configured scanner threshold",
);
assert.equal(
    issueByCode(numericVsHex, "BARCODE_NARROW_DOTS_UNSAFE")[0].elementId,
    "hex-34mm",
    "the same-length EPC HEX payload forces one dot/module and must warn",
);

const invalidEan = issueByCode(
    labelDoc([{
        id: "bad-ean",
        kind: "barcode",
        pos: { x: 1, y: 1 },
        size: { w: 50, h: 12 },
        data: "5901234123458",
        symbology: "EAN13",
        humanReadable: true,
    }]),
    "BARCODE_INVALID_DATA",
);
assert.equal(invalidEan.length, 1);
assert.equal(invalidEan[0].severity, "error");

const rfidEan = issueByCode(
    labelDoc(
        [{
            id: "rfid-ean",
            kind: "barcode",
            pos: { x: 1, y: 1 },
            size: { w: 50, h: 12 },
            data: "{rfid_read}",
            fieldName: "rfid_read",
            symbology: "EAN13",
            humanReadable: true,
        }],
        {
            rfid: {
                ...rfid,
                readEnabled: true,
                readFieldName: "rfid_read",
            },
        },
    ),
    "BARCODE_RFID_EAN13_UNSUPPORTED",
);
assert.equal(rfidEan.length, 1);
assert.equal(rfidEan[0].severity, "error");

function printerReadDoc(element, rfidPatch = {}, settingsPatch = {}) {
    return labelDoc([element], {
        dpi: 203,
        targetPrinterModel: "zt610r",
        rfid: {
            ...rfid,
            readEnabled: true,
            readBank: "EPC",
            zebraEpcReadMode: "pc",
            readLength: 24,
            readFieldName: "rfid_read",
            ...rfidPatch,
        },
        ...settingsPatch,
    });
}

// The native ZPL path sizes an unresolved printer RFID read with conservative
// hexadecimal F characters. Preflight must use the same payload instead of the
// much shorter literal "{rfid_read}" token; sizing warnings must allow calibration.
const narrowRfidCode128 = printerReadDoc({
    id: "rfid-code128-sample-sizing",
    kind: "barcode",
    pos: { x: 0, y: 1 },
    size: { w: 60, h: 12 },
    data: "{rfid_read}",
    symbology: "CODE128",
    humanReadable: false,
});
assertCalibrationWarningAllowsPrint(
    narrowRfidCode128,
    "BARCODE_NARROW_DOTS_UNSAFE",
    /\^BY1,2\.0,/,
);
assert.equal(
    issueByCode(narrowRfidCode128, "DYNAMIC_SYMBOL_CHECK_DEFERRED").length,
    0,
    "printer-resolved RFID has an estimated sizing check before printing",
);
assert.equal(issueByCode(narrowRfidCode128, "RFID_SYMBOL_SIZE_ESTIMATED").length, 1);

const narrowRfidQr = printerReadDoc({
    id: "rfid-qr-sample-sizing",
    kind: "qr",
    pos: { x: 1, y: 1 },
    size: { w: 7.25, h: 7.25 },
    data: "{rfid_read}",
    ecc: "M",
    cell: 4,
});
assertCalibrationWarningAllowsPrint(
    narrowRfidQr,
    "QR_MODULE_SIZE_UNSAFE",
    /\^BQN,2,1/,
);

const narrowRfidDataMatrix = printerReadDoc({
    id: "rfid-datamatrix-sample-sizing",
    kind: "datamatrix",
    pos: { x: 1, y: 1 },
    size: { w: 4.5, h: 4.5 },
    data: "{rfid_read}",
});
assertNativeCompileFailureIsPreflighted(
    narrowRfidDataMatrix,
    "DATAMATRIX_MODULE_SIZE_UNSAFE",
    /Data Matrix rfid-datamatrix-sample-sizing uses 1 dots\/module/,
);

const lengthSourceQr = {
    id: "rfid-length-source",
    kind: "qr",
    pos: { x: 1, y: 1 },
    size: { w: 9, h: 9 },
    data: "{rfid_read}",
    ecc: "M",
    cell: 4,
    minModuleMm: 0.25,
};
const pcLengthDoc = printerReadDoc(lengthSourceQr, {
    epcBits: 96,
    readLength: 64,
    zebraEpcReadMode: "pc",
});
assert.equal(
    issueByCode(pcLengthDoc, "QR_MODULE_SIZE_UNSAFE").length,
    0,
    "EPC PC-mode sizing must derive 24 HEX characters from epcBits, not readLength",
);
assert.doesNotThrow(() => buildZpl(pcLengthDoc));
const fixedLengthDoc = printerReadDoc(lengthSourceQr, {
    epcBits: 96,
    readLength: 64,
    zebraEpcReadMode: "fixed",
});
assertCalibrationWarningAllowsPrint(
    fixedLengthDoc,
    "QR_MODULE_SIZE_UNSAFE",
    /\^BQN,2,1/,
);
const pcLongEpcDoc = printerReadDoc(lengthSourceQr, {
    epcBits: 256,
    readLength: 24,
    zebraEpcReadMode: "pc",
});
assertCalibrationWarningAllowsPrint(
    pcLongEpcDoc,
    "QR_MODULE_SIZE_UNSAFE",
    /\^BQN,2,1/,
);

const nonAsciiNativeQr = printerReadDoc({
    id: "rfid-qr-native-ascii",
    kind: "qr",
    pos: { x: 1, y: 1 },
    size: { w: 20, h: 20 },
    data: "é{rfid_read}",
    ecc: "M",
    cell: 4,
});
assertNativeCompileFailureIsPreflighted(
    nonAsciiNativeQr,
    "QR_RFID_NATIVE_UNSUPPORTED",
    /native Zebra automatic input is limited to safe ASCII/,
);

const noConcatDelimiterBarcode = printerReadDoc(
    {
        id: "rfid-code128-no-fe-delimiter",
        kind: "barcode",
        pos: { x: 0, y: 1 },
        size: { w: 100, h: 12 },
        data: "#|@!%&;:?+*/-.$()[]{}{rfid_read}",
        symbology: "CODE128",
        humanReadable: false,
        minModuleMm: 0.125,
    },
    {},
    { widthMm: 102 },
);
assertNativeCompileFailureIsPreflighted(
    noConcatDelimiterBarcode,
    "BARCODE_RFID_NATIVE_UNSUPPORTED",
    /contains every supported \^FE delimiter/,
);

const oversizedNativeQrField = printerReadDoc(
    {
        id: "rfid-qr-native-field-limit",
        kind: "qr",
        pos: { x: 1, y: 1 },
        size: { w: 60, h: 60 },
        data: `${"^".repeat(1100)}{rfid_read}`,
        ecc: "L",
        cell: 4,
    },
    {},
    { widthMm: 65, heightMm: 65 },
);
assertNativeCompileFailureIsPreflighted(
    oversizedNativeQrField,
    "QR_RFID_NATIVE_UNSUPPORTED",
    /native Zebra field data exceeds the 3,072-byte \^FD limit/,
);

const oversizedNativeDataMatrixField = printerReadDoc(
    {
        id: "rfid-datamatrix-native-field-limit",
        kind: "datamatrix",
        pos: { x: 1, y: 1 },
        size: { w: 60, h: 60 },
        data: `${"^".repeat(1100)}{rfid_read}`,
    },
    {},
    { widthMm: 65, heightMm: 65 },
);
assertNativeCompileFailureIsPreflighted(
    oversizedNativeDataMatrixField,
    "DATAMATRIX_RFID_NATIVE_UNSUPPORTED",
    /native Zebra field data exceeds the 3,072-byte \^FD limit/,
);

const emptyQr = issueByCode(
    labelDoc([{
        id: "empty-qr",
        kind: "qr",
        pos: { x: 1, y: 1 },
        size: { w: 14, h: 14 },
        data: "",
        ecc: "M",
        cell: 4,
    }]),
    "QR_EMPTY_DATA",
);
assert.equal(emptyQr.length, 1);
assert.equal(emptyQr[0].severity, "error");

const unknownSymbolVariables = labelDoc([
    {
        id: "unknown-qr-variable",
        kind: "qr",
        pos: { x: 1, y: 1 },
        size: { w: 14, h: 14 },
        data: "{missing_qr}",
        ecc: "M",
        cell: 4,
    },
    {
        id: "unknown-barcode-variable",
        kind: "barcode",
        pos: { x: 16, y: 1 },
        size: { w: 40, h: 12 },
        data: "{missing_barcode}",
        symbology: "CODE128",
        humanReadable: false,
    },
    {
        id: "unknown-ean-variable",
        kind: "barcode",
        pos: { x: 16, y: 17 },
        size: { w: 40, h: 12 },
        data: "{missing_ean}",
        symbology: "EAN13",
        humanReadable: true,
    },
    {
        id: "unknown-datamatrix-variable",
        kind: "datamatrix",
        pos: { x: 1, y: 17 },
        size: { w: 14, h: 14 },
        data: "{missing_dm}",
    },
]);
const unknownVariableIssues = issueByCode(
    unknownSymbolVariables,
    "SYMBOL_UNKNOWN_PLACEHOLDER",
);
assert.deepEqual(
    unknownVariableIssues.map((issue) => issue.elementId),
    [
        "unknown-qr-variable",
        "unknown-barcode-variable",
        "unknown-ean-variable",
        "unknown-datamatrix-variable",
    ],
    "all three symbol types must block undeclared placeholders before encoding literal braces",
);
assert.ok(unknownVariableIssues.every((issue) => issue.severity === "error"));

const nestedUnresolvedRow = labelDoc([{
    id: "nested-unresolved-qr",
    kind: "qr",
    pos: { x: 1, y: 1 },
    size: { w: 20, h: 20 },
    data: "{payload}",
    fieldName: "payload",
    ecc: "M",
    cell: 4,
}]);
nestedUnresolvedRow.dataFeed = {
    columns: [{ id: "payload", name: "payload" }],
    rows: [{ id: "row-1", cells: { payload: "{missing_nested}" } }],
};
assert.equal(
    issueByCode(nestedUnresolvedRow, "SYMBOL_UNKNOWN_PLACEHOLDER").length,
    0,
    "a declared data column is valid at design time",
);
const nestedIssues = preflightLabelForPrinter(nestedUnresolvedRow, { copyIndex: 0 });
assert.equal(
    nestedIssues.filter((issue) => issue.code === "SYMBOL_UNRESOLVED_PLACEHOLDER").length,
    1,
    "a placeholder left inside the resolved row value must block printing",
);
assert.match(
    nestedIssues.find((issue) => issue.code === "SYMBOL_UNRESOLVED_PLACEHOLDER").message,
    /\{missing_nested\}.*row 1/,
);

const validTemplateAndBuiltinVariables = labelDoc([
    {
        id: "template-qr",
        kind: "qr",
        pos: { x: 1, y: 1 },
        size: { w: 16, h: 16 },
        data: "{qr_payload}",
        ecc: "M",
        cell: 4,
    },
    {
        id: "builtin-barcode",
        kind: "barcode",
        pos: { x: 18, y: 1 },
        size: { w: 40, h: 12 },
        data: "{row}",
        symbology: "CODE128",
        humanReadable: false,
    },
    {
        id: "template-dm",
        kind: "datamatrix",
        pos: { x: 1, y: 19 },
        size: { w: 16, h: 16 },
        data: "{dm_payload}",
    },
]);
validTemplateAndBuiltinVariables.templateFields = [
    { id: "tf-qr", name: "qr_payload", value: "QR-OK" },
    { id: "tf-dm", name: "dm_payload", value: "DM-OK" },
];
assert.equal(
    preflightLabelForPrinter(validTemplateAndBuiltinVariables, { copyIndex: 0 })
        .filter((issue) => issue.code === "SYMBOL_UNKNOWN_PLACEHOLDER" ||
            issue.code === "SYMBOL_UNRESOLVED_PLACEHOLDER").length,
    0,
    "template-field defaults and built-ins must resolve even without a Data Feed",
);

const reducerBaseDoc = labelDoc([
    {
        id: "edit-qr",
        kind: "qr",
        pos: { x: 1, y: 1 },
        size: { w: 14, h: 14 },
        data: "QR",
        ecc: "M",
        cell: 4,
    },
    {
        id: "edit-barcode",
        kind: "barcode",
        pos: { x: 16, y: 1 },
        size: { w: 40, h: 12 },
        data: "BAR",
        symbology: "CODE128",
        humanReadable: false,
    },
    {
        id: "edit-dm",
        kind: "datamatrix",
        pos: { x: 1, y: 17 },
        size: { w: 14, h: 14 },
        data: "DM",
    },
]);
reducerBaseDoc.dataFeed = defaultDataFeed();
let reducerState = {
    doc: reducerBaseDoc,
    selectedId: null,
    selectedIds: [],
    editingId: null,
    snapToGrid: true,
    showGrid: true,
    highlightVars: true,
    zoom: 1,
    feedOpen: false,
    feedFullscreen: false,
    previewRowId: null,
};
for (const [id, name] of [
    ["edit-qr", "new_qr"],
    ["edit-barcode", "new_barcode"],
    ["edit-dm", "new_dm"],
]) {
    reducerState = labelReducer(reducerState, {
        type: "updateElement",
        id,
        patch: { data: `{${name}}` },
    });
}
assert.deepEqual(
    reducerState.doc.dataFeed.columns
        .filter((column) => !column.system)
        .map((column) => column.name),
    ["new_qr", "new_barcode", "new_dm"],
    "editing any symbol placeholder must immediately create a fillable Data Feed column",
);
reducerState = labelReducer(reducerState, {
    type: "addElement",
    element: {
        id: "added-ean",
        kind: "barcode",
        pos: { x: 1, y: 31 },
        size: { w: 50, h: 8 },
        data: "{new_ean}",
        symbology: "EAN13",
        humanReadable: true,
    },
});
assert.equal(
    reducerState.doc.dataFeed.columns.some((column) => column.name === "new_ean"),
    true,
    "a newly inserted symbol with a placeholder must also expose that binding in Data Feed",
);

const templateDefaultDoc = {
    ...labelDoc([{
        id: "template-default-qr",
        kind: "qr",
        pos: { x: 1, y: 1 },
        size: { w: 16, h: 16 },
        data: "{catalog_code}",
        ecc: "M",
        cell: 4,
    }]),
    templateFields: [{ id: "catalog", name: "catalog_code", value: "CAT-001" }],
};
const loadedTemplateDefault = labelReducer(reducerState, {
    type: "load",
    doc: templateDefaultDoc,
});
assert.equal(
    loadedTemplateDefault.doc.dataFeed.columns.some(
        (column) => column.name.toLowerCase() === "catalog_code",
    ),
    false,
    "loading a template field must not create an empty row column that overrides its default",
);

const resolvedRowDoc = labelDoc([{
    id: "row-barcode",
    kind: "barcode",
    pos: { x: 1, y: 1 },
    size: { w: 50, h: 12 },
    data: "{SKU}",
    fieldName: "SKU",
    symbology: "CODE128",
    humanReadable: false,
}]);
resolvedRowDoc.dataFeed = {
    columns: [{ id: "sku", name: "SKU" }],
    rows: [{ id: "row-1", cells: { sku: "café" } }],
};
assert.equal(
    issueByCode(resolvedRowDoc, "BARCODE_INVALID_DATA").length,
    0,
    "design-time preflight must defer unknown row values",
);
const resolvedRowIssues = preflightLabelForPrinter(resolvedRowDoc, { copyIndex: 0 });
assert.equal(
    resolvedRowIssues.filter((issue) => issue.code === "BARCODE_INVALID_DATA").length,
    1,
    "the actual resolved row must be validated before printing",
);

const validResolvedEanDoc = labelDoc([{
    id: "row-ean",
    kind: "barcode",
    pos: { x: 1, y: 1 },
    size: { w: 50, h: 12 },
    data: "{EAN}",
    fieldName: "EAN",
    symbology: "EAN13",
    humanReadable: true,
}]);
validResolvedEanDoc.dataFeed = {
    columns: [{ id: "ean", name: "EAN" }],
    rows: [{ id: "row-1", cells: { ean: "5901234123457" } }],
};
assert.equal(
    preflightLabelForPrinter(validResolvedEanDoc, { copyIndex: 0 })
        .filter((issue) => issue.severity === "error").length,
    0,
    "a valid resolved EAN-13 row must pass before printing",
);

const qrTooSmall = issueByCode(
    labelDoc([
        {
            id: "qr-v2-too-small",
            kind: "qr",
            pos: { x: 1, y: 1 },
            size: { w: 2, h: 2 },
            data: "QR",
            ecc: "M",
            cell: 1,
            version: 2,
        },
    ]),
    "QR_TOO_SMALL_FOR_MODULE_MATRIX",
);
assert.equal(qrTooSmall.length, 1);
assert.equal(qrTooSmall[0].elementId, "qr-v2-too-small");
assert.match(qrTooSmall[0].message, /25 × 25 matrix plus/);

const longQrPayload = "LONG-QR-PAYLOAD-".repeat(10);
const longQrModules = qrModuleCount(longQrPayload, "H");
assert.ok(longQrModules > 21, "long high-ECC payload should require more than QR version 1");
const longQrTooSmall = issueByCode(
    labelDoc([
        {
            id: "long-qr-too-small",
            kind: "qr",
            pos: { x: 1, y: 1 },
            size: { w: 3, h: 3 },
            data: longQrPayload,
            ecc: "H",
            cell: 1,
        },
    ]),
    "QR_TOO_SMALL_FOR_MODULE_MATRIX",
);
assert.equal(longQrTooSmall.length, 1);
assert.equal(longQrTooSmall[0].elementId, "long-qr-too-small");
assert.match(
    longQrTooSmall[0].message,
    new RegExp(`${longQrModules} × ${longQrModules} matrix plus`),
);

const legacyText = issueByCode(
    labelDoc([
        {
            id: "legacy-text",
            kind: "text",
            pos: { x: 1, y: 1 },
            size: { w: 20, h: 5 },
            text: "Legacy",
            rotation: 0,
            font: "D",
            scaleX: 1,
            scaleY: 1,
        },
    ]),
    "LEGACY_TEXT_WITHOUT_PHYSICAL_SIZE",
);
assert.equal(legacyText.length, 1);
assert.equal(legacyText[0].severity, "info");

// Fractional millimetre coordinates are normal and intentionally do not
// produce per-element quantisation noise.
assert.deepEqual(
    preflightLabelForPrinter(
        labelDoc([
            {
                id: "fractional-position",
                kind: "image",
                pos: { x: 0.013, y: 0.027 },
                size: { w: 1.111, h: 1.137 },
                src: "data:image/png;base64,",
                threshold: 128,
            },
        ]),
    ),
    [],
);

console.log("DPI/model preflight tests passed.");
