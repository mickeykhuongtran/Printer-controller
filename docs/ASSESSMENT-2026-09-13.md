# Đánh giá in template, Zebra RFID và thứ tự datafeed

Ngày đánh giá: 2026-09-13. Phiên bản desktop/web: 3.0.0; connector: 0.4.0.

**Kết luận:** có nền tảng phù hợp để in template bằng ZPL trên ZT610R/ZD621R và đã có FIFO theo endpoint máy in. Chưa đủ để cam kết datafeed luôn được in đúng thứ tự, đủ số lượng, không trùng và đúng EPC trong mọi tình huống production. Các lỗi EPC và cơ chế nhận job/phục hồi bên dưới cần được xử lý trước khi nghiệm thu dây chuyền yêu cầu không nhầm nhãn/tag.

Đây là đánh giá source và kiểm thử phần mềm; không có lệnh in, encode RFID hoặc thay đổi cấu hình máy in vật lý trong đợt kiểm tra này. Không sửa logic in trong lần tạo baseline Git.

## Phạm vi và nguồn

- `ZbrePrinter-App` là Electron shell. Template compiler, UI, API, FIFO và source Go connector nằm ở sibling `../ZbrePrinter`.
- Bundle và `dist/win-unpacked` có manifest giống nhau, build ngày 2026-09-07; web source commit được ghi là `5f94b4c743774eb1ed5537dcd5440cb3516276a7`, nhưng `sourceDirty: true`. Connector ghi `signed: false`.
- 118 file trong `bundle/web/app` khớp SHA-256 với source tương ứng đang có ở sibling; 348 file `.next-desktop` khớp build sibling và packed build; connector EXE khớp artifact sibling. Điều này hỗ trợ việc đối chiếu source, nhưng không thay thế một clean build có source đã commit đầy đủ.
- Sibling `ZbrePrinter` đã có Git riêng và nhiều thay đổi chưa commit. Initial commit ở repo desktop không chứa hoặc commit thay những thay đổi đó; clone riêng repo desktop chưa đủ để rebuild toàn bộ sản phẩm.

## Khả năng tương thích template

| Máy | Profile hiện có | Điều kiện sử dụng |
| --- | --- | --- |
| ZT610R | ZPL, RFID; 203/300/600 dpi; print width 104 mm | Chọn đúng đầu in thực tế, khổ nhãn, media sensing, tốc độ, ribbon và calibration RFID |
| ZD621R | ZPL, RFID; 203/300 dpi; print width 104/108 mm theo catalog hiện tại | Không dùng profile 600 dpi; xác nhận EPC length/PC và calibration riêng cho inlay |

Catalog ở `../ZbrePrinter/app/printer-models.ts:42` và `:102`. Thông số DPI/ZPL được đối chiếu với [Zebra ZT600 RFID](https://www.zebra.com/us/en/products/spec-sheets/printers/industrial/zt600-rfid.html) và [Zebra ZD600 RFID](https://www.zebra.com/us/en/products/spec-sheets/printers/desktop/zd600-rfid-series.html). Cần kiểm tra SKU, firmware và cấu hình thực tế trước khi nghiệm thu. Có profile tương thích không đồng nghĩa đã kiểm thử trên cả hai máy.

Template `.nwl`, nội dung động và nhãn nhiều dòng được hỗ trợ. Hai đường render có giới hạn khác nhau: browser rendering phục vụ font/ảnh theo giao diện; server-native ZPL dùng font 0 và bỏ image (`app/zpl.ts:800`, `:1973`). Không nên đổi `renderMode` chỉ để vượt một lỗi mà chưa kiểm tra nội dung nhãn xuất ra. API browser-listener hiện từ chối nhiều bản in với dữ liệu serial/multi-row/RFID-encode động, trả 422; dùng bước Print cho batch hoặc native nếu template tương thích (`app/api/integration/print/route.ts:354`). API applyTemplateValues cũng thay dataFeed thành một dòng từ values (`app/integration.ts:173-184`): không được xem danh sách trong template upload là danh sách batch API. ZPL đang ép tear-off bằng `^MMT` (`app/zpl.ts:427`), nên chưa bao phủ nguyên trạng workflow cutter/peeler/rewinder.

## USB và Windows spooler

Luồng Windows RAW:

```text
DataFeed / API → template + dữ liệu → ZPL theo dòng/chunk
→ FIFO và khóa logical batch → Local Print Connector
→ OpenPrinterW → StartDocPrinterW(RAW) → WritePrinter → EndDocPrinter
→ Windows print queue → cổng USB → firmware Zebra
```

Đường này thực sự sử dụng Windows spooler, không phải gửi USB trực tiếp từ Electron. Source: `../ZbrePrinter/native/local_print_agent_go/spooler_windows.go:139-273`. Nếu chọn TCP trực tiếp hoặc COM thì không đi qua Windows spooler.

Windows nhận ZPL đã được app tạo sẵn. Nó không tự render template, sửa DPI, đối chiếu EPC hay sắp lại business sequence. Với RAW, payload phải mô tả các thiết lập mà firmware cần, theo [Microsoft WritePrinter](https://learn.microsoft.com/en-us/windows/win32/printdocs/writeprinter).

Spooler quản lý các job và truyền dữ liệu; app chưa theo dõi vòng đời từng job bằng `GetJob`/job notifications để đối soát hoàn tất. Trả thành công hiện có nghĩa **spool-accepted**, không xác nhận đã in hoặc encode đủ. [Microsoft JOB_INFO_2](https://learn.microsoft.com/en-us/windows/win32/printdocs/job-info-2) cũng phân biệt trạng thái đã gửi tới máy và kết quả in; job có priority và vị trí queue, có thể được điều chỉnh bằng [SetJob](https://learn.microsoft.com/en-us/windows/win32/printdocs/setjob).

## Bảo đảm thứ tự hiện có

| Trường hợp | Đánh giá |
| --- | --- |
| Các dòng trong cùng DataFeed, cùng logical batch | Giữ thứ tự mảng/phạm vi chọn và gửi chunk bằng `await`, không chủ động đảo dòng |
| Nhiều chunk cùng batch Windows RAW | Connector giữ lease theo endpoint xuyên suốt batch; kiểm tra sequence và payload hash để chống xen kẽ/replay cùng chunk trong thời gian lưu receipt |
| Nhiều request đã vào cùng một FIFO | Chạy lần lượt theo thứ tự vào FIFO |
| Datafeed phát A rồi B nhưng hai HTTP request cùng đang xử lý | Chưa bảo đảm A vào FIFO trước B: đọc profile/template/routing bất đồng bộ diễn ra trước enqueue; chưa có business sequence tại cổng nhận |
| Cùng máy vật lý được khai báo bằng hai queue hoặc cả USB lẫn TCP | Khóa theo tên queue/endpoint không hợp nhất thành một định danh máy vật lý |
| App khác gửi vào cùng máy | Khóa của connector không kiểm soát được nguồn gửi ngoài connector |
| Lỗi giữa batch, mất điện, crash, restart | Không có bảo đảm đủ/không trùng/thứ tự xuyên restart; core queues và checkpoint nằm trong RAM |

Bằng chứng: `app/components/PrintStep.tsx:228-252`, `:754-765`; `app/print-job-coordinator.ts:78`; `app/server-printer-queue.ts:52`; `app/api/integration/print/route.ts:282-376`, `:472-505`; `native/local_print_agent_go/raw_batch.go:33-38`, `:191-238`, `:271-293` (đều thuộc sibling `ZbrePrinter`).

Ví dụ A gồm 3 chunk, B gồm 2 chunk: đường thành công cùng endpoint được giữ thành `A1 A2 A3 B1 B2`, tránh `A1 B1 A2 B2 A3`. Nhưng nếu request B hoàn thành bước chuẩn bị trước A và enqueue trước, FIFO vẫn có thể chạy `B1 B2 A1 A2 A3`. FIFO đúng không tự chứng minh thứ tự yêu cầu nghiệp vụ đúng.

Đã tái hiện đảo thứ tự bằng route TypeScript thực và queue thực, chỉ mock I/O metadata: gọi POST A trước B, trì hoãn alias lookup của A 40 ms, cùng printer; cả hai trả 202 nhưng listener nhận B trước A. Không phát sinh lệnh in vật lý. Trường hợp client đợi ACK A rồi mới POST B sẽ tránh race chuẩn bị này trong đường bình thường, nhưng chưa giải quyết recovery hoặc kết quả vật lý chưa rõ.

## Những điểm cần sửa trước production

### P1 — EPC ASCII có thể bị thay đổi hoặc trùng âm thầm

`app/rfid.ts:143-149` cắt chuỗi theo độ dài EPC mà không báo lỗi. Tái hiện với ASCII 96 bit:

```text
ABCDEFGHIJKL-001 → ABCDEFGHIJKL
ABCDEFGHIJKL-002 → ABCDEFGHIJKL
```

Cả hai sinh cùng lệnh `^RFW,A,,,A^FDABCDEFGHIJKL^FS`. Ký tự `^` và `~` cũng bị thay thành dấu cách qua `zplText`, làm dữ liệu ghi khác nguồn. Cần validate số byte/character set trước khi đưa vào queue; reject quá dài hoặc unsupported encoding và dùng escaping chính xác. Không được âm thầm cắt mã định danh.

### P1 — Bật encode nhưng EPC rỗng vẫn có thể in nhãn

`app/zpl.ts:531` trả chuỗi rỗng nếu dữ liệu ghi rỗng. Tái hiện native compilation với `{epc: ""}`: không có preflight error, có `^PQ1`, không có `^RFW`. Kết quả có thể là nhãn được in nhưng tag chưa encode hoặc còn dữ liệu cũ. Phải reject job trước khi gửi khi encode được bật mà EPC không hợp lệ/rỗng.

### P1 — EPC có thể bị gán thay cho TID đọc từ chip

`app/label-data.ts:152-161` lấy alias `epc` để điền vào RFID read field mà không xét readBank. Đã tái hiện cấu hình `readBank=TID`, `readFieldName=tid`, values có `epc=112233445566778899001122`: nhãn in literal `TID=112233445566778899001122`; lệnh đọc TID thật `^RFR,H,0,12,2^FN1` vẫn có nhưng kết quả không được dùng. Cần phân biệt nguồn EPC với TID và chỉ dùng dữ liệu đã đọc đúng bank cho trường được đánh dấu là printer-read.

### P1 — Cổng datafeed ngoài Electron chưa kết nối hoàn chỉnh

`electron/main.cjs:578` tạo token ngẫu nhiên mỗi lần chạy; `:240-253` chỉ gắn Authorization trong Electron session; `electron/runtime.cjs:81` chuyển token vào Next. `../ZbrePrinter/proxy.ts:68` từ chối request không có token. Không có cơ chế credential/pairing cho process datafeed ngoài app trong luồng desktop hiện tại.

Kiểm thử proxy với request tổng hợp, không gọi máy in: request ngoài app không bearer → HTTP 401; token hợp lệ → HTTP 200 đi tiếp. Sibling gateway `Zbreintegration-tool/src/gateway.cjs:321-326` chỉ gửi Content-Type upstream, nên cũng cần tích hợp credential nếu chuyển sang desktop API này. Không nên giải quyết bằng bỏ xác thực; cần một API intake được cấp quyền rõ ràng và ổn định cho datafeed.

### P1 — Chưa bảo đảm recovery và không lặp job ở mức nghiệp vụ

Core API tạo ID mới mỗi lần POST (`app/api/integration/print/route.ts:482`, `app/integration-browser-print.ts`); không có ledger durable chung cho request ID, business sequence, row/EPC và spool job ID. Receipt chống lặp chunk của connector là cơ chế riêng, không ngăn resend toàn bộ API request với ID mới.

Batch `uncertain` giữ khóa một thời gian nhưng tự chuyển expired và nhả máy sau idle timeout 30 phút (`native/local_print_agent_go/raw_batch.go:14`, `:304-342`). Chưa có đối soát vật lý bắt buộc trước khi cho luồng tiếp tục. Restart mất cả queue/receipt RAM. Không được tự resend khi timeout chỉ vì client chưa nhận được response.

### P2 — EPC length/PC trên ZD621R cần xử lý rõ

ZT610R có đường auto-PC bank A; ZD621R đang dùng bank 1, mặc định start word 2 (`app/zpl.ts:533-541`, `app/zebra-rfid.ts:23-28`). Ghi EPC vào word 2 không đồng thời thiết lập PC length ở word 1 trong payload này. Với độ dài EPC khác PC hiện có trên tag, cần xác nhận/chủ động quản lý PC theo [tài liệu Zebra ^RF](https://docs.zebra.com/us/en/printers/software/zpl-pg/c-zpl-rfid-zpl-rfid-commands/r-zpl-rfid-rf.html), thay vì mặc định đã tương đương ZT610R. Đây là suy luận từ payload và cấu trúc PC, cần kiểm thử trên phần cứng, không phải khẳng định mọi lần ghi ZD621R đều lỗi.

### P2 — Nếu dùng gateway sibling, trạng thái có thể bị diễn giải quá mức

`Zbreintegration-tool/src/gateway.cjs:359-365` coi upstream `ok` + `waitForCompletion=true` là `spooled`. Core vẫn có thể trả HTTP 202 `queued-or-in-flight` sau hết thời gian chờ (`ZbrePrinter/app/api/integration/print/route.ts:420-437`). Cần giữ nguyên ý nghĩa pending và poll `statusUrl`. Gateway có SQLite idempotency riêng, nhưng không thay thế FIFO/ledger/recovery trong core và không xác nhận nhãn vật lý.

## Hướng hoàn thiện đề xuất

1. Sửa validation EPC và credential intake trước; khóa model/DPI/template version cho mỗi job. Chốt payload bất biến trước khi nhận trách nhiệm in.
2. Ghi nhận job trong SQLite/WAL bằng transaction trước khi ACK: request ID ổn định, stream ID + sequence, physical printer ID, template/payload hash, row index, EPC, số lượng.
3. Một dispatcher theo physical printer; sequence phải được kiểm tra tại intake. Có missing sequence hoặc kết quả uncertain thì giữ luồng chờ đối soát, không tự vượt sang phần sau.
4. Lưu batch/chunk/spool job IDs và trạng thái rõ: queued → submitted/spool-accepted → printer-confirmed/verified; lỗi chưa rõ → uncertain. Retry cùng ID và payload đã cố định. Spooler telemetry hữu ích nhưng chưa chứng minh nội dung tag đúng.
5. Đối soát số nhãn valid/VOID và đọc EPC/barcode; khi cần bảo đảm nội dung, dùng đọc kiểm tra trên máy và/hoặc reader/scanner ngoài. Không tuyên bố exactly-once chỉ dựa trên HTTP 200, WritePrinter thành công hoặc job biến mất khỏi spooler.
6. Nghiệm thu trên cả ZT610R và ZD621R: dòng 0001…N có mã nhìn thấy + barcode + EPC tương ứng; kiểm tra nhiều chunk, hai job liên tiếp, request đồng thời, hết giấy/ribbon, rút USB, tắt app/restart, response timeout, duplicate request và EPC rỗng/quá dài. Điều kiện đạt phải gồm thứ tự nhãn hợp lệ, số lượng, nội dung và chính sách xử lý VOID.

## Kiểm thử đã thực hiện

- Desktop `npm test`: 8/8 pass.
- `npm run verify:bundle` và `npm run verify:packed`: pass, gồm connector health; strictRelease=false, connector unsigned.
- Web regression đã pass: `test:print-batch-data` (bao gồm 2500 bản), `test:browser-print-queue` (1000 job FIFO), `test:zpl-rfid`, `test:dpi-preflight`.
- Connector `go test ./...`: pass (cached), chạy bằng Go toolchain bundled tại sibling.
- Reproduction bằng module thật xác nhận các trường hợp EPC ASCII trùng sau truncate, ký tự bị thay, EPC rỗng không chặn compile, EPC bị gán thành TID, API admission đảo A/B khi metadata I/O hoàn thành khác thứ tự và auth bên ngoài Electron.
- Không thực hiện in/encode vật lý. Test pass hiện tại không phủ hết các lỗi đã tái hiện ở trên.

## Baseline Git

Repo local mới ở `ZbrePrinter-App`, branch `main`, giữ version ứng dụng 3.0.0. Theo dõi source Electron, scripts, tests, package lock, icon và release notes; loại trừ dependencies, bundle, installer, QA Chromium profile, backup build và cấu hình nhạy cảm. Source sibling cần một commit riêng để có baseline đầy đủ cho toàn bộ sản phẩm.
