/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX }, fileName: filename,
}).outputText, filename);
const { RawSpoolBatch, RawSpoolBatchPendingError } = require("../app/raw-spool-batch.ts");
const { validateSpoolHexRows } = require("../app/raw-spool-preflight.ts");
const { stageServerRawSpoolBatch } = require("../app/server-raw-print.ts");
const { BUILT_IN_TEMPLATES } = require("../app/templates.ts");
const { listPendingWindowsSpoolBatches, forgetMissingWindowsSpoolBatch } = require("../app/windows-raw-print.ts");

function connector({ dropAppend, dropCommit, pending = false } = {}) {
    const requests = [], parts = [];
    let status, jobs = 0, droppedAppend = false, droppedCommit = false;
    const transport = async (request) => {
        requests.push(structuredClone(request));
        if (request.action === "begin") {
            status ??= { ok: true, batchId: request.batchId, state: "staging", nextSequence: 1, stagedBytes: 0, stagedLabels: 0, totalLabels: request.totalLabels, jobId: null };
        } else if (request.action === "append") {
            assert.equal(jobs, 0, "preparation must not submit anything to Windows");
            const payload = Buffer.from(request.payloadBase64, "base64");
            if (request.sequence < status.nextSequence) assert.deepEqual(payload, parts[request.sequence - 1]);
            else {
                assert.equal(request.sequence, status.nextSequence);
                parts.push(payload); status.nextSequence += 1;
                status.stagedBytes += payload.length; status.stagedLabels += request.labelCount;
            }
            if (dropAppend && !droppedAppend) { droppedAppend = true; throw new Error("append response lost"); }
        } else if (request.action === "commit") {
            assert.equal(request.totalBytes, status.stagedBytes);
            assert.equal(request.totalChunks, parts.length);
            assert.equal(status.totalLabels, status.stagedLabels);
            if (!jobs) { jobs += 1; status.jobId = 42; status.state = pending ? "spooling" : "spool-accepted"; }
            if (dropCommit && !droppedCommit) { droppedCommit = true; throw new Error("commit response lost"); }
        } else if (request.action === "cancel") {
            assert.equal(jobs, 0, "cannot automatically cancel after commit");
            status.state = "cancelled";
        }
        return structuredClone(status);
    };
    return { transport, requests, parts, get jobs() { return jobs; } };
}

async function main() {
    const mock = connector({ dropAppend: true, dropCommit: true });
    const batch = new RawSpoolBatch(mock.transport, { batchId: "order-2500", printerName: "Zebra", documentName: "2500 rows", totalLabels: 2500 });
    await batch.begin();
    for (let start = 0; start < 2500; start += 17) {
        const count = Math.min(17, 2500 - start);
        const payload = Buffer.from(Array.from({ length: count }, (_, i) => String(start + i + 1).padStart(4, "0")).join("\n") + "\n");
        await batch.append(payload, count);
    }
    assert.equal((await batch.commit()).jobId, 42);
    assert.equal(mock.jobs, 1);
    assert.deepEqual(Buffer.concat(mock.parts).toString().trim().split("\n"), Array.from({ length: 2500 }, (_, i) => String(i + 1).padStart(4, "0")));
    assert(mock.requests.every((request) => request.batchId === "order-2500"));
    assert.equal(mock.requests.filter((r) => r.action === "begin").length, 1);

    const interrupted = connector();
    const preparation = new RawSpoolBatch(interrupted.transport, { batchId: "render-error", printerName: "Zebra", documentName: "broken row", totalLabels: 2 });
    await preparation.begin(); await preparation.append(Buffer.from("row1"), 1);
    await assert.rejects(() => preparation.commit(), /incomplete/);
    await preparation.cancelPreparation();
    assert.equal(interrupted.jobs, 0);
    assert(!interrupted.requests.some((r) => r.action === "commit"));

    const slow = connector({ pending: true, dropCommit: true });
    const unknown = new RawSpoolBatch(slow.transport, { batchId: "same-id", printerName: "Zebra", documentName: "slow", totalLabels: 1 });
    await unknown.begin(); await unknown.append(Buffer.from("one"), 1);
    await assert.rejects(() => unknown.commit({ timeoutMs: 0 }), (error) => error instanceof RawSpoolBatchPendingError && error.batchId === "same-id");
    await unknown.cancelPreparation();
    assert.equal(slow.jobs, 1);
    assert(!slow.requests.some((r) => r.action === "cancel"));
    assert(slow.requests.some((r) => r.action === "status"));

    const rejected = Object.assign(new Error("printer is not allowed"), { status: 403 });
    let rejectionRequests = 0;
    const forbidden = new RawSpoolBatch(async () => { rejectionRequests += 1; throw rejected; }, { batchId: "rejected", printerName: "Zebra", documentName: "rejected", totalLabels: 1 });
    await assert.rejects(() => forbidden.begin(), (error) => error === rejected);
    await forbidden.cancelPreparation(); assert.equal(rejectionRequests, 1);

    const queueConflict = Object.assign(new Error("printer queue is blocked"), { status: 409 });
    const conflictActions = []; let rejectedCallback = false;
    const conflict = new RawSpoolBatch(async (request) => {
        conflictActions.push(request.action);
        throw request.action === "status" ? Object.assign(new Error("not found"), { status: 404 }) : queueConflict;
    }, { batchId: "not-created", printerName: "Zebra", documentName: "blocked", totalLabels: 1 }, undefined, () => { rejectedCallback = true; });
    await assert.rejects(() => conflict.begin(), (error) => error === queueConflict);
    await conflict.cancelPreparation();
    assert.deepEqual(conflictActions, ["begin", "status"]); assert(rejectedCallback);

    const doc = structuredClone(BUILT_IN_TEMPLATES[0]);
    doc.dataFeed = undefined; doc.templateFields = [];
    doc.settings.copies = 2500;
    doc.settings.serial = { enabled: true, start: 1, step: 1, pad: 4, prefix: "B" };
    doc.settings.rfid.enabled = false; doc.settings.rfid.readEnabled = false;
    doc.elements = [{ id: "row", kind: "text", pos: { x: 1, y: 1 }, size: { w: 50, h: 5 }, rotation: 0, text: "{serial}", font: "D", scaleX: 1, scaleY: 1, fontSizeMm: 3 }];
    const native = connector();
    const originalFetch = global.fetch;
    global.fetch = async (url, init) => new Response(JSON.stringify(String(url).endsWith("/v1/health")
        ? { capabilities: { rawSpoolBatchV1: true } }
        : await native.transport(JSON.parse(init.body))), { status: 200, headers: { "Content-Type": "application/json" } });
    try {
        const result = await stageServerRawSpoolBatch({ agentUrl: "http://mock", printerName: "Zebra", documentName: "native order", batchId: "native-2500", template: doc, values: {} });
        assert.equal(result.status.stagedLabels, 2500); assert.equal(native.jobs, 1);
        const serials = Array.from(Buffer.concat(native.parts).toString().matchAll(/\^FDB(\d{4})\^FS/g), (match) => match[1]);
        assert.deepEqual(serials, Array.from({ length: 2500 }, (_, i) => String(i + 1).padStart(4, "0")));
    } finally { global.fetch = originalFetch; }
    const hexDoc = structuredClone(doc);
    hexDoc.settings.rfid = { ...hexDoc.settings.rfid, enabled: true, format: "H", data: "{epc}", fieldName: "epc", epcBits: 96, words: 6, autoEpcBitsFromData: false };
    hexDoc.templateFields = [{ name: "epc", value: "" }];
    assert.throws(() => validateSpoolHexRows(hexDoc, 0, 1), /Empty EPC/);
    for (const value of ["GGGG", "123", "12345678901234567890123456789012"]) {
        hexDoc.templateFields[0].value = value;
        assert.throws(() => validateSpoolHexRows(hexDoc, 0, 1), /RFID HEX validation/);
    }
    hexDoc.templateFields[0].value = "123456789012345678901234";
    assert.doesNotThrow(() => validateSpoolHexRows(hexDoc, 0, 1));
    hexDoc.settings.rfid.format = "A"; hexDoc.templateFields[0].value = "customer ASCII";
    assert.doesNotThrow(() => validateSpoolHexRows(hexDoc, 0, 1));

    const oldWindow = global.window;
    const storage = new Map([["zbre.pending-spool-batches.v1", JSON.stringify([{ batchId: "ghost", agentUrl: "http://127.0.0.1:18791", printerName: "Zebra" }])]]);
    global.window = { location: { hostname: "localhost" }, setTimeout, clearTimeout, localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } };
    try {
        global.fetch = async (url) => {
            if (String(url).endsWith("/v1/health")) return new Response(JSON.stringify({ capabilities: { rawSpoolBatchV1: true } }), { status: 200 });
            throw new TypeError("disconnected");
        };
        await assert.rejects(() => forgetMissingWindowsSpoolBatch("http://127.0.0.1:18791", "ghost"));
        assert.equal(listPendingWindowsSpoolBatches("http://127.0.0.1:18791", "Zebra").length, 1, "connection failure must never erase pending identity");
        global.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith("/v1/health")
            ? { capabilities: { rawSpoolBatchV1: true } } : { error: "batch not found" }), { status: String(url).endsWith("/v1/health") ? 200 : 404 });
        await forgetMissingWindowsSpoolBatch("http://127.0.0.1:18791", "ghost");
        assert.equal(listPendingWindowsSpoolBatches("http://127.0.0.1:18791", "Zebra").length, 0);
    } finally { global.fetch = originalFetch; global.window = oldWindow; }
    console.log("Durable spool batch tests passed: 2,500 ordered rows, one job, idempotent timeouts, preparation cancellation and HEX validation.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
