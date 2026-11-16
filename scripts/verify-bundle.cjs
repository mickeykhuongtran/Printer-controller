const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const {
    CONNECTOR_HOST,
    connectorHealthError,
    connectorVersionError,
} = require("../electron/runtime.cjs");
const {
    enabled,
    runtimeManifestPolicyErrors,
} = require("./bundle-policy.cjs");

const root = path.resolve(__dirname, "..");
const bundle = path.join(root, "bundle");
const manifestPath = path.join(bundle, "runtime-manifest.json");
const CONNECTOR_START_TIMEOUT_MS = 10_000;
const MAX_CONNECTOR_LOG_CHARS = 16_000;
const TEMP_PREFIX = "zbreprinter-verify-";

function fail(message) {
    throw new Error(`Bundle verification failed: ${message}`);
}

function file(pathname, label) {
    if (!fs.statSync(pathname, { throwIfNoEntry: false })?.isFile()) {
        fail(`${label} is missing (${pathname}).`);
    }
}

function directory(pathname, label) {
    if (!fs.statSync(pathname, { throwIfNoEntry: false })?.isDirectory()) {
        fail(`${label} is missing (${pathname}).`);
    }
}

function sha256(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath, label) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        fail(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function safeFileName(value, label) {
    if (
        typeof value !== "string"
        || value.length === 0
        || path.basename(value) !== value
    ) {
        fail(`${label} must be one file name without path traversal.`);
    }
    return value;
}

function safeRelativeDirectory(value, label) {
    if (
        typeof value !== "string"
        || value.length === 0
        || path.isAbsolute(value)
        || value.split(/[\\/]+/).includes("..")
    ) {
        fail(`${label} must be a safe relative directory.`);
    }
    return value;
}

function boundedLog(previous, chunk) {
    return `${previous}${chunk.toString("utf8")}`.slice(-MAX_CONNECTOR_LOG_CHARS);
}

function childLog(stdout, stderr) {
    const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
    return combined ? ` Connector output:\n${combined}` : "";
}

function delay(timeoutMs) {
    return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function freeLoopbackPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen({ host: CONNECTOR_HOST, port: 0, exclusive: true }, () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                reject(new Error("Could not determine the temporary connector port."));
                return;
            }
            server.close((error) => {
                if (error) reject(error);
                else resolve(address.port);
            });
        });
    });
}

function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        let settled = false;
        const finish = (exited) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            child.removeListener("exit", onExit);
            resolve(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", onExit);
    });
}

async function terminateChild(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    if (await waitForExit(child, 2_000)) return;
    child.kill("SIGKILL");
    await waitForExit(child, 2_000);
}

function removeTemporaryDirectory(tempDirectory) {
    if (!tempDirectory) return;
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(tempDirectory);
    if (
        path.dirname(resolved) !== tempRoot
        || !path.basename(resolved).startsWith(TEMP_PREFIX)
    ) {
        throw new Error(`Refusing to remove unexpected temporary directory: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}

async function pollConnectorHealth(url, child, logs) {
    const deadline = Date.now() + CONNECTOR_START_TIMEOUT_MS;
    let lastError = "";
    while (Date.now() < deadline) {
        if (logs.spawnError) throw logs.spawnError;
        if (child.exitCode !== null || child.signalCode !== null) {
            fail(
                `bundled connector exited before health was ready `
                + `(code=${String(child.exitCode)}, signal=${String(child.signalCode)}).`
                + childLog(logs.stdout, logs.stderr),
            );
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 750);
        try {
            const response = await fetch(url, {
                cache: "no-store",
                signal: controller.signal,
            });
            const data = await response.json().catch(() => null);
            if (!response.ok) {
                fail(`connector health returned HTTP ${response.status}.`);
            }
            return data;
        } catch (error) {
            if (error instanceof Error && error.message.startsWith("Bundle verification failed:")) {
                throw error;
            }
            lastError = error instanceof Error ? error.message : String(error);
        } finally {
            clearTimeout(timer);
        }
        await delay(100);
    }
    fail(
        `bundled connector did not become healthy within ${CONNECTOR_START_TIMEOUT_MS} ms`
        + (lastError ? `: ${lastError}.` : ".")
        + childLog(logs.stdout, logs.stderr),
    );
}

async function smokeTestConnector(connectorPath, expectedVersion) {
    if (process.platform !== "win32") {
        fail("the Windows x64 connector smoke test must run on Windows.");
    }

    const port = await freeLoopbackPort();
    const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
    const stateFile = path.join(tempDirectory, "pairing-state.json");
    const logs = { stdout: "", stderr: "", spawnError: null };
    let child = null;
    try {
        child = spawn(
            connectorPath,
            [
                "--listen-address", CONNECTOR_HOST,
                "--port", String(port),
                "--tcp-ports", "9100",
                "--state-file", stateFile,
            ],
            {
                cwd: path.dirname(connectorPath),
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
            },
        );
        child.stdout.on("data", (chunk) => {
            logs.stdout = boundedLog(logs.stdout, chunk);
        });
        child.stderr.on("data", (chunk) => {
            logs.stderr = boundedLog(logs.stderr, chunk);
        });
        child.once("error", (error) => {
            logs.spawnError = error;
        });

        const health = await pollConnectorHealth(
            `http://${CONNECTOR_HOST}:${port}/v1/health`,
            child,
            logs,
        );
        const healthError = connectorHealthError(health);
        if (healthError) {
            fail(`bundled connector health is incompatible: ${healthError}`);
        }
        if (String(health.version || "").trim() !== String(expectedVersion).trim()) {
            fail(
                `bundled connector reports version ${String(health.version || "unknown")}, `
                + `but the runtime manifest declares ${String(expectedVersion)}.`,
            );
        }
        if (Number(health.port) !== port) {
            fail(
                `bundled connector health reports port ${String(health.port)}, `
                + `expected temporary port ${port}.`,
            );
        }
    } finally {
        await terminateChild(child);
        removeTemporaryDirectory(tempDirectory);
    }
}

async function main() {
    file(manifestPath, "runtime manifest");
    const manifest = readJson(manifestPath, "runtime manifest");
    if (manifest.schemaVersion !== 1) fail("unsupported runtime manifest schema.");
    const desktopPackagePath = path.join(root, "package.json");
    file(desktopPackagePath, "desktop package.json");
    const desktopPackage = readJson(desktopPackagePath, "desktop package.json");
    if (
        String(manifest.web?.packageVersion ?? "").trim()
        !== String(desktopPackage.version ?? "").trim()
    ) {
        fail(
            `web version ${String(manifest.web?.packageVersion ?? "missing")} `
            + `does not match desktop version ${String(desktopPackage.version ?? "missing")}.`,
        );
    }

    const strictRelease = enabled(process.env.ZBREPRINTER_STRICT_RELEASE);
    const policyErrors = runtimeManifestPolicyErrors(manifest, { strictRelease });
    if (policyErrors.length > 0) fail(policyErrors.join("; "));

    const connectorFile = safeFileName(
        manifest.connector?.file,
        "runtime manifest connector.file",
    );
    const distDir = safeRelativeDirectory(
        manifest.web?.distDir,
        "runtime manifest web.distDir",
    );
    const serverPath = path.join(bundle, "web", "server.js");
    const connectorPath = path.join(bundle, "connector", connectorFile);
    const connectorManifestPath = path.join(bundle, "connector", "manifest.json");
    file(serverPath, "Next standalone server");
    file(connectorPath, "Windows x64 Local Print Connector");
    file(connectorManifestPath, "copied connector manifest");
    directory(
        path.join(bundle, "web", distDir, "static"),
        "Next static assets",
    );
    directory(
        path.join(bundle, "web", "standalone_modules", "next"),
        "traced Next runtime modules",
    );
    directory(path.join(bundle, "web", "public"), "public assets");
    directory(path.join(bundle, "web", "template"), "template seeds");
    file(path.join(root, "build", "ZbrePrinter.png"), "Windows app icon");

    if (fs.existsSync(path.join(bundle, "web", "data"))) {
        fail("mutable developer data was copied into the installed runtime.");
    }
    if (fs.existsSync(path.join(bundle, "web", "node_modules"))) {
        fail("root node_modules must be renamed so electron-builder does not filter it.");
    }
    if (sha256(serverPath) !== manifest.web.serverSha256) {
        fail("server.js hash differs from the runtime manifest.");
    }
    if (sha256(connectorPath) !== manifest.connector.sha256) {
        fail("connector hash differs from the runtime manifest.");
    }

    const connectorManifest = readJson(connectorManifestPath, "copied connector manifest");
    if (connectorManifest.schemaVersion !== 1) {
        fail("unsupported copied connector manifest schema.");
    }
    const copiedVersionError = connectorVersionError(connectorManifest.connectorVersion);
    if (copiedVersionError) {
        fail(`copied connector manifest is incompatible: ${copiedVersionError}`);
    }
    if (
        String(connectorManifest.connectorVersion).trim()
        !== String(manifest.connector.version).trim()
    ) {
        fail("connector versions differ between the copied and runtime manifests.");
    }
    const connectorArtifact = connectorManifest.artifacts?.find(
        (artifact) => artifact.os === "windows" && artifact.arch === "amd64",
    );
    if (!connectorArtifact) {
        fail("copied connector manifest does not include Windows amd64.");
    }
    if (
        connectorArtifact.file !== connectorFile
        || connectorArtifact.sha256 !== manifest.connector.sha256
        || (connectorArtifact.signed === true) !== (manifest.connector.signed === true)
    ) {
        fail("Windows connector metadata differs between copied and runtime manifests.");
    }

    await smokeTestConnector(connectorPath, manifest.connector.version);

    process.stdout.write(
        `Bundle verified: web ${manifest.web.packageVersion}, `
        + `connector ${manifest.connector.version}, signed=${manifest.connector.signed}, `
        + `strictRelease=${strictRelease}\n`,
    );
}

if (require.main === module) {
    void main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}

module.exports = {
    freeLoopbackPort,
    smokeTestConnector,
};
