// End-to-end QA: packaged renderer + real connector + TCP printer simulator.
// The only printer destination is a listener on this computer's OWN private IP
// and an OS-assigned ephemeral port. No printer hardware can be addressed.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), net = require("node:net"), os = require("node:os");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "build/rfid-capture-qa");
const web = path.join(root, "dist/win-unpacked/resources/web");
fs.mkdirSync(output, { recursive: true });
const runDir = fs.mkdtempSync(path.join(output, "run-"));
app.setPath("userData", path.join(runDir, "profile"));
let win, server, connector, printerServer, logs = "", printerSocket;
let emitted = 0, paused = false, pauseSeen = false, mode = "normal", jobID;
let validCounter = 100, voidCounter = 10, totalCounter = 110;
const ordinals = [], formats = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function poll(fn, message, timeout = 240000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await fn()) return; await delay(100); }
    if (win) fs.writeFileSync(path.join(output, "failure.txt"), await js("document.body.innerText"));
    throw new Error(message);
}
async function freePort() {
    const probe = net.createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;
}
function child(command, args, options) {
    const proc = spawn(command, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
    proc.stdout.on("data", data => { logs += data; }); proc.stderr.on("data", data => { logs += data; }); return proc;
}
async function main() {
    const localAddresses = Object.values(os.networkInterfaces()).flat().filter(a => a.family === "IPv4" && !a.internal).map(a => a.address);
    const host = localAddresses.find(a => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a));
    assert.ok(host, "A private address of this computer is required for the simulator");
    printerServer = net.createServer(socket => {
        printerSocket = socket; let pending = ""; let outgoing = Promise.resolve();
        const send = text => { outgoing = outgoing.then(async () => {
            if (socket.destroyed) return;
            // Fragment the framing signature; host must not rely on packet boundaries.
            socket.write(text.slice(0, 2)); await delay(1); if (!socket.destroyed) socket.write(text.slice(2));
        }); };
        socket.on("error", () => {});
        socket.on("data", bytes => {
            pending += bytes.toString("ascii");
            for (;;) {
                pending = pending.replace(/^[\r\n ]+/, "");
                if (pending.startsWith("~HQES")) {
                    pending = pending.slice(5);
                    send(`\x02\r\nPRINTER STATUS\r\nERRORS: ${paused ? "1 00000000 00010000" : "0 00000000 00000000"}\r\nWARNINGS: 0 00000000 00000000\r\n\x03\r\n`);
                } else if (pending.startsWith("~HS")) {
                    pending = pending.slice(3);
                    send("\x02000,0,0,0251,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,1,2,6,0,00000000,1,001\x03\r\n\x021234,1\x03\r\n");
                } else if (pending.startsWith('! U1 getvar ') && pending.includes('\n')) {
                    const end = pending.indexOf('\n') + 1; const command = pending.slice(0, end); pending = pending.slice(end);
                    const value = command.includes('odometer.rfid.valid_resettable') ? validCounter
                        : command.includes('odometer.rfid.void_resettable') ? voidCounter
                        : command.includes('odometer.total_label_count') ? totalCounter : '?';
                    send(`"${value}"\r\n`);
                } else if (pending.startsWith("~PP")) { pending = pending.slice(3); paused = true; }
                else if (pending.startsWith("~JA")) { pending = pending.slice(3); }
                else if (pending.startsWith("^XA") && pending.includes("^XZ")) {
                    const end = pending.indexOf("^XZ") + 3; const zpl = pending.slice(0, end); pending = pending.slice(end);
                    const hv = zpl.match(/\^HV1,256,NWEP\|([^|]+)\|(\d+)\|,\|END_0D_0A,L\^FS/);
                    assert.ok(hv, "every label must carry a correlated host readback");
                    assert.match(zpl, /\^RFR,H,,,E\^FN1\^FS/); assert.match(zpl, /\^PQ1\b/); assert.ok(!zpl.includes("^RFW"));
                    assert.ok(zpl.indexOf("^JZN") >= 0 && zpl.indexOf("^JZN") < zpl.indexOf("^RFR"), "RFID formats must disable automatic error reprint before reading");
                    jobID = hv[1]; const ordinal = Number(hv[2]); ordinals.push(ordinal); formats.push(zpl); emitted++;
                    validCounter++; totalCounter++;
                    if (mode === 'void' && ordinal === 2) { voidCounter += 2; totalCounter += 2; }
                    if (mode === "normal" && emitted === 20) { paused = true; pauseSeen = true; }
                    const epc = ordinal.toString(16).toUpperCase().padStart(24, "0");
                    if (!(mode === "missing" && ordinal === 2)) send(`NWEP|${jobID}|${ordinal}|${epc}|END\r\n`);
                    if (mode === "duplicate" && ordinal === 2) send(`NWEP|${jobID}|${ordinal}|${epc}|END\r\n`);
                } else break;
            }
        });
    });
    await new Promise(resolve => printerServer.listen(0, host, resolve));
    const printerPort = printerServer.address().port;
    assert.notEqual(printerPort, 9100); assert.ok(localAddresses.includes(printerServer.address().address));
    const connectorPort = await freePort(), connectorOrigin = `http://127.0.0.1:${connectorPort}`;
    const connectorExe = path.join(root, "dist/win-unpacked/resources/connector/ZbrePrinterLocalPrintAgent-windows-x64.exe");
    connector = child(connectorExe, ["--port", String(connectorPort), "--tcp-ports", String(printerPort), "--state-file", path.join(runDir, "connector/paired-origins.json")]);
    await poll(async () => { try { const health = await (await fetch(connectorOrigin + "/v1/health")).json(); return health.version === "0.7.0" && health.capabilities.rfidCaptureV1 && health.capabilities.productionRollV1 && health.capabilities.tcpServiceFaultLatchV1; } catch { return false; } }, "Connector 0.7.0 with production/fault capabilities not ready", 30000);
    const port = await freePort(), origin = `http://127.0.0.1:${port}`;
    server = child("node", [path.join(web, "server.js")], { cwd: web, env: { ...process.env, NODE_PATH: path.join(web, "standalone_modules"), PORT: String(port), HOSTNAME: "127.0.0.1", NODE_ENV: "production", NEXTWAVES_DEPLOYMENT_MODE: "desktop", NEXTWAVES_SERVER_TCP: "disabled", NEXTWAVES_INTEGRATION_API_KEY: "", NEXTWAVES_DATA_DIR: path.join(runDir, "server-data") } });
    await poll(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, "Web server not ready", 30000);
    await app.whenReady();
    win = new BrowserWindow({ show: false, width: 1480, height: 1100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url.startsWith(origin + "/") || details.url.startsWith(connectorOrigin + "/") || /^(blob:|data:|devtools:)/.test(details.url)) }));
    const doc = { id: "rfid-capture-qa", name: "EPC read and capture QA", settings: { widthMm: 60, heightMm: 20, gapMm: 3, dpi: 203, targetPrinterModel: "zt610r", copies: 3001, speed: 4, darkness: 10,
        serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
        rfid: { enabled: false, readEnabled: true, captureToHost: true, readBank: "EPC", readFieldName: "rfid_read", zebraEpcReadMode: "pc", zebraModel: "zt610r", zebraUsePrinterSettings: true, chip: "epc_96", epcBits: 96, format: "H", retries: 3, block: 2, words: 6, data: "" } },
        elements: [{ id: "read-text", kind: "text", text: "EPC: {rfid_read}", pos: { x: 2, y: 2 }, size: { w: 56, h: 7 }, rotation: 0, font: "D", scaleX: 1, scaleY: 1 }] };
    const loadDoc = async count => {
        doc.settings.copies = count;
        await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc, step: "print", hasDoc: true }))}); localStorage.setItem('zbre.print.printer.v1', ${JSON.stringify(JSON.stringify({ connectionMode: "tcp", tcpHost: host, tcpPort: printerPort, tcpExecutionMode: "connector", printAgentUrl: connectorOrigin, language: "zpl" }))});`);
        // This harness exercises legacy technical sessions, including >2500.
        // Production roll admission/finalization has its own separate QA suite.
        await js(`localStorage.setItem(${JSON.stringify(`zbre.production-roll.v1:${connectorOrigin}`)}, JSON.stringify({enabled:false}));`);
        await win.loadURL(origin);
        await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'Print ${count} labels' && !b.disabled)`), `Print ${count} unavailable`, 30000);
        assert.equal(await js(`document.querySelector('[aria-label="Production roll"] input[type="checkbox"]').checked`), false, "Legacy QA must explicitly select technical mode");
    };
    await win.loadURL(origin); await loadDoc(3001);
    await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'Print 3001 labels').click()`);
    await poll(() => js(`document.body.innerText.includes('Printer paused')`), "Pause not shown", 30000);
    assert.ok(pauseSeen);
    assert.equal(await js(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Edit again').disabled`), true);
    await js(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Edit again').click()`);
    assert.ok(await js(`!![...document.querySelectorAll('button')].find(b=>b.innerText==='Cancel batch')`));
    paused = false;
    await poll(() => js(`document.body.innerText.includes('Saved 3001 EPC reads.')`), "3001-label capture did not complete");
    assert.deepEqual(ordinals, Array.from({ length: 3001 }, (_, i) => i + 1));
    const post = async body => { const response = await fetch(connectorOrigin + "/v1/tcp/job", { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify(body) }); assert.ok(response.ok); return response; };
    const firstID = jobID;
    const evidenceRoot = path.join(runDir, "connector/rfid-sessions");
    const evidenceFiles = fs.readdirSync(evidenceRoot, { recursive: true });
    assert.ok(evidenceFiles.some(file => path.basename(file) === "reads.csv"), "Internal read evidence must survive without an export");
    assert.ok(!evidenceFiles.some(file => path.basename(file) === "results.csv" || /_epc_Read_.*\.csv$/.test(path.basename(file))), "Do not automatically materialize an operator CSV report at run completion");
    // Report generation is explicitly requested here, as by an operator Export.
    const exported = await post({ action: "capture-export", jobId: firstID });
    const exportFileName = exported.headers.get("content-disposition").match(/filename="([^"]+)"/)[1];
    assert.match(exportFileName, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_epc_Read_[a-f0-9]{12}\.csv$/);
    const csv = await exported.text();
    const csvLines = csv.trim().split(/\r?\n/); assert.equal(csvLines.length, 3004);
    for (let i = 1; i <= 3001; i++) { const row = csvLines[i].split(","); assert.equal(row[1], String(i)); assert.equal(row[4], i.toString(16).toUpperCase().padStart(24, "0")); assert.equal(row[6], "READ_OK"); assert.match(row[5], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/); }
    assert.ok(csv.includes(',VOID_TOTAL,batch_void_total,0,'));
    assert.ok(csv.includes(',MATCHED,session_summary,3001,'));
    fs.writeFileSync(path.join(output, "complete-3001.csv"), csv);
    await js(`[...document.querySelectorAll('summary')].find(s=>s.innerText==='RFID session history').click()`);
    await poll(() => js(`document.body.innerText.includes('3001/3001 label reads')`), "History not displayed", 30000);
    const downloadPath = path.join(output, "downloaded-3001.csv");
    const download = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CSV download did not finish")), 30000);
        win.webContents.session.once("will-download", (_event, item) => {
            assert.equal(item.getFilename(), exportFileName, "UI and connector must agree on the dated session filename");
            item.setSavePath(downloadPath);
            item.once("done", (_event, state) => {
                clearTimeout(timer);
                state === "completed" ? resolve() : reject(new Error(`CSV download ${state}`));
            });
        });
    });
    await js(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Download CSV').click()`);
    await download;
    assert.equal(fs.readFileSync(downloadPath, "utf8"), csv);
    await js(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Clear view').click()`);
    await poll(() => js(`![...document.querySelectorAll('button')].some(b=>b.innerText==='Download CSV')`), 'Clear view did not hide session', 5000);
    assert.equal(await (await post({ action: 'capture-export', jobId: firstID })).text(), csv, 'Clear view deleted or altered saved data');
    await js(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Refresh').click()`);
    await delay(250);
    assert.equal(await js(`[...document.querySelectorAll('button')].some(b=>b.innerText==='Download CSV')`), false, 'Refresh must not undo Clear view');
    await js(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Show latest').click()`);
    await js(`[...document.querySelectorAll('summary')].find(s=>s.innerText==='RFID session history').closest('details').scrollIntoView({block:'center',behavior:'instant'})`);
    await delay(250);
    fs.writeFileSync(path.join(output, "complete.png"), (await win.webContents.capturePage()).toPNG());
    mode = 'void'; emitted = 0; await loadDoc(3);
    await js(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Print 3 labels').click()`);
    await poll(() => js(`document.body.innerText.includes('Saved 3 EPC reads.')`), 'Batch with aggregate VOID did not reconcile', 30000);
    const voidReport = await (await post({ action: 'capture-export', jobId: jobID })).text();
    assert.ok(voidReport.includes(',VOID_TOTAL,batch_void_total,2,'));
    assert.ok(voidReport.includes(',MATCHED,session_summary,3,'));
    fs.writeFileSync(path.join(output, 'void.csv'), voidReport);
    await js(`[...document.querySelectorAll('summary')].find(s=>s.innerText==='RFID session history').click()`);
    await poll(() => js(`document.body.innerText.includes('3/3 label reads')`), 'Latest session not visible', 5000);
    assert.equal(await js(`[...document.querySelectorAll('button')].filter(b=>b.innerText==='Download CSV').length`), 1);
    // Missing and repeated replies must leave a downloadable partial history.
    for (const nextMode of ["missing", "duplicate"]) {
        mode = nextMode; emitted = 0; await loadDoc(3);
        await js(`[...document.querySelectorAll('button')].find(b=>b.innerText==='Print 3 labels').click()`);
        await poll(() => js(`document.body.innerText.includes('Printing was interrupted.')`), `${mode} falsely completed`, 60000);
        const history = await (await post({ action: "capture-list" })).json();
        const current = history.sessions.find(s => s.jobId === jobID);
        assert.ok(current && current.state !== "complete");
        if (mode === "missing") assert.equal(current.uniqueLabels, 2); else assert.ok(current.issues > 0);
        const partial = await (await post({ action: "capture-export", jobId: jobID })).text(); fs.writeFileSync(path.join(output, mode + ".csv"), partial);
        // Close this isolated fake-printer job after inspecting its preserved history.
        const polled = await (await post({ action: "poll", jobId: jobID })).json();
        await post({ action: "reconcile", jobId: jobID, confirmed: true, reconciliationNote: "Simulator only: no hardware, inspected missing/duplicate readback case", expectedSequence: polled.nextSequence - 1, expectedBytes: polled.cumulativeBytes, checkpointHash: polled.checkpointHash });
        await js(`Object.keys(localStorage).filter(k=>k.startsWith('zbre.tcp-recovery.v1:')).forEach(k=>localStorage.removeItem(k))`);
    }
    fs.writeFileSync(path.join(output, "result.json"), JSON.stringify({ labels: 3001, completeCsvRows: 3001, aggregateVoidDetected: 2, latestOnly: true, clearViewPreservesFiles: true, manualExportOnly: true, productionMode: false, exportFileName, sequential: true, missingDetected: true, duplicateDetected: true, navigationBlockedDuringPrint: true, realConnector: true, hardwarePrinting: false, runDir }, null, 2));
    console.log("Packaged RFID capture passed: 3001 ordered reads, durable internal evidence, manual CSV export, Pause/navigation guard, missing and duplicate responses detected.");
}
function close(code) { if (win) win.destroy(); if (server) server.kill(); if (connector) connector.kill(); if (printerSocket) printerSocket.destroy(); if (printerServer) printerServer.close(); app.exit(code); }
main().then(() => close(0)).catch(error => { console.error(error, logs); close(1); });
