/* eslint-disable @typescript-eslint/no-require-imports */
const { spawn } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const port = "18888";
const origin = `http://127.0.0.1:${port}`;
const output = [];

const server = spawn(process.execPath, [path.join(root, "scripts", "start-8888.cjs")], {
    cwd: root,
    env: {
        ...process.env,
        PORT: port,
        HOSTNAME: "127.0.0.1",
        VERCEL: "1",
        NEXTWAVES_DEPLOYMENT_MODE: "cloud",
        NEXTWAVES_SERVER_TCP: "enabled",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
});

server.stdout.on("data", (chunk) => output.push(chunk.toString()));
server.stderr.on("data", (chunk) => output.push(chunk.toString()));

const delay = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForServer() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (server.exitCode !== null) {
            throw new Error(`Web server exited early (${server.exitCode}).`);
        }
        try {
            const response = await fetch(origin, { cache: "no-store" });
            if (response.ok) return;
        } catch {
            // Build startup is still in progress.
        }
        await delay(100);
    }
    throw new Error("Timed out waiting for the standalone web server.");
}

async function expectStatus(pathname, status, init) {
    const response = await fetch(`${origin}${pathname}`, init);
    if (response.status !== status) {
        throw new Error(`${pathname}: expected HTTP ${status}, got ${response.status}.`);
    }
    return response;
}

async function main() {
    await waitForServer();

    const manifestResponse = await expectStatus("/agent/manifest.json", 200);
    const manifest = await manifestResponse.json();
    if (manifest.connectorVersion !== "0.4.0" || manifest.artifacts?.length !== 4) {
        throw new Error("Connector artifact manifest is incomplete.");
    }

    const downloads = [
        "/agent/ZbrePrinterLocalPrintAgent-windows-x64.exe",
        "/agent/ZbrePrinterLocalPrintAgent-macos-arm64",
        "/agent/ZbrePrinterLocalPrintAgent-macos-x64",
    ];
    const downloadBytes = {};
    for (const pathname of downloads) {
        const response = await expectStatus(pathname, 200, { method: "HEAD" });
        const length = Number(response.headers.get("content-length"));
        if (!Number.isFinite(length) || length < 5_000_000) {
            throw new Error(`${pathname}: invalid content length ${length}.`);
        }
        downloadBytes[pathname] = length;
    }

    const tcpGuard = await expectStatus("/api/printer/tcp", 403, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            host: "192.168.50.50",
            port: 9100,
            payloadBase64: Buffer.from("test").toString("base64"),
        }),
    });
    const tcpGuardBody = await tcpGuard.json();
    if (tcpGuardBody.ok !== false) {
        throw new Error("Cloud TCP guard returned an unexpected response.");
    }

    await expectStatus("/api/integration/schema", 503);

    process.stdout.write(
        `${JSON.stringify({
            pageStatus: 200,
            connectorVersion: manifest.connectorVersion,
            artifacts: manifest.artifacts.length,
            downloadBytes,
            cloudTcpStatus: 403,
            cloudIntegrationStatus: 503,
        })}\n`,
    );
}

main()
    .catch((error) => {
        process.stderr.write(`${error.stack || error}\n${output.join("")}`);
        process.exitCode = 1;
    })
    .finally(() => {
        if (server.exitCode === null) server.kill();
    });
