/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const { test } = require("node:test");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(
    fs.readFileSync(filename, "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename },
).outputText, filename);
const { PrintCancellation, PrintCancelledError } = require("../app/print-cancellation.ts");
const { deliverBufferedPrintStream } = require("../app/buffered-print-stream.ts");
const { waitForZebraDrainBarrier } = require("../app/zebra-drain-barrier.ts");
const { cancelTcpPrinterBuffer } = require("../app/tcp-job-cancel.ts");
const { runExclusivePrinterJob } = require("../app/print-job-coordinator.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
const hq = "\x02\r\nPRINTER STATUS\r\nERRORS: 1 00000000 00010000\r\nWARNINGS: 0 00000000 00000000\r\n\x03\r\n";
const hs = (count = 0, partial = false) => `\x02000,0,1,0251,${String(count).padStart(3,"0")},0,0,${+partial},000,0,0,0\x03\r\n\x02000,0,0,0,1,2,6,0,${String(count).padStart(8,"0")},1,001\x03\r\n\x021234,1\x03\r\n`;

test("Cancel stops future chunks but joins the active write before clearing", async () => {
    const control = new PrintCancellation(), events = [];
    let completeWrite, producerClosed = false, settled = false;
    async function* source() {
        try { for (let i = 0; i < 200; i++) yield { payload: new Uint8Array(10) }; }
        finally { producerClosed = true; }
    }
    const stream = deliverBufferedPrintStream(source(), async () => {
        events.push("labels");
        await new Promise(resolve => { completeWrite = resolve; });
        events.push("write settled");
    }, { abortSignal: control.signal });
    const stopped = assert.rejects(stream, PrintCancelledError).then(() => { settled = true; events.push("clear allowed"); });
    await tick(); control.request(); await tick();
    assert.equal(settled, false);
    assert.deepEqual(events, ["labels"]);
    completeWrite(); await stopped;
    assert.equal(producerClosed, true);
    assert.deepEqual(events, ["labels", "write settled", "clear allowed"]);
});

test("Cancel during first render discards the rendered chunk and closes the producer", async () => {
    const control = new PrintCancellation();
    let release, closed = false, sends = 0;
    async function* source() {
        try { await new Promise(resolve => { release = resolve; }); yield { payload: new Uint8Array(1) }; }
        finally { closed = true; }
    }
    const stopped = assert.rejects(deliverBufferedPrintStream(source(), async () => { sends++; }, { abortSignal: control.signal }), PrintCancelledError);
    control.request(); release(); await stopped;
    assert.equal(sends, 0); assert.equal(closed, true);
});

test("Cancel while paused joins the in-flight query and issues no later status query", async () => {
    const control = new PrintCancellation();
    let release, queries = 0, settled = false;
    const barrier = waitForZebraDrainBarrier(async () => { queries++; await new Promise(resolve => { release = resolve; }); return hq; }, { signal: control.signal });
    const stopped = assert.rejects(barrier, PrintCancelledError).then(() => { settled = true; });
    control.request(); await tick(); assert.equal(settled, false);
    release(); await stopped; assert.equal(queries, 1);
});

test("Cancel wakes the ordinary Pause polling delay without a Resume", async () => {
    const control = new PrintCancellation();
    let queries = 0;
    const barrier = waitForZebraDrainBarrier(async () => { queries++; return hq; }, { signal: control.signal });
    const stopped = assert.rejects(barrier, PrintCancelledError);
    await tick(); control.request(); await stopped; assert.equal(queries, 1);
});

test("Cancel clears on the same session, verifies empty while paused, and never sends Resume", async () => {
    const events = [], replies = [hs(4), hs(), hs(0, true), hs(), hs()];
    let clock = 0;
    const result = await cancelTcpPrinterBuffer({
        append: async payload => { events.push(Buffer.from(payload).toString().trim()); },
        query: async command => { events.push(command.trim()); return replies.shift(); },
        finish: async () => { events.push("finish"); },
    }, { now: () => clock, sleep: async ms => { clock += ms; } });
    assert.equal(result.paused, true);
    assert.deepEqual(events, ["~JA", "~HS", "~HS", "~HS", "~HS", "~HS", "finish"]);
});

test("A lost clear/status response must not finish or silently reopen a job", async () => {
    let finishes = 0, writes = 0;
    await assert.rejects(cancelTcpPrinterBuffer({
        append: async () => { writes++; },
        query: async () => { throw new Error("Cable disconnected"); },
        finish: async () => { finishes++; },
    }), /Cable disconnected/);
    assert.equal(writes, 1); assert.equal(finishes, 0);
});

test("A printer that stays nonempty after Cancel is not reported cancelled", async () => {
    let clock = 0, finishes = 0;
    await assert.rejects(cancelTcpPrinterBuffer({
        append: async () => {}, query: async () => hs(2), finish: async () => { finishes++; },
    }, { timeoutMs: 400, now: () => clock, sleep: async ms => { clock += ms; } }), /not confirmed an empty buffer/);
    assert.equal(finishes, 0);
});

test("Cancelling a waiting job returns promptly without releasing the active FIFO owner", async () => {
    const control = new PrintCancellation(), events = [];
    let release;
    const first = runExclusivePrinterJob("cancel-queue-test", async () => { events.push("first"); await new Promise(resolve => { release = resolve; }); });
    await tick();
    const second = assert.rejects(runExclusivePrinterJob("cancel-queue-test", async () => { events.push("CANCELLED JOB RAN"); }, undefined, control.signal), PrintCancelledError);
    const third = runExclusivePrinterJob("cancel-queue-test", async () => { events.push("third"); });
    control.request(); await second; assert.deepEqual(events, ["first"]);
    release(); await Promise.all([first, third]); assert.deepEqual(events, ["first", "third"]);
});

test("The finish boundary rejects a late Cancel rather than relabelling a finished job", () => {
    const control = new PrintCancellation(); control.seal();
    assert.equal(control.request(), false); assert.equal(control.signal.aborted, false);
    const cancelled = new PrintCancellation(); cancelled.request();
    assert.throws(() => cancelled.seal(), PrintCancelledError);
});
