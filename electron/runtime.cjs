const net = require("node:net");
const path = require("node:path");

const APP_HOST = "127.0.0.1";
const APP_PORT = 18888;
const CONNECTOR_HOST = "127.0.0.1";
const CONNECTOR_PORT = 17917;
const CONNECTOR_MIN_VERSION = "0.12.2";

function numericVersion(value) {
    const match = String(value || "").trim().match(/^(\d+)\.(\d+)\.(\d+)/);
    return match ? match.slice(1).map(Number) : null;
}

function compareVersions(left, right) {
    const a = numericVersion(left);
    const b = numericVersion(right);
    if (!a || !b) return null;
    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    return 0;
}

function connectorVersionError(version) {
    const comparison = compareVersions(version, CONNECTOR_MIN_VERSION);
    if (comparison === null || comparison < 0) {
        return `Connector ${String(version || "unknown")} is older than ${CONNECTOR_MIN_VERSION}.`;
    }
    return "";
}

function connectorHealthError(health) {
    if (!health || typeof health !== "object" || health.ok !== true) {
        return "The process on connector port did not return a valid health response.";
    }
    if (health.name !== "Nextwaves Zebra Local Print Connector") {
        return `Connector identity mismatch: ${String(health.name || "unknown")}.`;
    }
    const versionError = connectorVersionError(health.version);
    if (versionError) return versionError;
    if (
        health.tcp !== true
        || health.capabilities?.tcpJobIdempotencyV1 !== true
        || health.capabilities?.printerTargetQueueV1 !== true
        || health.capabilities?.rawBatchLeaseV1 !== true
        || health.capabilities?.rawSpoolBatchV1 !== true
    ) {
        return "Connector does not expose the required persistent TCP job, RAW batch lease, durable RAW spool batch, and per-printer queue capabilities.";
    }
    if (
        health.capabilities?.rfidCaptureV1 !== true
        || health.capabilities?.rfidBatchAuditV1 !== true
        || health.capabilities?.productionRollV1 !== true
        || health.capabilities?.tcpServiceFaultLatchV1 !== true
    ) {
        return "Connector does not expose the required RFID evidence, batch audit, production roll, and service-fault latch capabilities.";
    }
    if (["tcpBackgroundMonitorV1", "productionRollIdentityV2", "productionRollCountsV2", "rfidWriteVerifyV1", "productionRemovalAccountingV2", "tcpFaultCounterReconciliationV1"].some(name => health.capabilities?.[name] !== true)) {
        return "Connector does not expose the required background monitor, roll identity/counts, and write-verification capabilities.";
    }
    if (health.capabilities?.productionRollLifecycleV1 !== true) {
        return "Connector does not support closing rolls independently of CSV export. Update the connector before printing.";
    }
    if (health.capabilities?.connectorCounterLifecycleV1 !== true) {
        return "Connector does not support durable counter sampling and verified final counts. Update the connector before printing.";
    }
    if (health.capabilities?.productionRollHistoryV1 !== true) {
        return "Connector does not support clearing and restoring roll history. Close the older connector and reopen ZbrePrinter 3.9.2.";
    }
    if (["fleetStreamingV1", "fleetFlowControlV1", "fleetSpoolV1", "productionRowNotesV1", "productionRevisionsV1"].some(name => health.capabilities?.[name] !== true)) {
        return "Connector does not support durable fleet jobs, row notes and per-run configuration revisions. Reopen ZbrePrinter 3.9.2.";
    }
    return "";
}

function appOrigin() {
    return `http://${APP_HOST}:${APP_PORT}`;
}

function rawSpoolBatchWork(health) {
    const states = ["staging", "queued", "spooling", "uncertain"];
    const counts = states.map((state) => Number(health?.rawSpoolBatches?.[state]));
    const known = counts.every((count) => Number.isSafeInteger(count) && count >= 0);
    return { known, total: known ? counts.reduce((sum, count) => sum + count, 0) : 0 };
}

function isAllowedAppUrl(rawUrl) {
    try {
        const url = new URL(rawUrl);
        return url.origin === appOrigin();
    } catch {
        return false;
    }
}

function buildNextEnvironment({
    baseEnvironment,
    dataDir,
    webDir,
    integrationToken,
}) {
    const environment = {
        ...(baseEnvironment || process.env),
        NODE_ENV: "production",
        HOSTNAME: APP_HOST,
        PORT: String(APP_PORT),
        NEXTWAVES_DEPLOYMENT_MODE: "desktop",
        NEXTWAVES_SERVER_TCP: "disabled",
        NEXTWAVES_SERVER_TCP_PORTS: "9100",
        NEXTWAVES_ENABLE_INTEGRATION_API: "true",
        NEXTWAVES_INTEGRATION_API_KEY: integrationToken,
        NEXTWAVES_INTEGRATION_ALLOWED_ORIGINS: appOrigin(),
        NEXTWAVES_DATA_DIR: dataDir,
        NEXTWAVES_PRINTER_CONFIG_PATH: path.join(dataDir, "printer-routing.json"),
        NEXTWAVES_PROFILE_DIR: path.join(dataDir, "integration-profiles"),
        NEXTWAVES_TEMPLATE_ROOT: path.join(webDir, "template"),
        NEXTWAVES_DEFAULT_TEMPLATE_PATH: "Generic_Label_A.nwl",
        NODE_PATH: path.join(webDir, "standalone_modules"),
    };

    delete environment.NODE_OPTIONS;
    delete environment.ELECTRON_RUN_AS_NODE;
    return environment;
}

function portAvailable(host, port) {
    return new Promise((resolve) => {
        const probe = net.createServer();
        probe.unref();
        probe.once("error", () => resolve(false));
        probe.listen({ host, port, exclusive: true }, () => {
            probe.close(() => resolve(true));
        });
    });
}

module.exports = {
    APP_HOST,
    APP_PORT,
    CONNECTOR_HOST,
    CONNECTOR_PORT,
    CONNECTOR_MIN_VERSION,
    appOrigin,
    buildNextEnvironment,
    compareVersions,
    connectorHealthError,
    connectorVersionError,
    isAllowedAppUrl,
    portAvailable,
    rawSpoolBatchWork,
};
