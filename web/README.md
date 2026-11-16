# ZbrePrinter

Source hiện tại: **3.9.2**, connector **0.12.2**. Đây là phần web/connector
trong repo Printer-controller; xem [README chính](../README.md) để biết kiến
trúc, thứ tự review và lệnh build desktop. Các ghi chú phiên bản bên dưới
được giữ làm tài liệu lịch sử kỹ thuật.

ZbrePrinter is a cloud-capable and local Zebra ZPL label designer and print
integration layer for
Zebra RFID printers such as ZT610 RFID, ZT231 RFID, and ZD621R.

Version 3.8.0 adds absolute template rotation (0/90/180/270 degrees), rotating
all element frames and swapping label dimensions on quarter turns. Text,
images and tables share frame-aware editor/bitmap geometry; text editing,
undo/redo and saved templates retain rotation. Native RFID text and Data Matrix
support all four orientations. Printer-resolved native QR remains normal-only
due to the Zebra `^BQ` command. Connector remains at 0.11.0.

Version 3.7.0 moves RFID counter ownership into connector 0.11.0 with
`connectorCounterLifecycleV1`: verified baseline before labels, durable counter
checkpoints, and stable final samples bracketed by queue checks on the original
connection. Stored absolute machine snapshots have timestamps and remain separate
from roll deltas. Missing final boundaries identify the unreconciled runs; EPC
records and historical exports remain intact after interrupted connections.

Roll closure remains separate from CSV export for continuous RFID reading
or verified EPC writing. An open roll accumulates runs until the operator closes
it; a new print then starts a separate roll. Historical open rolls require an
explicit choice to resume or close. Closed history remains available for later
CSV export; operator, business job ID and roll number are entered at first export.
The delivery is a standard seven-column CSV without a password, with explicit
count certainty and unresolved-run information. Connector 0.11.0 with
`productionRollLifecycleV1` and `connectorCounterLifecycleV1` is required;
build it with Go 1.22+.
RFID VOID does not pause the read job or require a manual run review. Actual
head/media/ribbon faults are monitored by the connector independently of UI
polling and trigger serialized pause/clear without replay. Printer VALID,
saved EPC, removed VALID and quantity-based GOOD are separate. Open rolls are
bound to printer, template fingerprint, operation mode and memory bank.
Write capture uses a dedicated readback of the intended write range and saves
expected bytes; a readable but mismatching value is not verified GOOD.
The operator UI shows controls, counts and actionable states without persistent
workflow explanations. Capture/counter failures after submission request a bounded
pause and queue clear before quarantining the run.

It is based on the completed `nextprinter` designer workflow, but the Zebra
build path emits ZPL:

- full-label bitmap output through `^GFA :Z64:` for lossless visual fidelity
  with substantially less TCP traffic,
- RFID EPC read/write commands through `^RF`, `^RS`, `^RW`, and `^RFW`,
- standard label setup through `^XA`, `^CI28`, `^PW`, `^LL`, `~SD`, `^PR`,
  `^PQ`, and `^XZ`.

## Print Paths

The app supports:

- `PRINTER`: USB-B Zebra printers installed as Windows printer queues, sent as
  RAW ZPL through the cross-platform Local Print Connector. The same path also
  supports a Windows queue attached to a Standard TCP/IP Port.
- `TCP/IP`: direct RAW ZPL socket output through the Local Print Connector to
  the printer IP (normally TCP port `9100`). A local standalone Next.js server
  remains available as a compatibility path.
- `COM`: browser Web Serial / RS232 flow for operator-driven printing.

## Batch printing and coordination

The Print step accepts positive safe-integer quantities without a fixed 2,500-label cap. This remains a
general template-printing feature:

- Print and control operations are FIFO per normalized printer target inside
  one browser/desktop renderer process. TCP uses `host:port`, Windows RAW uses
  `connector URL + printer queue`, and COM uses the selected Web Serial port.
  Unrelated printer targets may run in parallel. The Next runtime and connector
  add their own bounded per-target queues as final admission layers.
- Static templates with no per-copy data download one temporary Zebra stored
  graphic, recall it with `^XG`, and repeat it in windows of at most 100 labels
  with `^PQ`. The final window deletes the temporary graphic. This avoids
  resending the full bitmap for every window while retaining useful failure
  checkpoints.
- Templates with imported rows, serial fields, or normal RFID data keep their
  per-label values and are packed by actual encoded byte size. A dynamic chunk
  contains at most 25 labels, or 10 when RFID read/write is enabled. Transport
  byte targets are 512 KiB for Windows RAW, 256 KiB for direct TCP, and 32 KiB
  for COM; an individual label is never split across chunks.
- One direct-TCP batch keeps one RAW `9100` socket open from the first
  checkpoint through `finish`; HTTP checkpoints do not reconnect the Zebra.
  The error/status barrier after a checkpoint is queried on that same socket,
  preserving its ordering with the preceding print bytes.
- A multi-chunk Windows RAW batch uses one `batchId` and monotonic sequence,
  and the connector holds the normalized WinSpool target lease until the final
  chunk. This prevents two tabs/processes from interleaving A1-B1-A2-B2 spool
  documents. Same-process replay of an accepted sequence returns its cached
  receipt instead of spooling it twice.
- TCP and COM gate the next chunk with Zebra-native `~HQES`, then require all
  three framed `~HS` records. The next window waits for zero queued formats,
  zero labels remaining, no partial format/buffer-full condition, and no peel
  label waiting; printer faults stop the batch instead of being treated as a
  ready/empty timeout.
- Persistent TCP checkpoints use `(jobId, sequence, SHA-256)` replay identity
  plus a cumulative hash chain. If an HTTP response is lost while the same
  connector process is still alive, the client can replay or poll the same
  checkpoint and receive its retained receipt.
- A partial printer-socket write marks the session uncertain and stops it.
  The software never creates a new socket or silently falls back to stateless
  resend after a checkpoint may have reached the Zebra.
- COM supports two flow-control modes: no handshake and hardware RTS/CTS. The
  selected Web Serial mode must match the Zebra Host Handshake configuration;
  large COM batches should use RTS/CTS when the printer and cable expose it.
- Batch execution does not generate or require timestamp/count values; those
  remain ordinary template or imported-data fields when a design needs them.

These queues and TCP/RAW batch receipts are held in process memory; they are not a
durable job ledger and do not provide exactly-once delivery across a process
restart, power loss, cable failure, or printer fault. TCP/COM receipts confirm
bytes accepted by the host connection, and Windows RAW confirms WinSpool queue
acceptance. A successful Zebra status barrier reports current printer error
flags, but none of these receipts proves that every physical label/tag finished
successfully. Reconcile printed and VOID tags before resuming any uncertain
range.

When hosted on Vercel, printer traffic does not originate from the Vercel
Function. The browser calls a paired connector on the workstation or a
MacBook site gateway, and that connector reaches the private Zebra network.
See [the cloud deployment runbook](docs/cloud-deployment.md).

For the supported split between the hosted Basic edition and the installed
Windows desktop edition, including their persistence and reliability
boundaries, see
[the online/offline editions guide](docs/online-offline-editions.md).

For Windows Standard TCP/IP Port setup, connection tests, and a standalone ZPL
test sender, see [`TCP IP Setup/README.md`](TCP%20IP%20Setup/README.md).

The legacy customer-facing HTTP print route remains for local standalone
deployments. File-backed profiles and the in-memory browser-listener queue are
disabled by default in cloud mode because they are not durable on Vercel.

## Install

Install Node.js 20.19 or newer first if `npm` is not available. Install
dependencies separately on each operating system; do not copy `node_modules`
or `.next` between Windows and macOS.

```bash
npm ci
```

## Run

Development:

```bash
npm run dev
```

Production-like local serving:

```bash
npm run build
npm run start
```

`npm run start` defaults to loopback for safe same-machine operation. To keep
a legacy Windows deployment reachable from the company LAN, make the exposure
explicit and restrict server-side TCP to the intended Zebra:

```powershell
$env:HOSTNAME = "0.0.0.0"
$env:NEXTWAVES_SERVER_TCP = "enabled"
$env:NEXTWAVES_SERVER_TCP_HOSTS = "192.168.50.50"
$env:NEXTWAVES_SERVER_TCP_PORTS = "9100"
npm run start
```

Allow inbound TCP `8888` only from the required company/VPN subnet. Vercel
ignores these local switches and never opens raw TCP from a hosted function.

## macOS Direct TCP/IP

The recommended macOS path is RAW TCP/IP through the Local Print Connector. It
does not require a Zebra macOS driver or a macOS printer queue.

For a printer configured as `192.168.50.50`, subnet mask `255.255.255.0`, and
RAW port `9100`, configure the directly connected Mac Ethernet interface with
an unused address in the same subnet, for example:

```text
IPv4 address: 192.168.50.10
Subnet mask:  255.255.255.0
Router:       blank
```

Keep Wi-Fi on DHCP if the Mac also needs Internet access. Verify the printer
socket before starting the application:

```bash
route -n get 192.168.50.50
nc -G 3 -vz 192.168.50.50 9100
```

For local standalone compatibility, run the production build on loopback:

```bash
npm ci
npm run typecheck
npm run build
HOSTNAME=127.0.0.1 npm run start
```

Open `http://localhost:8888`, select `TCP/IP` under Target printer, and enter
`192.168.50.50` with port `9100`. The browser UI sends the job to the local
Next.js server, and the server opens the RAW TCP socket to the printer.

For a Vercel deployment, run the macOS connector instead and pair it through
the Printer setup dialog. If one MacBook is the only machine connected to the
Zebra, use its optional site-gateway mode as documented in the cloud runbook.

## Local Print Connector

Local Print Connector `0.4.0` supports Windows x64/ARM64 and macOS
Intel/Apple Silicon. It
binds loopback by default, uses exact-origin pairing for hosted pages, limits
TCP destinations and ports, and supports WinSpool RAW only on Windows.

```powershell
.\ZbrePrinterLocalPrintAgent-windows-x64.exe
```

Default endpoint:

```text
http://127.0.0.1:17917
```

Useful endpoints:

```text
GET  http://127.0.0.1:17917/v1/health
POST http://127.0.0.1:17917/v1/pair
GET  http://127.0.0.1:17917/v1/printers
POST http://127.0.0.1:17917/v1/print
POST http://127.0.0.1:17917/v1/tcp/exchange
POST http://127.0.0.1:17917/v1/tcp/job
```

Full protocol documentation is in
[`native/local_print_agent_go/PROTOCOL.md`](native/local_print_agent_go/PROTOCOL.md).
The original Python Windows agent and npm commands remain in the repository
for loopback-only legacy deployments.

For multi-printer PCs, rename each Windows queue clearly, for example:

```text
Zebra ZT610 RFID Line 1
Zebra ZD621R Line 2
```

## Customer API

The following API is intended for the original local standalone mode. Cloud
mode denies it unless durable storage, authentication and an API key are
deliberately configured.

After a template is published as an API profile, the visual-fidelity
browser-listener flow is:

```text
POST http://localhost:8888/api/integration/print
```

Send `profileId` in the JSON body. The dedicated
`/api/integration/profiles/{profileId}/print` endpoint uses direct native/RAW
rendering instead. Generic `/print` is a compatibility alias and also accepts a
published `profileId`, a full `.nwl` template, or a configured printer alias:

```json
{
  "printerName": "tem_loai_a",
  "values": {
    "product_name": "Sample product",
    "qr_code": "https://example.com/item/ABC001",
    "rfid_id": "000000000000000000000001"
  }
}
```

The browser-listener API returns HTTP `202` with `jobId` and `statusUrl` when a
job is queued or still in flight. Poll that URL until the status becomes
`accepted`, `error`, or `timeout`. `waitForCompletion: true` only bounds how
long the HTTP request waits; reaching that bound returns `202` and does not
delete the queued job. The queue and status records are still process-memory
state, so this polling contract does not survive a Next runtime restart.

Use `"renderMode": "native"` only for ZPL debugging. The default
`browser-listener` mode is the recommended production path because it preserves
icons, web fonts, QR, barcode, Vietnamese text, and table layout as a single
ZPL bitmap job.

## RFID Notes

When RFID is enabled in the template, ZbrePrinter resolves the configured RFID
data per row/copy. On a ZT400/ZT600 RFID printer (including ZT610R), it uses
EPC memory bank `A`:

```zpl
^RFW,H,,,A^FD000000000000000000000001^FS
```

Bank `A` starts at EPC word `2` and makes the printer update the Gen2 PC length
bits to match the actual `^FD` payload. This prevents a variable-length EPC
write from leaving stale PC bits, one cause of `02000423 / GEN2 MEMORY BAD PC`.
Models without documented bank-`A` support retain the explicit bank-`1`,
start-word-`2` command.

For read-and-print labels, the EPC is read and substituted into every matching
`^FN` field in the same active format. EPC length is read from the tag PC bits
by default:

```zpl
^FO40,40^A0N,28,28^FN1^FS
^FO40,120^BY2^BCN,96,Y,N,N^FN1^FS
^FO464,96^BQN,2,4^FDQA,^FN1^FS
^RFR,H,,,E^FN1^FS
```

Calibrated Zebra RFID tuning is used by default. Every RFID format emits `^RS`
for its attempts/error policy while leaving program position blank; a manual
job-tuning override may also fill the `^RS` position and emit `^RW` for
read/write power and antenna selection. `Attempts` and `After attempts` are
job-only policy, not SGD values returned by GET RFID. The safe default is `P`
(pause/retain); `N` explicitly drops the failed format and can reduce the
valid-label count.

Printer Config GET RFID first requests named Link-OS JSON values, then falls
back to individual SGD reads for older firmware. It reports reader identity,
program position, read/write power, antenna element, adaptive mode, region,
active RFID error and valid/VOID counters. SET RFID reads the written keys back
and reports a mismatch instead of treating socket acceptance as verification.
Adaptive antenna is available on supported ZT400/ZT600 media only when label
length is at least 51 mm.

Zebra tear-off is stored as `ezpl.tear_off` / `~TA` dots, not millimetres.
Normal jobs preserve the printer value. A job emits `~TA` only after the local
printer profile has a known dot value and the operator explicitly enables the
override; note that `~TA` remains persistent in the printer after that job.
