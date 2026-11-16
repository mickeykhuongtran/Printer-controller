// Packaged renderer QA. Private profile and local server; printer/external requests are blocked.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const root = path.resolve(__dirname, ".."), output = path.join(root, "build/rfid-text-qa");
const web = path.join(root, "dist/win-unpacked/resources/web");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(output, "profile-")));
let win, server, serverLog = "";
const js = async code => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { console.error("Renderer QA command:", code.slice(0, 400)); throw error; }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { if (await fn()) return; await delay(100); }
    throw new Error(label);
}
const text = { id: "tail", kind: "text", text: "EPC: {rfid_read}", pos: { x: 3, y: 3 }, size: { w: 65, h: 8 },
    rotation: 0, font: "D", scaleX: 1, scaleY: 1, fontSizeMm: 3 };
const doc = { id: "rfid-text-qa", name: "RFID Text last N", settings: {
    widthMm: 80, heightMm: 40, gapMm: 3, dpi: 300, targetPrinterModel: "zt610r", copies: 1, speed: 4, darkness: 10,
    serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
    rfid: { enabled: false, chip: "epc_96", epcBits: 96, format: "H", retries: 3, block: 2, words: 6, data: "",
        readEnabled: true, readBank: "EPC", readFieldName: "rfid_read", zebraEpcReadMode: "pc", zebraModel: "zt610r", zebraUsePrinterSettings: true },
}, elements: [text,
    { ...text, id: "full", text: "Full: {rfid_read}", pos: { x: 3, y: 13 } },
    { id: "qr", kind: "qr", data: "{rfid_read}", pos: { x: 55, y: 20 }, size: { w: 18, h: 18 }, ecc: "M", cell: 4 },
    { id: "dm", kind: "datamatrix", data: "{rfid_read}", pos: { x: 32, y: 21 }, size: { w: 18, h: 18 },
        sizeMode: "manual", magnification: 4, minModuleMm: 0.15 },
] };
async function installStateProbe() {
    await js(`window.reviewState = () => {
        const paper = document.querySelector('[data-testid="designer-paper"]');
        let fiber = paper[Object.keys(paper).find(k => k.startsWith('__reactFiber$'))];
        while (fiber.return) fiber = fiber.return;
        const pending = [fiber.stateNode.current];
        while (pending.length) {
            const current = pending.pop(); let hook = current.memoizedState;
            while (hook && typeof hook === 'object') {
                if (hook.memoizedState?.present?.doc && hook.queue?.dispatch) return {state: hook.memoizedState.present, dispatch: hook.queue.dispatch};
                hook = hook.next;
            }
            if (current.sibling) pending.push(current.sibling);
            if (current.child) pending.push(current.child);
        }
        throw new Error('state unavailable');
    }; true;`);
}
async function chooseOutput(label) {
    await js(`document.querySelector('[aria-label="RFID text output"]').focus()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Space" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Space" });
    await poll(() => js(`!!document.querySelector('[role="option"]')`), "RFID output menu");
    await js(`(() => {
        const option = [...document.querySelectorAll('[role="option"]')].find(el => el.textContent === ${JSON.stringify(label)});
        option.focus();
    })()`);
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Return" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Return" });
}
async function main() {
    const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => {
        const p = probe.address().port; probe.close(() => resolve(p));
    }); });
    const origin = `http://127.0.0.1:${port}`;
    server = spawn("node", [path.join(web, "server.js")], { cwd: web, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, NODE_PATH: path.join(web, "standalone_modules"), PORT: String(port), HOSTNAME: "127.0.0.1",
            NODE_ENV: "production", NEXTWAVES_DEPLOYMENT_MODE: "desktop", NEXTWAVES_SERVER_TCP: "disabled", NEXTWAVES_DATA_DIR: path.join(output, "server-data") } });
    server.stdout.on("data", chunk => { serverLog += chunk; }); server.stderr.on("data", chunk => { serverLog += chunk; });
    await poll(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, "server ready");
    await app.whenReady();
    win = new BrowserWindow({ show: false, width: 1550, height: 1100,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
    win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel:
        !(details.url.startsWith(origin + "/") || /^(blob:|data:|devtools:)/.test(details.url)) }));
    await win.loadURL(origin);
    await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc, step: "edit", hasDoc: true, zoom: 8 }))})`);
    await win.loadURL(origin + "/?step=edit");
    await poll(() => js(`!!document.querySelector('[data-testid="designer-paper"] .cursor-move')`), "editor ready");
    await installStateProbe();
    const loadedDoc = await js(`structuredClone(reviewState().state.doc)`);
    await js(`reviewState().dispatch({type:'select',id:'tail'})`);
    await poll(() => js(`!!document.querySelector('[data-testid="rfid-text-format"]')`), "RFID Text controls");
    assert.equal(await js(`document.querySelector('[aria-label="RFID text output"]').textContent`), "All characters");
    await chooseOutput("Last N characters");
    await poll(() => js(`reviewState().state.doc.elements[0].rfidReadLastChars === 6`), "select last N defaults to six");
    await js(`reviewState().dispatch({type:'endEdit'})`);
    await poll(() => js(`document.querySelector('[data-testid="designer-paper"]').textContent.includes('EPC: FFFFFF')`), "six-character estimated preview");
    await js(`(() => { const input = document.querySelector('[aria-label="RFID last characters"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'4');
        input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await poll(() => js(`reviewState().state.doc.elements[0].rfidReadLastChars === 4`), "edit N through the input");
    await js(`reviewState().dispatch({type:'undo'})`);
    // Existing history coalesces consecutive changes on the same Text into one step.
    await poll(() => js(`reviewState().state.doc.elements[0].rfidReadLastChars === undefined`), "undo grouped Text edits");
    await js(`reviewState().dispatch({type:'redo'})`);
    await poll(() => js(`reviewState().state.doc.elements[0].rfidReadLastChars === 4`), "redo N");
    await js(`(() => { const input = document.querySelector('[aria-label="RFID last characters"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'6');
        input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await poll(() => js(`reviewState().state.doc.elements[0].rfidReadLastChars === 6`), "set final N to six");
    await js(`reviewState().dispatch({type:'beginEdit',id:'tail'})`);
    await poll(() => js(`!![...document.querySelectorAll('[data-testid="designer-paper"] textarea')].find(el=>el.value==='EPC: {rfid_read}')`), "inline editing retains raw RFID reference");
    await js(`reviewState().dispatch({type:'endEdit'})`);
    assert.deepEqual(await js(`reviewState().state.doc.settings.rfid`), loadedDoc.settings.rfid, "read/write settings untouched");
    assert.deepEqual(await js(`reviewState().state.doc.elements[2]`), loadedDoc.elements[2], "QR unchanged");
    assert.equal(await js(`reviewState().state.doc.elements[1].rfidReadLastChars`), undefined, "full Text unchanged");
    await poll(() => js(`JSON.parse(localStorage.getItem('zbre.print.session.v1')).doc.elements[0].rfidReadLastChars === 6`), "session persisted");
    fs.writeFileSync(path.join(output, "suffix-controls.png"), (await win.webContents.capturePage()).toPNG());
    await win.loadURL(origin + "/?step=edit");
    await poll(() => js(`!!document.querySelector('[data-testid="designer-paper"] .cursor-move')`), "reload editor after session hydration");
    await installStateProbe();
    assert.equal(await js(`reviewState().state.doc.elements[0].rfidReadLastChars`), 6, "N survives app reload");
    assert.equal(await js(`reviewState().state.doc.elements.find(el=>el.id==='dm').data`), "{rfid_read}",
        "Data Matrix still binds the complete EPC after changing the Text suffix");
    // Real-value preview and browser/PDF output on the packaged code.
    const withData = await js(`structuredClone(reviewState().state.doc)`);
    withData.dataFeed = { columns: [{ id: "epc", name: "rfid_read" }], rows: [
        { id: "row1", cells: { epc: "300833B2DDD90140000000AB" } },
        { id: "row2", cells: { epc: "300833B2DDD90140000000CD" } },
    ] };
    await js(`reviewState().dispatch({type:'load',doc:${JSON.stringify(withData)}})`);
    await js(`reviewState().dispatch({type:'feed/setPreviewRow',rowId:'row1'})`);
    await poll(() => js(`document.querySelector('[data-testid="designer-paper"]').textContent.includes('EPC: 0000AB')`), "actual tail preview");
    assert.ok(await js(`document.querySelector('[data-testid="designer-paper"]').textContent.includes('Full: 300833B2DDD90140000000AB')`));
    await js(`reviewState().dispatch({type:'beginEdit',id:'tail'})`);
    await poll(() => js(`!![...document.querySelectorAll('[data-testid="designer-paper"] textarea')].find(el=>el.value==='EPC: {rfid_read}')`), "row preview still edits the source RFID reference");
    await js(`reviewState().dispatch({type:'endEdit'})`);
    await poll(() => js(`document.querySelector('[data-testid="designer-paper"]').textContent.includes('EPC: 0000AB')`), "return from source editing to tail preview");
    fs.writeFileSync(path.join(output, "resolved-preview.png"), (await win.webContents.capturePage()).toPNG());
    await js(`[...document.querySelectorAll('ol button')].find(b => b.textContent.endsWith('Print')).click()`);
    await poll(() => js(`!![...document.querySelectorAll('summary')].find(el => el.textContent === 'More actions')`), "Print step");
    await js(`window.print = () => { window.pdfPages = [...document.querySelectorAll('.pdf-page')].map(page=>page.textContent.trim()); };
        [...document.querySelectorAll('summary')].find(s=>s.textContent==='More actions').parentElement.open=true;
        [...document.querySelectorAll('button')].find(b=>b.innerText==='Print via browser').click();`);
    await poll(() => js(`!!window.pdfPages`), "browser export");
    const pages = await js(`window.pdfPages`);
    assert.equal(pages.length, 2);
    assert.ok(pages[0].includes("EPC: 0000AB") && pages[0].includes("Full: 300833B2DDD90140000000AB"));
    assert.ok(pages[1].includes("EPC: 0000CD") && pages[1].includes("Full: 300833B2DDD90140000000CD"));

    // Exercise the shipped diagnostic template and the real packaged ZPL
    // download path, including bitmap/native overlays. No printer is contacted.
    await js(`[...document.querySelectorAll('ol button')].find(b => b.textContent.endsWith('Edit')).click()`);
    await poll(() => js(`!!document.querySelector('[data-testid="designer-paper"] .cursor-move')`), "return to editor");
    await installStateProbe();
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/RFID-Matrix24-Text6-check.nwl"), "utf8"));
    const fixtureWithData = { ...fixture, templateFields: [{ name: "rfid_read", value: "E280F30200000001744AC695" }] };
    await js(`reviewState().dispatch({type:'load',doc:${JSON.stringify(fixtureWithData)}})`);
    await poll(() => js(`(() => { const paper = document.querySelector('[data-testid="designer-paper"]');
        return paper && paper.textContent.includes('E280F30200000001744AC695') && paper.textContent.includes('4AC695'); })()`), "diagnostic fixture full and suffix preview");
    // DOM state can lead the offscreen Chromium compositor by a frame.
    await js(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))`);
    await delay(300);
    fs.writeFileSync(path.join(output, "diagnostic-template-preview.png"), (await win.webContents.capturePage()).toPNG());
    const epcLine = { ...text, id: "epc-line", text: "EPC: {rfid_read}", pos: { x: 3.668074324, y: 2.54761496 },
        size: { w: 35.472662332, h: 3 }, fontSizeMm: 2.5, wrapMode: "none", fitMode: "clip" };
    await js(`reviewState().dispatch({type:'load',doc:${JSON.stringify({ ...fixture, elements: [...fixture.elements, epcLine] })}});
        reviewState().dispatch({type:'updateSettings',patch:{contentRotation:180}});`);
    await poll(() => js("reviewState().state.doc.settings.contentRotation === 180"), "rotate EPC template");
    await js(`[...document.querySelectorAll('ol button')].find(b => b.textContent.endsWith('Print')).click()`);
    await poll(() => js(`!![...document.querySelectorAll('summary')].find(el => el.textContent === 'More actions')`), "fixture Print step");
    const downloadPath = path.join(output, "diagnostic-printer-read.zpl");
    let downloadFinished = false;
    win.webContents.session.once("will-download", (_event, item) => {
        item.setSavePath(downloadPath);
        item.once("done", (_doneEvent, state) => { downloadFinished = state === "completed"; });
    });
    await js(`[...document.querySelectorAll('summary')].find(s=>s.textContent==='More actions').parentElement.open=true;
        [...document.querySelectorAll('button')].find(b=>b.innerText==='Download .zpl').click();`);
    await poll(async () => downloadFinished, "packaged ZPL download");
    const downloadedZpl = fs.readFileSync(downloadPath, "utf8");
    // On this 720 x 480 dot page, the padded baseline (47,57) rotates to (673,423).
    assert.ok(downloadedZpl.includes("^FT673,423,0^A0I,30,30^FH\\^FE#^FDEPC: #1#^FS"), "EPC starts three dots inside the frame after 180-degree rotation");
    assert.ok(downloadedZpl.includes("#1,b,6,1##1,b,5,1##1,b,4,1##1,b,3,1##1,b,2,1##1,b,1,1#"));
    assert.ok(!downloadedZpl.includes("#1,b,1,6#"), "old range is absent from actual exported ZPL");
    assert.match(downloadedZpl, /\^BX[^\n]+\^FN1\^FS/, "Data Matrix uses the entire read field");
    assert.equal((downloadedZpl.match(/\^RFR/g) || []).length, 1);
    assert.doesNotMatch(downloadedZpl, /\^RFW|E280F30200000001744AC695/, "fixture reads each tag instead of encoding or baking in the sample");
    fs.writeFileSync(path.join(output, "results.json"), JSON.stringify({ version: require("../package.json").version, passed: true, pages,
        checks: ["legacy default", "UI select and N input", "undo", "raw inline edit", "source, QR and Data Matrix isolation", "reload persistence", "six-character preview", "two-row browser/PDF output", "diagnostic template", "packaged ZPL download: full Data Matrix and six single-character references"] }, null, 2));
    console.log("Packaged RFID Text UI passed: controls, undo, persistence, previews and two-row browser/PDF output.");
}
async function close(code) {
    fs.writeFileSync(path.join(output, "server.log"), serverLog);
    if (code && win && !win.isDestroyed()) {
        fs.writeFileSync(path.join(output, "failure.png"), (await win.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(output, "failure.txt"), await js("document.body.innerText"));
    }
    if (win && !win.isDestroyed()) win.destroy();
    if (server) server.kill();
    app.exit(code);
}
main().then(() => close(0)).catch(error => { console.error(error); close(1); });
