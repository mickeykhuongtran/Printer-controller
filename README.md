# ZbrePrinter

Ứng dụng Windows để thiết kế template, in nhãn ZPL và đọc/ghi RFID trên máy in Zebra.
Giao diện dùng Next.js/React trong Electron; connector Go xử lý kết nối với máy in.

[Tải bộ cài Windows](https://github.com/mickeykhuongtran/Printer-controller/releases/latest) · [Tài liệu](docs/DESKTOP.md) · [Báo lỗi](https://github.com/mickeykhuongtran/Printer-controller/issues)

## Tính năng

- Thiết kế nhãn với text, barcode, QR, Data Matrix, ảnh và bảng; lưu/mở template `.nwl`.
- In theo dữ liệu Excel/CSV, số thứ tự hoặc nội dung cố định.
- Kết nối qua TCP/IP, Windows printer queue (USB hoặc Ethernet) và COM/Serial.
- Quản lý nhiều máy in, đọc/ghi EPC, theo dõi VALID/VOID và xuất CSV theo cuộn.

## Kiến trúc

Electron khởi động Next.js, connector Go và một cửa sổ ẩn chạy print worker.
UI chuẩn bị dữ liệu nhãn và sinh ZPL; connector quản lý hàng đợi, gửi lệnh in,
nhận phản hồi RFID và lưu lịch sử cuộn.

```text
Template + DataFeed → LabelDoc → Render / ZPL → Print job → Connector → Máy in
```

TCP và Windows RAW đi qua connector Go. COM/Serial dùng Web Serial từ giao diện.

```text
.
├─ electron/                       # Desktop runtime và print worker
├─ web/
│  ├─ app/                         # UI, template, ZPL và luồng in
│  │  ├─ components/               # Editor, màn hình in, quản lý máy/cuộn
│  │  └─ api/                      # Integration API và server TCP
│  ├─ native/local_print_agent_go/ # Connector Go
│  ├─ template/                    # Template mẫu .nwl
│  └─ scripts/                     # Test ZPL, RFID và transport
├─ scripts/                        # Build và kiểm tra gói desktop
├─ tests/                          # Test desktop runtime
├─ build/                          # Icon, test UI, fixture và release notes
└─ docs/                           # Tài liệu kỹ thuật
```

Các file chính khi đọc code:

| Phần | Bắt đầu từ | Nội dung |
| --- | --- | --- |
| Giao diện | [page.tsx](web/app/page.tsx), [DesignerCanvas.tsx](web/app/components/DesignerCanvas.tsx) | Luồng chọn template → chỉnh sửa → in; bố trí các phần tử trên nhãn. |
| Template | [types.ts](web/app/types.ts), [reducer.ts](web/app/reducer.ts), [storage.ts](web/app/storage.ts) | Model `LabelDoc`, state editor và lưu/mở template. |
| Dữ liệu và ZPL | [label-data.ts](web/app/label-data.ts), [full-page-raster.ts](web/app/full-page-raster.ts), [zpl.ts](web/app/zpl.ts) | Gắn dữ liệu vào từng nhãn, render bitmap và sinh lệnh ZPL/RFID. |
| Gửi lệnh in | [PrintStep.tsx](web/app/components/PrintStep.tsx), [print-batch.ts](web/app/print-batch.ts), [fleet-spool.ts](web/app/fleet-spool.ts) | Kiểm tra cấu hình, chia dữ liệu thành chunk và gửi job tới connector. |
| Máy in và RFID | [Connector Go](web/native/local_print_agent_go/), [PROTOCOL.md](web/native/local_print_agent_go/PROTOCOL.md) | TCP, WinSpool, hàng đợi, thu EPC, counter và lịch sử cuộn. |
| Desktop | [main.cjs](electron/main.cjs), [runtime.cjs](electron/runtime.cjs) | Khởi động các process, kiểm tra kết nối và xử lý đóng ứng dụng khi còn job. |

## Phát triển

Yêu cầu: Windows x64, Node.js 20.19 trở lên và Go 1.22 trở lên trong `PATH`.

```powershell
git clone https://github.com/mickeykhuongtran/Printer-controller.git
cd Printer-controller
npm ci
npm ci --prefix web
```

### Chạy ứng dụng

```powershell
npm run prepare:desktop
npm start
```

`prepare:desktop` build connector, build Next.js và chuẩn bị runtime trong `bundle/`.
Desktop dùng `127.0.0.1:18888` cho Next.js và `127.0.0.1:17917` cho connector.

Khi phát triển giao diện, chạy `npm run dev --prefix web` rồi mở
`http://localhost:8888`. Để chạy connector riêng, dùng
`npm run print-agent:connector --prefix web` trong terminal khác.

### Build bộ cài

```powershell
npm run dist:win
```

Bộ cài được tạo tại `dist/ZbrePrinter-App-Setup-<version>-x64.exe`.
Dùng `npm run pack:win` nếu chỉ cần thư mục ứng dụng trong `dist/win-unpacked/`.
Source web mặc định nằm trong `web/`; đặt `ZBREPRINTER_WEB_SOURCE` để dùng thư mục khác.

## Kiểm thử

```powershell
npm test
npm run typecheck --prefix web
npm run test:zpl-rfid --prefix web
npm run test:print-batch-data --prefix web
npm run test:production-roll --prefix web
npm run test-agent:connector --prefix web
```

Các test UI dùng bản đóng gói, như `test:spool-ui` và `test:fleet-ui`, cần chạy
`npm run pack:win` trước. Xem thêm các lệnh trong [package.json](package.json)
và [web/package.json](web/package.json).

## Tài liệu

- [Desktop runtime, dữ liệu và log](docs/DESKTOP.md)
- [Windows RAW spool](docs/WINDOWS-SPOOL-BATCH.md)
- [Integration API](web/docs/integration-api.md)
- [Counter và quy trình vận hành](docs/COUNTER-SOP-REVIEW-2026-10-19.md)
- [Release notes](https://github.com/mickeykhuongtran/Printer-controller/releases)

Với job có trạng thái `uncertain`, cần kiểm tra nhãn thực tế trước khi in lại.
TCP/WinSpool nhận dữ liệu thành công chưa xác nhận tem đã in hoặc EPC đã ghi đúng.

Bộ cài nằm trong GitHub Releases. `dist/`, `bundle/`, dependency và file build
được bỏ qua trong Git. Bản 3.9.2 chưa ký Authenticode.

Khi [báo lỗi](https://github.com/mickeykhuongtran/Printer-controller/issues), ghi rõ
phiên bản ứng dụng, model/firmware máy in và các bước tái hiện.
