const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveWebSource } = require("./web-source.cjs");

const { connectorVersionError } = require("../electron/runtime.cjs");

const desktopRoot = path.resolve(__dirname, "..");

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : "";
}

function inside(parent, child) {
    const relative = path.relative(parent, child);
    return relative !== ""
        && !relative.startsWith("..")
        && !path.isAbsolute(relative);
}

function sha256(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function requireFile(filePath, label) {
    if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`${label} was not found: ${filePath}`);
    }
}

function copyDirectory(source, destination) {
    if (!fs.statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`Required directory was not found: ${source}`);
    }
    fs.cpSync(source, destination, { recursive: true, force: true });
}

function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
        stdio: "inherit",
        ...options,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`${command} ${args.join(" ")} exited with ${result.status}.`);
    }
}

const sourceRoot = resolveWebSource({
    desktopRoot,
    source: argumentValue("--source") || process.env.ZBREPRINTER_WEB_SOURCE,
});
const skipBuild = process.argv.includes("--skip-build");
const nextDistDir = (
    process.env.ZBREPRINTER_BUILD_DIST_DIR
    || ".next-desktop"
).trim();
if (
    !nextDistDir
    || path.isAbsolute(nextDistDir)
    || nextDistDir.split(/[\\/]+/).includes("..")
) {
    throw new Error(`Unsafe desktop Next distDir: ${nextDistDir}`);
}
const bundleRoot = path.join(desktopRoot, "bundle");
const webDestination = path.join(bundleRoot, "web");
const connectorDestination = path.join(bundleRoot, "connector");

const sourcePackagePath = path.join(sourceRoot, "package.json");
const desktopPackagePath = path.join(desktopRoot, "package.json");
requireFile(sourcePackagePath, "ZbrePrinter package.json");
requireFile(desktopPackagePath, "desktop package.json");
const packageJson = JSON.parse(fs.readFileSync(sourcePackagePath, "utf8"));
const desktopPackageJson = JSON.parse(fs.readFileSync(desktopPackagePath, "utf8"));
if (String(packageJson.version).trim() !== String(desktopPackageJson.version).trim()) {
    throw new Error(
        `Desktop version ${String(desktopPackageJson.version)} does not match `
        + `web version ${String(packageJson.version)}.`,
    );
}
if (!inside(desktopRoot, bundleRoot)) {
    throw new Error(`Refusing to replace bundle outside desktop project: ${bundleRoot}`);
}

// Validate the connector before running the expensive web build or replacing
// the last known-good bundle. Pack/dist build the connector first, so a stale
// or incorrectly versioned artifact fails here instead of failing at runtime.
const connectorManifestPath = path.join(sourceRoot, "public", "agent", "manifest.json");
requireFile(connectorManifestPath, "Connector manifest");
const connectorManifest = JSON.parse(fs.readFileSync(connectorManifestPath, "utf8"));
const connectorCompatibilityError = connectorVersionError(
    connectorManifest.connectorVersion,
);
if (connectorCompatibilityError) {
    throw new Error(
        `Connector manifest is incompatible with the desktop runtime: ${connectorCompatibilityError}`,
    );
}
const connectorArtifact = connectorManifest.artifacts?.find(
    (artifact) => artifact.os === "windows" && artifact.arch === "amd64",
);
if (!connectorArtifact) {
    throw new Error("Connector manifest does not include a Windows amd64 artifact.");
}
const connectorSource = path.join(sourceRoot, "public", "agent", connectorArtifact.file);
requireFile(connectorSource, "Windows x64 Local Print Connector");
if (sha256(connectorSource) !== connectorArtifact.sha256) {
    throw new Error("Connector binary does not match public/agent/manifest.json.");
}

if (!skipBuild) {
    const npmCli = process.env.npm_execpath;
    if (!npmCli) {
        throw new Error(
            "npm_execpath is unavailable. Run this script through `npm run prepare:web`.",
        );
    }
    run(process.execPath, [npmCli, "run", "build"], {
        cwd: sourceRoot,
        env: {
            ...process.env,
            NEXT_PUBLIC_TCP_EXECUTION: "connector",
            NEXTWAVES_DEPLOYMENT_MODE: "desktop",
            NEXTWAVES_SERVER_TCP: "disabled",
            NEXTWAVES_ENABLE_INTEGRATION_API: "true",
            NEXTWAVES_NEXT_DIST_DIR: nextDistDir,
        },
    });
}

const standalone = path.join(sourceRoot, nextDistDir, "standalone");
const staticAssets = path.join(sourceRoot, nextDistDir, "static");
requireFile(path.join(standalone, "server.js"), "Next standalone server");

fs.rmSync(bundleRoot, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 250,
});
fs.mkdirSync(bundleRoot, { recursive: true });
copyDirectory(standalone, webDestination);

const tracedNodeModules = path.join(webDestination, "node_modules");
const packagedNodeModules = path.join(webDestination, "standalone_modules");
if (!fs.statSync(tracedNodeModules, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("Next standalone output did not include traced node_modules.");
}
fs.rmSync(packagedNodeModules, { recursive: true, force: true });
fs.renameSync(tracedNodeModules, packagedNodeModules);

for (const generatedOrMutable of [
    "data",
    "public",
    "template",
    "Setup",
    ".desktop-app-staging",
]) {
    fs.rmSync(path.join(webDestination, generatedOrMutable), {
        recursive: true,
        force: true,
    });
}
fs.rmSync(path.join(webDestination, nextDistDir, "static"), {
    recursive: true,
    force: true,
});
copyDirectory(staticAssets, path.join(webDestination, nextDistDir, "static"));
copyDirectory(path.join(sourceRoot, "public"), path.join(webDestination, "public"));
copyDirectory(path.join(sourceRoot, "template"), path.join(webDestination, "template"));

fs.mkdirSync(connectorDestination, { recursive: true });
fs.copyFileSync(
    connectorSource,
    path.join(connectorDestination, connectorArtifact.file),
);
fs.copyFileSync(
    connectorManifestPath,
    path.join(connectorDestination, "manifest.json"),
);

const buildDir = path.join(desktopRoot, "build");
fs.mkdirSync(buildDir, { recursive: true });
fs.copyFileSync(
    path.join(sourceRoot, "public", "icon-512.png"),
    path.join(buildDir, "ZbrePrinter.png"),
);

const gitCommit = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: sourceRoot,
    encoding: "utf8",
});
// The connector build intentionally refreshes tracked generated artifacts.
// Their integrity/signature is verified separately, so do not make every
// otherwise-clean strict release appear dirty solely because it rebuilt them.
const gitDirty = spawnSync("git", [
    "status",
    "--porcelain",
    "--",
    ".",
    ":(exclude)public/agent/**",
], {
    cwd: sourceRoot,
    encoding: "utf8",
});
const serverPath = path.join(webDestination, "server.js");
const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    web: {
        packageVersion: packageJson.version,
        distDir: nextDistDir,
        sourceCommit: gitCommit.status === 0 ? gitCommit.stdout.trim() : "",
        sourceDirty: gitDirty.status === 0 ? gitDirty.stdout.trim().length > 0 : null,
        sourceDirtyExcludes: ["public/agent/**"],
        serverSha256: sha256(serverPath),
    },
    connector: {
        version: connectorManifest.connectorVersion,
        file: connectorArtifact.file,
        sha256: connectorArtifact.sha256,
        signed: connectorArtifact.signed === true,
    },
};
fs.writeFileSync(
    path.join(bundleRoot, "runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
);

process.stdout.write(
    `Prepared desktop runtime from ${sourceRoot}\n`
    + `Web: ${webDestination}\n`
    + `Connector: ${connectorArtifact.file} ${connectorManifest.connectorVersion}\n`,
);
