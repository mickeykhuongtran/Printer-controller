# ZbrePrinter-App

Ứng dụng Windows cài đặt cục bộ cho ZbrePrinter. Project này chỉ là desktop
shell; UI, ZPL/RFID compiler và print workflow vẫn được build từ project
`web/` trong repo (tương thích source sibling `../ZbrePrinter` qua override).

Hướng dẫn clone/build hiện tại và bản đồ source: [README của repo](../README.md).

## User nhận được gì

- `ZbrePrinter-App-Setup-<version>-x64.exe`;
- cài theo Windows user, không yêu cầu Node/Yarn/Go;
- desktop shortcut và Start Menu shortcut;
- một cửa sổ app riêng, không mở CMD hoặc browser ngoài;
- chạy offline sau khi cài;
- tự khởi động Next standalone, Local Print Connector 0.12.0 và một print worker
  browser ẩn;
- single-instance và health check trước khi mở UI;
- giữ print worker chạy khi cửa sổ chính bị minimize, bật Electron
  `prevent-app-suspension` trong lúc desktop runtime mở, và hỏi xác nhận trước
  khi thoát nếu còn job;
- dữ liệu cấu hình nằm trong Electron user data, không bị overwrite khi update.

## Build installer

Bản **3.9.0** kế thừa 3.8.0: quản lý nhiều máy bằng IP, spool bền vững do
connector điều phối, tiếp tục một cuộn qua nhiều lần điều chỉnh, ghi chú theo
bản ghi và IP trong CSV. UI chính dùng VALID/VOID. Connector tối thiểu **0.12.0**.
Xem [release notes 3.9.0](../build/RELEASE-NOTES-3.9.0.md) và
[báo cáo kiểm thử 3.9.0](../build/QA-3.9.0.md).

Bản **3.8.0** thêm **Template rotation: 0° / 90° / 180° / 270°** trong
panel Label. Xoay cả bố cục, đổi chiều rộng/cao ở góc 90°/270° và giữ nguyên
tỷ lệ. Text, ảnh và bảng xoay cùng khung, kể cả khi chỉnh sửa text; hỗ trợ
Undo/Redo và lưu/mở lại `.nwl`. Connector tiếp tục dùng **0.11.0**.
Xem [release notes 3.8.0](../build/RELEASE-NOTES-3.8.0.md).

Bản **3.7.0** đưa việc lấy baseline, checkpoint và chốt counter vào connector,
tách snapshot số máy với số đếm cuộn và liệt kê lượt chưa đối soát. Connector
tối thiểu **0.11.0**, có capability `connectorCounterLifecycleV1`.
Xem [đánh giá quy trình và SOP](COUNTER-SOP-REVIEW-2026-10-19.md).

Bản **3.6.0** tách đóng cuộn khỏi xuất CSV. Người vận hành chọn tiếp tục cuộn
cũ hoặc đóng cuộn để bắt đầu lô mới; lịch sử vẫn giữ lại và có thể xuất sau.
Connector tối thiểu **0.10.0**, có capability `productionRollLifecycleV1`.
Xem [release notes 3.6.0](../build/RELEASE-NOTES-3.6.0.md).

Bản **3.5.2** chốt số đếm sau lỗi mực/giấy/đầu in khi có đủ bằng chứng từ máy,
tách tem đạt bị loại khỏi tem lỗi ghi bị loại để tránh trừ GOOD hai lần.
Connector tối thiểu **0.9.2**. Xem [release notes 3.5.2](../build/RELEASE-NOTES-3.5.2.md).

Bản **3.5.1** rút gọn nội dung màn hình in/cấu hình/cuộn, giữ cảnh báo theo
trạng thái và xử lý thêm lỗi lưu RFID/counter khi máy đã nhận dữ liệu.
Connector tối thiểu **0.9.1**. Xem [release notes 3.5.1](../build/RELEASE-NOTES-3.5.1.md).

Bản **3.5.0** bổ sung giám sát lỗi tại connector, tách VALID máy / EPC đã lưu /
GOOD còn lại / VOID, chống trộn máy/template/chế độ trong cuộn và kiểm chứng
ghi EPC bằng đọc lại. Giữ một checkbox, ba trường nhập cuối cùng, CSV thuần
bảy cột và cuộn liên tục qua các lần in bù. Xem
[release notes 3.5.0](../build/RELEASE-NOTES-3.5.0.md). Connector tối thiểu **0.9.0**.

Bản **3.4.0** gom lưu dữ liệu/xuất CSV thành một lựa chọn, giữ mọi lần in và
in bù trong cùng cuộn đến khi xuất. RFID VOID chuyển tiếp sang tem kế tiếp;
thông tin người vận hành, Job ID và thứ tự cuộn chỉ nhập lúc xuất. File CSV thuần
không có mật khẩu để upload trực tiếp; xem [release notes 3.4.0](../build/RELEASE-NOTES-3.4.0.md).
Connector tối thiểu **0.8.0**; quy trình này thay thế các bước chốt/đối soát 3.3.0 bên dưới.

Bản **3.3.0** quản lý Job → cuộn thành phẩm → nhiều lượt in/bù. Dữ liệu gốc
vẫn tự lưu; CSV thành phẩm chỉ xuất khi người vận hành chốt và bấm xuất.
Phát hiện head-open/ribbon/media fault khóa lượt in và gửi pause/clear,
kết hợp `^JZN` để tắt tự reprint khi lỗi. Xem
[release notes 3.3.0](../build/RELEASE-NOTES-3.3.0.md) và
[giải pháp SOP](../sop_nextwaves/Solution_SOP.md). Bản này thay hành vi tự tạo
CSV tổng hợp cuối mỗi phiên của 3.2.0.

Bản **3.2.0** bỏ trần 2.500 tem/checkpoint, giữ gửi chunk tuần tự và bổ sung
**Save read data to host** cho template đọc RFID qua TCP. Connector lưu CSV
theo phiên; xem và tải trong **RFID session history** tại màn hình Print.
Xem [release notes 3.2.0](../build/RELEASE-NOTES-3.2.0.md) để thiết lập và nghiệm thu.

Bản **3.1.9** giữ đúng tỷ lệ gốc của ảnh import/replace khi thay đổi khung W/H.
Edit, preview và bitmap ZPL dùng chung cách fit ảnh, không kéo dãn hoặc cắt ảnh.
Replace giữ kích thước/vị trí khung và dùng tỷ lệ của ảnh mới, kể cả SVG chỉ có
`viewBox`. Xem [release notes 3.1.9](../build/RELEASE-NOTES-3.1.9.md).

Bản **3.1.8** sửa tương thích cắt Text RFID khi ZT610R / Link-OS 7.6.2
chỉ in một ký tự cuối. App lấy từng ký tự từ cuối và ghép theo thứ tự EPC;
Data Matrix và các trường in toàn bộ EPC tiếp tục dùng nguồn đọc đầy đủ.
Xem [release notes 3.1.8](../build/RELEASE-NOTES-3.1.8.md) và mẫu nghiệm thu kèm theo.

Bản **3.1.7** thêm **RFID text output → Last N characters** trong thuộc tính
Text liên kết với trường đọc RFID. Nhập `6` để in 6 ký tự HEX cuối; mỗi Text
lưu lựa chọn riêng trong template. Mặc định vẫn in toàn bộ dữ liệu.
Xem [release notes 3.1.7](../build/RELEASE-NOTES-3.1.7.md) để biết thiết lập và firmware.

Bản **3.1.6** thêm **Cancel batch** cho TCP: dừng dữ liệu chưa gửi, chờ lượt
truyền hiện tại kết thúc, xóa buffer qua cùng socket và xác minh buffer rỗng.
Pause/Resume tiếp tục lô hiện tại; Cancel bỏ phần còn lại và không tự Resume.
Giữ X trên máy in vẫn cần Cancel trong app để bỏ các tem chưa gửi. Khi mất
kết nối lúc hủy, app yêu cầu xóa buffer trên máy in sau khi đã ngừng gửi.

Từ bản **3.1.5**, màn hình Print cho chọn máy in Windows cho USB hoặc
Ethernet, gửi cả dải thành một Windows job, lịch sử và thông tin kỹ thuật thu
gọn. Không còn form TCP thường trực yêu cầu nhập ID/ghi chú. Chỉ sau lỗi thật
mới hiện thao tác phục hồi; không tự gửi lại các tem đã gửi.
Xem [revised.md](../revised.md) để biết hành vi, cách cập nhật và nghiệm thu.

Ứng dụng hỗ trợ in DataFeed theo cả hai chiều From–To: [release notes 3.1.2](../build/RELEASE-NOTES-3.1.2.md).
Ví dụ From `2350`, To `1750` in 601 nhãn theo thứ tự `2350, 2349, …, 1750`.
Các số này là vị trí dòng trong DataFeed, tính từ 1; dữ liệu gốc không bị đảo.

Yêu cầu dành cho developer:

- Windows x64;
- Node.js 20.19 trở lên;
- Go 1.22 trở lên trong PATH;
- source web/connector được kèm trong `web/`.

```powershell
cd Printer-controller
npm ci --prefix web
npm ci
npm run test
npm run dist:win
```

Sau khi pack/build, chạy kiểm thử trên renderer đã đóng gói:

```powershell
npm run test:editor-ui
npm run test:spool-ui
npm run test:spool-reverse-ui
npm run test:tcp-pause-ui
npm run test:tcp-cancel-ui
```

Các kiểm thử dùng profile riêng và chặn endpoint máy in thật. Kiểm thử Edit
xác minh thao tác với 2.500 dòng sau Print → Edit; kiểm thử spool dùng connector
giả lập để xác minh đủ 2.500 nhãn tăng dần và 601 nhãn giảm dần, mỗi batch một
Windows job. Có đối chiếu thứ tự preview, mã HEX, file ZPL và trang browser/PDF.
Kết quả nằm trong `build/editor-qa`, `build/spool-qa` và `build/spool-reverse-qa`
(Git bỏ qua).

`npm run dist:win` sẽ:

1. build `web/` với TCP execution cố định qua local connector;
2. stage `.next/standalone`, `.next/static`, `public` và template seed;
3. xác minh SHA-256 connector Windows x64 theo manifest;
4. tạo installer NSIS trong `dist/`.

Nếu developer đã build web và chỉ muốn refresh bundle:

```powershell
npm run prepare:web -- --skip-build
npm run verify:bundle
```

Để chọn source web bên ngoài thay cho `web/`:

```powershell
npm run prepare:web -- --source D:\path\to\ZbrePrinter
```

## Runtime ports

| Thành phần | Bind | Mục đích |
| --- | --- | --- |
| Next standalone | `127.0.0.1:18888` | UI/API nội bộ, origin cố định |
| Print Connector | `127.0.0.1:17917` | WinSpool RAW và Zebra TCP 9100 |

Origin Next được giữ cố định để `localStorage` template không đổi giữa các lần
mở. Nếu một process khác chiếm port, app dừng với diagnostic thay vì chuyển
port âm thầm và làm user tưởng dữ liệu đã mất.

Connector đang chạy sẵn chỉ được reuse nếu health response có đúng identity,
version tối thiểu và capability persistent TCP/checkpoint replay, per-printer
queue, RAW batch lease và durable RAW spool batch. Process lạ hoặc
connector cũ trên port 17917 bị từ chối.

## Print worker và điều phối khi thoát

Sau khi Next runtime sẵn sàng, Electron mở `/print-listener` trong một
`BrowserWindow` ẩn với background throttling tắt. Worker này nhận các job
browser-listener mà không phụ thuộc cửa sổ editor đang ở màn hình nào. Nếu
renderer bị crash, load lỗi hoặc unresponsive, Electron ghi log và khởi động
lại worker; job đang chạy tại thời điểm lỗi vẫn phải được xem là `uncertain`
cho đến khi đối soát thực tế.

Print step dùng cùng coordinator của web build: logical job FIFO theo printer,
stored-graphic window 100 cho template static, tối đa 25 label/chunk động hoặc
10 label/chunk RFID, và target 512/256/32 KiB tương ứng Windows RAW/TCP/COM.
Windows RAW chuẩn bị toàn bộ 1–2.500 nhãn theo đúng thứ tự vào staging trên
đĩa connector trước khi commit. Mỗi batch tạo một Windows print job duy nhất;
connector đọc file bằng buffer 512 KiB và ghi tuần tự bằng WritePrinter.
Chunk chuẩn bị không còn tạo một Windows job riêng. TCP/COM giữ luồng hiện có.

Queue Zebra phải bật spooling và **Start printing after last page is spooled**,
không dùng Print directly to printer hoặc printer pooling. Chương trình kiểm tra
các thiết lập này và báo lỗi nếu chưa phù hợp; không tự sửa cấu hình Windows.
Xem [hướng dẫn batch Windows](WINDOWS-SPOOL-BATCH.md).

Khi user đóng cửa sổ hoặc chọn quit, app kiểm tra:

- browser-listener queued/in-flight;
- FIFO đang active/wait trong Next runtime;
- connector per-printer active/queued và persistent TCP jobs;
- durable RAW batch đang staging/queued/spooling hoặc cần đối soát;
- logical print jobs đang active trong renderer chính.

Nếu còn công việc, hoặc một status probe thất bại nên không thể chứng minh hệ
thống đang idle, lựa chọn mặc định là **Wait for jobs**. **Force exit
(uncertain)** vẫn được cung cấp cho tình huống khẩn cấp và có thể cắt ngang
batch. Cơ chế này áp dụng cho quy trình đóng app bình thường; mất điện, kill
process hoặc Windows shutdown cưỡng bức vẫn có thể bỏ qua guard.

## Dữ liệu và log

Electron dùng app ID ổn định `com.nextwaves.zbreprinter`. Dữ liệu mutable:

```text
%APPDATA%\ZbrePrinter\
├─ data\
│  ├─ printer-routing.json
│  └─ integration-profiles\
├─ connector\
│  └─ paired-origins.json
└─ logs\
   └─ desktop-main.log
```

Uninstaller mặc định giữ app data. Template/session hiện vẫn dùng Chromium
storage; hãy export `.nwl` cho template quan trọng cho đến khi phase SQLite
backup/versioning được triển khai.

Durable Windows RAW batch lưu manifest và payload ở thư mục `raw-spool-batches`
cạnh pairing state của connector. Giao diện Print có bảng Windows print batches
để xem lại, hủy batch chưa gửi hoặc đối soát kết quả chưa rõ. Batch đang spooling
khi connector restart chuyển thành uncertain; không tự tạo bản in mới.
Browser-listener queue trước khi bắt đầu staging, FIFO runtime và TCP/legacy RAW
checkpoint receipts vẫn ở RAM, không được bảo đảm sống qua restart.

## Security

- BrowserWindow: `sandbox: true`, `nodeIntegration: false`,
  `contextIsolation: true`.
- Chỉ origin `http://127.0.0.1:18888` được phép điều hướng trong app.
- Integration API dùng token 256-bit theo mỗi lần chạy. Electron chèn header
  ở network layer; token không đưa vào JavaScript renderer.
- Next server và connector chỉ bind loopback.
- Runtime và connector được kiểm tra SHA-256 trước khi khởi động.

Installer hiện có thể build unsigned để kiểm thử nội bộ. Trước production phải
ký Authenticode cho connector, app executable và installer, kèm timestamp.

## Giới hạn production

Desktop packaging loại bỏ CMD và giảm rủi ro browser/process lifecycle, nhưng
không chứng minh nhãn/tag đã hoàn tất chỉ từ việc spooler/TCP nhận byte.
Mất điện/cáp sau write có thể cần giữ trạng thái `uncertain` và đối soát nhãn
valid/VOID trước khi resend. Windows job ID và GetJob chỉ cung cấp telemetry
của spooler, không xác nhận số tag hoặc nội dung EPC vật lý.

FIFO theo printer endpoint, hidden worker, same-socket TCP status barrier,
app-suspension blocker và quit guard hiện đã giảm concurrent write và lỗi
lifecycle.
Chúng không tạo exactly-once semantics và không xác nhận số tag vật lý.
Durable RAW batch 0.5.0 bổ sung lưu trên đĩa, chống lặp append/commit và phục hồi
trạng thái để đối soát. Việc kiểm chứng số nhãn valid/VOID, EPC và tương tác
phần cứng vẫn cần nghiệm thu với printer thực tế.
