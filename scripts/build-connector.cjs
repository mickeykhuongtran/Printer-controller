const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { resolveWebSource } = require("./web-source.cjs");

const desktopRoot = path.resolve(__dirname, "..");

function argumentValue(name) {
    const index = process.argv.indexOf(name);
    return index >= 0 ? process.argv[index + 1] : "";
}

const sourceRoot = resolveWebSource({
    desktopRoot,
    source: argumentValue("--source") || process.env.ZBREPRINTER_WEB_SOURCE,
});
const packagePath = path.join(sourceRoot, "package.json");
if (!fs.statSync(packagePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`ZbrePrinter package.json was not found: ${packagePath}`);
}

const npmCli = process.env.npm_execpath;
if (!npmCli) {
    throw new Error(
        "npm_execpath is unavailable. Run this script through `npm run build:connector`.",
    );
}

const bundledGoBin = path.join(
    sourceRoot,
    "tmp",
    "go1.26.5-toolchain",
    "go",
    "bin",
);
const buildEnvironment = { ...process.env };
if (fs.statSync(path.join(bundledGoBin, "go.exe"), { throwIfNoEntry: false })?.isFile()) {
    buildEnvironment.PATH = `${bundledGoBin}${path.delimiter}${buildEnvironment.PATH || ""}`;
}

const result = spawnSync(
    process.execPath,
    [npmCli, "run", "build-agent:connector"],
    {
        cwd: sourceRoot,
        env: buildEnvironment,
        stdio: "inherit",
    },
);
if (result.error) throw result.error;
if (result.status !== 0) {
    throw new Error(`Connector build exited with status ${String(result.status)}.`);
}
