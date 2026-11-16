/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
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

global.window = {
    location: { hostname: "localhost" },
    setTimeout,
    clearTimeout,
};
global.btoa ??= (value) => Buffer.from(value, "latin1").toString("base64");

const {
    TcpTransportError,
    isSafeTcpRetry,
    sendTcpBytesWithSafeRetry,
} = require(path.join(__dirname, "..", "app", "tcp-print.ts"));

function jsonResponse(status, payload) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

const baseOptions = {
    host: "192.168.50.50",
    port: 9100,
    payload: Uint8Array.of(0x5e, 0x58, 0x41, 0x5e, 0x58, 0x5a),
    executionMode: "server",
};

async function testSafeConnectRetry() {
    let calls = 0;
    const retryEvents = [];
    global.fetch = async () => {
        calls += 1;
        if (calls === 1) {
            return jsonResponse(504, {
                ok: false,
                error: "TCP connect timeout",
                code: "TCP_CONNECT_TIMEOUT",
                stage: "connect",
                outcome: "not_sent",
                retrySafety: "safe",
                bytesWritten: 0,
                writeStarted: false,
                writeCompleted: false,
            });
        }
        return jsonResponse(200, {
            ok: true,
            bytesWritten: baseOptions.payload.byteLength,
            response: "",
        });
    };

    const result = await sendTcpBytesWithSafeRetry(baseOptions, {
        retryDelaysMs: [1],
        sleep: async () => {},
        onRetry: (...event) => retryEvents.push(event),
    });
    assert.equal(calls, 2, "a proven pre-write connect failure must retry once");
    assert.equal(result.bytesWritten, baseOptions.payload.byteLength);
    assert.equal(retryEvents.length, 1);
    assert.equal(retryEvents[0][0], 2, "callback reports the next attempt");
    assert.equal(retryEvents[0][1], 2, "max attempts includes the initial attempt");
    assert.ok(isSafeTcpRetry(retryEvents[0][3]));
}

async function testAmbiguousWriteNeverRetries() {
    let calls = 0;
    global.fetch = async () => {
        calls += 1;
        return jsonResponse(504, {
            ok: false,
            error: "TCP write timed out",
            code: "TCP_WRITE_TIMEOUT",
            stage: "write",
            outcome: "possibly_sent",
            retrySafety: "unsafe",
            bytesWritten: 32768,
            writeStarted: true,
            writeCompleted: false,
        });
    };

    await assert.rejects(
        sendTcpBytesWithSafeRetry(baseOptions, {
            retryDelaysMs: [0, 0, 0],
            sleep: async () => {},
        }),
        (error) => {
            assert.ok(error instanceof TcpTransportError);
            assert.equal(error.outcome, "possibly_sent");
            assert.equal(error.retrySafety, "unsafe");
            assert.equal(error.bytesWritten, 32768);
            assert.equal(error.attempts, 1);
            return true;
        },
    );
    assert.equal(calls, 1, "an ambiguous write must never be retried");
}

async function testConnectorPreservesStructuredFailure() {
    let calls = 0;
    global.fetch = async () => {
        calls += 1;
        if (calls === 1) {
            return jsonResponse(504, {
                ok: false,
                error: "connector could not reach printer",
                code: "TCP_CONNECT_TIMEOUT",
                stage: "connect",
                outcome: "not_sent",
                retrySafety: "safe",
                bytesWritten: 0,
                writeStarted: false,
                writeCompleted: false,
            });
        }
        return jsonResponse(200, {
            ok: true,
            bytesWritten: baseOptions.payload.byteLength,
            response: "",
        });
    };

    const result = await sendTcpBytesWithSafeRetry({
        ...baseOptions,
        executionMode: "connector",
        agentUrl: "http://127.0.0.1:17917",
    }, {
        retryDelaysMs: [0],
        sleep: async () => {},
    });
    assert.equal(calls, 2);
    assert.equal(result.execution, "connector");
}

async function testExhaustedSafeRetriesReportAttempts() {
    let calls = 0;
    global.fetch = async () => {
        calls += 1;
        return jsonResponse(502, {
            ok: false,
            error: "network unreachable",
            code: "TCP_CONNECT_FAILED",
            stage: "connect",
            outcome: "not_sent",
            retrySafety: "safe",
            bytesWritten: 0,
            writeStarted: false,
            writeCompleted: false,
        });
    };

    await assert.rejects(
        sendTcpBytesWithSafeRetry(baseOptions, {
            retryDelaysMs: [0, 0],
            sleep: async () => {},
        }),
        (error) => {
            assert.ok(isSafeTcpRetry(error));
            assert.equal(error.attempts, 3);
            return true;
        },
    );
    assert.equal(calls, 3);
}

async function main() {
    await testSafeConnectRetry();
    await testAmbiguousWriteNeverRetries();
    await testConnectorPreservesStructuredFailure();
    await testExhaustedSafeRetriesReportAttempts();
    console.log(
        "TCP retry tests passed: only proven not-sent failures retry; ambiguous writes stop.",
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
