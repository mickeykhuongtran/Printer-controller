# Revised — ZbrePrinter 3.1.6

Ngày cập nhật: 2026-09-13. Local Print Connector giữ nguyên **0.5.2**.

## Pause khác Cancel

- **Pause → Resume trên máy in**: giữ nguyên lô, giữ thứ tự; ứng dụng chờ và
  tiếp tục các tem chưa gửi. Không xóa buffer, không gửi lại các tem trước.
- **Pause → Cancel batch trong app**: hủy phần còn lại của lô TCP. Ngừng dựng/
  cấp chunk mới, chờ lượt truyền hoặc đọc trạng thái đang chạy kết thúc, rồi
  gửi `~JA` trên chính socket của job. Không mở socket thứ hai để đua với dữ liệu cũ.
- Nếu đã giữ X trên máy in, vẫn bấm **Cancel batch trong app** để bỏ hàng đợi
  chưa gửi. Buffer máy in trống không được dùng để tự suy đoán người dùng đã hủy.
- Giữ nguyên Pause sau khi hủy, không phát `~PS`/Resume. Sau thông báo
  **Batch cancelled**, chọn cấu hình/dải mới rồi in; Resume không hồi sinh lô cũ.

## Xác nhận hủy và lỗi

Lệnh clear là một append có checkpoint; retry HTTP dùng cùng job/sequence,
không tạo lại một lô hoặc gửi lại dữ liệu tem. Ứng dụng đọc `~HS` ngay cả khi
máy in đang Pause, yêu cầu hai phản hồi buffer rỗng liên tiếp, rồi đóng
transport. “Cancelled” không có nghĩa 2.000 tem đã in; các tem đã in không
thể thu hồi. Chọn dải mới theo số tem/EPC thực tế cần giữ hoặc in lại.

Nếu mất kết nối, phản hồi sai hoặc buffer chưa rỗng: ngừng gửi và đóng
socket; không báo đã hủy sạch, khóa nút in mới cho đến khi xử lý job dừng.
Giữ máy in Pause, **sau khi app đã báo ngừng gửi** giữ CANCEL (X) hai giây
để xóa buffer; kiểm tra tem/EPC và bấm nút xác nhận đã kiểm tra để đóng job.
Thông tin phục hồi phân biệt lỗi thường với yêu cầu Cancel, kể cả qua reload.

Nếu Cancel khi đang chờ đến lượt, dựng tem đầu hoặc mở kết nối, chưa có
tem nào được gửi thì chỉ bỏ yêu cầu này; không gửi lệnh xóa buffer của job khác.
Cancel bị khóa tại ranh giới finish để không gán nhầm job đã hoàn tất thành
job vừa hủy. Windows USB/spooler vẫn hủy bằng Windows Print Queue.

## Kiểm chứng

Thêm `test:print-cancel`: hủy khi đang dựng, truyền, đọc trạng thái/Pause,
chờ FIFO; chờ lượt I/O kết thúc trước clear; kiểm tra buffer khi Pause;
buffer không rỗng/mất kết nối không được coi là hủy thành công; ranh giới finish.

Thêm renderer test `test:tcp-cancel-ui` với lô 2.000 tem, mô phỏng đã in 400:
giữ X trước Cancel trong app, giữ Pause sau hủy, không gửi tiếp lô cũ khi
Resume, in dải mới 401–410; hủy giữa lượt truyền, trước tem đầu, và lỗi clear.
Kiểm thử giả lập không in phần cứng; vẫn cần nghiệm thu trên ZD621R thật.

Tham chiếu Zebra: [CANCEL/Pause](https://docs.zebra.com/us/en/printers/desktop/zd421-and-zd621-desktop-printers-user-guide/controls-and-indicators/standard-interface-controls.html),
[`~JA` — Cancel All](https://docs.zebra.com/us/en/printers/software/zpl-pg/advanced-techniques/cancel-clear-commands.html).

---

# Revised — ZbrePrinter 3.1.5

Ngày cập nhật: 2026-09-13. Local Print Connector giữ nguyên **0.5.2**.

## Giao diện in đơn giản

- Chọn kết nối và máy in ngay trong Print. **Windows printer (recommended)**
  dùng cho cả USB và Ethernet qua máy in ZPL đã cài trong Windows.
- Danh sách tự tải kể cả khi chưa chọn máy in; có Refresh và hướng dẫn thêm
  máy in. Không tự thay máy in đã lưu bằng máy in mặc định/đầu tiên khác.
- Trạng thái thông thường chỉ hiện tiến độ chuẩn bị và số tem đã vào queue.
  Lịch sử nằm dưới nút in, mặc định thu gọn; không tự mở khi đang chuẩn bị
  hoặc Windows đang nhận job. ID và checkpoint nằm trong Technical details.
- Bỏ form TCP thường trực yêu cầu job ID, ghi chú và checkbox. Chỉ sau lỗi
  thật mới hiện hướng xử lý và một nút xác nhận đã kiểm tra tem/queue.
  Ứng dụng tự nhớ job lỗi theo địa chỉ máy in và connector qua lần tải lại.
- URL connector và lựa chọn nơi thực thi TCP nằm trong Advanced connection
  settings của Target printer.

## Trách nhiệm hàng đợi và độ chính xác

Windows RAW vẫn dựng toàn bộ dải, lưu các phần theo sequence rồi commit
**một job Windows duy nhất**. Các chunk là đơn vị chuẩn bị/truyền nội bộ,
không phải những job Windows riêng. Giữ nguyên snapshot dữ liệu và cặp
bitmap chứa text + lệnh ghi EPC trong từng format ZPL độc lập.

Windows spooler cùng driver/port monitor điều tiết việc giao dữ liệu cho
máy in khi thiết bị bận. Pause/Resume thực hiện trên máy in. Ứng dụng không
tự gửi lại một job có kết quả chưa rõ và không báo “đã in xong” chỉ vì
Windows nhận dữ liệu. Lịch sử phục hồi vẫn kiểm tra trạng thái connector,
Windows job và checkpoint; nút xác nhận không gửi lại tem.

Direct TCP/IP giữ luồng socket/checkpoint/Pause của 3.1.4 và đi trực tiếp
tới máy in, không qua Windows spooler. Không tự đổi một cấu hình TCP cũ
sang queue USB hoặc đổi port của máy in Windows đã cài.

## Thiết lập sử dụng

1. Cài driver Zebra ZPL đúng model/DPI trong Windows.
2. USB: chọn queue Zebra tương ứng. Ethernet: thêm máy in Windows bằng
   Standard TCP/IP port, RAW 9100 (hoặc port RAW thực tế trên máy in);
   máy tính phải truy cập được IP đó. Không dùng queue USB cho dây Ethernet.
3. Trong Print chọn Windows printer → tên queue → dải From–To → Print.
   Có thể theo dõi job trong Windows Print Queue.

Tham chiếu: [Microsoft — gửi một job RAW](https://learn.microsoft.com/en-us/windows/win32/printdocs/sending-data-directly-to-a-printer),
[Zebra — cổng in RAW](https://supportcommunity.zebra.com/articles/en_US/Knowledge/Changing-the-printer-IP-port-to-9100-or-others).

## Kiểm chứng

Bộ kiểm thử gồm TypeScript/lint, durable spool, thứ tự From–To, ZPL/RFID;
renderer đóng gói đối chiếu text/bitmap–EPC với 2.500 tem tăng, 601 tem giảm,
TCP 51 + 450 tem và 240 bản tĩnh. Kiểm tra thêm chọn queue USB/Ethernet
ngay tại Print, không tự chọn máy in PDF mặc định, lịch sử thu gọn, phục hồi
TCP sau tải lại không nhập ID và không gửi lặp. Các ca tự động dùng connector
giả lập, không in phần cứng; nghiệm thu tag thật trên ZD621R vẫn cần thực hiện.

---

# Revised — ZbrePrinter 3.1.4

Ngày cập nhật: 2026-09-13. Local Print Connector: **0.5.2**.

## Hiện tượng và nguyên nhân

Dải **2449 → 2000** gồm 450 nhãn bị ngắt nhịp sau mỗi khoảng 10 tag.
Phiên bản 3.1.3 chia RFID thành checkpoint tối đa 10 nhãn, chờ bộ đệm máy
in trống hoàn toàn sau mỗi checkpoint, rồi mới dựng ảnh cho chunk kế tiếp.
Mỗi truy vấn trạng thái còn chờ hết khoảng im lặng 1.000 ms dù phản hồi đã
đầy đủ. Hai truy vấn HQES và HS tạo thêm khoảng chờ trong mỗi lượt kiểm tra.

## Luồng TCP sau cập nhật

- Giữ một job, một socket TCP và checkpoint tuần tự. Một checkpoint nhỏ
  không còn tương ứng với một lần dừng để in hết nhãn của checkpoint đó.
- Dựng trước tối đa 4 chunk / 1 MiB trong hàng đợi ứng dụng, đồng thời gửi
  và kiểm tra trạng thái. Ngoài hàng đợi có tối đa một chunk đang dựng/giữ
  chờ chỗ và một chunk đang gửi. Một nhãn lớn được xử lý riêng trong giới
  hạn payload hiện có; không dựng toàn bộ hàng nghìn nhãn vào RAM.
- Sau mỗi append, đọc HQES và HS trên cùng socket. Khi còn chỗ trong bộ
  đệm, gửi tiếp mà không yêu cầu số format/nhãn còn lại phải bằng 0.
- Với nhãn động, ngân sách phần mềm tối đa 40 format, giảm theo ước lượng
  kích thước ảnh nhãn trên ngân sách 2 MiB. Chunk RFID vẫn tối đa 10 nhãn
  và mục tiêu 256 KiB; chunk được giảm khi nhãn lớn. Chừa chỗ cho cả chunk
  kế tiếp, chờ khi buffer-full hoặc có partial format. Đây là giới hạn
  bảo thủ của ứng dụng, không phải phép đo dung lượng RAM còn trống của máy.
- Nhãn tĩnh giữ các cửa sổ lặp PQ 100 bản; cho phép cấp tiếp khi còn tối đa
  một format chờ trong receive buffer. Số bản PQ không đồng nghĩa số format.
- Poll lúc chờ chỗ khoảng 100 ms, lúc chờ cuối job khoảng 250 ms; Pause
  vẫn poll tối thiểu 1 giây. Thời gian truyền/đọc thực tế cộng vào các khoảng này.
- Chỉ kết thúc job sau bước drain cuối: không còn format, partial format,
  buffer-full, bản in còn lại hoặc nhãn đang chờ lấy theo trạng thái HS.
- Connector Go và server TCP Node trả ngay khi nhận đủ khung HQES hoặc đủ
  ba khung HS (kể cả phản hồi TCP bị chia nhỏ). Timeout vẫn áp dụng cho
  phản hồi thiếu; truy vấn legacy không có khung giữ cách chờ idle hiện có.

## Pause, lỗi và đối soát

Pause giữ job và dữ liệu đã đệm. Khi đã quan sát thấy Pause, ứng dụng giữ
các chunk chưa gửi, tiếp tục hỏi trạng thái và chờ người vận hành Resume.
Không phát lại checkpoint và không tự gửi lệnh Resume. Sau Resume, ứng
dụng tiếp tục cấp dữ liệu theo dung lượng bộ đệm, không ép bộ đệm về 0.
Pause vẫn không tính vào timeout hoạt động. Pause xuất hiện sau một lần
kiểm tra có thể trùng với chunk đang truyền; dữ liệu đó vẫn thuộc job hiện tại.

Do nhiều chunk có thể cùng nằm trong máy in, lỗi phải đối soát **toàn bộ
phần đã gửi**, kể cả các chunk trước chunk báo lỗi. Thông báo giờ ghi rõ
các dải trước đó cũng chưa xác minh hoàn tất vật lý. Nếu dựng nhãn thất bại,
ứng dụng ngừng producer, đợi thao tác đang gửi kết thúc, bỏ các chunk còn
trong RAM và chỉ rõ nhãn đầu tiên chưa gửi. Không tự suy ra EPC đã ghi
thành công từ byte count, checkpoint hoặc trạng thái bộ đệm trống.

COM giữ cách chờ hoàn tất theo chunk; Windows RAW giữ luồng staging/spool.

## Kiểm tra và nghiệm thu

Kiểm thử tự động bao gồm:

- Dải 450 số giảm dần, 45 checkpoint, 44 lần cấp tiếp khi bộ đệm vẫn còn
  nhãn; giới hạn buffer, đúng thứ tự, không trùng, drain cuối job.
- Pause/Resume khi nhiều format đã đệm; Pause ở chunk cuối; mất mạng và
  đối soát cả các chunk đã gửi trước lỗi.
- Producer/consumer bị lỗi, giới hạn lookahead, payload lớn, đóng producer
  và chờ thao tác đang chạy; không gửi lại dữ liệu đã nhận.
- Phản hồi HS chia nhỏ từng byte, không trả sớm trước đủ ba khung; hai lần
  đọc liên tiếp giữ một socket và hoàn tất trước read-idle timeout.
- Typecheck, lint mã thay đổi, bộ test TCP/status/print, Go test/vet,
  desktop tests, kiểm tra bundle và runtime đã đóng gói.

Bài kiểm thử renderer dùng connector giả trên loopback, chặn endpoint in
thật. Kết quả: `build/tcp-pause-qa/result.json`; ZPL và ảnh kiểm tra nằm
cùng thư mục. Mô phỏng xác nhận ứng dụng bỏ rào cản drain giữa các chunk;
không phải phép đo tốc độ cơ khí/RFID trên ZD621R thật.

Bộ cài: `dist/ZbrePrinter-App-Setup-3.1.4-x64.exe`. Desktop yêu cầu connector
**0.5.2** để dùng cơ chế đọc trạng thái nhanh. Cài khi job hiện tại đã xử lý
xong; đóng ứng dụng cũ trước khi cập nhật. Sau cài, nghiệm thu một dải nhãn
mới, theo dõi nhịp qua ranh giới chunk, thử Pause/Resume và đọc lại EPC.
Tốc độ thực tế còn phụ thuộc thời gian render, mạng, tốc độ in, cơ chế
peel/cut, hiệu chỉnh RFID và retry/VOID của máy. Không dùng bản cập nhật
để phát lại một dải chưa được đối soát.

---

## Lịch sử 3.1.3

Phần dưới ghi lại hành vi của 3.1.3; các mô tả chờ drain sau từng chunk TCP
đã được thay thế bởi luồng 3.1.4 ở trên.


# Revised — ZbrePrinter 3.1.3

Ngày cập nhật: 2026-09-13. Local Print Connector: **0.5.1**.

## Vấn đề đã sửa

Khi in DataFeed từ **2500 → 2450** (51 nhãn), người vận hành bấm Pause
trên ZD621R để kiểm tra. Bản 3.1.2 coi trạng thái Pause là lỗi trong bước
kiểm tra sau khi gửi chunk, gọi `abort()` và đóng phiên TCP. Nếu lỗi xuất hiện
ở chunk **2480 → 2471**, phần **2470 → 2450** chưa được gửi. Bấm Resume trên
máy in không thể khôi phục phần ứng dụng đã ngừng gửi.

## Hành vi sau cập nhật

- Pause là trạng thái chờ. Ứng dụng giữ job, kết nối TCP và vị trí trong hàng
  đợi của máy in; nút Print vẫn bị khóa trong khi job đang chạy hoặc Pause.
- Giao diện hiển thị `Printer paused — waiting for Resume on the printer`,
  kèm dải nhãn đã gửi. Ứng dụng không tự phát lệnh Resume.
- Trong khi Pause, ứng dụng tiếp tục hỏi trạng thái trên cùng phiên TCP.
  Các truy vấn thành công duy trì hoạt động của phiên connector.
- Sau khi người vận hành Resume, ứng dụng chờ máy xử lý hết dữ liệu của
  chunk hiện tại rồi gửi chunk tiếp theo; không phát lại chunk đã gửi.
- Pause ở chunk cuối vẫn phải chờ Resume và bộ đệm được xử lý xong trước khi
  kết thúc job. Pause nhiều lần trong cùng một job được hỗ trợ.
- Timeout chờ xử lý là **30 phút hoạt động cho mỗi chunk**, không tính các
  khoảng Pause được quan sát. Pause không xóa thời gian hoạt động đã tích lũy.
  Thời gian chờ phản hồi mạng vẫn có giới hạn; mất kết nối không được coi là Pause.
- Bộ phân tích nhận diện Pause qua bit `0x00010000` của `~HQES` và cờ Pause
  của `~HS`. Pause đi kèm lỗi thật, như đầu in mở hoặc hết media, vẫn dừng job
  để người vận hành xử lý; không tự bỏ qua lỗi.
- TCP và COM dùng chung cơ chế chờ. Quy trình Windows RAW giữ cách spool
  hiện có.

## Thông báo lỗi và đối soát

Nếu payload đã được chấp nhận qua TCP nhưng bước đọc trạng thái thất bại,
thông báo chỉ rõ chunk đó **đã gửi nhưng chưa xác minh hoàn tất vật lý** và
các chunk sau chưa gửi. Phần mềm không khẳng định số nhãn/EPC vật lý chỉ từ
biên nhận truyền dữ liệu.

Trong phần TCP/IP có mục **Reconcile a stopped TCP job**:

1. Cho máy xử lý xong dữ liệu còn trong bộ đệm; đối chiếu nhãn in, nhãn VOID
   và EPC. Xác định hàng cuối hợp lệ và dải cần in bổ sung.
2. Nhập job ID từ thông báo lỗi (job lỗi vừa xảy ra được điền sẵn) và ghi chú
   kết quả đối soát, gồm dải đã xác minh và dải còn lại.
3. Đánh dấu xác nhận đã kiểm tra nhãn/EPC và máy không còn nhãn chờ của job đó.
4. Chọn **Confirm reconciliation**. Thao tác chỉ ghi nhận đối soát và cho
   phép job mới; không in, không phát lại dữ liệu và không khôi phục job cũ.
5. Chọn đúng dải còn thiếu rồi chủ động tạo job mới. Ví dụ, chỉ khi đã xác
   minh đủ **2500 → 2471**, dải bổ sung mới là **2470 → 2450** (21 nhãn).

Connector xác minh chủ sở hữu, trạng thái đã dừng và checkpoint của job.
Job đang hoạt động hoặc checkpoint không khớp bị từ chối. Trạng thái lỗi và
biên nhận cũ được giữ lại; đối soát không chuyển chúng thành “đã in thành công”.
Server TCP cục bộ hỗ trợ cùng quy tắc đối soát.

## Cài đặt và giới hạn

- Bộ cài: `dist/ZbrePrinter-App-Setup-3.1.3-x64.exe`.
- Đóng ứng dụng cũ sau khi đã xử lý/đối soát công việc đang tồn tại, rồi cài
  bản mới. Bản desktop yêu cầu connector từ **0.5.1**; connector cũ còn chiếm
  cổng 17917 sẽ không được tái sử dụng.
- Job đã bị abort bởi 3.1.2 không tự sống lại sau cập nhật. Cần đối soát
  vật lý trước khi chọn dải in bổ sung.
- Lịch sử TCP và ghi chú đối soát hiện nằm trong bộ nhớ connector/server,
  theo thời hạn lưu bản ghi hiện có (một giờ sau khi job kết thúc); không phải
  nhật ký bền vững qua restart. Không dùng restart để suy luận rằng máy chưa in.
- Giữ ứng dụng và máy tính hoạt động trong lúc Pause. Không bảo đảm tiếp tục
  sau khi mất điện, đóng cưỡng bức ứng dụng, sleep máy tính hoặc mất kết nối.
- Trạng thái bộ đệm không thay thế việc kiểm tra nhãn/EPC thực tế.

## Kiểm thử

- Unit test: Pause qua HQES và HS; Pause lâu hơn timeout hoạt động; Pause lặp
  lại; lỗi thật kèm Pause; mất kết nối; cảnh báo; chờ chunk cuối sau Resume.
- TCP client/server và Go connector: giữ checkpoint, từ chối đối soát khi
  thiếu xác nhận/sai checkpoint/sai chủ sở hữu/job đang chạy; đối soát lặp lại
  không phát lại dữ liệu; giữ bằng chứng lỗi và mở lại quyền tạo job mới.
- Kiểm thử renderer đã đóng gói: 51 EPC theo thứ tự **2500 → 2450**, Pause
  ở chunk 3 và chunk cuối; không gửi thêm lúc Pause; chờ drain sau Resume;
  một job, sáu chunk, không trùng EPC; lỗi truy vấn và xác nhận đối soát qua UI.
- Kiểm thử renderer dùng connector giả trên loopback và chặn mọi endpoint
  in thật. Kết quả nằm trong `build/tcp-pause-qa/result.json` và ảnh kiểm tra.
- Chạy typecheck, ESLint cho mã thay đổi, desktop tests, kiểm tra SHA-256
  bundle và kiểm tra runtime sau đóng gói.

Chưa nghiệm thu thao tác Pause/Resume trên nhãn thật của ZD621R trong lượt
cập nhật này. Khi nghiệm thu phần cứng, dùng một lô nhỏ, kiểm tra đủ thứ tự,
không trùng/thiếu và đọc lại EPC sau các lần Pause/Resume.
