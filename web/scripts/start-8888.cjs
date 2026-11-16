/* eslint-disable @typescript-eslint/no-require-imports */
const path = require("node:path");
const fs = require("node:fs");

const rootDir = path.resolve(__dirname, "..");

function isInside(parent, target) {
    const rel = path.relative(parent, target);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function refreshStandaloneAssetDir(src, dest) {
    if (!fs.existsSync(src)) return;
    if (!isInside(rootDir, dest)) {
        throw new Error(`Refusing to refresh asset directory outside project: ${dest}`);
    }
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, force: true });
}

process.env.PORT = process.env.PORT || "8888";
process.env.HOSTNAME = process.env.HOSTNAME || "127.0.0.1";
if (!process.env.NEXTWAVES_SERVER_TCP) {
    const bindHost = process.env.HOSTNAME.trim().toLowerCase().replace(/^\[|\]$/g, "");
    process.env.NEXTWAVES_SERVER_TCP =
        bindHost === "localhost" || bindHost === "127.0.0.1" || bindHost === "::1"
            ? "enabled"
            : "disabled";
}
process.env.NEXTWAVES_DEFAULT_TEMPLATE_PATH =
    process.env.NEXTWAVES_DEFAULT_TEMPLATE_PATH || path.join(rootDir, "template", "Generic_Label_A.nwl");
process.env.NEXTWAVES_PRINTER_CONFIG_PATH =
    process.env.NEXTWAVES_PRINTER_CONFIG_PATH
    || path.join(rootDir, "data", "printer-routing.json");
process.env.NEXTWAVES_DATA_DIR =
    process.env.NEXTWAVES_DATA_DIR
    || path.join(rootDir, "data");
process.env.NEXTWAVES_TEMPLATE_ROOT =
    process.env.NEXTWAVES_TEMPLATE_ROOT
    || path.join(rootDir, "template");

refreshStandaloneAssetDir(
    path.join(rootDir, ".next", "static"),
    path.join(rootDir, ".next", "standalone", ".next", "static"),
);
refreshStandaloneAssetDir(
    path.join(rootDir, "public"),
    path.join(rootDir, ".next", "standalone", "public"),
);

require("../.next/standalone/server.js");
