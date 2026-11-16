# Đánh giá cơ chế counter và quy trình vận hành RFID

Ngày đánh giá: 19/10/2026, UTC+7. Phạm vi: app 3.6.0 và phương án sửa cho 3.7.0, TCP RFID qua connector. Đây là đánh giá kỹ thuật và phụ lục vận hành cho SOP Rev06; không thay thế bản SOP đã ban hành hoặc xác nhận nghiệm thu máy vật lý.

## Kết luận trước triển khai

Nguyên tắc dùng counter máy để xác định số lượng, EPC để xác định danh tính và kiểm mẫu để đánh giá chip–mặt in là hợp lý. Tuy nhiên, app 3.6.0 chưa đủ chắc ở bước chốt số đếm: giao diện điều khiển mẫu đầu/cuối, giám sát nền chỉ đọc trạng thái máy, và số cộng thiếu được đặt tên “VALID máy”. Mất kết nối trước mẫu cuối có thể tạo hồ sơ đã lưu EPC nhưng chưa xác định được số lượng của lượt đó. Kết quả tạm không được dùng làm căn cứ tự động in bù hoặc bàn giao.

Các phần giữ nguyên: một cuộn gồm nhiều lần in, ID cuộn nội bộ riêng, lưu EPC gốc, khóa template/đích máy, đóng hồ sơ độc lập xuất CSV, giữ nguyên báo cáo đã lưu, không tự phát lại dữ liệu khi kết quả truyền chưa rõ.

## Ba loại bằng chứng và ba quyết định khác nhau

| Nội dung | Ý nghĩa | Giới hạn |
|---|---|---|
| Counter máy | Giá trị tuyệt đối tại một lần đọc, có thời gian và nguồn | Có thể bao gồm cuộn trước; ảnh/snapshot không phải số hiện tại liên tục |
| Số đếm cuộn | Tổng chênh lệch counter trước–sau của những lượt thuộc cuộn | Chỉ xác nhận khi mọi lượt cần tính có bằng chứng cuối hợp lệ |
| EPC đã lưu | Danh sách phản hồi RFID thực nhận | Không thay counter; thiếu phản hồi không chứng minh tem chưa in hoặc VOID |
| Đóng cuộn | Kết thúc việc gắn lượt mới vào hồ sơ | Không tự xác nhận số lượng, QC hoặc buffer máy |
| Xuất CSV | Lưu bản báo cáo có trạng thái và nguồn số liệu | Báo cáo tạm không phải xác nhận giao hàng |
| Bàn giao | Quyết định vận hành sau đối soát và QC | Counter không chứng minh chất lượng mặt in hoặc đúng cặp chip–mặt in |

Với chế độ đọc EPC, số lượng GOOD sau loại = VALID đã xác nhận − số tem từng tính VALID đã loại. VOID là số riêng, không trừ lần nữa khỏi VALID. Với chế độ ghi EPC, phải thêm đối chiếu EPC kỳ vọng/đọc lại. Số lượng và chất lượng dữ liệu được đánh giá riêng; thiếu một EPC không biến một counter cuối hợp lệ thành số ước đoán, nhưng vẫn là lý do giữ hồ sơ để đối soát trước bàn giao.

## Thay đổi thiết kế đã chọn

1. Connector lấy mẫu đầu trước byte in đầu tiên trên kết nối đang sở hữu máy. Không mở lượt bằng một baseline lấy khi queue cũ còn chưa được xác nhận rỗng.
2. Một vòng lấy mẫu chứa phản hồi mới của VALID, VOID và odometer, được tuần tự hóa với append/control. Không ghép giá trị mới với trường còn sót từ vòng trước. Mẫu hoàn chỉnh trước đó vẫn giữ nếu vòng sau thất bại.
3. Lưu checkpoint counter trong khi in, ở ranh giới lệnh phù hợp. Checkpoint là quan sát tạm, không phải bằng chứng hoàn tất.
4. Connector chịu trách nhiệm chốt: kiểm tra queue, lấy các vòng mới ổn định, gắn bằng chứng với cùng kết nối/lượt/sequence và lưu trước khi trả receipt. Mất phản hồi HTTP không được dẫn đến in lại.
5. Lỗi TCP, timeout, reset hoặc thiếu mẫu cuối phải có trạng thái chưa đối soát và lý do riêng. Chỉ có EPC hoặc hai giá trị cùng bằng nhau không đủ để tự xác nhận lượt hoàn thành.
6. Giao diện hiển thị riêng snapshot máy và số lượng cuộn. Khi thiếu counter, ghi “đã ghi nhận”, số lượt chưa đối soát, thời điểm và nguyên nhân; GOOD/nhu cầu in bù chưa xác định không hiện như con số đã xác nhận.
7. Hồ sơ cũ không có bằng chứng mới tiếp tục được đánh giá theo bằng chứng cũ; không tự nâng cấp thành đã xác nhận. CSV đã xuất không bị sửa ngầm.

Mất truy vấn trạng thái trực tiếp sau khi đã chốt không đồng nghĩa kết quả lượt in chưa rõ. Connector chỉ cho hoàn tất receipt từ bằng chứng đã lưu khi proof còn khớp checkpoint hiện tại, không gửi thêm payload, không lỗi lưu/parse hoặc frame dở. Giao diện lấy kết luận này từ connector; không tạo phản hồi trạng thái máy giả hoặc bỏ qua các bước kiểm tra cho lượt chưa chốt.

Lượt bị từ chối trước byte payload đầu tiên là trường hợp riêng: connector ghi bằng chứng chưa gửi, giải phóng khóa máy và giữ lịch sử lỗi. Lượt đó đóng góp 0 tem, không làm thiếu số đếm của lượt thành công sau trên cùng cuộn. Không được suy ra “chưa gửi” chỉ vì chưa nhận EPC; phiên đã có thể truyền payload vẫn phải đối soát.

Counter phải tăng liên tục trong từng khoảng đo. Reset giữa các lượt không bắt buộc làm hỏng các delta đã chốt riêng, nhưng không còn được dùng một phép trừ đầu-cuối toàn cuộn để thay thế các lượt thiếu dữ liệu. Counter reset rồi tăng trở lại có thể không quan sát được nếu diễn ra hoàn toàn giữa hai mẫu; SOP phải kiểm soát việc reset và nguồn gửi khác.

## Quy trình vận hành đề xuất

| Bước | Người vận hành | Phần mềm |
|---|---|---|
| Chuẩn bị | Chọn đúng template, máy, vật tư và hồ sơ cuộn; hoàn tất setup/QC đầu | Xác nhận kết nối, quyền sở hữu phiên, queue và baseline trước in |
| In tiếp hoặc bù | Tiếp tục đúng cuộn; giữ counter trong quá trình in | Lưu EPC, các lượt và checkpoint; thể hiện rõ số tạm/số đã chốt |
| Kết thúc lượt | Chờ hoàn thành chốt số đếm | Xác nhận queue và counter cuối, lưu receipt; liệt kê nguyên nhân nếu chưa xác nhận |
| Gián đoạn | Giữ phần tem chưa rõ, kiểm tra buffer và tem thực tế; kiểm mẫu đầu sau khôi phục theo Rev06 | Giữ EPC/checkpoint, không tự phát lại; không gán counter đọc sau reconnect cho lượt cũ |
| Kết thúc cuộn | Đối soát số lượng, dữ liệu, tem loại và QC; đóng hồ sơ khi chuyển lô | Đóng độc lập xuất CSV; phần thiếu vẫn hiện trong lịch sử |
| Bàn giao | Chỉ dùng hồ sơ đủ điều kiện số lượng/dữ liệu/QC; xuất CSV đúng cuộn | Báo cáo ghi rõ trạng thái số đếm; archive cũ giữ nguyên |

SOP Rev06 đang quy định reset 0/0 một lần đầu cuộn. Nếu tiếp tục quy tắc đó, reset phải hoàn thành trước khi connector lấy baseline. Phần mềm không tự reset và không yêu cầu reset để chữa số liệu thiếu. Đo delta cho phép baseline khác 0 mà không lấy nhầm số lượng cuộn trước. Bỏ yêu cầu reset trong SOP là thay đổi quy trình cần được chủ quy trình ban hành riêng.

“Tải lại hồ sơ” chỉ đọc bằng chứng đã lưu. Snapshot có timestamp được trình bày là lần đọc gần nhất, không gọi là counter trực tiếp. Lượt cũ bị mất kết nối chỉ được sửa kết luận bằng bằng chứng đối soát có nguồn, người chịu trách nhiệm và phạm vi; không sửa raw EPC hoặc CSV đã xuất.

## Trường hợp thực tế dùng để thiết kế kiểm thử

CSV NW-5434-161026-001 ngày 19/10/2026 có 2.504 EPC riêng biệt và 10 READ_ERROR. Các nhóm trước 10:15 chứa 1.999 READ_OK; nhóm cuối thêm 505 READ_OK. Tổng đầu báo cáo vẫn là VALID 1.999 / VOID 5 và cảnh báo thiếu số đếm cuối. Điều này khoanh vùng phần counter chưa được tổng hợp ở lượt cuối; không xác định được lỗi mạng hay lỗi trạng thái máy vì log nằm trên máy xưởng.

Ảnh máy 2.505 VALID / 11 VOID không đủ để hồi tố toàn bộ chênh lệch vào lượt cuối: cần baseline, timestamp và kiểm soát các thao tác ngoài phiên. READ_ERROR không tương đương một VOID vật lý theo tỷ lệ 1:1.

## Tiêu chí nghiệm thu bản sửa

- Baseline khác 0: số máy và số cuộn khác nhau đúng theo delta.
- Baseline lỗi trước payload: lượt vẫn có trong lịch sử, không khóa lượt sau và không tạo thiếu EPC/counter giả khi in lại trên cùng cuộn.
- Client không gửi lệnh lấy counter: connector vẫn tự lấy đầu/cuối và lưu bằng chứng.
- Queue còn bận hoặc counter còn tăng: chưa được xác nhận xong.
- Mất TCP sau khi nhận EPC, trước counter cuối: giữ EPC/checkpoint, nêu đúng lượt chưa đối soát; không tự gửi lại.
- Vòng mẫu chỉ nhận VALID rồi mất VOID: không trộn hai vòng để tạo mẫu hoàn chỉnh.
- Counter giảm/reset: không chứng nhận delta hoặc tự lấy EPC làm số GOOD.
- Mất phản hồi HTTP lúc finish: thao tác lặp cùng phiên không in lại tem.
- Mất socket sau proof, kể cả lúc giao diện còn hỏi trạng thái: kết thúc bằng receipt đã xác thực, giữ chẩn đoán mạng và giải phóng lượt; lỗi lưu dữ liệu hoặc frame dở vẫn không được xác nhận.
- Nhiều lượt, một lượt thiếu counter: tổng cuộn hiện trạng thái chưa đầy đủ và chỉ rõ lượt thiếu.
- Đọc lịch sử, đóng cuộn, xuất về sau và tải lại không thay raw EPC/CSV đã lưu.
- Luồng lỗi đầu in/giấy/ribbon, dừng/hủy và in tiếp cuộn còn hoạt động theo bằng chứng hiện có.

## Giới hạn vận hành cần giữ

Một connector không ngăn được phần mềm trên máy khác gửi trực tiếp vào cùng máy in. Bằng chứng delta có giá trị khi nguồn gửi và thao tác reset trong khoảng đo được kiểm soát. Mô phỏng TCP xác nhận logic chương trình; nghiệm thu ZT610R/firmware/template/vật tư tại xưởng vẫn cần chạy các tình huống thật trước khi coi đạt yêu cầu sản xuất.

Tài liệu tham chiếu: [Solution SOP Rev06](../sop_nextwaves/Solution_SOP.md), [Zebra RFID Programming Guide 3](https://www.zebra.com/content/dam/support-dam/en/documentation/unrestricted/guide/software/rfid3-pg-en.pdf), các mục counter SGD và ^RS. Zebra mô tả counter resettable và khả năng thử trên nhãn tiếp theo khi RFID lỗi; chính sách continuous capture hiện tại của ứng dụng dùng một lần thử mỗi format. Các tiêu chí queue ổn định, lưu checkpoint và giao diện tách nguồn số là quyết định thiết kế của bản sửa này.
