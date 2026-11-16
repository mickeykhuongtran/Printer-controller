/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => {
    module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
        fileName: filename,
    }).outputText, filename);
};
const { buildZpl, buildFullPageZpl, buildZebraRfidReadCommand, buildZebraRfidWriteCommand } = require("../app/zpl.ts");
const { resolveTextValue, resolveDocForCopy, variablesForCopy } = require("../app/label-data.ts");
const { parseZebraDocument } = require("../app/zebra-document.ts");
const { preflightLabelForPrinter } = require("../app/dpi-preflight.ts");
const { renderLabelToBitmap } = require("../app/full-page-raster.ts");

const epc = "300833B2DDD90140000000AB";
const rfid = { enabled: false, chip: "epc_96", epcBits: 96, format: "H", retries: 3, block: 2, words: 6, data: "",
    readEnabled: true, readBank: "EPC", readFieldName: "rfid_read", zebraEpcReadMode: "pc", zebraUsePrinterSettings: true };
const text = { id: "tail", kind: "text", text: "{rfid_read}", rfidReadLastChars: 6, pos: { x: 2, y: 2 },
    size: { w: 56, h: 6 }, rotation: 0, font: "D", scaleX: 1, scaleY: 1, fontSizeMm: 3 };
const settings = { widthMm: 60, heightMm: 40, gapMm: 3, dpi: 300, copies: 1, speed: 4, darkness: 10,
    serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" }, rfid };
const doc = { id: "suffix-test", name: "RFID tail", settings, elements: [text] };
const bitmap = { widthDots: 8, heightDots: 1, widthBytes: 1, bytes: new Uint8Array([0]) };

// Reference models, not a firmware emulator. Zebra's ^FE example interprets
// b,1,N as a backward range; the reported ZT610R output is consistent with an
// end-relative start followed by a forward range. One-character references
// have the same meaning in both. Evaluate emitted fields, not the JS preview.
function evaluateConcatFields(zpl, source, backwardRange = false) {
    return [...zpl.matchAll(/\^FE(.)\^FD([^\^]*)\^FS/g)].map(([, delimiter, data]) => {
        const parts = data.split(delimiter);
        return parts.map((part, index) => {
            if (index % 2 === 0) return part;
            const reference = /^(\d+)(?:,([fb]),(\d+),(\d+))?$/.exec(part);
            assert.ok(reference, `valid field reference: ${part}`);
            assert.equal(reference[1], "1", "all outputs use the same EPC source");
            if (!reference[2]) return source;
            const offset = Number(reference[3]), count = Number(reference[4]);
            if (offset > source.length) return "";
            if (reference[2] === "f") return source.slice(offset - 1, offset - 1 + count);
            const start = source.length - offset;
            return backwardRange
                ? source.slice(Math.max(0, start - count + 1), start + 1)
                : source.slice(start, start + count);
        }).join("");
    });
}

const reportedEpcs = ["E280F30200000001744AC695", "E280F30200000001744AC696"];
assert.deepEqual(evaluateConcatFields("^FE#^FD#1,b,1,6#^FS", reportedEpcs[0]), ["5"],
    "reproduce the reported one-character result under end-relative start semantics");
assert.deepEqual(evaluateConcatFields(buildZpl(doc), reportedEpcs[0]), ["4AC695"],
    "printer field output must retain all six characters, independently of preview");

const vars = Object.freeze({ rfid_read: epc, lot: "LOT1" });
assert.equal(resolveTextValue(text, "", vars, rfid), "0000AB");
assert.equal(resolveTextValue({ ...text, text: "EPC: {rfid_read} / {lot}" }, "", vars, rfid), "EPC: 0000AB / LOT1");
assert.equal(resolveTextValue({ ...text, text: "{rfid_read}-{rfid_read}" }, "", vars, rfid), "0000AB-0000AB");
assert.equal(resolveTextValue({ ...text, text: "sample", fieldName: "rfid_read" }, "", vars, rfid), "0000AB");
assert.equal(resolveTextValue({ ...text, text: "EPC: {rfid_read}", fieldName: "rfid_read" }, "", vars, rfid), "EPC: 0000AB");
assert.equal(resolveTextValue({ ...text, text: "{ Read_EPC }" }, "", { read_epc: epc }, { ...rfid, readFieldName: "Read_EPC" }), "0000AB");
for (const n of [1, 3, 6, 24, 30, 128]) {
    assert.equal(resolveTextValue({ ...text, rfidReadLastChars: n }, "", vars, rfid), epc.slice(-n));
}
assert.equal(resolveTextValue(text, "", { rfid_read: "AB" }, rfid), "AB", "N longer than value retains all available characters");
assert.equal(resolveTextValue(text, "", undefined, rfid), "{rfid_read}", "no fabricated value on the print path");
assert.equal(resolveTextValue(text, "", undefined, rfid, true), "FFFFFF", "preview estimates six HEX characters");
assert.equal(resolveTextValue({ ...text, text: "EPC: {rfid_read} / X" }, "", undefined, rfid, true), "EPC: FFFFFF / X");
for (const invalid of [undefined, 0, -1, 6.5, NaN, Infinity, 129, "6"]) {
    assert.equal(resolveTextValue({ ...text, rfidReadLastChars: invalid }, "", vars, rfid), epc);
}
assert.equal(resolveTextValue({ ...text, text: "unchanged" }, "", vars, rfid), "unchanged");
assert.equal(resolveTextValue(text, "", vars, { ...rfid, readEnabled: false }), epc);
assert.equal(vars.rfid_read, epc);

const plain = { ...text, rfidReadLastChars: undefined };
for (const model of ["zt610r", "zd621r"]) {
    const modelSettings = { ...settings, targetPrinterModel: model, rfid: { ...rfid, zebraModel: model } };
    const modelDoc = { ...doc, settings: modelSettings };
    for (const content of [text, { ...text, text: "sample", fieldName: "rfid_read" }, { ...text, text: "EPC: {rfid_read}" }]) {
        for (const zpl of [buildZpl({ ...modelDoc, elements: [content] }),
            buildFullPageZpl(modelSettings, bitmap, 1, { elements: [content] })]) {
            assert.match(zpl, /\^RFR,H,,,E\^FN1\^FS/);
            for (const backwardRange of [false, true]) {
                assert.deepEqual(evaluateConcatFields(zpl, epc, backwardRange),
                    [content.text.startsWith("EPC: ") ? "EPC: 0000AB" : "0000AB"]);
            }
            assert.doesNotMatch(zpl, /\^RFW|FFFFFF|\{rfid_read\}/);
        }
    }
    const fullText = { ...plain, id: "whole", pos: { x: 2, y: 10 } };
    const qr = { id: "qr", kind: "qr", data: "{rfid_read}", pos: { x: 30, y: 15 }, size: { w: 20, h: 20 }, ecc: "M", cell: 4 };
    const dm = { id: "dm", kind: "datamatrix", data: "{rfid_read}", pos: { x: 5, y: 15 },
        size: { w: 20, h: 20 }, sizeMode: "manual", magnification: 4, minModuleMm: 0.15 };
    const mixed = { ...modelDoc, elements: [text, fullText, qr, dm] };
    const qrOnly = buildZpl({ ...modelDoc, elements: [qr] }).match(/\^BQ[^\n]+/g);
    const dmOnly = buildZpl({ ...modelDoc, elements: [dm] }).match(/\^BX[^\n]+/g);
    for (const zpl of [buildZpl(mixed), buildFullPageZpl(modelSettings, bitmap, 1, { elements: mixed.elements })]) {
        assert.doesNotMatch(zpl, /\^DF|\^XF/, "preserve the single active format required by current RFID firmware handling");
        assert.ok(evaluateConcatFields(zpl, reportedEpcs[0]).includes("4AC695"));
        assert.match(zpl, /\^FN1\^FS/, "other Text keeps full RFID binding");
        assert.deepEqual(zpl.match(/\^BQ[^\n]+/g), qrOnly, "QR payload unchanged");
        assert.deepEqual(zpl.match(/\^BX[^\n]+/g), dmOnly, "Data Matrix retains the full EPC binding");
        assert.equal((zpl.match(/\^RFR/g) || []).length, 1, "one read per label format");
    }
    for (const n of [1, 3, 6, 24, 30, 128]) {
        const selected = { ...text, rfidReadLastChars: n };
        for (const zpl of [buildZpl({ ...modelDoc, elements: [selected] }),
            buildFullPageZpl(modelSettings, bitmap, 1, { elements: [selected] })]) {
            for (const source of [...reportedEpcs, epc, "01", "000000", ""]) {
                for (const backwardRange of [false, true]) {
                    assert.deepEqual(evaluateConcatFields(zpl, source, backwardRange), [source.slice(-n)],
                        `${model}: N=${n}, EPC=${source}, backwardRange=${backwardRange}`);
                }
            }
        }
    }
    const readBefore = buildZebraRfidReadCommand(modelSettings.rfid);
    const writeBefore = buildZebraRfidWriteCommand({ ...modelSettings.rfid, enabled: true }, epc, model);
    const withData = { ...modelDoc, dataFeed: { columns: [{ id: "epc", name: "rfid_read" }],
        rows: [epc, "300833B2DDD90140000000CD"].map((value, index) => ({ id: `r${index}`, cells: { epc: value } })) },
        settings: { ...modelSettings, copies: 2 } };
    const zpl = buildZpl(withData);
    assert.match(zpl, /\^FD0000AB\^FS/);
    assert.match(zpl, /\^FD0000CD\^FS/);
    assert.ok(zpl.indexOf("^FD0000AB") < zpl.indexOf("^FD0000CD"), "each data row supplies its own tail");
    const resolved = resolveDocForCopy(withData, 0, variablesForCopy(withData, 0));
    assert.equal(resolved.elements[0].text, "0000AB");
    assert.equal(resolved.elements[0].fieldName, undefined);
    assert.equal(withData.elements[0].text, "{rfid_read}", "preview never overwrites the template");
    const bitmapResolved = buildFullPageZpl(modelSettings, bitmap, 1, { elements: [text], vars, emitResolvedRfidReadFields: true });
    assert.match(bitmapResolved, /\^FD0000AB\^FS/);
    assert.equal(buildZebraRfidReadCommand(modelSettings.rfid), readBefore);
    assert.equal(buildZebraRfidWriteCommand({ ...modelSettings.rfid, enabled: true }, epc, model), writeBefore);
    assert.equal(preflightLabelForPrinter(modelDoc).filter(i => i.code === "RFID_FIELD_CONCAT_REQUIRES_LINK_OS_68").length, 1);
    assert.equal(preflightLabelForPrinter(withData, { copyIndex: 0 }).filter(i => i.code === "RFID_FIELD_CONCAT_REQUIRES_LINK_OS_68").length, 0);
    assert.equal(buildZpl({ ...modelDoc, elements: [plain] }), buildZpl({ ...modelDoc, elements: [{ ...text, rfidReadLastChars: 0 }] }), "disabled suffix preserves old output");
}
const escaped = buildZpl({ ...doc, elements: [{ ...text, text: "LOT#1#: {rfid_read}" }] });
assert.match(escaped, /\^FE\|\^FDLOT#1#: /, "literal delimiter stays escaped from field references");
assert.deepEqual(evaluateConcatFields(escaped, epc), ["LOT#1#: 0000AB"]);
const twice = buildZpl({ ...doc, elements: [{ ...text, text: "{rfid_read}/{rfid_read}" }] });
assert.deepEqual(evaluateConcatFields(twice, reportedEpcs[1]), ["4AC696/4AC696"]);
const restored = parseZebraDocument(JSON.parse(JSON.stringify(doc)));
assert.equal(restored.elements[0].rfidReadLastChars, 6, "template round trip retains N");
assert.equal(parseZebraDocument({ ...doc, elements: [plain] }).elements[0].rfidReadLastChars, undefined);
assert.equal(parseZebraDocument({ ...doc, elements: [{ ...text, rfidReadLastChars: "6^FS" }] }).elements[0].rfidReadLastChars, undefined);

// Exercise the real bitmap text layout with a recording canvas (no printer or browser required).
async function checkRaster() {
    const draws = [];
    const context = new Proxy({
        measureText: value => ({ width: value.length * 15 }),
        fillText: value => draws.push(value),
        getImageData: () => ({ data: new Uint8ClampedArray(60 * 12 * 40 * 12 * 4) }),
    }, { get: (obj, name) => name in obj ? obj[name] : () => {} });
    global.document = { createElement: () => ({ getContext: () => context }) };
    await renderLabelToBitmap({ ...doc, templateFields: [{ name: "rfid_read", value: epc }] });
    assert.equal(draws.join(""), "0000AB", "bitmap renderer prints six characters from resolved EPC");
    draws.length = 0;
    await renderLabelToBitmap(doc);
    assert.equal(draws.join(""), "FFFFFF", "bitmap preview estimates suffix width");
    draws.length = 0;
    await renderLabelToBitmap(doc, 0, { skipRfidReadDynamicElements: true });
    assert.equal(draws.length, 0, "printer-read suffix is omitted from bitmap and emitted natively");
    delete global.document;
}
checkRaster().then(() => console.log("RFID Text suffix passed: both models, native/mixed/bitmap paths, preview, template round trip, full-source isolation and legacy defaults."))
    .catch(error => { console.error(error); process.exitCode = 1; });
