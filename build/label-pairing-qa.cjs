// Observe the actual packaged renderer's text draw calls and resulting pixels.
// Compare decompressed ZPL bitmaps with those pixels, paired to each RFW field.
// This audits host output; it does not pretend to read a physical RFID tag.
const assert = require("node:assert/strict");
const { inflateSync } = require("node:zlib");

function addPairingText(doc) {
    for (const [id, text, y] of [["pair-row", "PAIR ROW={ROW}", 9], ["pair-epc", "PAIR EPC={RFID}", 12]]) {
        doc.elements.push({ id, kind: "text", text, pos: { x: 1, y }, size: { w: 32, h: 2 },
            rotation: 0, font: "A", scaleX: 1, scaleY: 1, wrapMode: "none", fitMode: "clip" });
    }
}

function captureCanvasPairs(width, height) {
    const texts = new WeakMap();
    window.__labelPairingQA = {};
    window.__labelPairingQAStats = { width, height, textSamples: [], imageSizes: [] };
    const proto = CanvasRenderingContext2D.prototype;
    const fillText = proto.fillText, getImageData = proto.getImageData;
    proto.fillText = function(value, ...args) {
        const valueText = String(value);
        // Native-font spacing can draw one character at a time.
        const drawn = texts.get(this.canvas) || [];
        drawn.push(valueText);
        texts.set(this.canvas, drawn);
        return fillText.call(this, value, ...args);
    };
    proto.getImageData = function(...args) {
        const result = getImageData.apply(this, args);
        const drawn = (texts.get(this.canvas) || []).join("");
        const row = Number(drawn.match(/PAIR ROW=(\d+)/)?.[1]);
        const epc = drawn.match(/PAIR EPC=([0-9A-F]{24})/)?.[1];
        if (row && epc && result.width === width && result.height === height) {
            const stats = window.__labelPairingQAStats;
            if (stats.textSamples.length < 4) stats.textSamples.push(drawn);
            if (stats.imageSizes.length < 4) stats.imageSizes.push([result.width,result.height]);
            // Independent RGBA-to-monochrome conversion for the captured canvas.
            const stride = Math.ceil(width / 8), packed = new Uint8Array(stride * height);
            for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                const p = 4 * (y * width + x), rgba = result.data;
                const luminance = (299 * rgba[p] + 587 * rgba[p + 1] + 114 * rgba[p + 2]) / 1000;
                if (luminance * rgba[p + 3] + 255 * (255 - rgba[p + 3]) < 128 * 255) {
                    packed[y * stride + Math.floor(x / 8)] |= 1 << (7 - x % 8);
                }
            }
            let binary = "";
            for (const b of packed) binary += String.fromCharCode(b);
            const image = { epc, bitmap: btoa(binary) };
            const variants = window.__labelPairingQA[row] ||= [];
            if (!variants.some(item => item.epc === image.epc && item.bitmap === image.bitmap)) variants.push(image);
        }
        return result;
    };
}

async function installPairCapture(win, doc) {
    // Zebra's nominal 203/300/600 DPI profiles use 8/12/24 dots per mm.
    const dotsPerMm = doc.settings.dpi >= 600 ? 24 : doc.settings.dpi >= 300 ? 12 : 8;
    const width = Math.round(doc.settings.widthMm * dotsPerMm);
    const height = Math.round(doc.settings.heightMm * dotsPerMm);
    await win.webContents.executeJavaScript(`(${captureCanvasPairs.toString()})(${width},${height})`);
}

function assertLabelPairs(zpl, rows, captured) {
    assert.doesNotMatch(zpl, /\^(?:DF|XF|XG)|~DG/, "dynamic labels must not share stored printer images/formats");
    const blocks = [...zpl.matchAll(/\^XA\b[\s\S]*?\^XZ/g)].map(match => match[0]);
    assert.equal(blocks.length, rows.length, "one complete ZPL format per data row");
    blocks.forEach((block, index) => {
        const row = rows[index], expectedEpc = row.toString(16).padStart(24, "0").toUpperCase();
        const epcs = [...block.matchAll(/\^RFW,H[^\^]*\^FD([0-9A-F]+)\^FS/g)];
        assert.equal(epcs.length, 1); assert.equal(epcs[0][1], expectedEpc, `EPC order at row ${row}`);
        assert.match(block, /\^PQ1\s*\^XZ$/, "no printer-side serial/repeat counter for dynamic labels");
        const graphics = [...block.matchAll(/\^GFA,(\d+),(\d+),(\d+),:Z64:([^:]+):[0-9A-Fa-f]{4}/g)];
        assert.equal(graphics.length, 1, `one full-page bitmap for row ${row}`);
        const bitmap = inflateSync(Buffer.from(graphics[0][4], "base64"));
        assert.equal(bitmap.length, Number(graphics[0][1]));
        const expected = captured[row] || [];
        assert.ok(expected.length, `No captured text/pixel evidence for row ${row}; recorded rows: ${Object.keys(captured).slice(0, 8).join(",")}`);
        assert.ok(expected.some(image => image.epc === expectedEpc && Buffer.from(image.bitmap, "base64").equals(bitmap)),
            `Printed text/pixels do not match EPC for row ${row}`);
    });
    return blocks;
}

function assertDetectsReportedJump(zpl, rows, captured) {
    const blocks = assertLabelPairs(zpl, rows, captured);
    const destination = rows.indexOf(1337), source = rows.indexOf(1441);
    assert.ok(destination >= 0 && source >= 0);
    const graphic = /\^GFA[^\^]+\^FS/;
    const corrupted = blocks.slice();
    corrupted[destination] = corrupted[destination].replace(graphic, blocks[source].match(graphic)[0]);
    assert.throws(() => assertLabelPairs(corrupted.join("\n"), rows, captured), /Printed text\/pixels do not match EPC for row 1337/,
        "the audit must catch text 1441 paired with EPC 1337 even when EPC order is intact");
}

module.exports = { addPairingText, installPairCapture, assertLabelPairs, assertDetectsReportedJump };
