/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

if (process.platform !== "win32") {
    console.log("Connector TCP job smoke skipped: packaged test executable is Windows.");
    process.exit(0);
}

const connectorPort = 17919;
const printerPort = 19103;
const executable = path.join(
    __dirname,
    "..",
    "public",
    "agent",
    "ZbrePrinterLocalPrintAgent-windows-x64.exe",
);
const runId = crypto.randomUUID();
const stateFile = path.join(os.tmpdir(), `zbre-tcp-job-smoke-${runId}.json`);

function privateIpv4() {
    for (const addresses of Object.values(os.networkInterfaces())) {
        for (const address of addresses ?? []) {
            if (address.family !== "IPv4" || address.internal) continue;
            if (
                address.address.startsWith("10.")
                || address.address.startsWith("192.168.")
                || /^172\.(1[6-9]|2\d|3[01])\./.test(address.address)
            ) {
                return address.address;
            }
        }
    }
    throw new Error("No private IPv4 interface is available for connector smoke test.");
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(printerPort, "0.0.0.0", resolve);
    });
}

function close(server) {
    return new Promise((resolve) => server.close(resolve));
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForHealth(baseUrl, child, stderr) {
    for (let attempt = 0; attempt < 60; attempt += 1) {
        if (child.exitCode !== null) {
            throw new Error(`Connector exited early (${child.exitCode}): ${stderr.join("")}`);
        }
        try {
            const response = await fetch(`${baseUrl}/v1/health`);
            if (response.ok) return response.json();
        } catch {
            // Connector is still starting.
        }
        await delay(100);
    }
    throw new Error(`Connector did not become ready: ${stderr.join("")}`);
}

async function post(baseUrl, body) {
    const response = await fetch(`${baseUrl}/v1/tcp/job`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
        throw new Error(
            `TCP job ${body.action} failed (${response.status}): ${JSON.stringify(result)}`,
        );
    }
    return result;
}

async function main() {
    const printerHost = privateIpv4();
    const received = [];
    let connectionCount = 0;
    const printer = net.createServer((socket) => {
        connectionCount += 1;
        socket.on("data", (chunk) => received.push(chunk));
    });
    await listen(printer);

    const stderr = [];
    const connector = spawn(executable, [
        "--port",
        String(connectorPort),
        "--tcp-ports",
        String(printerPort),
        "--state-file",
        stateFile,
    ], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
    });
    connector.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
    const baseUrl = `http://127.0.0.1:${connectorPort}`;

    try {
        const health = await waitForHealth(baseUrl, connector, stderr);
        assert.equal(health.version, "0.4.0");
        assert.equal(health.capabilities.tcpJobV1, true);
        assert.equal(health.capabilities.tcpJobIdempotencyV1, true);
        assert.equal(health.capabilities.printerTargetQueueV1, true);
        assert.equal(health.capabilities.rawBatchLeaseV1, true);

        const jobId = `smoke-${runId}`;
        const opened = await post(baseUrl, {
            action: "open",
            jobId,
            host: printerHost,
            port: printerPort,
            connectTimeoutMs: 2_000,
            writeTimeoutMs: 2_000,
            idleTimeoutMs: 30_000,
        });
        assert.equal(opened.nextSequence, 1);

        const first = Buffer.from("^XA^FDFIRST^FS^XZ", "latin1");
        const firstRequest = {
            action: "append",
            jobId,
            sequence: 1,
            payloadBase64: first.toString("base64"),
            payloadSha256: crypto.createHash("sha256").update(first).digest("hex"),
        };
        const firstReceipt = await post(baseUrl, firstRequest);
        const duplicate = await post(baseUrl, firstRequest);
        assert.equal(duplicate.deduplicated, true);

        const second = Buffer.from("^XA^FDSECOND^FS^XZ", "latin1");
        const secondReceipt = await post(baseUrl, {
            action: "append",
            jobId,
            sequence: 2,
            payloadBase64: second.toString("base64"),
            payloadSha256: crypto.createHash("sha256").update(second).digest("hex"),
        });
        const finished = await post(baseUrl, {
            action: "finish",
            jobId,
            expectedSequence: 2,
            expectedBytes: first.length + second.length,
            checkpointHash: secondReceipt.checkpointHash,
        });
        assert.equal(finished.state, "finished");
        assert.equal(firstReceipt.nextSequence, 2);
        assert.equal(secondReceipt.nextSequence, 3);
        await delay(100);
        assert.equal(connectionCount, 1);
        assert.deepEqual(Buffer.concat(received), Buffer.concat([first, second]));
        console.log(
            "Packaged connector TCP job smoke passed: v0.4.0 uses one printer socket and deduplicates replayed checkpoints.",
        );
    } finally {
        connector.kill();
        await close(printer);
        if (
            stateFile.startsWith(os.tmpdir() + path.sep)
            && fs.existsSync(stateFile)
        ) {
            fs.rmSync(stateFile, { force: true });
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
