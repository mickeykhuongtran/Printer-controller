# Kết quả kiểm tra bản 3.3.0

Ngày16/10/2026. App/web3.3.0, connector0.7.0. Bài kiểm thử giao thức dùng connector thật kết nối simulator trên chính PC với cổng tạm; không gửi lệnh tới máy in sản xuất.

## Kết quả đã chạy

| Phạm vi | Kết quả | Bằng chứng |
|---|---|---|
| Go native | PASS toàn bộ `go test ./...`, `go vet ./...` | Bao gồm production ledger, chốt/review, mất/hỏng bằng chứng, export receipt, counter và queue |
| Lỗi service | PASS test đồng bộ socket và latch | Head/media/ribbon khi paused; thứ tự pause→clear; chặn append/Resume/finish; timeout/quarantine |
| Dải dữ liệu nguồn | PASS test preflight | Chặn overlap/skip/đổi chiều trước gửi; refill đuôi liên tục; giữ lại gap giữa dải |
| Số VOID | PASS test biên | 2 VOID sản xuất+1 VOID thử=3 trên máy; số giữ≤2; thiếu số đo vẫn không xóa phần đã biết |
| Frontend | PASS TypeScript và helper tests | Hash ổn định qua mở lại template; thay dữ liệu thực làm đổi hash; parse exclusions; payload roll-list |
| Điều khiển/in tuần tự | PASS TCP client, RFID ZPL và23 ca Pause/Cancel/streaming | Không tự replay khi kết quả không rõ; cùng read field cho host/mặt in; `^JZN` |
| Desktop runtime | PASS11 tests | Version/capability gating, user-data/runtime policies |
| Build | PASS `npm run dist:win` | Next production build, connector cross-build, NSIS x64, verify:bundle và verify:packed |
| SOP | PASS render và xem đủ12 trang | Sửa các bảng điền, kiểm dấu/chữ/cột/footer/ảnh; bản nguồn giữ nguyên |

Kiểm tra Go chạy trên Windows; các binary macOS/ARM được cross-compile, không phải đã chạy nghiệm thu trên từng nền tảng.

## E2E production trên renderer đóng gói

Lệnh: `npx electron build/test-production-roll-ui.cjs`.

- Job `NW-4520-261016-001`, Roll `_01`, hai run2300+200.
- 2.500 EPC duy nhất và đúng thứ tự; 2 VOID tổng; VOID giữ2.
- Chặn chốt khi thiếu/chưa review; source genealogy đúng.
- Reload khi đang làm và sau chốt giữ đúng hồ sơ.
- Không tự tạo report CSV; chỉ tạo khi bấm xuất.
- Tải lại CSV final giữ nguyên byte/tên/revision; final không được sửa qua reviewAPI.
- Nội dung dán lõi cùng Job/Roll/GOOD/VOID/filename.
- Không gửi lệnh reset counter; có `^JZN` trong2.500 format.

Kết quả máy đọc được: `../build/production-roll-qa/latest-result.json`. Run hoàn tất: `../build/production-roll-qa/run-UxzhM5`. Trường `globalUniqueEpcs=2500` trong harness chỉ nói về tập simulator của bài thử này, không có nghĩa dedup toàn công ty.

## E2E kỹ thuật và lịch sử cũ

Lệnh: `npx electron build/test-rfid-capture-ui.cjs`.

- 3.001 tem, 3.001 readback tuần tự; không bị cap2.500.
- Phát hiện thiếu phản hồi và duplicate.
- VOID tổng2; manual export; Clear view không xóa bằng chứng.
- Pause/navigation guard đạt; production mode tắt rõ ràng cho bài kỹ thuật.

Kết quả: `../build/rfid-capture-qa/result.json`; run `run-nGQkIu`. Cả hai E2E có `realConnector=true`, `hardwarePrinting=false`. Một assertion của harness production được sửa từ `innerText` sang `textContent` để đọc nút trong phần details đang đóng; không sửa app để bỏ qua kiểm tra.

## File giao và đối chiếu

Installer: `../dist/ZbrePrinter-App-Setup-3.3.0-x64.exe`.

Kích thước137.271.148 byte. SHA-256:

`952C318B3C8138EAC22F05D55FC990DA7DC42B426094D257464C5F8571EE8FC2`

File `.exe.sha256` nằm cạnh installer. Binary chưa ký Authenticode (`NotSigned`); bundle policy cho phép bản build nội bộ từ working tree có thay đổi. Đây không phải bằng chứng code đã merge/release qua pipeline ký số.

SOP nguồn tại ổG giữ nguyên SHA-256:

`A3665983DB687352BE49723A6FD29A2C443EF59F4C14704BD4FAAA474EA5FF59`

Tài liệu mới nằm trong thư mục này. Render QA dùng Word COM riêng và bundled Python/Poppler vì packaged LibreOffice không có trên máy; kiểm file PDF thực sự được tạo, dùng SaveAs2 khi ExportAsFixedFormat không tạo đầu ra. PDF/PNG nằm `_work/final_render` để kiểm nội bộ, không phải bản SOP giao chính thức.

## Những điều chưa được chứng minh bởi các bài thử trên

Chưa chạy máy ZT610R/ZD621R thực với firmware10.6.26.28275 và từng vật tư. Chưa đo latency dừng thực, số tem còn chạy sau fault, ý nghĩa counter read-only trên firmware đó, chính xác cơ học/chip–mặt in hoặc hiệu quả kế hoạch lấy mẫu. Chưa nghiệm thu USB-B, máy nhãn lõi riêng, reader100%, nhiềuPC dùng chungmáy hoặc database EPC toàn doanh nghiệp.

Thực hiện PD01/F02 trong SOP trước khi phê duyệt tổ hợp máy–vật tư–template để sản xuất. Giữ kết quả FAIL/PASS và vùng HOLD; không lấy kết quả simulator làm giấy xác nhận sản phẩm.
