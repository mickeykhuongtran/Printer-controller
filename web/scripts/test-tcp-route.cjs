/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
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

const port = 19100;
process.env.NEXTWAVES_SERVER_TCP_PORTS = String(port);

const { POST } = require(
    path.join(__dirname, "..", "app", "api", "printer", "tcp", "route.ts"),
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

function request(payload, connectTimeoutMs = 1_000) {
    return new Request("http://localhost/api/printer/tcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            host: "127.0.0.1",
            port,
            payloadBase64: Buffer.from(payload).toString("base64"),
            readWindowMs: 0,
            connectTimeoutMs,
            writeTimeoutMs: 1_000,
        }),
    });
}

async function main() {
    const received = [];
    const server = net.createServer((socket) => {
        socket.on("data", (chunk) => received.push(chunk));
    });
    await listen(server);

    const payload = Buffer.from("^XA^FO0,0^FDROUTE-TEST^FS^XZ", "latin1");
    const successResponse = await POST(request(payload));
    const success = await successResponse.json();
    assert.equal(successResponse.status, 200);
    assert.equal(success.ok, true);
    assert.equal(success.bytesWritten, payload.byteLength);
    await close(server);
    assert.deepEqual(Buffer.concat(received), payload);

    const failedResponse = await POST(request(payload, 500));
    const failure = await failedResponse.json();
    assert.equal(failure.ok, false);
    assert.equal(failure.stage, "connect");
    assert.equal(failure.outcome, "not_sent");
    assert.equal(failure.retrySafety, "safe");
    assert.equal(failure.bytesWritten, 0);
    assert.equal(failure.writeStarted, false);
    assert.equal(failure.writeCompleted, false);

    console.log(
        "TCP route tests passed: full write receipt and pre-write connect failure are classified correctly.",
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
