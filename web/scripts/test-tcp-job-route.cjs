/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
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

const port = 19102;
process.env.NEXTWAVES_SERVER_TCP = "enabled";
process.env.NEXTWAVES_SERVER_TCP_HOSTS = "127.0.0.1";
process.env.NEXTWAVES_SERVER_TCP_PORTS = String(port);

const { POST } = require(
    path.join(__dirname, "..", "app", "api", "printer", "tcp", "job", "route.ts"),
);
const { resetTcpJobSessionsForTests } = require(
    path.join(__dirname, "..", "app", "api", "printer", "tcp", "job", "session.ts"),
);

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
    });
}

function close(server) {
    return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
    });
}

function sha256(payload) {
    return crypto.createHash("sha256").update(payload).digest("hex");
}

async function post(body) {
    const response = await POST(new Request("http://localhost/api/printer/tcp/job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    }));
    return {
        status: response.status,
        body: await response.json(),
    };
}

async function main() {
    resetTcpJobSessionsForTests();
    const chunks = [];
    let connectionCount = 0;
    let framedStatus = false;
    const hsResponse = "\x02000,0,0,0251,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,1,2,6,0,00000000,1,001\x03\r\n\x021234,1\x03\r\n";
    const statusCommand = Buffer.from('! U1 getvar "zpl.system_status"\r\n', "latin1");
    const statusResponse = "0,0,00000000,00000000,0,00000000,00000000\r\n";
    const server = net.createServer((socket) => {
        connectionCount += 1;
        socket.on("data", (chunk) => {
            chunks.push(chunk);
            if (chunk.includes(statusCommand)) socket.write(statusResponse, "latin1");
            if (framedStatus && chunk.toString().trim() === "~HS") {
                socket.write(hsResponse.slice(0, 20), "latin1");
                setTimeout(() => socket.write(hsResponse.slice(20), "latin1"), 20);
            }
        });
    });
    await listen(server);

    const jobId = "tcp-job-route-test";
    const opened = await post({
        action: "open",
        jobId,
        host: "127.0.0.1",
        port,
        connectTimeoutMs: 1_000,
        writeTimeoutMs: 1_000,
        idleTimeoutMs: 5_000,
    });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.ok, true);
    assert.equal(opened.body.state, "open");
    assert.equal(opened.body.nextSequence, 1);
    assert.equal(opened.body.cumulativeBytes, 0);
    assert.match(opened.body.checkpointHash, /^[0-9a-f]{64}$/);

    const competingOpen = await post({
        action: "open",
        jobId: "tcp-job-route-competing",
        host: "127.0.0.1",
        port,
        connectTimeoutMs: 1_000,
        writeTimeoutMs: 1_000,
        idleTimeoutMs: 5_000,
    });
    assert.equal(competingOpen.status, 429);
    assert.equal(competingOpen.body.code, "TCP_JOB_TARGET_BUSY");
    assert.equal(competingOpen.body.outcome, "not_sent");

    const payload0 = Buffer.from("^XA^FO0,0^FDJOB-0^FS^XZ", "latin1");
    const append0Request = {
        action: "append",
        jobId,
        sequence: 1,
        payloadBase64: payload0.toString("base64"),
        payloadSha256: sha256(payload0),
    };
    const appended0 = await post(append0Request);
    assert.equal(appended0.status, 200);
    assert.equal(appended0.body.nextSequence, 2);
    assert.equal(appended0.body.bytesWritten, payload0.byteLength);
    assert.equal(appended0.body.deduplicated, undefined);
    const checkpoint0 = appended0.body.checkpointHash;

    const duplicate0 = await post(append0Request);
    assert.equal(duplicate0.status, 200);
    assert.equal(duplicate0.body.deduplicated, true);
    assert.equal(duplicate0.body.checkpointHash, checkpoint0);

    const conflictPayload = Buffer.from("DIFFERENT", "latin1");
    const conflict = await post({
        ...append0Request,
        payloadBase64: conflictPayload.toString("base64"),
        payloadSha256: sha256(conflictPayload),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "JOB_SEQUENCE_CONFLICT");

    const payload1 = Buffer.from("^XA^FO0,0^FDJOB-1^FS^XZ", "latin1");
    const gap = await post({
        action: "append",
        jobId,
        sequence: 3,
        payloadBase64: payload1.toString("base64"),
        payloadSha256: sha256(payload1),
    });
    assert.equal(gap.status, 409);
    assert.equal(gap.body.code, "JOB_SEQUENCE_GAP");

    const badHash = await post({
        action: "append",
        jobId,
        sequence: 2,
        payloadBase64: payload1.toString("base64"),
        payloadSha256: "0".repeat(64),
    });
    assert.equal(badHash.status, 400);
    assert.equal(badHash.body.code, "JOB_PAYLOAD_HASH_MISMATCH");

    const appended1 = await post({
        action: "append",
        jobId,
        sequence: 2,
        payloadBase64: payload1.toString("base64"),
        payloadSha256: sha256(payload1),
    });
    assert.equal(appended1.status, 200);
    assert.equal(appended1.body.nextSequence, 3);
    assert.notEqual(appended1.body.checkpointHash, checkpoint0);

    const queried = await post({
        action: "query",
        jobId,
        payloadBase64: statusCommand.toString("base64"),
        readWindowMs: 1_000,
        readIdleMs: 25,
    });
    assert.equal(queried.status, 200);
    assert.equal(queried.body.response, statusResponse);
    assert.equal(queried.body.nextSequence, 3);

    const polled = await post({ action: "poll", jobId });
    assert.equal(polled.status, 200);
    assert.equal(polled.body.state, "open");
    assert.equal(polled.body.nextSequence, 3);
    assert.equal(
        polled.body.cumulativeBytes,
        payload0.byteLength + payload1.byteLength,
    );

    const mismatchedFinish = await post({
        action: "finish",
        jobId,
        expectedSequence: 1,
        expectedBytes: polled.body.cumulativeBytes,
        checkpointHash: polled.body.checkpointHash,
    });
    assert.equal(mismatchedFinish.status, 409);
    assert.equal(mismatchedFinish.body.code, "JOB_FINISH_SEQUENCE_MISMATCH");

    const finishRequest = {
        action: "finish",
        jobId,
        expectedSequence: 2,
        expectedBytes: polled.body.cumulativeBytes,
        checkpointHash: polled.body.checkpointHash,
    };
    const finished = await post(finishRequest);
    assert.equal(finished.status, 200);
    assert.equal(finished.body.state, "finished");
    const duplicateFinish = await post(finishRequest);
    assert.equal(duplicateFinish.status, 200);
    assert.equal(duplicateFinish.body.deduplicated, true);

    const reopenedFinished = await post({
        action: "open",
        jobId,
        host: "127.0.0.1",
        port,
    });
    assert.equal(reopenedFinished.status, 409);
    assert.equal(reopenedFinished.body.code, "TCP_JOB_TERMINAL");
    assert.equal(reopenedFinished.body.outcome, "possibly_sent");

    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(connectionCount, 1, "one TCP socket must serve every append");
    assert.deepEqual(
        Buffer.concat(chunks),
        Buffer.concat([payload0, payload1, statusCommand]),
        "deduplicated/conflicting/gapped appends must not reach the printer",
    );

    const invalidHost = await post({
        action: "open",
        jobId: "invalid-host",
        host: "http://127.0.0.1",
        port,
    });
    assert.equal(invalidHost.status, 400);
    assert.equal(invalidHost.body.code, "TCP_HOST_INVALID");

    resetTcpJobSessionsForTests();
    const uncertainJobId = "tcp-job-route-uncertain";
    const uncertainOpen = await post({
        action: "open",
        jobId: uncertainJobId,
        host: "127.0.0.1",
        port,
        connectTimeoutMs: 1_000,
        writeTimeoutMs: 1_000,
        idleTimeoutMs: 5_000,
    });
    assert.equal(uncertainOpen.status, 200);
    const uncertainPayload = Buffer.from("^XA^FDUNCERTAIN^FS^XZ", "latin1");
    const uncertainAppend = await post({
        action: "append",
        jobId: uncertainJobId,
        sequence: 1,
        payloadBase64: uncertainPayload.toString("base64"),
        payloadSha256: sha256(uncertainPayload),
    });
    assert.equal(uncertainAppend.status, 200);
    const missingStatus = await post({
        action: "query",
        jobId: uncertainJobId,
        payloadBase64: Buffer.from("~HS\r\n", "latin1").toString("base64"),
        readWindowMs: 250,
        readIdleMs: 25,
    });
    assert.equal(missingStatus.status, 504);
    assert.equal(missingStatus.body.state, "uncertain");
    assert.equal(missingStatus.body.outcome, "possibly_sent");
    const quarantinedOpen = await post({
        action: "open",
        jobId: "tcp-job-route-after-uncertain",
        host: "127.0.0.1",
        port,
    });
    assert.equal(quarantinedOpen.status, 409);
    assert.equal(quarantinedOpen.body.code, "TCP_JOB_TARGET_QUARANTINED");
    assert.equal(quarantinedOpen.body.outcome, "possibly_sent");

    const reconciliation = {
        action: "reconcile", jobId: uncertainJobId, confirmed: true,
        reconciliationNote: "Verified physical labels and EPCs; printer buffer empty.",
        expectedSequence: uncertainAppend.body.nextSequence - 1,
        expectedBytes: uncertainAppend.body.cumulativeBytes,
        checkpointHash: uncertainAppend.body.checkpointHash,
    };
    assert.equal((await post({ ...reconciliation, confirmed: false })).status, 400);
    assert.equal((await post({ ...reconciliation, expectedSequence: 99 })).status, 409);
    assert.equal((await post(reconciliation)).body.reconciled, true);
    assert.equal((await post(reconciliation)).body.reconciled, true, "reconcile is idempotent");
    const audited = await post({ action: "poll", jobId: uncertainJobId });
    assert.equal(audited.body.state, "uncertain", "original outcome is preserved");
    assert.equal(audited.body.reconciled, true);
    const afterAudit = await post({ action: "open", jobId: "tcp-job-after-audit", host: "127.0.0.1", port });
    assert.equal(afterAudit.status, 200, "explicit audit releases quarantine");
    assert.equal((await post({ ...reconciliation, jobId: "tcp-job-after-audit" })).status, 409, "cannot reconcile an active job");

    framedStatus = true;
    const started = performance.now();
    let connectionsAfterFirstQuery;
    for (let i = 0; i < 2; i++) {
        const fast = await post({ action: "query", jobId: "tcp-job-after-audit",
            payloadBase64: Buffer.from("~HS\r\n").toString("base64"), readWindowMs: 5000, readIdleMs: 2000 });
        assert.equal(fast.status, 200); assert.equal(fast.body.response, hsResponse);
        assert.equal(fast.body.nextSequence, 1); assert.equal(fast.body.cumulativeBytes, 0);
        if (i === 0) connectionsAfterFirstQuery = connectionCount;
    }
    assert.ok(performance.now() - started < 1000, "complete framed queries must not wait for read-idle timeout");
    assert.equal(connectionCount, connectionsAfterFirstQuery, "fast status retains the same socket");

    resetTcpJobSessionsForTests();
    await close(server);
    console.log(
        "Persistent TCP job route tests passed: one socket, hash/sequence "
        + "idempotency, same-socket status, target quarantine, gap/conflict rejection, checkpointed finish, and strict target validation.",
    );
}

main().catch((error) => {
    resetTcpJobSessionsForTests();
    console.error(error);
    process.exitCode = 1;
});
