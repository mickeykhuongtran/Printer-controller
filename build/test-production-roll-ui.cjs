// Packaged renderer + real connector + simulator on this computer only.
// This harness never addresses printer hardware or uses TCP port 9100.
// Run AFTER packaging the production-roll build:
//   npx electron build/test-production-roll-ui.cjs
const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "build/production-roll-qa");
const web = path.join(root, "dist/win-unpacked/resources/web");
const connectorExe = path.join(root, "dist/win-unpacked/resources/connector/ZbrePrinterLocalPrintAgent-windows-x64.exe");
const runtimeManifest = JSON.parse(fs.readFileSync(path.join(root, "dist/win-unpacked/resources/runtime-manifest.json"), "utf8"));
assert.equal(runtimeManifest.web.packageVersion, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version, "Package the current app version before UI testing");
const businessJobId = "NW-4520-261016-001";
let rollId = "";
fs.mkdirSync(output, { recursive: true });
const runDir = fs.mkdtempSync(path.join(output, "run-"));
const captureRoot = path.join(runDir, "connector/rfid-sessions");
app.setPath("userData", path.join(runDir, "profile"));

let win, server, connector, printerServer, logs = "", simulatorFailure;
let validCounter = 0, voidCounter = 0, totalCounter = 0;
let downloads = 0, resetAttempts = 0, safetyCommands = 0, printerConnections = 0;
let maxSimulatorQueueDelayMs = 0, maxSimulatorFragmentDelayMs = 0;
let maxSimulatorEventLoopLagMs = 0, simulatorTickAt = Date.now();
const simulatorTimingTimer = setInterval(() => {
    const now = Date.now(), lag = Math.max(0, now - simulatorTickAt - 100); simulatorTickAt = now;
    maxSimulatorEventLoopLagMs = Math.max(maxSimulatorEventLoopLagMs, lag);
    if (lag > 250) logs += `\nSimulator event loop lag ${lag}ms at ${new Date(now).toISOString()}\n`;
}, 100);
simulatorTimingTimer.unref();
let firstWriteRunId = "", materialFaultAfter = 0, materialFault = false, printerPaused = false;
const sockets = new Set(), runFrames = new Map(), runSockets = new Map(), commands = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = async code => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { logs += `\nFailed renderer probe:\n${code}\n`; throw error; }
};
const panel = `document.querySelector('section[aria-label="Production roll"]')`;
const epcFor = n => n.toString(16).toUpperCase().padStart(24, "0");

async function poll(fn, message, timeout = 240000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        if (simulatorFailure) throw simulatorFailure;
        if (await fn()) return;
        await delay(100);
    }
    if (win && !win.isDestroyed()) fs.writeFileSync(path.join(runDir, "failure.txt"), await js("document.body.innerText"));
    throw new Error(message);
}
async function freePort() {
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
}
function child(command, args, options) {
    const proc = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    proc.stdout.on("data", data => { logs += data; });
    proc.stderr.on("data", data => { logs += data; });
    proc.on("error", error => { logs += String(error); });
    return proc;
}
async function fill(label, value) {
    await poll(() => js(`(() => { const e = document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']'); return !!e && !e.disabled; })()`),
        "Input unavailable: " + label, 30000);
    await js(`(() => {
        const element = document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']');
        if (!element) throw new Error('Missing input: ' + ${JSON.stringify(label)});
        const proto = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, ${JSON.stringify(String(value))});
        element.dispatchEvent(new Event(element.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
}
async function check(label) {
    await js(`(() => { const e = document.querySelector('[aria-label=' + ${JSON.stringify(JSON.stringify(label))} + ']'); if (!e) throw new Error('Missing checkbox'); if (!e.checked) e.click(); })()`);
}
async function clickButton(text) {
    await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(text)} && !b.disabled)`), "Button unavailable: " + text, 30000);
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText.trim() === ${JSON.stringify(text)} && !b.disabled).click()`);
}
async function showDetails(text) {
    await js(`(() => { const e = [...${panel}.querySelectorAll('summary')].find(s => s.innerText.trim() === ${JSON.stringify(text)}); if (e && !e.parentElement.open) e.click(); })()`);
}
function filesBelow(directory) {
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const location = path.join(directory, entry.name);
        return entry.isDirectory() ? filesBelow(location) : [location];
    });
}
function rawEvidenceHashes() {
    return Object.fromEntries(filesBelow(captureRoot).filter(file => path.basename(file) === "reads.csv")
        .map(file => [path.relative(captureRoot, file), createHash("sha256").update(fs.readFileSync(file)).digest("hex")]).sort(([a], [b]) => a.localeCompare(b)));
}
function assertEvidencePreserved(expected) {
    const actual = rawEvidenceHashes();
    for (const [file, hash] of Object.entries(expected)) assert.equal(actual[file], hash, "Historical raw RFID evidence changed: " + file);
}
function physicalLabels() { return [...runFrames.values()].reduce((sum, frames) => sum + frames.length, 0); }
async function screenshot(name, target = panel) {
    await js(target + "?.scrollIntoView({block:'center', behavior:'instant'})"); await delay(250);
    fs.writeFileSync(path.join(runDir, name + ".png"), (await win.webContents.capturePage()).toPNG());
}
async function resumeRoll() {
    await clickButton("Tiếp tục cuộn cũ");
    await poll(() => js("![...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Tiếp tục cuộn cũ' && !b.disabled)"), "Explicit roll resume did not take effect", 30000);
}
async function selectHistory(id) {
    await showDetails("Lịch sử cuộn / xuất CSV");
    await fill("Production roll history", id);
    assert.equal(await js("document.querySelector('[aria-label=\"Production roll history\"]').closest('details').open"), true,
        "Changing historical roll selection must keep its chooser and View button visible");
    await clickButton("Xem dữ liệu cuộn");
    await poll(() => js("document.querySelector('[aria-label=\"Historical production roll\"]')?.textContent.includes(" + JSON.stringify(id) + ")"
        + " && [...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Xem dữ liệu cuộn' && !b.disabled)"),
        "Selected historical roll did not finish loading: " + id, 30000);
}
async function closeRoll(getRoll) {
    const labelsBefore = physicalLabels(), downloadsBefore = downloads, commandsBefore = commands.length, connectionsBefore = printerConnections;
    const evidence = rawEvidenceHashes();
    await clickButton("Đóng cuộn / bắt đầu lô mới");
    await poll(async () => (await getRoll()).roll.state === "closed", "Independent roll closure did not persist", 30000);
    assert.equal(physicalLabels(), labelsBefore, "Closing a ledger must never emit labels");
    assert.equal(commands.length, commandsBefore, "Closing a ledger must never issue printer commands");
    assert.equal(printerConnections, connectionsBefore, "Closing a ledger must not connect to the printer");
    assert.equal(downloads, downloadsBefore, "Closing a ledger must not download CSV automatically");
    assertEvidencePreserved(evidence);
    const closed = await getRoll();
    assert.ok(closed.roll.closedAt, "Closure must have its own audit timestamp");
    assert.ok(!closed.exportFileName, "Closure must not generate a CSV artifact");
    assert.ok(!closed.roll.exportFileName, "Closure must not set an export receipt");
    await poll(() => js("document.querySelector('[aria-label=\"Historical production roll\"]')?.textContent.includes(" + JSON.stringify(closed.roll.rollId) + ")"
        + " && [...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Xem dữ liệu cuộn' && !b.disabled)"),
        "Closed history did not finish rendering after independent close", 30000);
    return closed;
}
function assertNoAutomaticReport() {
    const stored = filesBelow(captureRoot);
    assert.ok(stored.some(file => path.basename(file) === "reads.csv"), "Raw evidence must exist before checking presentation export policy");
    const unexpected = stored.filter(file => /\.(csv|zip)$/i.test(file) && path.basename(file) !== "reads.csv");
    assert.deepEqual(unexpected, [], "Run close/finalize must preserve raw evidence without automatically creating presentation CSVs");
    assert.equal(downloads, 0, "No operator download should occur automatically");
}
function parseCsv(text) {
    const rows = []; let row = [], value = "", quoted = false;
    text = text.replace(/^\uFEFF/, "");
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quoted) {
            if (c === '"' && text[i + 1] === '"') { value += '"'; i++; }
            else if (c === '"') quoted = false;
            else value += c;
        } else if (c === '"') quoted = true;
        else if (c === ',') { row.push(value); value = ""; }
        else if (c === '\n') { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
        else value += c;
    }
    if (value || row.length) { row.push(value); rows.push(row); }
    assert.equal(quoted, false, "CSV must not end within a quoted field");
    const headerIndex = rows.findIndex(row => row[0] === "ordinal");
    assert.ok(headerIndex >= 0, "Report must contain the compact data header");
    const metadata = rows.slice(0, headerIndex), header = rows[headerIndex];
    const records = rows.slice(headerIndex + 1).filter(row => row.some(Boolean)).map(row => {
        assert.equal(row.length, header.length, "CSV record must retain its column count");
        return Object.fromEntries(header.map((key, i) => [key, row[i]]));
    });
    return { metadata, header, records };
}
async function download(button, destination, expectedName) {
    const finished = new Promise((resolve, reject) => {
        const onDownload = (_event, item) => {
            try { if (expectedName) assert.equal(item.getFilename(), expectedName); }
            catch (error) { item.cancel(); clearTimeout(timer); reject(error); return; }
            item.setSavePath(destination);
            item.once("done", (_event, state) => {
                clearTimeout(timer);
                if (state === "completed") resolve(item.getFilename()); else reject(new Error("Download " + state));
            });
        };
        const timer = setTimeout(() => { win.webContents.session.removeListener("will-download", onDownload); reject(new Error("Operator download timeout: " + button)); }, 30000);
        win.webContents.session.once("will-download", onDownload);
    });
    await clickButton(button);
    return finished;
}

async function main() {
    assert.ok(fs.existsSync(connectorExe) && fs.existsSync(path.join(web, "server.js")), "Build the latest packaged renderer and connector first");
    const localAddresses = Object.values(os.networkInterfaces()).flat().filter(a => a.family === "IPv4" && !a.internal).map(a => a.address);
    const host = localAddresses.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
    assert.ok(host, "Simulator requires a private IPv4 address belonging to this computer");
    printerServer = net.createServer(socket => {
        printerConnections++;
        sockets.add(socket); let pending = "", outgoing = Promise.resolve();
        const send = text => { const queuedAt = Date.now(); outgoing = outgoing.then(async () => {
            const queuedMs = Date.now() - queuedAt; maxSimulatorQueueDelayMs = Math.max(maxSimulatorQueueDelayMs, queuedMs);
            if (queuedMs > 250) logs += `\nSimulator delayed reply queue ${queuedMs}ms: ${JSON.stringify(text.slice(0, 72))}\n`;
            if (socket.destroyed) return;
            socket.write(text.slice(0, 2)); const fragmentAt = Date.now(); await delay(1);
            const fragmentMs = Date.now() - fragmentAt; maxSimulatorFragmentDelayMs = Math.max(maxSimulatorFragmentDelayMs, fragmentMs);
            if (fragmentMs > 250) logs += `\nSimulator delayed TCP fragment ${fragmentMs}ms: ${JSON.stringify(text.slice(0, 72))}\n`;
            if (!socket.destroyed) socket.write(text.slice(2));
        }); };
        socket.on("error", () => {}); socket.on("close", () => sockets.delete(socket));
        socket.on("data", bytes => {
            pending += bytes.toString("ascii");
            try {
                for (;;) {
                    pending = pending.replace(/^[\r\n ]+/, "");
                    if (pending.startsWith("~HQES")) {
                        pending = pending.slice(5); commands.push("~HQES");
                        send(`\x02\r\nPRINTER STATUS\r\nERRORS: ${materialFault ? "1" : "0"} 00000000 ${materialFault ? "00000004" : "00000000"}\r\nWARNINGS: 0 00000000 00000000\r\n\x03\r\n`);
                    } else if (pending.startsWith("~HS")) {
                        pending = pending.slice(3); commands.push("~HS");
                        send(`\x02000,0,${printerPaused ? "1" : "0"},0251,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,${materialFault ? "1" : "0"},0,1,2,6,0,00000000,1,001\x03\r\n\x021234,1\x03\r\n`);
                    } else if (pending.startsWith('! U1 getvar ') && pending.includes('\n')) {
                        const end = pending.indexOf('\n') + 1, command = pending.slice(0, end); pending = pending.slice(end); commands.push(command.trim());
                        const value = command.includes('odometer.rfid.valid_resettable') ? validCounter
                            : command.includes('odometer.rfid.void_resettable') ? voidCounter
                            : command.includes('odometer.total_label_count') ? totalCounter : '?';
                        send(`"${value}"\r\n`);
                    } else if (pending.startsWith('! U1 setvar ')) {
                        resetAttempts++; throw new Error("Application must never reset printer counters during a production roll");
                    } else if (pending.startsWith("~JA") || pending.startsWith("~PP") || pending.startsWith("~PS")) {
                        const command = pending.slice(0, 3);
                        commands.push(command); pending = pending.slice(3);
                        if (command === "~PP") printerPaused = true;
                        if (command === "~PS") printerPaused = false;
                    } else if (pending.startsWith("^JZN") || pending.startsWith("~JZN")) {
                        safetyCommands++; pending = pending.slice(4);
                    } else if (pending.startsWith("^XA") && pending.includes("^XZ")) {
                        const end = pending.indexOf("^XZ") + 3, zpl = pending.slice(0, end); pending = pending.slice(end);

                        if (zpl.includes("^JZN")) safetyCommands++;
                        const hv = zpl.match(/\^HV1,256,NWEP\|([^|]+)\|(\d+)\|,\|END_0D_0A,L\^FS/);
                        const writeHv = zpl.match(/\^HV2,256,NWEP\|([^|]+)\|(\d+)\|W\|([0-9A-F]+)\|,\|END_0D_0A,L\^FS/);
                        if (writeHv) {
                            assert.match(zpl, /\^RFW/); assert.match(zpl, /\^RFR,H,2,12,1\^FN2\^FS/);
                            assert.match(zpl, /\^RS8,[^,\r\n]*,,1,N/);
                            const runId = writeHv[1], ordinal = Number(writeHv[2]), expected = writeHv[3];
                            if (!firstWriteRunId) firstWriteRunId = runId;
                            const actual = runId === firstWriteRunId && ordinal === 2 ? expected.slice(0, -1) + (expected.endsWith("F") ? "E" : "F") : expected;
                            if (!runFrames.has(runId)) runFrames.set(runId, []);
                            const frames = runFrames.get(runId); assert.equal(ordinal, frames.length + 1);
                            frames.push({ ordinal, epc: actual, expected }); validCounter++; totalCounter++;
                            send("NWEP|" + runId + "|" + ordinal + "|W|" + expected + "|" + actual + "|END\r\n");
                            continue;
                        }
                        assert.ok(!zpl.includes("^RFW"), "Read-only production must not write EPC");
                        if (!hv) { assert.match(zpl, /^\^XA\s*\^JZN\s*\^XZ$/, "Only the safe setup format may omit RFID readback"); continue; }
                        assert.match(zpl, /\^RFR,H,,,E\^FN1\^FS/); assert.match(zpl, /\^PQ1\b/);
                        const runId = hv[1], ordinal = Number(hv[2]);
                        runSockets.set(runId, socket);
                        // The head-open stop prevents queued formats from becoming
                        // physical labels; the connector's ~JA discards that tail.
                        if (materialFault) continue;
                        if (!runFrames.has(runId)) runFrames.set(runId, []);
                        const frames = runFrames.get(runId); assert.equal(ordinal, frames.length + 1, "Each run's host ordinals must be strictly sequential");
                        totalCounter++;
                        const isVoid = runFrames.size === 1 && (ordinal === 273 || ordinal === 1450);
                        if (isVoid) voidCounter++; else validCounter++;
                        const epc = isVoid ? "" : epcFor(validCounter), omitted = runFrames.size === 1 && ordinal === 1200; frames.push({ ordinal, epc, omitted });
                        assert.match(zpl, /\^RS8,[^,\r\n]*,,1,N/, "RFID policy must continue after a failed attempt");
                        if (!omitted) send(`NWEP|${runId}|${ordinal}|${epc}|END\r\n`);
                        if (materialFaultAfter > 0 && ordinal === materialFaultAfter) materialFault = true;
                    } else break;
                }
            } catch (error) { simulatorFailure = error; socket.destroy(); }
        });
    });
    await new Promise(resolve => printerServer.listen(0, host, resolve));
    const printerPort = printerServer.address().port;
    assert.notEqual(printerPort, 9100);
    assert.ok(localAddresses.includes(printerServer.address().address));
    const connectorPort = await freePort(), connectorOrigin = `http://127.0.0.1:${connectorPort}`;
    connector = child(connectorExe, ["--port", String(connectorPort), "--tcp-ports", String(printerPort), "--state-file", path.join(runDir, "connector/paired-origins.json")]);
    await poll(async () => { try { return (await (await fetch(connectorOrigin + "/v1/health")).json()).capabilities.rfidCaptureV1; } catch { return false; } }, "Connector not ready", 30000);
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    server = child("node", [path.join(web, "server.js")], { cwd: web, env: { ...process.env, NODE_PATH: path.join(web, "standalone_modules"), PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", NEXTWAVES_DEPLOYMENT_MODE: "desktop", NEXTWAVES_SERVER_TCP: "disabled", NEXTWAVES_INTEGRATION_API_KEY: "", NEXTWAVES_DATA_DIR: path.join(runDir, "server-data") } });
    await poll(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, "Web server not ready", 30000);
    await app.whenReady();
    win = new BrowserWindow({ show: false, width: 1480, height: 1180, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.on("console-message", event => { logs += `\nRenderer: ${event.message}\n`; });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url.startsWith(origin + "/") || details.url.startsWith(connectorOrigin + "/") || /^(blob:|data:|devtools:)/.test(details.url)) }));
    win.webContents.session.on("will-download", () => { downloads++; });
    const doc = { id: "production-roll-qa", name: "Nextwaves 4520 EPC read QA", settings: { widthMm: 45, heightMm: 20, gapMm: 3, dpi: 203, targetPrinterModel: "zt610r", copies: 2500, speed: 4, darkness: 10,
        serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
        rfid: { enabled: false, readEnabled: true, captureToHost: true, readBank: "EPC", readFieldName: "rfid_read", zebraEpcReadMode: "pc", zebraModel: "zt610r", zebraUsePrinterSettings: true, chip: "epc_96", epcBits: 96, format: "H", retries: 3, block: 2, words: 6, data: "" } },
        elements: [{ id: "read-text", kind: "text", text: "{rfid_read}", pos: { x: 2, y: 2 }, size: { w: 41, h: 7 }, rotation: 0, font: "D", scaleX: 1, scaleY: 1 }] };
    await win.loadURL(origin);
    await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc, step: "print", hasDoc: true }))}); localStorage.setItem('zbre.print.printer.v1', ${JSON.stringify(JSON.stringify({ connectionMode: "tcp", tcpHost: host, tcpPort: printerPort, tcpExecutionMode: "connector", printAgentUrl: connectorOrigin, language: "zpl" }))});`);
    await win.loadURL(origin);
    await poll(() => js(panel + "?.innerText.includes('Sẵn sàng bắt đầu lô mới.')"), "CSV panel unavailable; latest package required", 30000);
    await js(panel + ".scrollIntoView({block:'center', behavior:'instant'})"); await delay(250);
    fs.writeFileSync(path.join(runDir, "empty-roll.png"), (await win.webContents.capturePage()).toPNG());
    const post = async (action, production = {}, expectedStatus = 200) => {
        const response = await fetch(connectorOrigin + "/v1/tcp/job", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ action, production }) });
        assert.equal(response.status, expectedStatus, action + ": " + await response.clone().text());
        return response;
    };
    const getRoll = async () => (await post("roll-get", { rollId })).json();
    if (process.argv.includes("--history-only")) {
        await require("./test-roll-history-flow.cjs")({ post, host, printerPort, js, panel, poll, clickButton, fill, showDetails, win, origin, screenshot, download, runDir,
            printerActivity: () => ({ connections: printerConnections, commands: commands.length, labels: physicalLabels() }) });
        console.log("Packaged roll history passed: clear selected/all closed, open-roll guard, reload, restore, CSV preservation, real connector, no printer traffic.");
        return;
    }
    const counter = async (name, value) => js("document.querySelector('[data-testid=\"roll-" + name + "\"],[data-testid=\"history-roll-" + name + "\"]')?.textContent?.trim().split(' ')[0] === " + JSON.stringify(String(value)));
    const loadDoc = async value => {
        await js("localStorage.setItem('zbre.print.session.v1', " + JSON.stringify(JSON.stringify({ doc: value, step: "print", hasDoc: true })) + ")");
        await win.loadURL(origin);
    };
    const assertPrintBlocked = async message => {
        await poll(() => js("document.body.innerText.includes(" + JSON.stringify(message) + ")"), "Expected configuration guard: " + message, 30000);
        assert.equal(await js("[...document.querySelectorAll('button')].find(b=>/^Print \\d+ labels?$/.test(b.innerText.trim()))?.disabled"), true);
    };
    assert.equal((await (await post("roll-list")).json()).rolls.length, 0, "Enabling CSV must not create an empty export file or ledger before printing");
    assert.equal(await js("document.querySelectorAll('[aria-label=\"Save roll CSV\"]').length"), 1);
    assert.equal(await js(panel + ".querySelectorAll('input[type=checkbox]').length"), 0, "The production panel must not add a second recording option or QC checkbox");
    assert.equal(await js("document.querySelector('[aria-label=\"Production operator\"]') === null"), true, "Metadata is requested at final export, not before the first print");
    await clickButton("Print 2500 labels");
    await poll(async () => {
        if (await js("document.body.innerText.includes('A printer fault or lost status stopped this run.')")) {
            throw new Error("Unexpected loss of status during the normal 2500-attempt case; inspect simulator timing and connector audit before retrying");
        }
        return await counter("printer-valid", 2498) && await counter("captured-epc", 2497) && await js("document.body.innerText.includes('Saved 2497 EPC reads.')");
    }, "2500-attempt run did not finish across two VOID tags and missing readback");
    const openRolls = (await (await post("roll-list")).json()).rolls;
    assert.equal(openRolls.length, 1); rollId = openRolls[0].rollId;
    assert.equal(runFrames.size, 1);
    const firstId = [...runFrames.keys()][0];
    assert.equal(runFrames.get(firstId).length, 2500, "VOID must consume one requested attempt without pausing the next chunk");
    assert.equal(validCounter, 2498); assert.equal(voidCounter, 2); assert.equal(resetAttempts, 0);
    assertNoAutomaticReport();
    let view = await getRoll();
    assert.equal(view.roll.state, "open");
    assert.equal(await js("document.querySelector('[aria-label=\"Save roll CSV\"]').disabled"), true, "Recording cannot be disabled partway through an unfinished roll");
    assert.equal(view.summary.printerValidCount, 2498); assert.equal(view.summary.capturedEpcCount, 2497); assert.equal(view.summary.missingEpcCount, 1); assert.equal(view.summary.voidCount, 2);
    assert.equal(await js("!!document.querySelector('[data-testid=\"roll-epc-gap\"]')"), true);
    assert.deepEqual(view.summary.activeRuns, []);

    // Template, operation mode and non-RFID changes cannot silently mix a roll.
    const changedDoc = structuredClone(doc); changedDoc.elements[0].text = "CHANGED {rfid_read}";
    await loadDoc(changedDoc); await assertPrintBlocked("Đã đổi template");
    await post("roll-create", { rollId, printerHost: host, printerPort, operationMode: "read", bank: "EPC", templateFingerprint: "f".repeat(64) }, 409);
    const nonRfidDoc = structuredClone(doc); nonRfidDoc.settings.rfid.readEnabled = false; nonRfidDoc.settings.rfid.captureToHost = false;
    await loadDoc(nonRfidDoc); await assertPrintBlocked("Đóng cuộn");
    assert.equal(runFrames.size, 1, "Blocked template changes must not send a new print run");
    assert.equal((await (await post("roll-list")).json()).rolls.length, 1, "A mismatch must not automatically split the roll");
    await loadDoc(doc);
    await poll(() => counter("printer-valid", 2498), "Open roll did not restore after reload", 30000);
    await assertPrintBlocked("Tiếp tục cuộn cũ");
    assert.equal(runFrames.size, 1, "Reload must never silently resume an old roll");
    await resumeRoll();
    await showDetails("Tem đã loại");
    await fill("Removed good labels", 1);
    await poll(() => js("[..." + panel + ".querySelectorAll('button')].find(b=>b.innerText.trim()==='Đóng cuộn / bắt đầu lô mới').disabled"),
        "Closing must not silently discard operator edits to removal quantities", 30000);
    await clickButton("Lưu số tem loại");
    await poll(() => counter("good", 2497), "Removed VALID was not deducted from GOOD", 30000);
    await poll(() => js("![..." + panel + ".querySelectorAll('button')].find(b=>b.innerText.trim()==='Đóng cuộn / bắt đầu lô mới').disabled"),
        "Saving removal quantities must make independent closure available", 30000);
    assert.equal((await getRoll()).summary.removedGoodCount, 1);
    assert.equal((await getRoll()).summary.removedRejectedCount, 0);
    assert.equal(await js("document.querySelector('[aria-label=\"Removed rejected labels\"]') === null"), true, "Read-only roll does not need write-rejection input");
    await js(`[...${panel}.querySelectorAll('summary')].find(s => s.innerText.trim() === 'Tem đã loại').parentElement.open = false`);
    await fill("Labels", 3);
    await clickButton("Print 3 labels");
    await poll(async () => await counter("printer-valid", 2501) && await counter("captured-epc", 2500) && await counter("good", 2500) && await js("document.body.innerText.includes('Saved 3 EPC reads.')"), "Manual three-label top-up did not finish");
    assert.equal(runFrames.size, 2);
    const secondId = [...runFrames.keys()][1];
    assert.equal(runFrames.get(secondId).length, 3);
    assert.equal(runFrames.get(secondId)[0].epc, epcFor(2499));
    assert.equal(validCounter, 2501); assert.equal(voidCounter, 2); assert.equal(resetAttempts, 0);
    assertNoAutomaticReport();
    view = await getRoll();
    assert.equal(view.roll.runs.length, 2); assert.equal(view.summary.printerValidCount, 2501);
    assert.equal(view.summary.goodCount, 2500); assert.equal(view.summary.capturedEpcCount, 2500); assert.equal(view.summary.missingEpcCount, 1);
    assert.equal((await (await post("roll-list")).json()).rolls.length, 1, "A top-up must not split the roll");

    const readRollId = rollId;
    const readEvidence = rawEvidenceHashes();
    // Backdate only the isolated test ledger to model a batch left open by an
    // earlier installation. Raw capture files and the user's profile are never
    // edited. The connector reads the durable manifest for each roll operation.
    const oldManifestFile = filesBelow(captureRoot).find(file => path.basename(file) === "roll.json"
        && JSON.parse(fs.readFileSync(file, "utf8")).roll.rollId === readRollId);
    assert.ok(oldManifestFile);
    const oldManifest = JSON.parse(fs.readFileSync(oldManifestFile, "utf8"));
    const priorWeek = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    oldManifest.roll.createdAt = priorWeek; oldManifest.roll.jobId = businessJobId;
    oldManifest.roll.operator = "LAST-WEEK-OPERATOR"; oldManifest.roll.rollNumber = 1;
    for (const key of ["closedAt", "closedBy", "exportedAt", "exportedBy"]) delete oldManifest.roll[key];
    fs.writeFileSync(oldManifestFile, JSON.stringify(oldManifest, null, 2));
    // Reproduce an older installed version's durable open roll with a current
    // capture-OFF draft. Reload must expose a choice; it must not append or
    // silently turn capture back on. All evidence stays under this test profile.
    const captureOffDoc = structuredClone(doc); captureOffDoc.settings.rfid.captureToHost = false;
    await loadDoc(captureOffDoc);
    await poll(() => counter("printer-valid", 2501), "Capture-OFF startup hid the old roll", 30000);
    await assertPrintBlocked("Tiếp tục cuộn cũ");
    assert.equal(await js("document.querySelector('[aria-label=\"Save roll CSV\"]').checked"), false, "Discovery must not silently enable recording");
    assert.ok(!await js("document.body.innerText.includes('unknown outcome')"), "Known pre-send guard must not imply an unknown print outcome");
    await screenshot("old-roll-capture-off");
    const admissionCommands = commands.length, admissionLabels = physicalLabels(), admissionConnections = printerConnections;
    const admissionResponse = await fetch(connectorOrigin + "/v1/tcp/job", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ action: "open", jobId: "blocked-admission-qa", host, port: printerPort }) });
    assert.equal(admissionResponse.status, 409);
    const admissionError = await admissionResponse.json();
    assert.equal(admissionError.outcome, "not_sent");
    assert.equal(admissionError.stage, "admission");
    assert.equal(admissionError.retrySafety, "safe");
    assert.equal(physicalLabels(), admissionLabels); assert.equal(commands.length, admissionCommands, "Admission guard must run before opening printer traffic");
    assert.equal(printerConnections, admissionConnections, "Blocked admission must not dial the printer");
    view = await closeRoll(getRoll);
    const readClosedAt = view.roll.closedAt;
    assert.equal(view.roll.createdAt, priorWeek, "Close must preserve the historical batch creation time");
    assert.equal(view.roll.operator, "LAST-WEEK-OPERATOR", "Close must not rewrite old batch metadata");
    assert.equal(view.roll.runs.length, 2); assert.equal(view.summary.goodCount, 2500);
    assertNoAutomaticReport();
    await screenshot("closed-without-export");
    await win.loadURL(origin);
    await poll(() => js("!!document.querySelector('[aria-label=\"Production roll history\"]')"), "Closed unexported history disappeared after capture-OFF reload", 30000);
    await selectHistory(readRollId);
    await poll(() => counter("good", 2500), "Closed historical counts did not load", 30000);
    assertNoAutomaticReport();

    // Start another batch on exactly the same endpoint and template before
    // exporting the prior batch. An identical business Job ID must be allowed.
    const freshDoc = structuredClone(doc); freshDoc.settings.copies = 1;
    await loadDoc(freshDoc);
    // Test-only interception holds the genuine final append response while the
    // connector autonomously seals its evidence. No response or status is
    // fabricated: after socket loss the actual PrintStep must handle its own
    // failed foreground status query and recover the saved finish receipt.
    await js(`(() => {
        const original = window.fetch.bind(window);
        const state = window.__qaPostSealLoss = { jobId: '', released: false, queryFailures: [] };
        window.__qaRestoreFetch = () => { window.fetch = original; };
        window.fetch = async (input, options) => {
            let body;
            try { body = typeof options?.body === 'string' ? JSON.parse(options.body) : null; } catch {}
            const response = await original(input, options);
            if (state.released && body?.action === 'query' && body.jobId === state.jobId && !response.ok)
                state.queryFailures.push({ status: response.status, command: atob(body.payloadBase64 || '') });
            if (!state.jobId && body?.action === 'append') {
                state.jobId = body.jobId;
                await new Promise(resolve => { window.__qaReleaseAppend = () => { state.released = true; resolve(); }; });
            }
            return response;
        };
    })()`);
    await clickButton("Print 1 label");
    await poll(() => js("!!window.__qaPostSealLoss.jobId"), "The one-label append response was not intercepted", 30000);
    const postSealLossJobId = await js("window.__qaPostSealLoss.jobId");
    const sealedManifest = path.join(captureRoot, createHash("sha256").update(origin + "\x00" + postSealLossJobId).digest("hex"), "manifest.json");
    await poll(() => {
        try { return JSON.parse(fs.readFileSync(sealedManifest, "utf8")).summary.audit.finalizationStatus === "verified"; }
        catch { return false; }
    }, "Connector did not autonomously seal while PrintStep was awaiting the genuine append response", 15000);
    assert.equal(runFrames.get(postSealLossJobId).length, 1);
    assert.ok(runSockets.get(postSealLossJobId)); runSockets.get(postSealLossJobId).destroy();
    await delay(150); await js("window.__qaReleaseAppend()");
    await poll(async () => {
        if (await js("document.body.innerText.includes('A printer fault or lost status stopped this run.') || document.body.innerText.includes('Printing was interrupted.')"))
            throw new Error("PrintStep falsely marked a durably sealed run incomplete after its later socket loss");
        return await counter("printer-valid", 1) && await counter("captured-epc", 1)
            && await js("document.body.innerText.includes('Saved 1 EPC reads.')");
    }, "New batch did not recover its sealed finish receipt after foreground status failure");
    const postSealStatusFailures = await js("window.__qaPostSealLoss.queryFailures");
    assert.ok(postSealStatusFailures.some(failure => /~HQES|~HS/.test(failure.command)), "The actual foreground status request must fail before PrintStep recovers");
    await js("window.__qaRestoreFetch()");
    assert.equal((await (await fetch(connectorOrigin + "/v1/tcp/job", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ action: "poll", jobId: postSealLossJobId }) })).json()).state, "finished");
    await screenshot("post-seal-status-recovered");
    const freshRoll = (await (await post("roll-list")).json()).rolls.find(item => item.state === "open");
    assert.ok(freshRoll && freshRoll.rollId !== readRollId);
    assert.equal(freshRoll.runs.length, 1); assert.equal(runFrames.size, 3);
    assertEvidencePreserved(readEvidence);
    const historicalRead = await (await post("roll-get", { rollId: readRollId })).json();
    assert.equal(historicalRead.roll.state, "closed"); assert.equal(historicalRead.roll.runs.length, 2);
    assert.ok(!historicalRead.exportFileName, "Old CSV must remain deferred while the fresh batch prints");
    rollId = freshRoll.rollId;
    // A different window may close a selected roll after this renderer's last
    // refresh. The stale explicit ID must fail before any label is sent and the
    // visible error must say that clearly, without an 'unknown outcome'.
    await poll(() => js("[...document.querySelectorAll('button')].some(b=>b.innerText.trim()==='Print 1 label' && !b.disabled)"), "Fresh batch UI did not become idle", 30000);
    await delay(250);
    const staleLabels = physicalLabels(), staleCommands = commands.length, staleConnections = printerConnections;
    await post("roll-close", { rollId, note: "Closed by another test window after its batch completed." });
    await clickButton("Print 1 label");
    await poll(() => js("document.body.innerText.includes('Chưa gửi lệnh in.')"), "Pre-send stale-roll rejection did not show the clear UI status", 30000);
    const technicalDetails = "[...document.querySelectorAll('summary')].find(s=>s.textContent.trim()==='Technical details').parentElement";
    await js(technicalDetails + ".open = true");
    assert.ok(!await js("document.body.innerText.includes('unknown outcome') || document.body.innerText.includes('Printing was interrupted.')"), "Known unsent roll rejection must not claim an uncertain physical outcome");
    assert.ok(!await js(technicalDetails + ".textContent.includes('unknown outcome')"), "Technical details must preserve the guaranteed unsent outcome");
    assert.equal(physicalLabels(), staleLabels); assert.equal(commands.length, staleCommands); assert.equal(printerConnections, staleConnections);
    await screenshot("stale-selection-not-sent", technicalDetails);
    assert.equal((await getRoll()).roll.state, "closed");
    assertEvidencePreserved(readEvidence);
    await selectHistory(rollId);
    assertNoAutomaticReport();
    await showDetails("Lịch sử cuộn / xuất CSV");
    await fill("Production Job ID", businessJobId); await fill("Production roll number", 1); await fill("Production operator", "SIM-OPERATOR");
    const freshFilename = await download("Xuất CSV", path.join(runDir, "fresh-batch-export.csv"));
    assert.equal((await getRoll()).roll.state, "closed");
    const freshRollId = rollId;

    rollId = readRollId;
    await selectHistory(readRollId);
    await poll(() => counter("good", 2500), "Old closed roll was not available for deferred export", 30000);
    await showDetails("Lịch sử cuộn / xuất CSV");
    assert.equal(await js("document.querySelector('[aria-label=\"Historical production roll\"]').querySelectorAll('input').length"), 3, "Export needs only operator, job ID and roll sequence");
    await fill("Production Job ID", businessJobId);
    await fill("Production roll number", 1);
    await fill("Production operator", "SIM-OPERATOR");
    await js(panel + ".scrollIntoView({block:'start', behavior:'instant'})"); await delay(250);
    fs.writeFileSync(path.join(runDir, "export-ready.png"), (await win.webContents.capturePage()).toPNG());
    const csvPath = path.join(runDir, "roll-export.csv");
    const exportStarted = Date.now();
    const filename = await download("Xuất CSV", csvPath);
    assert.match(filename, /\.csv$/i);
    await poll(async () => !!(await getRoll()).exportFileName, "Deferred export did not commit its artifact", 30000);
    view = await getRoll();
    assert.equal(view.roll.state, "closed");
    assert.equal(view.roll.closedAt, readClosedAt, "Export must not rewrite the independent close timestamp");
    assert.equal(view.roll.jobId, businessJobId); assert.equal(view.roll.operator, "SIM-OPERATOR"); assert.equal(view.roll.rollNumber, 1);
    assert.ok(Date.parse(view.roll.exportedAt) >= exportStarted - 1500, "Export has its own timestamp, separate from closure");
    assert.equal(view.exportFileName, filename);
    assert.notEqual(filename, freshFilename, "Same business Job ID and roll number must still produce independently named historical artifacts");
    assertEvidencePreserved(readEvidence);
    const csvBuffer = fs.readFileSync(csvPath);
    const csv = csvBuffer.toString("utf8"), parsed = parseCsv(csv);
    assert.deepEqual(parsed.header, ["ordinal", "host_time", "bank", "value", "result", "received_time", "detail"]);
    assert.ok(JSON.stringify(parsed.metadata).includes("SIM-OPERATOR") && JSON.stringify(parsed.metadata).includes(businessJobId));
    const good = parsed.records.filter(row => row.result.startsWith("READ_OK"));
    assert.equal(good.length, 2500); assert.equal(new Set(good.map(row => row.value)).size, 2500);
    const attempted = parsed.records.filter(row => row.ordinal);
    assert.equal(attempted.length, 2502, "Report retains every attempt including both unreadable responses");
    assert.equal(parsed.records.filter(row => row.result === "READ_ERROR").length, 2);
    assert.equal(parsed.records.filter(row => row.result === "VOID_TOTAL:2").length, 1);
    for (let index = 0; index < attempted.length; index++) assert.equal(attempted[index].ordinal, String(index + 1));
    const captured = [...runFrames.get(firstId), ...runFrames.get(secondId)].filter(row => row.epc && !row.omitted).map(row => row.epc);
    assert.deepEqual(good.map(row => row.value), captured);
    assert.ok(parsed.records.filter(row => !row.result.startsWith("READ_OK")).every(row => row.value === ""));
    const ledgerCsv = filesBelow(captureRoot).find(file => path.basename(file) === filename);
    assert.ok(ledgerCsv); assert.deepEqual(fs.readFileSync(ledgerCsv), csvBuffer);

    // The closed report remains downloadable after reload, without creating a new roll.
    await win.loadURL(origin);
    await poll(() => js("!!document.querySelector('[aria-label=\"Production roll history\"]')"), "Export history did not restore", 30000);
    await selectHistory(rollId);
    const repeatPath = path.join(runDir, "repeat-" + filename);
    await download("Tải lại CSV", repeatPath, filename);
    assert.deepEqual(fs.readFileSync(repeatPath), csvBuffer, "Re-download must return the original CSV artifact");
    assert.equal((await (await post("roll-list")).json()).rolls.length, 2, "History access and export must not create a roll");
    await js(panel + ".scrollIntoView({block:'start', behavior:'instant'})"); await delay(250);
    fs.writeFileSync(path.join(runDir, "finalized.png"), (await win.webContents.capturePage()).toPNG());
    // A new write-only roll verifies the actual written range, even when no
    // read field is enabled or printed in the template.
    const writeDoc = structuredClone(doc); writeDoc.id = "write-roll-qa"; writeDoc.name = "Write-only verification QA"; writeDoc.settings.copies = 3;
    writeDoc.settings.rfid = { ...writeDoc.settings.rfid, enabled: true, readEnabled: false, readBank: "TID", captureToHost: true, data: "{epc}" };
    writeDoc.elements[0].text = "WRITE QA";
    const expectedWrites = [epcFor(9001), epcFor(9002), epcFor(9003)];
    writeDoc.dataFeed = { columns: [{ id: "write-epc", name: "epc", width: 160, format: { type: "text" } }],
        rows: expectedWrites.map((epc, i) => ({ id: "write-row-" + i, cells: { "write-epc": epc } })) };
    await loadDoc(writeDoc);
    await poll(() => js("!!document.querySelector('[aria-label=\"Save roll CSV\"]')?.checked"), "Write-only CSV capture option is missing", 30000);
    await clickButton("Print 3 labels");
    await poll(async () => await counter("printer-valid", 3) && await counter("captured-epc", 2) && await counter("good", 2)
        && await js("document.body.innerText.includes('Saved 2 EPC write verifications.')"), "Write-only verification did not distinguish native VALID from matching EPCs");
    const writeRoll = (await (await post("roll-list")).json()).rolls.find(item => item.state === "open");
    assert.ok(writeRoll); rollId = writeRoll.rollId;
    view = await getRoll();
    assert.equal(view.roll.operationMode, "write"); assert.equal(view.roll.bank, "EPC");
    assert.equal(view.summary.printerValidCount, 3); assert.equal(view.summary.capturedEpcCount, 2); assert.equal(view.summary.goodCount, 2); assert.equal(view.summary.writeVerificationIssues, 1);
    assert.equal(view.summary.goodCountKnown, true, "A definitive rejected write must not make the two verified GOOD labels provisional");
    assert.equal(view.summary.writeMismatchCount, 1); assert.equal(view.summary.writeUnverifiedCount, 0);
    assert.equal(view.summary.removalReviewRequired, false);
    assert.equal(await js("document.querySelector('[data-testid=\"roll-good\"]').textContent.includes('(tạm)')"), false);
    const changedModeDoc = structuredClone(writeDoc); changedModeDoc.settings.rfid.readEnabled = true;
    await loadDoc(changedModeDoc); await assertPrintBlocked("Đã đổi chế độ đọc/ghi");
    assert.equal(runFrames.size, 4, "Mode mismatch must not send another write run");
    await loadDoc(writeDoc); await poll(() => counter("good", 2), "Write roll did not restore", 30000);
    await assertPrintBlocked("Tiếp tục cuộn cũ"); await resumeRoll();
    await showDetails("Tem đã loại");
    await fill("Removed rejected labels", 1);
    await clickButton("Lưu số tem loại");
    await poll(async () => (await getRoll()).summary.removedRejectedCount === 1, "Rejected removal did not persist", 30000);
    view = await getRoll();
    assert.equal(view.summary.goodCount, 2); assert.equal(view.summary.removedGoodCount, 0);
    assert.equal(view.summary.goodCountKnown, true, "Removing an already rejected write must not deduct GOOD");
    assert.equal(await js(`[...${panel}.querySelectorAll('button')].find(b => b.innerText.trim() === 'Lưu số tem loại').disabled`), true, "Unchanged cumulative totals must not request another UI save");
    const rejectedRevision = view.roll.revision;
    await post("roll-adjust", { rollId, removedGoodCount: 0, removedRejectedCount: 1 });
    view = await getRoll();
    assert.equal(view.summary.goodCount, 2); assert.equal(view.summary.removedRejectedCount, 1);
    assert.equal(view.roll.revision, rejectedRevision, "Repeating the same removal request is idempotent");
    // Retry the exact original source row, without changing the source data or
    // template; the new run has ordinal 1 but must retain source_row=2.
    await clickButton("From–To");
    await fill("From", 2); await fill("To", 2);
    await poll(() => js("document.querySelector('[data-testid=\"print-range-summary\"]')?.innerText.includes('Rows 2 → 2')"), "Exact failed source-row range was not selected", 30000);
    await clickButton("Print 1 label");
    await poll(async () => await counter("printer-valid", 4) && await counter("captured-epc", 3) && await counter("good", 3)
        && await js("document.body.innerText.includes('Saved 1 EPC write verifications.')"), "Retry of original source row 2 did not verify correctly");
    view = await getRoll();
    assert.equal(view.roll.runs.length, 2); assert.equal(view.summary.goodCountKnown, true);
    assert.equal(view.summary.writeMismatchCount, 1); assert.equal(view.summary.writeUnverifiedCount, 0);
    assert.equal(view.summary.removedRejectedCount, 1);
    const writeRetryFrames = runFrames.get([...runFrames.keys()][4]);
    assert.equal(writeRetryFrames.length, 1); assert.equal(writeRetryFrames[0].expected, expectedWrites[1]);
    assert.equal(writeRetryFrames[0].epc, expectedWrites[1]);
    await showDetails("Tem đã loại");
    await fill("Removed good labels", 1);
    await clickButton("Lưu số tem loại");
    await poll(() => counter("good", 2), "Removing one verified GOOD label must deduct exactly one", 30000);
    view = await getRoll();
    assert.equal(view.summary.removedGoodCount, 1); assert.equal(view.summary.removedRejectedCount, 1);
    assert.equal(view.summary.goodCountKnown, true); assert.equal(view.summary.goodCount, 2);
    await post("roll-adjust", { rollId, removedGoodCount: 1, removedRejectedCount: 1 });
    assert.equal((await getRoll()).summary.goodCount, 2, "Repeated cumulative removal must not deduct GOOD twice");
    await loadDoc(writeDoc);
    await poll(() => counter("good", 2), "Classified removals did not survive UI reload", 30000);
    await showDetails("Tem đã loại");
    assert.equal(await js("document.querySelector('[aria-label=\"Removed good labels\"]').value"), "1");
    assert.equal(await js("document.querySelector('[aria-label=\"Removed rejected labels\"]').value"), "1");
    await js(`[...${panel}.querySelectorAll('summary')].find(s => s.innerText.trim() === 'Tem đã loại').parentElement.open = false`);
    await closeRoll(getRoll);
    await showDetails("Lịch sử cuộn / xuất CSV");
    await fill("Production Job ID", businessJobId + "-WRITE"); await fill("Production roll number", 2); await fill("Production operator", "SIM-OPERATOR");
    await js(panel + ".scrollIntoView({block:'start',behavior:'instant'})"); await delay(250);
    fs.writeFileSync(path.join(runDir, "write-export-ready.png"), (await win.webContents.capturePage()).toPNG());
    const writePath = path.join(runDir, "write-export.csv");
    const writeFilename = await download("Xuất CSV", writePath);
    const writeCsv = parseCsv(fs.readFileSync(writePath, "utf8"));
    const verifiedWrites = writeCsv.records.filter(row => row.result.startsWith("WRITE_OK"));
    const mismatches = writeCsv.records.filter(row => row.result === "WRITE_MISMATCH");
    assert.equal(verifiedWrites.length, 3); assert.equal(mismatches.length, 1);
    assert.deepEqual(verifiedWrites.map(row => row.value), [expectedWrites[0], expectedWrites[2], expectedWrites[1]]);
    assert.ok(writeCsv.records.filter(row => row.ordinal).every(row => row.detail.startsWith("write;source_row=")));
    assert.ok(mismatches[0].detail.includes("expected=" + expectedWrites[1]));
    assert.ok(mismatches[0].detail.includes("source_row=2"));
    assert.ok(verifiedWrites[2].detail.includes("source_row=2"), "Retry preserves the original source row, not the new run ordinal");
    assert.deepEqual(writeCsv.metadata.find(row => row[0] === "Total").slice(0, 6), ["Total", "4", "Valid", "4", "Void", "0"]);
    assert.deepEqual(writeCsv.metadata.find(row => row[0] === "EPC saved").slice(0, 6), ["EPC saved", "3", "Removed GOOD", "1", "GOOD (quantity)", "2"]);
    assert.deepEqual(writeCsv.metadata.find(row => row[0] === "Removed rejected").slice(0, 6), ["Removed rejected", "1", "Write mismatches", "1", "Unverified writes", "0"]);
    assert.ok(!JSON.stringify(writeCsv.metadata).includes("GOOD is a provisional"), "A known rejection and classified removals must not leave a provisional GOOD warning");
    const writeRollId = rollId;
    assert.equal((await getRoll()).roll.state, "closed");
    // A head-open interruption occurs after three physical labels of a ten-
    // label request. Remaining queued formats are cancelled, not counted as
    // printed or missing EPCs. Repair then starts a fresh seven-label run.
    const faultDoc = structuredClone(doc); faultDoc.id = "material-fault-qa"; faultDoc.name = "Head-open recovery QA"; faultDoc.settings.copies = 10;
    await loadDoc(faultDoc);
    materialFaultAfter = 3;
    const clearCommandsBefore = commands.filter(command => command === "~JA").length;
    const frameRunsBeforeFault = runFrames.size;
    await clickButton("Print 10 labels");
    await poll(async () => materialFault && await counter("printer-valid", 3)
        && await js("document.body.innerText.includes('Printer stopped: check media, ribbon and printhead.')"), "Material fault did not stop the original run after three physical labels");
    const faultRoll = (await (await post("roll-list")).json()).rolls.find(item => item.state === "open");
    assert.ok(faultRoll); rollId = faultRoll.rollId;
    await poll(async () => {
        const current = await getRoll();
        return current.summary.activeRuns.length === 0 && current.summary.countsComplete && current.summary.goodCountKnown;
    }, "Paused, empty, stable fault run did not obtain final counter certainty", 30000);
    view = await getRoll();
    assert.equal(view.summary.printerValidCount, 3); assert.equal(view.summary.capturedEpcCount, 3);
    assert.equal(view.summary.goodCount, 3); assert.equal(view.summary.voidCount, 0);
    assert.equal(view.summary.missingEpcCount, 0, "Seven cancelled unsent formats must not become missing EPC records");
    assert.equal(view.summary.printerValidKnown, true); assert.equal(view.summary.goodCountKnown, true);
    assert.equal(view.roll.runs.length, 1); assert.equal(runFrames.size, frameRunsBeforeFault + 1);
    const faultRunId = [...runFrames.keys()][frameRunsBeforeFault];
    assert.equal(runFrames.get(faultRunId).length, 3);
    assert.ok(commands.filter(command => command === "~JA").length > clearCommandsBefore, "Material stop must request queue cancellation");
    await loadDoc(faultDoc);
    await poll(async () => await counter("good", 3) && await js("!document.querySelector('[data-testid=\"roll-good\"]').textContent.includes('(tạm)')"), "Final stopped-run count did not survive renderer reload", 30000);
    await assertPrintBlocked("Tiếp tục cuộn cũ"); await resumeRoll();
    await js(panel + ".scrollIntoView({block:'start',behavior:'instant'})"); await delay(250);
    fs.writeFileSync(path.join(runDir, "fault-reconciled.png"), (await win.webContents.capturePage()).toPNG());
    materialFault = false; materialFaultAfter = 0;
    await fill("Labels", 7);
    await clickButton("Print 7 labels");
    await poll(async () => await counter("printer-valid", 10) && await counter("captured-epc", 10) && await counter("good", 10)
        && await js("document.body.innerText.includes('Saved 7 EPC reads.')"), "Repaired printer did not append seven-label top-up to the same roll");
    view = await getRoll();
    assert.equal(view.roll.rollId, faultRoll.rollId); assert.equal(view.roll.runs.length, 2);
    assert.equal(view.summary.countsComplete, true); assert.equal(view.summary.goodCountKnown, true);
    assert.equal(view.summary.printerValidCount, 10); assert.equal(view.summary.capturedEpcCount, 10);
    assert.equal(view.summary.goodCount, 10); assert.equal(view.summary.missingEpcCount, 0);
    assert.equal(runFrames.get(faultRunId).length, 3, "Recovery must not replay the cancelled old run");
    assert.equal(runFrames.get([...runFrames.keys()].at(-1)).length, 7);
    await closeRoll(getRoll);
    await showDetails("Lịch sử cuộn / xuất CSV");
    await fill("Production Job ID", businessJobId + "-FAULT"); await fill("Production roll number", 3); await fill("Production operator", "SIM-OPERATOR");
    const faultPath = path.join(runDir, "fault-export.csv");
    const faultFilename = await download("Xuất CSV", faultPath);
    const faultCsv = parseCsv(fs.readFileSync(faultPath, "utf8"));
    assert.equal(faultCsv.records.filter(row => row.result.startsWith("READ_OK")).length, 10);
    assert.deepEqual(faultCsv.metadata.find(row => row[0] === "Total").slice(0, 6), ["Total", "10", "Valid", "10", "Void", "0"]);
    assert.ok(!JSON.stringify(faultCsv.metadata).includes("GOOD is a provisional"));
    assert.ok(!JSON.stringify(faultCsv.metadata).includes("Số đếm là dữ liệu đã ghi nhận"), "CSV must reflect durable settled counts after fault recovery");
    const faultRollId = rollId;
    assert.equal((await getRoll()).roll.state, "closed");
    assertEvidencePreserved(readEvidence);
    assert.equal(physicalLabels(), 2518, "Only requested physical simulator labels should exist across all independent batches");
    assert.ok(safetyCommands >= 1);
    const result = { businessJobId, rollId: readRollId, runs: [2500, 3], printerValid: 2501, capturedEpc: 2500, removedGood: 1, removedRejected: 0, good: 2500, missingEpc: 1, void: 2, compactColumns: parsed.header,
        templateAndModeProtected: true, writeOnlyVerified: true, writeRollId, writeFilename,
        writeCounts: { printerValid: 4, capturedEpc: 3, removedGood: 1, removedRejected: 1, good: 2, goodKnown: true, historicalMismatches: 1, unverified: 0 },
        rejectedRemovalDoesNotDeductGood: true, cumulativeRemovalIdempotent: true, exactWriteSourceRetry: 2,
        faultRollId, faultFilename, stoppedFaultCountsKnown: true, faultRuns: [3, 7], faultGood: 10,
        continuedAfterVoid: true, unreviewedTopupAllowed: true, reloadedOpenAndClosed: true, explicitExportOnly: true,
        captureOffOldRollDiscovered: true, explicitResumeAfterReload: true, closeIndependentOfExport: true,
        unsavedRemovalEditsProtected: true,
        closeEmittedNoPrinterCommands: true, closedHistorySurvivesReload: true, delayedHistoricalExport: true,
        freshRollId, freshFilename, freshSameEndpointBeforePriorExport: true, repeatedBusinessJobIdAllowed: true,
        foregroundPostSealLossRecoveredByActualPrintStep: true, postSealLossJobId, postSealStatusFailures,
        historicalCreatedAt: priorWeek, historicalRawEvidenceHashes: readEvidence, historicalRawEvidencePreserved: true, blockedAdmission: admissionError,
        staleSelectionAfterExternalCloseBlocked: true, clearNotSentUiStatus: true,
        plainCsvVerified: true, repeatedExportStable: true, counterResetAttempts: resetAttempts, filename, downloads,
        physicalSimulatorLabels: physicalLabels(), maxSimulatorQueueDelayMs, maxSimulatorFragmentDelayMs, maxSimulatorEventLoopLagMs, realConnector: true, hardwarePrinting: false, appVersion: runtimeManifest.web.packageVersion,
        connectorVersion: runtimeManifest.connector.version, connectorSha256: runtimeManifest.connector.sha256, runDir };
    fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(output, "latest-result.json"), JSON.stringify(result, null, 2));
    console.log("Packaged roll workflow passed: explicit old-roll resume/close with capture OFF, fresh batch before deferred CSV, same business Job ID, preserved raw hashes, exact repeated download; 2500 RFID attempts, write verification and head-open recovery.");
}
function close(code) {
    clearInterval(simulatorTimingTimer);
    logs += `\nSimulator timing: maxQueuedMs=${maxSimulatorQueueDelayMs}, maxFragmentMs=${maxSimulatorFragmentDelayMs}, maxEventLoopLagMs=${maxSimulatorEventLoopLagMs}\n`;
    fs.writeFileSync(path.join(runDir, "process.log"), logs);
    fs.writeFileSync(path.join(runDir, "simulator-commands.json"), JSON.stringify(commands, null, 2));
    if (win && !win.isDestroyed()) win.destroy();
    if (server) server.kill(); if (connector) connector.kill();
    for (const socket of sockets) socket.destroy();
    if (printerServer) printerServer.close();
    app.exit(code);
}
main().then(() => close(0)).catch(async error => {
    if (win && !win.isDestroyed()) {
        try { fs.writeFileSync(path.join(runDir, "failure.txt"), await win.webContents.executeJavaScript("document.body.innerText")); } catch { /* Preserve the original exception. */ }
        try { fs.writeFileSync(path.join(runDir, "failure.png"), (await win.webContents.capturePage()).toPNG()); } catch { /* Preserve the original exception. */ }
    }
    console.error(error, logs); close(1);
});
