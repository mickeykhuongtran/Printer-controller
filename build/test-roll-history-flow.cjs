const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

module.exports = async function testRollHistory({ post, host, printerPort, js, panel, poll, clickButton, fill, showDetails, win, origin, screenshot, download, runDir, printerActivity }) {
    const listIds = () => js(`[...document.querySelector('[aria-label="Production roll history"]').options].map(o=>o.value).filter(Boolean)`);
    const select = async id => { await fill("Production roll history", id); await clickButton("Xem dữ liệu cuộn"); };
    const reload = async () => {
        await win.loadURL(origin);
        await poll(() => js(`!!${panel}?.querySelector('[aria-label="Production roll history"]')`), "Roll history did not reload", 30000);
        await showDetails("Lịch sử cuộn / xuất CSV");
    };
    const seed = async (name, closed = true) => {
        const roll = (await (await post("roll-create", { targetLabels: 1, templateName: name, templateFingerprint: "a".repeat(64), printerHost: host, printerPort, operationMode: "read", bank: "EPC" })).json()).roll;
        if (closed) await post("roll-close", { rollId: roll.rollId });
        return roll.rollId;
    };
    // Produce one real connector capture against the local simulator, so the CSV
    // assertion exercises a genuine EPC record rather than an empty mock report.
    await fill("Labels", 1); await clickButton("Print 1 label");
    await poll(() => js("document.body.innerText.includes('Saved 1 EPC reads.')"), "One-label simulator capture did not finish", 30000);
    const first = (await (await post("roll-list")).json()).rolls[0].rollId;
    await post("roll-close", { rollId: first });
    const second = await seed("History B"), open = await seed("Current open roll", false);
    const beforeHistoryActivity = printerActivity();
    await clickButton("Tải lại hồ sơ");
    await showDetails("Lịch sử cuộn / xuất CSV");
    await poll(async () => (await listIds()).length === 3, "Seeded history not listed", 30000);
    await select(first);
    await fill("Production operator", "QA"); await fill("Production Job ID", "HISTORY-CLEAR"); await fill("Production roll number", 1);
    const before = path.join(runDir, "before-clear.csv"), after = path.join(runDir, "after-clear.csv");
    await download("Xuất CSV", before);
    await clickButton("Clear cuộn đã chọn");
    await poll(async () => !(await listIds()).includes(first), "Selected history was not cleared", 30000);
    await reload();
    await poll(async () => (await listIds()).length === 2, "Clear did not persist across reload", 30000);
    assert.deepEqual(new Set(await listIds()), new Set([second, open]));
    await js(`document.querySelector('[aria-label="Show cleared roll history"]').click()`);
    await select(first);
    await download("Tải lại CSV", after);
    assert.deepEqual(fs.readFileSync(after), fs.readFileSync(before), "Clear altered the archived CSV");
    await clickButton("Khôi phục cuộn đã chọn");
    await poll(async () => (await (await post("roll-list")).json()).rolls.every(r => !r.historyClearedAt), "Restore not persisted", 30000);
    await reload();
    await poll(async () => (await listIds()).length === 3, "Restore did not survive reload", 30000);
    await clickButton("Clear toàn bộ cuộn đã đóng (2)");
    await poll(async () => (await listIds()).length === 1, "Clear all did not remove both closed rolls", 30000);
    assert.deepEqual(await listIds(), [open]);
    await select(open);
    assert.equal(await js(`[...${panel}.querySelectorAll('button')].find(b=>b.innerText==='Clear cuộn đã chọn').disabled`), true);
    await post("roll-history-clear", { rollIds: [open] }, 409);
    assert.equal((await (await post("roll-get", { rollId: open })).json()).roll.state, "open");
    await screenshot("history-cleared", `document.querySelector('[aria-label="Production roll history"]')`);
    await reload();
    await poll(async () => (await listIds()).length === 1, "Clear all lost on reload", 30000);
    await js(`document.querySelector('[aria-label="Show cleared roll history"]').click()`);
    await select(first);
    await screenshot("history-restore", `document.querySelector('[aria-label="Production roll history"]')`);
    assert.deepEqual(printerActivity(), beforeHistoryActivity, "History management sent printer traffic");
    const result = { passed: true, clearSelected: true, clearAllClosed: true, openRollProtected: true, reloadPersistence: true, restore: true, immutableCsv: true, realConnector: true, hardwarePrinting: false };
    fs.writeFileSync(path.join(runDir, "history-result.json"), JSON.stringify(result, null, 2));
    fs.writeFileSync(path.join(__dirname, "production-roll-qa/latest-history-result.json"), JSON.stringify({ ...result, runDir }, null, 2));
};
