/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const { test } = require("node:test");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(
    fs.readFileSync(filename, "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename },
).outputText, filename);
const { deliverBufferedPrintStream } = require("../app/buffered-print-stream.ts");
const { waitForZebraDrainBarrier } = require("../app/zebra-drain-barrier.ts");
const { hasCompleteZebraStatusResponse } = require("../app/zebra-status-framing.ts");
const tick = () => new Promise(resolve => setImmediate(resolve));
const hq = paused => `\x02\r\nPRINTER STATUS\r\nERRORS: ${paused ? "1 00000000 00010000" : "0 00000000 00000000"}\r\nWARNINGS: 0 00000000 00000000\r\n\x03\r\n`;
const hs = (formats = 0, { full = false, partial = false, remaining = formats, waiting = false } = {}) =>
    `\x02000,0,0,0251,${String(formats).padStart(3, "0")},${+full},0,${+partial},000,0,0,0\x03\r\n`
    + `\x02000,0,0,0,1,2,6,${+waiting},${String(remaining).padStart(8, "0")},1,001\x03\r\n\x021234,1\x03\r\n`;

test("status framing waits for every byte of all three HS records", () => {
    const reply = hs();
    for (let n = 0; n < reply.length; n++) assert.equal(hasCompleteZebraStatusResponse("~HS\r\n", reply.slice(0, n)), false, `prefix ${n}`);
    assert.equal(hasCompleteZebraStatusResponse("~HS\r\n", reply), true);
    assert.equal(hasCompleteZebraStatusResponse("~HQES", hq(false)), true);
    assert.equal(hasCompleteZebraStatusResponse("~HQES", hq(false).trimEnd()), true);
    for (const bad of [reply + "garbage", reply + reply, reply.replace("0251", "\x02"), "garbage" + reply]) {
        assert.equal(hasCompleteZebraStatusResponse("~HS", bad), false);
    }
    assert.equal(hasCompleteZebraStatusResponse('! U1 getvar "zpl.system_status"', reply), false);
});

test("450 descending labels replenish a bounded nonempty printer queue; only the final barrier drains", async () => {
    let buffered = 0, sleeps = 0, maxBuffered = 0, refillsBeforeEmpty = 0, closed = false;
    const received = [], beforeAppend = [];
    const query = async command => command.trim() === "~HQES" ? hq(false) : hs(buffered);
    const sleep = async () => { sleeps++; buffered = Math.max(0, buffered - 3); };
    async function* source() {
        try {
            for (let offset = 0; offset < 450; offset += 10) {
                yield { payload: new Uint8Array(10), labels: Array.from({ length: 10 }, (_, i) => 2449 - offset - i) };
            }
        } finally { closed = true; }
    }
    await deliverBufferedPrintStream(source(), async chunk => {
        beforeAppend.push(buffered);
        if (buffered > 0) refillsBeforeEmpty++;
        buffered += chunk.labels.length; maxBuffered = Math.max(maxBuffered, buffered);
        received.push(...chunk.labels);
        await waitForZebraDrainBarrier(query, { maxBufferedFormats: 30, sleep });
    });
    assert.equal(refillsBeforeEmpty, 44);
    assert.ok(maxBuffered <= 40);
    assert.ok(buffered > 0, "submission must not drain the last chunk implicitly");
    await waitForZebraDrainBarrier(query, { sleep });
    assert.equal(buffered, 0); assert.ok(sleeps > 0); assert.equal(closed, true);
    assert.deepEqual(received, Array.from({ length: 450 }, (_, i) => 2449 - i));
    assert.equal(new Set(received).size, 450);
});

test("headroom still waits for Pause, buffer-full and partial formats, but resumes before empty", async () => {
    const polls = [hq(true), hq(true), hs(10, { full: true }), hs(10, { partial: true }), hs(10)];
    let poll = 0;
    const states = [];
    await waitForZebraDrainBarrier(async command => command.trim() === "~HQES" ? (poll < 2 ? polls[poll] : hq(false)) : polls[poll], {
        maxBufferedFormats: 30, timeoutMs: 50,
        now: () => poll < 2 ? poll * 100_000 : 200_000 + poll,
        sleep: async () => { if (++poll > 5) throw new Error("runaway"); },
        onStateChange: state => states.push(state),
    });
    assert.equal(poll, 4); assert.deepEqual(states, ["paused", "buffering"]);
});

test("final drain waits for pending copies and label-taken acknowledgement", async () => {
    let poll = 0;
    await waitForZebraDrainBarrier(async command => command.trim() === "~HQES" ? hq(false) :
        [hs(0, { remaining: 3 }), hs(0, { waiting: true }), hs()][poll], {
        sleep: async () => { if (++poll > 2) throw new Error("runaway"); },
    });
    assert.equal(poll, 2);
});

test("render lookahead is bounded during a held send and closes its producer on send failure", async () => {
    let produced = 0, closed = false, rejectSend;
    async function* source() {
        try { for (let i = 0; i < 450; i++) { produced++; yield { payload: new Uint8Array(10) }; } }
        finally { closed = true; }
    }
    const running = deliverBufferedPrintStream(source(), () => new Promise((_, reject) => { rejectSend = reject; }), { maxChunks: 4, maxBytes: 40 });
    const rejected = assert.rejects(running, /cable lost/);
    await tick();
    assert.ok(produced >= 4 && produced <= 6, `bounded count ${produced}`);
    rejectSend(new Error("cable lost")); await rejected;
    assert.equal(closed, true);
});

test("render failure stops queued sends and waits for the in-flight receipt", async () => {
    let sends = 0, release;
    async function* source() {
        for (let i = 0; i < 5; i++) yield { payload: new Uint8Array(10) };
        throw new Error("invalid EPC on next row");
    }
    const running = deliverBufferedPrintStream(source(), () => { sends++; return new Promise(resolve => { release = resolve; }); });
    let settled = false;
    const rejected = assert.rejects(running, /invalid EPC/).then(() => { settled = true; });
    await tick(); assert.equal(settled, false); assert.equal(sends, 1);
    release(); await rejected; assert.equal(sends, 1);
});

test("byte budget supports one oversized chunk without deadlock and preserves order", async () => {
    const sizes = [100, 2, 3, 70, 1], sent = [];
    async function* source() { for (const size of sizes) yield { payload: new Uint8Array(size) }; }
    await deliverBufferedPrintStream(source(), async chunk => { sent.push(chunk.payload.byteLength); await tick(); }, { maxChunks: 4, maxBytes: 10 });
    assert.deepEqual(sent, sizes);
});
