# Review độ tin cậy in tem Zebra

Ngày 13 tháng 10 năm 2026. Phạm vi chính: ZT610R và ZD621R, in bằng TCP trực tiếp qua IP; Windows RAW qua USB là đường phụ. Kiểm tra desktop 3.1.9, source web 3.1.9 và connector Go 0.5.2.

**Kết luận: luồng bình thường đã có nền tảng tốt, nhưng chưa đáp ứng tiêu chí sản xuất nghiêm ngặt “không trùng tem, không bỏ dòng, phục hồi có bằng chứng”.** Có lỗi tái hiện được trong vòng đời giao diện, khóa máy in và chuẩn hóa EPC. Không nên nâng số lượng bằng cách chỉ thay hằng số 2.500. Nên giữ streaming có giới hạn, sửa các lỗi P1 và bổ sung nhật ký job bền vững trước khi mở lô lớn.

Đây là review và các ca tái hiện; không thay đổi mã sản phẩm, không nâng giới hạn, không gửi dữ liệu tới máy in thật. Source hai project có sẵn thay đổi chưa commit khi bắt đầu. Các bài UI chạy trên artifact hiện có trong `dist/win-unpacked`, không khẳng định đó là đúng file đang cài tại máy sản xuất.

## Các phát hiện theo mức ưu tiên

P1: sửa trước khi coi tính năng phù hợp cho lô tem định danh không được trùng. P2: có thể gây lỗi vận hành, sai nội dung hoặc mất thiết kế; phải xử lý trước khi tăng quy mô.

### P1 Giao diện mất trạng thái job khi quay lại Edit

Nguồn: `../ZbrePrinter/app/page.tsx:1272`, `:1677`; `app/components/PrintStep.tsx:202`, `:238`, `:1039`.

`PrintStep` chỉ được mount khi `step === "print"`. Các trạng thái `busy`, `tcpCancellation`, range và `printOperationRef` nằm trong component này; **Edit again** vẫn hoạt động lúc đang in. Rời Print không dừng promise đang chạy hoặc giải phóng job. Khi trở lại, component mới cho rằng chưa có job.

Tái hiện bằng renderer đóng gói, connector giả và chặn endpoint máy in thật:

1. In dải 2500 → 2450, 51 tem; Pause ở chunk thứ ba.
2. Ban đầu nút Print bị khóa, Cancel batch hiện.
3. Bấm Edit again → Continue.
4. `activeJobs` vẫn bằng 1, nhưng Cancel biến mất; **Print 2500 labels** đã bật và dải trở về All.

FIFO có thể xếp lượt in mới sau lượt cũ, nhưng không biết đó là cùng dữ liệu đã in. Vì vậy nó không ngăn được một lô trùng do thao tác này. Đây là rủi ro ngay trong một cửa sổ, không cần ứng dụng khác.

Sửa: đưa job store/controller ra khỏi vòng đời màn hình; UI đọc trạng thái job đang tồn tại theo printer ID. Chuyển tab không được làm mất range, progress hoặc Cancel. Một job đang gửi/chưa đối soát phải chặn việc tạo một job mới vô tình dùng cùng phạm vi. Lệnh in lại cần là thao tác riêng có liên kết tới job gốc.

Bằng chứng: `build/review-2026-10-13/navigation-qa/result.json` và `audit-navigation-ui.cjs`.

### P1 Khóa job TCP lỗi tự hết hạn và không sống qua restart

Nguồn: `../ZbrePrinter/native/local_print_agent_go/tcp_job.go:21`, `:81`, `:223`, `:331`, `:890`; `app/components/TcpJobReconciliation.tsx:34`; `app/components/PrintStep.tsx:1210`.

Checkpoint, receipts, trạng thái `uncertain` và quarantine TCP nằm trong `map` RAM. `cleanupTerminalLocked()` xóa mọi terminal record sau một giờ, kể cả chưa `reconciled`. Khi record biến mất, kiểm tra quarantine không còn thấy máy đó cần đối soát. Restart connector cũng làm mất toàn bộ TCP records.

Tái hiện: open → append một format → abort thành uncertain. Job mới cùng target bị từ chối đúng. Đặt thời điểm kết thúc cũ hơn retention rồi open lại: job mới được nhận dù chưa đối soát.

UI có lớp chặn bổ sung bằng `stoppedTcpJobId`, nên **không phải cứ đủ một giờ là nút Print trong cửa sổ đang giữ reminder tự mở**. Tuy nhiên reminder chỉ được ghi khi code đi vào catch, sau khi lỗi đã xảy ra. Renderer bị kill trong lúc in không bảo đảm chạy catch; không có durable record được ghi trước lần gửi đầu để khôi phục đầy đủ job/range sau crash.

Sửa: connector lưu manifest, printer ID, range, template/data hash, từng chunk và trạng thái write-ahead xuống đĩa trước side effect. Bất kỳ đoạn `dispatching` chưa có kết quả xác định khi restart đều phải thành uncertain. Quarantine chưa đối soát không có TTL; chỉ dọn lịch sử đã giải quyết theo chính sách lưu trữ. Phải persist cả job đang chạy, không chỉ con trỏ lỗi phía UI.

Bằng chứng: `TestReviewUnreconciledTCPMustNotExpire` trong Go overlay, thất bại trên mã hiện tại.

### P1 Connector chưa khóa toàn bộ job đối với mọi đường gửi TCP

Nguồn: `../ZbrePrinter/native/local_print_agent_go/tcp_job.go:489`, `:658`; `tcp_exchange.go:213`; `printer_queue.go:31`.

Hai persistent jobs có cùng chuỗi host/port bị chặn đồng thời. Nhưng khóa shared printer queue chỉ được lấy và nhả quanh từng `append`/`query`. `/v1/tcp` dùng cùng khóa theo từng request, cho phép payload tùy ý và không kiểm tra persistent owner/quarantine. Một caller khác có thể gửi format hoặc lệnh thay đổi trạng thái giữa hai chunk của một logical job.

Queue của browser bảo vệ nhiều thao tác trong **cùng renderer**. Nó không thay thế kiểm tra cuối ở connector: renderer khác, cửa sổ cấu hình khác hoặc caller của endpoint có thể không chia sẻ registry đó.

Tái hiện: mở persistent job, append chunk 1; admission primitive của `/v1/tcp` vẫn lấy được cùng target trước khi job finish.

Sửa: giữ lease ở connector từ begin đến finish/drain hoặc reconciliation cho toàn logical job. Tất cả endpoint gửi dữ liệu phải kiểm tra lease. Status/Pause/Resume/Cancel trong lúc in cần command channel có điều phối với session hiện hành; không khóa toàn bộ control sau job khiến Resume phải chờ chính job đang Pause kết thúc. Những lệnh có thể xóa hoặc thay đổi queue cần cập nhật trạng thái job tương ứng.

Bằng chứng: `TestReviewTCPLeaseMustCoverLogicalJob`, thất bại trên mã hiện tại. Đây là khả năng chen của đường gửi khác; chưa có bằng chứng nó là nguyên nhân lần nhảy số cụ thể tại hiện trường.

### P1 Các địa chỉ của cùng máy in dùng khóa khác nhau

Nguồn: `../ZbrePrinter/native/local_print_agent_go/printer_queue.go:31`; `tcp_job.go:333`; `app/print-job-coordinator.ts:44`.

Khóa là chuỗi `tcp:host:port` hoặc `winspool:printerName`. `printer.local` và IP của nó khác khóa; tên hai Windows queues trỏ cùng máy cũng khác; TCP và USB/Windows không có ánh xạ máy vật lý chung. `resolvedAddress` được ghi nhận nhưng không dùng để hợp nhất quyền sở hữu.

Go probe với hai tên cùng resolve tới một endpoint nhận cả hai job. Không có bảo đảm độc quyền giữa TCP trực tiếp và queue Windows của cùng Zebra.

Sửa: registry máy in với stable printer ID, serial/model và các endpoint đã xác minh thuộc cùng thiết bị. Mỗi thiết bị có một hàng đợi và một quarantine. Host/IP được canonicalize nhưng IP không thay thế serial lâu dài vì có thể đổi. Phần mềm khác ngoài connector vẫn cần được kiểm soát bằng cấu hình vận hành hoặc giới hạn nguồn gửi trên mạng.

Bằng chứng: `TestReviewResolvedPrinterAliasMustShareLease`, thất bại trên mã hiện tại.

### P1 RFID ASCII bị cắt âm thầm và có thể tạo EPC trùng

Nguồn: `../ZbrePrinter/app/rfid.ts:144`; `app/zpl.ts:472`.

`padEpcAsciiToBits()` dùng `slice(0, targetBytes)`. Ví dụ EPC 96 bit ở chế độ ASCII chỉ có 12 byte:

```text
Input A: ABCDEFGHIJKL1675
Input B: ABCDEFGHIJKL1676
Cả hai: ^RFW,A,,,A^FDABCDEFGHIJKL^FS  (ZT610R)
```

Hai dòng khác nhau tạo cùng lệnh encode mà không báo lỗi. HEX có validation chặt hơn; không nên suy ra ASCII cũng an toàn. Đếm `string.length` còn không phải kiểm tra byte/ASCII khi đầu vào có Unicode. `zplText()` cũng biến đổi các ký tự điều khiển ZPL, nên dữ liệu định danh cần được kiểm tra và mã hóa chính xác trước khi phát lệnh.

Sửa: reject dữ liệu quá dung lượng, ký tự ngoài encoding được hỗ trợ và các phép biến đổi mất thông tin. Không tự cắt chuỗi định danh. Chuẩn hóa sang byte sequence duy nhất, dùng byte sequence đó cho preview/encode/hash/kiểm tra duplicate. Nếu cần ASCII nên chuyển sang HEX từ encoding đã xác định và kiểm tra số byte/word, thay vì để nhiều đường xử lý khác nhau.

Bằng chứng: `audit-probes.cjs`, hai input khác nhau cho output bằng nhau.

### P1 Dòng EPC rỗng trên TCP vẫn có thể in hình mà không ghi RFID

Nguồn: `../ZbrePrinter/app/components/PrintStep.tsx:565`, `:981`, `:1056`; `app/zpl.ts:542`, `:672`; `app/raw-spool-preflight.ts:6`.

Khi binding EPC trả về chuỗi rỗng, `buildFullPageZpl()` bỏ qua nhánh ghi RFID; `buildZebraRfidWriteCommand()` cũng trả chuỗi rỗng. Preflight chung kiểm tra model/symbol/layout nhưng không chặn trường hợp này. Windows batch gọi `validateSpoolHexRows()` trước staging; TCP không gọi bước tương đương.

Probe xác nhận: EPC rỗng không có blocking issue, output chứa `^PQ1` nhưng không có `^RFW`; cùng document bị Windows HEX preflight từ chối. Có thể nhận một tem đã in mặt nhưng còn EPC cũ/trắng. Những lỗi HEX không rỗng thường được generator bắt, nhưng TCP mới kiểm tra khi đến dòng đó, sau khi phần trước có thể đã gửi.

Sửa: một preflight dữ liệu dùng chung cho TCP, Windows, export và API; validate toàn dải trước byte in đầu tiên. Kiểm tra bắt buộc/nonempty, encoding, dung lượng chip, công thức, binding và uniqueness của các trường được khai báo là định danh. Với RFID enabled, thiếu payload phải là lỗi, không phải yêu cầu in thường.

### P1 API browser listener chưa chống lặp ở cửa vào

Nguồn: `../ZbrePrinter/app/api/integration/print/route.ts:376`, `:476`; `app/integration-browser-print.ts:358`.

Nhánh native nhận `batchId`/`Idempotency-Key`. Nhánh browser-listener gọi `queueBrowserPrintJob()` mà không truyền request key; hàm queue luôn tạo UUID mới. Nếu caller mất phản hồi rồi POST lại cùng yêu cầu, hai logical jobs khác nhau được tạo. Connector chống lặp theo batch ID không thể gộp hai UUID khác nhau.

Đây là lỗi của đường integration, không phải vòng `append` TCP tương tác chính mà người dùng đang dùng. Khi đánh giá toàn project cần sửa để tránh mở lại cùng rủi ro qua API.

Sửa: bắt buộc hoặc hỗ trợ rõ một business request ID, persist key + hash nội dung trước enqueue; cùng key/cùng hash trả lại job cũ, cùng key/khác hash trả 409. Dùng chung quy tắc ở các render modes. Job queue trước staging hiện ở RAM nên còn cần xử lý crash mà không làm mất yêu cầu đã nhận.

### P2 Import cho phép tên cột trùng và ghi đè dữ liệu khi resolve

Nguồn: `../ZbrePrinter/app/data-feed.ts:103`, `:133`, `:270`; `app/reducer.ts:994`.

`feedFromMatrix()` tạo cột trực tiếp từ header. `feed/replaceAll` giữ nguyên các cột này. `evaluateRow()` trả về object keyed theo tên; hai cột cùng `epc` khiến giá trị cột sau ghi đè giá trị cột trước. Cột vẫn có ID riêng trong bảng, nên người dùng có thể tưởng chúng là hai nguồn độc lập.

Probe nhập hai cột `epc`, giá trị kết thúc 1675 và 1570: binding `epc` trả về 1570. Đây là sai nội dung trước khi vào queue, có thể bị nhầm là lỗi thứ tự in.

Sửa: validate header theo cùng quy tắc phân biệt hoa/thường với engine binding, chặn duplicate và tên reserved không rõ nghĩa; yêu cầu ánh xạ rõ trước chấp nhận data feed. Không tự đổi tên rồi âm thầm bind một cột khác. Cũng cần preflight công thức lỗi và lưu resolved row snapshot cho cả lô.

### P2 Lỗi tải ảnh bị bỏ qua khi tạo bitmap in

Nguồn: `../ZbrePrinter/app/full-page-raster.ts:397`.

`drawImageEl()` nuốt exception giải mã ảnh rồi tiếp tục. `renderLabelToBitmap()` trả bitmap hợp lệ nhưng thiếu ảnh. Điều này ảnh hưởng template có logo, ký hiệu hoặc mã đã nhập dưới dạng ảnh; receipt của job vẫn bình thường.

Sửa: phân biệt preview và production render. Print phải báo element ID/source và dừng trước dispatch khi asset bắt buộc không decode được. Preload toàn bộ ảnh/font, đóng băng asset theo hash cho một job. Google Fonts hiện được tải từ Internet trong `app/fonts.ts`; template dùng font đó không có bảo đảm hình thức ổn định khi chạy offline. Không coi font fallback là thiết kế đã được xác nhận.

### P2 Lưu template và session báo thành công dù storage thất bại

Nguồn: `../ZbrePrinter/app/storage.ts:237`, `:319`; `app/components/PrintStep.tsx:1403`.

Các hàm lưu nuốt lỗi localStorage, bao gồm quota exceeded. `onSaveTemplate` vẫn hiện Saved. Với data feed lớn, bitmap/custom font nhúng hoặc nhiều template, người dùng có thể in bằng trạng thái mới trong RAM nhưng lần mở sau nạp bản cũ. Điều này có thể đưa serial/range về dữ liệu cũ ngoài ý muốn.

Sửa: trả kết quả lưu cho UI, chỉ báo Saved khi ghi thành công; dùng lưu trữ transactional có version/backup và tách tài nguyên lớn. Parser `.nwl` hiện kiểm tra cấu trúc nông; cần schema validation và giới hạn tài nguyên để lỗi một template không làm hỏng cả collection lúc load.

Bằng chứng: probe ném `QuotaExceededError` từ `setItem`; hai hàm lưu vẫn trả về bình thường.

## Những phần hiện đã làm đúng

- Data range được tính theo index gốc, có hỗ trợ chiều giảm; không đảo dữ liệu nguồn để in ngược.
- Dữ liệu động được dựng tuần tự, mỗi tem một bitmap mới; text/bitmap và EPC dùng cùng `copyIndex`. Không thấy logic cố ý quay ngược tới dòng trước trong vòng lặp normal path.
- Tem động dùng `^PQ1`, EPC và hình nằm cùng format. Nhánh stored RFID format cũ có tên cố định hiện bị vô hiệu bằng `return false`; không coi đoạn code chết này là bằng chứng đang ghi đè format trong lô.
- TCP dùng một persistent socket cho job, sequence tăng, hash payload và checkpoint; phát lại HTTP cùng sequence không đồng nghĩa gửi lại byte ra socket. Partial/unknown write dừng và không tự tạo socket/job mới để resend.
- `~HQES` trước `~HS`, theo dõi Pause và backpressure, phân biệt transport receipt với physical completion. Cancel dừng producer, chờ write đang chạy, gửi `~JA` trên cùng socket và kiểm tra buffer rỗng.
- Windows RAW chụp snapshot, staging trên đĩa rồi commit một spool job; append/commit có dedup, kiểm tra hash và total bytes. Giữ reservation nếu spool outcome uncertain, kiểm tra queue spooling và printer pooling.
- `^RS` được phát với P/E, fallback P; tránh mặc định N làm bỏ format lỗi RFID. ZT610R có đường bank A để điều chỉnh PC length theo dữ liệu; ZD621R có xử lý model riêng. Các kiểm thử generator hiện có đều qua.
- Electron có single instance, worker ẩn, power blocker và quit guard. Các guard này giúp đóng ứng dụng bình thường, không thay thế persistent TCP job state khi renderer/process/máy tính hỏng.

## Vì sao vẫn chưa thể cam kết mỗi tem chỉ in một lần

Một sequence receipt chứng minh connector đã xử lý lần gửi đó. TCP write/ACK không xác nhận nội dung đã in, EPC đã ghi đúng, nhãn đã thoát khỏi cơ cấu hoặc được chấp nhận để sử dụng. `~HS` báo trạng thái/buffer và số lượng liên quan format, không mang row ID của mọi nhãn đã hoàn tất. Code hiện cũng ghi rõ giới hạn này.

Firmware có thể tự in lại độc lập với retry của app. Zebra mô tả `^JZY` in lại nhãn bị gián đoạn bởi media/ribbon/head-open và giá trị mặc định lúc bật nguồn là Y. Generator hiện không đặt chính sách `^JZ`. Chỉ chuyển sang `^JZN` không đủ: có thể bỏ mất tem đang in dở, nên cần chính sách loại bỏ/đối soát tem lỗi. [Zebra về reprint after error](https://cpws.zebra.com/cpws/docs/zpl/zpl_reprint.htm).

RFID retry có thể dùng nhiều nhãn vật lý cho một logical record và in VOID trên nhãn lỗi. `^RS` P/E giữ format khi hết số lần thử. Vì vậy số nhãn đã kéo qua đầu in không bằng số EPC hợp lệ; quét/đối chiếu phải phân biệt tem valid và VOID. Có thể dùng `^HV`/RFID log làm bằng chứng bổ sung, nhưng không suy ra chúng là xác nhận chất lượng mặt in hoặc một giao dịch exactly-once với ứng dụng. [Zebra RFID Programming Guide 3](https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/guide/software/rfid3-pg-en.pdf).

Nếu yêu cầu kinh doanh là không bao giờ đưa hai tem cùng định danh ra sử dụng, kiến trúc cần có bước xác minh đầu ra và loại bỏ tem lỗi: đọc EPC và quét barcode/text trên cùng tem, đối chiếu với manifest. Sau gián đoạn ở gần 1675, không tự lấy `lastSent + 1` hoặc chỉ nhìn một tem cuối rồi chọn điểm resume; phải xác định phần đã in hợp lệ, phần VOID và phần vẫn nằm trong buffer.

Chuỗi “1675 → 1570…1590 → 1676” chưa có log/ZPL tại thời điểm lỗi để kết luận nguyên nhân. Trong một TCP stream, tầng TCP không tự lấy lại một đoạn byte cũ và đưa lên ứng dụng lần hai. Các nhánh cần phân biệt là một job khác chen vào, request/lô cũ được gửi lại, dữ liệu dòng bị ghép sai, hoặc firmware/nguồn gửi khác. Nếu chỉ phần text nhảy mà EPC trên cùng tem vẫn tăng đúng, phải ưu tiên kiểm tra ghép bitmap–EPC, không gán ngay cho toàn bộ queue đảo thứ tự.

## Nâng giới hạn in

2.500 là policy của ứng dụng; không phải bằng chứng máy Zebra chỉ in được 2.500 tem trong một lô. Nó xuất hiện ở nhiều tầng:

| Tầng | Giới hạn hiện tại |
| --- | --- |
| `app/print-batch.ts:2` | 2.500 labels cho quantity/planning |
| `app/windows-raw-print.ts:79` | 2.500 labels khi tạo Windows batch |
| `app/raw-spool-batch.ts:95` | 2.500 labels ở client durable batch |
| Go `raw_spool_batch.go:21` | 2.500 labels; 1 GiB/batch; 2 GiB active payload, cần thêm chỗ khi assemble |
| Go `tcp_job.go:22` | 2.500 **checkpoint**, không phải labels; 1 GiB cumulative |
| Next `app/api/printer/tcp/job/session.ts:11` | 2.500 checkpoint cho đường server TCP |
| Browser print | 250 labels; đây là đường khác, không nên tăng cùng bulk TCP |

Ví dụ 50.000 tem RFID với 10 tem/chunk cần ít nhất 5.000 checkpoint, chưa kể khi byte budget giảm kích thước chunk. Nếu mỗi tem lớn cần một chunk, chỉ 2.501 tem đã vượt trần checkpoint. Ngay tại trần 2.500 checkpoint, Cancel dùng thêm một `append(~JA)` cũng cần chỗ dự phòng; không nên dùng cùng hạn mức dữ liệu để vô tình khóa command phục hồi.

Đề xuất rollout: nghiệm thu 10.000 trước, sau đó 50.000 trên từng template/model/DPI sau khi sửa P1. Đây là mục tiêu kiểm thử, không phải cam kết dung lượng. Trần thực tế dựa trên tổng byte, disk quota, thời gian, RAM renderer và checkpoint ledger.

- Một logical job giữ nguyên từ đầu đến cuối lô; có thể chia payload thành segment trên đĩa, nhưng không tạo các job độc lập để lách giới hạn.
- TCP giữ chunk theo byte budget, tối đa 10 tem RFID hoặc 25 tem động như hiện tại; giữ lookahead giới hạn. Tăng số lượng tổng không đòi hỏi tăng buffer máy in.
- Tách sequence/checkpoint capacity khỏi label quantity; dùng ledger có thể tăng trưởng trên đĩa, vẫn có giới hạn byte rõ ràng và dự phòng control commands.
- Validate toàn dataset và assets trước khi in. Staging file/hash đầy đủ trên đĩa cho TCP giúp phục hồi và điều tra; không cần giữ tất cả bitmap trong RAM.
- Không dựng hàng chục nghìn canvas preview, không dùng localStorage chứa bản sao toàn bộ job history. Virtualize data feed, tránh autosave synchronous lượng JSON lớn trong lúc streaming.
- Capability/version handshake phải cho biết hạn mức; nâng client và connector cùng release, tránh UI nhận 50.000 rồi lỗi giữa lô vì connector cũ.

## Kiến trúc đề xuất cho đường TCP chính

Một service connector là chủ sở hữu job, UI chỉ tạo yêu cầu và theo dõi. Job gồm ID cố định, stable printer ID, model/DPI/firmware, phiên bản template, snapshot dữ liệu và asset hash; mỗi row có ordinal và định danh nghiệp vụ rõ ràng. Không mặc định mọi text/SKU phải unique; đánh dấu đúng trường serial/EPC nào bắt buộc unique.

Luồng trạng thái đề xuất:

```text
preflight → staged → queued → dispatching → transport accepted → draining
                                  ↘ uncertain → reconciliation
draining → completed unverified → verified (khi có bằng chứng đầu ra)
```

1. Admission transaction kiểm tra idempotency và overlap định danh/phạm vi, rồi persist job.
2. Reserve một lease cho toàn máy vật lý. Hai model khác nhau được chạy song song; cùng máy chỉ một job.
3. Persist chunk intent trước write, receipt sau write. Lỗi sau intent không được tự cho là not-sent.
4. Worker có vòng đọc liên tục và parser phân loại status/RFID response theo frame. Nếu bổ sung `^HV`, phải thay đổi parser có chủ đích: query parser hiện tại không được mặc nhiên nhận thêm unsolicited replies như thể vẫn là `~HS` thuần.
5. Drain chỉ đóng transport phase. Xác minh barcode/EPC/VOID đưa job vào verified; không hiển thị một con số sent như physical completed.
6. Reconciliation lưu người xác nhận, phạm vi đã kiểm tra, tem lỗi/đã hủy, căn cứ resume và quan hệ với job mới. Không dùng một audit note cố định để thay thế dữ liệu đối soát.

Windows USB giữ staging một spool document; Windows có thể quản lý/retry job sau khi app đã ghi đủ byte, nên app cần trình bày trạng thái accepted/unverified chính xác. Không cho đổi từ TCP sang USB để vượt quarantine của cùng thiết bị.

## Nghiệm thu bắt buộc sau sửa

Ma trận chạy riêng trên ZT610R và ZD621R, đúng DPI và cuộn inlay đang sử dụng. Mỗi tem xác minh text/barcode–EPC trên cùng vật thể, giữ thứ tự và ghi riêng VOID. Tiêu chí nghiệm thu là định danh hợp lệ không trùng, không thiếu, không sai cặp; không chỉ đếm số format hoặc bytes.

- Dải tăng 1 → 2500, 1 → 10000 và 1 → 50000 khi đủ tài nguyên; dải giảm và range không bắt đầu từ 1.
- Chèn lỗi quanh 1569/1570/1590/1675/1676, ở biên chunk và chunk cuối.
- Mất phản hồi HTTP sau append nhưng socket vẫn sống: retry cùng ID chỉ trả receipt, không write lại.
- Cắt mạng sau một phần write; restart app, renderer, connector và printer; đợi quá một giờ: target vẫn blocked cho tới đối soát.
- Pause/Resume, hết giấy, mở đầu in, ribbon out, RFID encode failure/VOID; Cancel khi đang write và khi queued.
- Print → Edit → Print; mở cửa sổ khác; gửi qua IP/hostname và TCP/Windows cùng máy.
- EPC trống, trùng, quá dài, non-ASCII, duplicate headers, công thức lỗi, ảnh hỏng và storage đầy phải bị phát hiện trước khi có output sai.
- USB: spooler offline/restart, job còn tồn tại, StartDoc/WritePrinter/EndDoc failures và journal write failures.

Số `10.6.26.28275` người dùng cung cấp là **ZDesigner Windows Printer Driver V10**, không phải phiên bản firmware của hai máy. Zebra phân biệt nó với Link-OS trong [tài liệu chính thức về driver diagnostics](https://support.zebra.com/article/000036105). Cần lưu Printer OS/Link-OS và RFID reader firmware thực tế trong biên bản nghiệm thu; chưa dùng thông tin driver để xác nhận khả năng hỗ trợ lệnh của firmware.

## Bằng chứng kiểm thử trong round này

| Kiểm thử | Kết quả |
| --- | --- |
| Desktop `npm test` | 10/10 pass |
| Web các scripts `test:*` | 21/21 nhóm pass |
| Web `npm run typecheck` | Pass |
| Go `go test -count=1 ./...` | Pass, không dùng test cache |
| Desktop `npm run verify:bundle` | Pass cho web 3.1.9 và connector 0.5.2; bundle hiện unsigned, chế độ development |
| `test:spool-ui` | 2.500 cặp bitmap/text–EPC đúng thứ tự; 250 chunk; một Windows job giả |
| `test:tcp-pause-ui` | 51 tem regression Pause, 450 tem giảm liên tục, 501 cặp bitmap–EPC; không duplicate trong mô phỏng |
| `test:tcp-cancel-ui` | Lô 2.000, mô phỏng đã in 400/gửi 430; các tình huống cancel, pending write, clear failure pass |
| `audit-probes.cjs` | Tái hiện ASCII collision, blank EPC TCP, duplicate header và silent save failure |
| `audit-navigation-ui.cjs` | Tái hiện activeJobs=1 nhưng UI mới bật Print 2500 và mất Cancel |
| Go overlay `TestReview*` | 3/3 test an toàn mới fail: quarantine expiry, partial-job lease, target alias |

Các test mới cố ý giữ yêu cầu an toàn nên Go FAIL là bằng chứng lỗi chưa sửa, không phải lỗi cài môi trường. JS probes thì PASS khi tái hiện được hành vi chưa an toàn, không phải PASS nghiệm thu sản phẩm. Test UI dùng fake connector, không kiểm tra firmware hay cuộn tem vật lý.

Source desktop HEAD `2b6948c368d5ce9d50652dfad9499b9aa856634d`; web HEAD `6d2a4a616f21fd581f230c8e5aacc5687d52dfe2`; cả hai có thay đổi chưa commit. Manifest bundle ghi web dirty, nên commit SHA một mình không định danh đầy đủ binary.

Các lệnh tái hiện bổ sung chạy từ `ZbrePrinter-App`:

```powershell
node build/review-2026-10-13/audit-probes.cjs
& .\node_modules\.bin\electron.cmd build/review-2026-10-13/audit-navigation-ui.cjs
& ..\ZbrePrinter\tmp\go1.26.5-toolchain\go\bin\go.exe -C ..\ZbrePrinter\native\local_print_agent_go test -overlay "$((Get-Location).Path)\build\review-2026-10-13\go-overlay.json" -run TestReview -count=1 -v
```

Go overlay ánh xạ file test audit vào package để test private functions; không thêm hoặc sửa file trong source connector. Overlay dùng đường dẫn tuyệt đối của workspace này, cần tạo lại nếu chuyển checkout.
