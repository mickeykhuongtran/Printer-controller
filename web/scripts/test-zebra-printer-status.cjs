/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const sourcePath = path.join(__dirname, "..", "app", "zebra-printer-status.ts");
const source = fs.readFileSync(sourcePath, "utf8");
const output = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2019,
    },
    fileName: sourcePath,
}).outputText;
const loadedModule = { exports: {} };
new Function("exports", "module", "require", output)(
    loadedModule.exports,
    loadedModule,
    require,
);

const {
    isZebraHostStatusDrained,
    parseZebraHostStatus,
    parseZebraHqesStatus,
    parseZebraPrinterStatus,
} = loadedModule.exports;

const ready = parseZebraPrinterStatus(
    '"0","0","00000000","00000000","0","00000000","00000000"\r\n',
);
assert.equal(ready.level, "ready");
assert.equal(ready.paused, false);
assert.deepEqual(ready.reasons, ["Printer is ready"]);

const paused = parseZebraPrinterStatus(
    '"1","0","00000000","00000000","0","00000000","00000000"',
);
assert.equal(paused.level, "paused");
assert.equal(paused.paused, true);

const pausedHeadOpen = parseZebraPrinterStatus(
    '"1,1,00000000,00000004,0,00000000,00000000"',
);
assert.equal(pausedHeadOpen.level, "error");
assert.equal(pausedHeadOpen.paused, true);
assert.ok(pausedHeadOpen.errors.includes("Printhead open"));

const warning = parseZebraPrinterStatus(
    "0,0,00000000,00000000,1,00000000,00000002",
);
assert.equal(warning.level, "warning");
assert.ok(warning.warnings.includes("Clean printhead"));

assert.throws(
    () => parseZebraPrinterStatus(""),
    /empty status response/i,
);
assert.throws(
    () => parseZebraPrinterStatus("unexpected printer text"),
    /expected 7 fields/i,
);

const hqesReady = parseZebraHqesStatus(
    "\x02\r\nPRINTER STATUS\r\n"
    + "ERRORS:         0 00000000 00000000\r\n"
    + "WARNINGS:       0 00000000 00000000\r\n\x03\r\n",
);
assert.equal(hqesReady.level, "ready");

const hqesHeadOpen = parseZebraHqesStatus(
    "\x02\r\nPRINTER STATUS\r\n"
    + "ERRORS:         1 00000000 00000004\r\n"
    + "WARNINGS:       1 00000000 00000002\r\n\x03\r\n",
);
assert.equal(hqesHeadOpen.level, "error");
assert.ok(hqesHeadOpen.errors.includes("Printhead open"));
assert.ok(hqesHeadOpen.warnings.includes("Clean printhead"));

assert.throws(
    () => parseZebraHqesStatus("PRINTER STATUS\r\nREADY"),
    /valid ~HQES payload/i,
);

const drainedHostResponse =
    "\x02000,0,0,1200,000,0,0,0,000,0,0,0\x03\r\n"
    + "\x02000,0,0,0,1,2,6,0,00000000,1,001\x03\r\n"
    + "\x021234,1\x03\r\n";
const drainedHostStatus = parseZebraHostStatus(drainedHostResponse);
assert.equal(drainedHostStatus.formatsInReceiveBuffer, 0);
assert.equal(drainedHostStatus.labelsRemaining, 0);
assert.equal(drainedHostStatus.labelWaiting, false);
assert.equal(drainedHostStatus.headUp, false);
assert.equal(isZebraHostStatusDrained(drainedHostStatus), true);

const busyHostResponse =
    "\x02000,0,0,1200,002,1,0,1,000,0,0,0\x03\r\n"
    + "\x02000,0,0,0,1,2,6,1,00000012,1,001\x03\r\n"
    + "\x021234,1\x03\r\n";
const busyHostStatus = parseZebraHostStatus(busyHostResponse);
assert.equal(busyHostStatus.formatsInReceiveBuffer, 2);
assert.equal(busyHostStatus.bufferFull, true);
assert.equal(busyHostStatus.partialFormat, true);
assert.equal(busyHostStatus.labelsRemaining, 12);
assert.equal(busyHostStatus.labelWaiting, true);
assert.equal(isZebraHostStatusDrained(busyHostStatus), false);

assert.throws(
    () => parseZebraHostStatus(
        "\x02000,0,0,1200,000,0,0,0,000,0,0,0\x03\r\n"
        + "\x02000,0,0,0,1,2,6,0,00000000,1,001\x03\r\n",
    ),
    /exactly 3 frames/i,
);
assert.throws(
    () => parseZebraHostStatus(`echo${drainedHostResponse}`),
    /outside its framed payloads/i,
);
assert.throws(
    () => parseZebraHostStatus(drainedHostResponse.replace("00000000", "0")),
    /labels remaining/i,
);
assert.throws(
    () => parseZebraHostStatus(drainedHostResponse.replace(",000,0,0,0\x03", ",001,0,0,0\x03")),
    /unused string-1/i,
);

console.log("Zebra printer status parser tests passed.");
