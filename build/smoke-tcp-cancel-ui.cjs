const { resolveWebSource } = require("../scripts/web-source.cjs");
// Packaged renderer only, private connector mock, all real printer endpoints blocked.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), http = require("node:http");
const net = require("node:net"), Module = require("node:module"), assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { addPairingText, installPairCapture, assertLabelPairs } = require("./label-pairing-qa.cjs");
const root = path.resolve(__dirname, ".."), web = path.join(root, "dist/win-unpacked/resources/web");
const output = path.join(root, "build/tcp-cancel-qa");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(output, "profile-")));
let win, server, mock, serverLog = "", current, scenario = "large", releaseOpen, releaseAppend;
const jobs = [], events = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, message) {
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) { if (await fn()) return; await wait(100); }
    if (win && !win.isDestroyed()) {
        fs.writeFileSync(path.join(output, "failure.txt"), await win.webContents.executeJavaScript("document.body.innerText"));
        fs.writeFileSync(path.join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
    }
    throw new Error(message);
}
async function freePort() {
    return new Promise(resolve => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => {
        const port = probe.address().port; probe.close(() => resolve(port));
    }); });
}
function receipt(job) {
    return { ok: true, jobId: job.id, host: "192.168.50.2", port: 9100, state: job.state,
        nextSequence: job.sequence, cumulativeBytes: job.bytes, checkpointHash: `checkpoint-${job.sequence - 1}`,
        reconciled: job.reconciled || false };
}
async function main() {
    const fixturePath = path.join(resolveWebSource(), "scripts", "test-print-calibration.cjs");
    const fixture = new Module(fixturePath, module);
    fixture.filename = fixturePath; fixture.paths = Module._nodeModulePaths(path.dirname(fixturePath));
    fixture._compile(fs.readFileSync(fixturePath, "utf8") + "\nmodule.exports = { doc };", fixturePath);
    const doc = structuredClone(fixture.exports.doc);
    doc.settings.rfid.captureToHost = false;
    addPairingText(doc);
    doc.id = "tcp-cancel-qa"; doc.name = "Cancel 2000 after 400"; doc.settings.copies = 2000;
    doc.settings.targetPrinterModel = "zd621r";
    Object.assign(doc.settings.rfid, { enabled: true, data: "{RFID}", zebraModel: "zd621r", zebraUsePrinterSettings: true });
    doc.dataFeed.rows = Array.from({ length: 2000 }, (_, i) => ({ id: `row${i+1}`, cells: { epc: (i+1).toString(16).padStart(24,"0").toUpperCase() } }));
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
            const body = JSON.parse(raw);
            if (body.action === "roll-list") return send({ ok: true, rolls: [] });
            if (body.action === "spool-list") return send({ ok: true, jobs: [] });
            events.push({ action: body.action, jobId: body.jobId });
            if (body.action === "open") {
                assert.ok(!current || ["finished", "aborted"].includes(current.state) || current.reconciled, "previous job resolved before next admission");
                current = { id: body.jobId, mode: scenario, state: "open", sequence: 1, bytes: 0,
                    printed: 0, buffered: 0, paused: false, clears: 0, emptyReads: 0, pauseQueries: 0, chunks: [] };
                jobs.push(current);
                if (scenario === "opening") await new Promise(resolve => { releaseOpen = resolve; });
            }
            const job = jobs.find(item => item.id === body.jobId);
            assert.ok(job, "known job identity");
            if (body.action === "append") {
                assert.equal(job.state, "open");
                assert.equal(body.sequence, job.sequence);
                const payload = Buffer.from(body.payloadBase64, "base64");
                const command = payload.toString().trim();
                if (command === "~JA") {
                    assert.equal(releaseAppend, undefined, "clear must wait for the pending label response");
                    job.clears++; job.buffered = 0;
                    assert.equal(job.clears, 1, "clear checkpoint must not be replayed to the printer");
                } else {
                    assert.equal(job.paused, false, "no label payload during Pause");
                    assert.equal(job.clears, 0, "no labels after clear");
                    assert.ok(!command.includes("~PS"), "never Resume automatically");
                    job.chunks.push(payload);
                    job.buffered += [...command.matchAll(/\^RFW,H[^\^]*\^FD([0-9A-F]+)\^FS/g)].length;
                    assert.ok(job.buffered <= 40, "bounded label lookahead");
                }
                job.sequence++; job.bytes += payload.length;
                if (job.mode === "inflight" && job.chunks.length === 2 && !job.clears)
                    await new Promise(resolve => { releaseAppend = () => { releaseAppend = undefined; resolve(); }; });
                return send({ ...receipt(job), bytesWritten: payload.length, payloadSha256: body.payloadSha256 });
            }
            if (body.action === "query") {
                const command = Buffer.from(body.payloadBase64, "base64").toString().trim();
                if (command === "~HQES") {
                    if (job.mode === "clear-failure" && job.chunks.length >= 2) job.paused = true;
                    if (job.paused) job.pauseQueries++;
                    return send({ ...receipt(job), response: `\x02\r\nPRINTER STATUS\r\nERRORS: ${job.paused ? "1 00000000 00010000" : "0 00000000 00000000"}\r\nWARNINGS: 0 00000000 00000000\r\n\x03\r\n` });
                }
                assert.equal(command, "~HS");
                if (job.mode === "clear-failure" && job.clears) return send({ ok: false, code: "TCP_JOB_QUERY_FAILED", outcome: "possibly_sent", error: "Lost printer connection after Cancel" }, 502);
                if (!job.paused && !job.clears) {
                    const consumed = Math.min(job.buffered, 3, job.mode === "large" ? 400 - job.printed : Infinity);
                    job.buffered -= consumed; job.printed += consumed;
                    if (job.mode === "large" && job.printed === 400) job.paused = true;
                }
                if (!job.buffered && job.clears) job.emptyReads++;
                return send({ ...receipt(job), response: `\x02000,0,${+job.paused},0251,${String(job.buffered).padStart(3,"0")},0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,1,2,6,0,${String(job.buffered).padStart(8,"0")},1,001\x03\r\n\x021234,1\x03\r\n` });
            }
            if (body.action === "finish") {
                assert.equal(job.buffered, 0);
                if (job.clears) assert.ok(job.emptyReads >= 2);
                else assert.equal(job.paused, false);
                assert.equal(body.expectedBytes, job.bytes);
                assert.equal(body.expectedSequence, job.sequence - 1);
                assert.equal(body.checkpointHash, receipt(job).checkpointHash);
                job.state = "finished";
            }
            if (body.action === "abort") job.state = job.chunks.length ? "uncertain" : "aborted";
            if (body.action === "reconcile") {
                assert.equal(body.confirmed, true); assert.equal(job.buffered, 0);
                job.reconciled = true;
            }
            return send(receipt(job));
        } catch (error) { return send({ ok: false, error: error.message }, 400); }
    });
    await new Promise(resolve => mock.listen(0, "127.0.0.1", resolve));
    const connectorOrigin = `http://127.0.0.1:${mock.address().port}`;
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    server = spawn("node", [path.join(web,"server.js")], { cwd: web, windowsHide: true,
        env: { ...process.env, NODE_PATH: path.join(web,"standalone_modules"), PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", NEXTWAVES_DEPLOYMENT_MODE: "desktop", NEXTWAVES_SERVER_TCP: "disabled", NEXTWAVES_DATA_DIR: path.join(output,"server-data") }, stdio: ["ignore","pipe","pipe"] });
    server.stdout.on("data", data => { serverLog += data; }); server.stderr.on("data", data => { serverLog += data; });
    await poll(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, "Packaged server not ready");
    await app.whenReady();
    win = new BrowserWindow({ show: false, width: 1480, height: 1100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url.startsWith(origin + "/") || details.url.startsWith(connectorOrigin + "/") || /^(blob:|data:|devtools:)/.test(details.url)) }));
    const js = code => win.webContents.executeJavaScript(code, true);
    const click = text => js(`[...document.querySelectorAll('button')].find(b => b.innerText === ${JSON.stringify(text)}).click()`);
    const setRange = async (from, to) => {
        await click("From–To");
        await poll(() => js(`!!document.querySelector('input[aria-label="From"]')`), "Range inputs missing");
        for (const [name, value] of [["From",from],["To",to]]) await js(`(() => { const el = document.querySelector('input[aria-label="${name}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'${value}'); el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'Print ${Math.abs(from-to)+1} labels' && !b.disabled)`), "Range not ready");
    };
    await win.loadURL(origin);
    await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc, step:"print", hasDoc:true }))}); localStorage.setItem('zbre.print.printer.v1', ${JSON.stringify(JSON.stringify({ connectionMode:"tcp", tcpHost:"192.168.50.2", tcpPort:9100, tcpExecutionMode:"connector", printAgentUrl:connectorOrigin, language:"zpl" }))});`);
    await win.loadURL(origin);
    await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'Print 2000 labels' && !b.disabled)`), "Print 2000 unavailable");
    await installPairCapture(win, doc);
    await click("Print 2000 labels");
    await poll(async () => current?.printed === 400 && current.paused && await js(`!!document.querySelector('[data-testid="printer-pause-notice"]')`), "Did not Pause after 400 physical labels");
    const large = current, submittedChunks = large.chunks.length;
    large.buffered = 0; // Operator held X on printer: never infer app Cancel from this.
    const pauses = large.pauseQueries;
    await poll(() => large.pauseQueries >= pauses + 2, "Hardware X incorrectly stopped Pause polling");
    assert.equal(large.chunks.length, submittedChunks); assert.equal(large.clears, 0);
    await click("Cancel batch");
    await poll(() => js(`document.body.innerText.includes('Batch cancelled. Unsent labels were discarded')`), "App Cancel did not finish");
    assert.equal(large.printed,400); assert.equal(large.paused,true); assert.equal(large.clears,1);
    assert.equal(large.chunks.length, submittedChunks);
    const submittedZpl = Buffer.concat(large.chunks).toString();
    const submittedCount = [...submittedZpl.matchAll(/\^RFW,H[^\^]*\^FD([0-9A-F]+)\^FS/g)].length;
    assert.ok(submittedCount >= 400 && submittedCount < 2000);
    assertLabelPairs(submittedZpl, Array.from({length:submittedCount},(_,i)=>i+1), await js("window.__labelPairingQA"));
    await js(`document.querySelector('[data-testid="print-settings-card"]').scrollIntoView({block:'end'})`);
    fs.writeFileSync(path.join(output,"cancelled-2000-after-400.png"), (await win.webContents.capturePage()).toPNG());
    large.paused = false; await wait(300); assert.equal(large.chunks.length, submittedChunks, "Resume after Cancel must not continue old batch");
    scenario = "new-range"; await setRange(401,410); await click("Print 10 labels");
    await poll(() => js(`document.body.innerText.includes('Sent 10 labels to')`), "New range did not print");
    assert.notEqual(current.id, large.id);
    assertLabelPairs(Buffer.concat(current.chunks).toString(), Array.from({length:10},(_,i)=>401+i), await js("window.__labelPairingQA"));

    scenario = "inflight"; await setRange(1,2000); await click("Print 2000 labels");
    await poll(() => !!releaseAppend, "Second label response not held");
    const inflight = current; await click("Cancel batch"); await wait(300);
    assert.equal(inflight.clears,0); assert.equal(inflight.chunks.length,2);
    releaseAppend();
    await poll(() => js(`document.body.innerText.includes('Batch cancelled. Unsent labels were discarded')`), "In-flight cancel did not finish");
    assert.equal(inflight.chunks.length,2); assert.equal(inflight.clears,1);

    scenario = "opening"; await click("Print 2000 labels");
    await poll(() => !!releaseOpen, "Open was not held");
    const opening = current; await click("Cancel batch"); releaseOpen(); releaseOpen = undefined;
    await poll(() => js(`document.body.innerText.includes('Batch cancelled before sending labels')`), "Cancel before labels failed");
    assert.equal(opening.chunks.length,0); assert.equal(opening.clears,0); assert.equal(opening.state,"aborted");

    scenario = "clear-failure"; await click("Print 2000 labels");
    await poll(async () => current?.paused && await js(`!!document.querySelector('[data-testid="printer-pause-notice"]')`), "Failure scenario not paused");
    const uncertain = current; await click("Cancel batch");
    await poll(() => js(`document.body.innerText.includes('Pause / buffer clear could not be confirmed')`), "Lost clear status misreported as cancelled");
    assert.equal(uncertain.state,"uncertain");
    assert.equal(await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Print 2000 labels').disabled`),true);
    assert.equal(await js(`document.querySelector('[data-testid="tcp-recovery"]').innerText.includes('hold CANCEL (X)')`),true);
    const chunkCount = uncertain.chunks.length;
    uncertain.buffered = 0; // Explicit physical clearance before acknowledgement.
    await js(`document.querySelector('[data-testid="tcp-recovery"] button').click()`);
    await poll(() => js(`!document.querySelector('[data-testid="tcp-recovery"]')`), "Manual clear recovery failed");
    assert.equal(uncertain.reconciled,true); assert.equal(uncertain.chunks.length,chunkCount);
    fs.writeFileSync(path.join(output,"result.json"), JSON.stringify({ requested:2000, physicalPrintedBeforeCancel:400, submittedBeforeCancel:submittedCount, hardwareXDoesNotImplyAppCancel:true, cancelPreservesPause:true, newRange:[401,410], cancelledDuringWrite:true, cancelledBeforeFirstLabel:true, clearFailureBlocksNewPrint:true, manualClearDoesNotReprint:true, hardwarePrinting:false },null,2));
    console.log("Packaged TCP cancellation passed: 2000/400, hardware X vs Pause, same-session clear, new range, in-flight write, pre-write cancellation and failed-clear recovery.");
}
function close(code) { if(win)win.destroy(); if(server)server.kill(); if(mock)mock.close(); app.exit(code); }
main().then(()=>close(0)).catch(error=>{ console.error(error,serverLog); close(1); });
