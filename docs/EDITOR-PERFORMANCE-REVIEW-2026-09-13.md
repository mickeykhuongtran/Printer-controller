# Review hiệu năng Edit với 2.500 dòng DataFeed

> Cập nhật sau review: lỗi đã được sửa và kiểm chứng trong [bản 3.1.1](../build/RELEASE-NOTES-3.1.1.md). Nội dung bên dưới ghi lại kết quả của bản 3.1.0 trước khi sửa.

Ngày: 2026-09-13. Phiên bản: desktop/web 3.1.0. Source web: `e1f9b37161a87be48cbf77be779b6a8af2bf16d1`; desktop: `316537dae51624811ea9c51fa50d9b40101ebb36`.

## Kết luận

**Xác nhận lỗi P1:** khi `doc.settings.copies` lớn, mỗi thay đổi document trong màn hình Edit chạy đồng bộ `buildZpl()` cho toàn bộ số bản in trên luồng giao diện. Kéo barcode 2 mm sau khi vào Print rồi trở lại Edit đã được tái hiện mất **7,38 giây** trên bản desktop đã build; sửa nội dung QR mất **7,71 giây**.

Canvas không tạo 2.500 canvas/template riêng. Công việc dư thừa là đánh giá dữ liệu, mã hóa barcode/QR và tạo chuỗi ZPL cho toàn batch trong lúc React đang render. Tab nhận chuỗi ZPL này hiện bị ẩn.

Import 2.500 dòng khi `copies = 1` chưa tự động tạo 2.500 bản. Tuy nhiên, vào Print với phạm vi All sẽ đặt `copies = 2500`; khi trở về Edit, giá trị này vẫn còn. Session/template lưu sẵn số lượng lớn cũng có thể kích hoạt lỗi ngay khi mở.

Review này không sửa mã sản phẩm, không thay đổi cấu hình máy in, không gửi lệnh in và không tích hợp QZ.

## Bằng chứng từ code

Các đường dẫn sau tính từ repository `../ZbrePrinter`:

| Vị trí | Hành vi và tác động |
| --- | --- |
| `app/page.tsx:535–548` | `useMemo(() => buildZpl(state.doc), [state.doc])` chạy ở component trang, không phụ thuộc việc đang Edit hay có mở ZPL panel. Mỗi lần đổi tọa độ/nội dung làm document đổi tham chiếu và vô hiệu hóa memo. |
| `app/components/ElementBox.tsx:211–258` | Pointer move gọi `onMove()` trực tiếp. `app/page.tsx:1425` dispatch `moveElement`. |
| `app/reducer.ts:669–674` | `moveElement` tạo document mới nhưng giữ nguyên tham chiếu DataFeed. Reducer không sao chép hoặc sinh template cho từng dòng. |
| `app/zpl.ts:1985` | `buildZpl()` lấy `previewBatch()`, lặp các bản in, gọi `emitElement()` cho từng object, ghép các block ZPL. Đây là công việc đồng bộ. |
| `app/label-data.ts:280–307` | Số entry trong `previewBatch()` lấy từ `settings.copies`; mỗi entry giải dữ liệu tương ứng. |
| `app/components/PrintStep.tsx:259–283` | Effect của phạm vi All đồng bộ số lượng bản in về tổng số dòng DataFeed. Giá trị thuộc document nên tồn tại khi quay lại Edit. |
| `app/components/BottomDock.tsx:55` | `SHOW_ZPL_SOURCE_TAB = false`; phần giao diện xem ZPL ẩn nhưng component cha vẫn tạo toàn bộ chuỗi. |
| `app/page.tsx:579–595` | Canvas chỉ giải dữ liệu của một dòng preview được chọn, hoặc dùng giá trị mẫu trong template. |
| `app/components/DataFeedSheet.tsx:373–412` | Bảng đã virtualize khi vượt 60 dòng. Bài đo 2.500 dòng chỉ có 22 `<tr>` trong DOM, bao gồm các dòng spacer. |

Chuỗi gây lỗi:

`Print chọn All → copies = 2500 → quay về Edit → pointermove/updateElement → document mới → buildZpl(2500 bản) → luồng giao diện bị chặn → tọa độ/nội dung mới xuất hiện muộn`.

## Đo trên renderer desktop đã build

Chạy renderer production trong `dist/win-unpacked/resources/web`, Electron 43.2.0 / Chromium 150, cửa sổ offscreen 1.600 × 1.100, profile thử nghiệm riêng. Nguồn `app/page.tsx` trong bundle khớp SHA-256 với source hiện tại: `1CEB05777511048DF95FBFEBC043B8FBCA069D375AD221AB18C40DF79F52497E`.

Fixture: tem 80 × 45 mm, 300 dpi, một CODE128, một QR, một text; 2.500 dòng có mã HEX 24 ký tự khác nhau, giữ số 0 đầu. RFID write tắt để cô lập việc thiết kế/mã hóa hình. Không có request tới connector hoặc máy in; harness chỉ cho phép truy cập web server thử nghiệm.

| Tình huống | Từ lúc chuẩn bị gửi sự kiện đến DOM cập nhật | Đến frame kế tiếp |
| --- | ---: | ---: |
| 2.500 dòng, copies = 1, DataFeed đóng; kéo phải 2 mm | 19,8 ms | 21,5 ms |
| 2.500 dòng, copies = 1, DataFeed mở; kéo trái 2 mm | 15,8 ms | 16,0 ms |
| Vào Print rồi Edit, copies = 2.500, DataFeed đóng; kéo phải 2 mm | 7.379,8 ms | 7.380,0 ms |
| Sửa QR từ `{HEX}` thành `HEX:{HEX}`, copies = 2.500 | 7.711,3 ms | Không đo |

Kéo được gửi bằng `webContents.sendInputEvent()` qua đường pointer thực của renderer, có kiểm tra tọa độ dịch chính xác 16 pixel ở zoom 8 pixel/mm. Lần kéo 2.500 bản có bật CPU sampling profiler. Phép sửa QR dispatch cùng action `updateElement` mà panel thuộc tính dùng; không đo tốc độ gõ vật lý. Đây là các mẫu đo tái hiện, không phải phân vị latency hoặc bảo đảm hiệu năng cho mọi template/phần cứng.

## Đo riêng nhánh compiler

Node v24.16.0, cùng fixture, mỗi cấu hình gọi compiler ba lần; giữa các lần chỉ thay đổi vị trí barcode 2 mm. Có bộ đếm số lần gọi đánh giá dòng và mã hóa symbol.

| Dòng DataFeed | Copies | Thời gian mỗi lần build ZPL | EvaluateRow / Barcode / QR mỗi lần |
| ---: | ---: | ---: | ---: |
| 1 | 1 | 2,59–3,81 ms | 1 / 1 / 1 |
| 2.500 | 1 | 2,60–2,75 ms | 1 / 1 / 1 |
| 2.500 | 1.000 | 3.299,74–3.827,03 ms | 1.000 / 1.000 / 1.000 |
| 2.500 | 2.500 | 8.299,52–9.943,46 ms | 2.500 / 2.500 / 2.500 |

Một batch 2.500 bản tạo 1.819.869 byte ZPL. Trong mẫu này, riêng reducer move dưới 1 ms; giải một dòng preview dưới 0,3 ms; normalize và JSON stringify session 2.500 dòng khoảng 0,9–2,0 ms. Chưa đo riêng thời gian Windows/browser ghi localStorage. Không có bằng chứng để quy độ trễ nhiều giây ở fixture này cho autosave hoặc virtualization của bảng.

QR có cache matrix 128 mục và module count 256 mục (`app/qr-sizing.ts:91–93`). Quét lặp 2.500 giá trị khác nhau làm cache bị thay thế liên tục. Chỉ tăng cache hoặc thêm `useMemo` ở component cha không xử lý được việc toàn batch vẫn bị compiler chạy lại khi kéo.

## Hướng sửa ưu tiên

1. **Bỏ việc tạo toàn batch ZPL khỏi render của trang.** Hiện tab ZPL bị ẩn nên bỏ đường tính và prop không còn dùng. Nếu cần phục hồi tab, tạo preview khi người dùng mở, giới hạn một dòng được chọn; không thay `settings.copies` của lệnh in thật thành 1 để né lỗi.
2. **Chỉ tạo toàn bộ dữ liệu khi Print hoặc Export yêu cầu.** Giữ kiểm tra đầy đủ, thứ tự và cơ chế staging/chunk hiện tại trong luồng in. `PrintStep` đã có `runPrintJob()` cho hành động in/xuất; nhánh ZPL đồng bộ ở trang không phải điều kiện bắt buộc để spool batch hoạt động.
3. **Tối ưu render phụ sau khi bỏ nguyên nhân chính:** cho DataFeed/BottomDock bỏ qua render khi props liên quan không đổi; không dispatch move/resize khi tọa độ sau snap không thay đổi. Chỉ thêm điều tiết theo animation frame nếu phép đo sau sửa vẫn cho thấy cần thiết.
4. **Thêm kiểm thử hồi quy theo đúng đường phát sinh lỗi:** import 2.500 dòng → Print All → Edit → kéo phải 2 mm, sửa QR, đổi text, undo/redo, mở/đóng bảng và đổi dòng preview. Xác minh thao tác Edit không gọi compiler cho cả batch; khi in vẫn tạo đủ 2.500 nhãn đúng thứ tự và HEX không đổi.

Debounce toàn batch chỉ dời đợt treo giao diện sang thời điểm muộn hơn. Worker có thể hữu ích cho tác vụ xuất/in nặng, nhưng trước tiên cần loại bỏ công việc không phục vụ màn hình Edit. Tích hợp QZ không tự khắc phục vấn đề này vì nó nằm trước lớp giao tiếp máy in.

## Artifact tái hiện

Các file đo nằm trong thư mục scratch được Git bỏ qua: `../ZbrePrinter/tmp/editor-perf-review/`:

- `benchmark.cjs`, `node-results.json`: benchmark compiler và số lần gọi.
- `packaged-review.cjs`, `packaged-results.json`: tái hiện renderer production.
- `packaged-drag.cpuprofile`: CPU profile của lần kéo bị chậm.

Chạy lại từ `ZbrePrinter`: `node tmp/editor-perf-review/benchmark.cjs`.

Chạy lại renderer từ `ZbrePrinter-App`: `.\node_modules\.bin\electron.cmd ..\ZbrePrinter\tmp\editor-perf-review\packaged-review.cjs`.

Ở thời điểm hoàn tất review ban đầu, chưa có bản sửa, commit hoặc installer mới cho vấn đề này. Kết quả triển khai tiếp theo được ghi trong release notes 3.1.1 ở đầu tài liệu.
