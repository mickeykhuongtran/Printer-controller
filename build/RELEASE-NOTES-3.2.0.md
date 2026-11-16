# ZbrePrinter 3.2.0

Ngày 14 tháng 10 năm 2026. Desktop/web 3.2.0, Local Print Connector 0.6.1.

## In lô lớn

TCP và Windows RAW không còn trần 2.500 tem. Giới hạn 2.500 checkpoint TCP
cũng được bỏ ở connector và Next server. Quantity phải là số nguyên dương
biểu diễn chính xác bằng JavaScript; không thay trần 2.500 bằng một trần tem
10.000 hoặc 50.000 khác.

App vẫn giữ chunk nhỏ, render trước có giới hạn và một consumer gửi tuần tự.
Các cửa sổ in lặp được lập kế hoạch từng phần để không cấp phát mảng theo toàn
bộ số lượng. Windows tiếp tục staging rồi gửi một spool document cho cả lô.
Các hạn mức tài nguyên vẫn còn: TCP/Windows tối đa 1 GiB payload mỗi job,
Windows tối đa 2 GiB active staged payload; browser/PDF printing là đường riêng.
Cancel TCP có 64 KiB dự phòng điều khiển để vẫn xóa buffer khi chạm trần dữ liệu.

## Gửi chunk và điều khiển máy in

- Connector giữ lease của endpoint IP/port từ open đến finish hoặc đối soát lỗi,
  thay vì nhả sau mỗi chunk. Request TCP khác không được chen format vào job.
- Status, Pause và Resume của endpoint đang in dùng cùng socket với job hiện hành;
  Cancel tiếp tục dừng producer rồi gửi `~JA` sau write đang chạy.
- Client tuần tự hóa các thao tác và chụp payload trước khi xếp hàng. Một append
  thất bại chặn các append đang đợi phía sau; không tạo job mới để gửi lại.
- Sequence, SHA-256, receipt đủ byte và final checkpoint tiếp tục được kiểm tra.
- Không cho rời màn hình Print bằng Edit/step/back trong khi job đang chạy, để
  tránh mất Cancel hoặc bật thêm một lượt Print do component bị remount.
- Record TCP chưa đối soát không tự hết hạn sau một giờ. TCP checkpoints vẫn
  nằm trong RAM; điều này chưa phải cơ chế tự phục hồi một job qua restart.

Lease hiện theo endpoint được cấu hình. Không tự hợp nhất hostname, IP và USB
thành serial của cùng máy; nên dùng nhất quán một endpoint trong phiên vận hành.

## Lưu EPC được đọc từ từng tem

1. Chọn TCP và nhập IP máy Zebra. Bản desktop sử dụng local connector đi kèm.
2. Trong RFID, bật **Read RFID**, chọn **Bank → EPC**, **EPC length → From PC bits**.
3. Đặt Text là `{rfid_read}` hoặc bind tới tên **Template field** đã chọn.
4. Bật **Save read data to host** trong phần RFID hoặc tại màn hình Print.
5. Nhập số tem/range rồi Print. Mở **RFID session history → Download CSV** sau phiên.

CSV tải về có tên `YYYY-MM-DD_HH-mm-ss_epc_Read_<mã phiên ngắn>.csv`, ví dụ
`2026-10-14_14-35-08_epc_Read_a31b9c24d507.csv`. Ngày giờ là thời điểm bắt đầu
phiên theo giờ địa phương trên máy tính, không phải thời điểm tải file. Mã ngắn
gồm 12 ký tự HEX được suy ra từ mã phiên để phân biệt các phiên cùng giây.
Nếu đọc TID thì tên dùng `tid_Read`. Quy tắc này cũng áp dụng khi tải lịch sử
cũ; file thô trong thư mục lưu trữ vẫn là `reads.csv`. Phiên mới khi đóng
còn tự lưu một CSV tổng hợp với cùng tên ngày giờ này trong thư mục phiên.

Với 2.500 phản hồi hợp lệ, báo cáo có hàng tiêu đề, 2.500 dòng readback,
một dòng tổng VOID và một dòng tổng kết phiên. `record_type` phân biệt
`readback`, `batch_void_total`, `session_summary` và các dòng cảnh báo.
`ordinal` định danh thứ tự gửi; `source_row` giữ số dòng gốc, kể cả khi in
range giảm. CSV giữ thứ tự nhận thực tế để phát hiện phản hồi đảo thứ tự.
Khi mở bằng Excel, import `data_hex` dưới dạng Text để giữ số 0 đầu chuỗi.

`host_time` dùng giờ địa phương của máy chạy connector, định dạng
`YYYY-MM-DD HH:mm:ss.SSS`; `host_utc_offset` ghi múi giờ và
`received_at_utc` giữ thời gian UTC gốc. Ví dụ `2026-10-14T02:44:00.6128408Z`
tương ứng `2026-10-14 09:44:00.612`, múi giờ `+07:00`. Thời gian mỗi readback
là lúc host nhận phản hồi, không phải thời điểm cơ khí chính xác tem ra máy.
Giờ của dòng tổng kết là lúc lấy số đo cuối, không phải thời điểm từng VOID.

Giá trị host nhận lấy từ cùng `^FN1` mà `^RFR` đã đọc cho mặt in. Text có thể
chỉ hiển thị Last N characters, còn CSV vẫn lưu toàn bộ giá trị đọc. Ở chế độ
Fixed range, đó là toàn bộ phạm vi đã cấu hình, không tự mở rộng sang toàn EPC.
Giá trị read được cung cấp từ data feed không ghi đè giá trị đọc từ máy khi
capture đang bật. TID cũng dùng được nếu chọn ngân hàng TID.

Mỗi format in một tem (`^PQ1`), với header host verification chứa UUID phiên và
ordinal. Connector liên tục đọc socket, tách frame RFID khỏi status và đồng bộ
mỗi dòng CSV xuống đĩa. File vẫn tồn tại khi đóng hoặc khởi động lại app.

`complete` ở phiên mới yêu cầu đủ phản hồi hợp lệ, đúng ordinal, không trùng
ordinal/dữ liệu và số đếm đối soát khớp. Nó không chứng nhận chất lượng mặt in.
Thiếu phản hồi, đọc sai độ dài cố định, giá trị lỗi, phản hồi lặp hoặc mất kết nối làm phiên thành
`incomplete`/`interrupted`; file giữ các phản hồi đã nhận, không thêm EPC giả
để đủ số lượng và không tự in lại phần thiếu. Các phản hồi lặp được giữ trong
CSV với marker, không bị xóa âm thầm. Sau Cancel, CSV giữ phần đã nhận và phiên
có trạng thái `cancelled`. Khi kết thúc, connector thu nốt phản hồi đến muộn
trong khoảng chờ có giới hạn rồi kiểm tra lại tổng kết trước khi nhả máy in.

Lịch sử chỉ hiển thị **phiên mới nhất**. **Clear view** ẩn thẻ hiện tại và nhớ
lựa chọn qua lần mở app sau; **Show latest** hiện lại. Phiên mới tự xuất hiện.
Các thao tác này không xóa hoặc sửa file đã lưu.

Lịch sử desktop nằm tại `%APPDATA%\ZbrePrinter\connector\rfid-sessions\<session-key>\`.
`reads.csv` là phản hồi thô, `YYYY-MM-DD_HH-mm-ss_epc_Read_<mã>.csv` là báo cáo
tổng hợp tự tạo khi đóng phiên; `manifest.json` lưu template, máy, range và
các số đếm trước/sau. Nếu connector bị tắt đột ngột, `reads.csv` vẫn giữ các dòng
đã sync; Download CSV dựng báo cáo gián đoạn và không giả định số đếm cuối.
Connector chạy độc lập dùng thư mục `rfid-sessions` cạnh pairing state file.
Mỗi CSV có ngân sách 128 MiB; lỗi ghi đĩa làm dừng phiên thay vì báo lưu thành công.

Thu phản hồi và đối soát theo phiên hỗ trợ **TCP qua Local Print Connector 0.6.1**.
Windows RAW/USB, COM và API Windows browser-listener chưa thu các phản hồi này;
template bật capture bị chặn ở những đường in đó. Tắt tùy chọn nếu chỉ muốn in
qua các đường này. Lịch sử đã lưu vẫn có thể tải lại từ connector.

## Đối soát tổng phiên, giữ tốc độ theo chunk

Theo lựa chọn của người vận hành, app giữ chunk RFID tối đa 10 format và pipeline
có giới hạn. Không chuyển sang giao thức gửi một tem rồi chờ xác nhận từng tem.
App chờ buffer trống trước phiên, đọc ba bộ đếm bằng SGD `getvar`, rồi lấy lại
sau khi gửi hết và buffer được kiểm tra trống:

- `odometer.rfid.valid_resettable`: số RFID valid.
- `odometer.rfid.void_resettable`: số RFID VOID.
- `odometer.total_label_count`: số tem máy đã ghi nhận.

Không gửi `setvar`, không reset bộ đếm máy. Báo cáo lưu chênh lệch trong
`printer_valid_delta`, `printer_void_delta`, `printer_total_delta`.
`MATCHED` yêu cầu valid tăng bằng số tem yêu cầu, tổng tem tăng bằng valid + VOID,
đồng thời readback đủ và không có lỗi. Sai khác là `NEEDS_REVIEW`; thiếu số đo
là `UNAVAILABLE`; counter giảm là `COUNTER_RESET`. Counter không được hỗ trợ
không bị đổi thành số 0; không lấy được baseline thì dừng trước khi gửi tem.

Các dòng CSV:

- `READ_OK`: EPC phản hồi hợp lệ, không phải chứng nhận mặt in của riêng tem đó.
- `RFID_READ_ERROR`: máy trả dữ liệu đọc không hợp lệ.
- `NO_READBACK`: khoảng ordinal chưa có phản hồi; không đồng nghĩa VOID hoặc chưa in.
- `VOID_TOTAL`, `quantity=N`: số VOID của phiên/snapshot, để trống EPC và source row.
- `VOID_TOTAL_UNVERIFIED`: không đủ số đo tin cậy để xác định tổng VOID.
- Các marker duplicate/out-of-order vẫn giữ lại để đối chiếu, không xóa âm thầm.

Không gán N VOID tổng hợp cho N EPC tùy ý. Phiên gián đoạn/Cancel có thể chỉ có
snapshot trung gian; máy còn có thể xử lý dữ liệu đã nhận sau snapshot. Lịch sử
cũ chỉ có readback sẽ ghi `NOT_RECORDED`, không suy ra counter quá khứ.

Các counter là của toàn máy: phiên đối soát phải tránh job từ PC khác, đường
USB khác, thao tác reset counter hoặc tác vụ test/calibration xen vào. Lease
trong connector không chặn các chương trình ở máy tính khác gửi trực tiếp.
Chưa xác nhận trên phần cứng ZT610R/ZD621R rằng template chỉ `^RFR` luôn tăng
valid counter và tổng counter theo đúng quy tắc trên. Nếu firmware khác quy
tắc đó, app báo cần đối soát thay vì tự hạ tiêu chuẩn thành công.

Máy có thể cung cấp timestamp trong RFID operation log (`^HL`/`~HL`) theo cấu
hình, nhưng log RF operation không tự tạo ánh xạ VOID tới từng EPC. Bản này
dùng giờ host nhất quán cho báo cáo và không bật/xóa log trong máy.
[Zebra về bộ đếm RFID](https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/guide/software/rfid3-pg-en.pdf),
[Zebra về kiểm tra số tem đã in bằng odometer](https://techdocs.zebra.com/link-os/2-13/bestpractices/content/index.html).

## Cơ sở ZPL

Ví dụ phần RFID trong một format:

```zpl
^RFR,H,,,E^FN1^FS
^FH_^HV1,256,NWEP|<session-uuid>|1|,|END_0D_0A,L^FS
^PQ1
```

`^RF` đọc vào field dùng cho text và host verification. `^HV` với `L` cho phép
nhận phản hồi theo nhãn, kể cả tình huống retry/VOID, để host phát hiện lặp.
SGD `rfid.tag.read.content`/`execute` đọc tag hiện tại ở anten, phù hợp thao tác
đọc thử; việc gắn từng kết quả vào từng format của lô dùng `^RF` + `^FN` + `^HV`.
[Zebra về ^RF](https://docs.zebra.com/us/en/printers/software/zpl-pg/c-zpl-rfid-zpl-rfid-commands/r-zpl-rfid-rf.html),
[Zebra RFID Programming Guide 3](https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/guide/software/rfid3-pg-en.pdf).

## Kiểm thử

Các kiểm thử tự động dùng transport/spool giả và máy in TCP mô phỏng, không gửi
tem tới ZT610R/ZD621R thật. Chúng bao phủ sequence vượt 2.500, staging 50.000
tem thành một Windows job, framing RFID bị chia gói/xen status, thiếu/lặp/sai
độ dài, lịch sử sau restart, lease, Pause/Resume, Cancel và navigation guard.

Bản đóng gói được kiểm tra xuyên suốt với connector thật và máy in TCP
mô phỏng: 3.001 format đúng thứ tự, CSV đầy đủ readback/tổng kết và Download CSV
trả đúng file. Hai phiên riêng mô phỏng thiếu phản hồi và lặp phản hồi đều bị
đánh dấu gián đoạn, giữ được CSV và không báo hoàn tất. Test Go cũng xác nhận
phản hồi lặp đến trong lúc finish không làm nhả lease như một phiên thành công.
Kiểm thử bổ sung bao phủ VOID tổng hợp, số đo không hỗ trợ, counter reset,
snapshot cũ, file báo cáo tự lưu, giờ UTC+7 và phục hồi lịch sử sau crash.

Nghiệm thu phần cứng: chạy 20–50 tem trên từng model với template thực tế;
đối chiếu Text/EPC của cùng tem với từng dòng CSV, sau đó thử Pause/Resume,
media error/VOID và ngắt mạng. Chỉ tăng lô sau khi kiểm tra chính sách reprint
và thông điệp trả về của firmware đang sử dụng.
