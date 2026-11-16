// Real packaged renderer, isolated storage, no printer/network side effects.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const assert = require('node:assert/strict'), {spawn} = require('node:child_process'), {inflateSync} = require('node:zlib');
const root=path.resolve(__dirname,'..'), output=path.join(__dirname,'rotation-qa');
const web=path.join(root,'dist/win-unpacked/resources/web');
fs.mkdirSync(output,{recursive:true});
app.setPath('userData',fs.mkdtempSync(path.join(output,'ui-profile-')));
let win,server,serverLog='';
const errors=[];
const js=code=>win.webContents.executeJavaScript(code,true);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function poll(fn,label){const end=Date.now()+45_000;while(Date.now()<end){if(await fn())return;await delay(100);}throw new Error(label);}
const doc={id:'rotation-ui',name:'Template rotation 3.8.0',settings:{widthMm:60,heightMm:40,gapMm:3,dpi:300,copies:1,speed:4,darkness:10,
    serial:{enabled:false,start:1,step:1,pad:4,prefix:''},
    rfid:{enabled:false,chip:'epc_96',epcBits:96,format:'H',retries:3,block:2,words:6,data:'',zebraUsePrinterSettings:true}},
    elements:[{id:'text',kind:'text',text:'Nextwaves\nAntenna RFID',pos:{x:4,y:3},size:{w:28,h:8},rotation:0,
        font:'D',scaleX:1,scaleY:1,fontSource:'system',fontFamily:'Arial',fontSizeMm:3,align:'center',wrapMode:'word',fitMode:'shrink'},
    {id:'image',kind:'image',pos:{x:40,y:3},size:{w:14,h:8},rotation:0,threshold:0,
        src:'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 40"><path d="M0 0H12V28H80V40H0Z"/></svg>')},
    {id:'matrix',kind:'datamatrix',pos:{x:3,y:20},size:{w:14,h:14},data:'NWS-RFID-1234',rotation:0},
    {id:'table',kind:'table',pos:{x:25,y:22},size:{w:24,h:12},rotation:0,rows:2,cols:2,cells:['A','B','C','D'],
        colWidths:[8,16],rowHeights:[5,7],scaleMode:'all',fontSizeMm:2,padding:1,borderThickness:0.25},
    {id:'separator',kind:'line',pos:{x:38,y:3},size:{w:3,h:8},thickness:0.25,orientation:'v',strokeAnchor:'start'}]};
async function probe(){await js(`window.reviewState=()=>{
    const paper=document.querySelector('[data-testid="designer-paper"]');
    let fiber=paper[Object.keys(paper).find(k=>k.startsWith('__reactFiber$'))];
    while(fiber.return)fiber=fiber.return;const pending=[fiber.stateNode.current];
    while(pending.length){const current=pending.pop();let hook=current.memoizedState;
        while(hook&&typeof hook==='object'){if(hook.memoizedState?.present?.doc&&hook.queue?.dispatch)return{state:hook.memoizedState.present,dispatch:hook.queue.dispatch};hook=hook.next;}
        if(current.sibling)pending.push(current.sibling);if(current.child)pending.push(current.child);}
    throw new Error('state unavailable');};true;`);}
async function orientation(angle){
    await js(`[...document.querySelectorAll('[aria-label="Template rotation"] button')].find(b=>b.textContent==='${angle}°').click()`);
    await poll(()=>js(`(reviewState().state.doc.settings.contentRotation??0)===${angle}`),'rotation '+angle);
    assert.equal(await js(`document.querySelector('[aria-label="Template rotation"] button[aria-pressed="true"]').textContent`),angle+'°');
}
async function frameMatches(editing=false){
    const result=await js(`(()=>{const box=document.querySelector('[data-element-id="text"]');
        const content=${editing?'box.querySelector("textarea")':'box.firstElementChild.firstElementChild'};
        const a=box.getBoundingClientRect(),b=content.getBoundingClientRect();
        const paper=document.querySelector('[data-testid="designer-paper"]');
        const pxPerMm=paper.getBoundingClientRect().width/reviewState().state.doc.settings.widthMm;
        const inkArea=box.querySelector('[data-text-content]')?.getBoundingClientRect();
        const margins=inkArea ? [inkArea.left-a.left, inkArea.top-a.top, a.right-inkArea.right, a.bottom-inkArea.bottom]
            : [parseFloat(getComputedStyle(content).paddingLeft)];
        return {frame:[a.x,a.y,a.width,a.height],content:[b.x,b.y,b.width,b.height],overflow:getComputedStyle(content).overflow,
            margins:margins.map(p=>p/pxPerMm), mm:reviewState().state.doc.elements.find(e=>e.id==='text').marginMm};})()`);
    result.frame.forEach((v,i)=>assert.ok(Math.abs(v-result.content[i])<0.1,'text/frame match '+JSON.stringify(result)));
    result.margins.forEach(v=>assert.ok(Math.abs(v-result.mm)<0.02,'rotated text margin '+JSON.stringify(result)));
    assert.equal(result.overflow,'hidden');
}
async function download(file,code){
    let done=false;
    win.webContents.session.once('will-download',(_event,item)=>{item.setSavePath(path.join(output,file));item.once('done',(_e,s)=>{done=s==='completed';});});
    await js(code);await poll(()=>done,'download '+file);
    return fs.readFileSync(path.join(output,file),'utf8');
}
const canvasBits=`window.canvasBits=canvas=>{
    const w=canvas.width,h=canvas.height,p=canvas.getContext('2d').getImageData(0,0,w,h).data;
    const stride=Math.ceil(w/8),bytes=new Uint8Array(stride*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=(y*w+x)*4;
        const l=(p[i]*299+p[i+1]*587+p[i+2]*114)/1000;
        if((l*p[i+3]+255*(255-p[i+3]))/255<128)bytes[y*stride+(x>>3)]|=0x80>>(x&7);}
    let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);
    return {w,h,stride,data:btoa(binary)};
};true;`;
async function main(){
    assert.equal(JSON.parse(fs.readFileSync(path.join(web,'package.json'))).version,JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version);
    const port=await new Promise(resolve=>{const p=net.createServer();p.listen(0,'127.0.0.1',()=>{const port=p.address().port;p.close(()=>resolve(port));});});
    const origin='http://127.0.0.1:'+port;
    server=spawn('node',[path.join(web,'server.js')],{cwd:web,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,
        NODE_PATH:path.join(web,'standalone_modules'),PORT:String(port),HOSTNAME:'127.0.0.1',NODE_ENV:'production',
        NEXTWAVES_DEPLOYMENT_MODE:'desktop',NEXTWAVES_SERVER_TCP:'disabled',NEXTWAVES_DATA_DIR:path.join(output,'server-data')}});
    server.stdout.on('data',c=>{serverLog+=c;});server.stderr.on('data',c=>{serverLog+=c;});
    await poll(async()=>{try{return(await fetch(origin)).ok;}catch{return false;}},'server ready');
    await app.whenReady();
    win=new BrowserWindow({show:false,width:1600,height:1100,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});
    win.webContents.on('console-message',details=>{if(details.level==='error'&&!details.message.includes('ERR_BLOCKED_BY_CLIENT'))errors.push(details.message);});
    win.webContents.session.webRequest.onBeforeRequest((d,cb)=>cb({cancel:!(d.url.startsWith(origin+'/')||/^(blob:|data:|devtools:)/.test(d.url))||/\/api\/(printer|print)(?:\/|$)/.test(d.url)}));
    await win.loadURL(origin);
    await js(`localStorage.setItem('zbre.print.session.v1',${JSON.stringify(JSON.stringify({doc,step:'edit',hasDoc:true,zoom:8}))})`);
    await win.loadURL(origin+'/?step=edit');
    await poll(()=>js(`!!document.querySelector('[aria-label="Template rotation"]')`),'editor ready');await probe();
    const initial=await js('structuredClone(reviewState().state.doc)');
    for(const angle of [0,90,180,270,0]){
        await orientation(angle);await js(`reviewState().dispatch({type:'select',id:'text'})`);await delay(100);await frameMatches();
        const current=await js('structuredClone(reviewState().state.doc)');
        assert.equal(current.settings.widthMm,angle===90||angle===270?40:60);
        assert.equal(current.settings.heightMm,angle===90||angle===270?60:40);
        const stroke=await js(`(()=>{const paper=document.querySelector('[data-testid="designer-paper"]'),box=paper.querySelector('[data-element-id="separator"]'),ink=box.firstElementChild.firstElementChild;
            const p=paper.getBoundingClientRect(),r=ink.getBoundingClientRect(),s=p.width/reviewState().state.doc.settings.widthMm;
            return [(r.x-p.x)/s,(r.y-p.y)/s,r.width/s,r.height/s];})()`);
        const expectedStroke={0:[38,3,0.25,8],90:[29,38,8,0.25],180:[21.75,29,0.25,8],270:[3,21.75,8,0.25]}[angle];
        expectedStroke.forEach((v,i)=>assert.ok(Math.abs(v-stroke[i])<0.01,'separator stays between logos at '+angle));
        await js(`document.querySelector('[data-element-id="text"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
        await poll(()=>js(`!!document.querySelector('[data-element-id="text"] textarea')`),'text editing');await frameMatches(true);
        await js(`document.querySelector('[data-element-id="text"] textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
        await poll(()=>js(`!document.querySelector('[data-element-id="text"] textarea')`),'text edit ends');
        await delay(200);
        fs.writeFileSync(path.join(output,'editor-'+angle+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    const roundTrip=await js('structuredClone(reviewState().state.doc)');
    assert.deepEqual(roundTrip,initial,'UI full cycle preserves template');
    // Use the real margin input and keep the custom value through NWL export and session reload.
    assert.equal(initial.elements[0].marginMm, 0.25, 'older template gets the protective margin');
    await js(`(()=>{const input=document.querySelector('[aria-label="Text margin (mm)"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'0.5');
        input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await poll(()=>js("reviewState().state.doc.elements[0].marginMm===0.5"),'custom margin');
    await frameMatches();
    // Individual rotation uses the same visible physical frame.
    for(const angle of [90,180,270,0]){
        await js(`reviewState().dispatch({type:'updateElement',id:'text',patch:{rotation:${angle}}})`);await delay(100);await frameMatches();
    }
    await orientation(90);
    await js(`document.querySelector('button[title^="Undo"]').click()`);
    await poll(()=>js(`reviewState().state.doc.settings.contentRotation===0`),'undo template rotation');
    await js(`document.querySelector('button[title^="Redo"]').click()`);
    await poll(()=>js(`reviewState().state.doc.settings.contentRotation===90`),'redo template rotation');
    // The rotated table's hit-testing and separator drags use local axes.
    await js(`reviewState().dispatch({type:'select',id:'table'})`);await delay(100);
    await js(`(()=>{const box=document.querySelector('[data-element-id="table"]'),r=box.getBoundingClientRect();
        const scale=r.width/12;box.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,clientX:r.x+9.5*scale,clientY:r.y+16*scale}));})()`);
    await poll(()=>js(`document.querySelector('[data-element-id="table"] textarea')?.value==='B'`),'rotated table selects the correct cell');
    await js(`document.querySelector('[data-element-id="table"] textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await poll(()=>js(`!document.querySelector('[data-element-id="table"] textarea')`),'table edit ends');
    const separator=await js(`(()=>{const r=document.querySelector('[data-element-id="table"] [title="Drag to resize column"]').getBoundingClientRect();return{x:Math.round(r.x+r.width*0.2),y:Math.round(r.y+r.height/2)}})()`);
    for(const event of [{type:'mouseMove',...separator},{type:'mouseDown',...separator,button:'left',clickCount:1},{type:'mouseMove',x:separator.x,y:separator.y+8,button:'left'},{type:'mouseUp',x:separator.x,y:separator.y+8,button:'left',clickCount:1}])win.webContents.sendInputEvent(event);
    await poll(()=>js(`reviewState().state.doc.elements.find(e=>e.id==='table').colWidths[0]>8`),'rotated column separator follows vertical drag');
    await js(`reviewState().dispatch({type:'select',id:'text'});if(reviewState().state.snapToGrid)reviewState().dispatch({type:'toggleSnap'});`);await delay(100);
    const before=await js('structuredClone(reviewState().state.doc.elements[0])');
    const center=await js(`(()=>{const r=document.querySelector('[data-element-id="text"]').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for(const event of [{type:'mouseMove',...center},{type:'mouseDown',...center,button:'left',clickCount:1},{type:'mouseMove',x:center.x-16,y:center.y+8,button:'left'},{type:'mouseUp',x:center.x-16,y:center.y+8,button:'left',clickCount:1}])win.webContents.sendInputEvent(event);
    await poll(()=>js(`reviewState().state.doc.elements[0].pos.x!==${before.pos.x}`),'drag rotated text');await frameMatches();
    const handle=await js(`(()=>{const h=[...document.querySelectorAll('[data-element-id="text"] > div')].find(e=>e.style.cursor==='ew-resize'&&e.style.right);const r=h.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
    for(const event of [{type:'mouseMove',...handle},{type:'mouseDown',...handle,button:'left',clickCount:1},{type:'mouseMove',x:handle.x+16,y:handle.y,button:'left'},{type:'mouseUp',x:handle.x+16,y:handle.y,button:'left',clickCount:1}])win.webContents.sendInputEvent(event);
    await poll(()=>js(`reviewState().state.doc.elements[0].size.w>${before.size.w}`),'resize rotated text');await frameMatches();
    await orientation(270);
    const exported=JSON.parse(await download('rotation-270.nwl',`document.querySelector('button[title="Download Nextwaves Label (.nwl)"]').click()`));
    assert.equal(exported.settings.contentRotation,270);
    const current=await js('structuredClone(reviewState().state.doc)');
    assert.deepEqual(exported.elements,JSON.parse(JSON.stringify(current.elements)));
    await js(`document.querySelector('button[title^="Save ("]').click()`);
    await poll(()=>js(`JSON.parse(localStorage.getItem('zbre.print.templates.v1')||'[]').some(d=>d.settings.contentRotation===270)`),'saved template');
    await poll(()=>js(`JSON.parse(localStorage.getItem('zbre.print.session.v1')).doc.settings.contentRotation===270`),'saved session');
    await win.loadURL(origin+'/?step=edit');
    await poll(()=>js(`!!document.querySelector('[data-element-id="text"]')`),'reload editor');await probe();await frameMatches();
    assert.deepEqual(await js('reviewState().state.doc.elements'),current.elements);
    await js(`[...document.querySelectorAll('ol button')].find(b=>b.textContent.endsWith('Print')).click()`);
    await poll(()=>js(`!!document.querySelector('[data-testid="print-preview-card"] [data-preview-state="ready"] canvas')`),'print preview');
    await js(canvasBits);
    const preview=await js(`canvasBits(document.querySelector('[data-testid="print-preview-card"] canvas'))`);
    assert.deepEqual([preview.w,preview.h],[480,720]);
    fs.writeFileSync(path.join(output,'print-preview.png'),(await win.webContents.capturePage()).toPNG());
    const zpl=await download('rotation-270.zpl',`[...document.querySelectorAll('summary')].find(s=>s.textContent==='More actions').parentElement.open=true;
        [...document.querySelectorAll('button')].find(b=>b.innerText==='Download .zpl').click()`);
    const graphic=/~DG[^,]+,(\d+),(\d+),:Z64:([^:]+):/.exec(zpl);
    assert.ok(graphic,'full-page bitmap ZPL');assert.match(zpl,/\^PW480/);assert.match(zpl,/\^LL720/);
    assert.doesNotMatch(zpl,/\^PO[NI]/);
    const bitmap=inflateSync(Buffer.from(graphic[3],'base64'));
    assert.equal(Number(graphic[2]),preview.stride);
    assert.deepEqual(bitmap,Buffer.from(preview.data,'base64'),'ZPL pixel mask equals rotated Print preview');
    await js(`window.print=()=>{
        const root=document.querySelector('.pdf-export-frame'),paper=root.querySelector('[data-testid="designer-paper"]');
        const p=paper.getBoundingClientRect();
        window.browserFrames=[...paper.querySelectorAll('[data-element-id]')].map(el=>{
            const r=el.getBoundingClientRect(),content=el.firstElementChild.firstElementChild.getBoundingClientRect();
            return {id:el.dataset.elementId,box:[r.x-p.x,r.y-p.y,r.width,r.height],content:[content.x-r.x,content.y-r.y,content.width,content.height]};
        });
        const clone=root.cloneNode(true);
        const targets=clone.querySelectorAll('canvas');root.querySelectorAll('canvas').forEach((source,i)=>targets[i].getContext('2d').drawImage(source,0,0));
        document.body.appendChild(clone);window.browserReady=true;
    };
        [...document.querySelectorAll('button')].find(b=>b.innerText==='Print via browser').click()`);
    await poll(()=>js('!!window.browserReady'),'browser/PDF layout');
    const frames=await js('window.browserFrames');
    for(const el of current.elements){
        const frame=frames.find(f=>f.id===el.id),scale=96/25.4;
        const expected=[el.pos.x*scale,el.pos.y*scale,el.size.w*scale,el.size.h*scale];
        expected.forEach((v,i)=>assert.ok(Math.abs(v-frame.box[i])<0.1,'browser/PDF geometry '+el.id));
        if(el.kind==='text'||el.kind==='table'){
            [0,0,frame.box[2],frame.box[3]].forEach((v,i)=>assert.ok(Math.abs(v-frame.content[i])<0.1,'browser/PDF rotated content '+el.id));
        }
    }
    const pdf=await win.webContents.printToPDF({preferCSSPageSize:true,printBackground:true,margins:{top:0,right:0,bottom:0,left:0}});
    fs.writeFileSync(path.join(output,'rotation-270.pdf'),pdf);
    assert.deepEqual(errors,[],'renderer console errors');
    fs.writeFileSync(path.join(output,'ui-results.json'),JSON.stringify({passed:true,version:'3.8.0',
        checks:['four absolute angles','text and textarea frame bounds','individual text rotation','undo/redo','table cell hit-testing','table column drag','mouse drag','mouse resize','NWL export','template save','session reload','print preview','ZPL pixel equality','browser/PDF geometry'],errors},null,2));
    console.log('Packaged rotation UI passed: frames, editing, drag/resize, undo/redo, persistence, preview, ZPL pixels and browser/PDF geometry.');
}
async function close(code){
    fs.writeFileSync(path.join(output,'ui-server.log'),serverLog);
    if(code&&win&&!win.isDestroyed()){
        fs.writeFileSync(path.join(output,'ui-failure.png'),(await win.webContents.capturePage()).toPNG());
        fs.writeFileSync(path.join(output,'ui-failure.txt'),await js('document.body.innerText'));
    }
    if(win&&!win.isDestroyed())win.destroy();server?.kill();app.exit(code);
}
main().then(()=>close(0)).catch(error=>{console.error(error);close(1);});
