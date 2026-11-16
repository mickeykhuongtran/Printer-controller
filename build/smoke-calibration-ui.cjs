const { resolveWebSource } = require("../scripts/web-source.cjs");
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const Module = require("node:module");

const root = path.resolve(__dirname, "..");
const web = path.join(root, "dist", "win-unpacked", "resources", "web");
const output = path.join(root, "build", "calibration-qa");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(output, "profile-")));
app.commandLine.appendSwitch("disable-background-timer-throttling");
let server;
let win;
let serverLog = "";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn, message) {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
        if (await fn()) return;
        await wait(200);
    }
    throw new Error(message);
}
async function main() {
    const fixturePath = path.join(resolveWebSource(), "scripts", "test-print-calibration.cjs");
    const fixtureModule = new Module(fixturePath, module);
    fixtureModule.filename = fixturePath;
    fixtureModule.paths = Module._nodeModulePaths(path.dirname(fixturePath));
    fixtureModule._compile(fs.readFileSync(fixturePath, "utf8") + "\nmodule.exports = { doc, printerRead };", fixturePath);
    const fixtures = fixtureModule.exports;
    const port = await new Promise((resolve) => {
        const probe = net.createServer();
        probe.listen(0, "127.0.0.1", () => {
            const value = probe.address().port;
            probe.close(() => resolve(value));
        });
    });
    const origin = `http://127.0.0.1:${port}`;
    server = spawn("node", [path.join(web, "server.js")], {
        cwd: web, windowsHide: true,
        env: {
            ...process.env, NODE_PATH: path.join(web, "standalone_modules"),
            PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production",
            NEXTWAVES_DEPLOYMENT_MODE: "desktop", NEXTWAVES_SERVER_TCP: "disabled",
            NEXTWAVES_DATA_DIR: path.join(output, "server-data"),
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    server.stdout.on("data", (data) => { serverLog += data; });
    server.stderr.on("data", (data) => { serverLog += data; });
    await poll(async () => {
        try { return (await fetch(origin)).ok; } catch { return false; }
    }, "Packaged server did not start: " + serverLog);
    await app.whenReady();
    win = new BrowserWindow({
        show: false, width: 1460, height: 1050,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
    });
    // The QA window can only use its isolated local web runtime; never a printer.
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => {
        const allowed = details.url.startsWith(origin + "/") || /^(blob:|data:|devtools:)/.test(details.url);
        callback({ cancel: !allowed });
    });
    win.webContents.session.on("will-download", (_event, item) => item.cancel());
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadURL(origin);
    const results = [];
    for (const [name, doc] of Object.entries(fixtures)) {
        await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc, step: "print", hasDoc: true }))}); localStorage.setItem('zbre.print.printer.v1', JSON.stringify({connectionMode:'windowsRaw', printerName:'QA disconnected queue', language:'zpl'}));`);
        await win.loadURL(origin);
        await poll(() => js(`!!document.querySelector('[data-testid="print-calibration-warnings"]')`), "Warning bar missing for " + name);
        const ui = await js(`({warning: document.querySelector('[data-testid="print-calibration-warnings"]').innerText, print: [...document.querySelectorAll('button')].filter(b=>/^Print \\d+ labels?$/.test(b.innerText)).map(b=>({text:b.innerText,disabled:b.disabled}))})`);
        assert.match(ui.warning, /test printing allowed/);
        assert.match(ui.warning, name === "doc" ? /First N/ : /label quantity to 1–3/);
        assert.ok(ui.print.length > 0 && ui.print.every((button) => !button.disabled), "Sizing must not disable print: " + JSON.stringify(ui));
        await js(`document.querySelector('[data-testid="print-calibration-warnings"] details').open = true; window.__qaBlobs = []; const original = URL.createObjectURL.bind(URL); URL.createObjectURL = blob => { window.__qaBlobs.push(blob); return original(blob); }; [...document.querySelectorAll('summary')].find(s=>s.innerText.includes('More actions')).parentElement.open = true;`);
        await js(`[...document.querySelectorAll('button')].find(b=>b.innerText.includes('Download .zpl')).click()`);
        await poll(() => js(`window.__qaBlobs.length > 0`), "ZPL download did not finish for " + name);
        const zpl = await js(`window.__qaBlobs[window.__qaBlobs.length-1].text()`);
        assert.match(zpl, /\^GFA/);
        if (name === "printerRead") {
            assert.match(zpl, /\^BY2,2\.0,/);
            assert.match(zpl, /\^BQN,2,3/);
            assert.match(zpl, /\^RF/);
            assert.doesNotMatch(zpl, /\{read_epc\}|FFFFFFFFFFFFFFFFFFFFFFFF/);
        } else {
            assert.equal((zpl.match(/\^PQ1/g) || []).length, 2, "Both imported rows must export");
        }
        await wait(300);
        assert.ok(await js(`document.body.innerText.includes('Print warnings were allowed for')`), "Download result must retain calibration warnings");
        fs.writeFileSync(path.join(output, name + ".zpl"), zpl);
        const shot = await win.webContents.capturePage();
        fs.writeFileSync(path.join(output, name + ".png"), shot.toPNG());
        results.push({ name, ui, zplBytes: Buffer.byteLength(zpl) });
    }
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(results, null, 2));
    console.log("Packaged UI calibration smoke passed: warning bars visible, print buttons enabled, imported list and read_epc exported.");
}
main().then(() => {
    if (win) win.destroy();
    if (server) server.kill();
    app.exit(0);
}).catch((error) => {
    console.error(error, serverLog);
    if (win) win.destroy();
    if (server) server.kill();
    app.exit(1);
});
