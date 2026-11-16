const { resolveWebSource } = require("../scripts/web-source.cjs");
// Real Chromium decoding and raster output, without a server or printer.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, ".."), output = path.join(__dirname, "image-qa");
fs.mkdirSync(output, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(output, "render-profile-")));
let win;
async function main() {
    await app.whenReady();
    win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    await win.loadURL("about:blank");
    const result = await win.webContents.executeJavaScript(`(async () => {
        const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
        const web = ${JSON.stringify(resolveWebSource())};
        const ts = require(path.join(web, 'node_modules/typescript'));
        require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
        }).outputText, filename);
        const { renderLabelToBitmap, renderLabelToPreviewCanvas } = require(path.join(web, 'app/full-page-raster.ts'));
        const { decodeImage, drawContainedImage } = require(path.join(web, 'app/image-layout.ts'));
        const { mmToDots } = require(path.join(web, 'app/units.ts'));
        const makePng = (w, h, format = 'image/png') => {
            const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
            const ctx = canvas.getContext('2d'); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
            return canvas.toDataURL(format);
        };
        const svg = (markup, base64 = false) => base64
            ? 'data:image/svg+xml;base64,' + btoa(markup)
            : 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(markup);
        const sources = [
            ['landscape PNG', makePng(800, 200), 4],
            ['portrait PNG', makePng(200, 800), 0.25],
            ['square PNG', makePng(200, 200), 1],
            ['landscape JPEG', makePng(800, 200, 'image/jpeg'), 4],
            ['SVG viewBox only', svg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 200"><rect width="800" height="200"/></svg>'), 4],
            ['SVG explicit viewport', svg('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="200"><rect width="800" height="200"/></svg>'), 4],
            ['SVG XML/base64', svg('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 800"><rect width="200" height="800"/></svg>', true), 0.25],
        ];
        const bounds = (w, h, black) => {
            let x0=w, y0=h, x1=-1, y1=-1;
            for(let y=0;y<h;y++) for(let x=0;x<w;x++) if(black(x,y)) {
                x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);
            }
            return { x:x0, y:y0, w:x1-x0+1, h:y1-y0+1 };
        };
        const canvasBounds = canvas => {
            const p = canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
            return bounds(canvas.width,canvas.height,(x,y)=>{
                const i=(y*canvas.width+x)*4;
                return (p[i]*p[i+3]+255*(255-p[i+3]))/255<128;
            });
        };
        const checks = [];
        for (const dpi of [203,300,600]) for (const [name,src,ratio] of sources) for (const size of [{w:20,h:20},{w:36,h:8},{w:8,h:28},{w:13.3,h:7.7}]) {
            const el = {id:'logo',kind:'image',src,fileName:name,pos:{x:2,y:3},size,threshold:0};
            const doc = { id:'image-qa',name:'Image QA',elements:[el],settings:{widthMm:42,heightMm:36,dpi,copies:1,
                serial:{enabled:false,start:1,step:1,pad:4,prefix:''},rfid:{enabled:false}} };
            const before = JSON.stringify(doc);
            const fw=mmToDots(size.w,dpi),fh=mmToDots(size.h,dpi);
            // Independent expected geometry, no production layout helper.
            const w = Math.round(Math.min(fw,fh*ratio)), h = Math.round(Math.min(fh,fw/ratio));
            const expected = {x:mmToDots(2,dpi)+Math.round((fw-w)/2),y:mmToDots(3,dpi)+Math.round((fh-h)/2),w,h};
            const bitmap = await renderLabelToBitmap(doc);
            const actual = bounds(bitmap.widthDots,bitmap.heightDots,(x,y)=>bitmap.bytes[y*bitmap.widthBytes+(x>>3)] & (0x80>>(x&7)));
            assert.deepEqual(actual, expected, name+' bitmap '+dpi+' '+JSON.stringify(size));
            const preview=await renderLabelToPreviewCanvas(doc);
            assert.deepEqual(canvasBounds(preview), expected, name+' preview');
            const editor=document.createElement('canvas');editor.width=fw;editor.height=fh;
            drawContainedImage(editor.getContext('2d'),await decodeImage(src),0,0,fw,fh);
            const editorBounds=canvasBounds(editor);
            assert.deepEqual(editorBounds,{x:expected.x-mmToDots(2,dpi),y:expected.y-mmToDots(3,dpi),w,h},name+' editor');
            assert.equal(JSON.stringify(doc),before,'render never changes source or frame');
            checks.push({name,dpi,size,bounds:actual});
        }
        // Transparent padding belongs to the original source and must not be cropped.
        const padded=document.createElement('canvas');padded.width=800;padded.height=200;
        padded.getContext('2d').fillRect(200,50,400,100);
        const target=document.createElement('canvas');target.width=240;target.height=240;
        drawContainedImage(target.getContext('2d'),await decodeImage(padded.toDataURL()),0,0,240,240);
        assert.deepEqual(canvasBounds(target),{x:60,y:105,w:120,h:30});
        return {passed:true,checks,transparentPadding:true};
    })()`, true);
    fs.writeFileSync(path.join(output, "rendering-results.json"), JSON.stringify(result, null, 2));
    console.log(`Image rendering passed: ${result.checks.length} cases across 203/300/600 DPI; editor, preview and bitmap agree.`);
}
main().then(() => { win?.destroy(); app.exit(0); }).catch(error => { console.error(error); win?.destroy(); app.exit(1); });
