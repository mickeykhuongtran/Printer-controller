# ZbrePrinter Integration API

ZbrePrinter provides a local HTTP integration layer for Zebra ZPL/RFID label
printing.

## Recommended Flow

1. Design a label in the UI.
2. Bind dynamic fields with Data Feed columns, for example `product_name`,
   `qr_code`, `lot`, `expired_date`, and `rfid_id`.
3. Publish the design as an API profile from the Print step.
4. Open `http://localhost:8888/print-listener` on the printer PC.
5. Customer systems call `POST /api/integration/print` with the published
   `profileId` and JSON values.
6. The browser listener renders the exact label bitmap, wraps it in Zebra ZPL
   `^GFA`, inserts RFID `^RFW` when enabled, and stages the complete batch on the
   Local Print Connector before committing one Windows RAW spool job.

## Endpoints

```text
POST /api/integration/profiles
POST /api/integration/profiles/{profileId}/compile
POST /api/integration/profiles/{profileId}/print
POST /api/integration/compile
POST /api/integration/print
GET  /api/integration/browser-print/status?jobId={jobId}
POST /print
```

## Print Example

```js
const response = await fetch("http://localhost:8888/api/integration/print", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    profileId: "product-label-rfid",
    printerName: "Zebra ZT610R Line 1",
    agentUrl: "http://127.0.0.1:17917",
    copies: 1,
    values: {
      product_name: product.product_name,
      qr_code: product.qr_code,
      unit: product.unit,
      lot: product.lot,
      expired_date: product.expired_date,
      rfid_id: product.rfid_id
    }
  })
});

const result = await response.json();
// The normal browser-listener response is 202 with result.jobId and
// result.statusUrl. Poll statusUrl; do not resubmit the print request merely
// because the original HTTP connection ended.
```

## Browser-listener queue and HTTP `202`

The default browser-listener flow is asynchronous. A successfully admitted job
normally returns:

```http
HTTP/1.1 202 Accepted
Content-Type: application/json

{
  "ok": true,
  "status": "queued",
  "jobId": "f1f960ca-8c7f-45bf-931c-f10624c42d27",
  "statusUrl": "/api/integration/browser-print/status?jobId=f1f960ca-8c7f-45bf-931c-f10624c42d27"
}
```

Poll `statusUrl`. A job status is `queued`, `claimed`, `accepted`, `error`, or
`timeout`. `accepted` means the connector reported `spool-accepted` for the
complete batch; it does not confirm that every physical label or RFID tag was
printed successfully. The browser job ID is also its connector batch ID.

`waitForCompletion: true` waits for at most `waitTimeoutMs` before returning.
The default is 30 seconds and values are clamped to 1–50 seconds. If the job is
still queued or in flight, the API returns HTTP `202`, status
`queued-or-in-flight`, and the same polling URL. The former absolute 60-second
queue deletion is not used: a slow backlog is not discarded merely because an
HTTP caller stopped waiting.

The browser-listener admission queue, leases, and terminal status records live
in the current Next.js process memory. A process restart loses jobs that have
not reached the connector, and separate Next instances do not share admission
state. Once connector `begin` succeeds, batch payload and status are stored on
connector disk and can be inspected after a browser or application restart.
This is not an end-to-end exactly-once delivery guarantee.

The listener never reprints on a completion-report retry or lease expiration.
Its completion retries retain the original job ID. If a batch requires status
review, it retains that same connector ID and does not allocate a replacement.
An additional browser-listener `POST /api/integration/print` is a new job:
poll the returned job ID instead of retrying POST after a timeout or HTTP
error. Native mode offers the explicit idempotency key described below.

## Generic `/print`

`POST /print` accepts a full `.nwl` template, a published `profileId`, or a
printer alias configured in `/printer-config`.

```json
{
  "printerName": "tem_loai_a",
  "values": {
    "field_1": "ABC001",
    "field_2": "Sample product",
    "field_qr": "https://example.com/qr/ABC001",
    "field_rfid": "000000000000000000000001"
  },
  "waitForCompletion": true
}
```

## Render Modes

`browser-listener` is the default and recommended mode. It preserves visual
fidelity because rendering happens in the browser with the same fonts and
layout engine used by the designer.

For `copies > 1`, browser-listener repetition is limited to templates with no
per-copy serial, multi-row, RFID-encode, or RFID-read variation. Dynamic batch
data must use the interactive chunked Print step, or native mode when its
rendering limitations are acceptable.

`native` mode returns server-generated ZPL for debugging. It emits native ZPL
text, QR, barcode, line, rectangle, table, and RFID commands, but it cannot
include arbitrary uploaded images or browser-only font rendering.

`POST /api/integration/profiles/{profileId}/print` is the direct native/RAW
profile endpoint. To use the visual-fidelity browser listener with a published
profile, call `POST /api/integration/print` and include `profileId` as shown
above.

## Batch coordinator and chunk limits

Within one web/desktop process, a complete logical job is FIFO per printer
target: TCP is keyed by `host:port`, Windows RAW by connector URL and Windows
queue name, and COM by the selected serial-port object. Other printer targets
can run in parallel. The local Next runtime uses bounded admission queues.
Connector `0.5.0` additionally stores Windows batch reservations and staged
payloads on disk. Its Windows queue order is the order in which `begin` is
admitted for that printer; rendering a later batch faster does not let it pass
an earlier reservation.

Within a selected Data Feed range, the Print step freezes the template/data
snapshot and expands rows in increasing source-row order. Every complete ZPL
label retains that order across staged chunks. This does not impose a global
business order on simultaneous HTTP requests from different callers: network
arrival and asynchronous route processing may differ from sender creation
time. A producer needing cross-request order should serialize requests and
await each admission/result, or manage business sequence numbers upstream.

The interactive Print step uses the following packing policy:

- static templates without serial, data-row, or RFID variation: one temporary
  Zebra stored graphic, recalled in `^PQ` windows of at most 100 labels and
  deleted after the final window;
- dynamic non-RFID data: at most 25 complete labels per chunk;
- RFID read/write data: at most 10 complete labels per chunk;
- encoded-byte targets: 512 KiB for Windows RAW, 256 KiB for TCP, and 32 KiB
  for COM. One label is never cut in the middle to meet a byte target.

For Windows RAW these chunks are preparation units, not separate spool jobs.
`begin` reserves the printer before asynchronous rendering. `append` writes
ordered chunks to connector disk and acknowledges staged byte/label totals.
Only `commit`, after all rows validate and all totals match, makes the batch
eligible for one `StartDocPrinter` / `EndDocPrinter` job. An error during HEX
RFID validation, rendering, or staging cancels the uncommitted reservation;
earlier staged chunks have not been sent to Windows. Other applications can
still submit their own Windows jobs, and Windows printer priority/settings
remain outside the application's ordering contract.

The Print step's Windows spool jobs panel shows staging, queued, spooling,
spool-accepted, failed, uncertain, and cancelled states. It can cancel unsent
work and supports explicit recovery/reconciliation. A client timeout does not
cancel a committed job. A recovered or uncertain job is never automatically
reprinted under a new batch ID.

Direct TCP uses one persistent port-9100 socket for the batch. Each committed
print checkpoint is followed by a Zebra error/status query on that same socket,
so the response is ordered after the preceding bytes. The checkpoint receipt
and status response narrow the uncertain range, but do not count completed
physical labels.

For COM, select either no handshake or hardware RTS/CTS, and configure Zebra
Host Handshake to match. A byte receipt means the browser/OS serial stream
accepted the data; without matching flow control it is not protection against
a slow printer receive path.

## Native Windows idempotency and pending responses

For `renderMode: "native"` on `/api/integration/print`, and for the native
`/api/integration/profiles/{profileId}/print` endpoint, generate and persist a
batch ID before the first request. Pass it in JSON `batchId` or the
`Idempotency-Key` header. JSON `batchId` takes precedence. If neither is
supplied, the server creates a new ID for each request, so a blind HTTP retry
can create another logical job.

```js
// Persist with the business operation before sending. Reuse on any retry.
const batchId = crypto.randomUUID();
const response = await fetch("http://localhost:8888/api/integration/print", {
  method: "POST",
  headers: { "Content-Type": "application/json", "Idempotency-Key": batchId },
  body: JSON.stringify({
    profileId: "product-label-rfid",
    renderMode: "native",
    printerName: "Zebra ZT610R Line 1",
    copies: 1,
    values: { field_rfid: "000000000000000000000001" }
  })
});
```

Normal success includes `print.delivery: "spool-accepted"`, `print.batchId`
and one Windows ID in `print.jobIds`. If waiting ends with an unresolved
connector state, or the same existing ID is submitted again, HTTP `202`
reports the retained ID and state rather than generating another print:

```json
{
  "ok": true,
  "pending": true,
  "batchId": "persisted-business-batch-id",
  "print": { "delivery": "spooling", "verification": "not-physical", "jobId": 42 }
}
```

`pending` means status review is required; inspect `print.delivery` even if
HTTP status is 202. It can report a terminal failure/uncertainty as well as an
in-progress state. Query the same connector using authenticated
`POST /v1/print/batch` with `{ "action": "status", "batchId": "..." }`, or use
the Windows spool jobs panel. A lost response to `append`/`commit` is retried
only with the exact same batch ID, sequence, and payload. A recovered batch
requires the operator's explicit recovery decision. Never replace an
uncertain batch ID with a new ID to force a retry.

## Compile Example

```text
POST /api/integration/compile
```

Response fields include:

```json
{
  "ok": true,
  "language": "zpl",
  "bytes": 1234,
  "payloadBase64": "...",
  "zpl": "^XA..."
}
```

## RFID

RFID EPC writes are generated from the template RFID settings and resolved per
copy/data-feed row. The Zebra write sequence uses:

```zpl
^MMT
^RFW,H,,,A^FD000000000000000000000001^FS
```

For supported ZT400/ZT600 RFID models, memory bank `A` writes EPC data from
word 2 and lets the printer update the Gen2 PC length bits to match the actual
payload. Other Link-OS models retain the explicit bank/start-word form.

The normal production path uses the RFID settings saved by Zebra tag
calibration. If a template explicitly enables job overrides, the setup is
emitted with the current Link-OS syntax:

```zpl
^RS8,F15,,3,P
^RW18,22,A4
```

The app does not emit the obsolete adaptive-antenna setting, which was removed
from current Link-OS firmware.

Defaults:

- EPC memory bank: `1`
- EPC start block: `2`
- Format: hex (`H`)
- Length: derived from the configured chip/bit length or data when auto length
  is enabled

Before Windows staging can be committed, enabled HEX RFID rows are checked
against the original resolved value: empty/non-hex data, invalid word length,
fixed-length mismatches, and payloads exceeding configured EPC capacity stop
the entire batch. This guard does not change ASCII templates or replace
printer/tag calibration and read-back verification.

Read-and-print jobs define text, Code 128, and QR fields with one `^FN`
variable, then execute `^RFR` in the same `^XA...^XZ` format. EPC reads use
the tag PC bits by default (`^RFR,H,,,E`) so 96-bit and longer EPC values are
not truncated to a fixed 12-byte range.

## Local Print Connector

Connector `0.5.0` or newer, advertising `rawSpoolBatchV1`, must run on the
workstation for staged Windows printing. Older connectors are rejected for
this path instead of falling back to one job per chunk.
Windows uses WinSpool RAW for USB-B queues; Windows and macOS can use direct TCP
port 9100:

```powershell
.\ZbrePrinterLocalPrintAgent-windows-x64.exe --port 17917 --tcp-ports 9100
```

The Windows printer queue must already exist through a Zebra or Seagull driver.
RAW success means `WritePrinter`/WinSpool accepted all bytes for that spool job.
TCP and COM success similarly means host transport acceptance. Power loss,
media/ribbon faults, RFID VOID tags, or a printer-side cancellation can still
reduce the physical output, so uncertain ranges require operator
reconciliation before resend.
