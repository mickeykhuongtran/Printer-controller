/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
    const source = fs.readFileSync(filename, "utf8");
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
        fileName: filename,
    }).outputText;
    module._compile(output, filename);
};

delete globalThis.__nextwavesBrowserPrintQueue;
const {
    browserPrintStatus,
    browserPrintJobStatus,
    completeBrowserPrintJob,
    queueBrowserPrintJob,
    takeBrowserPrintJob,
} = require(path.join(__dirname, "..", "app", "integration-browser-print.ts"));

function input(printerName, documentName) {
    return {
        doc: { id: "doc", name: "Queue test", settings: {}, elements: [] },
        values: {},
        printerName,
        agentUrl: "http://127.0.0.1:17917",
        documentName,
        templateId: "template",
        templateName: "Queue test",
        rfidEpc: "",
        modelId: "generic",
        targetPrinterModel: "generic",
        dpi: 203,
    };
}

async function main() {
    const queued = Array.from({ length: 1000 }, (_, index) =>
        queueBrowserPrintJob(input("Zebra A", `A-${index + 1}`)));
    assert.equal(browserPrintStatus().queued, 1000);

    const firstA = await takeBrowserPrintJob("listener-1", 1000);
    assert.equal(firstA.id, queued[0].jobId);
    assert.equal(browserPrintStatus().inFlight, 1);

    const printerB = queueBrowserPrintJob(input("Zebra B", "B-1"));
    const firstB = await takeBrowserPrintJob("listener-2", 1000);
    assert.equal(
        firstB.id,
        printerB.jobId,
        "a second printer may run while Zebra A remains leased",
    );

    const waitingForA = takeBrowserPrintJob("listener-3", 1000);
    completeBrowserPrintJob(firstA.id, { ok: true, bytes: 10 });
    const secondA = await waitingForA;
    assert.equal(
        secondA.id,
        queued[1].jobId,
        "same-printer jobs must be claimed in FIFO order",
    );

    completeBrowserPrintJob(firstB.id, { ok: true, bytes: 10 });
    completeBrowserPrintJob(secondA.id, { ok: true, bytes: 10 });
    for (const [index, queuedJob] of queued.slice(2).entries()) {
        const job = await takeBrowserPrintJob("listener-1", 1000);
        assert.equal(job.id, queuedJob.jobId, `FIFO mismatch at drained job ${index + 3}`);
        completeBrowserPrintJob(job.id, { ok: true, bytes: 10 });
    }
    assert.equal(browserPrintJobStatus(queued.at(-1).jobId).status, "accepted");
    assert.equal(
        completeBrowserPrintJob(queued.at(-1).jobId, { ok: true, bytes: 10 }),
        true,
        "completion acknowledgement must be idempotent",
    );
    assert.deepEqual(
        { queued: browserPrintStatus().queued, inFlight: browserPrintStatus().inFlight },
        { queued: 0, inFlight: 0 },
    );
    console.log(
        "Browser print queue tests passed: 1,000 jobs drain FIFO without expiry and same-printer claims are exclusive.",
    );
}

main().catch((error) => {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
});
