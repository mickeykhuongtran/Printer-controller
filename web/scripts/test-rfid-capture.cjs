/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
}).outputText, filename);

const { buildFullPageZpl } = require("../app/zpl.ts");
const { variablesForCopy } = require("../app/label-data.ts");
const { buildRfidCaptureZpl, assertRfidCaptureComplete } = require("../app/rfid-capture.ts");
const { iteratePrintBatchChunks, assertPrintBatchQuantity } = require("../app/print-batch.ts");
const rfid = { enabled: false, readEnabled: true, captureToHost: true, readBank: "EPC", readFieldName: "rfid_read", zebraEpcReadMode: "pc", chip: "epc_96", epcBits: 96, format: "H", retries: 3, block: 2, words: 6, data: "" };
const doc = { id: "read-capture-test", name: "Read EPC", settings: { widthMm: 80, heightMm: 40, gapMm: 3, dpi: 300, copies: 3001, speed: 4, darkness: 10,
    serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" }, rfid },
    elements: [{ id: "read-text", kind: "text", text: "EPC: {rfid_read}", rfidReadLastChars: 6, pos: { x: 2, y: 2 }, size: { w: 60, h: 8 }, rotation: 0, font: "D", scaleX: 1, scaleY: 1 }],
    templateFields: [{ id: "old-read", name: "rfid_read", value: "DEADBEEF" }] };
const bitmap = { widthBytes: 1, heightDots: 1, bytes: Uint8Array.of(0), widthDots: 8 };
for (const model of ["zt610r", "zd621r"]) {
    doc.settings.targetPrinterModel = model;
    const vars = variablesForCopy(doc, 1674);
    assert.equal(vars.rfid_read, undefined, "host-supplied value must not replace the printer read during capture");
    const zpl = buildFullPageZpl(doc.settings, bitmap, 1, { elements: doc.elements, vars, capture: { jobId: "capture-session-123", ordinal: 1675 } });
    assert.match(zpl, /\^RFR,H,,,E\^FN1\^FS/);
    assert.match(zpl, /\^RS8,,,1,N/);
    assert.match(zpl, /\^FH_\^HV1,256,NWEP\|capture-session-123\|1675\|,\|END_0D_0A,L\^FS/);
    assert.equal((zpl.match(/\^XA/g) || []).length, 1);
    assert.equal((zpl.match(/\^PQ1\b/g) || []).length, 1);
    assert.ok(!zpl.includes("^RFW") && !zpl.includes("DEADBEEF"));
    assert.ok(zpl.indexOf("^HV1") > zpl.indexOf("^RFR"));
}
assert.throws(() => buildFullPageZpl(doc.settings, bitmap, 2, { capture: { jobId: "capture-session-123", ordinal: 1 } }), /one printer-read/);
assert.throws(() => buildRfidCaptureZpl("bad^XZ", 1), /Invalid/);
assert.throws(() => buildRfidCaptureZpl("capture-session-123", 1.5), /Invalid/);
for (const readEnabled of [false, true]) {
    const writeSettings = { ...doc.settings, targetPrinterModel: "zt610r", rfid: { ...rfid, enabled: true, readEnabled, readBank: "TID", zebraErrorHandling: "P" } };
    const expected = "00112233445566778899AABB";
    const zpl = buildFullPageZpl(writeSettings, bitmap, 1, { rfidData: expected, capture: { jobId: "write-capture-123", ordinal: 3 } });
    assert.match(zpl, /\^RS8,,,1,N/);
    assert.match(zpl, /\^RFW,H,,,A\^FD00112233445566778899AABB\^FS/);
    assert.match(zpl, /\^RFR,H,2,12,1\^FN2\^FS/);
    assert.match(zpl, /\^HV2,256,NWEP\|write-capture-123\|3\|W\|00112233445566778899AABB\|,/);
    assert.ok(zpl.indexOf("^RFR,H,2,12,1^FN2") > zpl.indexOf("^RFW"));
    assert.throws(() => buildFullPageZpl(writeSettings, bitmap, 1, { capture: { jobId: "write-capture-123", ordinal: 1 } }), /non-empty EPC/);
    const ascii = { ...writeSettings, rfid: { ...writeSettings.rfid, format: "A", epcBits: 32 } };
    assert.match(buildFullPageZpl(ascii, bitmap, 1, { rfidData: "AB", capture: { jobId: "write-capture-123", ordinal: 4 } }), /\|W\|41422020\|,/);
    for (const bad of ["ABCDE", "A^", "A~", "A\u00e9"]) {
        assert.throws(() => buildFullPageZpl(ascii, bitmap, 1, { rfidData: bad, capture: { jobId: "write-capture-123", ordinal: 4 } }), /ASCII write verification/);
    }
    const fixed = { ...writeSettings, targetPrinterModel: "zd621r", rfid: { ...writeSettings.rfid, block: 4 } };
    assert.match(buildFullPageZpl(fixed, bitmap, 1, { rfidData: expected, capture: { jobId: "write-capture-123", ordinal: 1 } }), /\^RFR,H,4,12,1\^FN2\^FS/);
}
// Custom QR concatenation must preserve the same-label host evidence. The
// production generator deliberately uses a single active format for these
// templates because some printer firmware loses fields when using ^DF/^XF.
const qrElements = [{ id: "custom-rfid-qr", kind: "qr", pos: { x: 2, y: 2 }, size: { w: 30, h: 30 },
    data: "LOT:{lot}|{rfid_read}", ecc: "M", cell: 4, magnification: 4 }];
for (const model of ["zt610r", "zd621r"]) {
    for (const writeEnabled of [false, true]) {
        const expected = "00112233445566778899AABB";
        const settings = { ...doc.settings, targetPrinterModel: model, rfid: { ...rfid, enabled: writeEnabled,
            readBank: writeEnabled ? "TID" : "EPC", zebraReadByteCount: 12 } };
        const options = { elements: qrElements, vars: { lot: "LOT42" }, rfidData: writeEnabled ? expected : undefined,
            capture: { jobId: "custom-qr-capture", ordinal: 7 } };
        const zpl = buildFullPageZpl(settings, bitmap, 1, options);
        assert.equal((zpl.match(/\^XA/g) || []).length, 1, "QR capture must keep one executed physical-label format");
        assert.equal((zpl.match(/\^PQ1\b/g) || []).length, 1);
        assert.doesNotMatch(zpl, /\^D[F]|\^XF/, "Do not re-enable the unsupported stored RFID format as a capture workaround");
        assert.match(zpl, /\^BQN,2,4/);
        assert.match(zpl, /\^FDMA,LOT:LOT42\|#1#\^FS/, "QR contains the printed read field and resolved source data");
        const field = writeEnabled ? 2 : 1;
        assert.equal((zpl.match(/\^HV\d,/g) || []).length, 1, "Exactly one capture response per physical label");
        assert.match(zpl, new RegExp(`\\^HV${field},256,NWEP\\|custom-qr-capture\\|7\\|`));
        assert.ok(zpl.indexOf(`^HV${field},`) > zpl.lastIndexOf("^RFR,"), "Capture must follow every read used for the label");
        assert.ok(zpl.indexOf(`^HV${field},`) < zpl.indexOf("^PQ1"), "Capture stays inside the executed label before quantity/end");
        if (writeEnabled) {
            assert.match(zpl, /\^RFR,H,0,12,2\^FN1\^FS/, "Printed TID remains on FN1");
            assert.match(zpl, /\^RFR,H,2,12,1\^FN2\^FS/, "Write verification reads the complete written EPC into reserved FN2");
            assert.match(zpl, /\|W\|00112233445566778899AABB\|,/);
            assert.ok(zpl.indexOf("^RFW,") < zpl.indexOf("^RFR,H,2,12,1^FN2"));
            assert.throws(() => buildFullPageZpl(settings, bitmap, 1, { ...options, rfidData: "" }), /non-empty EPC/);
        } else {
            assert.match(zpl, /\^RFR,H,,,E\^FN1\^FS/);
            assert.doesNotMatch(zpl, /\^RFW/);
        }
        assert.throws(() => buildFullPageZpl(settings, bitmap, 2, options), /one printer-read/);
    }
}
assert.throws(() => buildRfidCaptureZpl("write-capture-123", 1, { expectedHex: "=INJECT", fieldNumber: 2 }), /Invalid/);
const summary = { options: { expectedLabels: 2500 }, received: 2500, uniqueLabels: 2500, issues: 0 };
assert.doesNotThrow(() => assertRfidCaptureComplete(summary));
const voidSummary = { ...summary, options: { expectedLabels: 2500, auditBatchCounters: true }, received: 2499, uniqueLabels: 2498, invalidReads: 1,
    audit: { countsKnown: true, validDelta: 2498, voidDelta: 2, totalDelta: 2498 } };
assert.doesNotThrow(() => assertRfidCaptureComplete(voidSummary), "2500 physical attempts include two counter-confirmed VOID, even if one has no host response");
assert.throws(() => assertRfidCaptureComplete({ ...voidSummary, audit: { ...voidSummary.audit, lifecycleVersion: 1, finalizationStatus: "unresolved" } }), /RFID session saved/,
    "A periodic numeric sample does not prove finality after a disconnect");
assert.doesNotThrow(() => assertRfidCaptureComplete({ ...voidSummary, audit: { ...voidSummary.audit, lifecycleVersion: 1, finalizationStatus: "verified" } }));
assert.throws(() => assertRfidCaptureComplete({ ...voidSummary, audit: { ...voidSummary.audit, countsKnown: false } }), /RFID session saved/,
    "missing host responses cannot silently become VOID without counter evidence");
for (const change of [{ received: 2499, uniqueLabels: 2499 }, { received: 2501 }, { issues: 1 }, { error: "disk full" }]) {
    assert.throws(() => assertRfidCaptureComplete({ ...summary, ...change }), /RFID session saved/);
}
for (const size of [2501, 10000, 50000]) {
    assertPrintBatchQuantity(size);
    let next = 0;
    for (const chunk of iteratePrintBatchChunks(size, 13)) {
        assert.equal(chunk.startIndex, next); assert.ok(chunk.quantity <= 13); next = chunk.endIndexExclusive;
    }
    assert.equal(next, size, "no missing/overlapping large-batch ranges");
}
const huge = iteratePrintBatchChunks(Number.MAX_SAFE_INTEGER, 100);
assert.equal(huge.next().value.quantity, 100, "planning remains lazy for large counts"); huge.return();
console.log("RFID capture ZPL, same-read binding, full EPC with suffix text, completion checks and uncapped lazy planning passed.");
