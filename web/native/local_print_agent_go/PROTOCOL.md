# Nextwaves Zebra Local Print Connector

This connector keeps printer I/O on the user's workstation while the design
application is hosted on Vercel or another HTTPS origin. It defaults to
loopback-only operation. An explicit private or link-local IP can enable the
optional LAN/VPN site-gateway mode.

Connector **0.11.0** is required by desktop **3.7.0**. In addition to the
existing TCP/RAW capabilities, `/v1/health` advertises `productionRollV1`,
`productionRollIdentityV2`, `productionRollCountsV2`, `productionRollLifecycleV1`, `rfidWriteVerifyV1`,
`productionRemovalAccountingV2`, `tcpFaultCounterReconciliationV1`, `connectorCounterLifecycleV1`
when RFID evidence storage is configured, and `tcpServiceFaultLatchV1`
and `tcpBackgroundMonitorV1`.
The desktop checks these capabilities as well as the minimum version.

For an active TCP job, a detected head-open, media-out or ribbon-out status
latches the run, writes `~PP` followed by `~JA` on that same serialized socket,
and rejects later payloads, Resume and finish. Query/poll responses expose
`serviceFault` and `faultClearRequested`. The latter proves a complete control
write, not that the physical printer buffer is empty. A status-query failure
after committed label bytes also attempts a bounded same-socket pause/clear
before quarantine. There is no reconnect/replay of label payloads. Physical
inspection is required before a new run. For a known service fault whose
pause/clear command was sent, the next Print request verifies fresh fault-free
`~HQES` and empty-buffer `~HS` responses before releasing the stopped session;
it resumes a paused printer only after those checks. Other uncertain transport
outcomes retain explicit reconciliation. Polling can miss
a brief open/close between observations; printer-panel Resume must not be used
to resume an interrupted production run. Generated RFID formats additionally
set `^JZN` to disable firmware error reprint, without persisting it with `^JUS`.

Version 0.9.1 also requests bounded pause/clear for capture-storage and counter
failures after label submission. The run remains uncertain and cannot be replayed;
a successful control write does not establish physical cancellation or recovered
evidence. The operator must reconcile the affected output before a new run.

## Run

Build requires Go 1.22+.

### Production roll lifecycle in 0.10.0

`roll-create` without `rollId` creates a new logical roll. It never selects a
historical draft implicitly. A same-printer open roll must first be explicitly
resumed with its `rollId`, or closed. A closed roll cannot accept a later run.
Business `jobId` is descriptive export metadata, not the durable roll identity;
new lots may use the same business ID without merging their histories. New CSV
filenames include a short roll-identity suffix to distinguish these downloads.

`roll-close` accepts `{rollId, closedBy?, note?}`. It durably changes an `open`
roll to `closed`, records `closedAt`, optional `closedBy`/`closeNote` and any
`closeWarnings`, and releases its logical printer binding. It does not generate
or download CSV, require export metadata, delete raw evidence, send any printer
command, or clear TCP quarantine. Closing an already closed/finalized roll is
idempotent. Active/queued print sessions prevent closure; admission, registration
and close are serialized so a closed roll cannot acquire a late run. Missing,
corrupt or incomplete historical evidence does not prevent closing; its blockers
and unknown counts remain visible. Closure is never a physical count/QC assertion.

`roll-export` requires a closed roll. Its first archive requires
`{rollId, operator, jobId, rollNumber}` and records `exportedAt`/`exportedBy`.
The state stays `closed`. Once archived, repeated requests return exactly the
saved, hash-verified bytes and filename even if new metadata is supplied or raw
evidence is unavailable. Download failure does not reopen the roll. Export
blockers for missing/corrupt evidence remain enforced. A closed legacy roll with
unclassified removals exports its saved removal total and explicit unknown GOOD
classification; closure does not manufacture missing evidence or counts.
Legacy `finalized` manifests and their archived CSV files remain unchanged.

A roll identity rejection during TCP admission returns `stage: "admission"`,
`outcome: "not_sent"`, `retrySafety: "safe"`, and zero bytes/write flags, because
that path precedes all socket writes. These fields do not clear uncertainty from
an earlier run. Reporting conflicts are not generically marked safe to resend.

### Production roll evidence in 0.9.2

After a known media/ribbon/head fault, the connector can finalize the actual
VALID/VOID deltas for the interrupted run without claiming all requested labels
printed. The same original socket must have sent pause/clear and then observed
a paused, empty `~HS` queue around two fresh, identical counter triplets at least
250 ms apart. Collection is bounded to three rounds / four seconds. Complete
submitted single-label formats bound the maximum attributable RFID attempts.
A counter decrease is retained as a permanent uncertainty for that run.
The durable `audit.counterReconciliation` records the samples and checkpoint;
the capture stays `interrupted`. Missing EPC data remains missing. Reset counters,
lost connections, uncertain cancellation or evidence-storage failure cannot be
repaired by a later healthy run. No payload is replayed.

The connector starts its own serialized status monitor after the first data
append, independent of HTTP polling. The default interval is 500 ms with a
bounded response timeout; append/query/control and the monitor share the
session mutex and the existing single capture reader. A confirmed service
fault latches pause/clear once, samples available counters and terminalizes
the capture without waiting for the UI. Ordinary Pause and isolated VOID do
not cancel the run. Monitor traffic does not renew the owner's idle lease.
Lease expiry and controlled shutdown attempt pause/clear before disconnect.
This does not generate unsent labels, survive process death, or guarantee
detection of physical events between status observations.

`roll-create` and capture options bind the draft to `templateFingerprint`,
`printerHost`/`printerPort` (job target for capture), `operationMode`
(`read`, `write`, `read_write`) and `bank`. The fingerprint is recomputed from
the actual current template for each run. Empty drafts may be corrected;
nonempty drafts reject changed identity and uncaptured jobs at the same
endpoint, including another owner. Validation is repeated after queue
ownership and at registration. Read-only status operations remain available.
Legacy drafts can resume when stored identity matches, with explicit legacy
provenance limits; no old write is retroactively marked verified.

`roll-adjust` accepts `{rollId, removedGoodCount, removedRejectedCount}`: two
cumulative nonnegative quantities, persisted with adjustment history. Removing
a GOOD label reduces GOOD once; removing an already rejected/unverified write
does not. Both counts are required together and cannot exceed their observed
physical pools; edits during active printing are rejected. Saving the same totals
again is idempotent. `removedValidCount` remains a compatibility total and is
accepted as an input only for read-only legacy clients. Old open write rolls with
positive unclassified removals require one explicit classification before export.
Existing finalized CSV bytes remain unchanged. Removal never deletes raw records
or assigns a physical removal to an EPC.
Responses separate `printerValidCount`, `capturedEpcCount`,
`capturedReadbackCount`, `missingEpcCount`, `removedValidCount`, `goodCount`,
`printerValidKnown`, `goodCountKnown`, `writeMismatchCount`,
`writeUnverifiedCount` and `writeVerificationIssues`.
The old `validCount` is now an alias of measured printer VALID, never the
maximum of counters and captured rows. Incomplete measurements remain marked
provisional. Write GOOD sums each run's minimum of native VALID and matching
verified EPCs, then subtracts only removed GOOD. A definite mismatched write is
already excluded: it does not make an otherwise fully classified GOOD total
provisional. Missing/duplicate/conflicting responses still do. A successful later
retry retains the original mismatch or uncertainty in the history.

Read capture frames retain `NWEP|job|ordinal|actualHex|END\r\n`. Write capture
uses `NWEP|job|ordinal|W|expectedHex|actualHex|END\r\n`, populated by a dedicated
FN2 read of exactly the written EPC range after the write. The collector
requires matching bytes for a successful write. Internal write CSVs append
`expected_hex` to the legacy seven-column raw format. Presentation CSVs still
have seven columns; write `detail` identifies the source row and expected
bytes on failure, while duplicate/order warnings remain in `result`.

The plain CSV format below remains in effect. The lifecycle in 0.10.0 replaces
the historical export-to-close behavior; the identity admission rules above
replace unrestricted legacy admission.

### Historical production roll contract in 0.8.0

This section describes old persisted data only, not the current API. Connector
0.10.0 uses explicit `roll-close` followed by optional `roll-export` as above.

`roll-create` starts or resumes the owner's open draft. `targetLabels`,
`templateName` and `templateFingerprint` are optional descriptive metadata;
`rollId` can identify a specific existing draft. No operator or business job
metadata is required to print. Run registration appends evidence to the draft
without review, exact-target, template or duplicate-EPC admission gates.

`roll-export` accepts `{rollId, operator, jobId, rollNumber}`. It validates the
three user fields, records the workstation export time, writes a durable
artifact and receipt, and closes the roll on successful delivery. Failed
exports leave the draft available. An already finalized roll can be downloaded
again with `{rollId}`. `roll-review` and `roll-finalize` are obsolete.

Exports are `text/csv; charset=utf-8`, without a password. Metadata
precedes the seven columns `ordinal,host_time,bank,value,result,received_time,detail`.
The local receipt verifies re-download bytes by SHA-256, not downstream
uploads. Systems requiring cryptographic provenance must implement signature
verification at ingestion. Historical 0.7.0 roll schemas below are retained for
reading legacy evidence; their review and QC workflow no longer applies.

Development:

```powershell
go run . --port 17917 --tcp-ports 9100
```

Packaged executable:

```powershell
.\ZbrePrinterLocalPrintAgent-windows-x64.exe --port 17917 --tcp-ports 9100
```

macOS:

```bash
chmod +x ./ZbrePrinterLocalPrintAgent-macos-arm64
./ZbrePrinterLocalPrintAgent-macos-arm64 --port 17917 --tcp-ports 9100
```

Flags:

- `--listen-address`: one literal loopback/private/link-local unicast IP;
  default `127.0.0.1`. Hostnames, wildcard, public, multicast, unspecified, and
  cloud-metadata addresses are rejected. A non-loopback value enables
  `siteMode`.
- `--port`: HTTP port; default `17917`.
- `--require-origin-token`: enables strict proxied-site authentication even
  while binding to loopback. Pairing then requires an HTTPS Origin, and every
  protected request requires that Origin plus its paired bearer token.
- `--tcp-ports`: comma-separated allowlist; default and recommended value
  `9100`. For example, `--tcp-ports 9100,6101`.
- `--allow-non-zebra-queues`: unsafe opt-in that lets the cloud origin submit
  Windows RAW jobs to queues not recognized as Zebra/ZDesigner/Seagull. By
  default, unknown, redirected, PDF/XPS, and other non-Zebra queues are denied.
- `--state-file`: optional location for paired-origin token hashes. The default
  is `Nextwaves/ZebraPrinterConnector/paired-origins.json` under the operating
  system's per-user configuration directory.

The connector prints an eight-digit, ten-minute one-time pairing code at
startup and after each successful pairing. It stores only SHA-256 token hashes,
not returned bearer tokens. Up to 32 independently paired browser tokens are
kept for each exact Origin; pairing another employee/browser does not
invalidate existing tokens. When that cap is exceeded, the oldest token for
that Origin is evicted.

Pairing state schema version 2 stores a `tokens` array under each Origin.
Existing version 1 files containing one `tokenSha256`/`pairedAt` record are
migrated atomically at startup and remain valid. The `pairedOrigins` health
field continues to count exact Origins, not browser tokens.

## Browser pairing

The cloud page calls:

```http
POST http://127.0.0.1:17917/v1/pair
Origin: https://labels.example.com
Content-Type: application/json

{"code":"12345678"}
```

Success:

```json
{
  "ok": true,
  "origin": "https://labels.example.com",
  "token": "<random-token>",
  "tokenType": "Bearer",
  "tokenHeader": "Authorization"
}
```

The page must retain that token and add it to every protected request:

```http
Authorization: Bearer <random-token>
```

`X-Nextwaves-Token` is also accepted. HTTP/HTTPS localhost origins are
automatically allowed without a token so the existing local application keeps
working only in the default legacy loopback mode. Requests with no `Origin`
header are treated as local CLI/native requests only when both `siteMode` and
`requireOriginToken` are false.

The hosted application's CSP must allow
`connect-src http://127.0.0.1:17917`. The connector answers Private Network
Access preflights with `Access-Control-Allow-Private-Network: true`. CORS always
returns the exact approved origin and never `*`.

## Strict proxied-site mode

Use this mode when an HTTPS reverse proxy or local secure gateway is the LAN
entry point, while the connector itself remains isolated on loopback:

```bash
./ZbrePrinterLocalPrintAgent-macos-arm64 \
  --listen-address 127.0.0.1 \
  --port 17917 \
  --require-origin-token \
  --tcp-ports 9100
```

This produces `siteMode: false` and `requireOriginToken: true`. The reverse
proxy must:

- expose a company-controlled HTTPS URL with a trusted certificate;
- forward requests only to `http://127.0.0.1:17917`;
- rewrite the upstream `Host` header to exactly `127.0.0.1:17917`;
- preserve `Origin`, `Authorization` or `X-Nextwaves-Token`, `Content-Type`,
  and Private/Local Network Access request headers;
- pass the connector's exact CORS and PNA response headers unchanged;
- enforce its own source-network and request-size controls.

In strict mode, pairing without Origin, pairing from an HTTP Origin, protected
requests without Origin, and tokenless localhost Origin requests are all
rejected. This flag closes the legacy local-CLI trust path without exposing the
Go process directly on the LAN.

## Optional site-gateway mode

Site-gateway mode lets one always-on Mac or Windows machine reach the Zebra
printer and receive jobs directly from employee browsers:

```text
Vercel HTTPS page -> employee browser -> Mac LAN IP:17917
                                      -> Zebra 192.168.50.50:9100
```

The Vercel server does not connect to the private printer or gateway. Each
employee browser must have a network route to the gateway through the same
company LAN or an approved VPN.

For a Mac with Zebra connected directly by Ethernet:

1. Keep the printer at `192.168.50.50/24`.
2. Give the printer-facing Mac Ethernet interface an address such as
   `192.168.50.10/24` with no router on that interface.
3. Keep the Mac connected to the employee/company network through another
   interface. Give that company-facing interface a static address or DHCP
   reservation, for example `10.20.30.25`.
4. Bind the gateway to the company-facing address:

```bash
./ZbrePrinterLocalPrintAgent-macos-arm64 \
  --listen-address 10.20.30.25 \
  --port 17917 \
  --tcp-ports 9100
```

Use the exact literal address in the web configuration:
`http://10.20.30.25:17917`. Hostnames are intentionally unsupported by the
connector's DNS-rebinding protection. If employees are actually on the
`192.168.50.0/24` printer network, the connector may instead bind to
`192.168.50.10`.

Site-mode security differs from loopback mode:

- `GET /v1/health` remains public.
- `POST /v1/pair` requires an actual HTTPS `Origin` header and the one-time
  console code; supplying only an `origin` JSON field is rejected.
- Every protected endpoint requires an HTTPS Origin that is already paired and
  a matching bearer token.
- Protected requests without `Origin` are rejected, including curl/native CLI
  requests.
- The HTTP `Host` header must exactly match the configured IP and port.

Direct site mode automatically enables the same effective
`requireOriginToken` policy; adding the flag there is harmless but unnecessary.

Allow inbound TCP `17917` in the Mac/Windows and network firewall only from
approved company LAN/VPN source subnets. Do not expose or port-forward `17917`
to the Internet. Do not bind the connector to a guest Wi-Fi or another
untrusted network. Plain HTTP does not encrypt the bearer token or print data
on the LAN; use a trusted segmented LAN/VPN, or put an authenticated TLS
gateway with a managed certificate in front of this service.

Browser policy is an independent deployment constraint. A hosted HTTPS page
must permit the gateway URL in its `connect-src` CSP and the browser must allow
Private/Local Network Access. Some browser or enterprise policies block an
HTTPS page from calling a plain-HTTP LAN address even when the PNA preflight is
correct; those environments require an HTTPS gateway/reverse proxy with a
trusted certificate. Validate this policy on the company-managed browser
before rollout.

## API

### `GET /v1/health`

Public discovery endpoint:

```json
{
  "ok": true,
  "name": "Nextwaves Zebra Local Print Connector",
  "version": "0.5.1",
  "platform": "windows",
  "arch": "amd64",
  "win32print": true,
  "windowsRaw": true,
  "tcp": true,
  "capabilities": {
    "tcpExchangeV1": true,
    "tcpJobV1": true,
    "tcpJobIdempotencyV1": true,
    "printerTargetQueueV1": true,
    "rawBatchLeaseV1": true,
    "rawSpoolBatchV1": true
  },
  "printerQueue": {
    "targets": 1,
    "active": 1,
    "queued": 3
  },
  "tcpJobs": {
    "active": 1,
    "retained": 2
  },
  "rawBatches": {
    "open": 1,
    "uncertain": 0,
    "retained": 1
  },
  "rawSpoolBatches": {
    "staging": 0,
    "queued": 1,
    "spooling": 0,
    "uncertain": 0,
    "failed": 0
  },
  "host": "127.0.0.1",
  "listenAddress": "127.0.0.1",
  "siteMode": false,
  "requireOriginToken": false,
  "port": 17917,
  "pairedOrigins": 1,
  "pairingCodeExpiresAt": "2026-07-26T12:00:00Z",
  "allowedTCPPorts": [9100],
  "allowNonZebraQueues": false
}
```

`win32print` and `windowsRaw` are false on macOS. `tcp` is true on all
supported platforms.

### `POST /v1/pair`

Body: `{"code":"12345678"}`. The HTTPS `Origin` header is the identity being
paired. Only legacy loopback mode may let a native CLI without `Origin`
provide an `origin` field. Site mode and `--require-origin-token` always require
the real HTTPS header.

### `GET /v1/printers`

Returns the existing UI-compatible shape:

```json
{
  "printers": [
    {
      "name": "ZDesigner ZT610-300dpi ZPL",
      "description": "",
      "comment": "",
      "portName": "USB001",
      "driverName": "ZDesigner ZT610-300dpi ZPL",
      "isDefault": true
    }
  ]
}
```

It enumerates WinSpool queues on Windows. macOS returns `{"printers":[]}`;
macOS printing uses the TCP endpoint.

### `POST /v1/print`

Windows RAW request, compatible with the existing TypeScript client:

```json
{
  "printerName": "ZDesigner ZT610-300dpi ZPL",
  "documentName": "Nextwaves label",
  "language": "zpl",
  "payloadBase64": "XlhBXlha"
}
```

Success keeps the existing response fields:

```json
{
  "ok": true,
  "printerName": "ZDesigner ZT610-300dpi ZPL",
  "documentName": "Nextwaves label",
  "jobId": 42,
  "bytesWritten": 6,
  "portName": "USB001",
  "driverName": "ZDesigner ZT610-300dpi ZPL",
  "warning": ""
}
```

The endpoint returns HTTP `501` on macOS because WinSpool RAW queues do not
exist there.

Requests to the same normalized Windows printer name pass through one bounded
FIFO operation queue; different printer queues may proceed in parallel. A
successful response means `WritePrinter` and `EndDocPrinter` accepted the RAW
spool job. It does not prove that the Windows port monitor delivered every byte
to the device or that every physical label/tag completed.

For a logical job split across multiple HTTP payloads, every request must add
the same URL-safe `batchId`, a strictly increasing `sequence`, and
`finalChunk:true` only on the last chunk:

```json
{
  "printerName": "ZDesigner ZT610-300dpi ZPL",
  "documentName": "Batch A [2/4]",
  "language": "zpl",
  "payloadBase64": "XlhBXlha",
  "batchId": "018f47d6-b48f-7e31-8f5f-0d6ca4f62948",
  "sequence": 2,
  "finalChunk": false
}
```

The connector holds the printer lease from sequence 1 through the final
sequence, so two web/app clients cannot interleave their spool documents. A
successful receipt echoes `batchId`, `sequence`, `nextSequence`, `batchState`,
`finalChunk`, and `payloadSha256`. Replaying the same sequence and payload in
the same connector process returns the cached receipt with
`deduplicated:true`; reusing a sequence with different bytes is rejected.
After a possibly-sent WinSpool failure, the target stays quarantined for the
30-minute reconciliation window instead of admitting another ZPL stream.
These receipts and leases are memory-only: a connector restart destroys them,
so a request whose response was lost across restart remains `uncertain` and
must not be retried automatically.

### `POST /v1/tcp/exchange`

Request compatible with the current Next.js TCP route:

```json
{
  "host": "192.168.50.50",
  "port": 9100,
  "payloadBase64": "XlhBXlha",
  "readWindowMs": 0,
  "readIdleMs": 100,
  "closeWaitMs": 750,
  "connectTimeoutMs": 5000
}
```

`text` may replace `payloadBase64` for SGD/ZPL text exchanges. Success:

```json
{
  "ok": true,
  "bytesWritten": 6,
  "response": "",
  "resolvedAddress": "192.168.50.50"
}
```

TCP destinations are DNS-pinned after resolution and must be RFC 1918/ULA
private or link-local unicast addresses. Loopback, public, multicast, and
unspecified addresses are rejected. Cloud metadata targets, including
`169.254.169.254`, `169.254.170.2`, and their common IPv6 equivalents, are
explicitly blocked even though other link-local destinations are allowed. The
destination port must be in the connector's startup allowlist.

TCP exchanges to the same normalized `host:port` pass through the same bounded
per-target operation queue used by persistent-job append/query actions.
Successful `bytesWritten` is a host-socket receipt, not a physical-label count.

### `POST /v1/tcp/job`

Persistent batch transport. All actions for one `jobId` reuse one printer TCP
socket. Sequence numbers are 1-based.

Only one active persistent job is admitted for an identical normalized
`host:port`. A competing `open` returns `TCP_JOB_TARGET_BUSY` with a proven
`not_sent` outcome; the calling application should keep the complete logical
job in its per-printer FIFO and retry admission after the owner finishes. The
connector does not persist that waiting logical job itself.

Open:

```json
{
  "action": "open",
  "jobId": "018f47d6-b48f-7e31-8f5f-0d6ca4f62948",
  "host": "192.168.50.50",
  "port": 9100,
  "connectTimeoutMs": 10000,
  "writeTimeoutMs": 30000,
  "idleTimeoutMs": 300000
}
```

Append:

```json
{
  "action": "append",
  "jobId": "018f47d6-b48f-7e31-8f5f-0d6ca4f62948",
  "sequence": 1,
  "payloadBase64": "XlhBXlha",
  "payloadSha256": "<SHA-256 of decoded payload>"
}
```

Other actions:

```json
{"action":"query","jobId":"018f47d6-b48f-7e31-8f5f-0d6ca4f62948",
 "payloadBase64":"ISBVMSBnZXR2YXIgInpwbC5zeXN0ZW1fc3RhdHVzIg0K",
 "readWindowMs":8000,"readIdleMs":300}
{"action":"poll","jobId":"018f47d6-b48f-7e31-8f5f-0d6ca4f62948"}
{"action":"abort","jobId":"018f47d6-b48f-7e31-8f5f-0d6ca4f62948"}
{"action":"finish","jobId":"018f47d6-b48f-7e31-8f5f-0d6ca4f62948","expectedSequence":12,"expectedBytes":345678,"checkpointHash":"<last receipt hash>"}
```

Connector 0.5.1 adds `tcpJobReconcileV1`. After a physical audit, a stopped
job can be acknowledged without reopening it or sending any printer bytes:

```json
{"action":"reconcile","jobId":"018f47d6-b48f-7e31-8f5f-0d6ca4f62948","confirmed":true,"reconciliationNote":"Verified rows 2500-2471, EPCs correct, buffer empty; remaining 2470-2450.","expectedSequence":3,"expectedBytes":345678,"checkpointHash":"<current poll checkpoint hash>"}
```

Read `poll` first and use its actual checkpoint, byte count, and
`nextSequence - 1`. `confirmed: true` and a note of 8–2000 characters are
required. Only the job owner may acknowledge it. Active and finished jobs,
or stale checkpoints, are rejected. The response includes `host`, `port`,
`reconciled` and `reconciliationNote`; the original state and receipts remain
unchanged. Repeating this action is idempotent. It releases that record's
target quarantine only for future jobs; it never retries the stopped job.
Other unreconciled records still block admission. Records remain in memory
under the existing terminal retention policy, not durable across restart.

The UI treats a confirmed operator Pause as a waiting state. Continue status
queries on the existing socket while paused; a successful query refreshes
the idle timeout. After Resume, wait for the current chunk to drain before
appending the next sequence. Never replay a label payload to implement Resume.

`query` accepts only Zebra `zpl.system_status`, `~HQES`, or `~HS`. It writes the command
and reads the response on the existing job socket, after the preceding append,
instead of opening a competing status connection. A successful status response
reports the printer state observed at that barrier; it is not an acknowledgement
for a specific number of physically completed labels.

An append receipt contains `nextSequence`, `bytesWritten`,
`cumulativeBytes`, `payloadSha256`, and `checkpointHash`. Replaying the same
`(jobId, sequence, payloadSha256)` returns the stored receipt with
`deduplicated: true`; it does not write the payload to the printer again.
Changing a committed sequence's payload or skipping a sequence returns `409`.

The checkpoint chain is identical in the Go connector and local Next route:

```text
H0 = SHA256(UTF8("zbre-tcp-job-v1\0" + jobId))
Hn = SHA256(H(n-1) raw 32 bytes
            || sequence uint64 big-endian
            || payload SHA-256 raw 32 bytes
            || payload length uint64 big-endian)
```

A partial socket write puts the job in `uncertain`; subsequent appends and
finish are rejected. The browser must not open a replacement job or use the
stateless endpoint after an append has an unknown outcome. Poll/replay can
recover a lost HTTP receipt while connector memory remains available. Session
receipts are in memory, not a durable write-ahead log; a process crash still
requires physical printed/VOID-tag reconciliation.

Checkpoint replay prevents a repeated append only while the matching retained
record remains in this connector process. It is not an exactly-once guarantee
across connector restart, OS failure, network/cable loss, or printer reset.
Likewise, FIFO ordering covers admitted in-process operations; it is not a
durable distributed queue.

## Limits and timeouts

- JSON request: 48 MiB.
- Decoded print payload: 32 MiB.
- Persistent job: 1 GiB print payload plus 64 KiB reserved for standalone `~JA` control appends; no 2,500-checkpoint cap (safe integer sequences), four active sockets.
- Persistent idle timeout: caller-selectable 30 seconds to 30 minutes; the web
  client default is five minutes and the interactive Print step requests ten
  minutes.
- Terminal job receipts: resolved records retained in memory for one hour, up to 512 records; unreconciled uncertain/printed-expired records do not expire.
- Per-printer operation queue: at most 2,048 active-plus-waiting operations.
- TCP response: 4 MiB.
- DNS lookup: 3 seconds.
- Overall TCP exchange: 45 seconds.
- Caller-selectable connect/read timing is clamped to the documented
  30-second maximum.
- At most four persistent TCP jobs are active across different targets.
- HTTP header, body, response, and idle timeouts are configured on the server.

All errors use the stable JSON shape:

```json
{"ok":false,"error":"Human-readable error."}
```

## Cross-build

From PowerShell with Go 1.22 or newer:

```powershell
.\build-cross-platform.ps1
```

The script runs tests first, builds Windows x64/ARM64 and macOS
x64/Apple-Silicon executables, and writes a SHA-256 `manifest.json`. Its
default output is the ignored local `dist` directory. The repository-level
`npm run build-agent:connector` command targets `public/agent` so pilot
artifacts can be served by the web UI; replace them with signed/notarized
release URLs for production.

### `POST /v1/print/batch` — durable single Windows job (0.5.0)

Use this endpoint for an ordered DataFeed batch. Authentication, exact-Origin
CORS and pairing rules are the same as other protected endpoints. A batch is
owned by the normalized browser Origin; native/legacy loopback clients share
the local owner. Another owner cannot inspect, append, commit, cancel or
reconcile it. Client-generated IDs must contain 8–128 URL-safe characters.

The workflow is:

1. `begin` reserves admission order for the Windows queue before rendering.
2. `append` stores ordered, immutable chunks on the connector disk; it does
   not call a printer. Clients must validate and render every data row first.
3. `commit` verifies all declared counts, each chunk hash and the assembled
   payload, persists the queued state, and starts an asynchronous worker.
4. The worker waits for its reservation, saves `spooling`, calls one
   `StartDocPrinter`, persists its Windows job ID before writing any bytes,
   streams the entire file through bounded `WritePrinter` buffers and calls
   one `EndDocPrinter`. HTTP disconnects do not cancel committed work.
5. `status` reports the durable receipt. `spool-accepted` means Windows accepted
   the complete document, not that all physical labels or RFID tags completed.

A later batch cannot overtake an earlier batch that is still staging. Printer
reservations are shared with legacy `/v1/print` operations. Different queues
remain independent. This ordering applies to operations admitted by this
connector; separate Windows queues or direct writers to the same device are
outside its arbitration.

Representative requests (one JSON object per POST):

```json
{"action":"begin","batchId":"batch-20260913-0001","printerName":"ZDesigner ZT610-300dpi ZPL","documentName":"Order 0001","totalLabels":1000}
```

```json
{"action":"append","batchId":"batch-20260913-0001","sequence":1,"labelCount":10,"payloadBase64":"..."}
```

```json
{"action":"commit","batchId":"batch-20260913-0001","totalChunks":100,"totalBytes":12500000}
```

```json
{"action":"status","batchId":"batch-20260913-0001"}
```

All successful per-batch responses include:

```json
{
  "ok": true,
  "batchId": "batch-20260913-0001",
  "printerName": "ZDesigner ZT610-300dpi ZPL",
  "documentName": "Order 0001",
  "state": "queued",
  "nextSequence": 101,
  "totalChunks": 100,
  "stagedBytes": 12500000,
  "stagedLabels": 1000,
  "totalLabels": 1000,
  "jobId": null,
  "createdAt": "2026-09-13T12:00:00Z",
  "updatedAt": "2026-09-13T12:00:10Z"
}
```

`state` is `staging`, `queued`, `spooling`, `spool-accepted`, `failed`,
`uncertain`, or `cancelled`. Optional fields are `error`, `recoveryRequired`,
`payloadSha256`, `reconciliation`, `archived` and `spoolStatus`. Status queries
can read Windows job information, including whether it still exists. The
actual spool document includes the unique batch ID (`[NW:<batchId>]`) so a
reused Windows job ID cannot silently identify another print. Missing jobs or
`spooler_completed` do not prove physical completion; the inspector never
sets `physicalCompletionConfirmed` to true.

Retry semantics:

- Repeating `begin` with identical metadata returns its existing record.
  A changed queue/document/label count or a different owner is rejected.
- Repeating an accepted `append` sequence with identical bytes and label count
  returns its receipt without appending again. Changed bytes/count return 409.
- Sequence gaps and totals that differ from the staged bytes/labels are
  rejected. `commit` of a queued/running/accepted batch does not create a
  second Windows job. An uncertain batch is never replayed by `commit`.
- Retain the same batch ID when a response is lost. Inspect `status`; do not
  manufacture a fresh ID to retry an ambiguous physical submission.

Recovery and operator actions:

```json
{"action":"list"}
```

Returns `{ "ok": true, "batches": [...] }` for the current owner, newest first.

```json
{"action":"cancel","batchId":"batch-20260913-0001"}
```

Only definitely-unsent staging/queued/failed batches may be cancelled. This
releases their reservations and deletes their payload files. A worker failure
before a Windows job starts records `failed` and releases its lane; any failure
after job creation or possible submission is `uncertain` and retains the lane
without an expiry timer. Resolve it explicitly, after inspecting/clearing the
old Windows and printer job:

```json
{"action":"reconcile","batchId":"batch-20260913-0001","resolution":"do-not-reprint","acknowledgePrinterCleared":true}
```

Reconciliation is rejected while the identified old Windows job is still
active. It records `cancelled` with `reconciliation: "do-not-reprint"`, releases
the lane and never resubmits or claims the batch physically printed.

```json
{"action":"archive","batchId":"batch-20260913-0001"}
```

Archive is limited to spool-accepted/cancelled/definitely-unsent failed batches.
It removes detailed chunk receipts from completed history and hides the entry
from `list`, retaining a small durable metadata tombstone. `status` and `begin`
still recognize the original batch ID; archiving cannot make it print again.

The state directory is `raw-spool-batches` beside the pairing state file.
One process exclusively owns it. Files and manifests are synced before durable
replacement; Windows replacements use write-through and directory flushes.
On restart, `spooling` becomes `uncertain`, never automatically resubmitted.
Recovered `queued` batches require explicit `commit` with the original totals
or `cancel`. Fully staged batches can also be explicitly committed. Earlier
recovered staging/uncertain reservations continue to block later batches.

A crash during an unaccepted begin may leave only an empty directory or
manifest-writing temp file; recovery removes those definitely-unsent remnants.
An unreferenced next-sequence chunk while the manifest still says `staging` is
also definitely unsent and is discarded for safe re-upload. Referenced chunk
corruption, unexpected state or an unavailable lock disables the capability
and all Windows RAW admission, including the legacy endpoint, until repaired.
No ambiguous queued/spooling payload is discarded on a guess.

Limits: positive safe-integer label quantity (no fixed label-count cap), at most 32 MiB per upload, 1 GiB per assembled
batch, 2 GiB of active payloads (up to twice that disk space during assembly),
64 unfinished batches and 1,000 unarchived detailed receipts. Archive terminal
entries to free history capacity; never delete uncertain state to bypass a
blocked lane. Payload cleanup failures disable admission rather than silently
ignoring leaked disk usage. Small archived ID tombstones remain on disk so IDs
cannot be recycled. `rawSpoolBatchV1` is true only when the store is healthy.

Windows queue preflight is read-only and runs both at begin and before the
worker opens its print document. It requires spooling with **Start printing
after last page is spooled**, rejects direct printing and multi-port pooling,
and does not alter Windows settings. RAW ZPL itself specifies printer/DPI/media
settings. The application prepares payloads and submits one job; Windows owns
transport to the selected port after spool acceptance.

## RFID session capture in connector 0.6.1

`POST /v1/tcp/job` open accepts optional `capture: { expectedLabels, firstRow, rowStep, bank, templateName, expectedHexChars? }`. `bank` is EPC or TID; rowStep is 1 or -1; expectedHexChars is zero/omitted for a variable-length read, otherwise the exact even HEX character count. Capture-enabled job responses contain a `capture` summary. An older connector must not be used unless it explicitly confirms this capture object before the first append.

Each `^PQ1` format emits `^FH_^HV1,256,NWEP|<jobId>|<ordinal>|,|END_0D_0A,L^FS` after its `^RFR...^FN1^FS`. A continuous socket reader demultiplexes these records and ordinary `~HS`/`~HQES` responses. Captured rows are appended and synced to CSV independently of HTTP polling. Missing, duplicate, invalid or out-of-order readbacks cannot produce a complete capture summary. Transport completion and capture completion are separate concepts.

Protected actions `capture-list` (optional historyOffset, pages of 50) and `capture-export` (jobId) list persisted sessions and stream UTF-8 CSV for the authenticated origin. They work after terminal TCP receipts expire or the connector restarts; no TCP socket is opened by either action. CSV and a session manifest are stored in `rfid-sessions` beside the pairing state. No automatic deletion or replay is performed. The per-session capture storage budget is 128 MiB. `complete` describes response collection, not verified physical print quality.

Export filenames use `YYYY-MM-DD_HH-mm-ss_epc_Read_<12 hex>.csv` (`tid_Read` for TID). The timestamp is the session's `createdAt` in local time, and the suffix is the first six bytes of SHA-256(jobId), encoded as lowercase HEX. The desktop download uses the viewer's local time; the API attachment header uses the connector's local time. Both are the same computer in the desktop app. Existing session files remain `reads.csv`; downloading older history applies the new export name too.

The persistent job owns its configured endpoint queue across all append/query operations. Other TCP exchanges may route only `~HS`, `~HQES`, `~PP` or `~PS` onto its existing socket. Other payloads are rejected until completion/reconciliation. Quarantine/checkpoint records remain in memory; persisted RFID history does not make transport job recovery automatic.

### Aggregate RFID batch audit

`capture.auditBatchCounters: true` uses connector-owned lifecycle version 1 from
connector 0.11.0. The audited open receipt must expose `audit.lifecycleVersion: 1`.
The browser neither establishes baseline nor finalizes counts by querying them.
The connector owns these read-only queries on the original capture socket:

```
! U1 getvar "odometer.rfid.valid_resettable"
! U1 getvar "odometer.rfid.void_resettable"
! U1 getvar "odometer.total_label_count"
```

Before the first payload, two complete stable counter rounds are bracketed by
empty `~HS` queue checks. Invalid, missing, decreasing or unstable values and a
nonempty queue reject admission as `RFID_BASELINE_UNVERIFIED`, `outcome:not_sent`,
`bytesWritten:0`; that rejected session cannot later reuse a partial baseline.
No counter reset, label replay or automatic reconnect is performed.

A baseline rejection records `audit.admissionRejection` with method
`before_first_payload_v1`, outcome `not_sent`, timestamp and reason
`baseline_unverified`, then releases its endpoint reservation. This durable
control-flow evidence permits a rejected attempt to contribute zero physical
labels without making a later valid run on the same roll unresolved. Its failed
attempt and diagnostic history remain visible. Empty EPC data alone, legacy
aborted state or a failed operation after label submission never establish this
no-payload proof and never release a potentially printed run's quarantine.

The existing session mutex serializes append, control, query and counter rounds.
One continuous reader demultiplexes EPC records. Each complete three-counter
round is saved atomically; incomplete rounds stay private and cannot replace
the last complete observation. The monitor checkpoints at most once per two
seconds at complete format boundaries. Browser counter queries remain readable
but cannot overwrite authoritative lifecycle evidence.

`finish` independently drains the queue and collects two fresh stable rounds at
least 250 ms apart, with an overall 45-second budget independent of HTTP request
cancellation. Once all expected known single-label capture formats are submitted,
the monitor can seal this proof autonomously even if the browser disappears
before `finish`. The normal proof requires VALID + VOID to equal submitted
physical attempts and all intended formats to be submitted. Counts exceeding
submitted attempts, reset or contradictory readbacks remain unresolved. A known
service-fault stop retains its separate same-socket paused/cleared/stable proof,
which may account for fewer physical attempts than originally submitted.

`audit` adds `lifecycleVersion`, `finalizationStatus` (`collecting`, `verified`,
`unresolved`), stable-code `finalizationReason`, human-readable `finalizationNote`,
`lastSampleAt`, `finalizedAt`, `counterSampleCount` and `finalCounterProof`.
`baseline` and `latest` are complete absolute machine observations with time and
append sequence. Their deltas are observations; `countsKnown` requires a valid
final proof, not merely two plausible snapshots. Physical count finality is
separate from EPC completeness: missing readbacks do not become invented EPCs or
VOID positions. The lifetime print odometer is diagnostic and is not required to
equal RFID attempts.

Unsealed socket loss, timeout, cancellation or connector shutdown retains EPCs
and complete counter checkpoints with an explicit unresolved reason. A committed
proof survives later transport loss or restart if no subsequent append occurred:
proof invalidation is durably saved **before** writing further label bytes.
Transport receipt state, raw-read quality and physical counter finality remain
separate. Reconnection never retroactively assigns fresh machine counts to an
unresolved historical run. Legacy manifests retain their original evidence and
are not upgraded to connector-owned certainty.

After a strict normal final proof, clean socket loss is a `transportNote`, not
a capture-storage error. A foreground status query may still fail because live
machine status is unavailable. Poll exposes `counterFinishRecoverable:true`
only when this is a known query-transport failure after that sealed boundary,
with the same committed receipt and no later payload, service fault, capture
error or partial frame. The client may then send `finish` with the exact normal
sequence/byte/hash checkpoint; the connector completes its local receipt and
releases the endpoint without fabricating a live status response or reconnecting.
Disk failures, later payload attempts and other uncertain states retain their
existing quarantine. The final counter proof alone is not a general override.

Other clients can change physical printer counters; exclusive production use of
the endpoint remains an operational requirement. Read-only template counter
semantics must be qualified on each printer/firmware. Stable snapshots are not
100% optical/RFID inspection of each finished label.

`capture-export` now streams a result report. Its columns are job_id, ordinal,
source_row, bank, data_hex, host_time, result, record_type, quantity,
host_utc_offset, received_at_utc, session_state, batch_validation,
printer_valid_delta, printer_void_delta, printer_total_delta, evidence, detail.
Local host time includes milliseconds plus a separate UTC offset; UTC remains
available. READ_OK means a valid readback, not optical print verification.
The report adds a VOID_TOTAL row and a session_summary row. VOID identity/time
is not correlated to any individual EPC/source row. Unknown VOID count is blank
with VOID_TOTAL_UNVERIFIED. Missing ordinals are compressed NO_READBACK ranges,
never inferred as VOID. Interrupted snapshots may precede further printer work.

Raw `reads.csv` stays append-only with its original seven columns. In connector
0.7.0, closing a session saves its raw evidence and manifest but **does not create
a presentation CSV**. An operator explicitly requests `capture-export` for a
diagnostic run report or `roll-export` for a production roll report. Crash exports
recover raw rows; unsealed runs remain unverified and sealed v1 proofs remain intact. Clearing the UI history view
only changes browser localStorage; it does not delete a session or alter its files.

## Historical Production Job / Roll / Run ledger in connector 0.7.0

This is a legacy schema reference for reading old records. Its create/review/
finalize calls and export-to-release rules are obsolete. Current clients use the
0.10.0 lifecycle at the start of this document, including `roll-close`.

The protected `POST /v1/tcp/job` endpoint accepts `roll-create`, `roll-list`,
`roll-get`, `roll-review`, `roll-finalize`, and `roll-export`. Arguments go in a
`production` object. All records are scoped to the authenticated origin owner.
No ledger operation prints, resets a printer counter, or replays a run.

Create a finished-roll record before printing:

```json
{
  "action": "roll-create",
  "production": {
    "jobId": "NW-4520-261016-001", "rollNumber": 1, "targetLabels": 2500,
    "operator": "OP-01", "templateName": "Approved Kit",
    "templateFingerprint": "<64 hexadecimal SHA-256 characters>",
    "kind": "kit", "reference": "ERP order reference", "materialLot": "LOT-01",
    "requireUniqueSourceRows": false, "countersResetConfirmed": true
  }
}
```

`jobId` has 1-64 ASCII letters, digits, underscores or hyphens, starting with a
letter or digit. The immutable `rollId` is `jobId` plus `_01` (minimum two digits).
`kind` is `kit` or `custom`. `countersResetConfirmed` records the operator's
assertion that VALID/VOID were reset once for this finished roll; the connector
does not send a reset. `requireUniqueSourceRows` is true for approved imported
variable data, false for static templates whose source numbering restarts on
each run. Template name and SHA-256 are immutable within a roll.

Each TCP capture open additionally supplies `productionRollId`,
`templateFingerprint`, `operator`, `sourceRollId`, and `materialLot` in `capture`.
Production capture requires EPC bank. The run is durably registered before label
bytes may be sent. First registration binds the roll to the configured host/port.
A different printer endpoint, changed template, finalized roll, unreviewed or
active predecessor, changed evidence, unresolved/duplicate retained evidence, or
quantity greater than the remaining retained GOOD target rejects admission.
Use one consistent printer IP; this binding does not discover physical aliases.

For variable-data rolls, first admission binds `sourcePlanFirstRow` and
`sourcePlanRowStep`. Every proposed refill range is checked **before label bytes
are sent**: its first row must be the next row after the contiguous retained
GOOD prefix, its direction must match, and none of its source rows may overlap
retained rows. A partial 1..2500 run retaining 1..2200 can continue at 2201.
Retaining 1, 3 after rejecting 2 cannot be repaired by printing 2 at the tail;
the roll is held for controlled rework. Removing the entire affected tail and
continuing its retained prefix in order is supported. Arbitrary insertion or
reordering is not. This source allocation is roll-local; a central job register
must allocate distinct customer-data ranges to separate rolls.

Responses to create/get/review/finalize contain `ok`, `roll`, `summary`, `rows`,
and `exportFileName`. `roll-list` with `production: {}` returns `rolls` metadata.
Rows retain run ordinal, source row, EPC, receive time, source blank-roll ID and
material lot. Summary contains retained/excluded/unresolved counts, duplicate
EPCs, duplicate source rows, conflicting finalized roll IDs, active/unreviewed
runs, known native VOID subtotal, unknown-VOID run IDs and explicit blockers.
Uniqueness is local to this connector owner, not a cross-PC/global ERP guarantee.

Before a refill or final release, review each stopped run:

```json
{
  "action": "roll-review",
  "production": {
    "rollId": "NW-4520-261016-001_01", "runId": "<TCP run UUID>",
    "operator": "OP-01", "verified": true,
    "excludedOrdinals": [2199, 2200],
    "note": "Removed boundary rejects; recorded sample QC and counter reconciliation."
  }
}
```

Review `verified` means the operator reconciled the run under the SOP, not that
the app or a sample check verified every physical label. Exclusions remove all
frames with that run ordinal from retained GOOD candidates. Reviews are revised
by submitting a replacement exclusion set; every revision remains in `reviews`.
Invalid/out-of-order/duplicate-ordinal frames need explicit exclusion after
physical disposition. Missing replies are not fabricated as GOOD or VOID; an
interrupted partial run can contribute its reviewed valid retained EPCs, followed
by a reviewed makeup run. Every review records the raw evidence SHA-256.

Finalize only after the final count and sampled QC are reconciled:

```json
{
  "action": "roll-finalize",
  "production": {
    "rollId": "NW-4520-261016-001_01", "operator": "QC-01",
    "confirmed": true, "physicalGoodCount": 2500,
    "printerValidCount": 2502, "printerVoidCount": 9, "retainedVoidCount": 5,
    "externalTestVoidCount": 1,
    "qcMethod": "sampled", "orientation": "forward",
    "note": "Two RFID-valid labels removed; production VOID8 includes three removed scraps and five retained. F03-001 external technical test VOID1 removed. Start/middle/end sample checked."
  }
}
```

Physical GOOD count, retained unique EPC count and target must match. Printer
VALID must cover the retained count; its excess requires explanation in the
mandatory close note. `externalTestVoidCount` is an optional nonnegative integer,
default zero, for technical-test VOID **outside** the registered production runs.
These test labels are removed as scraps; they cannot be included in retained
VOID. A positive count requires its F03/technical-run evidence in the close note.
This is operator-declared reconciliation, not an automatically measured count.

When every production run has a reliable final snapshot, entered printer VOID
must equal known production VOID plus declared external-test VOID. If some runs
have unknown snapshots, entered printer VOID must still be at least that known
subtotal plus external-test VOID; unknown never erases known evidence. Remaining
operator display counts stay explicitly declared, not reconstructed measurements.
`retainedVoidCount` is required, including explicit zero, and must be between
zero and `printerVoidCount - externalTestVoidCount`. Total printer VOID includes
removed scraps; retained VOID identifies only VOID physically left in the
finished roll. The exported provenance distinguishes these values.

`orientation` is `forward` or `reverse` for the final unwind order of retained
GOOD labels. `good_label_ordinal` excludes VOID labels remaining in the roll; it
is not an absolute physical label position including unidentified VOID. Arbitrary
reordering/splicing among GOOD labels is unsupported. A final roll is immutable.

`roll-export` with `production: {rollId}` exports a final roll. For an open roll,
`provisional: true` is required and every row is marked PROVISIONAL. The CSV
contains GOOD_OPERATOR_RELEASED rows, exclusions, unresolved evidence, per-run
native VOID totals/unknowns, missing-response totals, all review revisions,
PRINTER_VALID_DECLARED, PRINTER_VOID_DECLARED, RETAINED_VOID_DECLARED and the roll
summary. EXTERNAL_TEST_VOID_DECLARED separately records the procedural outside
test count with `operator_declared_external_test` provenance and the F03/test
note. Sampled QC never becomes a claim of 100% optical/RFID verification.

Only explicit export creates the presentation file under
`rfid-sessions/production-rolls/<owner-and-roll-hash>/`. The stable final filename
is `<rollId>_FINAL_<host-local timestamp>_epc_Read_r<revision>.csv` and is returned
as `exportFileName`. Final exports save a SHA-256 receipt and subsequent downloads
reuse identical archived bytes; changed archived files are rejected. Internal
run `reads.csv` files and atomic ledger manifests remain automatically durable.


### Roll history visibility (desktop/web 3.8.0)

`productionRollHistoryV1` enables `roll-history-clear` and `roll-history-restore` on
`POST /v1/tcp/job`. Both accept `production: { rollIds: string[] }` and return
`{ ok: true, updatedRollIds: string[] }`. Only authenticated closed/finalized rolls
can be changed; open or active rolls reject the entire selection before writes.
IDs are explicitly selected (1–10000), deduplicated, and retries are idempotent.

`roll-list` still returns all records for reconciliation, with optional
`historyClearedAt`. UI lists omit cleared records unless explicitly requested by
the operator. Visibility is stored in an atomic `history.json` sidecar, separate
from immutable roll/export revisions. Clear does not delete EPC evidence or CSV
archives, reset counters, change roll state, or send commands to the printer.
