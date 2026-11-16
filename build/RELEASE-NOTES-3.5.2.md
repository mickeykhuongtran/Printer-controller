# ZbrePrinter 3.5.2

Desktop/web 3.5.2, connector 0.9.2. Sửa đối soát số đếm sau sự cố và phân loại tem bị loại trong quy trình đọc/ghi EPC. Giữ một cuộn qua nhiều lần in và in bù; chỉ xuất CSV mới đóng cuộn.

## Số đếm sau lỗi mực, giấy hoặc đầu in

Connector gửi pause/clear qua kết nối đang in, kiểm tra hàng đợi đã rỗng và máy đang pause, rồi lấy hai bộ số đếm mới giống nhau cách nhau ít nhất 250 ms. Mỗi bộ gồm VALID, VOID và odometer tổng. Kiểm tra hàng đợi được thực hiện trước và sau mỗi bộ; tối đa ba vòng trong bốn giây.

Số RFID đã chạy phải nằm trong số format một tem thực sự đã gửi. Bằng chứng được lưu cùng checkpoint và số đếm. Lần in vẫn ghi nhận là bị gián đoạn, nhưng số thực tế đã in có thể được xác định chính xác; không còn bắt buộc mang nhãn “tạm” chỉ vì chưa chạy hết số yêu cầu. Phần chưa in đã hủy không bị tính thành EPC thiếu.

Nếu counter giảm/reset, phản hồi thiếu hoặc không ổn định, hàng đợi chưa rỗng, mất kết nối hoặc lưu dữ liệu lỗi, phần mềm giữ số chưa xác minh. Một lần in bù thành công không xóa sự không chắc chắn của lần trước. Không phát lại lệnh ghi EPC tự động.

Đối soát tự động áp dụng cho sự cố được bản mới ghi nhận khi kết nối gốc còn hoạt động. Lần in cũ bị gián đoạn mà không có bằng chứng số đếm cuối không được tự chuyển từ “tạm” sang đã xác minh sau nâng cấp. Khi test bản mới, dùng cuộn mới sau khi đã xuất/lưu cuộn cũ.

## Tem bị loại và GOOD

- **Tổng tem đạt đã loại:** tem trước đó đã tính vào GOOD, ví dụ EPC đúng nhưng hình in hỏng. Trừ GOOD một lần.
- **Tổng tem lỗi ghi đã loại:** tem ghi sai/chưa xác minh vốn chưa tính vào GOOD. Ghi nhận việc loại, không trừ GOOD thêm.
- Hai trường là số cộng dồn của cuộn. Lưu lại cùng giá trị không cộng dồn lần nữa. Không nhận số vượt dữ liệu tem đã ghi nhận hoặc chỉnh số khi đang in.
- Hai nhóm nằm trong mục thu gọn **Tem đã loại**; nhóm lỗi ghi chỉ xuất hiện khi ghi EPC. Không thêm bước xác nhận cho cuộn mới.
- Hướng dẫn sau sự cố yêu cầu đối chiếu GOOD còn lại trước khi nhập số in bù, tránh dùng VALID máy thay cho số tem ghi EPC đúng.
- Cuộn ghi EPC cũ có số loại chưa phân nhóm cần phân loại một lần trước khi xuất. CSV đã xuất trước đây giữ nguyên.

GOOD khi ghi EPC được cộng theo từng lần in: lấy số nhỏ hơn giữa VALID máy và số EPC đọc lại đúng, sau đó trừ tem đạt đã loại. Ghi sai rõ ràng được loại khỏi GOOD ngay từ đầu. Thiếu phản hồi hoặc dữ liệu mâu thuẫn vẫn làm GOOD chưa xác minh.

## Các tình huống đối soát

| Tình huống | Kết quả cần đạt |
|---|---|
| Yêu cầu 2.500; lỗi sau 1.248 VALID và 2 VOID; dừng/xóa hàng đợi và số ổn định | VALID/EPC/GOOD 1.248, VOID 2; số thực tế được chốt, 1.250 tem chưa chạy không sinh EPC thiếu. |
| In bù 1.252 tem đạt cho trường hợp trên | Cùng cuộn: VALID/EPC/GOOD 2.500, VOID 2, CSV Total 2.502. |
| Một tem cuối hoàn thành sau mẫu số đếm đầu tiên | Bộ số chốt phải gồm tem này: 1.249 VALID; lượng bù còn 1.251. |
| Trong 1.248 VALID có một tem in hỏng, EPC vẫn đúng | Loại tem đạt 1 → GOOD 1.247; bù 1.253 → VALID/EPC 2.501, GOOD 2.500, VOID 2, Total 2.503. |
| Ghi 3 tem: 2 EPC đúng, 1 sai; máy báo VALID 3 | GOOD 2 xác định; loại tem lỗi ghi 1 vẫn GOOD 2. |
| Chọn đúng dòng nguồn lỗi và ghi lại thành công | VALID 4, EPC đúng 3, GOOD 3; lịch sử vẫn có lần ghi sai. |
| Sau đó loại một tem đã đạt | GOOD còn 2; loại tem lỗi ghi vẫn là 1, không trừ lần thứ hai. |
| Ghi 3 tem nhưng thiếu phản hồi của một tem | GOOD chưa xác minh; nhập số tem lỗi loại hoặc in bù không tự chứng minh nội dung lần thiếu phản hồi. |
| Reset counter, mất đường truyền, hàng đợi chưa rỗng hoặc lỗi lưu | Không tự chốt số; giữ dữ liệu và cảnh báo. |

## CSV và phạm vi xác minh

CSV vẫn có bảy cột: `ordinal,host_time,bank,value,result,received_time,detail`. Phần đầu tách Removed GOOD / Removed rejected, số lần ghi sai và số ghi chưa xác minh. Total = VALID + VOID; số dòng CSV không phải số tem GOOD. Dòng VOID tổng không cộng lần nữa với READ_ERROR. Lịch sử sai và lần in bù đều được giữ.

GOOD là số lượng theo bằng chứng RFID và số loại do người vận hành nhập; không tự xác nhận chất lượng hình in hoặc xác định EPC nào đã bị bóc bỏ. Khi ghi bù phải chọn đúng dòng dữ liệu gốc. Template và dữ liệu đầu vào được giữ bằng fingerprint trong cuộn. Không dùng phần mềm khác gửi job vào cùng máy trong lúc thử nghiệm hoặc sản xuất vì không thể quy thuộc chắc chắn số đếm chung của máy cho nhiều nguồn bên ngoài.

## Kiểm thử và bộ cài

- Full Go suite trên mã cuối: đạt, 51,965 giây; `go vet ./...` đạt.
- TypeScript, production build và ESLint các file thay đổi: đạt.
- 12 test desktop runtime/bundle policy: đạt. Desktop từ chối connector cũ hoặc thiếu khả năng đối soát/phân loại mới.
- Test trợ giúp production roll, TCP job client, RFID capture, Zebra RFID, row range và batch data: đạt. Bổ sung QR tùy chỉnh cho đọc EPC và ghi EPC kèm đọc TID; nhánh tạo QR đang hoạt động không cần thay đổi.
- Full-repository ESLint vẫn báo 2 lỗi có sẵn tại `RfidSessionsPanel.tsx` và 6 cảnh báo ngoài phần sửa; không ghi nhận toàn bộ lint là đạt.

Bundle và packed runtime xác minh đúng web 3.5.2 / connector 0.9.2.

- Bộ cài: `dist/ZbrePrinter-App-Setup-3.5.2-x64.exe`, 137.356.874 byte.
- SHA-256: `CCCFC2D16E4F4C92EF951E8DA78B6577478EA50F1DC227795DE6E48FD349B3D2`.
- Connector SHA-256: `0a0aa814d50fad9ca295b0956473f2c8974ebb1dbbe38d5413ec49c0c656a436`.

Luồng giao diện đóng gói đã đạt: 2.500 lượt có hai VOID và một phản hồi EPC bị thiếu; loại một tem đạt rồi bù ba tem; chống đổi template/chế độ; ghi ba tem có một mismatch, loại mismatch, ghi lại đúng dòng nguồn số 2, loại một tem đạt; mở đầu in sau 3/10 tem, chốt số thực tế 3 rồi bù 7 trong cùng cuộn. CSV của từng trường hợp được kiểm tra số đếm, dữ liệu, lịch sử và tính ổn định khi tải lại.

Bằng chứng trên bản đóng gói cuối: [result.json](production-roll-qa/run-6VYtVs/result.json), [CSV đọc](production-roll-qa/run-6VYtVs/roll-export.csv), [CSV ghi EPC](production-roll-qa/run-6VYtVs/write-export.csv), [CSV sau mở đầu in và in bù](production-roll-qa/run-6VYtVs/fault-export.csv). Ảnh giao diện: [số đếm sau sự cố](production-roll-qa/run-6VYtVs/fault-reconciled.png), [xuất cuộn ghi EPC](production-roll-qa/run-6VYtVs/write-export-ready.png).

Kiểm thử tự động dùng connector thật nối máy in TCP mô phỏng; chưa chạy trên máy in vật lý. Cần kiểm thử các phản hồi trạng thái và counter thực của model/firmware tại phòng in trước khi đưa vào sản xuất.
