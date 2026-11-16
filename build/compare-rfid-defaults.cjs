const { resolveWebSource } = require("../scripts/web-source.cjs");
// Compare existing (suffix-disabled) output against the source repository's HEAD.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { execFileSync } = require("node:child_process");
const source = resolveWebSource();
const ts = require(path.join(source, "node_modules/typescript"));
const prefix = execFileSync("git", ["rev-parse", "--show-prefix"], { cwd: source, encoding: "utf8" }).trim();
const previous = new Map();
for (const name of ["label-data", "zebra-document", "zpl", "full-page-raster", "dpi-preflight"]) {
    const relative = `app/${name}.ts`;
    previous.set(path.join(source, relative), execFileSync("git", ["show", `HEAD:${prefix}${relative}`], { cwd: source, encoding: "utf8" }));
}
let baseline = true;
require.extensions[".ts"] = (module, filename) => {
    const input = baseline && previous.has(filename) ? previous.get(filename) : fs.readFileSync(filename, "utf8");
    module._compile(ts.transpileModule(input, { compilerOptions: {
        module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
    }, fileName: filename }).outputText, filename);
};
function snapshots() {
    const { buildZpl, buildFullPageZpl } = require(path.join(source, "app/zpl.ts"));
    const { preflightLabelForPrinter } = require(path.join(source, "app/dpi-preflight.ts"));
    const { resolveDocForCopy, variablesForCopy } = require(path.join(source, "app/label-data.ts"));
    const outputs = [];
    const text = { id: "text", kind: "text", text: "EPC: {rfid_read}", pos: { x: 2, y: 2 }, size: { w: 75, h: 5 },
        rotation: 0, font: "D", scaleX: 1, scaleY: 1, fontSizeMm: 3 };
    const bitmap = { widthDots: 8, heightDots: 1, widthBytes: 1, bytes: new Uint8Array([0]) };
    for (const model of ["zt610r", "zd621r"]) for (const dpi of model === "zt610r" ? [203, 300, 600] : [203, 300]) {
        for (const readMode of ["pc", "fixed"]) for (const resolved of [false, true]) for (const encode of [false, true]) {
            const doc = { id: "legacy", name: "Legacy", settings: { widthMm: 100, heightMm: 60, gapMm: 3, dpi, copies: 2,
                targetPrinterModel: model, speed: 4, darkness: 10,
                serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
                rfid: { enabled: encode, chip: "epc_96", epcBits: 96, format: "H", retries: 3, block: 2, words: 6,
                    data: "300833B2DDD90140000000AB", readEnabled: true, readBank: "EPC", readFieldName: "rfid_read",
                    zebraEpcReadMode: readMode, readStartBlock: 2, zebraReadByteCount: 12, zebraModel: model, zebraUsePrinterSettings: true } },
                elements: [text, { ...text, id: "bound", text: "sample", fieldName: "rfid_read", pos: { x: 2, y: 9 } },
                    { id: "barcode", kind: "barcode", data: "{rfid_read}", pos: { x: 2, y: 17 }, size: { w: 90, h: 12 }, symbology: "CODE128", humanReadable: true },
                    { id: "qr", kind: "qr", data: "{rfid_read}", pos: { x: 2, y: 34 }, size: { w: 20, h: 20 }, ecc: "M", cell: 4, sizeMode: "manual", magnification: 4 },
                    { id: "dm", kind: "datamatrix", data: "{rfid_read}", pos: { x: 40, y: 34 }, size: { w: 20, h: 20 }, sizeMode: "manual", magnification: 4, minModuleMm: 0.15 }],
                ...(resolved ? { templateFields: [{ name: "rfid_read", value: "300833B2DDD90140000000AB" }] } : {}) };
            const vars = variablesForCopy(doc, 0);
            outputs.push({ model, dpi, readMode, resolved, encode, zpl: buildZpl(doc),
                bitmap: buildFullPageZpl(doc.settings, bitmap, 1, { elements: doc.elements, vars,
                    rfidData: doc.settings.rfid.data, emitResolvedRfidReadFields: true }),
                preview: resolveDocForCopy(doc, 0, vars), preflight: preflightLabelForPrinter(doc, { copyIndex: 0 }) });
        }
    }
    return outputs;
}
const before = snapshots();
for (const name of Object.keys(require.cache)) if (name.startsWith(path.join(source, "app") + path.sep)) delete require.cache[name];
baseline = false;
const after = snapshots();
assert.deepEqual(after, before);
const output = path.join(__dirname, "rfid-text-qa");
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "legacy-comparison.json"), JSON.stringify({ passed: true, cases: after.length,
    compared: ["native ZPL", "bitmap ZPL overlays", "resolved preview", "preflight"], baselineCommit:
        execFileSync("git", ["rev-parse", "HEAD"], { cwd: source, encoding: "utf8" }).trim() }, null, 2));
console.log(`Legacy output matches HEAD exactly in ${after.length} cases (two models, supported DPIs, PC/fixed reads, host/printer data, encoding on/off).`);
