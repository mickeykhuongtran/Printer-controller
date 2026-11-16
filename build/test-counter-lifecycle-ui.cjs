// Packaged connector counter ownership + renderer disclosure regression suite.
// Every TCP endpoint belongs to this computer; port 9100 and real printers are
// deliberately excluded. Evidence is written only beneath this isolated run.
// Run after packaging: npx electron build/test-counter-lifecycle-ui.cjs
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const resources = path.join(root, "dist/win-unpacked/resources");
const web = path.join(resources, "web");
const manifest = JSON.parse(fs.readFileSync(path.join(resources, "runtime-manifest.json"), "utf8"));
assert.equal(manifest.web.packageVersion, "3.7.0", "Package the counter lifecycle build before testing");
assert.equal(manifest.connector.version, "0.11.0");
const output = path.join(root, "build/counter-lifecycle-qa");
fs.mkdirSync(output, { recursive: true });
const runDir = fs.mkdtempSync(path.join(output, "run-"));
const captureRoot = path.join(runDir, "connector/rfid-sessions");
app.setPath("userData", path.join(runDir, "profile"));
const sha = value => createHash("sha256").update(value).digest("hex");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const fingerprint = sha("isolated-counter-lifecycle-test-template-v1");
const sockets = new Set(), frames = new Map(), commands = [], apiCalls = [];
let win, server, connector, printer, logs = "", simulatorFailure;
let valid = 8000, voidCount = 30, total = 8030, printerConnections = 0, resetCommands = 0;
let dropAfterRun = "", dropArmed = false, resetAfterRun = "", resetPerformed = false, serial = 0;
let resetLowObserved = false, resetRebound = 0, baselineMalformed = false;
let delayedFinalRun = "";
let origin, connectorOrigin, host, printerPort;
const panel = `document.querySelector('section[aria-label="Production roll"]')`;
const js = code => win.webContents.executeJavaScript(code, true);
function allFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory()
        ? allFiles(path.join(dir, item.name)) : [path.join(dir, item.name)]);
}
function rawHashes() {
    return Object.fromEntries(allFiles(captureRoot).filter(file => path.basename(file) === "reads.csv")
        .map(file => [path.relative(captureRoot, file), sha(fs.readFileSync(file))]));
}
function preserve(expected) {
    const current = rawHashes();
    for (const [file, hash] of Object.entries(expected)) assert.equal(current[file], hash, "Raw evidence changed: " + file);
}
function labels() { return [...frames.values()].reduce((sum, rows) => sum + rows.length, 0); }
function child(command, args, options) {
    const proc = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    proc.stdout.on("data", data => { logs += data; }); proc.stderr.on("data", data => { logs += data; });
    proc.on("error", error => { logs += String(error); });
    return proc;
}
async function poll(fn, message, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (simulatorFailure) throw simulatorFailure;
        if (await fn()) return;
        await delay(100);
    }
    throw new Error(message);
}
async function freePort() {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
async function request(body, { allowError = false, text = false } = {}) {
    apiCalls.push({ at: new Date().toISOString(), ...body });
    const response = await fetch(connectorOrigin + "/v1/tcp/job", { method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
    const bodyText = await response.text();
    if (!allowError) assert.equal(response.ok, true, body.action + ": " + bodyText);
    return { status: response.status, ok: response.ok, value: text ? bodyText : JSON.parse(bodyText), headers: Object.fromEntries(response.headers) };
}
async function action(name, data = {}, options) { return (await request({ action: name, ...data }, options)).value; }
async function createRoll(name) {
    return action("roll-create", { production: { printerHost: host, printerPort, operationMode: "read", bank: "EPC", templateFingerprint: fingerprint,
        templateName: "Counter lifecycle QA", targetLabels: 10, jobId: name } });
}
async function getRoll(rollId) { return action("roll-get", { production: { rollId } }); }
async function openRun(rollId, name, count) {
    return action("open", { jobId: name, host, port: printerPort,
        capture: { operationMode: "read", productionRollId: rollId, templateFingerprint: fingerprint, auditBatchCounters: true,
            expectedHexChars: 24, expectedLabels: count, firstRow: 1, rowStep: 1, bank: "EPC", templateName: "Counter lifecycle QA" } });
}
async function appendRun(name, count) {
    const payload = Array.from({ length: count }, (_, i) => `^XA^RS8,,,1,N^RFR,H,,,E^FN1^FS^HV1,256,NWEP|${name}|${i + 1}|,|END_0D_0A,L^FS^PQ1^XZ`).join("\r\n");
    return action("append", { jobId: name, sequence: 1, payloadBase64: Buffer.from(payload).toString("base64"), payloadSha256: sha(payload) });
}
async function finishRun(name, receipt, allowError = false) {
    return request({ action: "finish", jobId: name, expectedSequence: receipt.nextSequence - 1,
        expectedBytes: receipt.cumulativeBytes, checkpointHash: receipt.checkpointHash }, { allowError });
}
async function loseFinishResponse(name, receipt) {
    const controller = new AbortController();
    const body = { action: "finish", jobId: name, expectedSequence: receipt.nextSequence - 1,
        expectedBytes: receipt.cumulativeBytes, checkpointHash: receipt.checkpointHash };
    apiCalls.push({ ...body, qaDroppedHttpResponse: true });
    const timer = setTimeout(() => controller.abort(), 75);
    let lost = false;
    try {
        const response = await fetch(connectorOrigin + "/v1/tcp/job", { method: "POST", signal: controller.signal,
            headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) });
        await response.text();
    } catch (error) { assert.equal(error.name, "AbortError"); lost = true; }
    finally { clearTimeout(timer); }
    assert.equal(lost, true, "The test must actually lose the HTTP finish response");
    await poll(async () => (await action("poll", { jobId: name })).state === "finished", "Connector must finish after HTTP requester disappears");
    return finishRun(name, receipt);
}
async function screenshot(name) {
    await js(panel + "?.scrollIntoView({block:'start',behavior:'instant'})"); await delay(200);
    fs.writeFileSync(path.join(runDir, name + ".png"), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(runDir, name + ".txt"), await js("document.body.innerText"));
}
async function loadUI(copies = 10) {
    const doc = { id: "counter-lifecycle-qa", name: "Counter lifecycle QA", settings: { widthMm: 45, heightMm: 20, gapMm: 3, dpi: 203, targetPrinterModel: "zt610r", copies, speed: 4, darkness: 10,
        serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
        rfid: { enabled: false, readEnabled: true, captureToHost: true, readBank: "EPC", readFieldName: "rfid_read", zebraEpcReadMode: "pc", zebraModel: "zt610r", zebraUsePrinterSettings: true, chip: "epc_96", epcBits: 96, format: "H", retries: 3, block: 2, words: 6, data: "" } },
        elements: [{ id: "read-text", kind: "text", text: "{rfid_read}", pos: { x: 2, y: 2 }, size: { w: 41, h: 7 }, rotation: 0, font: "D", scaleX: 1, scaleY: 1 }] };
    await win.loadURL(origin);
    await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc, step: "print", hasDoc: true }))}); localStorage.setItem('zbre.print.printer.v1', ${JSON.stringify(JSON.stringify({ connectionMode: "tcp", tcpHost: host, tcpPort: printerPort, tcpExecutionMode: "connector", printAgentUrl: connectorOrigin, language: "zpl" }))});`);
    await win.loadURL(origin);
    await poll(() => js("!!" + panel), "Production panel did not load", 30000);
}
async function main() {
    const localAddresses = Object.values(os.networkInterfaces()).flat().filter(a => a.family === "IPv4" && !a.internal).map(a => a.address);
    host = localAddresses.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
    assert.ok(host, "A private address belonging to this computer is required");
    printer = net.createServer(socket => {
        printerConnections++; sockets.add(socket); let pending = "", outgoing = Promise.resolve();
        const send = (value, beforeDelay = 0) => { outgoing = outgoing.then(async () => { if (beforeDelay) await delay(beforeDelay); if (socket.destroyed) return; socket.write(value.slice(0, 2)); await delay(1); if (!socket.destroyed) socket.write(value.slice(2)); }); };
        const shouldDrop = command => {
            if (!dropArmed || !command.includes("odometer.rfid.void_resettable")) return false;
            dropArmed = false; commands.push("SIMULATED_DISCONNECT_AFTER_EPC");
            outgoing = outgoing.then(async () => { await delay(25); socket.destroy(); }); return true;
        };
        socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
        socket.on("data", bytes => {
            pending += bytes.toString("ascii");
            try {
                for (;;) {
                    pending = pending.replace(/^[\r\n ]+/, "");
                    if (pending.startsWith("~HQES")) {
                        pending = pending.slice(5); commands.push("~HQES"); if (shouldDrop("~HQES")) return;
                        send("\x02\r\nPRINTER STATUS\r\nERRORS: 0 00000000 00000000\r\nWARNINGS: 0 00000000 00000000\r\n\x03\r\n");
                    } else if (pending.startsWith("~HS")) {
                        pending = pending.slice(3); commands.push("~HS"); if (shouldDrop("~HS")) return;
                        send("\x02000,0,0,0251,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,1,2,6,0,00000000,1,001\x03\r\n\x021234,1\x03\r\n");
                    } else if (pending.startsWith('! U1 getvar ') && pending.includes("\n")) {
                        const end = pending.indexOf("\n") + 1, command = pending.slice(0, end); pending = pending.slice(end); commands.push(command.trim()); if (shouldDrop(command)) return;
                        const value = baselineMalformed ? "not-a-number" : command.includes("odometer.rfid.valid_resettable") ? valid : command.includes("odometer.rfid.void_resettable") ? voidCount : command.includes("odometer.total_label_count") ? total : "?";
                        send(`"${value}"\r\n`, delayedFinalRun && frames.has(delayedFinalRun) ? 200 : 0);
                        if (resetPerformed && !resetLowObserved && command.includes("odometer.rfid.valid_resettable")) { resetLowObserved = true; valid = resetRebound; }
                    } else if (pending.startsWith("! U1 setvar ")) {
                        resetCommands++; throw new Error("No application action may reset counters");
                    } else if (pending.startsWith("~JA") || pending.startsWith("~PP") || pending.startsWith("~PS")) {
                        const command = pending.slice(0, 3); commands.push(command); pending = pending.slice(3);
                    } else if (pending.startsWith("^JZN") || pending.startsWith("~JZN")) {
                        commands.push(pending.slice(0, 4)); pending = pending.slice(4);
                    } else if (pending.startsWith("^XA") && pending.includes("^XZ")) {
                        const end = pending.indexOf("^XZ") + 3, zpl = pending.slice(0, end); pending = pending.slice(end);
                        const hv = zpl.match(/\^HV1,256,NWEP\|([^|]+)\|(\d+)\|,\|END_0D_0A,L\^FS/);
                        if (!hv) { assert.match(zpl, /^\^XA\s*\^JZN\s*\^XZ$/); continue; }
                        const run = hv[1], ordinal = Number(hv[2]); if (!frames.has(run)) frames.set(run, []);
                        assert.equal(ordinal, frames.get(run).length + 1, "No print replay is allowed");
                        valid++; total++; serial++;
                        const epc = serial.toString(16).toUpperCase().padStart(24, "0"); frames.get(run).push({ ordinal, epc });
                        send(`NWEP|${run}|${ordinal}|${epc}|END\r\n`);
                        if (dropAfterRun === run && ordinal === 5) dropArmed = true;
                        if (resetAfterRun === run && ordinal === 3) { resetRebound = valid + 10; valid = 0; resetPerformed = true; }
                    } else break;
                }
            } catch (error) { simulatorFailure = error; socket.destroy(); }
        });
    });
    await new Promise(resolve => printer.listen(0, host, resolve)); printerPort = printer.address().port;
    assert.notEqual(printerPort, 9100); assert.ok(localAddresses.includes(printer.address().address));
    const connectorPort = await freePort(); connectorOrigin = `http://127.0.0.1:${connectorPort}`;
    connector = child(path.join(resources, "connector/ZbrePrinterLocalPrintAgent-windows-x64.exe"), ["--port", String(connectorPort), "--tcp-ports", String(printerPort), "--state-file", path.join(runDir, "connector/paired-origins.json")]);
    await poll(async () => { try { return (await (await fetch(connectorOrigin + "/v1/health")).json()).capabilities.rfidCaptureV1; } catch { return false; } }, "Connector did not start", 30000);
    const webPort = await freePort(); origin = `http://127.0.0.1:${webPort}`;
    server = child("node", [path.join(web, "server.js")], { cwd: web, env: { ...process.env, NODE_PATH: path.join(web, "standalone_modules"), PORT: String(webPort), HOSTNAME: "127.0.0.1", NODE_ENV: "production", NEXTWAVES_DEPLOYMENT_MODE: "desktop", NEXTWAVES_SERVER_TCP: "disabled", NEXTWAVES_INTEGRATION_API_KEY: "", NEXTWAVES_DATA_DIR: path.join(runDir, "server-data") } });
    await poll(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, "Web did not start", 30000);
    await app.whenReady(); win = new BrowserWindow({ show: false, width: 1480, height: 1180, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
    win.webContents.on("console-message", event => { logs += `\nRenderer: ${event.message}\n`; });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url.startsWith(origin + "/") || details.url.startsWith(connectorOrigin + "/") || /^(blob:|data:|devtools:)/.test(details.url)) }));

    // The caller deliberately sends no counter query. This verifies that both
    // baseline and final samples belong to the packaged connector. A later
    // foreground status query tests recovery after an already-sealed socket loss.
    const original = await createRoll("COUNTER-QA-OLD"), rollId = original.roll.rollId;
    const first = "counter-qa-verified-3";
    delayedFinalRun = first;
    await openRun(rollId, first, 3); const firstReceipt = await appendRun(first, 3);
    const firstFinish = await loseFinishResponse(first, firstReceipt);
    delayedFinalRun = "";
    assert.equal(firstFinish.value.deduplicated, true, "Retry after lost HTTP finish response must return the existing receipt");
    assert.equal(frames.get(first).length, 3);
    assert.equal(firstFinish.value.capture.audit.lifecycleVersion, 1);
    assert.equal(firstFinish.value.capture.audit.finalizationStatus, "verified");
    assert.equal(firstFinish.value.capture.audit.finalCounterProof.method, "same_socket_drained_stable_v1");
    assert.equal(firstFinish.value.capture.audit.baseline.valid, 8000);
    assert.equal(firstFinish.value.capture.audit.latest.valid, 8003);
    assert.equal(firstFinish.value.capture.audit.validDelta, 3);
    let view = await getRoll(rollId);
    assert.equal(view.summary.printerValidCount, 3); assert.equal(view.summary.countsComplete, true);
    assert.equal(view.summary.machineCounterSnapshot.valid, 8003); assert.equal(view.summary.machineCounterSnapshot.void, 30);
    assert.equal(view.summary.machineCounterSnapshot.live, false); assert.deepEqual(view.summary.unreconciledRuns, []);
    await loadUI();
    await poll(() => js(panel + ".textContent.includes('8003')"), "UI must distinguish saved machine absolute8003 from roll delta3", 30000);
    assert.equal(await js("document.querySelector('[data-testid=\"roll-printer-valid\"]').textContent.trim()"), "3");
    assert.ok(await js("document.querySelector('[data-testid=\"machine-counter-values\"]').textContent.includes('VALID 8003')"));
    assert.ok(await js("!!document.querySelector('[data-testid=\"machine-counter-time\"]').textContent.trim()"));
    await screenshot("baseline-vs-roll");
    const verifiedEvidence = rawHashes();

    const interrupted = "counter-qa-disconnect-5"; dropAfterRun = interrupted;
    await openRun(rollId, interrupted, 5); const interruptedReceipt = await appendRun(interrupted, 5);
    await poll(async () => (await action("poll", { jobId: interrupted })).capture.uniqueLabels === 5, "All five EPCs must persist before disconnection");
    const interruptedFinish = await finishRun(interrupted, interruptedReceipt, true);
    const interruptedPoll = await action("poll", { jobId: interrupted });
    assert.equal(interruptedPoll.capture.uniqueLabels, 5);
    assert.equal(interruptedPoll.capture.audit.finalizationStatus, "unresolved");
    assert.ok(interruptedPoll.capture.audit.finalizationReason, "Missing final sample requires a durable machine-readable reason");
    assert.notEqual(interruptedPoll.capture.audit.finalCounterProof?.method, "same_socket_drained_stable_v1");
    view = await getRoll(rollId);
    assert.equal(view.summary.printerValidCount, 3, "A complete earlier checkpoint must not certify interrupted run totals");
    assert.equal(view.summary.capturedEpcCount, 8); assert.equal(view.summary.countsComplete, false);
    assert.equal(view.summary.printerValidKnown, false); assert.equal(view.summary.goodCountKnown, false);
    const unresolved = view.summary.unreconciledRuns.find(run => run.runId === interrupted);
    assert.ok(unresolved); assert.equal(unresolved.capturedEpcCount, 5);
    assert.equal(unresolved.reason, interruptedPoll.capture.audit.finalizationReason);
    assert.ok(unresolved.detail, "Run disclosure must include an explanation, not only an ID");
    const storedSnapshot = structuredClone(view.summary.machineCounterSnapshot), droppedEvidence = rawHashes();
    assert.equal(storedSnapshot.valid, 8003, "Partial final round with VALID8008 and missing VOID must not overwrite complete prior snapshot8003");
    const afterDropLabels = labels(), afterDropConnections = printerConnections;
    await delay(1500); await getRoll(rollId);
    assert.equal(labels(), afterDropLabels); assert.equal(printerConnections, afterDropConnections, "Lost final sampling must not reconnect for attribution");
    preserve(verifiedEvidence); preserve(droppedEvidence);
    await loadUI();
    await poll(() => js(panel + ".textContent.includes(" + JSON.stringify(interrupted) + ")"), "UI must name the unreconciled run", 30000);
    assert.ok(await js("document.querySelector('[data-testid=\"roll-printer-valid\"]').textContent.includes('3 (đã ghi nhận)')"));
    assert.equal(await js("document.querySelector('[data-testid=\"roll-good\"]').textContent.trim()"), "Chưa xác định");
    assert.ok(await js("document.querySelector('[data-testid=\"unreconciled-runs\"]').textContent.includes('5')"));
    await screenshot("disconnect-unreconciled");
    const closeButton = "[...document.querySelectorAll('button')].find(b=>b.innerText.trim()==='Đóng cuộn / bắt đầu lô mới')";
    await js(closeButton + ".scrollIntoView({block:'center',behavior:'instant'})"); await delay(150);
    assert.equal(await js(`(() => { const b=${closeButton}, r=b.getBoundingClientRect(); return !b.disabled && r.top>=0 && r.bottom<=innerHeight && b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)); })()`), true,
        "The independent close action must remain visible/reachable below expanded unresolved-run diagnostics");
    fs.writeFileSync(path.join(runDir, "disconnect-actions.png"), (await win.webContents.capturePage()).toPNG());

    // Reload/refresh cannot convert cached observations into live measurements,
    // even when the machine has moved independently after the session ended.
    valid += 100; voidCount += 2; total += 102;
    view = await getRoll(rollId);
    assert.deepEqual(view.summary.machineCounterSnapshot, storedSnapshot);
    assert.equal(view.summary.printerValidCount, 3); assert.equal(view.summary.countsComplete, false);
    assert.equal(view.summary.machineCounterSnapshot.live, false);
    assert.equal(printerConnections, afterDropConnections);

    // An explicit simulated physical audit releases transport quarantine only.
    // It must not synthesize the missing counter sample or change historical EPCs.
    if (interruptedPoll.state !== "finished") {
        await action("reconcile", { jobId: interrupted, confirmed: true, expectedSequence: interruptedPoll.nextSequence - 1,
            expectedBytes: interruptedPoll.cumulativeBytes, checkpointHash: interruptedPoll.checkpointHash,
            reconciliationNote: "QA simulator: verified eight total unique physical labels and cleared empty socket; no historical counter attribution authorized." });
    }
    const beforeCloseCommands = commands.length, beforeCloseConnections = printerConnections;
    await action("roll-close", { production: { rollId, closedBy: "QA", note: "Close incomplete ledger without inventing missing counters." } });
    assert.equal(commands.length, beforeCloseCommands); assert.equal(printerConnections, beforeCloseConnections); preserve(droppedEvidence);
    const exported = await request({ action: "roll-export", production: { rollId, operator: "QA", jobId: "COUNTER-QA-OLD", rollNumber: 1, provisional: true } }, { text: true });
    fs.writeFileSync(path.join(runDir, "interrupted-history.csv"), exported.value);
    const archivedHash = sha(exported.value);
    assert.match(exported.value, /counter-qa-disconnect-5/); assert.match(exported.value, /READ_OK/g);

    const resetRoll = (await createRoll("COUNTER-QA-RESET")).roll.rollId;
    const reset = "counter-qa-reset-3"; resetAfterRun = reset;
    await openRun(resetRoll, reset, 3); const resetReceipt = await appendRun(reset, 3);
    await poll(async () => (await action("poll", { jobId: reset })).capture.audit.counterResetObserved,
        "Periodic connector checkpoint must observe the low counter before it rebounds", 10000);
    const resetFinish = await finishRun(reset, resetReceipt, true);
    const resetPoll = await action("poll", { jobId: reset });
    assert.equal(resetPerformed, true); assert.equal(resetPoll.capture.uniqueLabels, 3);
    assert.equal(resetLowObserved, true); assert.ok(valid > resetPoll.capture.audit.baseline.valid, "Test must rebound above baseline after observing a reset");
    assert.ok(resetPoll.capture.audit.latest.valid > resetPoll.capture.audit.baseline.valid, "A later high complete sample must not erase an earlier observed reset");
    assert.equal(resetPoll.capture.audit.finalizationStatus, "unresolved");
    assert.equal(resetPoll.capture.audit.counterResetObserved, true);
    const resetView = await getRoll(resetRoll);
    assert.equal(resetView.summary.printerValidCount, 0); assert.equal(resetView.summary.capturedEpcCount, 3);
    assert.equal(resetView.summary.countsComplete, false); assert.equal(resetView.summary.unreconciledRuns[0].reason, "counter_reset");
    const oldAfterNew = await getRoll(rollId);
    assert.equal(oldAfterNew.summary.printerValidCount, 3); assert.equal(oldAfterNew.summary.capturedEpcCount, 8);
    assert.equal(oldAfterNew.summary.countsComplete, false); assert.deepEqual(oldAfterNew.summary.machineCounterSnapshot, storedSnapshot);
    const repeat = await request({ action: "roll-export", production: { rollId } }, { text: true });
    assert.equal(sha(repeat.value), archivedHash, "New batch and new counter values must not change exported old history");
    preserve(droppedEvidence);
    await loadUI();
    await poll(() => js(panel + ".textContent.includes(" + JSON.stringify(reset) + ")"), "Reset run must be visibly unreconciled", 30000);
    await screenshot("reset-unreconciled");

    // An invalid baseline is an admission failure, not an unknown print outcome.
    if (resetPoll.state !== "finished") {
        await action("reconcile", { jobId: reset, confirmed: true, expectedSequence: resetPoll.nextSequence - 1,
            expectedBytes: resetPoll.cumulativeBytes, checkpointHash: resetPoll.checkpointHash,
            reconciliationNote: "QA simulator physical audit after reset; no missing counter values inferred." });
    }
    await action("roll-close", { production: { rollId: resetRoll, closedBy: "QA" } });
    const blockedRoll = (await createRoll("COUNTER-QA-INVALID-BASELINE")).roll.rollId;
    const blocked = "counter-qa-baseline-invalid";
    await openRun(blockedRoll, blocked, 1); baselineMalformed = true;
    const noSendPayload = `^XA^RFR,H,,,E^FN1^FS^HV1,256,NWEP|${blocked}|1|,|END_0D_0A,L^FS^PQ1^XZ`;
    const blockedReply = await request({ action: "append", jobId: blocked, sequence: 1,
        payloadBase64: Buffer.from(noSendPayload).toString("base64"), payloadSha256: sha(noSendPayload) }, { allowError: true });
    baselineMalformed = false;
    assert.equal(blockedReply.ok, false); assert.equal(blockedReply.value.code, "RFID_BASELINE_UNVERIFIED");
    assert.equal(blockedReply.value.stage, "admission"); assert.equal(blockedReply.value.outcome, "not_sent");
    assert.equal(blockedReply.value.bytesWritten, 0); assert.ok(!frames.has(blocked));
    await action("abort", { jobId: blocked });
    const refusedEvidence = rawHashes();
    const baselineRetry = "counter-qa-baseline-retry-2";
    await openRun(blockedRoll, baselineRetry, 2); const retryReceipt = await appendRun(baselineRetry, 2);
    const retryFinish = await finishRun(baselineRetry, retryReceipt);
    assert.equal(retryFinish.value.capture.audit.finalizationStatus, "verified");
    const retriedView = await getRoll(blockedRoll);
    assert.equal(retriedView.roll.runs.length, 2, "The refused admission remains in history");
    assert.equal(retriedView.summary.printerValidCount, 2); assert.equal(retriedView.summary.capturedEpcCount, 2);
    assert.equal(retriedView.summary.missingEpcCount, 0); assert.equal(retriedView.summary.voidCount, 0);
    assert.equal(retriedView.summary.countsComplete, true); assert.equal(retriedView.summary.goodCountKnown, true);
    assert.deepEqual(retriedView.summary.unreconciledRuns, [], "Proven zero-attempt admission must not poison subsequent confirmed counts");
    assert.equal(retriedView.summary.notSentRuns.length, 1); assert.equal(retriedView.summary.notSentRuns[0].runId, blocked);
    assert.equal(retriedView.summary.notSentRuns[0].requestedLabels, 1);
    assert.ok(!apiCalls.some(call => call.action === "reconcile" && call.jobId === blocked), "A guaranteed unsent baseline refusal needs no physical audit");
    preserve(refusedEvidence);
    await loadUI();
    await poll(() => js("document.querySelector('[data-testid=\"not-sent-runs\"]')?.textContent.includes(" + JSON.stringify(blocked) + ")"),
        "The zero-attempt refused request must remain visible separately from unreconciled physical work", 30000);
    await js("(() => { const detail=document.querySelector('[data-testid=\"not-sent-runs\"]'); if(!detail.open) detail.querySelector('summary').click(); })()");
    assert.equal(await js("document.querySelector('[data-testid=\"roll-printer-valid\"]').textContent.trim()"), "2");
    assert.equal(await js("document.querySelector('[data-testid=\"roll-good\"]').textContent.trim()"), "2");
    await screenshot("unsent-admission-retry");
    await action("roll-close", { production: { rollId: blockedRoll, closedBy: "QA" } });

    // No finish request exists until AFTER the connector autonomously seals the
    // full run. Losing the original socket afterward must not erase this proof.
    const autonomousRoll = (await createRoll("COUNTER-QA-AUTONOMOUS")).roll.rollId;
    const autonomous = "counter-qa-autonomous-2";
    await openRun(autonomousRoll, autonomous, 2); const autonomousReceipt = await appendRun(autonomous, 2);
    await poll(async () => (await action("poll", { jobId: autonomous })).capture.audit.finalizationStatus === "verified",
        "Connector must seal a full run when the browser never sends finish", 10000);
    assert.ok(!apiCalls.some(call => call.action === "finish" && call.jobId === autonomous));
    const autonomousBeforeLoss = await action("poll", { jobId: autonomous });
    assert.equal(autonomousBeforeLoss.state, "open");
    assert.equal(autonomousBeforeLoss.capture.audit.validDelta, 2);
    const sealedProof = structuredClone(autonomousBeforeLoss.capture.audit.finalCounterProof);
    const sealedLabels = labels(), sealedConnections = printerConnections, sealedCommands = commands.length;
    for (const socket of sockets) socket.destroy();
    await delay(1200);
    const failedForegroundStatus = await request({ action: "query", jobId: autonomous,
        payloadBase64: Buffer.from("~HQES\r\n").toString("base64"), readWindowMs: 500, readIdleMs: 50 }, { allowError: true });
    assert.equal(failedForegroundStatus.ok, false, "A status query on a lost socket must report the transport failure truthfully");
    assert.match(failedForegroundStatus.value.code, /TCP_JOB|RFID_CAPTURE/);
    const postStatusLoss = await action("poll", { jobId: autonomous });
    assert.equal(postStatusLoss.counterFinishRecoverable, true, "Only a strict sealed counter proof may authorize local finish recovery");
    const autonomousFinish = await finishRun(autonomous, autonomousReceipt);
    assert.equal(autonomousFinish.value.capture.audit.finalizationStatus, "verified");
    assert.deepEqual(autonomousFinish.value.capture.audit.finalCounterProof, sealedProof);
    assert.equal(labels(), sealedLabels); assert.equal(printerConnections, sealedConnections);
    assert.equal(commands.length, sealedCommands, "Final proof survives later socket loss without new printer traffic");
    const autonomousView = await getRoll(autonomousRoll);
    assert.equal(autonomousView.summary.countsComplete, true); assert.equal(autonomousView.summary.printerValidCount, 2);
    assert.equal(autonomousView.summary.capturedEpcCount, 2); assert.deepEqual(autonomousView.summary.unreconciledRuns, []);
    await action("roll-close", { production: { rollId: autonomousRoll, closedBy: "QA" } });
    const postSealProbe = "counter-qa-post-seal-probe";
    await action("open", { jobId: postSealProbe, host, port: printerPort });
    await action("abort", { jobId: postSealProbe });
    assert.ok(!apiCalls.some(call => call.action === "reconcile" && call.jobId === autonomous), "A sealed completed run needs no fabricated physical reconciliation after later EOF");
    preserve(droppedEvidence);
    const callerCounterQueries = apiCalls.filter(call => call.action === "query" && Buffer.from(call.payloadBase64, "base64").toString().includes("odometer.")).length;
    assert.equal(resetCommands, 0); assert.equal(labels(), 15); assert.equal(callerCounterQueries, 0);
    const result = { appVersion: manifest.web.packageVersion, connectorVersion: manifest.connector.version, connectorSha256: manifest.connector.sha256,
        realConnector: true, hardwarePrinting: false, runDir, physicalSimulatorLabels: labels(), resetCommands,
        connectorOwnedBaselineAndFinal: true, lostHttpFinishResponseRecoveredIdempotently: true, nonzeroMachineBaseline: 8000, verifiedRollDelta: 3, machineSnapshot: storedSnapshot,
        disconnectedEpcsPreserved: 5, rollCapturedAfterDisconnect: 8, rollVerifiedSubtotalAfterDisconnect: 3,
        unresolvedRun: unresolved, interruptedHttpStatus: interruptedFinish.status, interruptedState: interruptedPoll.state,
        noAutomaticReprintOrReconnect: true, cachedSnapshotIsNotLive: true, explicitTransportAuditDoesNotCertifyCounters: true,
        partialCounterRoundNeverMixed: true, counterResetDetected: true, counterResetRemainsStickyAfterRebound: true, resetHttpStatus: resetFinish.status, historicalRawEvidencePreserved: true, oldCsvSha256: archivedHash,
        malformedBaselineBlockedBeforeLabels: true, malformedBaselineError: blockedReply.value,
        sameRollRetryAfterUnsentAdmission: 2, refusedAdmissionDoesNotPoisonConfirmedRollCounts: true, refusedRawEvidencePreserved: true,
        autonomousSealWithoutFinishRequest: true, finalProofSurvivesLaterSocketLoss: true,
        truthfulForegroundStatusFailureAfterSealRecovered: true, foregroundStatusError: failedForegroundStatus.value,
        laterSocketLossDoesNotQuarantineCompletedRun: true,
        newRollCannotChangeHistoricalCountersOrCsv: true, callerCounterQueries };
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(output, "latest-result.json"), JSON.stringify(result, null, 2));
    console.log("Packaged counter lifecycle passed: connector-owned baseline/final; nonzero absolute counters; disconnect with all EPCs preserved; unresolved run disclosure; counter reset; immutable historical CSV.");
}
function close(code) {
    fs.writeFileSync(path.join(runDir, "process.log"), logs);
    fs.writeFileSync(path.join(runDir, "simulator-commands.json"), JSON.stringify(commands, null, 2));
    fs.writeFileSync(path.join(runDir, "api-calls.json"), JSON.stringify(apiCalls, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    if (server) server.kill(); if (connector) connector.kill();
    for (const socket of sockets) socket.destroy(); if (printer) printer.close(); app.exit(code);
}
main().then(() => close(0)).catch(async error => {
    if (win && !win.isDestroyed()) {
        try { fs.writeFileSync(path.join(runDir, "failure.txt"), await js("document.body.innerText")); } catch {}
        try { fs.writeFileSync(path.join(runDir, "failure.png"), (await win.webContents.capturePage()).toPNG()); } catch {}
    }
    console.error(error, logs); close(1);
});
