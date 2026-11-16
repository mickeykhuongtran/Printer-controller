const fs = require("node:fs");
const path = require("node:path");

// Prefer the source included in this repository. Keep compatibility with older
// checkouts that placed ZbrePrinter and ZbrePrinter-App beside each other.
function resolveWebSource({
    desktopRoot = path.resolve(__dirname, ".."),
    source = process.env.ZBREPRINTER_WEB_SOURCE,
} = {}) {
    const candidates = source
        ? [path.resolve(source)]
        : [
            path.join(desktopRoot, "web"),
            path.resolve(desktopRoot, "..", "ZbrePrinter"),
            path.resolve(desktopRoot, "..", ".."),
        ];
    for (const candidate of candidates) {
        if (fs.statSync(path.join(candidate, "package.json"), { throwIfNoEntry: false })?.isFile()
            && fs.statSync(path.join(candidate, "app", "zpl.ts"), { throwIfNoEntry: false })?.isFile()) {
            return candidate;
        }
    }
    throw new Error(`ZbrePrinter web source was not found. Checked: ${candidates.join(", ")}`);
}

module.exports = { resolveWebSource };
