const { resolveWebSource } = require("../scripts/web-source.cjs");
// Compare actual Chromium rendering with an independent pixel rotation oracle.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path');
const output = path.join(__dirname, 'rotation-qa');
fs.mkdirSync(output, {recursive: true});
app.setPath('userData', fs.mkdtempSync(path.join(output, 'render-profile-')));
let win;
async function main() {
    await app.whenReady();
    win = new BrowserWindow({show: false, webPreferences: {nodeIntegration: true, contextIsolation: false}});
    await win.loadURL('about:blank');
    const result = await win.webContents.executeJavaScript(`(async () => {
        const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
        const web = ${JSON.stringify(resolveWebSource())};
        const ts = require(path.join(web, 'node_modules/typescript'));
        require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}, fileName: filename,
        }).outputText, filename);
        const {renderLabelToBitmap} = require(path.join(web, 'app/full-page-raster.ts'));
        const {rotateTemplate} = require(path.join(web, 'app/rotation.ts'));
        const {mmToDots} = require(path.join(web, 'app/units.ts'));
        const source = document.createElement('canvas'); source.width=80; source.height=40;
        const ctx=source.getContext('2d');ctx.fillRect(0,0,12,40);ctx.fillRect(0,28,80,12);
        const text = {id:'text',kind:'text',text:'Nextwaves\\nRFID 1234',rotation:0,font:'D',scaleX:1,scaleY:1,
            fontSource:'system',fontFamily:'Arial',fontSizeMm:3,align:'center',wrapMode:'word',fitMode:'shrink',pos:{x:8,y:5},size:{w:28,h:10}};
        const elements = [text,
            {...text,id:'clip',text:'TOO LONG FOR THIS FRAME',wrapMode:'none',fitMode:'clip',size:{w:20,h:4}},
            {...text,id:'epc-margin',text:'EPC: E280F3020000000174AD813B',align:'left',wrapMode:'none',fitMode:'clip',fontSizeMm:2.5,size:{w:35.5,h:3}},
            {...text,id:'custom-margin',text:'EPC',align:'right',marginMm:0.5},
            {...text,id:'native-font',fontSource:'zpl',fontSizeMm:undefined,rotation:90,size:{w:10,h:28}},
            {id:'image',kind:'image',pos:{x:8,y:5},size:{w:24,h:10},rotation:0,src:source.toDataURL(),threshold:0},
            {id:'table',kind:'table',pos:{x:8,y:5},size:{w:24,h:12},rotation:0,rows:2,cols:2,
                cells:['A','B','C','D'],colWidths:[8,16],rowHeights:[5,7],scaleMode:'all',fontSizeMm:2,padding:1,borderThickness:0.25},
            {id:'qr',kind:'qr',pos:{x:8,y:5},size:{w:20,h:20},rotation:0,data:'NWS123456',ecc:'M',cell:3,align:'left',verticalAlign:'bottom'},
            {id:'dm',kind:'datamatrix',pos:{x:8,y:5},size:{w:24,h:12},rotation:0,data:'NWS123456',shape:'rectangle',align:'right',verticalAlign:'top'},
            {id:'barcode',kind:'barcode',pos:{x:8,y:5},size:{w:38,h:12},rotation:0,data:'NWS123',symbology:'CODE128',humanReadable:true,align:'left'},
            {id:'rect',kind:'rect',pos:{x:8,y:5},size:{w:24,h:12},thickness:0.25,filled:false},
            {id:'line',kind:'line',pos:{x:8,y:5},size:{w:24,h:0.5},thickness:0.5,orientation:'h'},
            {id:'padded-h',kind:'line',pos:{x:8,y:5},size:{w:24,h:4},thickness:0.25,orientation:'h'},
            {id:'padded-v',kind:'line',pos:{x:8,y:5},size:{w:3,h:12},thickness:0.25,orientation:'v'},
            {id:'padded-h-end',kind:'line',pos:{x:8,y:5},size:{w:24,h:4},thickness:0.25,orientation:'h',strokeAnchor:'end'},
            {id:'padded-v-end',kind:'line',pos:{x:8,y:5},size:{w:3,h:12},thickness:0.25,orientation:'v',strokeAnchor:'end'},
        ];
        const settings={widthMm:60,heightMm:40,gapMm:3,copies:1,speed:4,darkness:10,contentRotation:0,
            serial:{enabled:false,start:1,step:1,pad:4,prefix:''},rfid:{enabled:false}};
        const bit=(b,x,y)=>x>=0&&y>=0&&x<b.widthDots&&y<b.heightDots&&(b.bytes[y*b.widthBytes+(x>>3)]&(0x80>>(x&7)))!==0;
        const checks=[];
        for(const dpi of [203,300,600]) for(const el of elements) {
            const doc={id:'qa',name:'QA',settings:{...settings,dpi},elements:[el]};
            const original=await renderLabelToBitmap(doc,0,dpi);
            for(const angle of [0,90,180,270]) {
                const turned=rotateTemplate(doc,angle), actual=await renderLabelToBitmap(turned,0,dpi);
                const quarter=angle===90||angle===270;
                assert.equal(actual.widthDots,quarter?original.heightDots:original.widthDots);
                assert.equal(actual.heightDots,quarter?original.widthDots:original.heightDots);
                const expected={...actual,bytes:new Uint8Array(actual.bytes.length)};
                let ink=0;
                for(let y=0;y<original.heightDots;y++) for(let x=0;x<original.widthDots;x++) if(bit(original,x,y)) {
                    ink++;
                    const tx=angle===90?original.heightDots-1-y:angle===180?original.widthDots-1-x:angle===270?y:x;
                    const ty=angle===90?x:angle===180?original.heightDots-1-y:angle===270?original.widthDots-1-x:y;
                    expected.bytes[ty*expected.widthBytes+(tx>>3)]|=0x80>>(tx&7);
                }
                assert.ok(ink>0,el.id+' renders ink');
                let mismatch=0,unmatched=0,actualInk=0;
                for(let y=0;y<actual.heightDots;y++) for(let x=0;x<actual.widthDots;x++) {
                    const a=bit(actual,x,y),e=bit(expected,x,y);if(a)actualInk++;
                    if(a===e)continue;mismatch++;
                    const target=a?expected:actual;
                    let near=false;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(bit(target,x+dx,y+dy))near=true;
                    if(!near)unmatched++;
                }
                // Chromium font hinting changes when a glyph baseline becomes vertical.
                const fontInk = el.kind==='text'||el.kind==='table'||el.kind==='barcode';
                assert.ok(Math.abs(actualInk-ink)/ink<(fontInk?0.20:0.02),el.id+' ink retained '+dpi+'/'+angle+' '+actualInk+'/'+ink);
                assert.ok(unmatched/ink<0.025,el.id+' pixel placement '+dpi+'/'+angle+' mismatch='+unmatched+'/'+ink);
                if(el.kind==='line')assert.equal(mismatch,0,el.id+' exact rotated ink '+dpi+'/'+angle);
                if(el.kind==='text') {
                    const e=turned.elements[0],x0=mmToDots(e.pos.x,dpi),y0=mmToDots(e.pos.y,dpi),w=mmToDots(e.size.w,dpi),h=mmToDots(e.size.h,dpi);
                    const inset = Math.ceil((el.marginMm ?? 0.25) * ({203:8,300:12,600:24}[dpi]));
                    for(let y=0;y<actual.heightDots;y++)for(let x=0;x<actual.widthDots;x++)
                        if(x<x0+inset||y<y0+inset||x>=x0+w-inset||y>=y0+h-inset)assert.ok(!bit(actual,x,y),'white margin at '+angle+' / '+dpi);
                }
                checks.push({element:el.id,dpi,angle,ink,actualInk,mismatch,unmatched});
            }
        }
        // Check the reported leading E against the same print origin with
        // plenty of space below and after the glyph, independently of clipping.
        for (const dpi of [203,300,600]) {
            const glyph = {...text, text:'E', align:'left', wrapMode:'none', fitMode:'clip',
                fontSizeMm:2.5, size:{w:35.5,h:3}, marginMm:0.25};
            const roomy = {...glyph, pos:{x:glyph.pos.x+0.25,y:glyph.pos.y+0.25}, size:{w:40,h:10}, marginMm:0};
            for (const angle of [0,90,180,270]) {
                const render = item => renderLabelToBitmap(rotateTemplate({id:'E',name:'E',settings:{...settings,dpi},elements:[item]},angle),0,dpi);
                const a=await render(glyph), b=await render(roomy);
                assert.ok(a.bytes.some(Boolean),'E must print');
                assert.deepEqual(a.bytes,b.bytes,'full leading E at '+dpi+' DPI / '+angle);
            }
        }
        return {passed:true,checks,fullGlyphComparisons:12};
    })()`,true);
    fs.writeFileSync(path.join(output,'rendering-results.json'),JSON.stringify(result,null,2));
    console.log('Rotation raster passed: '+result.checks.length+' cases, 203/300/600 DPI, independent pixel rotation and text containment.');
}
main().then(()=>{win?.destroy();app.exit(0);}).catch(error=>{console.error(error);win?.destroy();app.exit(1);});
