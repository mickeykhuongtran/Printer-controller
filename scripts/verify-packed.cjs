const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { enabled, runtimeManifestPolicyErrors } = require("./bundle-policy.cjs");
const { smokeTestConnector } = require("./verify-bundle.cjs");

const root = path.resolve(__dirname, "..");
const appDirectory = path.resolve(
    process.argv[2] || path.join(root, "dist", "win-unpacked"),
);
const resources = path.join(appDirectory, "resources");

function fail(message) {
    throw new Error(`Packed runtime verification failed: ${message}`);
}

function requireFile(filePath, label) {
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        fail(`${label} is missing (${filePath}).`);
    }
}

function sha256(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

async function main() {
    requireFile(path.join(appDirectory, "ZbrePrinter.exe"), "desktop executable");
    const manifestPath = path.join(resources, "runtime-manifest.json");
    requireFile(manifestPath, "packed runtime manifest");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const strictRelease = enabled(process.env.ZBREPRINTER_STRICT_RELEASE);
    const policyErrors = runtimeManifestPolicyErrors(manifest, { strictRelease });
    if (policyErrors.length > 0) fail(policyErrors.join("; "));

    const connectorFile = path.basename(String(manifest.connector?.file || ""));
    if (!connectorFile || connectorFile !== manifest.connector.file) {
        fail("connector file name is invalid.");
    }
    const connectorPath = path.join(resources, "connector", connectorFile);
    const serverPath = path.join(resources, "web", "server.js");
    requireFile(connectorPath, "packed Local Print Connector");
    requireFile(serverPath, "packed Next standalone server");
    if (sha256(connectorPath) !== manifest.connector.sha256) {
        fail("connector hash changed during Electron packaging/signing.");
    }
    if (sha256(serverPath) !== manifest.web.serverSha256) {
        fail("server.js hash changed during Electron packaging.");
    }

    await smokeTestConnector(connectorPath, manifest.connector.version);
    process.stdout.write(
        `Packed runtime verified: ${appDirectory}, connector ${manifest.connector.version}, `
        + `signed=${manifest.connector.signed}, strictRelease=${strictRelease}\n`,
    );
}

if (require.main === module) {
    void main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
