/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// Lightweight TypeScript loader for this focused generator test. It keeps the
// project dependency-free while allowing Node to exercise the real ZPL code.
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

const {
    buildFullPageZpl,
    buildZpl,
    buildZebraRfidSetupLines,
    buildZebraRfidHostReadCommand,
    buildZebraRfidReadCommand,
    buildZebraRfidWriteCommand,
} = require(path.join(__dirname, "..", "app", "zpl.ts"));
const {
    ZEBRA_RFID_QUERY_KEYS,
    buildZebraJsonGetCommand,
    buildZebraRfidSgdConfigCommand,
    normalizeZebraProgramPosition,
    parseZebraJsonMap,
    parseZebraRfidHostReadData,
    parseZebraSgdValues,
    zebraRfidConfigMismatches,
    zebraRfidPatchFromSgd,
    zebraRfidPatchFromValues,
    zebraRfidSgdConfigValues,
    zebraRfidSnapshotFromValues,
} = require(path.join(__dirname, "..", "app", "zebra-rfid.ts"));
const {
    rfidPayloadForPreview,
    zebraRfidFixedReadByteCount,
    zebraRfidReadHexCharacterCount,
} = require(path.join(__dirname, "..", "app", "rfid.ts"));
const { renderBarcode, scanSafeBarcodeNarrowDots } = require(
    path.join(__dirname, "..", "app", "barcode.ts"),
);
const { dotsPerMm, dotsToMm, mmToDots } = require(
    path.join(__dirname, "..", "app", "units.ts"),
);
const {
    compatiblePrinterDpi,
    maxPrintSpeedIps,
    printerDotSize,
} = require(path.join(__dirname, "..", "app", "printer-models.ts"));
const { printerQueueDpiMismatch } = require(
    path.join(__dirname, "..", "app", "printer-target.ts"),
);
const {
    buildZebraAlignmentGetCommand,
    buildZebraAlignmentSetCommand,
    parseZebraAlignmentResponse,
} = require(path.join(__dirname, "..", "app", "zebra-printer-alignment.ts"));

const rfid = {
    enabled: false,
    chip: "epc_96",
    epcBits: 96,
    autoEpcBitsFromData: false,
    format: "H",
    retries: 3,
    block: 2,
    words: 6,
    data: "",
    readEnabled: true,
    readBank: "EPC",
    readStartBlock: 2,
    readLength: 24,
    readFieldName: "rfid_read",
    zebraEpcReadMode: "fixed",
    zebraReadByteCount: 12,
    zebraUsePrinterSettings: true,
};

const settings = {
    widthMm: 60,
    heightMm: 40,
    gapMm: 3,
    dpi: 203,
    copies: 1,
    speed: 4,
    darkness: 10,
    printMode: "thermal_transfer",
    tearOffMm: 10,
    sensorMode: 2,
    startOffsetDots: 0,
    rowOffsetDots: 0,
    codePage: 850,
    serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
    rfid,
};

const elements = [
    {
        id: "epc_text",
        kind: "text",
        pos: { x: 2, y: 2 },
        size: { w: 56, h: 5 },
        text: "EPC: {rfid_read}",
        rotation: 0,
        font: "D",
        scaleX: 1,
        scaleY: 1,
    },
    {
        id: "epc_barcode",
        kind: "barcode",
        pos: { x: 2, y: 9 },
        size: { w: 56, h: 12 },
        data: "{rfid_read}",
        symbology: "CODE128",
        humanReadable: false,
        minModuleMm: 0.125,
    },
    {
        id: "epc_qr",
        kind: "qr",
        pos: { x: 42, y: 23 },
        size: { w: 17, h: 17 },
        data: "{rfid_read}",
        ecc: "M",
        cell: 4,
        magnification: 4,
    },
];

const bitmap = {
    widthDots: 8,
    heightDots: 1,
    widthBytes: 1,
    bytes: new Uint8Array([0]),
};

assert.deepEqual(
    [203, 300, 600].map((dpi) => dotsPerMm(dpi)),
    [8, 12, 24],
    "Zebra resolutions must use the project's exact 8/12/24 dots-per-mm grid",
);
assert.deepEqual(
    [203, 300, 600].map((dpi) => printerDotSize(60, 40, dpi)),
    [
        { widthDots: 480, heightDots: 320 },
        { widthDots: 720, heightDots: 480 },
        { widthDots: 1440, heightDots: 960 },
    ],
    "60x40 mm must preserve physical geometry while output dot dimensions follow DPI",
);
assert.equal(mmToDots(104, 203), 832, "203 dpi width conversion must use 8 dots/mm");
assert.equal(dotsToMm(832, 203), 104, "GET media must reverse the same exact conversion");
assert.equal(compatiblePrinterDpi("zd621r", 600), 300, "ZD621R must reject a 600 dpi target");
assert.equal(maxPrintSpeedIps("zt610r", 300), 12, "ZT610R 300 dpi speed limit must be 12 ips");
assert.equal(maxPrintSpeedIps("zd621r", 300), 6, "ZD621R 300 dpi speed limit must be 6 ips");
assert.equal(
    Object.keys(
        zebraRfidPatchFromSgd(
            Array.from({ length: ZEBRA_RFID_QUERY_KEYS.length }, () => '"?"').join("\n"),
        ).patch,
    ).length,
    0,
    "unsupported SGD RFID variables must not masquerade as calibrated RFID settings",
);
assert.deepEqual(
    parseZebraSgdValues('\x02"15"\x03\r\n'),
    ["15"],
    "STX/ETX framing must not corrupt an individual SGD value",
);

const keyedGetCommand = buildZebraJsonGetCommand([
    "rfid.enable",
    "rfid.reader_1.power.read",
]);
assert.ok(
    keyedGetCommand.startsWith("{}"),
    "Link-OS keyed GET must use the JSON command prefix",
);
assert.deepEqual(
    JSON.parse(keyedGetCommand.slice(2)),
    {
        "rfid.enable": null,
        "rfid.reader_1.power.read": null,
    },
    "Link-OS keyed GET must request values by SGD key instead of response order",
);
assert.deepEqual(
    parseZebraJsonMap(
        [
            "\x02{}",
            '{"rfid.enable":null,"rfid.reader_1.power.read":null}',
            '{"rfid.enable":"on","rfid.reader_1.power.read":15}',
            "\x03",
        ].join(""),
        ["rfid.enable", "rfid.reader_1.power.read"],
    ),
    {
        "rfid.enable": "on",
        "rfid.reader_1.power.read": "15",
    },
    "keyed JSON parsing must tolerate framing and an echoed request",
);
assert.deepEqual(
    parseZebraJsonMap(
        '{"rfid":{"reader_1":{"power":{"read":"14","write":"16"}}}}',
        ["rfid.reader_1.power.read", "rfid.reader_1.power.write"],
    ),
    {
        "rfid.reader_1.power.read": "14",
        "rfid.reader_1.power.write": "16",
    },
    "nested Link-OS JSON must flatten to canonical SGD keys",
);

const calibratedValues = {
    "rfid.enable": "on",
    "rfid.reader_1.model": "M6e-Micro",
    "rfid.reader_1.firmware_version": "1.23.4",
    "rfid.reader_1.hardware_version": "2",
    "rfid.position.program": "F12",
    "rfid.reader_1.power.read": "15",
    "rfid.reader_1.power.write": "16",
    "rfid.reader_1.antenna_port": "c3",
    "rfid.adaptive_antenna": "neighbors",
    "rfid.region_code": "EU3",
    "rfid.error.response": "OK",
    "odometer.rfid.valid_resettable": "1234",
    "odometer.rfid.void_resettable": "9",
};
const calibratedSnapshot = zebraRfidSnapshotFromValues(calibratedValues);
assert.equal(calibratedSnapshot.state, "ready", "a complete calibrated RFID snapshot must be ready");
assert.equal(calibratedSnapshot.readerDetected, true, "reader diagnostics must identify the RF module");
assert.deepEqual(
    calibratedSnapshot.patch,
    {
        zebraPositionMode: "forward",
        writePositionMm: 12,
        zebraReadPower: 15,
        zebraWritePower: 16,
        zebraAntenna: "C3",
        zebraAdaptiveAntenna: true,
    },
    "GET RFID must import only validated tuning fields",
);
assert.equal(
    Object.prototype.hasOwnProperty.call(calibratedSnapshot.patch, "zebraModel"),
    false,
    "an RF reader module name must never be mistaken for the printer model",
);
assert.equal(calibratedSnapshot.validCount, 1234, "valid-label diagnostics must parse");
assert.equal(calibratedSnapshot.voidCount, 9, "VOID-label diagnostics must parse");

const unknownSnapshot = zebraRfidSnapshotFromValues({
    "rfid.enable": "on",
    "rfid.reader_1.model": "M6e-Micro",
    "rfid.position.program": "?",
    "rfid.reader_1.power.read": "?",
    "rfid.reader_1.power.write": "?",
    "rfid.reader_1.antenna_port": "?",
});
assert.equal(
    unknownSnapshot.state,
    "unconfigured",
    "a present RFID reader with unknown tuning must be reported as unconfigured",
);
assert.deepEqual(
    zebraRfidPatchFromValues({
        "rfid.position.program": "B31",
        "rfid.reader_1.power.read": "",
        "rfid.reader_1.power.write": "31",
        "rfid.reader_1.antenna_port": "A5",
    }),
    {},
    "blank and out-of-range values must not become power zero or clamped configuration",
);
assert.equal(normalizeZebraProgramPosition("B30"), "B30", "B30 is the backward limit");
assert.equal(normalizeZebraProgramPosition("B31"), null, "backward position above B30 is invalid");
assert.equal(normalizeZebraProgramPosition("F999"), "F999", "F999 is the forward limit");

const explicitSgdSettings = {
    ...rfid,
    zebraModel: "zt610r",
    zebraPositionMode: "forward",
    writePositionMm: 12,
    zebraReadPower: 15,
    zebraWritePower: 16,
    zebraAntenna: "C3",
    zebraAdaptiveAntenna: true,
};
assert.deepEqual(
    zebraRfidSgdConfigValues(explicitSgdSettings, { allowAdaptiveAntenna: true }),
    {
        "rfid.position.program": "F12",
        "rfid.reader_1.power.read": "15",
        "rfid.reader_1.power.write": "16",
        "rfid.reader_1.antenna_port": "C3",
        "rfid.adaptive_antenna": "neighbors",
    },
    "SET RFID must include explicit multi-element tuning only",
);
assert.doesNotMatch(
    buildZebraRfidSgdConfigCommand(
        { ...rfid, zebraModel: "zt610r", power: 20 },
        { allowAdaptiveAntenna: true },
    ),
    /power\.(?:read|write)/,
    "persistent SET must not copy the legacy template power implicitly",
);
assert.equal(
    zebraRfidSgdConfigValues(explicitSgdSettings, { allowAdaptiveAntenna: false })[
        "rfid.adaptive_antenna"
    ],
    "none",
    "SET must actively disable neighbor search below Zebra's minimum label length",
);
assert.equal(
    zebraRfidSgdConfigValues(
        { ...explicitSgdSettings, zebraAdaptiveAntenna: false },
        { allowAdaptiveAntenna: false },
    )["rfid.adaptive_antenna"],
    "none",
    "an unsafe prior neighbor-search setting must still be possible to disable",
);
assert.deepEqual(
    zebraRfidConfigMismatches(
        {
            "rfid.position.program": "F12",
            "rfid.reader_1.power.read": "15",
        },
        {
            "rfid.position.program": "f12",
            "rfid.reader_1.power.read": "16",
        },
    ),
    [
        {
            key: "rfid.reader_1.power.read",
            expected: "15",
            actual: "16",
        },
    ],
    "SET read-back verification must normalize text and identify the exact mismatch",
);

assert.deepEqual(
    buildZebraRfidSetupLines({
        ...rfid,
        zebraUsePrinterSettings: true,
        zebraPositionMode: "calibrated",
        zebraErrorHandling: "P",
    }),
    ["^RS8,,,1,N"],
    "read-and-print must override legacy pause/retry policy without changing calibrated tuning",
);
assert.deepEqual(
    buildZebraRfidSetupLines({
        ...rfid,
        zebraUsePrinterSettings: false,
        zebraPositionMode: "calibrated",
        retries: 3,
    }),
    ["^RS8,,,1,N"],
    "read-and-print must attempt each physical label once and continue after VOID",
);
assert.ok(
    buildZebraRfidSetupLines({
        ...rfid,
        zebraUsePrinterSettings: false,
        zebraPositionMode: "forward",
        writePositionMm: 12,
        retries: 2,
        zebraErrorHandling: "E",
    }).includes("^RS8,F12,,1,N"),
    "read-and-print preserves explicit antenna position while overriding legacy error/retry policy",
);
assert.equal(
    printerQueueDpiMismatch("Zebra ZD621R 203 dpi", 300)?.queueDpi,
    203,
    "an explicit Windows queue DPI conflict must be detected before printing",
);

const zpl = buildFullPageZpl(settings, bitmap, 1, {
    elements,
    sn: "",
    vars: {},
});

assert.equal(
    buildZebraRfidReadCommand(rfid),
    "^RFR,H,2,12,1^FN1^FS",
    "24 EPC HEX characters must map to 12 bytes at EPC word 2",
);
const maximumFixedRead = {
    ...rfid,
    zebraEpcReadMode: "fixed",
    zebraReadByteCount: 64,
    readLength: 128,
};
assert.equal(zebraRfidFixedReadByteCount(maximumFixedRead), 64);
assert.equal(zebraRfidReadHexCharacterCount(maximumFixedRead), 128);
assert.equal(
    buildZebraRfidReadCommand(maximumFixedRead),
    "^RFR,H,2,64,1^FN1^FS",
    "a 64-byte fixed read must preserve all 128 returned HEX characters",
);
assert.match(
    buildZebraRfidHostReadCommand(maximumFixedRead),
    /\^HV1,128,DATA:/,
    "host diagnostics must reserve the same 128 HEX characters as the print field",
);
assert.equal(
    zebraRfidReadHexCharacterCount({
        ...maximumFixedRead,
        zebraEpcReadMode: "pc",
        epcBits: 128,
    }),
    32,
    "EPC PC mode must size from PC bits rather than the fixed byte-count control",
);
assert.equal(
    buildZebraRfidWriteCommand(
        {
            ...rfid,
            enabled: true,
            autoEpcBitsFromData: true,
            zebraModel: "zt610r",
        },
        "1122334455667788",
    ),
    "^RFW,H,,,A^FD1122334455667788^FS",
    "ZT610R variable-length EPC writes must use bank A so Zebra updates Gen2 PC length bits",
);
assert.equal(
    buildZebraRfidWriteCommand(
        {
            ...rfid,
            enabled: true,
            autoEpcBitsFromData: true,
            zebraModel: "zd621r",
        },
        "1122334455667788",
    ),
    "^RFW,H,2,8,1^FD1122334455667788^FS",
    "models without documented ^RF bank-A support must retain the explicit EPC bank write",
);
const exactEpc96 = "112233445566778899001122";
assert.equal(
    buildZebraRfidWriteCommand(
        {
            ...rfid,
            enabled: true,
            zebraModel: "zt610r",
        },
        exactEpc96,
    ),
    `^RFW,H,,,A^FD${exactEpc96}^FS`,
    "an exact 96-bit EPC must reach Zebra unchanged and begin at EPC word 2",
);
assert.throws(
    () => buildZebraRfidWriteCommand(
        {
            ...rfid,
            enabled: true,
            zebraModel: "zt610r",
        },
        `ABCD${exactEpc96}`,
    ),
    /Expected 24 hex chars for 96-bit EPC, got 28.*not truncated or sent/i,
    "an oversized EPC must be rejected instead of silently dropping its first word",
);
assert.throws(
    () => buildZebraRfidWriteCommand(
        {
            ...rfid,
            enabled: true,
            zebraModel: "zt610r",
        },
        "NOT-HEX-DATA",
    ),
    /EPC must be hexadecimal only.*not truncated or sent/i,
    "hex mode must reject non-hex data instead of converting it behind the user's back",
);
assert.equal(
    rfidPayloadForPreview(rfid, `ABCD${exactEpc96}`),
    `ABCD${exactEpc96}`,
    "RFID preview must expose an oversized EPC in full instead of hiding its first word",
);
assert.match(zpl, /\^FH\\\^FE#\^FDEPC: #1#\^FS/, "text must concatenate the shared EPC field");
assert.match(zpl, /\^BCN,[^\r\n]*,A\^FN1\^FS/, "Code 128 must use automatic mode and the shared EPC field");
assert.match(zpl, /\^BQN,2,4\^FH\\\^FE#\^FDMA,#1#\^FS/, "QR must concatenate EPC inside QR field data");
assert.doesNotMatch(zpl, /\^FD[A-Z]A,\^FN1/, "QR must not embed a ZPL command inside ^FD");
assert.equal((zpl.match(/\^RFR/g) ?? []).length, 1, "one label must perform exactly one RFID read");
assert.equal((zpl.match(/\^XA/g) ?? []).length, 1, "one label must use one active ^XA format");
assert.equal((zpl.match(/\^XZ/g) ?? []).length, 1, "one label must use one active ^XZ format");
assert.doesNotMatch(
    zpl,
    /~TA/,
    "normal jobs must preserve the printer's persistent Tear-off configuration",
);
assert.match(zpl, /\^MTT/, "thermal-transfer templates must emit Zebra ^MTT");
const readIndex = zpl.indexOf("^RFR,H,2,12,1^FN1^FS");
assert.ok(zpl.indexOf("^FDEPC: #1#^FS") < readIndex, "text field must precede the RFID read");
assert.ok(zpl.indexOf("^BCN,") < readIndex, "Code 128 field must precede the RFID read");
assert.ok(zpl.indexOf("^BQN,2,4") < readIndex, "QR field must precede the RFID read");
assert.doesNotMatch(zpl, /\^LT0(?:\D|$)/, "default job must preserve printer Label Top");
assert.doesNotMatch(zpl, /\^LS0(?:\D|$)/, "default job must preserve printer Left Position");

const literalHashZpl = buildFullPageZpl(settings, bitmap, 1, {
    elements: [{ ...elements[0], text: "LOT#1#: {rfid_read}" }],
    sn: "",
    vars: {},
});
assert.match(
    literalHashZpl,
    /\^FH\\\^FE\|\^FDLOT#1#: \|1\|\^FS/,
    "^FE must choose a delimiter absent from literal content instead of consuming #1# text",
);

assert.equal(
    buildZebraAlignmentGetCommand(),
    '! U1 getvar "zpl.label_top"\n! U1 getvar "zpl.left_position"',
    "alignment GET must use the Zebra Link-OS variables exposed by the printer menu",
);
assert.equal(
    buildZebraAlignmentSetCommand({ labelTopDots: 10, leftPositionDots: -20 }),
    '! U1 setvar "zpl.label_top" "10"\n! U1 setvar "zpl.left_position" "-20"',
    "alignment SET must write only Zebra Label Top and Left Position",
);
assert.deepEqual(
    parseZebraAlignmentResponse('"10"\r\n"-20"\r\n'),
    { labelTopDots: 10, leftPositionDots: -20 },
    "quoted Zebra SGD alignment responses must parse in query order",
);
assert.equal(
    parseZebraAlignmentResponse('"?"\r\n"-20"\r\n'),
    null,
    "unsupported Zebra SGD variables must not overwrite the local alignment profile",
);
const alignedZpl = buildFullPageZpl(settings, bitmap, 1, {
    alignment: { labelTopDots: 0, leftPositionDots: 0 },
});
assert.match(alignedZpl, /\^LT0(?:\D|$)/, "a local printer profile must explicitly emit ^LT0");
assert.match(alignedZpl, /\^LS0(?:\D|$)/, "a local printer profile must explicitly emit ^LS0");
const shiftedZpl = buildFullPageZpl(settings, bitmap, 1, {
    alignment: { labelTopDots: 12, leftPositionDots: -34 },
});
assert.match(shiftedZpl, /\^LT12(?:\D|$)/, "print jobs must apply the selected Label Top");
assert.match(shiftedZpl, /\^LS-34(?:\D|$)/, "print jobs must apply the selected Left Position");

const worstCaseCode128 = renderBarcode("F".repeat(24), "CODE128");
assert.equal(worstCaseCode128.symbolModules, 299, "24 HEX characters need 299 Code 128 modules");
assert.equal(worstCaseCode128.totalModules, 319, "Code 128 sizing must reserve 10X quiet zones");
assert.equal(scanSafeBarcodeNarrowDots(300), 3, "300 dpi must use at least a 3-dot X dimension");

const barcode300 = {
    ...elements[1],
    pos: { x: 2, y: 9 },
    size: { w: 80, h: 12 },
    align: "left",
    widthMode: "scan_safe",
};
const settings300 = { ...settings, widthMm: 100, dpi: 300 };
const zpl300 = buildFullPageZpl(settings300, bitmap, 1, {
    elements: [barcode300],
    sn: "",
    vars: {},
});
assert.match(
    zpl300,
    /\^FO54,108\^BY3,2\.0,144\^BCN,144,N,N,N,A\^FN1\^FS/,
    "300-dpi RFID Code 128 must use 3-dot modules, valid ratio, automatic mode, and a 10X quiet zone",
);
assert.doesNotMatch(zpl300, /\^BY[12],/, "an 80 mm frame at 300 dpi must not emit unsafe 1/2-dot bars");

const legacyText = {
    id: "legacy_text",
    kind: "text",
    pos: { x: 2, y: 2 },
    size: { w: 30, h: 8 },
    text: "Legacy",
    rotation: 0,
    font: "D",
    scaleX: 1,
    scaleY: 1,
};
const legacyTextZpl203 = buildZpl({
    id: "legacy_203",
    name: "Legacy 203",
    settings: { ...settings, dpi: 203 },
    elements: [legacyText],
});
const legacyTextZpl300 = buildZpl({
    id: "legacy_300",
    name: "Legacy 300",
    settings: { ...settings, dpi: 300 },
    elements: [legacyText],
});
const legacyTextZpl600 = buildZpl({
    id: "legacy_600",
    name: "Legacy 600",
    settings: { ...settings, dpi: 600 },
    elements: [legacyText],
});
assert.match(legacyTextZpl203, /\^A0N,18,18/, "legacy font D must retain its 203-dpi physical height");
assert.match(legacyTextZpl300, /\^A0N,27,27/, "legacy font D must scale to 300-dpi dots");
assert.match(legacyTextZpl600, /\^A0N,54,54/, "legacy font D must scale to 600-dpi dots");

const epcValue = "5D54A62D90CCA62D90CC8057";
const resolved300 = buildFullPageZpl(settings300, bitmap, 1, {
    elements: [barcode300],
    sn: "",
    vars: { rfid_read: epcValue },
    emitResolvedRfidReadFields: true,
});
assert.match(
    resolved300,
    /\^FO24,108\^GFA,/,
    "a host-resolved EPC must use the same scan-safe exact Code 128 bitmap as preview",
);
assert.doesNotMatch(
    resolved300,
    /\^BC/,
    "a host-resolved EPC must not let printer firmware choose a different Code 128 subset",
);

const offsetZpl = buildFullPageZpl(
    { ...settings, startOffsetDots: 5, rowOffsetDots: -3 },
    bitmap,
    1,
);
assert.match(offsetZpl, /\^LT5(?:\D|$)/, "non-zero document Label Top override must remain available");
assert.match(offsetZpl, /\^LS-3(?:\D|$)/, "non-zero document Left Position override must remain available");

const hostRead = buildZebraRfidHostReadCommand(rfid);
const noReplayZpl = buildFullPageZpl(settings, bitmap, 1);
assert.ok(noReplayZpl.indexOf("^JZN") < noReplayZpl.indexOf("^RFR"), "disable firmware error reprint before reading an RFID tag");
assert.match(noReplayZpl, /\^XA\n\^JZN\n/);
assert.doesNotMatch(noReplayZpl, /\^JZY|\^JUS/, "do not restore replay or persist a printer-wide change");
assert.doesNotMatch(buildFullPageZpl({ ...settings, rfid: { ...rfid, enabled: false, readEnabled: false } }, bitmap, 1), /\^JZ/, "ordinary labels retain their existing error-reprint mode");
assert.match(hostRead, /\^RFR,H,2,12,1\^FN1\^FS/, "diagnostic must test the fixed print read");
assert.match(hostRead, /\^HV1,24,DATA:/, "diagnostic must return all 24 EPC HEX characters");
assert.equal(
    parseZebraRfidHostReadData("DATA:112233445566778899001122\r\n"),
    "112233445566778899001122",
    "host verification response must parse without treating DATA as hexadecimal",
);
assert.equal(
    parseZebraRfidHostReadData("02000400\r\n"),
    null,
    "an RFID error code without the DATA header must not be reported as EPC data",
);

console.log(
    "Zebra test passed: DPI/model limits, route mismatch, RFID parsing, and EPC output are valid.",
);
