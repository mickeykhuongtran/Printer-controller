const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
    APP_PORT,
    appOrigin,
    buildNextEnvironment,
    compareVersions,
    connectorHealthError,
    connectorVersionError,
    isAllowedAppUrl,
    rawSpoolBatchWork,
} = require("../electron/runtime.cjs");

test("desktop origin is stable so Chromium storage survives restarts", () => {
    assert.equal(appOrigin(), `http://127.0.0.1:${APP_PORT}`);
    assert.equal(isAllowedAppUrl(`${appOrigin()}/`), true);
    assert.equal(isAllowedAppUrl(`${appOrigin()}/printer-config`), true);
    assert.equal(isAllowedAppUrl("https://example.com/"), false);
    assert.equal(isAllowedAppUrl("http://127.0.0.1:18889/"), false);
});

test("connector health requires persistent jobs and a per-printer queue", () => {
    assert.equal(connectorHealthError({
        ok: true,
        name: "Nextwaves Zebra Local Print Connector",
        version: "0.12.2",
        tcp: true,
        capabilities: {
            tcpJobIdempotencyV1: true,
            printerTargetQueueV1: true,
            rawBatchLeaseV1: true,
            rawSpoolBatchV1: true,
            rfidCaptureV1: true,
            rfidBatchAuditV1: true,
            productionRollV1: true,
            tcpServiceFaultLatchV1: true, tcpBackgroundMonitorV1: true, productionRollIdentityV2: true, productionRollCountsV2: true, rfidWriteVerifyV1: true,
            productionRemovalAccountingV2: true, tcpFaultCounterReconciliationV1: true, productionRollLifecycleV1: true, connectorCounterLifecycleV1: true, productionRollHistoryV1: true, fleetStreamingV1: true, fleetFlowControlV1: true, fleetSpoolV1: true, productionRowNotesV1: true, productionRevisionsV1: true,
        },
    }), "");
    assert.match(connectorHealthError({
        ok: true,
        name: "Nextwaves Zebra Local Print Connector",
        version: "0.2.0",
        tcp: true,
        capabilities: {
            tcpJobIdempotencyV1: true,
            printerTargetQueueV1: true,
            rawBatchLeaseV1: true,
            rawSpoolBatchV1: true,
        },
    }), /older/);
    assert.match(connectorHealthError({
        ok: true,
        name: "unrelated service",
        version: "9.0.0",
        tcp: true,
        capabilities: {
            tcpJobIdempotencyV1: true,
            printerTargetQueueV1: true,
            rawBatchLeaseV1: true,
            rawSpoolBatchV1: true,
        },
    }), /identity mismatch/);
    assert.match(connectorHealthError({
        ok: true,
        name: "Nextwaves Zebra Local Print Connector",
        version: "0.12.2",
        tcp: true,
        capabilities: { tcpJobIdempotencyV1: true },
    }), /RAW batch lease/);
});

test("semantic version comparison handles supported connector upgrades", () => {
    assert.equal(compareVersions("0.5.0", "0.5.0"), 0);
    assert.equal(compareVersions("0.5.2", "0.5.0"), 1);
    assert.equal(compareVersions("0.3.9", "0.5.0"), -1);
    assert.equal(compareVersions("invalid", "0.5.0"), null);
    assert.equal(connectorVersionError("0.12.2"), "");
    assert.match(connectorVersionError("0.10.0"), /older than 0\.12\.2/);
    assert.match(connectorVersionError("0.9.2"), /older than 0\.12\.2/);
    assert.match(connectorVersionError("0.9.1"), /older than 0\.12\.2/);
    assert.match(connectorVersionError("0.9.0"), /older than 0\.12\.2/);
    assert.match(connectorVersionError("0.6.1"), /older than 0\.12\.2/);
    assert.match(connectorVersionError("0.3.9"), /older than 0\.12\.2/);
    assert.match(connectorVersionError("0.5.1"), /older than 0\.12\.2/);
    assert.match(connectorVersionError("invalid"), /older than 0\.12\.2/);
});

test("production capability receipt is required even with a current connector version", () => {
    const capabilities = { tcpJobIdempotencyV1: true, printerTargetQueueV1: true, rawBatchLeaseV1: true,
        rawSpoolBatchV1: true, rfidCaptureV1: true, rfidBatchAuditV1: true, productionRollV1: true, tcpServiceFaultLatchV1: true };
    for (const missing of ["rfidCaptureV1", "rfidBatchAuditV1", "productionRollV1", "tcpServiceFaultLatchV1"]) {
        assert.match(connectorHealthError({ ok: true, name: "Nextwaves Zebra Local Print Connector", version: "0.12.2", tcp: true,
            capabilities: { ...capabilities, [missing]: false } }), /production roll, and service-fault latch/);
    }
});

test("durable staging and uncertain batches keep the desktop quit guard active", () => {
    assert.deepEqual(rawSpoolBatchWork({ rawSpoolBatches: {
        staging: 1, queued: 2, spooling: 1, uncertain: 3, retained: 50,
    } }), { known: true, total: 7 });
    assert.deepEqual(rawSpoolBatchWork({ rawSpoolBatches: {
        staging: 0, queued: 0, spooling: 0, uncertain: 0,
    } }), { known: true, total: 0 });
    for (const health of [undefined, {}, { rawSpoolBatches: { staging: -1 } }]) {
        assert.equal(rawSpoolBatchWork(health).known, false);
    }
});

test("desktop rejects connectors without the new production safeguards", () => {
    const required = ["tcpJobIdempotencyV1", "printerTargetQueueV1", "rawBatchLeaseV1", "rawSpoolBatchV1", "rfidCaptureV1", "rfidBatchAuditV1", "productionRollV1", "tcpServiceFaultLatchV1", "tcpBackgroundMonitorV1", "productionRollIdentityV2", "productionRollCountsV2", "rfidWriteVerifyV1", "productionRemovalAccountingV2", "tcpFaultCounterReconciliationV1"];
    const capabilities = Object.fromEntries(required.map(name => [name, true]));
    for (const missing of required.slice(-6)) {
        assert.match(connectorHealthError({ ok: true, name: "Nextwaves Zebra Local Print Connector", version: "0.12.2", tcp: true,
            capabilities: { ...capabilities, [missing]: false } }), /background monitor/);
    }
    assert.match(connectorVersionError("0.8.0"), /older/);
});

test("a version string alone cannot authorize an old RAW transport", () => {
    assert.match(connectorHealthError({
        ok: true,
        name: "Nextwaves Zebra Local Print Connector",
        version: "0.12.2",
        tcp: true,
        capabilities: {
            tcpJobIdempotencyV1: true,
            printerTargetQueueV1: true,
            rawBatchLeaseV1: true,
        },
    }), /durable RAW spool batch/);
});

test("desktop requires independent close and export support", () => {
    const required = ["tcpJobIdempotencyV1", "printerTargetQueueV1", "rawBatchLeaseV1", "rawSpoolBatchV1", "rfidCaptureV1", "rfidBatchAuditV1", "productionRollV1", "tcpServiceFaultLatchV1", "tcpBackgroundMonitorV1", "productionRollIdentityV2", "productionRollCountsV2", "rfidWriteVerifyV1", "productionRemovalAccountingV2", "tcpFaultCounterReconciliationV1"];
    const health = { ok: true, name: "Nextwaves Zebra Local Print Connector", version: "0.12.2", tcp: true,
        capabilities: Object.fromEntries(required.map(name => [name, true])) };
    assert.match(connectorHealthError(health), /closing rolls independently/);
    health.capabilities.productionRollLifecycleV1 = true;
    assert.match(connectorHealthError(health), /durable counter sampling/);
    health.capabilities.connectorCounterLifecycleV1 = true;
    assert.match(connectorHealthError(health), /clearing and restoring roll history/);
    health.capabilities.productionRollHistoryV1 = true;
    assert.match(connectorHealthError(health), /durable fleet jobs/);
    Object.assign(health.capabilities, {fleetStreamingV1: true, fleetFlowControlV1:true, fleetSpoolV1:true, productionRowNotesV1:true, productionRevisionsV1:true});
    assert.equal(connectorHealthError(health), "");
});

test("desktop requires connector-owned counter finalization even with a current version", () => {
    const required = ["tcpJobIdempotencyV1", "printerTargetQueueV1", "rawBatchLeaseV1", "rawSpoolBatchV1", "rfidCaptureV1", "rfidBatchAuditV1", "productionRollV1", "tcpServiceFaultLatchV1", "tcpBackgroundMonitorV1", "productionRollIdentityV2", "productionRollCountsV2", "rfidWriteVerifyV1", "productionRemovalAccountingV2", "tcpFaultCounterReconciliationV1", "productionRollLifecycleV1"];
    const health = { ok: true, name: "Nextwaves Zebra Local Print Connector", version: "0.12.2", tcp: true,
        capabilities: Object.fromEntries(required.map(name => [name, true])) };
    assert.match(connectorHealthError(health), /verified final counts/);
    health.capabilities.connectorCounterLifecycleV1 = true;
    assert.match(connectorHealthError(health), /clearing and restoring roll history/);
    health.capabilities.productionRollHistoryV1 = true;
    assert.match(connectorHealthError(health), /durable fleet jobs/);
    Object.assign(health.capabilities, {fleetStreamingV1: true, fleetFlowControlV1:true, fleetSpoolV1:true, productionRowNotesV1:true, productionRevisionsV1:true});
    assert.equal(connectorHealthError(health), "");
});

test("Next runtime writes mutable state to user data and strips Node injection", () => {
    const dataDir = path.resolve("C:/Users/operator/AppData/Roaming/ZbrePrinter/data");
    const webDir = path.resolve("C:/runtime/web");
    const environment = buildNextEnvironment({
        baseEnvironment: {
            NODE_OPTIONS: "--inspect",
            ELECTRON_RUN_AS_NODE: "1",
            SAFE_VALUE: "kept",
        },
        dataDir,
        webDir,
        integrationToken: "test-token",
    });

    assert.equal(environment.SAFE_VALUE, "kept");
    assert.equal(environment.NODE_OPTIONS, undefined);
    assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);
    assert.equal(environment.NEXTWAVES_SERVER_TCP, "disabled");
    assert.equal(environment.NODE_PATH, path.join(webDir, "standalone_modules"));
    assert.equal(environment.NEXTWAVES_DATA_DIR, dataDir);
    assert.equal(
        environment.NEXTWAVES_PRINTER_CONFIG_PATH,
        path.join(dataDir, "printer-routing.json"),
    );
    assert.equal(environment.NEXTWAVES_INTEGRATION_API_KEY, "test-token");
});
