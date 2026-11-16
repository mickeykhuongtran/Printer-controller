/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const ts = require("typescript");
require.extensions[".ts"] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: filename,
}).outputText, filename);

const { labelReducer } = require("../app/reducer.ts");
const { hasUserDataRows } = require("../app/label-data.ts");
const { BUILT_IN_TEMPLATES } = require("../app/templates.ts");
const { productionTemplateContent, productionTemplateFingerprint, parseExcludedOrdinals, listProductionRolls, prepareProductionRoll, downloadProductionRoll,
    productionRunIdentity, productionIdentityMismatch, productionRollCounts, findProductionOpenRoll, closeProductionRoll, productionCounterReason, productionUnreconciledRuns, productionCaptureWarnings } = require("../app/production-roll.ts");

async function main() {
    const legacy = structuredClone(BUILT_IN_TEMPLATES[0]);
    delete legacy.dataFeed;
    legacy.settings.rfid = { ...legacy.settings.rfid, enabled: false, readEnabled: true, readFieldName: "rfid_read" };
    legacy.elements = [{ id: "epc-text", kind: "text", text: "EPC: {rfid_read}", pos: { x: 2, y: 2 }, size: { w: 38, h: 5 }, font: "D", scaleX: 1, scaleY: 1, rotation: 0 }];
    legacy.templateFields = [{ id: "part-field", name: "part", value: "KIT-4520" }];
    const firstOpen = labelReducer({ doc: legacy }, { type: "load", doc: legacy }).doc;
    const secondOpen = labelReducer({ doc: legacy }, { type: "load", doc: legacy }).doc;
    assert.equal(hasUserDataRows(firstOpen), false);
    assert.equal(hasUserDataRows(secondOpen), false);
    assert.notDeepEqual(firstOpen.dataFeed.rows.map(row => row.id), secondOpen.dataFeed.rows.map(row => row.id), "Reopening a legacy file creates fresh editor row identities");
    const firstContent = productionTemplateContent(firstOpen);
    assert.equal(productionTemplateContent(secondOpen), firstContent, "Reopening an approved static template must not block its open production roll");
    assert.equal(productionTemplateContent(legacy), firstContent, "System-only default data is not print data for a static template");
    const firstHash = await productionTemplateFingerprint(firstContent);
    assert.equal(firstHash, createHash("sha256").update(firstContent, "utf8").digest("hex"));
    assert.equal(await productionTemplateFingerprint(productionTemplateContent(secondOpen)), firstHash);

    const topup = structuredClone(firstOpen);
    topup.settings.copies = 200;
    topup.settings.rfid.captureToHost = !firstOpen.settings.rfid.captureToHost;
    topup.templateFields[0].id = "new-editor-field-id";
    assert.equal(productionTemplateContent(topup), firstContent, "Quantity, forced capture and template-field editor IDs must not change the approved template");

    const customer = structuredClone(firstOpen);
    customer.dataFeed = {
        columns: [
            { id: "serial-column", name: "serial", width: 140, format: { type: "text" } },
            { id: "price-column", name: "price", formula: "=ROW()*2", width: 120, format: { type: "number", decimals: 2 } },
        ],
        rows: [
            { id: "row-a", cells: { "serial-column": "CUSTOM-0001", "price-column": "2" } },
            { id: "row-b", cells: { "serial-column": "CUSTOM-0002", "price-column": "4" } },
        ],
    };
    const customerContent = productionTemplateContent(customer);
    const customerHash = await productionTemplateFingerprint(customerContent);
    const sameData = structuredClone(customer);
    const renamedColumns = new Map(sameData.dataFeed.columns.map(column => [column.id, "reimported-" + column.id]));
    sameData.dataFeed.columns.forEach(column => { column.id = renamedColumns.get(column.id); column.width += 55; column.protected = true; });
    sameData.dataFeed.rows.forEach((row, index) => {
        row.id = "reimported-row-" + index;
        row.cells = Object.fromEntries(Object.entries(row.cells).map(([id, value]) => [renamedColumns.get(id), value]));
    });
    assert.equal(productionTemplateContent(sameData), customerContent, "Equivalent reimported data and editor widths/IDs must preserve the approval hash");
    assert.equal(await productionTemplateFingerprint(productionTemplateContent(sameData)), customerHash);

    const meaningfulChanges = [
        ["cell value", doc => { doc.dataFeed.rows[0].cells["serial-column"] = "CUSTOM-9999"; }],
        ["formula", doc => { doc.dataFeed.columns[1].formula = "=ROW()*3"; }],
        ["format", doc => { doc.dataFeed.columns[1].format.decimals = 3; }],
        ["source row order", doc => { doc.dataFeed.rows.reverse(); }],
        ["source column order", doc => { doc.dataFeed.columns.reverse(); }],
        ["binding name", doc => { doc.dataFeed.columns[0].name = "customer_serial"; }],
        ["template field value", doc => { doc.templateFields[0].value = "KIT-5030"; }],
        ["label geometry", doc => { doc.settings.widthMm += 1; }],
        ["printed element", doc => { doc.elements[0].text = "READ: {rfid_read}"; }],
    ];
    for (const [description, change] of meaningfulChanges) {
        const changed = structuredClone(customer);
        change(changed);
        assert.notEqual(await productionTemplateFingerprint(productionTemplateContent(changed)), customerHash, `${description} must invalidate template approval`);
    }

    const allowed = new Set([1, 2, 3, 5, 6, 7, 10]);
    assert.deepEqual(parseExcludedOrdinals("", allowed), []);
    assert.deepEqual(parseExcludedOrdinals(" 7; 1-3, 2\n5-6 10 ", allowed), [1, 2, 3, 5, 6, 7, 10], "Ranges are inclusive, ordered and deduplicated");
    for (const invalid of ["0", "-1", "2.5", "1e2", "7-5", "1-4", "11", "1-100002", "9007199254740992"]) {
        assert.throws(() => parseExcludedOrdinals(invalid, allowed), Error, `Invalid or unobserved ordinal ${invalid} must not be silently excluded`);
    }
    assert.throws(() => parseExcludedOrdinals("1", new Set()), /1/);

    const printer = { host: " PRINTER.local ", port: 9100 };
    const identity = productionRunIdentity(firstOpen, printer, firstHash);
    assert.deepEqual(identity, { printerHost: "printer.local", printerPort: 9100, operationMode: "read", bank: "EPC", templateFingerprint: firstHash });
    const boundRoll = { ...identity, state: "open", runs: [{ runId: "first-run" }] };
    assert.equal(productionIdentityMismatch(boundRoll, identity), "");
    assert.equal(productionIdentityMismatch({ ...boundRoll, printerHost: "PRINTER.local." }, identity), "", "A DNS trailing dot must not falsely change the printer");
    const ipv6Identity = productionRunIdentity(firstOpen, { host: " [0:0:0:0:0:0:0:1] ", port: 9100 }, firstHash);
    assert.equal(ipv6Identity.printerHost, "::1");
    assert.equal(productionIdentityMismatch({ ...boundRoll, printerHost: "::1" }, ipv6Identity), "", "Bracketed or expanded IPv6 is the same printer endpoint");
    for (const change of [{ printerHost: "another-printer" }, { printerPort: 9101 }, { operationMode: "write" }, { bank: "TID" }]) {
        assert.match(productionIdentityMismatch(boundRoll, { ...identity, ...change }), /Đóng cuộn hiện tại/, "A mixed endpoint/template/mode/bank must be rejected before print");
    }
    assert.equal(productionIdentityMismatch({ ...boundRoll, state: "finalized" }, { ...identity, printerHost: "another-printer" }), "", "A closed roll does not block the next configuration");
    assert.equal(productionIdentityMismatch({ ...boundRoll, state: "closed" }, { ...identity, printerHost: "another-printer" }), "", "An unexported closed roll must also release the printer");
    assert.equal(productionIdentityMismatch(boundRoll, { ...identity, templateFingerprint: "different-template" }), "", "Layout revision stays in the same physical roll");
    const pendingRolls = [
        { ...boundRoll, rollId: "other-printer", printerHost: "other.local" },
        { ...boundRoll, rollId: "closed", state: "closed" },
        { ...boundRoll, rollId: "same-printer" },
        { ...boundRoll, rollId: "legacy-unbound", printerHost: "" },
    ];
    assert.equal(findProductionOpenRoll(pendingRolls, printer).rollId, "same-printer", "An unrelated printer's old roll must not hijack discovery");
    assert.equal(findProductionOpenRoll(pendingRolls, printer, "other-printer").rollId, "same-printer", "Selection from a different endpoint cannot leak into this printer");
    assert.equal(findProductionOpenRoll(pendingRolls, printer, "closed").rollId, "same-printer", "A stale selected closed roll is never resumed");
    assert.equal(findProductionOpenRoll(pendingRolls, { host: "unused", port: 9100 }).rollId, "legacy-unbound", "An old roll lacking a printer identity requires explicit closure or resumption");
    assert.equal(findProductionOpenRoll(pendingRolls.slice(0, 2), printer), undefined, "Closed history never blocks new work and discovery must not choose another printer");
    const writeOnly = structuredClone(firstOpen);
    writeOnly.settings.rfid.enabled = true; writeOnly.settings.rfid.readEnabled = false; writeOnly.settings.rfid.readBank = "TID";
    assert.equal(productionRunIdentity(writeOnly, printer, firstHash).operationMode, "write");
    assert.equal(productionRunIdentity(writeOnly, printer, firstHash).bank, "EPC", "Write evidence must describe verified written EPC, not an unrelated read-bank preference");
    writeOnly.settings.rfid.readEnabled = true;
    assert.equal(productionRunIdentity(writeOnly, printer, firstHash).operationMode, "read_write");
    const countView = productionRollCounts({ roll: { bank: "EPC" }, summary: { printerValidCount: 1250, printerValidKnown: true, capturedEpcCount: 1228, removedValidCount: 10, voidCount: 2 } });
    assert.deepEqual(countView, { printerValid: 1250, printerValidKnown: true, capturedEpc: 1228, capturedReadback: 1228, removed: 10,
        removedRejected: 0, removalReviewRequired: false, removableGood: 1250, removableRejected: 0,
        good: 1240, goodKnown: true, voidCount: 2, missingEpc: 22 });
    const unknownCount = productionRollCounts({ roll: { bank: "EPC" }, summary: { printerValidCount: 0, printerValidKnown: false, capturedEpcCount: 2500, retainedCount: 2500 } });
    assert.equal(unknownCount.printerValid, 0); assert.equal(unknownCount.good, 0); assert.equal(unknownCount.goodKnown, false, "Captured EPCs must never be substituted for unknown printer counters or GOOD");
    const incomplete = { roll: { bank: "EPC", runs: [{ runId: "last-run", registeredAt: "2026-10-19T03:15:00Z" }] },
        summary: { printerValidCount: 1999, printerValidKnown: false, capturedEpcCount: 2504,
            machineCounterSnapshot: { valid: 2505, void: 11, at: "2026-10-19T03:18:00Z", live: false },
            unknownVoidRuns: ["last-run"], countsComplete: false } };
    assert.equal(productionRollCounts(incomplete).printerValid, 1999, "Absolute snapshot and EPC count must not overwrite roll subtotal");
    assert.equal(productionRollCounts(incomplete).goodKnown, false);
    assert.equal(productionUnreconciledRuns(incomplete)[0].runId, "last-run");
    assert.match(productionCounterReason("socket_lost"), /Mất kết nối/);
    assert.match(productionCounterReason("final_snapshot_missing"), /Thiếu bộ số đếm cuối/);
    const nativeDiagnostics = [{ runId: "last-run", reason: "socket_lost", capturedEpcCount: 505 }];
    assert.equal(productionUnreconciledRuns({ ...incomplete, summary: { ...incomplete.summary, unreconciledRuns: nativeDiagnostics } }), nativeDiagnostics,
        "Native per-run evidence is retained rather than reconstructed from absolute counters");
    const captureOutcome = { state: "incomplete", options: { expectedLabels: 5, bank: "EPC", operationMode: "read" }, uniqueLabels: 5, received: 5, issues: 0,
        audit: { finalizationStatus: "unresolved", finalizationReason: "counter_reset", countsKnown: false, validDelta: 0 } };
    const resetWarnings = productionCaptureWarnings(captureOutcome).join(" ");
    assert.match(resetWarnings, /Đã lưu 5 EPC/); assert.match(resetWarnings, /reset/);
    assert.doesNotMatch(resetWarnings, /Thiếu|Missing/, "A reset with all responses must not be called missing RFID");
    const knownPhysical = { ...captureOutcome, uniqueLabels: 4, audit: { finalizationStatus: "verified", countsKnown: true, validDelta: 5 } };
    assert.match(productionCaptureWarnings(knownPhysical).join(" "), /Thiếu 1 EPC đọc thành công/);
    assert.doesNotMatch(productionCaptureWarnings(knownPhysical).join(" "), /Counter chưa chốt/);
    assert.deepEqual(productionCaptureWarnings({ ...knownPhysical, state: "complete", uniqueLabels: 4, audit: { ...knownPhysical.audit, validDelta: 4, voidDelta: 1 } }), [],
        "A counter-confirmed VOID without an EPC is not a missing-successful-read warning");
    assert.equal(productionRollCounts({ roll: { bank: "TID" }, summary: { printerValidCount: 10, capturedReadbackCount: 10 } }).missingEpc, 0, "TID capture must not report fictitious missing EPCs");
    assert.equal(productionRollCounts({ roll: { bank: "EPC", operationMode: "write" }, summary: { printerValidCount: 3, capturedEpcCount: 2 } }).good, 2, "Write GOOD must be capped by matching verified EPCs even when the printer counts all writes as VALID");
    const writeCounts = productionRollCounts({ roll: { bank: "EPC", operationMode: "write", removalAccountingVersion: 2 },
        summary: { printerValidCount: 3, printerValidKnown: true, capturedEpcCount: 2, goodCount: 2, goodCountKnown: true,
            removedValidCount: 1, removedGoodCount: 0, removedRejectedCount: 1, removableGoodCount: 2, removableRejectedCount: 1, writeMismatchCount: 1 } });
    assert.equal(writeCounts.good, 2, "Removing an already rejected mismatch must not deduct a second GOOD");
    assert.equal(writeCounts.removed, 0); assert.equal(writeCounts.removedRejected, 1); assert.equal(writeCounts.goodKnown, true);
    const legacyWrite = productionRollCounts({ roll: { bank: "EPC", operationMode: "write", removedValidCount: 1 },
        summary: { printerValidCount: 3, printerValidKnown: true, capturedEpcCount: 2, goodCountKnown: true } });
    assert.equal(legacyWrite.removalReviewRequired, true); assert.equal(legacyWrite.goodKnown, false);
    assert.equal(legacyWrite.removed, 0, "An ambiguous legacy removal must not silently become a verified-GOOD removal");
    assert.equal(productionRollCounts({ roll: { bank: "EPC", operationMode: "write" },
        summary: { printerValidCount: 3, printerValidKnown: true, capturedEpcCount: 2 } }).goodKnown, false,
        "Aggregate counters without native per-run reconciliation cannot prove a write GOOD total");

    // Exercise the real HTTP helper with a replaced fetch. No connector or printer is contacted.
    const previousWindow = global.window, previousFetch = global.fetch;
    let requests = 0;
    global.window = { location: { hostname: "127.0.0.1" }, setTimeout, clearTimeout };
    global.fetch = async (url, init) => {
        requests++;
        assert.equal(url, "http://127.0.0.1:9999/v1/tcp/job");
        assert.equal(init.method, "POST");
        assert.equal(init.headers.get("Content-Type"), "application/json");
        assert.deepEqual(JSON.parse(init.body), { action: "roll-list", production: {} }, "Native roll dispatch requires the production object even for listing");
        return new Response(JSON.stringify({ rolls: [{ rollId: "NW-4520-261016-001_01" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
        assert.deepEqual(await listProductionRolls("http://127.0.0.1:9999/"), { rolls: [{ rollId: "NW-4520-261016-001_01" }] });
        assert.equal(requests, 1);
    } finally {
        global.fetch = previousFetch;
        if (previousWindow === undefined) delete global.window;
        else global.window = previousWindow;
    }
    // A new print creates a draft; only an explicit ID resumes one. Closing
    // needs no export metadata and exporting never performs implicit closure.
    const previousDocument = global.document, previousCreateUrl = URL.createObjectURL, previousRevokeUrl = URL.revokeObjectURL;
    const calls = [], links = [];
    const draft = { ok: true, roll: { rollId: "internal-roll-001", state: "open", runs: [{ runId: "run-1" }] }, summary: {}, rows: [] };
    const closed = { ...draft, roll: { ...draft.roll, state: "closed", closedAt: "2026-10-19T00:00:00Z" } };
    const archived = { ...closed, roll: { ...closed.roll, operator: "Operator", jobId: "JOB-123", rollNumber: 4, exportedAt: "2026-10-19T01:00:00Z" }, exportFileName: "JOB-123_04.csv" };
    let committed = true, failExport = false;
    global.window = { location: { hostname: "127.0.0.1" }, setTimeout: () => 0, clearTimeout: () => {} };
    global.document = { createElement: () => { const link = { click() { links.push({ href: this.href, download: this.download }); } }; return link; } };
    URL.createObjectURL = () => "blob:test-roll";
    URL.revokeObjectURL = () => {};
    global.fetch = async (_url, init) => {
        const request = JSON.parse(init.body); calls.push(request);
        if (request.action === "roll-export") return failExport
            ? new Response(JSON.stringify({ error: "export storage unavailable" }), { status: 500, headers: { "Content-Type": "application/json" } })
            : new Response("ordinal,host_time,bank,value,result,received_time,detail\r\n", { headers: { "Content-Type": "text/csv" } });
        return new Response(JSON.stringify(request.action === "roll-create" || !committed ? draft : request.action === "roll-close" ? closed : archived), { headers: { "Content-Type": "application/json" } });
    };
    try {
        const prepared = await prepareProductionRoll("http://127.0.0.1:9999", firstOpen, 2500, printer);
        assert.equal(prepared.roll.rollId, draft.roll.rollId);
        assert.equal(prepared.runIdentity.templateFingerprint, firstHash, "Capture uses the independently computed current hash, never a stale hash returned in the old draft");
        assert.equal(calls[0].action, "roll-create");
        assert.equal(calls[0].production.targetLabels, 2500);
        assert.equal(calls[0].production.templateFingerprint, firstHash);
        for (const key of ["printerHost", "printerPort", "operationMode", "bank"]) assert.equal(calls[0].production[key], identity[key]);
        for (const key of ["operator", "jobId", "rollNumber"]) assert.equal(key in calls[0].production, false);
        assert.equal("rollId" in calls[0].production, false, "A new batch must not carry the ID of discovered historical work");
        await prepareProductionRoll("http://127.0.0.1:9999", firstOpen, 2, printer, draft.roll.rollId);
        assert.equal(calls[1].production.rollId, draft.roll.rollId, "Top-up resumes the same draft regardless of requested quantity");
        const metadata = { operator: "Operator", jobId: "JOB-123", rollNumber: 4 };
        const requestsBeforeOpenExport = calls.length;
        await assert.rejects(downloadProductionRoll("http://127.0.0.1:9999", draft, metadata), /Đóng cuộn trước/);
        assert.equal(calls.length, requestsBeforeOpenExport, "Exporting an open roll must not send a request or silently close it");
        const closedReceipt = await closeProductionRoll("http://127.0.0.1:9999", draft.roll.rollId);
        assert.equal(closedReceipt.roll.state, "closed");
        assert.deepEqual(calls[2], { action: "roll-close", production: { rollId: draft.roll.rollId } }, "Closure needs no business metadata, counters, CSV or validation assertion");
        assert.equal(links.length, 0, "Closing must not download anything");
        const receipt = await downloadProductionRoll("http://127.0.0.1:9999", closed, metadata);
        assert.deepEqual(calls[3], { action: "roll-export", production: { rollId: draft.roll.rollId, ...metadata } });
        assert.equal("exportedAt" in calls[3].production, false, "The connector supplies computer export time");
        assert.equal(calls[4].action, "roll-get");
        assert.equal(receipt.roll.state, "closed", "Export cannot reopen or recertify the closed roll");
        assert.deepEqual(links, [{ href: "blob:test-roll", download: "JOB-123_04.csv" }]);
        await downloadProductionRoll("http://127.0.0.1:9999", archived);
        assert.deepEqual(calls[5], { action: "roll-export", production: { rollId: draft.roll.rollId } }, "Redownload requests stored immutable bytes without replacing metadata");
        assert.equal(links.length, 2);
        committed = false;
        await assert.rejects(closeProductionRoll("http://127.0.0.1:9999", draft.roll.rollId), /Chưa đóng được/);
        await assert.rejects(downloadProductionRoll("http://127.0.0.1:9999", closed, metadata), /chưa được lưu/);
        assert.equal(links.length, 2, "An uncommitted export must not signal completion");
        failExport = true;
        const before = calls.length;
        await assert.rejects(downloadProductionRoll("http://127.0.0.1:9999", closed, metadata), /storage unavailable/);
        assert.equal(calls.length, before + 1, "Failed export must not fetch or synthesize a successful final receipt");
        assert.equal(links.length, 2);
    } finally {
        global.fetch = previousFetch;
        if (previousWindow === undefined) delete global.window; else global.window = previousWindow;
        if (previousDocument === undefined) delete global.document; else global.document = previousDocument;
        URL.createObjectURL = previousCreateUrl; URL.revokeObjectURL = previousRevokeUrl;
    }
    console.log("Production helpers passed: template identity, explicit resume, same-printer discovery, closure without export, delayed CSV archive/redownload, durable receipt and failure retention.");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
