const { resolveWebSource } = require("../scripts/web-source.cjs");
// Exercises the packaged renderer with a private mock connector. All other
// network destinations are blocked; this test cannot submit hardware prints.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const net = require("node:net");
const Module = require("node:module");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { addPairingText, installPairCapture, assertLabelPairs } = require("./label-pairing-qa.cjs");
const root = path.resolve(__dirname, "..");
const web = path.join(root, "dist/win-unpacked/resources/web");
const output = path.join(root, "build/tcp-pause-qa");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(output, "profile-")));
let win, server, mock, serverLog = "";
const chunks = [], actions = [];
let paused = false, drainPolls = 0, cumulativeBytes = 0, pauseQueries = 0;
let snapshot, failQuery = false;
let pollErrorCode = "";
let continuous = false, bufferedLabels = 0, maxBufferedLabels = 0, nonemptyRefills = 0;
const continuousChunks = [];
let staticMode = false;
const staticWindows = [], staticChunks = [];
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, message) {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) { if (await fn()) return; await wait(100); }
    if (win && !win.isDestroyed()) {
        fs.writeFileSync(path.join(output, "failure.txt"), await win.webContents.executeJavaScript("document.body.innerText"));
        fs.writeFileSync(path.join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
    }
    throw new Error(message);
}
async function freePort() {
    return new Promise(resolve => {
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
    doc.settings.rfid.captureToHost = false;
    addPairingText(doc);
    doc.settings.targetPrinterModel = "zd621r";
    doc.id = "tcp-pause-qa"; doc.name = "TCP Pause Resume QA"; doc.settings.copies = 2500;
    Object.assign(doc.settings.rfid, { enabled: true, data: "{RFID}", zebraModel: "zd621r", zebraUsePrinterSettings: true });
    doc.dataFeed.rows = Array.from({ length: 2500 }, (_, i) => ({ id: `row${i + 1}`, cells: { epc: (i + 1).toString(16).padStart(24, "0").toUpperCase() } }));
    mock = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Private-Network", "true");
        res.setHeader("Content-Type", "application/json");
        const send = (data, status = 200) => { res.writeHead(status); res.end(JSON.stringify(data)); };
        if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
        if (req.url === "/v1/health") return send({ ok: true, name: "Nextwaves Zebra Local Print Connector", version: "0.5.2", tcp: true, capabilities: { tcpJobV1: true, tcpJobIdempotencyV1: true, tcpJobReconcileV1: true, printerTargetQueueV1: true } });
        if (req.url !== "/v1/tcp/job") return send({ ok: false, error: "Unexpected endpoint" }, 400);
        try {
            let raw = ""; for await (const piece of req) raw += piece;
            const body = JSON.parse(raw); actions.push(body.action);
            if (body.action === "roll-list") return send({ ok: true, rolls: [] });
            if (body.action === "spool-list") return send({ ok: true, jobs: [] });
            if (body.action === "poll" && pollErrorCode) return send({ ok: false, code: pollErrorCode, error: "Simulated unavailable receipt" }, 404);
            if (body.action === "open") {
                cumulativeBytes = 0;
                snapshot = { ok: true, jobId: body.jobId, host: body.host, port: body.port, state: "open", nextSequence: 1, cumulativeBytes: 0, checkpointHash: "seed" };
            }
            assert.equal(body.jobId, snapshot.jobId, "one job identity throughout pause/resume");
            if (body.action === "append") {
                assert.equal(paused, false, "must not append while paused");
                assert.equal(body.sequence, snapshot.nextSequence, "no chunk replay");
                const payload = Buffer.from(body.payloadBase64, "base64");
                chunks.push(payload); cumulativeBytes += payload.length;
                if (staticMode) {
                    const pq = payload.toString().match(/\^PQ(\d+)/);
                    assert.ok(pq, "one printer repeat window per checkpoint");
                    staticWindows.push(Number(pq[1])); staticChunks.push(payload);
                    assert.ok(staticWindows.length <= 3, "bounded PQ format queue including active format");
                }
                if (continuous) {
                    if (bufferedLabels > 0) nonemptyRefills++;
                    const labels = [...payload.toString().matchAll(/\^RFW,H[^\^]*\^FD([0-9A-F]+)\^FS/g)];
                    bufferedLabels += labels.length;
                    maxBufferedLabels = Math.max(maxBufferedLabels, bufferedLabels);
                    assert.ok(bufferedLabels <= 40, "bounded printer lookahead");
                    continuousChunks.push(payload);
                }
                snapshot.nextSequence++; snapshot.cumulativeBytes = cumulativeBytes;
                snapshot.checkpointHash = `checkpoint-${body.sequence}`;
                if (!staticMode && (continuous ? body.sequence === 12 : body.sequence === 3 || body.sequence === 6)) paused = true;
                return send({ ...snapshot, bytesWritten: payload.length, payloadSha256: body.payloadSha256 });
            }
            if (body.action === "query") {
                if (failQuery && snapshot.nextSequence > 3) return send({ ok: false, error: "Simulated cable disconnected", outcome: "possibly_sent", code: "TCP_JOB_QUERY_FAILED" }, 502);
                const command = Buffer.from(body.payloadBase64, "base64").toString().trim();
                if (command === "~HQES") {
                    if (paused) pauseQueries++;
                    return send({ ...snapshot, response: `\x02\r\nPRINTER STATUS\r\nERRORS: ${paused ? "1 00000000 00010000" : "0 00000000 00000000"}\r\nWARNINGS: 0 00000000 00000000\r\n\x03\r\n` });
                }
                assert.equal(command, "~HS");
                const busy = drainPolls > 0; if (busy) drainPolls--;
                const remaining = staticMode ? staticWindows[0] || 0 : continuous ? bufferedLabels : busy ? 3 : 0;
                const formats = staticMode ? Math.max(0, staticWindows.length - 1) : remaining;
                if (staticMode && staticWindows.length) {
                    staticWindows[0] -= 25;
                    if (staticWindows[0] <= 0) staticWindows.shift();
                }
                if (continuous) bufferedLabels = Math.max(0, bufferedLabels - 3);
                return send({ ...snapshot, response: `\x02000,0,0,0251,${String(formats).padStart(3, "0")},0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,1,2,6,0,${String(remaining).padStart(8, "0")},1,001\x03\r\n\x021234,1\x03\r\n` });
            }
            if (body.action === "finish") {
                assert.equal(paused, false); assert.equal(drainPolls, 0);
                assert.equal(bufferedLabels, 0, "finish must wait for the entire queue");
                assert.equal(staticWindows.length, 0, "finish must wait for all PQ copies");
                assert.equal(body.expectedBytes, cumulativeBytes);
                assert.equal(body.expectedSequence, snapshot.nextSequence - 1);
                snapshot.state = "finished";
            }
            if (body.action === "abort") snapshot.state = "uncertain";
            if (body.action === "reconcile") {
                assert.equal(body.confirmed, true);
                assert.equal(body.expectedSequence, snapshot.nextSequence - 1);
                assert.equal(body.checkpointHash, snapshot.checkpointHash);
                snapshot.reconciled = true;
            }
            send(snapshot);
        } catch (error) { send({ ok: false, error: error.message }, 400); }
    });
    await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
    const connectorOrigin = `http://127.0.0.1:${mock.address().port}`;
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    server = spawn("node", [path.join(web, "server.js")], { cwd: web, windowsHide: true,
        env: { ...process.env, NODE_PATH: path.join(web, "standalone_modules"), PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", NEXTWAVES_DEPLOYMENT_MODE: "desktop", NEXTWAVES_SERVER_TCP: "disabled", NEXTWAVES_INTEGRATION_API_KEY: "", NEXTWAVES_DATA_DIR: path.join(output, "server-data") }, stdio: ["ignore", "pipe", "pipe"] });
    server.stdout.on("data", data => { serverLog += data; }); server.stderr.on("data", data => { serverLog += data; });
    await poll(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, "Packaged server not ready");
    await app.whenReady();
    win = new BrowserWindow({ show: false, width: 1480, height: 1100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url.startsWith(origin + "/") || details.url.startsWith(connectorOrigin + "/") || /^(blob:|data:|devtools:)/.test(details.url)) }));
    const js = code => win.webContents.executeJavaScript(code, true);
    const setInput = (selector, value) => js(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(value))}); input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await win.loadURL(origin);
    await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc, step: "print", hasDoc: true }))}); localStorage.setItem('zbre.print.printer.v1', ${JSON.stringify(JSON.stringify({ connectionMode: "tcp", tcpHost: "192.168.50.2", tcpPort: 9100, tcpExecutionMode: "connector", printAgentUrl: connectorOrigin, language: "zpl" }))});`);
    await win.loadURL(origin);
    await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'From–To')`), "Range control missing");
    assert.equal(await js(`!!document.querySelector('[data-testid="tcp-recovery"]')`), false, "no recovery form during normal printing");
    assert.equal(await js(`document.querySelector('select[aria-label="Print connection"]').value`), "tcp", "existing TCP choice must not silently switch to USB");
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'From–To').click()`);
    await poll(() => js(`!!document.querySelector('input[aria-label="From"]')`), "Range inputs missing");
    await setInput('input[aria-label="From"]', 2500); await setInput('input[aria-label="To"]', 2450);
    await installPairCapture(win, doc);
    await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'Print 51 labels' && !b.disabled)`), "Print 51 unavailable");
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Print 51 labels').click()`);
    for (const chunkNumber of [3, 6]) {
        await poll(async () => chunks.length === chunkNumber && await js(`document.body.innerText.includes('Printer paused — waiting for Resume')`), `Pause at chunk ${chunkNumber} missing`);
        const count = pauseQueries;
        await poll(() => pauseQueries >= count + 2, "Paused job did not keep polling");
        assert.equal(chunks.length, chunkNumber); assert.equal(actions.includes("abort"), false); assert.equal(actions.includes("finish"), false);
        assert.equal(await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Print 51 labels').disabled`), true);
        await js(`document.querySelector('[data-testid="printer-pause-notice"]').scrollIntoView({block:'center'})`);
        fs.writeFileSync(path.join(output, `paused-chunk-${chunkNumber}.png`), (await win.webContents.capturePage()).toPNG());
        drainPolls = 2; paused = false;
    }
    await poll(() => js(`document.body.innerText.includes('Sent 51 labels to')`), "Job failed to complete after Resume");
    const generatedZpl = Buffer.concat(chunks).toString();
    const initialCapturedPairs = await js("window.__labelPairingQA");
    fs.writeFileSync(path.join(output, "descending.zpl"), generatedZpl);
    const epcs = [...generatedZpl.matchAll(/\^RFW,H[^\^]*\^FD([0-9A-F]+)\^FS/g)].map(match => match[1]);
    assert.deepEqual(epcs, Array.from({ length: 51 }, (_, i) => doc.dataFeed.rows[2499-i].cells.epc));
    assert.equal(new Set(epcs).size, 51); assert.equal(actions.filter(a => a === "open").length, 1);
    assert.equal(actions.filter(a => a === "finish").length, 1); assert.equal(actions.includes("abort"), false);
    // A real query failure must stop, expose reconciliation, and never replay.
    failQuery = true;
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Print 51 labels').click()`);
    await poll(() => js(`document.body.textContent.includes('physical completion is unverified')`), "Query failure misclassified");
    const sentAfterFailure = chunks.length;
    assert.equal(sentAfterFailure, 9); assert.equal(actions.filter(a => a === "abort").length, 1);
    assert.equal(await js(`document.body.textContent.includes('earlier labels 2500–2481 is also unverified')`), true, "failure must cover earlier buffered chunks");
    assert.equal(await js(`document.querySelectorAll('[data-testid="tcp-recovery"] input').length`), 0, "no ID, note or checkbox needed");
    const recoveryKey = await js(`Object.keys(localStorage).find(key => key.startsWith('zbre.tcp-recovery.v1:'))`);
    const recoveryJob = await js(`localStorage.getItem(${JSON.stringify(recoveryKey)})`);
    await win.loadURL(origin);
    await poll(() => js(`!!document.querySelector('[data-testid="tcp-recovery"] button')`), "Interrupted job must remain recoverable after reload");
    await js(`document.querySelector('[data-testid="tcp-recovery"] button').click()`);
    await poll(() => js(`document.body.innerText.includes('Đã giải phóng khóa phiên truyền')`), "Recovery did not finish");
    assert.equal(await js(`Object.keys(localStorage).some(key => key.startsWith('zbre.tcp-recovery.v1:'))`), false, "resolved pointer removed");
    assert.equal(await js(`!!document.querySelector('[data-testid="tcp-recovery"]')`), false, "recovery disappears when resolved");
    assert.equal(chunks.length, sentAfterFailure);
    fs.writeFileSync(path.join(output, "reconciled.png"), (await win.webContents.capturePage()).toPNG());

    // Connector receipts can expire or disappear after a restart. An explicit
    // label check may dismiss that reminder, but a generic HTTP 404 must not.
    await js(`localStorage.setItem(${JSON.stringify(recoveryKey)}, ${JSON.stringify(recoveryJob)})`);
    await win.loadURL(origin);
    await poll(() => js(`!!document.querySelector('[data-testid="tcp-recovery"] button')`), "Saved reminder missing");
    pollErrorCode = "HTTP_NOT_FOUND";
    await js(`document.querySelector('[data-testid="tcp-recovery"] button').click()`);
    await poll(() => js(`!!document.querySelector('[data-testid="tcp-recovery"] [role="alert"]')`), "Route failure must not clear recovery");
    assert.equal(await js(`localStorage.getItem(${JSON.stringify(recoveryKey)})`), recoveryJob);
    pollErrorCode = "TCP_JOB_NOT_FOUND";
    const actionsBeforeMissing = actions.length;
    await js(`document.querySelector('[data-testid="tcp-recovery"] button').click()`);
    await poll(() => js(`!document.querySelector('[data-testid="tcp-recovery"]')`), "Confirmed expired reminder was not cleared");
    assert.deepEqual(actions.slice(actionsBeforeMissing), ["poll"], "missing receipt recovery must never create or resend a job");
    assert.equal(chunks.length, sentAfterFailure);
    pollErrorCode = "";

    // Reproduce the 450-label report, with queue consumption and Pause at chunk 12.
    continuous = true; failQuery = false; paused = false; drainPolls = 0;
    await installPairCapture(win, doc);
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'From–To').click()`);
    await poll(() => js(`!!document.querySelector('input[aria-label="From"]')`), "Range inputs missing after reload");
    await setInput('input[aria-label="From"]', 2449); await setInput('input[aria-label="To"]', 2000);
    await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'Print 450 labels' && !b.disabled)`), "Print 450 unavailable");
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Print 450 labels').click()`);
    await poll(async () => continuousChunks.length === 12 && await js(`document.body.innerText.includes('Printer paused — waiting for Resume')`), "Continuous job did not pause at chunk 12");
    const pausedAt = pauseQueries, heldLabels = bufferedLabels;
    assert.ok(heldLabels > 0, "pause with several queued formats");
    await poll(() => pauseQueries >= pausedAt + 2, "Continuous pause not polled");
    assert.equal(continuousChunks.length, 12); assert.equal(bufferedLabels, heldLabels);
    fs.writeFileSync(path.join(output, "continuous-paused.png"), (await win.webContents.capturePage()).toPNG());
    paused = false;
    await poll(() => js(`document.body.innerText.includes('Sent 450 labels to')`), "450-label stream failed to finish");
    const streamZpl = Buffer.concat(continuousChunks).toString();
    const streamEpcs = [...streamZpl.matchAll(/\^RFW,H[^\^]*\^FD([0-9A-F]+)\^FS/g)].map(match => match[1]);
    assert.deepEqual(streamEpcs, Array.from({ length: 450 }, (_, i) => doc.dataFeed.rows[2448-i].cells.epc));
    const capturedPairs = await js("window.__labelPairingQA");
    console.log("Pairing capture:", await js("window.__labelPairingQAStats"));
    assertLabelPairs(generatedZpl, Array.from({ length: 51 }, (_, i) => 2500 - i), initialCapturedPairs);
    assertLabelPairs(streamZpl, Array.from({ length: 450 }, (_, i) => 2449 - i), capturedPairs);
    assert.equal(new Set(streamEpcs).size, 450); assert.equal(nonemptyRefills, 44);
    assert.equal(actions.filter(a => a === "open").length, 3);
    assert.equal(actions.filter(a => a === "finish").length, 2);
    assert.equal(actions.filter(a => a === "abort").length, 1);
    fs.writeFileSync(path.join(output, "continuous-descending.zpl"), streamZpl);
    fs.writeFileSync(path.join(output, "continuous-completed.png"), (await win.webContents.capturePage()).toPNG());

    staticMode = true; continuous = false;
    const staticDoc = structuredClone(doc);
    staticDoc.id = "static-stream-qa"; staticDoc.settings.copies = 240;
    staticDoc.elements = staticDoc.elements.filter(element => !element.id.startsWith("pair-"));
    delete staticDoc.dataFeed;
    Object.assign(staticDoc.settings.rfid, { enabled: false, readEnabled: false, data: "" });
    staticDoc.elements.forEach(element => { element.data = "STATIC"; });
    await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc: staticDoc, step: "print", hasDoc: true }))});`);
    await win.loadURL(origin);
    await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'Print 240 labels' && !b.disabled)`), "Static print unavailable");
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Print 240 labels').click()`);
    await poll(() => js(`document.body.innerText.includes('Sent 240 labels to')`), "Static PQ windows did not drain");
    const staticZpl = Buffer.concat(staticChunks).toString();
    assert.deepEqual([...staticZpl.matchAll(/\^PQ(\d+)/g)].map(match => Number(match[1])), [100, 100, 40]);
    assert.equal([...staticZpl.matchAll(/~DG/g)].length, 1);
    assert.equal([...staticZpl.matchAll(/\^XG/g)].length, 3);
    assert.equal([...staticZpl.matchAll(/\^ID/g)].length, 1);
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ recoveryAbsentNormally: true, recoverySurvivesReload: true, recoveryHasNoInputs: true, missingReceiptClearedOnlyAfterExplicitCheck: true, generic404PreservesRecovery: true, pauseRegression: { from: 2500, to: 2450, labels: epcs.length, chunks: 6, pauseAt: [3,6] }, continuous: { from: 2449, to: 2000, labels: streamEpcs.length, chunks: continuousChunks.length, pauseAt: 12, nonemptyRefills, maxBufferedLabels }, textBitmapEpcPairsChecked: 501, staticCopies: 240, pauseQueries, duplicates: 0, queryFailureStops: true, reconciliationSendsLabels: false, hardwarePrinting: false }, null, 2));
    console.log("Packaged TCP UI passed: 51-label Pause regression, queued failure/reconciliation, 450 descending EPCs, 44 refills before empty, bounded queue and no duplicates.");
}
function close(code) { if (win) win.destroy(); if (server) server.kill(); if (mock) mock.close(); app.exit(code); }
main().then(() => close(0)).catch(error => { console.error(error, serverLog); close(1); });
