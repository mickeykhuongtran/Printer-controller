const {
    app,
    BrowserWindow,
    dialog,
    Menu,
    powerSaveBlocker,
    session,
    shell,
    utilityProcess,
} = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { createLogger } = require("./logger.cjs");
const {
    APP_HOST,
    APP_PORT,
    CONNECTOR_HOST,
    CONNECTOR_PORT,
    appOrigin,
    buildNextEnvironment,
    connectorHealthError,
    isAllowedAppUrl,
    portAvailable,
    rawSpoolBatchWork,
} = require("./runtime.cjs");

app.setName("ZbrePrinter");
app.setAppUserModelId("com.nextwaves.zbreprinter");

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
    app.quit();
}

let mainWindow = null;
let printWorkerWindow = null;
let printWorkerRestartTimer = null;
let nextProcess = null;
let connectorProcess = null;
let ownsConnector = false;
let quitting = false;
let logger = null;
let fatalErrorInProgress = false;
let quitCheckInProgress = false;
let powerMonitorTimer = null;
let powerBlockerId = null;
let integrationApiToken = "";
let runtimeReady = false;

function resourcePath(...segments) {
    const root = app.isPackaged
        ? process.resourcesPath
        : path.join(__dirname, "..", "bundle");
    return path.join(root, ...segments);
}

function sha256(filePath) {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function verifyRuntimeResources() {
    const manifestPath = resourcePath("runtime-manifest.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const connectorPath = resourcePath("connector", manifest.connector.file);
    const serverPath = resourcePath("web", "server.js");

    if (sha256(connectorPath) !== manifest.connector.sha256) {
        throw new Error("Local Print Connector integrity verification failed.");
    }
    if (sha256(serverPath) !== manifest.web.serverSha256) {
        throw new Error("Next standalone runtime integrity verification failed.");
    }
    return { manifest, connectorPath, serverPath };
}

async function fetchJson(url, timeoutMs = 1200, headers = undefined) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            cache: "no-store",
            headers,
            signal: controller.signal,
        });
        const data = await response.json().catch(() => null);
        return { reachable: true, ok: response.ok, data };
    } catch (error) {
        return {
            reachable: false,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
    } finally {
        clearTimeout(timer);
    }
}

async function waitFor(check, {
    timeoutMs,
    intervalMs = 200,
    description,
}) {
    const deadline = Date.now() + timeoutMs;
    let lastError = "";
    while (Date.now() < deadline) {
        try {
            const value = await check();
            if (value) return value;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    throw new Error(
        `${description} did not become ready within ${timeoutMs} ms`
        + (lastError ? `: ${lastError}` : "."),
    );
}

async function ensureConnector(connectorPath, manifest) {
    const healthUrl = `http://${CONNECTOR_HOST}:${CONNECTOR_PORT}/v1/health`;
    const existing = await fetchJson(healthUrl);
    if (existing.reachable) {
        const healthError = connectorHealthError(existing.data);
        if (!existing.ok || healthError) {
            throw new Error(
                `TCP ${CONNECTOR_PORT} is occupied by an incompatible process. `
                + (healthError || `HTTP status was not successful.`),
            );
        }
        logger.info("Reusing compatible Local Print Connector", {
            version: existing.data.version,
            port: CONNECTOR_PORT,
        });
        return;
    }

    const connectorDataDir = path.join(app.getPath("userData"), "connector");
    fs.mkdirSync(connectorDataDir, { recursive: true });
    const args = [
        "--listen-address", CONNECTOR_HOST,
        "--port", String(CONNECTOR_PORT),
        "--tcp-ports", "9100",
        "--state-file", path.join(connectorDataDir, "paired-origins.json"),
    ];

    connectorProcess = spawn(connectorPath, args, {
        cwd: path.dirname(connectorPath),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
    });
    ownsConnector = true;
    logger.pipe(connectorProcess.stdout, "connector");
    logger.pipe(connectorProcess.stderr, "connector");
    connectorProcess.once("error", (error) => {
        logger.error("Local Print Connector process error", error.message);
    });
    connectorProcess.once("exit", (code, signal) => {
        logger.warn("Local Print Connector exited", { code, signal });
        if (!quitting) void showFatalRuntimeError(
            "Local Print Connector đã dừng. Job đang in có thể ở trạng thái uncertain; "
            + "không tự động gửi lại trước khi đối soát nhãn/tag thực tế.",
        );
    });

    await waitFor(async () => {
        const health = await fetchJson(healthUrl);
        if (!health.reachable || !health.ok) return false;
        const healthError = connectorHealthError(health.data);
        if (healthError) throw new Error(healthError);
        return health.data;
    }, {
        timeoutMs: 12_000,
        description: "Local Print Connector",
    });

    logger.info("Started bundled Local Print Connector", {
        version: manifest.connector.version,
        port: CONNECTOR_PORT,
    });
}

function startNextServer(serverPath, integrationToken) {
    const webDir = path.dirname(serverPath);
    const dataDir = path.join(app.getPath("userData"), "data");
    const tracedModulesPath = path.join(webDir, "standalone_modules");
    const runnerPath = path.join(__dirname, "next-runner.cjs");
    fs.mkdirSync(dataDir, { recursive: true });

    nextProcess = utilityProcess.fork(
        runnerPath,
        [serverPath, tracedModulesPath],
        {
            cwd: webDir,
            env: buildNextEnvironment({
                baseEnvironment: process.env,
                dataDir,
                webDir,
                integrationToken,
            }),
            serviceName: "ZbrePrinter Local Web Runtime",
            stdio: "pipe",
        },
    );
    logger.pipe(nextProcess.stdout, "next");
    logger.pipe(nextProcess.stderr, "next");
    nextProcess.once("exit", (code) => {
        logger.warn("Next standalone runtime exited", { code });
        if (!quitting) void showFatalRuntimeError(
            "Dịch vụ ZbrePrinter cục bộ đã dừng. Hãy kiểm tra log trước khi tiếp tục in.",
        );
    });
}

async function waitForNextServer() {
    const url = appOrigin();
    await waitFor(async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 1500);
        try {
            const response = await fetch(url, {
                cache: "no-store",
                redirect: "manual",
                signal: controller.signal,
            });
            return response.status >= 200 && response.status < 400;
        } catch {
            return false;
        } finally {
            clearTimeout(timer);
        }
    }, {
        timeoutMs: 30_000,
        description: "ZbrePrinter local web runtime",
    });
}

function configureSession(appSession, integrationToken) {
    const origin = appOrigin();
    appSession.webRequest.onBeforeSendHeaders(
        {
            urls: [
                `${origin}/api/integration/*`,
                `${origin}/print*`,
            ],
        },
        (details, callback) => {
            details.requestHeaders.Authorization = `Bearer ${integrationToken}`;
            callback({ requestHeaders: details.requestHeaders });
        },
    );

    const localSerialPermission = (_webContents, permission, requestingOrigin) =>
        permission === "serial" && requestingOrigin === origin;
    appSession.setPermissionCheckHandler(localSerialPermission);
    appSession.setPermissionRequestHandler(
        (webContents, permission, callback, details) => {
            callback(
                permission === "serial"
                && details.requestingOrigin === origin
                && webContents === mainWindow?.webContents,
            );
        },
    );
    appSession.setDevicePermissionHandler((details) =>
        details.deviceType === "serial" && details.origin === origin,
    );

    appSession.on(
        "select-serial-port",
        (event, portList, webContents, callback) => {
            event.preventDefault();
            if (webContents !== mainWindow?.webContents || portList.length === 0) {
                callback("");
                return;
            }
            const visiblePorts = portList.slice(0, 12);
            const buttons = visiblePorts.map((port, index) =>
                port.displayName
                || port.portName
                || `Serial port ${index + 1}`,
            );
            const cancelId = buttons.length;
            buttons.push("Hủy");
            void dialog.showMessageBox(mainWindow, {
                type: "question",
                title: "Chọn cổng COM",
                message: "Chọn cổng serial dùng để giao tiếp với máy in Zebra.",
                buttons,
                cancelId,
                defaultId: 0,
                noLink: true,
            }).then(({ response }) => {
                callback(response === cancelId ? "" : visiblePorts[response]?.portId || "");
            });
        },
    );
}

function createWindow(integrationToken) {
    const appSession = session.fromPartition("persist:zbreprinter");
    configureSession(appSession, integrationToken);

    mainWindow = new BrowserWindow({
        title: "ZbrePrinter",
        width: 1440,
        height: 900,
        minWidth: 1080,
        minHeight: 700,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: "#f4f4f2",
        icon: resourcePath("web", "public", "icon-512.png"),
        webPreferences: {
            session: appSession,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            spellcheck: false,
        },
    });

    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("https://")) void shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (isAllowedAppUrl(url)) return;
        event.preventDefault();
        if (url.startsWith("https://")) void shell.openExternal(url);
    });
    mainWindow.once("ready-to-show", () => mainWindow?.show());
    mainWindow.on("close", (event) => {
        if (quitting) return;
        event.preventDefault();
        void requestApplicationQuit();
    });
    mainWindow.on("closed", () => {
        mainWindow = null;
    });
    void mainWindow.loadFile(path.join(__dirname, "loading.html"));
}

function schedulePrintWorkerRestart(reason) {
    if (quitting || printWorkerRestartTimer) return;
    logger?.warn("Scheduling print worker restart", { reason });
    printWorkerRestartTimer = setTimeout(() => {
        printWorkerRestartTimer = null;
        if (!quitting && mainWindow) createPrintWorker();
    }, 1000);
    printWorkerRestartTimer.unref?.();
}

function createPrintWorker() {
    if (printWorkerWindow && !printWorkerWindow.isDestroyed()) return;
    const appSession = session.fromPartition("persist:zbreprinter");
    printWorkerWindow = new BrowserWindow({
        title: "ZbrePrinter Print Worker",
        show: false,
        webPreferences: {
            session: appSession,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true,
            allowRunningInsecureContent: false,
            backgroundThrottling: false,
            spellcheck: false,
        },
    });
    printWorkerWindow.webContents.setAudioMuted(true);
    printWorkerWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    printWorkerWindow.webContents.on("will-navigate", (event, url) => {
        if (isAllowedAppUrl(url)) return;
        event.preventDefault();
    });
    printWorkerWindow.webContents.on("render-process-gone", (_event, details) => {
        logger?.error("Print worker renderer stopped", details);
        if (printWorkerWindow && !printWorkerWindow.isDestroyed()) {
            printWorkerWindow.destroy();
        }
        schedulePrintWorkerRestart("renderer stopped");
    });
    printWorkerWindow.webContents.on("did-fail-load", (_event, code, description) => {
        logger?.error("Print worker failed to load", { code, description });
        if (printWorkerWindow && !printWorkerWindow.isDestroyed()) {
            printWorkerWindow.destroy();
        }
        schedulePrintWorkerRestart(`load failed: ${code}`);
    });
    printWorkerWindow.on("unresponsive", () => {
        logger?.error("Print worker became unresponsive");
        if (printWorkerWindow && !printWorkerWindow.isDestroyed()) {
            printWorkerWindow.destroy();
        }
        schedulePrintWorkerRestart("renderer unresponsive");
    });
    printWorkerWindow.on("closed", () => {
        printWorkerWindow = null;
        if (!quitting && mainWindow) schedulePrintWorkerRestart("window closed");
    });
    void printWorkerWindow.loadURL(`${appOrigin()}/print-listener`).catch((error) => {
        logger?.error("Could not load print worker", error.message);
        if (printWorkerWindow && !printWorkerWindow.isDestroyed()) {
            printWorkerWindow.destroy();
        }
        schedulePrintWorkerRestart("loadURL rejected");
    });
}

async function activePrintWork() {
    const [browserQueue, connectorHealth] = await Promise.all([
        fetchJson(
            `${appOrigin()}/api/integration/browser-print/status`,
            1500,
            integrationApiToken
                ? { Authorization: `Bearer ${integrationApiToken}` }
                : undefined,
        ),
        fetchJson(`http://${CONNECTOR_HOST}:${CONNECTOR_PORT}/v1/health`, 1500),
    ]);
    let rendererActive = 0;
    let rendererStatusUnknown = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
        try {
            rendererActive = await Promise.race([
                mainWindow.webContents.executeJavaScript(
                    "Number(globalThis.__nextwavesPrinterJobQueues?.activeJobs || 0)",
                    true,
                ),
                new Promise((_, reject) => setTimeout(
                    () => reject(new Error("Renderer print-state probe timed out.")),
                    1500,
                )),
            ]);
        } catch {
            rendererStatusUnknown = true;
        }
    }
    const queued = Number(browserQueue.data?.queued || 0);
    const inFlight = Number(browserQueue.data?.inFlight || 0);
    const serverActive = Number(browserQueue.data?.serverQueue?.active || 0);
    const serverWaiting = Number(browserQueue.data?.serverQueue?.waiting || 0);
    const connectorActive = Number(connectorHealth.data?.printerQueue?.active || 0);
    const connectorQueued = Number(connectorHealth.data?.printerQueue?.queued || 0);
    const tcpJobs = Number(connectorHealth.data?.tcpJobs?.active || 0);
    const spoolWork = rawSpoolBatchWork(connectorHealth.data);
    // Once the runtime is ready, inability to inspect either queue is not
    // evidence that printing is idle. Fail closed so quit/sleep requires an
    // explicit operator decision instead of silently truncating a batch.
    const counters = [
        queued,
        inFlight,
        serverActive,
        serverWaiting,
        connectorActive,
        connectorQueued,
        tcpJobs,
        rendererActive,
    ];
    const malformedCounters = counters.some(
        (value) => !Number.isSafeInteger(value) || value < 0,
    );
    const statusUnknown = runtimeReady && (
        !browserQueue.ok
        || !connectorHealth.ok
        || malformedCounters
        || !spoolWork.known
        || rendererStatusUnknown
    );
    return {
        total:
            queued + inFlight + serverActive + serverWaiting
            + connectorActive + connectorQueued
            + tcpJobs + rendererActive + spoolWork.total + (statusUnknown ? 1 : 0),
        queued,
        inFlight,
        serverActive,
        serverWaiting,
        connectorActive,
        connectorQueued,
        tcpJobs,
        rawSpoolBatches: spoolWork.total,
        rendererActive,
        statusUnknown,
    };
}

async function refreshPowerBlocker() {
    if (quitting) return;
    if (powerBlockerId === null) {
        powerBlockerId = powerSaveBlocker.start("prevent-app-suspension");
        logger?.info("Preventing system sleep while the desktop print runtime is open");
    }
}

function startPowerMonitor() {
    void refreshPowerBlocker();
}

async function requestApplicationQuit() {
    if (quitting || quitCheckInProgress) return;
    quitCheckInProgress = true;
    try {
        const work = await activePrintWork().catch(() => ({
            total: runtimeReady ? 1 : 0,
            statusUnknown: runtimeReady,
        }));
        if (work.total > 0) {
            const { response } = await dialog.showMessageBox(mainWindow || undefined, {
                type: "warning",
                title: "Print jobs are still active",
                message: "ZbrePrinter is still sending or draining print jobs.",
                detail:
                    `Queued: ${work.queued || 0}; listener in flight: ${work.inFlight || 0}; `
                    + `connector active/queued: ${work.connectorActive || 0}/${work.connectorQueued || 0}; `
                    + `server active/queued: ${work.serverActive || 0}/${work.serverWaiting || 0}; `
                    + `TCP jobs: ${work.tcpJobs || 0}; UI jobs: ${work.rendererActive || 0}.\n\n`
                    + (work.statusUnknown
                        ? "One or more queue status probes failed; active work cannot be ruled out.\n\n"
                        : "")
                    + "Waiting avoids truncating the remaining tags. Force exit can leave the physical result uncertain.",
                buttons: ["Wait for jobs", "Force exit (uncertain)"],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
            });
            if (response === 0) {
                mainWindow?.show();
                return;
            }
            logger?.warn("Operator forced exit with active print work", work);
        }
        quitting = true;
        app.quit();
    } finally {
        quitCheckInProgress = false;
    }
}

async function showFatalRuntimeError(message) {
    if (quitting || fatalErrorInProgress) return;
    fatalErrorInProgress = true;
    logger?.error("Fatal runtime failure", message);
    await dialog.showMessageBox(mainWindow || undefined, {
        type: "error",
        title: "ZbrePrinter runtime error",
        message,
        detail: `Log: ${logger?.filePath || app.getPath("logs")}`,
        buttons: ["Đóng ứng dụng", "Mở thư mục log"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    }).then(async ({ response }) => {
        if (response === 1) {
            await shell.openPath(path.dirname(logger.filePath));
        }
    });
    if (runtimeReady) {
        fatalErrorInProgress = false;
        await requestApplicationQuit();
        return;
    }
    quitting = true;
    app.quit();
}

async function bootstrap() {
    const logDir = path.join(app.getPath("userData"), "logs");
    app.setAppLogsPath(logDir);
    logger = createLogger(logDir);
    logger.info("Starting ZbrePrinter desktop", {
        version: app.getVersion(),
        packaged: app.isPackaged,
    });

    integrationApiToken = crypto.randomBytes(32).toString("base64url");
    createWindow(integrationApiToken);
    const { manifest, connectorPath, serverPath } = verifyRuntimeResources();

    if (!(await portAvailable(APP_HOST, APP_PORT))) {
        throw new Error(
            `TCP ${APP_PORT} is already in use. Close the other local service `
            + "or restart Windows, then open ZbrePrinter again.",
        );
    }

    await ensureConnector(connectorPath, manifest);
    startNextServer(serverPath, integrationApiToken);
    await waitForNextServer();
    await mainWindow.loadURL(appOrigin());
    createPrintWorker();
    startPowerMonitor();
    runtimeReady = true;
    logger.info("ZbrePrinter desktop is ready", {
        origin: appOrigin(),
        connectorPort: CONNECTOR_PORT,
    });
}

function stopManagedProcesses() {
    if (printWorkerRestartTimer) {
        clearTimeout(printWorkerRestartTimer);
        printWorkerRestartTimer = null;
    }
    if (powerMonitorTimer) {
        clearInterval(powerMonitorTimer);
        powerMonitorTimer = null;
    }
    if (powerBlockerId !== null) {
        if (powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
        powerBlockerId = null;
    }
    if (nextProcess) {
        try {
            nextProcess.kill();
        } catch (error) {
            logger?.warn("Could not stop Next runtime", String(error));
        }
        nextProcess = null;
    }
    if (connectorProcess && ownsConnector) {
        try {
            connectorProcess.kill();
        } catch (error) {
            logger?.warn("Could not stop connector", String(error));
        }
        connectorProcess = null;
    }
}

app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
});

app.on("before-quit", (event) => {
    if (!quitting) {
        event.preventDefault();
        void requestApplicationQuit();
        return;
    }
    stopManagedProcesses();
});

app.on("window-all-closed", () => {
    app.quit();
});

process.on("uncaughtException", (error) => {
    logger?.error("Uncaught desktop exception", error.stack || error.message);
    if (!quitting) void showFatalRuntimeError(error.message);
});
process.on("unhandledRejection", (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    logger?.error("Unhandled desktop rejection", message);
});

if (singleInstance) {
    void app.whenReady().then(async () => {
        Menu.setApplicationMenu(null);
        try {
            await bootstrap();
        } catch (error) {
            await showFatalRuntimeError(
                error instanceof Error ? error.message : String(error),
            );
        }
    });
}
