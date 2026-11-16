# ZbrePrinter 3.3.0

16/10/2026. Desktop/web3.3.0, connector0.7.0. Thay đổi nghiệp vụ cuộn thành phẩm nên tăng phiên bản minor từ3.2.0.

## Quản lý sản xuất

- Mặc định quản lý cuộn khi in RFID EPC qua TCP; nhập JobID, số cuộn, người vận hành, source roll và lot. Target2.500 GOOD là chuẩn cuộn thành phẩm; chế độ thử kỹ thuật vẫn không có trần2.500 của phiên bản cũ.
- Một RollID nhận nhiều run; giữ ID qua thay nguồn và in bù. Review từng run, loại ordinal có lý do, giữ raw evidence/review revisions. Số còn thiếu tính từ EPC đang giữ, vẫn cần đối soát vật lý/QC.
- Khóa template bằng SHA-256 nội dung in; bỏ ID/độ rộng cột chỉ phục vụ editor khỏi fingerprint. Không đổi máy hoặc template âm thầm giữa các lượt bù.
- Chặn run tiếp theo khi còn active/chưa review/bằng chứng lỗi; với data feed, chặn dải trùng hoặc không nối đúng bước trước khi gửi.
- Chốt cần2.500 EPC duy nhất, mọi run được đối soát, số GOOD thực tế, VALID/VOID màn hình, VOID giữ lại, chiều tháo và ghi chú QC. Số VOID thử ngoài production sau reset khai báo riêng theo F03.
- Roll final bất biến qua API. Kiểm EPC trùng với roll final trong cùng connector/owner; chưa có dedup nhiều PC.

## CSV và nhãn lõi

Dữ liệu raw `reads.csv`/manifest vẫn tự lưu trong `%APPDATA%\ZbrePrinter\connector\rfid-sessions`. Không còn tự tạo CSV trình bày sau mỗi run. Người vận hành chủ động chọn Xuất CSV cuộn sau chốt, hoặc Xuất tạm để điều tra trước chốt.

Tên final: `<RollID>_FINAL_YYYY-MM-DD_HH-mm-ss_epc_Read_r<revision>.csv`. Lần đầu xuất archiveCSV+SHA-256receipt; tải lại giữ byte/tên. File có dòng GOOD, loại, missing, counter và review; lọc `GOOD_OPERATOR_RELEASED` để lấy danh sách giao. GOODordinal loại trừ VOID; không suy ra vị trí từngVOID.

Thông tin dán lõi xuất `<RollID>_CORE_LABEL.txt` để đưa sang máy nhãn riêng; app chưa tự điều khiển máy đó. Các count được phân biệt rõ nguồn operator và số đo connector. QC ghi sampled, không nhận là kiểm100%.

## Dừng khi lỗi vật tư hoặc đầu in

Mỗi RFIDformat đặt `^JZN` trước đọc/ghi để tắt firmware tự reprint khi lỗi. Nativefaultlatch quan sát head/media/ribbon kể cả khi paused, gửi `~PP` rồi `~JA` cùngsocket và chặn append/Resume/finish. Mất status sau khi gửi thửpause/clear có timeout rồiquarantine; không replay.

ChunkRFID<=10, bufferbudget<=40 vẫn giữ. Đây không phải quy tắc “in thêm10tem sau mở đầu”. Polling có thể bỏ lỡ mở/đóng rất nhanh; lệnh TCP không chứng minh buffer vật lý rỗng. Giữ máy paused, xóa queue, HOLD/kiểm vùng ảnh hưởng và runmới sau đốisoát.

## Nâng cấp và nghiệm thu

Không nâng cấp giữa lúc đang in. Kết thúc/đối soát phiên và giữ máy dừng; sao lưu thư mục dữ liệu trước triển khai. Lịch sử3.2.0 vẫn là bằng chứng run, không tự biến thành roll đã chốt của3.3.0.

Electron kiểm connector>=0.7.0 và capability production/faultlatch; build/pack verification kiểm binary/manifest. Tài liệu nghiệp vụ và kết quả test nằm tại `sop_nextwaves`. Kiểm thử simulator không thay qualification ZT610R/ZD621R với firmware/vật tư thực tế.
