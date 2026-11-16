# Triển khai cloud và Zebra Local Print Connector

Tài liệu này mô tả cấu hình được hỗ trợ cho Vercel và các nền tảng cloud
tương đương. Mục tiêu là giữ việc thiết kế template trên web, nhưng thực hiện
I/O máy in tại máy người dùng hoặc tại một MacBook gateway trong mạng công ty.

## Kiến trúc

### Connector cá nhân

Áp dụng khi chính máy đang mở trình duyệt cũng nối USB/COM với Zebra hoặc có
route tới IP của Zebra:

```text
Vercel HTTPS
├─ COM → Web Serial → cổng serial trên máy người dùng
├─ USB-B Windows → http://127.0.0.1:17917 → WinSpool RAW
└─ TCP/IP → http://127.0.0.1:17917 → Zebra:9100
```

### MacBook site gateway

Áp dụng cho topology hiện tại, trong đó chỉ một MacBook nối Ethernet trực tiếp
với Zebra:

```text
Trình duyệt nhân viên
        │ HTTPS: ứng dụng Vercel
        │ HTTP/LNA: IP nội bộ của MacBook, port 17917
        ▼
MacBook site gateway
├─ Wi-Fi/LAN công ty: ví dụ 10.20.30.40
└─ Ethernet Zebra: 192.168.50.10/24
        │
        └─ TCP 192.168.50.50:9100
```

Port `9100` không được public lên Internet. Connector chỉ bind một IP được chỉ
định, kiểm tra exact browser origin, pairing token, TCP destination và port.
Site gateway này phục vụ người dùng trong cùng LAN hoặc VPN có route tới IP nội
bộ của MacBook. In từ bất kỳ Internet location nào, kể cả khi không có VPN,
cần thêm authenticated durable cloud queue; queue in-memory cũ không đáp ứng
yêu cầu đó.

## Hỗ trợ transport

| Transport | Cloud browser | Thành phần trên client/gateway |
| --- | --- | --- |
| COM / RS-232 | Có | Chrome/Edge Web Serial; không cần connector |
| USB-B trên Windows | Có | Zebra/ZDesigner/Seagull driver và connector Windows |
| USB-B trên macOS | Không nằm trong phạm vi hiện tại | Dùng TCP/IP trên Mac |
| TCP/IP, connector cá nhân | Có | Connector trên máy có route tới Zebra |
| TCP/IP, một Zebra dùng chung | Có trong LAN/VPN | Connector site-gateway trên MacBook |
| TCP server của Next.js local | Có, chỉ local standalone | Giữ để tương thích hệ thống cũ |

## Cấu hình MacBook nối trực tiếp với Zebra

Giữ Wi-Fi/LAN công ty ở DHCP để có Internet và default route. Cấu hình riêng
adapter Ethernet nối Zebra:

```text
IPv4:        Manually
IP address:  192.168.50.10
Subnet mask: 255.255.255.0
Router:      để trống
DNS:         để trống
```

Máy in:

```text
IP address:  192.168.50.50
Subnet mask: 255.255.255.0
RAW port:    9100
```

Kiểm tra trên Mac:

```bash
route -n get 192.168.50.50
nc -G 3 -vz 192.168.50.50 9100
```

Route tới `192.168.50.50` phải đi qua adapter Ethernet; default route Internet
vẫn phải đi qua Wi-Fi/LAN công ty.

Đối với site gateway, cấp cho interface công ty của MacBook một IP ổn định
bằng DHCP reservation hoặc static assignment, ví dụ `10.20.30.40`. Chỉ mở
inbound TCP `17917` từ subnet công ty/VPN; không port-forward port này từ
Internet.

## Chạy connector

Connector là binary độc lập; máy vận hành không cần Node.js, npm, Python hay Go.

Chế độ cá nhân mặc định:

```bash
./ZbrePrinterLocalPrintAgent-macos-arm64
```

Chế độ site gateway, bind đúng IP nội bộ của MacBook:

```bash
./ZbrePrinterLocalPrintAgent-macos-arm64 \
  --listen-address 10.20.30.40 \
  --port 17917 \
  --tcp-ports 9100
```

Không dùng `0.0.0.0`. Connector cố ý từ chối wildcard, public và multicast
address.

### TLS cho site gateway production

Direct site mode dùng HTTP, vì vậy token và nội dung job không được mã hóa trên
LAN. Chỉ dùng direct HTTP trên mạng/VPN đã segment và được tin cậy. Phương án
production tốt hơn là:

1. để connector bind loopback mặc định `127.0.0.1:17917`, nhưng bật strict
   origin/token mode;
2. đặt reverse proxy trên cùng MacBook, dùng certificate do CA công ty cấp;
3. expose duy nhất HTTPS gateway cho subnet công ty/VPN;
4. rewrite upstream `Host` thành `127.0.0.1:17917`;
5. giữ nguyên `Origin` và `Authorization` khi proxy.

Chạy connector loopback dành riêng cho reverse proxy:

```bash
./ZbrePrinterLocalPrintAgent-macos-arm64 --require-origin-token
```

Flag này bắt buộc mọi protected request phải có HTTPS `Origin` đã pair và
Bearer token, kể cả khi upstream connector chỉ bind `127.0.0.1`. Không bỏ flag
này ở topology reverse proxy; nếu không, chế độ tương thích local cũ có thể
chấp nhận request không có `Origin`.

Ví dụ Caddy-compatible:

```caddyfile
zebra-gateway.company.internal {
    tls /path/to/company-cert.pem /path/to/company-key.pem
    reverse_proxy 127.0.0.1:17917 {
        header_up Host 127.0.0.1:17917
    }
}
```

Managed browsers phải trust CA công ty và corporate DNS/VPN phải resolve tên
gateway về IP private của MacBook. Trên Vercel đặt:

```text
NEXT_PUBLIC_PRINT_CONNECTOR_URL=https://zebra-gateway.company.internal
```

Frontend chỉ chấp nhận hostname HTTPS nếu nó khớp chính xác origin được cấu
hình tại build time; HTTP tùy ý hoặc public hostname bị từ chối.

Windows USB-B/TCP cá nhân:

```powershell
.\ZbrePrinterLocalPrintAgent-windows-x64.exe
```

Khi khởi động, terminal hiển thị pairing code tám chữ số, hiệu lực mười phút.
Trong ứng dụng:

1. Mở **Printer setup**.
2. Nhập connector URL:
   - cá nhân: `http://127.0.0.1:17917`;
   - site gateway: `http://10.20.30.40:17917`.
3. Nhập pairing code và chọn **Pair**.
4. Cho phép Local Network Access khi Chrome/Edge hỏi.
5. Chọn **Test local connector**.
6. Với TCP, nhập `192.168.50.50`, port `9100`, execution `Local connector`.

Pairing gắn với exact origin. Dùng một custom production domain ổn định; mỗi
Vercel preview URL mới sẽ phải pair lại.

Mỗi browser nhận một token riêng. Connector giữ đồng thời tối đa 32 token cho
mỗi exact origin, nên một nhân viên pair mới không làm các browser đã pair trước
đó mất quyền. Khi vượt giới hạn, session cũ nhất của origin đó bị loại.

### Binary macOS pilot

Binary thô tải từ web có thể cần executable bit:

```bash
chmod +x ~/Downloads/ZbrePrinterLocalPrintAgent-macos-arm64
~/Downloads/ZbrePrinterLocalPrintAgent-macos-arm64
```

Để rollout production, phải ký bằng Apple Developer ID và notarize dưới dạng
`.pkg`, `.dmg` hoặc signed app. Không nên yêu cầu người dùng tắt Gatekeeper.
Windows production artifact tương tự nên được ký Authenticode.

## Deploy ứng dụng lên Vercel

Import GitLab repository vào Vercel, chọn framework **Next.js**, sau đó đặt các
environment variables cho Production và Preview:

```text
NEXT_PUBLIC_TCP_EXECUTION=connector
NEXTWAVES_DEPLOYMENT_MODE=cloud
NEXTWAVES_SERVER_TCP=disabled
NEXTWAVES_ENABLE_INTEGRATION_API=false
```

Tùy chọn:

```text
NEXT_PUBLIC_AGENT_WINDOWS_URL=<signed Windows release URL>
NEXT_PUBLIC_AGENT_MACOS_ARM64_URL=<signed Apple Silicon release URL>
NEXT_PUBLIC_AGENT_MACOS_X64_URL=<signed Intel Mac release URL>
NEXT_PUBLIC_PRINT_CONNECTOR_URL=<default connector/site-gateway origin>
NEXT_PUBLIC_GA_MEASUREMENT_ID=
```

Build settings:

```text
Install command: npm ci
Build command:   npm run build
Output:          Next.js default
```

Mỗi push lên branch GitLab đã kết nối sẽ tạo deployment mới. User chỉ mở URL
HTTPS; không cần chạy `yarn dev` hoặc `npm run dev`.

### Access control

Code hiện không tự suy đoán hệ thống identity của công ty. Trước khi đưa vào
production:

- dùng Vercel Deployment Protection **All Deployments** với Vercel
  Authentication nếu toàn bộ user là thành viên team Vercel; hoặc
- tích hợp IdP/SSO của công ty ở application layer.

Không để production domain public chỉ vì preview deployment đã được bảo vệ.

## Tương thích local cũ

Local standalone vẫn hoạt động:

```bash
npm ci
npm run typecheck
npm run build
npm run start
```

`npm run start` mặc định bind `127.0.0.1:8888` và bật server-side TCP local.
Cloud luôn hard-disable `/api/printer/tcp`. Python Windows agent cũ chỉ được
fallback khi chính web app chạy trên loopback; hosted origins bắt buộc dùng
connector `/v1` có pairing.

## Build connector cho developer

Chỉ developer cần Go 1.22 trở lên:

```powershell
npm run test-agent:connector
npm run build-agent:connector
```

Protocol, flags, limits và error contract được mô tả tại
`native/local_print_agent_go/PROTOCOL.md`.

## Các giới hạn cloud chủ ý

- Template người dùng hiện lưu trong browser `localStorage`; chưa phải shared
  company template database.
- File-based API profiles và browser-listener queue cũ không durable trên
  Vercel, nên mặc định bị khóa trong cloud mode.
- ZPL bitmap được gửi trực tiếp từ browser tới connector, không proxy qua
  Vercel Function. Điều này tránh giới hạn payload cloud và giữ dữ liệu in
  trong site/client.
- Nếu cần print API bất đồng bộ từ ERP, shared templates, retry, audit và in
  ngoài LAN/VPN, cần thêm database/object storage và durable job queue với
  `siteId`, `connectorId`, lease, idempotency và authentication.
