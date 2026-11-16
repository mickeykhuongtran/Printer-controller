# Báo cáo kiểm thử và nghiệm thu ZbrePrinter 3.9.0

Ngày: 08/11/2026. Nền: mã nguồn 3.8.0 của workspace. Runtime: Electron 43.2.0, Next.js/React, Go connector 0.12.0. Bộ cài Windows x64, bản nội bộ chưa ký số.

## Kết luận

Kiến trúc đã đáp ứng một host điều phối nhiều máy qua TCP/IP, tách lượt in khỏi vòng đời giao diện và giữ hồ sơ riêng từng cuộn/máy. Có thể đưa vào **pilot có kiểm soát**. Chưa đủ bằng chứng để tuyên bố nghiệm thu dây chuyền thật hoặc READ_ERROR thực tế đã hết: trong phiên này không gửi lệnh tới ZT610R/ZD621R vật lý.

Không cần đổi sang C# để triển khai mô hình này. Các điểm ảnh hưởng ổn định nằm ở sở hữu kết nối, đồng bộ dữ liệu, đối soát counter và xử lý trạng thái chưa rõ. App/connector cần chạy trong phiên Windows của người vận hành; đây chưa phải Windows service sống qua logoff.

## Những phần đã thay đổi

| Phần | Thay đổi chính |
|---|---|
| `native/local_print_agent_go/fleet_spool.go` | Lưu toàn bộ lượt trước khi gửi, kiểm tra SHA-256/sequence, hàng đợi theo máy, worker độc lập UI, không phát lại khi khởi động lại; lịch sử phân trang và trạng thái mới nhất mỗi máy. |
| `tcp_job.go`, `tcp_job_control.go` | Tránh giữ việc kiểm tra máy khác chờ I/O của một máy chậm; cấu hình mức đồng thời mặc định 10, phạm vi 1–64. |
| `production_roll*.go`, `production_notes.go` | Một cuộn nhiều lượt/cấu hình, snapshot bất biến, ghi chú theo ID bản ghi, metadata IP, giữ CSV đã lưu của bản cũ. |
| `rfid_capture.go`, `rfid_diagnostics.go` | Xử lý phản hồi TCP chia/gộp, tìm lại frame sau frame hỏng, lưu bằng chứng lỗi; sync theo gói nhận và trước checkpoint. |
| `raw_spool_durable_windows.go` | Thử lại thao tác thay file đã sync trong tối đa 500 ms khi bị khóa đọc ngắn; lỗi kéo dài vẫn giữ bằng chứng cũ và báo lỗi. |
| `FleetConsole.tsx`, `fleet-spool.ts`, `fleet-drafts.ts` | Danh sách máy linh hoạt, điều khiển riêng, bản nháp IndexedDB theo máy, thẻ VALID/VOID và trạng thái. |
| `PrintStep.tsx`, `ProductionRollPanel.tsx`, `RollNotes.tsx` | Giao lượt cho connector, khóa gửi khi máy đang xử lý, tiếp tục cùng cuộn sau chỉnh sửa, ghi chú và CSV. |
| Desktop runtime | Kiểm tra connector/capability mới, giữ quit guard trong lúc chuẩn bị/gửi, phiên bản 3.9.0. |

## Kiểm thử tự động

- Toàn bộ bài kiểm thử Go, gồm counter lifecycle, lỗi đầu in/giấy/mực, mất kết nối, bằng chứng chưa gửi, đối soát, CSV cũ, queue, spool, notes và độ bền dữ liệu. Có kiểm thử khóa file Windows ngắn/kéo dài và lỗi hồ sơ lúc khởi động; không cho phép dùng danh sách nạp dở để bỏ qua lượt chưa đối soát.
- Go vet; build connector Windows x64/arm64, macOS x64/arm64. Chỉ runtime Windows được chạy trong phiên này.
- 24 nhóm kiểm thử nguồn JavaScript/TypeScript; TypeScript/build production thành công. ESLint: 0 lỗi, 6 cảnh báo có sẵn ở phần ngoài thay đổi này.
- 14 kiểm thử desktop runtime và chính sách bundle.
- Kiểm thử queue với 1, 2, 3, 4, 5 và 10 máy mô phỏng; cố ý giới hạn 2 kết nối để kiểm tra chờ lượt. Kiểm thử UI/TCP bên dưới chạy 3 kết nối đồng thời.
- Kiểm thử EPC/CSV với phản hồi chia theo 1, 2, 7 và 4.096 byte; frame hỏng không nuốt EPC hợp lệ kế tiếp; giữ phản hồi lỗi để điều tra.
- Kiểm thử giao diện editor với 2.500 dòng, đổi Print/Edit, QR/text, kéo vị trí, undo/redo và thứ tự EPC. Các mẫu đo phản hồi editor khoảng 11–24,4 ms trên host thử nghiệm; đây không phải cam kết latency cho mọi template/host.
- RFID text, ảnh và xoay template; 192 trường hợp render xoay và 84 trường hợp render ảnh.
- TCP legacy: Pause/Resume, 501 cặp text/EPC, queue giới hạn và không trùng; Cancel sau khoảng 400 tem trong lượt 2.000, cancel khi đang gửi/chưa gửi, lỗi clear và đối soát không in lại. Mock cũ đã được cập nhật cho API lịch sử và thông báo hiện hành.

Bài thử chính: `npm run test:fleet-ui`. Mỗi lần tạo profile và dữ liệu riêng; kết nối ba TCP simulator trên các cổng động của host, không dùng port 9100. Nó kiểm tra:

1. Ba lượt 2.500 tem cùng hoạt động; reload renderer không hủy hoặc phát lại.
2. Mỗi máy có một VOID mô phỏng: 2.499 VALID + 1 VOID; phần mềm không tự in bù.
3. Chọn dòng, Apply ghi chú, kiểm tra lưu và xóa ô nhập/chọn.
4. Đổi vị trí template, tốc độ và độ đậm; thêm 5 tem vào cùng cuộn.
5. Mở đầu in trước payload, không gửi tem; đối soát, đóng đầu in, tiếp tục cùng cuộn thêm 5 tem. Có nhánh giữ Pause để người vận hành bấm Tiếp tục.
6. Đóng và xuất CSV: máy thứ ba 2.509 VALID + 1 VOID, một cuộn với các lượt và một CSV có IP/ghi chú.

Kết quả máy đọc được, CSV thử và ảnh UI nằm tại [fleet-qa/latest-result.json](fleet-qa/latest-result.json) và thư mục `runDir` trong file đó. Kết quả legacy tại `tcp-pause-qa/result.json`, `tcp-cancel-qa/result.json`; editor tại `fleet-qa/regression-ui-results.json`. Kiểm tra bundle/packed xác minh version, capability và hash connector/web.

Go race detector chưa chạy được do môi trường thiếu C compiler cho CGO; không tính kiểm tra này là đạt. Không thử cài/gỡ bộ cài lên profile vận hành thật.

## READ_ERROR và dữ liệu lịch sử

Đã tìm thấy lỗi parser cụ thể có thể làm mất phản hồi hợp lệ sau frame hỏng, đồng thời sửa các nguồn gây chậm trong nhận/lưu và cập nhật UI. Lượt thử dài còn phát hiện lỗi thay file Windows lúc có reader; đã bổ sung sửa và kiểm thử tái hiện.

CSV cũ có các dòng `invalid_read` không giữ nội dung lỗi gốc. Không thể xác nhận nguyên nhân từng dòng hoặc phục hồi EPC chỉ từ CSV ấy. Bản mới giữ `feedback-errors.jsonl` cạnh dữ liệu lượt để phân biệt phản hồi rỗng, sai định dạng, thiếu frame và lỗi lưu. Không biến READ_ERROR thành VALID bằng phỏng đoán EPC hoặc dựa riêng vào counter/chữ in trên tem.

## Quy trình vận hành và nghiệm thu thực tế

- Dùng IP cố định, dán IP lên máy; cấu hình đúng model/DPI/template. Mỗi máy giữ một cuộn đang mở; một cuộn có nhiều lượt in.
- Cuộn mới: căn giấy/calibrate trước, reset VALID/VOID về 0 trên máy rồi bắt đầu. Tiếp tục cùng cuộn: không reset counter.
- 2.500 là lượng của lượt yêu cầu. “Xong lượt” không tự đóng cuộn. Người vận hành kiểm tra VALID/VOID, phản hồi EPC và tem loại, rồi tự quyết định lượt in bù.
- Chỉnh vị trí/tốc độ/độ đậm áp dụng cho lượt tiếp theo. Pause ngắn có thể Resume; mở đầu in gây service fault thì đối soát lượt dừng, xóa buffer, sửa lỗi và tạo lượt tiếp theo trong **cùng cuộn**.
- Tem mất biết chính xác EPC: ghi chú đúng dòng. Chưa biết EPC: ghi sự cố theo mốc gần nhất; không gán mất tem cho một EPC bất kỳ. Ghi chú không tự sửa counter hay số tem loại.
- Chỉ đóng cuộn khi kết thúc cuộn thực tế; xuất một CSV. Sao lưu dữ liệu hồ sơ/spool theo ca, theo dõi dung lượng đĩa và tránh sleep/logoff khi in. Spool/bằng chứng được giữ, chưa có tự động xóa theo tuổi.

Trước nâng cấp, sao lưu dữ liệu app và hoàn tất các lượt đang chạy. Không dùng luân phiên 3.8.0 và 3.9.0 để ghi cùng hồ sơ đang mở; nếu rollback, dùng bản sao lưu phù hợp phiên bản để tránh phần mềm cũ bỏ qua dữ liệu revision/ghi chú mới.

Pilot đề nghị: từng ZT610R/ZD621R một lượt 2.500 tem, sau đó cả ba cùng lúc; thử pause, mở đầu in giữa lượt, đổi template, in bù, mất mạng từng máy, restart app/host và đọc lại CSV cũ. Chấp nhận khi không lẫn EPC giữa máy, không phát lại lượt mơ hồ, tổng counter được đối soát, một cuộn một CSV và mọi thiếu phản hồi đều được thể hiện rõ. Nếu còn READ_ERROR, lấy kèm raw feedback, manifest, model/firmware và mốc thời gian để xác định nguyên nhân trước khi chạy toàn công suất.

## Bộ cài đã xác minh

- [ZbrePrinter-App-Setup-3.9.0-x64.exe](../dist/ZbrePrinter-App-Setup-3.9.0-x64.exe)
- SHA-256: `f856adc86e94d60c0de856317b8dfa2194a17301befa334808b5743c8bea49b2`
- Kết quả kiểm thử cuối trên runtime đóng gói: `D:\Nextwaves_SDK_Printer\Final-version\Zebra\ZbrePrinter-App\build\fleet-qa\run-7K3OCd`.
- [Biên bản xác minh JSON](fleet-qa/release-verification.json), gồm hash runtime và kết quả CSV.
