/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
}).outputText, filename);
const { rotateTemplate, inverseRotatePoint, rotationFrame } = require('../app/rotation.ts');
const { labelReducer } = require('../app/reducer.ts');
const { historyReducer, makeInitialHistory } = require('../app/history.ts');
const { normalizeZebraDocument } = require('../app/zebra-document.ts');
const { buildZpl, buildFullPageZpl, buildFullPageStoredGraphicRecallZpl } = require('../app/zpl.ts');
const { preflightLabelForPrinter } = require('../app/dpi-preflight.ts');
const settings = { widthMm: 80, heightMm: 50, gapMm: 3, dpi: 300, copies: 1, speed: 4, darkness: 10, contentRotation: 0,
    serial: { enabled: false, start: 1, step: 1, pad: 4, prefix: '' },
    rfid: { enabled: false, chip: 'epc_96', epcBits: 96, format: 'H', retries: 3, block: 2, words: 6, data: '' },
};
const text = { id: 'text', kind: 'text', text: 'Antenna\nNextwaves', pos: {x: 4, y: 3}, size: {w: 28, h: 8},
    rotation: 0, font: 'D', scaleX: 1, scaleY: 1, fontSizeMm: 2, marginMm: 0.25, align: 'left', wrapMode: 'word', fitMode: 'clip' };
const table = { id: 'table', kind: 'table', pos: {x: 30, y: 30}, size: {w: 20, h: 12}, rotation: 0,
    rows: 2, cols: 2, cells: ['A', 'B', 'C', 'D'], colWidths: [8, 12], rowHeights: [5, 7],
    scaleMode: 'all', fontSizeMm: 2, padding: 1, borderThickness: 0.25 };
const doc = { id: 'rotation-qa', name: 'Rotation', settings, elements: [text,
    { ...text, id: 'locked', locked: true, rotation: 90, pos: {x: 68, y: 6}, size: {w: 8, h: 28} },
    { id: 'qr', kind: 'qr', pos: {x: 3, y: 16}, size: {w: 16, h: 16}, rotation: 0, data: 'NWS1234', cell: 3, ecc: 'M', align: 'left', verticalAlign: 'bottom' },
    { id: 'image', kind: 'image', pos: {x: 24, y: 18}, size: {w: 30, h: 10}, rotation: 0, src: '', threshold: 0 },
    { id: 'rect', kind: 'rect', pos: {x: 3, y: 40}, size: {w: 10, h: 5}, thickness: 0.25, filled: false },
    { id: 'line', kind: 'line', pos: {x: 2, y: 47}, size: {w: 70, h: 0.5}, thickness: 0.5, orientation: 'h', strokeAnchor: 'start' }, table,
] };
const original = structuredClone(doc);
const state = { doc, selectedId: 'text', selectedIds: ['text'], editingId: 'text', snapToGrid: false, showGrid: false,
    zoom: 8, feedOpen: false, feedFullscreen: false, previewRowId: null };
for (const angle of [0, 90, 180, 270]) {
    const rotated = rotateTemplate(doc, angle);
    const quarter = angle === 90 || angle === 270;
    assert.equal(rotated.settings.widthMm, quarter ? 50 : 80);
    assert.equal(rotated.settings.heightMm, quarter ? 80 : 50);
    assert.deepEqual(rotated.elements.map(e => e.id), doc.elements.map(e => e.id));
    assert.deepEqual(rotated.elements[6].colWidths, table.colWidths);
    assert.deepEqual(rotated.elements[6].cells, table.cells);
    assert.equal(rotated.elements[1].rotation, (90 + angle) % 360);
    assert.equal(rotated.elements[5].orientation, quarter ? 'v' : 'h');
    assert.deepEqual(rotateTemplate(rotated, 0), doc, 'round trip ' + angle);
    assert.equal(rotateTemplate(rotated, angle), rotated, 'absolute angle is idempotent');
    const saved = normalizeZebraDocument(JSON.parse(JSON.stringify(rotated)));
    assert.equal(saved.settings.contentRotation, angle);
    assert.deepEqual(JSON.parse(JSON.stringify(saved.elements[0])), rotated.elements[0]);
    const next = labelReducer(state, {type: 'updateSettings', patch: {contentRotation: angle}});
    assert.deepEqual(next.doc, rotated);
    let history = historyReducer(makeInitialHistory(state), {type: 'updateSettings', patch: {contentRotation: angle}});
    history = historyReducer(history, {type: 'undo'});
    assert.deepEqual(history.present.doc, doc);
    history = historyReducer(history, {type: 'redo'});
    assert.deepEqual(history.present.doc, rotated);
    const frame = rotationFrame({w: 80, h: 20}, angle);
    const local = inverseRotatePoint({x: frame.x, y: frame.y}, {w: 80, h: 20}, angle);
    assert.deepEqual(local, {x: 0, y: 0});
    const item = labelReducer(state, {type: 'updateElement', id: 'text', patch: {rotation: angle}}).doc.elements[0];
    assert.deepEqual(item.size, quarter ? {w: 8, h: 28} : text.size);
    assert.deepEqual(item.pos, text.pos);
    const rfidDoc = { ...rotated, settings: { ...rotated.settings,
        rfid: { ...settings.rfid, readEnabled: true, readBank: 'EPC', readLength: 24, readFieldName: 'rfid_read' } },
        elements: [{ ...rotated.elements[0], text: '{rfid_read}', rfidReadLastChars: 6 },
            { id: 'dm', kind: 'datamatrix', data: '{rfid_read}', fieldName: 'rfid_read', pos: {x: 2, y: 2}, size: {w: 16, h: 16}, rotation: angle }],
    };
    const zpl = buildZpl(rfidDoc);
    assert.doesNotMatch(zpl, /\^PO[NI]/, "Software rotation must not change printer orientation mode");
    assert.ok(!preflightLabelForPrinter(rfidDoc).some(issue => issue.code === 'DATAMATRIX_RFID_NATIVE_UNSUPPORTED'), 'rotated RFID Data Matrix passes UI preflight');
    const orientation = {0: 'N', 90: 'R', 180: 'I', 270: 'B'}[angle];
    assert.match(zpl, new RegExp('\\^BX' + orientation + ',\\d+,200,'));
    assert.match(zpl, new RegExp('\\^A0' + orientation + ','));
    assert.match(zpl, /\^RFR/);
    assert.doesNotMatch(zpl, /\^FO-\d|\^FO\d+,-\d/);
    const native = buildZpl({...rotated, elements: [rotated.elements[0], rotated.elements[6]]});
    assert.match(native, new RegExp('\\^A0' + orientation + ','));
}
let repeated = doc;
for (let i = 0; i < 100; i++) for (const angle of [90, 180, 270, 0]) repeated = rotateTemplate(repeated, angle);
assert.deepEqual(repeated, doc, '400 turns do not drift');
assert.deepEqual(doc, original, 'no source mutation');
const rotatedState = {...state, doc: rotateTemplate(doc, 90)};
const resize = labelReducer(rotatedState, {type: 'resizeElement', id: 'table', pos: rotatedState.doc.elements[6].pos, size: {w: 24, h: 40}});
assert.deepEqual(resize.doc.elements[6].colWidths, [16, 24]);
assert.deepEqual(resize.doc.elements[6].rowHeights, [10, 14]);
const reshape = labelReducer(rotatedState, {type: 'updateElement', id: 'table', patch: {rows: 3}}).doc.elements[6];
assert.equal(reshape.size.w, reshape.rowHeights.reduce((a, b) => a + b, 0));
assert.equal(reshape.size.h, reshape.colWidths.reduce((a, b) => a + b, 0));
console.log('Rotation passed: geometry, locked items, table edits, no drift, persistence, undo/redo, text frames and native RFID at all four angles.');

// Reported tag: (44,31) outer origin, 3 dots of margin and a 23-dot baseline.
const epcLabel = {
    ...doc, settings: { ...doc.settings, widthMm: 56, heightMm: 34, dpi: 300, copies: 1,
        rfid: { ...settings.rfid, readEnabled: true, readBank: 'EPC', readFieldName: 'rfid_read' } },
    elements: [{ ...text, text: 'EPC: {rfid_read}', pos: {x: 3.668074324, y: 2.54761496},
        size: {w: 35.472662332, h: 3}, fontSizeMm: 2.5, marginMm: undefined, wrapMode: 'none', fitMode: 'clip' }],
};
const emptyGraphic = { widthDots: 8, heightDots: 1, widthBytes: 1, bytes: new Uint8Array([0]) };
const epcValue = 'E280F3020000000174AD813B';
const expectedOrigins = ['^FO47,34^A0N', '^FT351,47,0^A0R', '^FT625,351,0^A0I', '^FT57,625,0^A0B'];
const zeroOrigins = ['^FO44,31^A0N', '^FT354,44,0^A0R', '^FT628,354,0^A0I', '^FT54,628,0^A0B'];
assert.equal(normalizeZebraDocument(epcLabel).elements[0].marginMm, 0.25);
for (const [index, angle] of [0, 90, 180, 270].entries()) {
    const label = rotateTemplate(epcLabel, angle);
    const prefix = expectedOrigins[index] + ',30,30';
    const dynamicField = prefix + '^FH\\^FE#^FDEPC: #1#^FS';
    const native = buildZpl(label);
    const overlay = buildFullPageZpl(label.settings, emptyGraphic, 1, {elements: label.elements});
    for (const job of [native, overlay]) {
        assert.ok(job.includes(dynamicField), 'direct EPC field at the rotated baseline: ' + angle);
        assert.match(job, /\^RFR,H,,,E\^FN1\^FS/);
    }
    const resolved = buildFullPageZpl(label.settings, emptyGraphic, 1, {elements: label.elements,
        vars: {rfid_read: epcValue}, emitResolvedRfidReadFields: true});
    assert.ok(resolved.includes(prefix + '^FDEPC: ' + epcValue + '^FS'));
    const noMargin = normalizeZebraDocument({...label, elements: [{...label.elements[0], marginMm: 0}]});
    assert.equal(noMargin.elements[0].marginMm, 0);
    assert.ok(buildZpl(noMargin).includes(zeroOrigins[index] + ',30,30^FH'));
    for (const override of [{wrapMode: 'word'}, {fitMode: 'shrink'}, {align: 'center'}, {align: 'right'}]) {
        const framedLabel = {...label, elements: [{...label.elements[0], ...override}]};
        assert.match(buildZpl(framedLabel), /\^FB420,\d+,0,[LCR],0\^FH\\\^FE#\^FDEPC: #1#/);
    }
}
const tooTight = {...epcLabel, elements: [{...epcLabel.elements[0], marginMm: 2}]};
assert.ok(preflightLabelForPrinter(tooTight).some(issue => issue.code === 'TEXT_MARGIN_NO_SPACE' && issue.severity === 'error'));
assert.throws(() => buildZpl(tooTight), /margin leaves no printable area/);
const customMargin = normalizeZebraDocument({...epcLabel, elements:[{...epcLabel.elements[0], marginMm:0.26}]});
assert.equal(normalizeZebraDocument(JSON.parse(JSON.stringify(customMargin))).elements[0].marginMm, 0.26);
assert.ok(buildZpl(customMargin).includes('^FO48,35^A0N'), 'round clearance up to four dots');
console.log('EPC margin passed: four rotated anchors, native, bitmap overlay, resolved data, zero/custom margins and old templates.');

// Reproduce the user's separator: a thin vertical stroke in a wider frame.
const separator = {id:'separator',kind:'line',pos:{x:47,y:2},size:{w:3,h:5},thickness:0.25,orientation:'v',strokeAnchor:'start'};
const separatorDoc = {...doc,settings:{...settings,widthMm:56,heightMm:34},elements:[separator]};
const turned = rotateTemplate(separatorDoc,180);
assert.deepEqual(turned.elements[0].pos,{x:6,y:27});
assert.equal(turned.elements[0].strokeAnchor,'end');
assert.match(buildZpl(turned),/\^FO105,324\^GB3,60,3,B,0\^FS/,'ink is at 8.75 mm, not the frame left at 6 mm');
const legacy = structuredClone(turned);delete legacy.elements[0].strokeAnchor;
const repaired = normalizeZebraDocument(legacy);
assert.equal(repaired.elements[0].strokeAnchor,'end','already-saved 180-degree templates repair on load');
assert.equal(normalizeZebraDocument(repaired).elements[0].strokeAnchor,'end','migration does not apply twice');
assert.match(buildZpl(repaired),/\^FO105,324\^GB3,60,3,B,0\^FS/);
assert.deepEqual(rotateTemplate(rotateTemplate(separatorDoc,90),270),rotateTemplate(separatorDoc,270));
assert.deepEqual(rotateTemplate(turned,0),separatorDoc);
const addedLine={...separator,id:'new-line'};delete addedLine.strokeAnchor;
const added=labelReducer({...state,doc:turned},{type:'addElement',element:addedLine}).doc;
assert.equal(normalizeZebraDocument(added).elements[1].strokeAnchor,'start','new line in a 180-degree template does not jump on save');
const bitmap = {widthDots:8,heightDots:1,widthBytes:1,bytes:new Uint8Array([0x80])};
assert.doesNotMatch(buildFullPageZpl(turned.settings,bitmap),/\^PO[NI]/);
assert.doesNotMatch(buildFullPageStoredGraphicRecallZpl(turned.settings,'R:ROTATION.GRF',1),/\^PO[NI]/);
console.log('Separator regression passed: padded frame, 180-degree native ink position, legacy migration, bitmap/stored-graphic rotation without printer orientation commands.');
