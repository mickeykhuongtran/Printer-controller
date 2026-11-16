# ZbrePrinter Online và ZbrePrinter Desktop

Hai edition dùng chung một codebase thiết kế template, render ZPL và xử lý
RFID. Chúng chỉ khác host runtime, cách lưu dữ liệu và ranh giới kết nối máy
in.

## 1. ZbrePrinter Online Basic

Project `ZbrePrinter` hiện là source chính và có thể deploy trực tiếp lên
Vercel hoặc một nền tảng chạy Next.js tương đương. Cấu hình production:

```text
NEXT_PUBLIC_TCP_EXECUTION=connector
NEXTWAVES_DEPLOYMENT_MODE=cloud
NEXTWAVES_SERVER_TCP=disabled
NEXTWAVES_ENABLE_INTEGRATION_API=false
```

User mở một HTTPS URL để thiết kế template và in. Web server không kết nối
thẳng tới IP Zebra trong LAN của user. Trình duyệt gửi job đến Local Print
Connector trên máy user hoặc site gateway, rồi connector mới gửi RAW ZPL tới
Zebra.

Online Basic hỗ trợ nhiều người truy cập đồng thời, nhưng state hiện tại là
độc lập theo browser profile:

- template, session và printer setting nằm trong `localStorage`;
- connector token chỉ nằm trên thiết bị đã pair;
- chưa có login, organization, role, database hoặc đồng bộ template;
- xóa browser data có thể làm mất template chưa export.

Vì vậy đây là edition basic cho pilot/authoring độc lập, chưa phải SaaS
multi-tenant. Trước khi public production phải bảo vệ toàn bộ deployment bằng
SSO/Deployment Protection và dùng một production origin ổn định.

Để thành edition multi-user có chia sẻ dữ liệu, phase tiếp theo cần OIDC/Entra,
PostgreSQL tenant-scoped, object storage cho asset, versioning template, audit
log và queue in durable theo site/printer.

Chi tiết connector, network và TLS nằm trong
[`cloud-deployment.md`](cloud-deployment.md).

## 2. ZbrePrinter Desktop

Project sibling `../ZbrePrinter-App` là shell Electron, không fork business
logic. Quy trình build của nó lấy output `.next/standalone` từ project này,
kèm Local Print Connector Windows x64, rồi tạo installer NSIS.

Runtime:

```text
ZbrePrinter.exe
├─ Electron main process
├─ Next standalone trên 127.0.0.1
├─ sandboxed Chromium app window
└─ Local Print Connector 0.3.0 trên 127.0.0.1:17917
```

User không cần cài Node, Yarn hoặc Go và không mở CMD. Installer tạo desktop
shortcut và Start Menu shortcut. App bảo đảm single-instance, khởi động các
runtime ẩn, chờ health check trước khi mở UI, ghi log và dừng child process
khi thoát.

Mutable server data nằm dưới Electron `userData`, không nằm trong thư mục cài
đặt:

```text
%APPDATA%/ZbrePrinter/
├─ data/
│  ├─ printer-routing.json
│  └─ integration-profiles/
├─ connector/
└─ logs/
```

Chromium local storage cũng được giữ theo cùng app ID qua update. Template quan
trọng vẫn nên export `.nwl`; phase production nên chuyển template business
sang SQLite có atomic write và backup version.

## 3. So sánh mục đích sử dụng

| Tiêu chí | Online Basic | Desktop |
| --- | --- | --- |
| Cập nhật UI | Một lần trên server | Qua installer/update |
| Cần Internet | Có để mở app | Không sau khi cài |
| Kết nối Zebra | Local connector/site gateway | Connector được bundle |
| Dữ liệu hiện tại | Theo browser profile | Theo Windows user/app profile |
| Batch công nghiệp | Phụ thuộc browser + connector | App kiểm soát lifecycle |
| Chia sẻ template | Chưa có | Chưa có; local machine |

Mô hình production tối ưu là hybrid: online quản lý danh tính, template và
version; desktop/connector chịu trách nhiệm hàng đợi và I/O máy in tại site.

## 4. Giới hạn về xác nhận in vật lý

Installer không thể biến việc socket nhận byte thành xác nhận nhãn đã in hoặc
tag RFID đã program thành công. Nếu mất điện, rút mạng hoặc connector crash sau
khi Zebra đã nhận một phần job, trạng thái vẫn phải là `uncertain`, không tự
động resend.

Để đạt độ tin cậy production cho batch lớn cần thêm:

1. FIFO/lease riêng cho từng printer endpoint.
2. SQLite/WAL durable cho checkpoint và job state.
3. EPC/sequence ledger và workflow đối soát nhãn valid/VOID.
4. Zebra status/backpressure trước mỗi window gửi.
5. Chặn sleep/update/quit trong lúc job đang active.
6. Test vật lý với pause, head-open, media-out, RFID error và cable-loss.
