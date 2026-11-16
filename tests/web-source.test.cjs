const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { resolveWebSource } = require("../scripts/web-source.cjs");

test("build source selection supports a standalone clone and explicit external source", (t) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "zbre-source-"));
    t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
    const desktopRoot = path.join(temporary, "desktop");
    const embedded = path.join(desktopRoot, "web");
    const sibling = path.join(temporary, "ZbrePrinter");
    function addSource(directory) {
        fs.mkdirSync(path.join(directory, "app"), { recursive: true });
        fs.writeFileSync(path.join(directory, "package.json"), "{}");
        fs.writeFileSync(path.join(directory, "app", "zpl.ts"), "");
    }
    addSource(sibling);
    assert.equal(resolveWebSource({ desktopRoot, source: "" }), sibling);
    addSource(embedded);
    assert.equal(resolveWebSource({ desktopRoot, source: "" }), embedded);
    assert.equal(resolveWebSource({ desktopRoot, source: sibling }), sibling);
    assert.throws(() => resolveWebSource({ desktopRoot, source: path.join(temporary, "missing") }), /not found/);
    assert.throws(() => resolveWebSource({ desktopRoot, source: desktopRoot }), /not found/);
});
