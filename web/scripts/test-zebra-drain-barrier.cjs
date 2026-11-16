/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const ts = require("typescript");
const { test } = require("node:test");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(
    fs.readFileSync(filename, "utf8"),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename },
).outputText, filename);
const { waitForZebraDrainBarrier } = require("../app/zebra-drain-barrier.ts");
const { parseZebraHqesStatus } = require("../app/zebra-printer-status.ts");

const hq = (errors = "00000000", warnings = "00000000") =>
    `\x02\r\nPRINTER STATUS\r\nERRORS: ${errors === "00000000" ? 0 : 1} 00000000 ${errors}\r\nWARNINGS: ${warnings === "00000000" ? 0 : 1} 00000000 ${warnings}\r\n\x03\r\n`;
const hs = ({ paused = false, busy = false, headUp = false } = {}) =>
    `\x02000,0,${Number(paused)},0251,${busy ? "003" : "000"},0,0,0,000,0,0,0\x03\r\n`
    + `\x02000,0,${Number(headUp)},0,1,2,6,0,${busy ? "00000003" : "00000000"},1,001\x03\r\n`
    + "\x021234,1\x03\r\n";

function scenario(polls, { interval = 1000, timeout = 3000 } = {}) {
    let tick = 0, clock = 0;
    const states = [], commands = [];
    return {
        states, commands,
        run: () => waitForZebraDrainBarrier(async (command) => {
            commands.push(command.trim());
            const current = polls[Math.min(tick, polls.length - 1)];
            if (current.error) throw new Error(current.error);
            return command.trim() === "~HQES" ? hq(current.fault, current.warning) : hs(current);
        }, {
            now: () => clock,
            sleep: async () => { clock += interval; tick++; if (tick > 30) throw new Error("test runaway"); },
            timeoutMs: timeout,
            onStateChange: (state) => states.push(state),
        }),
    };
}

test("HQES pause is a state; concurrent and unknown faults stay faults", () => {
    const pause = parseZebraHqesStatus(hq("00010000"));
    assert.equal(pause.level, "paused");
    assert.equal(pause.paused, true);
    assert.deepEqual(pause.errors, []);
    for (const fault of ["00010004", "80010000"]) {
        const status = parseZebraHqesStatus(hq(fault));
        assert.equal(status.level, "error");
        assert.equal(status.paused, true);
    }
});

test("pause longer than active timeout keeps polling, resumes and drains", async () => {
    const trial = scenario([
        { busy: true }, { fault: "00010000" }, { fault: "00010000" },
        { fault: "00010000" }, { fault: "00010000" }, { busy: true }, {},
    ]);
    await trial.run();
    assert.deepEqual(trial.states, ["draining", "paused", "draining"]);
    assert.equal(trial.commands.filter(c => c === "~HQES").length, 7);
});

test("standalone HS pause with an empty buffer cannot release a chunk", async () => {
    const trial = scenario([{ paused: true }, { paused: true }, {}]);
    await trial.run();
    assert.deepEqual(trial.states, ["paused", "draining"]);
    assert.equal(trial.commands.length, 6);
});

test("repeated pauses preserve accumulated active drain time", async () => {
    const trial = scenario([
        { busy: true }, { busy: true }, { fault: "00010000" },
        { busy: true }, { busy: true }, { fault: "00010000" },
        { busy: true }, { busy: true },
    ]);
    await assert.rejects(trial.run(), /timed out.*operator pauses excluded/);
});

test("faults during pause and HS faults abort instead of silently resuming", async () => {
    await assert.rejects(scenario([{ fault: "00010000" }, { fault: "00010004" }]).run(), /Printhead open/);
    await assert.rejects(scenario([{ paused: true, headUp: true }]).run(), /Printhead open/);
});

test("connection loss during pause remains a failure with last diagnosis", async () => {
    await assert.rejects(scenario([{ fault: "00010000" }, { error: "socket closed" }]).run(), /Printer is paused.*socket closed/);
});

test("resuming a final chunk waits for its buffered labels; warnings survive", async () => {
    const trial = scenario([{ fault: "00010000", warning: "00000002" }, { busy: true }, {}]);
    assert.match(await trial.run(), /Clean printhead/);
    assert.equal(trial.commands.filter(c => c === "~HQES").length, 3);
});
