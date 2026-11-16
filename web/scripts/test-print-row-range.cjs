/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
const { selectPrintRowRange, printRowIndexAt } = require("../app/print-row-range.ts");
const { validateSpoolHexRows } = require("../app/raw-spool-preflight.ts");
const { variablesForCopy } = require("../app/label-data.ts");
const { planPrintBatchChunks } = require("../app/print-batch.ts");
const { buildZpl } = require("../app/zpl.ts");
const { BUILT_IN_TEMPLATES } = require("../app/templates.ts");
const indices = range => Array.from({ length: range.quantity }, (_, i) => printRowIndexAt(range, i));

for (const [from, to, count, step] of [[2350,1750,601,-1], [1750,2350,601,1], [1,2500,2500,1], [2500,1,2500,-1], [1750,1750,1,1]]) {
    const range = selectPrintRowRange(2500, from, to);
    assert.equal(range.quantity, count); assert.equal(range.step, step);
    const ordered = indices(range);
    assert.equal(ordered[0], from - 1); assert.equal(ordered.at(-1), to - 1);
    assert.equal(new Set(ordered).size, count);
    for (let i = 1; i < count; i++) assert.equal(ordered[i] - ordered[i - 1], step);
    assert.throws(() => printRowIndexAt(range, -1), RangeError);
    assert.throws(() => printRowIndexAt(range, count), RangeError);
}
assert.deepEqual(indices(selectPrintRowRange(5, 99, -2)), [4,3,2,1,0]);
assert.deepEqual(indices(selectPrintRowRange(5, 4.9, 2.7)), [3,2,1]);
assert.deepEqual(indices(selectPrintRowRange(5, NaN, Infinity)), [0]);

const doc = structuredClone(BUILT_IN_TEMPLATES[0]);
doc.templateFields = [];
doc.settings.copies = 1;
doc.settings.serial = { enabled: true, start: 1, step: 1, pad: 4, prefix: "S" };
doc.settings.rfid = { ...doc.settings.rfid, enabled: true, readEnabled: false, format: "H", data: "{HEX}", fieldName: "HEX", epcBits: 96, words: 6, autoEpcBitsFromData: false, zebraUsePrinterSettings: true };
doc.dataFeed = {
    columns: [{ id: "hex", name: "HEX" }, { id: "row", name: "original_row", formula: "=ROW()" }],
    rows: Array.from({ length: 2500 }, (_, i) => ({ id: `r${i}`, cells: { hex: (i + 1).toString(16).padStart(24, "0").toUpperCase() } })),
};
doc.elements = [{ id: "text", kind: "text", text: "{original_row}|{serial}", pos: { x: 1, y: 1 }, size: { w: 30, h: 5 }, font: "D", scaleX: 1, scaleY: 1, rotation: 0 }];
const before = JSON.stringify(doc);
const range = selectPrintRowRange(2500, 2350, 1750);
validateSpoolHexRows(doc, range.fromIdx, range.quantity, range.step);
const chunks = planPrintBatchChunks(range.quantity, 10).map(chunk => {
    const rows = Array.from({ length: chunk.quantity }, (_, i) => printRowIndexAt(range, chunk.startIndex + i));
    for (const index of rows) {
        const vars = variablesForCopy(doc, index);
        assert.equal(vars.original_row, String(index + 1));
        assert.equal(vars.serial, `S${String(index + 1).padStart(4, "0")}`);
    }
    return rows.map(index => buildZpl(doc, index)).join("");
});
assert.equal(chunks.length, 61);
const rendered = [...chunks.join("").matchAll(/\^RFW,H[^\^]*\^FD([0-9A-F]+)\^FS/g)].map(match => match[1]);
assert.equal(rendered.length, 601, "one HEX write for every selected row");
assert.deepEqual(rendered, indices(range).map(index => doc.dataFeed.rows[index].cells.hex));
assert.equal(JSON.stringify(doc), before, "printing backwards must not reverse or mutate the feed");

doc.dataFeed.rows[0].cells.hex = "BAD-OUTSIDE-RANGE";
assert.doesNotThrow(() => validateSpoolHexRows(doc, range.fromIdx, range.quantity, range.step));
doc.dataFeed.rows[1999].cells.hex = "NOT-HEX";
doc.dataFeed.rows[1799].cells.hex = "ALSO-NOT-HEX";
assert.throws(() => validateSpoolHexRows(doc, range.fromIdx, range.quantity, range.step), /data row 2000:/);
assert.throws(() => validateSpoolHexRows(doc, 1749, 601), /data row 1800:/);
console.log("Print row ranges passed: ascending/descending, 601 and 2,500 rows, chunk boundaries, original ROW/serial values and HEX preflight order.");
