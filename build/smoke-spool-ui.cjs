const { resolveWebSource } = require("../scripts/web-source.cjs");
// Packaged-UI regression. A private fake connector is the only print endpoint
// permitted by the Electron request filter; this script cannot print hardware.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const Module = require("node:module");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { addPairingText, installPairCapture, assertLabelPairs, assertDetectsReportedJump } = require("./label-pairing-qa.cjs");
const root = path.resolve(__dirname, "..");
const web = path.join(root, "dist/win-unpacked/resources/web");
const reverse = process.argv.includes("--reverse");
const output = path.join(root, reverse ? "build/spool-reverse-qa" : "build/spool-qa");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(output, "profile-")));
let win, server, mock, serverLog = "";
const batches = new Map();
const chunks = [];
let commits = 0;
const dataRowCount = 2500;
const fromRow = reverse ? 2350 : 1;
const toRow = reverse ? 1750 : dataRowCount;
const labelCount = Math.abs(toRow - fromRow) + 1;
const expectedRows = Array.from({ length: labelCount }, (_, i) => fromRow + i * (reverse ? -1 : 1));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function poll(fn, message) {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) { if (await fn()) return; await wait(200); }
    if (win && !win.isDestroyed()) {
        fs.writeFileSync(path.join(output, "failure.txt"), await win.webContents.executeJavaScript("document.body.innerText"));
        fs.writeFileSync(path.join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
    }
    throw new Error(message);
}
async function freePort() {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
    });
}
async function main() {
    const fixturePath = path.join(resolveWebSource(), "scripts", "test-print-calibration.cjs");
    const fixture = new Module(fixturePath, module);
    fixture.filename = fixturePath;
    fixture.paths = Module._nodeModulePaths(path.dirname(fixturePath));
    fixture._compile(fs.readFileSync(fixturePath, "utf8") + "\nmodule.exports = { doc };", fixturePath);
    const doc = structuredClone(fixture.exports.doc);
    addPairingText(doc);
    doc.id = "spool-qa"; doc.name = "Staged HEX batch QA"; doc.settings.copies = dataRowCount;
    Object.assign(doc.settings.rfid, { enabled: true, data: "{RFID}", zebraModel: "zt610r", zebraUsePrinterSettings: true });
    doc.dataFeed.rows = Array.from({ length: dataRowCount }, (_, i) => ({ id: `row${i + 1}`, cells: { epc: (i + 1).toString(16).padStart(24, "0").toUpperCase() } }));
    const printerName = reverse ? "ZDesigner QA ZT610R-300dpi Ethernet" : "ZDesigner QA ZT610R-300dpi USB";
    const queues = [
        { name: "Office PDF", driverName: "Microsoft Print To PDF", portName: "PORTPROMPT:", isDefault: true },
        { name: "ZDesigner QA ZT610R-300dpi USB", driverName: "ZDesigner ZT610R-300dpi ZPL", portName: "USB_QA", isDefault: false },
        { name: "ZDesigner QA ZT610R-300dpi Ethernet", driverName: "ZDesigner ZT610R-300dpi ZPL", portName: "IP_192.168.50.2", isDefault: false },
    ];
    mock = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Content-Type", "application/json");
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        const send = (data, status = 200) => { res.writeHead(status); res.end(JSON.stringify(data)); };
        if (req.url === "/v1/health") return send({ ok: true, name: "Nextwaves Zebra Local Print Connector", version: "0.5.0", windowsRaw: true, capabilities: { rawSpoolBatchV1: true, rawBatchLeaseV1: true, tcpJobIdempotencyV1: true, printerTargetQueueV1: true } });
        if (req.url === "/v1/printers") return send({ printers: queues });
        if (req.url !== "/v1/print/batch") return send({ ok: false, error: "Only staged batches are allowed in this test." }, 400);
        try {
            let raw = ""; for await (const piece of req) raw += piece;
            const body = JSON.parse(raw);
            if (body.action === "list") return send({ ok: true, batches: [...batches.values()].filter((batch) => !batch.archived) });
            if (body.action === "begin") {
                assert.equal(body.printerName, printerName, "explicitly selected queue, never the unrelated Windows default");
                assert.equal(body.totalLabels, labelCount);
                batches.set(body.batchId, { ok: true, batchId: body.batchId, state: "staging", nextSequence: 1, stagedBytes: 0, stagedLabels: 0, totalLabels: body.totalLabels, jobId: null, printerName, documentName: body.documentName, updatedAt: new Date().toISOString() });
            }
            const batch = batches.get(body.batchId);
            assert.ok(batch, "known batch ID");
            if (body.action === "append") {
                assert.ok(Number.isSafeInteger(body.labelCount) && body.labelCount > 0, "descending chunks still have positive counts");
                assert.equal(commits, 0, "all labels must stage before any commit");
                assert.equal(body.sequence, batch.nextSequence);
                const payload = Buffer.from(body.payloadBase64, "base64");
                chunks.push(payload);
                batch.nextSequence++; batch.stagedBytes += payload.length; batch.stagedLabels += body.labelCount;
            }
            if (body.action === "commit") {
                assert.equal(batch.stagedLabels, labelCount);
                assert.equal(body.totalChunks, chunks.length);
                assert.equal(body.totalBytes, batch.stagedBytes);
                if (batch.state !== "spool-accepted") commits++;
                batch.state = "spool-accepted"; batch.jobId = 817;
            }
            if (body.action === "cancel") batch.state = "cancelled";
            if (body.action === "reconcile") {
                assert.equal(body.acknowledgePrinterCleared, true);
                assert.equal(body.resolution, "do-not-reprint");
                assert.equal(batch.state, "uncertain");
                if (batch.spoolStatus?.exists) return send({ ok: false, error: "Resolve the pending Windows job first." }, 409);
                batch.state = "cancelled";
            }
            if (body.action === "status" && batch.jobId) batch.spoolStatus = { exists: true, state: "printing", statusText: "Printing (mock only)" };
            return send(batch);
        } catch (error) { return send({ ok: false, error: error.message }, 500); }
    });
    await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const connectorOrigin = `http://127.0.0.1:${mock.address().port}`;
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    server = spawn("node", [path.join(web, "server.js")], { cwd: web, windowsHide: true,
        env: { ...process.env, NODE_PATH: path.join(web, "standalone_modules"), PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", NEXTWAVES_DEPLOYMENT_MODE: "desktop", NEXTWAVES_SERVER_TCP: "disabled", NEXTWAVES_INTEGRATION_API_KEY: "", NEXTWAVES_DATA_DIR: path.join(output, "server-data") }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", (data) => { serverLog += data; }); server.stderr.on("data", (data) => { serverLog += data; });
    await poll(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, "Packaged server not ready");
    await app.whenReady();
    win = new BrowserWindow({ show: false, width: 1480, height: 1100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url.startsWith(origin + "/") || details.url.startsWith(connectorOrigin + "/") || /^(blob:|data:|devtools:)/.test(details.url)) }));
    const js = (code) => win.webContents.executeJavaScript(code, true);
    await win.loadURL(origin);
    await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc, step: "print", hasDoc: true }))}); localStorage.setItem('zbre.print.printer.v1', ${JSON.stringify(JSON.stringify({ connectionMode: "windowsRaw", printerName: "", printAgentUrl: connectorOrigin, language: "zpl" }))});`);
    await win.loadURL(origin);
    await poll(() => js(`document.querySelector('select[aria-label="Windows printer"]')?.options.length === 4`), "Windows queues should load without a saved printer");
    assert.equal(await js(`document.querySelector('select[aria-label="Windows printer"]').value`), "", "do not auto-select Office PDF");
    assert.equal(await js(`!!document.querySelector('[data-testid="tcp-recovery"]')`), false);
    await js(`(() => { const select = document.querySelector('select[aria-label="Windows printer"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(printerName)}); select.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await poll(() => js(`document.querySelector('select[aria-label="Windows printer"]').value === ${JSON.stringify(printerName)}`), "Printer selection not saved");
    assert.equal(await js(`document.querySelector('[data-testid="print-history"]').open`), false, "history stays closed during normal use");
    if (reverse) {
        await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'From–To')`), "From–To button missing");
        await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'From–To').click()`);
        await poll(() => js(`!!document.querySelector('input[aria-label="From"]')`), "Range inputs missing");
        for (const [name, value] of [["From", fromRow], ["To", toRow]]) {
            await js(`(() => {
                const input = document.querySelector('input[aria-label="${name}"]');
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'${value}');
                input.dispatchEvent(new Event('input',{bubbles:true}));
            })()`);
        }
        await poll(() => js(`document.querySelector('[data-testid="print-range-summary"]').textContent.includes('601 labels')`), "Descending quantity is wrong");
        assert.deepEqual(await js(`[...document.querySelectorAll('[data-testid="print-data-rows"] [data-row-index]')].slice(0,3).map(e=>Number(e.dataset.rowIndex)+1)`), [2350,2349,2348]);
        await poll(() => js(`!!document.querySelector('[data-testid="print-preview-card"] canvas[data-copy-index="2349"]')`), "Preview must start at From");
        await js(`document.querySelector('[data-row-index="2348"]').click()`);
        await poll(() => js(`!!document.querySelector('[data-testid="print-preview-card"] canvas[data-copy-index="2348"]')`), "Row selection preview mismatch");
        await js(`[...document.querySelectorAll('button')].find(b => b.innerText.startsWith('Roll (')).click()`);
        await poll(() => js(`document.querySelectorAll('canvas[data-copy-index]').length === 50`), "Roll preview not ready");
        assert.deepEqual(await js(`[...document.querySelectorAll('canvas[data-copy-index]')].slice(0,3).map(e=>Number(e.dataset.copyIndex)+1)`), [2350,2349,2348]);
        await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Single').click()`);
    }
    await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'Print ${labelCount} labels' && !b.disabled)`), "Print batch button unavailable");
    await installPairCapture(win, doc);
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Print ${labelCount} labels').click()`);
    await poll(async () => {
        const text = await js("document.body.innerText");
        if (text.includes("Could not queue the labels") || text.includes("An earlier job needs attention")) throw new Error(text);
        return text.includes(`Queued ${labelCount} labels for`);
    }, "Staged print did not finish");
    assert.equal(commits, 1);
    assert.ok(chunks.length >= 3, "RFID batch crosses multiple preparation chunks");
    const zpl = Buffer.concat(chunks).toString("utf8");
    const epcs = [...zpl.matchAll(/\^RFW,H,,,A\^FD([0-9A-F]+)\^FS/g)].map((match) => match[1]);
    assert.deepEqual(epcs, expectedRows.map(row => doc.dataFeed.rows[row-1].cells.epc), "rendered HEX order and leading zeros");
    const capturedPairs = await js("window.__labelPairingQA");
    console.log("Pairing capture:", await js("window.__labelPairingQAStats"));
    assertLabelPairs(zpl, expectedRows, capturedPairs);
    if (!reverse) assertDetectsReportedJump(zpl, expectedRows, capturedPairs);
    if (reverse) assert.equal(chunks.length, 61, "601 RFID labels cross 61 preparation chunks");
    await poll(() => js(`document.body.textContent.includes('Windows job 817')`), "Saved job history missing");
    assert.equal(await js(`document.querySelector('[data-testid="print-history"]').open`), false, "normal submission must not open history");
    await js(`document.querySelector('[data-testid="print-settings-card"]').scrollIntoView({block:'start'})`);
    fs.writeFileSync(path.join(output, "simple-print.png"), (await win.webContents.capturePage()).toPNG());
    await js(`document.querySelector('[data-testid="print-history"]').open = true`);
    await js(`document.querySelector('[data-testid="print-history"]').scrollIntoView({block:'center'})`);
    await wait(300);
    fs.writeFileSync(path.join(output, "spool-batch.png"), (await win.webContents.capturePage()).toPNG());
    await js("document.documentElement.classList.remove('dark')");
    await wait(300);
    fs.writeFileSync(path.join(output, "spool-batch-light.png"), (await win.webContents.capturePage()).toPNG());
    const archivedId = "qa-archived-failed";
    batches.set(archivedId, { ...[...batches.values()][0], batchId: archivedId, documentName: "Archived failed QA", state: "failed", jobId: null, archived: true });
    await js(`localStorage.setItem('zbre.pending-spool-batches.v1', ${JSON.stringify(JSON.stringify([{ batchId: archivedId, agentUrl: connectorOrigin, printerName }]))})`);
    await poll(() => js("document.body.textContent.includes('Archived failed QA')"), "Archived pending failure became unreachable");
    await js(`[...document.querySelectorAll('span')].find(s => s.textContent === 'Archived failed QA').closest('div.rounded-lg').querySelectorAll('button')[1].click()`);
    await poll(() => batches.get(archivedId).state === "cancelled", "Archived unsent failure could not be dismissed");
    assert.equal(commits, 1, "recovering archived history must not print again");
    const interruptedId = "qa-interrupted-submission";
    batches.set(interruptedId, { ...[...batches.values()][0], batchId: interruptedId, documentName: "Interrupted QA", state: "uncertain", spoolStatus: { exists: true }, archived: false });
    await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'Labels checked — close without reprinting')`), "Interrupted submission action missing");
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Labels checked — close without reprinting').click()`);
    await poll(() => js(`document.body.innerText.includes('Resolve the pending Windows job first.')`), "Active Windows job must remain protected");
    assert.equal(batches.get(interruptedId).state, "uncertain");
    batches.get(interruptedId).spoolStatus = { exists: false };
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Labels checked — close without reprinting').click()`);
    await poll(() => batches.get(interruptedId).state === "cancelled", "Confirmed interruption could not be closed");
    assert.equal(commits, 1, "closing an interruption must never reprint");
    if (reverse) {
        const exportPath = path.join(output, "descending.zpl");
        const downloaded = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("ZPL download timed out")), 120_000);
            win.webContents.session.once("will-download", (_event, item) => {
                item.setSavePath(exportPath);
                item.once("done", (_event, state) => {
                    clearTimeout(timeout);
                    return state === "completed" ? resolve() : reject(new Error(`ZPL download ${state}`));
                });
            });
        });
        await js(`[...document.querySelectorAll('summary')].find(s => s.textContent === 'More actions').parentElement.open = true;
            [...document.querySelectorAll('button')].find(b => b.innerText === 'Download .zpl').click();`);
        await downloaded;
        const exportedHex = [...fs.readFileSync(exportPath, "utf8").matchAll(/\^RFW,H,,,A\^FD([0-9A-F]+)\^FS/g)].map(match => match[1]);
        assert.deepEqual(exportedHex, epcs, "downloaded ZPL and Windows spool must use the same descending order");
        assert.equal(commits, 1, "export must not create a Windows job");
    }
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ printerName, explicitQueueSelection: true, unrelatedDefaultNotSelected: true, historyCollapsed: true, interruptedRecoveryNoReplay: true, fromRow, toRow, labels: epcs.length, textBitmapEpcPairsChecked: expectedRows.length, detects1337TextSwappedWith1441: !reverse, chunks: chunks.length, windowsJobs: commits, payloadBytes: Buffer.byteLength(zpl), hardwarePrinting: false }, null, 2));
    console.log(`Packaged staged-spool UI passed: ${labelCount} ordered HEX labels, ${chunks.length} chunks, one mock Windows job, recovery panel visible.`);
}
function close(code) { if (win) win.destroy(); if (server) server.kill(); if (mock) mock.close(); app.exit(code); }
main().then(() => close(0)).catch((error) => { console.error(error, serverLog); close(1); });
