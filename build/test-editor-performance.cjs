// Regression test for editing a large DataFeed in the packaged renderer. Private profile;
// requests outside the private web server (including every printer) are blocked.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'build', 'editor-qa');
fs.mkdirSync(output, { recursive: true });
function makeDoc(rows = 2500, copies = rows) {
  return {
    id: 'editor-review', name: 'Editor performance review',
    settings: { widthMm: 80, heightMm: 45, gapMm: 3, dpi: 300, targetPrinterModel: 'zt610r', copies, speed: 4, darkness: 10,
      serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: '' },
      rfid: { enabled: false, chip: 'epc_96', epcBits: 96, format: 'H', retries: 3, block: 2, words: 6, data: '' } },
    elements: [
      { id: 'barcode', kind: 'barcode', pos: { x: 3, y: 3 }, size: { w: 65, h: 10 }, data: '{HEX}', symbology: 'CODE128', humanReadable: false, minModuleMm: 0.15 },
      { id: 'qr', kind: 'qr', pos: { x: 3, y: 18 }, size: { w: 23, h: 23 }, data: '{HEX}', ecc: 'M', cell: 3, sizeMode: 'auto', minModuleMm: 0.25 },
      { id: 'text', kind: 'text', pos: { x: 29, y: 20 }, size: { w: 45, h: 6 }, text: '{Name}', font: 'D', scaleX: 1, scaleY: 1, rotation: 0 },
    ],
    dataFeed: { columns: [{ id: 'hex', name: 'HEX' }, { id: 'name', name: 'Name' }], rows: Array.from({ length: rows }, (_, i) => ({ id: `row-${i}`, cells: { hex: (i + 1).toString(16).padStart(24, '0').toUpperCase(), name: `Tag ${i + 1}` } })) },
  };
}

const web = path.join(process.env.ZBRE_QA_RESOURCES || path.join(root, 'dist/win-unpacked/resources'), 'web');
app.setPath('userData', fs.mkdtempSync(path.join(output, 'electron-profile-')));
let win, server;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const js = code => win.webContents.executeJavaScript(code, true);
async function poll(fn, label) {
  const until = Date.now() + 90000;
  while (Date.now() < until) { if (await fn()) return; await pause(100); }
  throw new Error(label);
}
async function main() {
  const port = await new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  server = spawn('node', [path.join(web, 'server.js')], {
    cwd: web, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_PATH: path.join(web, 'standalone_modules'), PORT: String(port), HOSTNAME: '127.0.0.1', NODE_ENV: 'production', NEXTWAVES_DEPLOYMENT_MODE: 'desktop', NEXTWAVES_SERVER_TCP: 'disabled', NEXTWAVES_DATA_DIR: path.join(output, 'server-data') },
  });
  let log = '';
  server.stdout.on('data', data => { log += data; }); server.stderr.on('data', data => { log += data; });
  await poll(async () => { try { return (await fetch(origin)).ok; } catch { return false; } }, 'server ready');
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1600, height: 1100, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !(details.url.startsWith(origin + '/') || /^(blob:|data:|devtools:)/.test(details.url)) }));
  await win.loadURL(origin);
  const doc = makeDoc(2500, 1);
  await js(`localStorage.setItem('zbre.print.session.v1', ${JSON.stringify(JSON.stringify({ doc, step: 'edit', hasDoc: true, zoom: 8 }))});`);
  await win.loadURL(origin + '/?step=edit');
  await poll(() => js(`!!document.querySelector('[data-testid="designer-paper"] .cursor-move')`), 'editor ready');
  await js(`window.reviewState = () => {
    const paper = document.querySelector('[data-testid="designer-paper"]');
    let fiber = paper[Object.keys(paper).find(k => k.startsWith('__reactFiber$'))];
    while (fiber.return) fiber = fiber.return;
    const pending = [fiber.stateNode.current];
    while (pending.length) {
      const current = pending.pop();
      let hook = current.memoizedState;
      while (hook && typeof hook === 'object') {
        if (hook.memoizedState?.present?.doc && hook.queue?.dispatch) return { state: hook.memoizedState.present, dispatch: hook.queue.dispatch };
        hook = hook.next;
      }
      if (current.sibling) pending.push(current.sibling);
      if (current.child) pending.push(current.child);
    }
    throw new Error('history not found');
  }; void 0;`);
  await js(`window.originalFeed = reviewState().state.doc.dataFeed; void 0;`);
  const results = { versions: process.versions, rows: 2500, elements: ['CODE128', 'QR', 'text'], cases: [] };
  const maxEditMs = 1000; // Catch the multi-second batch compilation regression, tolerate CI jitter.
  async function moveCase(label) {
    await pause(400);
    const before = await js(`(() => {
      const paper = document.querySelector('[data-testid="designer-paper"]');
      const el = paper.querySelector('.cursor-move');
      const rect = el.getBoundingClientRect();
      return { x: Math.round(rect.left + 12), y: Math.round(rect.top + 12), left: parseFloat(el.style.left), copies: reviewState().state.doc.settings.copies };
    })()`);
    const delta = before.left === 40 ? -16 : 16; // Avoid the independent canvas-center snap.
    win.webContents.sendInputEvent({ type: 'mouseMove', x: before.x, y: before.y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: before.x, y: before.y, button: 'left', clickCount: 1 });
    await pause(100);
    await js(`window.moveResult = null; window.moveStarted = performance.now();
      window.moveTarget = document.querySelector('[data-testid="designer-paper"] .cursor-move');
      window.moveObserver = new MutationObserver(() => {
        const left = parseFloat(moveTarget.style.left);
        if (left !== ${before.left}) {
          const commitMs = performance.now() - moveStarted;
          moveObserver.disconnect();
          requestAnimationFrame(() => { window.moveResult = { commitMs, nextFrameMs: performance.now() - moveStarted, left }; });
        }
      }); moveObserver.observe(moveTarget, { attributes: true, attributeFilter: ['style'] });`);
    win.webContents.sendInputEvent({ type: 'mouseMove', x: before.x + delta, y: before.y, button: 'left' });
    await poll(() => js('!!window.moveResult'), '2 mm drag did not update');
    const result = await js('window.moveResult');
    win.webContents.sendInputEvent({ type: 'mouseUp', x: before.x + delta, y: before.y, button: 'left', clickCount: 1 });
    assert.equal(result.left, before.left + delta, 'exact 2 mm displacement at 8 px/mm');
    assert.ok(result.nextFrameMs < maxEditMs, `${label}: ${result.nextFrameMs.toFixed(1)} ms exceeded ${maxEditMs} ms`);
    results.cases.push({ label, copies: before.copies, ...result });
    process.stdout.write(JSON.stringify(results.cases.at(-1)) + '\n');
  }
  await moveCase('2500 rows, copies=1, drawer closed');
  await js(`reviewState().dispatch({type: 'feed/setOpen', open: true});`);
  await moveCase('2500 rows, copies=1, drawer open');
  const visibleRows = await js(`document.querySelectorAll('tbody tr').length`);
  await js(`[...document.querySelectorAll('ol button')].find(b => b.textContent.endsWith('Print')).click()`);
  await poll(() => js(`new URLSearchParams(location.search).get('step') === 'print' && JSON.parse(localStorage.getItem('zbre.print.session.v1')).doc.settings.copies === 2500`), 'Print step must persist copies=2500');
  await js(`[...document.querySelectorAll('ol button')].find(b => b.textContent.endsWith('Edit')).click()`);
  await poll(() => js(`!!document.querySelector('[data-testid="designer-paper"] .cursor-move')`), 'return to Edit');
  await js(`reviewState().dispatch({type:'feed/setOpen',open:false});`);
  await moveCase('Print -> Edit, copies=2500, drawer closed');
  await js(`reviewState().dispatch({type:'feed/setOpen',open:true});`);
  await moveCase('Print -> Edit, copies=2500, drawer open');
  // Use the same reducer action as the element properties panel to change QR content.
  const editResult = await js(`new Promise((resolve,reject) => {
    const el = document.querySelectorAll('[data-testid="designer-paper"] .cursor-move')[1];
    const started = performance.now();
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('QR edit timeout')); },10000);
    const observer = new MutationObserver(() => { observer.disconnect(); clearTimeout(timer); resolve({ commitMs: performance.now() - started }); });
    observer.observe(el, {childList:true,subtree:true,attributes:true});
    reviewState().dispatch({type:'updateElement', id:'qr', patch:{data:'HEX:{HEX}'}});
  })`);
  assert.ok(editResult.commitMs < maxEditMs, `QR edit stalled for ${editResult.commitMs} ms`);
  results.cases.push({ label: 'QR data edit with copies=2500', ...editResult });
  await js(`reviewState().dispatch({type:'feed/setPreviewRow',rowId:'row-2499'});`);
  await poll(() => js(`document.querySelector('[data-testid="designer-paper"]').textContent.includes('Tag 2500')`), 'last DataFeed row preview');
  const textResult = await js(`new Promise((resolve,reject) => {
    const el = document.querySelectorAll('[data-testid="designer-paper"] .cursor-move')[2];
    const started = performance.now();
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('text edit timeout')); }, 10000);
    const observer = new MutationObserver(() => {
      if (!el.textContent.includes('Name: Tag 2500')) return;
      observer.disconnect(); clearTimeout(timer); resolve({commitMs:performance.now()-started});
    });
    observer.observe(el, {childList:true,subtree:true,characterData:true});
    reviewState().dispatch({type:'updateElement',id:'text',patch:{text:'Name: {Name}'}});
  })`);
  assert.ok(textResult.commitMs < maxEditMs, `Text edit stalled for ${textResult.commitMs} ms`);
  results.cases.push({label:'Text data edit with copies=2500 and last row preview',...textResult});
  await js(`reviewState().dispatch({type:'undo'});`);
  await poll(() => js(`reviewState().state.doc.elements[2].text === '{Name}' && !document.querySelector('[data-testid="designer-paper"]').textContent.includes('Name: Tag 2500')`), 'undo text');
  await js(`reviewState().dispatch({type:'redo'});`);
  await poll(() => js(`document.querySelector('[data-testid="designer-paper"]').textContent.includes('Name: Tag 2500')`), 'redo text');
  const posResult = await js(`new Promise((resolve,reject) => {
    const el = document.querySelectorAll('[data-testid="designer-paper"] .cursor-move')[2];
    const started = performance.now();
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error('position edit timeout')); },10000);
    const observer = new MutationObserver(() => {
      if (el.style.left !== '248px') return;
      observer.disconnect(); clearTimeout(timer); resolve({commitMs:performance.now()-started});
    });
    observer.observe(el,{attributes:true,attributeFilter:['style']});
    reviewState().dispatch({type:'updateElement',id:'text',patch:{pos:{x:31,y:20}}});
  })`);
  assert.ok(posResult.commitMs < maxEditMs, `Text position edit stalled for ${posResult.commitMs} ms`);
  results.cases.push({label:'Text position +2 mm with copies=2500',...posResult});
  assert.ok(await js(`reviewState().state.doc.dataFeed === window.originalFeed`), 'object edits must retain the DataFeed reference');
  assert.deepEqual(await js(`reviewState().state.doc.dataFeed.rows`), doc.dataFeed.rows, 'all rows retain order, HEX and leading zeroes');
  assert.equal(await js(`reviewState().state.doc.settings.copies`), 2500, 'editing must not reduce the print quantity');
  assert.ok(visibleRows < 60, 'large DataFeed stays virtualized');
  fs.writeFileSync(path.join(output,'editor.png'), (await win.webContents.capturePage()).toPNG());
  // Exercise the browser/PDF path without opening a native dialog or printing.
  await js(`[...document.querySelectorAll('ol button')].find(b => b.textContent.endsWith('Print')).click()`);
  await poll(() => js(`!![...document.querySelectorAll('button')].find(b => b.innerText === 'From–To')`), 'Print range controls');
  await js(`[...document.querySelectorAll('button')].find(b => b.innerText === 'From–To').click()`);
  await poll(() => js(`!!document.querySelector('input[aria-label="From"]')`), 'From input');
  for (const [name, value] of [['From',5],['To',3]]) {
    await js(`(() => {
      const input=document.querySelector('input[aria-label="${name}"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'${value}');
      input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
  }
  await poll(() => js(`document.querySelector('[data-testid="print-range-summary"]').textContent.includes('3 labels')`), 'three descending PDF rows');
  await js(`window.print = () => { window.pdfPages = [...document.querySelectorAll('.pdf-page')].map(page=>page.textContent.trim()); };
    [...document.querySelectorAll('summary')].find(s=>s.textContent==='More actions').parentElement.open=true;
    [...document.querySelectorAll('button')].find(b=>b.innerText==='Print via browser').click();`);
  await poll(() => js('!!window.pdfPages'), 'PDF pages captured');
  assert.deepEqual(await js('window.pdfPages'), ['Name: Tag 5','Name: Tag 4','Name: Tag 3']);
  results.browserPrintRows = [5,4,3];
  results.visibleTableRowsWith2500Records = visibleRows;
  fs.writeFileSync(path.join(output, 'packaged-results.json'), JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(output, 'server.log'), log);
  process.stdout.write(JSON.stringify(results.cases.slice(-3)) + '\n');
  process.stdout.write('Packaged editor regression passed: 2,500 rows, Print -> Edit, barcode drag, QR/text edits, preview, undo/redo, preserved HEX order and descending browser/PDF pages.\n');
}
function close(code) { if (win && !win.isDestroyed()) win.destroy(); if (server) server.kill(); app.exit(code); }
main().then(() => close(0)).catch(error => { console.error(error); close(1); });
