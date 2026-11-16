/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
        fileName: filename,
    }).outputText;
    module._compile(output, filename);
};

global.crypto ??= webcrypto;
global.btoa ??= (value) => Buffer.from(value, "latin1").toString("base64");
global.window = {
    location: { hostname: "localhost" },
    setTimeout(callback) {
        queueMicrotask(callback);
        return 1;
    },
    clearTimeout() {},
};

const { TcpPrintJob, TcpPrintJobError } = require(
    path.join(__dirname, "..", "app", "tcp-print-job.ts"),
);

function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function openReceipt(body) {
    return {
        ok: true,
        jobId: body.jobId,
        state: "open",
        nextSequence: 1,
        cumulativeBytes: 0,
        checkpointHash: "seed-checkpoint",
    };
}

async function testReplayKeepsIdentityAndSequence() {
    const calls = [];
    let appendAttempts = 0;
    global.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body);
        if (body.action === "open") return jsonResponse(200, openReceipt(body));
        if (body.action === "append") {
            appendAttempts += 1;
            if (appendAttempts === 1) throw new TypeError("simulated lost request");
            return jsonResponse(200, {
                ok: true,
                jobId: body.jobId,
                state: "open",
                nextSequence: 2,
                cumulativeBytes: 6,
                bytesWritten: 6,
                payloadSha256: body.payloadSha256,
                checkpointHash: "checkpoint-1",
                deduplicated: true,
            });
        }
        if (body.action === "query") {
            return jsonResponse(200, {
                ok: true,
                jobId: body.jobId,
                state: "open",
                nextSequence: 2,
                cumulativeBytes: 6,
                checkpointHash: "checkpoint-1",
                bytesWritten: Buffer.from(body.payloadBase64, "base64").byteLength,
                response: "0,0,00000000,00000000,0,00000000,00000000\r\n",
            });
        }
        if (body.action === "finish") {
            return jsonResponse(200, {
                ok: true,
                jobId: body.jobId,
                state: "finished",
                nextSequence: 2,
                cumulativeBytes: 6,
                checkpointHash: "checkpoint-1",
            });
        }
        throw new Error(`Unexpected action ${body.action}`);
    };

    const job = await TcpPrintJob.open({
        host: "192.168.50.50",
        port: 9100,
        executionMode: "server",
        jobId: "11111111-1111-4111-8111-111111111111",
    });
    const payload = Uint8Array.of(0x5e, 0x58, 0x41, 0x5e, 0x58, 0x5a);
    const receipt = await job.append(payload);
    const status = await job.query('! U1 getvar "zpl.system_status"\r\n');
    const finished = await job.finish();

    assert.equal(receipt.bytesWritten, payload.byteLength);
    assert.equal(receipt.deduplicated, true);
    assert.equal(finished.chunksAccepted, 1);
    assert.match(status, /^0,0,/);
    const appendCalls = calls.filter((call) => call.action === "append");
    assert.equal(appendCalls.length, 2, "an interrupted append should replay once");
    assert.equal(appendCalls[0].jobId, appendCalls[1].jobId);
    assert.equal(appendCalls[0].sequence, 1);
    assert.equal(appendCalls[1].sequence, 1);
    assert.equal(appendCalls[0].payloadSha256, appendCalls[1].payloadSha256);
}

async function testPollRecoversLostAppendReceipt() {
    let appendAttempts = 0;
    let pollCalls = 0;
    global.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.action === "open") return jsonResponse(200, openReceipt(body));
        if (body.action === "append") {
            appendAttempts += 1;
            throw new TypeError("all append responses were lost");
        }
        if (body.action === "poll") {
            pollCalls += 1;
            return jsonResponse(200, {
                ok: true,
                jobId: body.jobId,
                state: "open",
                nextSequence: 2,
                cumulativeBytes: 3,
                checkpointHash: "checkpoint-recovered",
            });
        }
        if (body.action === "abort") {
            return jsonResponse(200, {
                ok: true,
                jobId: body.jobId,
                state: "aborted",
                nextSequence: 2,
                cumulativeBytes: 3,
                checkpointHash: "checkpoint-recovered",
            });
        }
        throw new Error(`Unexpected action ${body.action}`);
    };

    const job = await TcpPrintJob.open({
        host: "192.168.50.50",
        port: 9100,
        executionMode: "server",
        jobId: "22222222-2222-4222-8222-222222222222",
    });
    const receipt = await job.append(Uint8Array.of(1, 2, 3));
    assert.equal(appendAttempts, 4, "the same checkpoint gets bounded retries");
    assert.equal(pollCalls, 1, "poll should reconcile a lost append receipt");
    assert.equal(receipt.deduplicated, true);
    assert.equal(receipt.nextSequence, 2);
    await job.abort();
}

async function testCheckpointConflictStopsWithoutReplay() {
    let appendCalls = 0;
    global.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.action === "open") return jsonResponse(200, openReceipt(body));
        if (body.action === "append") {
            appendCalls += 1;
            return jsonResponse(409, {
                ok: false,
                error: "sequence/hash conflict",
                code: "TCP_JOB_CHECKPOINT_CONFLICT",
                jobState: "open",
                outcome: "not_sent",
            });
        }
        throw new Error(`Unexpected action ${body.action}`);
    };

    const job = await TcpPrintJob.open({
        host: "192.168.50.50",
        port: 9100,
        executionMode: "server",
        jobId: "33333333-3333-4333-8333-333333333333",
    });
    await assert.rejects(
        job.append(Uint8Array.of(9)),
        (error) => {
            assert.ok(error instanceof TcpPrintJobError);
            assert.equal(error.code, "TCP_JOB_CHECKPOINT_CONFLICT");
            assert.equal(error.outcome, "not_sent");
            return true;
        },
    );
    assert.equal(appendCalls, 1, "a 409 checkpoint conflict must never replay");
}

async function testReconciliationDoesNotPrint() {
    const calls = [];
    const options = { jobId: "stopped-job-test", host: "192.168.50.50", port: 9100,
        executionMode: "server", confirmed: true, note: "Verified rows 2500-2471; buffer empty, EPCs correct." };
    global.fetch = async (_url, init) => {
        const body = JSON.parse(init.body); calls.push(body);
        assert.ok(["poll", "reconcile"].includes(body.action), "audit cannot send a print operation");
        return jsonResponse(200, { ok: true, jobId: options.jobId, host: options.host, port: 9100,
            nextSequence: 4, cumulativeBytes: 123, checkpointHash: "audit-checkpoint", reconciled: body.action === "reconcile" });
    };
    await assert.rejects(TcpPrintJob.reconcile({ ...options, confirmed: false }), /Confirm/);
    assert.equal(calls.length, 0);
    await TcpPrintJob.reconcile(options);
    assert.deepEqual(calls.map(c => c.action), ["poll", "reconcile"]);
    assert.equal(calls[1].expectedSequence, 3);
    assert.equal(calls[1].expectedBytes, 123);
    assert.equal(calls[1].checkpointHash, "audit-checkpoint");
    await assert.rejects(TcpPrintJob.reconcile({ ...options, host: "192.168.50.51" }), /does not match/);
    assert.equal(calls.filter(c => c.action === "reconcile").length, 1);
}

async function testConcurrentAppendsAreSerialized() {
    const calls=[];let cumulative=0, active=0, maxActive=0;
    global.fetch=async (_url, init)=>{
        const body=JSON.parse(init.body);
        if(body.action==='open') return jsonResponse(200,openReceipt(body));
        assert.equal(body.action,'append'); active++;maxActive=Math.max(maxActive,active);
        const payload=Buffer.from(body.payloadBase64,'base64');
        await new Promise(resolve=>setTimeout(resolve,5));
        calls.push({sequence:body.sequence,text:payload.toString()});cumulative+=payload.length;active--;
        return jsonResponse(200,{ok:true,jobId:body.jobId,state:'open',nextSequence:body.sequence+1,cumulativeBytes:cumulative,
            bytesWritten:payload.length,payloadSha256:body.payloadSha256,checkpointHash:'chain-'+body.sequence});
    };
    const job=await TcpPrintJob.open({host:'printer',port:9100,executionMode:'server'});
    const second=new TextEncoder().encode('TWO');
    const pending=[job.append(new TextEncoder().encode('ONE')),job.append(second),job.append(new TextEncoder().encode('THREE'))];
    second.fill(88);
    await Promise.all(pending);
    assert.equal(maxActive,1);assert.deepEqual(calls,[{sequence:1,text:'ONE'},{sequence:2,text:'TWO'},{sequence:3,text:'THREE'}]);
}

async function main() {
    await testStoredCounterProofRecoversOnlyCompletedCheckpoint();
    await testConnectorOwnsRfidCounterLifecycle();
    await testRollAdmissionOutcomeIsPreserved();
    await testBackgroundFaultMetadataSurvivesTerminalErrors();
    await testServiceFaultLatchBlocksLaterChunks();
    await testConcurrentAppendsAreSerialized();
    await testReplayKeepsIdentityAndSequence();
    await testPollRecoversLostAppendReceipt();
    await testCheckpointConflictStopsWithoutReplay();
    await testReconciliationDoesNotPrint();
    console.log(
        "TCP job client tests passed: replay identity, same-socket query, poll recovery, and conflict-stop semantics are correct.",
    );
}

async function testStoredCounterProofRecoversOnlyCompletedCheckpoint() {
    const variants = [
        ["verified", null, true],
        ["missing-epc", snapshot => { snapshot.capture.uniqueLabels = 1; }, true],
        ["lost-http-response", snapshot => { snapshot.state = "open"; snapshot.counterFinishRecoverable = false; }, true],
        ["no-native-recovery", snapshot => { snapshot.counterFinishRecoverable = false; }, false],
        ["wrong-hash", snapshot => { snapshot.checkpointHash = "another-checkpoint"; }, false],
        ["wrong-bytes", snapshot => { snapshot.cumulativeBytes += 1; }, false],
        ["wrong-sequence", snapshot => { snapshot.nextSequence += 1; }, false],
        ["partial-submission", snapshot => { snapshot.capture.audit.submittedAttempts = 1; }, false],
        ["missing-proof", snapshot => { delete snapshot.capture.audit.finalCounterProof; }, false],
        ["counter-reset", snapshot => { snapshot.capture.audit.finalizationStatus = "unresolved"; }, false],
        ["service-fault", snapshot => { snapshot.serviceFault = "Printhead open"; }, false],
        ["clear-requested", snapshot => { snapshot.faultClearRequested = true; }, false],
        ["evidence-failed", snapshot => { snapshot.capture.error = "disk full"; }, false],
    ];
    for (const [name, change, succeeds] of variants) {
        const calls = [], captureOptions = { auditBatchCounters: true, expectedLabels: 2, firstRow: 1, rowStep: 1, bank: "EPC", templateName: "Proof recovery" };
        let snapshot;
        global.fetch = async (_url, init) => {
            const body = JSON.parse(init.body); calls.push(body.action);
            const capture = { jobId: body.jobId, options: captureOptions, state: "capturing", received: 2, uniqueLabels: 2, issues: 0, audit: { lifecycleVersion: 1, finalizationStatus: "collecting" } };
            if (body.action === "open") return jsonResponse(200, { ...openReceipt(body), capture });
            if (body.action === "append") return jsonResponse(200, { ...openReceipt(body), capture, nextSequence: 2, cumulativeBytes: 6,
                bytesWritten: 6, payloadSha256: body.payloadSha256, checkpointHash: "final-checkpoint" });
            if (body.action === "query") return jsonResponse(502, { jobId: body.jobId, code: "TCP_JOB_QUERY_READ_FAILED", error: "socket closed after proof", outcome: "possibly_sent" });
            if (body.action === "poll") {
                snapshot = { ok: true, jobId: body.jobId, state: "uncertain", nextSequence: 2, cumulativeBytes: 6, checkpointHash: "final-checkpoint", counterFinishRecoverable: true,
                    capture: { ...capture, audit: { lifecycleVersion: 1, finalizationStatus: "verified", countsKnown: true, validDelta: 2, voidDelta: 0,
                        submittedAttemptsKnown: true, submittedAttempts: 2, finalCounterProof: { method: "same_socket_drained_stable_v1", sequence: 1 } } } };
                change?.(snapshot);
                return jsonResponse(200, snapshot);
            }
            if (body.action === "finish") {
                assert.equal(succeeds, true, name + " must not request finish without valid proof/checkpoint");
                assert.equal(body.expectedSequence, 1); assert.equal(body.expectedBytes, 6); assert.equal(body.checkpointHash, "final-checkpoint");
                return jsonResponse(200, { ...snapshot, state: "finished", capture: { ...snapshot.capture, state: snapshot.capture.uniqueLabels === 2 ? "complete" : "incomplete" } });
            }
            throw new Error("Unexpected recovery action: " + body.action);
        };
        const job = await TcpPrintJob.open({ host: "simulated", port: 9100, executionMode: "connector", capture: captureOptions });
        await job.append(new TextEncoder().encode("LABELS"));
        await assert.rejects(job.query("~HQES\r\n"), /socket closed/);
        assert.ok(job.serviceFault, "Original unavailable-status latch is retained until native proof finish succeeds");
        const receipt = await job.finishFromCounterProof();
        assert.equal(!!receipt, succeeds, name);
        assert.deepEqual(calls, ["open", "append", "query", "poll", ...(succeeds ? ["finish"] : [])], "Recovery must not resend, query again, abort, or reopen");
        if (succeeds) {
            assert.equal(job.serviceFault, ""); assert.equal(receipt.state, "finished");
            await job.abort();
            assert.equal(calls.at(-1), "finish", "Finished recovery must not emit abort");
        }
    }
}

async function testConnectorOwnsRfidCounterLifecycle() {
    const capture = { auditBatchCounters: true, expectedLabels: 2, firstRow: 1, rowStep: 1, bank: "EPC", templateName: "Counter SOP" };
    for (const upgraded of [false, true]) {
        const calls = [];
        global.fetch = async (_url, init) => {
            const body = JSON.parse(init.body); calls.push(body.action);
            if (body.action === "open") return jsonResponse(200, { ...openReceipt(body), capture: {
                jobId: body.jobId, options: capture, state: "capturing", received: 0, uniqueLabels: 0, issues: 0,
                audit: { lifecycleVersion: upgraded ? 1 : undefined, finalizationStatus: "collecting" },
            } });
            if (body.action === "abort") return jsonResponse(200, { ok: true, jobId: body.jobId, state: "aborted" });
            throw new Error("Browser must not sample the connector-owned counters: " + body.action);
        };
        const opening = TcpPrintJob.open({ host: "simulated", port: 9100, executionMode: "connector", capture });
        if (!upgraded) {
            await assert.rejects(opening, /Cập nhật connector/);
            assert.deepEqual(calls, ["open", "abort"], "Old connector is rejected before any label payload");
        } else {
            const job = await opening;
            await job.sampleRfidCounters();
            assert.deepEqual(calls, ["open"], "Frontend cannot overwrite native complete counter rounds");
        }
    }
}

async function testRollAdmissionOutcomeIsPreserved() {
    for (const executionMode of ["connector", "server"]) {
        const calls = [];
        global.fetch = async (_url, init) => {
            const body = JSON.parse(init.body);
            calls.push(body.action);
            assert.equal(body.action, "open", "rejected admission must not poll, append, or send printer controls");
            return jsonResponse(409, { ok: false, code: "PRODUCTION_ROLL_CONFLICT",
                error: "Chưa gửi lệnh in: hãy tiếp tục cuộn cũ hoặc đóng cuộn để bắt đầu lô mới.",
                stage: "admission", outcome: "not_sent", bytesWritten: 0 });
        };
        await assert.rejects(TcpPrintJob.open({ host: "simulated", port: 9100, executionMode }), error =>
            error instanceof TcpPrintJobError && error.outcome === "not_sent"
            && error.code === "PRODUCTION_ROLL_CONFLICT" && error.status === 409);
        assert.deepEqual(calls, ["open"]);
    }
    // A roll-related conflict during an append does not establish that earlier
    // payloads were never printed. Missing outcome evidence must remain unknown.
    const calls = [];
    global.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        calls.push(body.action);
        if (body.action === "open") return jsonResponse(200, openReceipt(body));
        if (body.action === "poll") return jsonResponse(409, { ok: false, code: "TCP_JOB_UNCERTAIN", error: "Outcome unavailable" });
        return jsonResponse(409, { ok: false, code: "PRODUCTION_ROLL_CONFLICT", error: "Registration conflict" });
    };
    const job = await TcpPrintJob.open({ host: "simulated", port: 9100, executionMode: "connector" });
    await assert.rejects(job.append(new TextEncoder().encode("LABEL")), error =>
        error instanceof TcpPrintJobError && error.outcome === "possibly_sent");
    assert.equal(calls.filter(action => action === "append").length, 1);
}

async function testBackgroundFaultMetadataSurvivesTerminalErrors() {
    for (const action of ["append", "query", "finish"]) {
        const calls = [];
        global.fetch = async (_url, init) => {
            const body = JSON.parse(init.body); calls.push(body.action);
            if (body.action === "open") return jsonResponse(200, openReceipt(body));
            if (body.action === "poll") return jsonResponse(200, { ...openReceipt(body), state: "uncertain", serviceFault: "Ribbon out", faultClearRequested: true });
            assert.equal(body.action, action);
            return jsonResponse(409, { ok: false, jobId: body.jobId, jobState: "uncertain", error: "Native background monitor stopped this run.",
                code: "TCP_JOB_SERVICE_FAULT", outcome: "possibly_sent", serviceFault: "Ribbon out", faultClearRequested: true });
        };
        const job = await TcpPrintJob.open({ host: "simulated", port: 9100, executionMode: "server" });
        const pending = action === "append" ? job.append(new TextEncoder().encode("LABEL"))
            : action === "query" ? job.query("~HQES\r\n") : job.finish();
        await assert.rejects(pending, error => error instanceof TcpPrintJobError && error.serviceFault === "Ribbon out" && error.faultClearRequested);
        assert.equal(job.serviceFault, "Ribbon out");
        assert.equal(job.faultClearRequested, true);
        assert.equal(calls.filter(item => item === action).length, 1, "a native terminal fault must not replay label data");
        await assert.rejects(job.append(new TextEncoder().encode("MUST NOT PRINT")), /service fault/);
        assert.equal(calls.filter(item => item === "append").length, action === "append" ? 1 : 0);
    }
}

async function testServiceFaultLatchBlocksLaterChunks() {
    const calls = [];
    global.fetch = async (_url, init) => {
        const body = JSON.parse(init.body); calls.push(body.action);
        if (body.action === "open") return jsonResponse(200, openReceipt(body));
        if (body.action === "query") return jsonResponse(200, { ...openReceipt(body), response: '"100"\r\n', serviceFault: "Printhead open", faultClearRequested: true });
        if (body.action === "abort") return jsonResponse(200, { ...openReceipt(body), state: "uncertain" });
        throw new Error("Unexpected printer command: " + body.action);
    };
    const job = await TcpPrintJob.open({ host: "simulated", port: 9100, executionMode: "server" });
    await assert.rejects(job.query("~HQES\r\n"), error => error.code === "TCP_JOB_SERVICE_FAULT");
    assert.equal(job.serviceFault, "Printhead open");
    assert.equal(job.faultClearRequested, true);
    await assert.rejects(job.append(new TextEncoder().encode("MUST NOT PRINT")), /service fault/);
    assert.equal(await job.query('! U1 getvar "odometer.rfid.void_resettable"\r\n'), '"100"\r\n', "interrupted counter audit remains available");
    await job.abort();
    assert.deepEqual(calls, ["open", "query", "query", "abort"]);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
