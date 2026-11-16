// Exercise the packaged app using an isolated profile; never contact a printer.
const { app, BrowserWindow, nativeImage } = require("electron");
const fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const assert = require("node:assert/strict"), { spawn } = require("node:child_process");
const { inflateSync } = require("node:zlib");
const root = path.resolve(__dirname, ".."), output = path.join(__dirname, "image-qa");
const web = path.join(root, "dist/win-unpacked/resources/web");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(output, "ui-profile-")));
let win, server, serverLog = "";
const js = async code => {
    try { return await win.webContents.executeJavaScript(code, true); }
    catch (error) { console.error('Renderer QA command:',code.slice(0,700));throw error; }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(fn, label) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) { if (await fn()) return; await delay(100); }
    throw new Error(label);
}
const doc = { id: "image-qa", name: "Image proportions", settings: {
    widthMm: 60, heightMm: 40, gapMm: 3, dpi: 300, copies: 1, speed: 4, darkness: 10,
    serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: "" },
    rfid: { enabled: false, chip: "epc_96", epcBits: 96, format: "H", retries: 3, block: 2, words: 6, data: "", zebraUsePrinterSettings: true },
}, elements: [{ id: "logo", kind: "image", src: "", pos: { x: 2, y: 3 }, size: { w: 20, h: 20 }, threshold: 0, rotation: 0 }] };
async function probe() {
    await js(`window.reviewState = () => {
        const paper = document.querySelector('[data-testid="designer-paper"]');
        let fiber = paper[Object.keys(paper).find(k => k.startsWith('__reactFiber$'))];
        while (fiber.return) fiber = fiber.return;
        const pending = [fiber.stateNode.current];
        while (pending.length) {
            const current = pending.pop(); let hook = current.memoizedState;
            while (hook && typeof hook === 'object') {
                if (hook.memoizedState?.present?.doc && hook.queue?.dispatch) return {state:hook.memoizedState.present,dispatch:hook.queue.dispatch};
                hook = hook.next;
            }
            if (current.sibling) pending.push(current.sibling);
            if (current.child) pending.push(current.child);
        }
        throw new Error('state unavailable');
    }; true;`);
}
async function setNumber(label, value) {
    await js(`(() => {
        const input=[...document.querySelectorAll('label')].find(el=>el.textContent===${JSON.stringify(label)}).parentElement.querySelector('input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(String(value))});
        input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
}
async function importImage(name, w, h, sidebar = false, svg = false) {
    await js(`(() => {
        const canvas=document.createElement('canvas');canvas.width=${w};canvas.height=${h};
        canvas.getContext('2d').fillRect(0,0,canvas.width,canvas.height);
        const bytes=${svg ? `'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}"/></svg>'` : `Uint8Array.from(atob(canvas.toDataURL().split(',')[1]), c=>c.charCodeAt(0))`};
        const input=${sidebar ? `[...document.querySelectorAll('label')].find(el=>el.textContent.trim()==='Replace…').querySelector('input')` : `document.querySelector('[data-testid="designer-paper"] input[type="file"]')`};
        const transfer=new DataTransfer();transfer.items.add(new File([bytes],${JSON.stringify(name)},{type:${JSON.stringify(svg ? "image/svg+xml" : "image/png")}}));
        input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    })()`);
    await poll(() => js(`reviewState().state.doc.elements[0].fileName===${JSON.stringify(name)}`), "import " + name);
}
async function canvasBounds(selector, crop) {
    return js(`(() => {
        const canvas=document.querySelector(${JSON.stringify(selector)});if(!canvas)return null;
        const c=${JSON.stringify(crop)}||{x:0,y:0,w:canvas.width,h:canvas.height};
        const p=canvas.getContext('2d').getImageData(c.x,c.y,c.w,c.h).data;
        let x0=c.w,y0=c.h,x1=-1,y1=-1;
        for(let y=0;y<c.h;y++)for(let x=0;x<c.w;x++){
            const i=(y*c.w+x)*4;
            if((p[i]*p[i+3]+255*(255-p[i+3]))/255<128){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
        }
        return {x:x0,y:y0,w:x1-x0+1,h:y1-y0+1};
    })()`);
}
const imageCanvas = '[data-testid="designer-paper"] .cursor-move canvas';
async function expectEditor(ratio) {
    const el = await js('structuredClone(reviewState().state.doc.elements[0])');
    const fw = Math.round(el.size.w * 12), fh = Math.round(el.size.h * 12);
    const w = Math.round(Math.min(fw, fh * ratio)), h = Math.round(Math.min(fh, fw / ratio));
    const expected = { x: Math.round((fw - w) / 2), y: Math.round((fh - h) / 2), w, h };
    await poll(async () => JSON.stringify(await canvasBounds(imageCanvas)) === JSON.stringify(expected), 'editor preserves ratio '+ratio);
    return { el, expected };
}
async function main() {
    assert.equal(JSON.parse(fs.readFileSync(path.join(web, 'package.json'))).version, require('../package.json').version);
    const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => {
        const p = probe.address().port; probe.close(() => resolve(p));
    }); });
    const origin = `http://127.0.0.1:${port}`;
    server = spawn('node', [path.join(web, 'server.js')], { cwd: web, windowsHide: true, stdio: ['ignore','pipe','pipe'], env: {
        ...process.env, NODE_PATH:path.join(web,'standalone_modules'),PORT:String(port),HOSTNAME:'127.0.0.1',NODE_ENV:'production',
        NEXTWAVES_DEPLOYMENT_MODE:'desktop',NEXTWAVES_SERVER_TCP:'disabled',NEXTWAVES_DATA_DIR:path.join(output,'server-data'),
    } });
    server.stdout.on('data', chunk=>{serverLog+=chunk;});server.stderr.on('data',chunk=>{serverLog+=chunk;});
    await poll(async()=>{try{return (await fetch(origin)).ok;}catch{return false;}},'server ready');
    await app.whenReady();
    win = new BrowserWindow({show:false,width:1550,height:1100,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
    win.webContents.on('console-message',details=>{if(details.level==='error')console.error(details.message);});
    win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:
        !(details.url.startsWith(origin+'/')||/^(blob:|data:|devtools:)/.test(details.url))||/\/api\/print(?:\/|$)/.test(details.url)}));
    await win.loadURL(origin);
    await js(`localStorage.setItem('zbre.print.session.v1',${JSON.stringify(JSON.stringify({doc,step:'edit',hasDoc:true,zoom:8}))})`);
    await win.loadURL(origin+'/?step=edit');
    await poll(()=>js(`!!document.querySelector('[data-testid="designer-paper"] input[type="file"]')`),'editor ready');
    await probe();
    await poll(()=>js(`(() => {try {return !!reviewState().state.doc;}catch{return false;}})()`),'state hydration');
    await js(`reviewState().dispatch({type:'select',id:'logo'})`);
    await importImage('landscape.png',800,200);
    await expectEditor(4);
    assert.deepEqual(await js('reviewState().state.doc.elements[0].size'),{w:20,h:20},'initial import preserves authored frame');
    await setNumber('W (mm)',32);await setNumber('H (mm)',12);
    await expectEditor(4);
    assert.deepEqual(await js('reviewState().state.doc.elements[0].size'),{w:32,h:12});
    // Real mouse drag of the east handle, without a modifier key.
    const handle=await js(`(() => {const el=[...document.querySelectorAll('[data-testid="designer-paper"] .cursor-move > div')].find(el=>el.style.cursor==='ew-resize'&&el.style.right);const r=el.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...handle});
    win.webContents.sendInputEvent({type:'mouseDown',...handle,button:'left',clickCount:1});
    win.webContents.sendInputEvent({type:'mouseMove',x:handle.x+32,y:handle.y,button:'left'});
    win.webContents.sendInputEvent({type:'mouseUp',x:handle.x+32,y:handle.y,button:'left',clickCount:1});
    await poll(()=>js('reviewState().state.doc.elements[0].size.w>32'),'edge drag changes width');
    await expectEditor(4);
    const beforeReplace=await js('structuredClone(reviewState().state.doc.elements[0])');
    await delay(800); // Separate replacement from the resize history group.
    await importImage('portrait.png',200,800,true);
    await expectEditor(0.25);
    const afterReplace=await js('structuredClone(reviewState().state.doc.elements[0])');
    for(const key of ['size','pos','threshold','rotation'])assert.deepEqual(afterReplace[key],beforeReplace[key],`Replace preserves ${key}`);
    await js(`reviewState().dispatch({type:'undo'})`);
    await poll(()=>js(`reviewState().state.doc.elements[0].fileName==='landscape.png'`),'undo replacement');
    await expectEditor(4);
    await js(`reviewState().dispatch({type:'redo'})`);await expectEditor(0.25);
    await importImage('square.png',200,200,true);await expectEditor(1);
    await importImage('portrait.svg',200,800,true,true);await expectEditor(0.25);
    await importImage('landscape.png',800,200,true);const {el,expected}=await expectEditor(4);
    fs.writeFileSync(path.join(output,'editor.png'),(await win.webContents.capturePage()).toPNG());
    await poll(()=>js(`JSON.parse(localStorage.getItem('zbre.print.session.v1')).doc.elements[0].src===reviewState().state.doc.elements[0].src`),'save session');
    await win.loadURL(origin+'/?step=edit');
    await poll(()=>js(`!!document.querySelector('${imageCanvas}')`),'reload editor');await probe();await expectEditor(4);
    assert.deepEqual(await js('reviewState().state.doc.elements[0]'),JSON.parse(JSON.stringify(el)),'replacement persists without source or geometry changes');
    await js(`[...document.querySelectorAll('ol button')].find(b=>b.textContent.endsWith('Print')).click()`);
    await poll(()=>js(`!!document.querySelector('[data-testid="print-preview-card"] [data-preview-state="ready"] canvas')`),'Print preview ready');
    const absolute={...expected,x:expected.x+Math.round(el.pos.x*12),y:expected.y+Math.round(el.pos.y*12)};
    assert.deepEqual(await canvasBounds('[data-testid="print-preview-card"] canvas'),absolute,'packaged Print preview matches Edit');
    fs.writeFileSync(path.join(output,'print-preview.png'),(await win.webContents.capturePage()).toPNG());
    const downloadPath=path.join(output,'image-aspect.zpl');let downloaded=false;
    win.webContents.session.once('will-download',(_event,item)=>{item.setSavePath(downloadPath);item.once('done',(_event,state)=>{downloaded=state==='completed';});});
    await js(`[...document.querySelectorAll('summary')].find(s=>s.textContent==='More actions').parentElement.open=true;
        [...document.querySelectorAll('button')].find(b=>b.innerText==='Download .zpl').click();`);
    await poll(async()=>downloaded,'ZPL download');
    const zpl=fs.readFileSync(downloadPath,'utf8');
    const graphic=/~DG[^,]+,(\d+),(\d+),:Z64:([^:]+):/i.exec(zpl);
    assert.ok(graphic,'compressed full-label bitmap is present');
    const bytes=inflateSync(Buffer.from(graphic[3],'base64')),stride=Number(graphic[2]);
    assert.equal(bytes.length,Number(graphic[1]),'ZPL graphic byte count');
    let x0=720,y0=480,x1=-1,y1=-1;
    for(let y=0;y<bytes.length/stride;y++)for(let x=0;x<stride*8;x++)if(bytes[y*stride+(x>>3)]&(0x80>>(x&7))){
        x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
    }
    assert.deepEqual({x:x0,y:y0,w:x1-x0+1,h:y1-y0+1},absolute,'exported ZPL retains source proportions and placement');
    await js(`window.print=()=>{window.browserImage=document.querySelector('.pdf-page canvas')?.toDataURL();};
        [...document.querySelectorAll('button')].find(b=>b.innerText==='Print via browser').click();`);
    await poll(()=>js('!!window.browserImage'),'browser/PDF image render');
    const browserImage=await js('window.browserImage');
    const browserPng=Buffer.from(browserImage.split(',')[1],'base64');
    fs.writeFileSync(path.join(output,'browser-print.png'),browserPng);
    const decoded=nativeImage.createFromBuffer(browserPng),pixels=decoded.getBitmap(),{width,height}=decoded.getSize();
    x0=width;y0=height;x1=-1;y1=-1;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){
        const i=(y*width+x)*4;
        if(pixels[i+3]>127&&pixels[i]<128){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
    }
    assert.deepEqual({x:x0,y:y0,w:x1-x0+1,h:y1-y0+1},expected,'browser/PDF image preserves proportions');
    fs.writeFileSync(path.join(output,'ui-results.json'),JSON.stringify({passed:true,version:require('../package.json').version,expected:absolute,
        checks:['placeholder import','numeric W/H','edge resize','Replace different proportions','undo/redo','PNG/SVG replacement','session reload','Print preview','downloaded ZPL pixel bounds','browser/PDF image render']},null,2));
    console.log('Packaged image UI passed: import, resize, Replace, persistence, preview, ZPL and browser output.');
}
async function close(code) {
    fs.writeFileSync(path.join(output,'ui-server.log'),serverLog);
    if(code&&win&&!win.isDestroyed()){
        fs.writeFileSync(path.join(output,'ui-failure.png'),(await win.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(output,'ui-failure.txt'),await js('document.body.innerText'));
    }
    if(win&&!win.isDestroyed())win.destroy();if(server)server.kill();app.exit(code);
}
main().then(()=>close(0)).catch(error=>{console.error(error);close(1);});
