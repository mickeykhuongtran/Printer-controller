# ZbrePrinter 3.7.0

Desktop/web 3.7.0, connector 0.11.0. Connector chịu trách nhiệm lấy và chốt counter RFID, tách số đếm máy khỏi số lượng thuộc cuộn và chỉ rõ từng lượt chưa đối soát.

## Đánh giá quy trình trước khi sửa

Nguyên tắc dùng counter để xác định số lượng, EPC để xác định danh tính và QC để kiểm tra chất lượng là hợp lý. Điểm cần sửa là quyền sở hữu bước chốt: giao diện cũ lấy mẫu đầu/cuối nên mất kết nối có thể để lại EPC nhưng thiếu counter cuối. Tổng thiếu không được trình bày như số máy hiện tại hoặc dùng để tự động tính in bù.

Đóng hồ sơ cuộn, xác thực số lượng và bàn giao sau QC là ba quyết định riêng. Xuất CSV cũng độc lập với đóng cuộn. Chi tiết thiết kế, giới hạn và quy trình vận hành nằm trong [đánh giá SOP](../docs/COUNTER-SOP-REVIEW-2026-10-19.md). Bản SOP Rev06 đã ban hành được giữ nguyên.

## Cơ chế counter mới

- Trước byte in đầu tiên, connector xác nhận queue rỗng và lấy hai vòng counter đầy đủ, ổn định trên kết nối sở hữu lượt. Baseline có thể khác 0; baseline không hợp lệ bị từ chối với trạng thái chưa gửi.
- Lượt bị từ chối trước payload đầu tiên có bằng chứng riêng về việc chưa gửi, được giải phóng khóa máy và đóng góp 0 tem. Lịch sử lỗi vẫn giữ; lượt in sau trên cùng cuộn không bị biến thành thiếu số đếm. Không suy ra “chưa gửi” chỉ từ việc chưa nhận EPC.
- Trong khi in, connector lấy checkpoint khoảng 2 giây tại ranh giới format. Một vòng gồm VALID, VOID và odometer; vòng lỗi không ghép giá trị mới với trường cũ để tạo mẫu giả.
- Sau khi gửi đủ format, connector tự chốt khi queue rỗng, hai vòng counter mới ổn định và phù hợp số attempt đã gửi. Việc chốt không phụ thuộc giao diện còn mở hoặc đã gọi `finish`.
- Mất TCP trước khi chốt giữ EPC và mẫu hoàn chỉnh gần nhất, kèm lý do chưa đối soát. Không tự reconnect để gán counter hiện tại cho lượt cũ, không phát lại tem và không reset counter.
- Nếu bằng chứng chốt đã được lưu, mất phản hồi HTTP hoặc mất socket sau đó không xóa bằng chứng. Bắt đầu gửi thêm dữ liệu phải vô hiệu hóa bằng chứng cũ và lưu trạng thái đó trước khi gửi.
- EOF, reset hoặc timeout của socket sau proof hợp lệ, khi không còn frame dở và không có lỗi lưu dữ liệu, được ghi như chẩn đoán đường truyền. Kết thúc lượt trả receipt cục bộ và giải phóng máy; lỗi ghi ổ đĩa hoặc frame nhận dở vẫn bị giữ để đối soát.
- Nếu truy vấn trạng thái của giao diện thất bại sau khi đã chốt, giao diện hỏi connector về khả năng hoàn tất từ bằng chứng đã lưu. Chỉ checkpoint/proof khớp và lỗi đường truyền đủ điều kiện mới được kết thúc; không tạo trạng thái máy giả, không bỏ qua lỗi của lượt chưa chốt.
- Counter giảm/reset được giữ thành dấu hiệu cần đối soát, kể cả sau đó tăng trở lại. EPC đủ không thay thế bằng chứng counter; thiếu EPC cũng được báo riêng với chất lượng số đếm.
- Lỗi lưu EPC ngay sau khi gửi vẫn giữ checkpoint/hash đúng phần payload đã commit và giữ cơ chế dừng, chặn phát lại khi chưa rõ kết quả.

## Giao diện, CSV và lịch sử

- Hiển thị riêng số đếm cuộn và snapshot tuyệt đối của máy, có thời gian đọc. “Tải lại hồ sơ” đọc bằng chứng đã lưu, không giả là counter trực tiếp.
- Nếu còn lượt chưa đối soát, phần đã ghi nhận được đánh dấu rõ; GOOD và số cần in bù chưa xác định không được trình bày như số chắc chắn.
- Danh sách chưa đối soát chỉ rõ lượt, thời gian, EPC đã lưu và lý do. Thông báo thiếu phản hồi RFID tách khỏi lỗi chốt counter.
- CSV mới ghi trạng thái `UNRECONCILED` khi thiếu bằng chứng, tổng VALID quan sát là số tạm và GOOD là `UNKNOWN`. READ_ERROR không được quy thành VOID theo tỷ lệ 1:1.
- Đóng cuộn và bắt đầu lô mới tiếp tục độc lập với xuất CSV. Lịch sử và CSV đã xuất giữ nguyên; không nâng lịch sử cũ thành đã xác thực chỉ vì cài bản mới.

## Kiểm thử nguồn và runtime

- Toàn bộ 155 test Go cấp cao cùng các subtest đạt trong pipeline build cuối (127,690 giây); `go vet` đạt.
- Có 11 suite lifecycle connector mới, bao gồm mất kết nối, vòng mẫu dở, reset, tự chốt, mất phản hồi, proof qua restart, từ chối baseline và kết thúc sau khi socket/truy vấn trạng thái đã mất. Các suite lỗi lưu dữ liệu cũng đạt.
- TypeScript, ESLint cho các thành phần thay đổi và các helper test đạt.
- 14 test desktop; 23 test TCP streaming/cancel/drain; test ZPL RFID, phạm vi dòng và chia lô dữ liệu đạt.
- Production build, kiểm tra bundle, kiểm tra runtime đóng gói và xác nhận phiên bản desktop trong ASAR đạt: web/desktop 3.7.0, connector 0.11.0.

## Kiểm thử giao diện trên bản đóng gói cuối

Hai bộ kiểm thử chạy lần lượt trên cùng connector SHA-256 ghi dưới đây, bằng máy in TCP mô phỏng và dữ liệu riêng:

- Counter lifecycle: **15 tem**, đạt baseline máy 8.000 → số máy 8.003 / số cuộn 3; mất VOID trong vòng cuối giữ EPC và mẫu hoàn chỉnh trước đó; reset rồi tăng lại vẫn chưa đối soát; mất phản hồi HTTP finish không phát lại.
- Lượt bị từ chối trước khi gửi rồi in lại 2 tem trên cùng cuộn: VALID/EPC/GOOD đều 2, không tạo thiếu EPC hoặc lượt chưa đối soát giả; hồ sơ lỗi vẫn giữ.
- Tự chốt khi chưa có yêu cầu finish; mất socket và truy vấn trạng thái sau proof; poll bằng chứng, kết thúc receipt và mở lượt mới thành công, không gửi thêm tem.
- Vòng đời cuộn: **2.518 tem**, gồm đọc/ghi EPC, VOID, thiếu phản hồi, loại tem, in bù, lỗi vật tư, đóng cuộn độc lập xuất CSV, mở lô mới trước khi xuất lô cũ và dùng lại Job ID nghiệp vụ.
- Kiểm thử thao tác bấm In thật: giữ phản hồi append thật cho đến khi native chốt, ngắt socket, trả phản hồi append cho giao diện. Truy vấn `~HQES` sau đó thật sự nhận HTTP 502; giao diện phục hồi đúng thành đã lưu 1 EPC và job `finished`, không hiển thị gián đoạn hoặc phát lại tem.
- Tổng **2.533 tem mô phỏng**, **0 lệnh reset counter**, 5 lần tải CSV chủ động. Hash dữ liệu RFID cũ và byte CSV đã xuất giữ nguyên.
- Kiểm tra ảnh và vị trí nút: số máy/số cuộn tách rõ, GOOD chưa biết hiện “Chưa xác định”, lý do và mã lượt chưa đối soát đọc được, các thao tác đóng/lịch sử vẫn truy cập được.

Kết quả chi tiết: [counter lifecycle](../build/counter-lifecycle-qa/run-PH2R8O/result.json), [vòng đời cuộn và thao tác In](../build/production-roll-qa/run-aVCdSG/result.json). Ảnh đối chứng nằm trong cùng thư mục. Vòng kiểm thử cuối không đổi timeout native 2 giây; độ trễ queue/fragment/event loop mô phỏng lớn nhất lần lượt là 126/69/100 ms.

SHA-256 connector Windows x64 đã kiểm thử:

```text
2d3e169cbb750a660716328345a0a02effc761da86f83a4691fcce733b800d87
```

## Bộ cài Windows x64

[ZbrePrinter-App-Setup-3.7.0-x64.exe](../dist/ZbrePrinter-App-Setup-3.7.0-x64.exe) — 137.469.757 byte; FileVersion 3.7.0. NSIS được tạo bằng `--prepackaged` từ đúng bản đã vượt hai bộ kiểm thử giao diện; kiểm tra runtime sau đóng gói tiếp tục đạt. Hash connector trong package khớp cả hai báo cáo QA.

SHA-256 bộ cài:

```text
e2da60693fed9feace3342b4956c3c9bfeb355cfa7969bc87d86b23af1fb0952
```

File đối chiếu: [SHA-256](../dist/ZbrePrinter-App-Setup-3.7.0-x64.exe.sha256). Chữ ký Authenticode: `NotSigned`.

## Giới hạn và cài nâng cấp

Kiểm thử dùng máy in TCP mô phỏng và thư mục dữ liệu riêng. Chưa nghiệm thu máy ZT610R vật lý ở xưởng. Bộ cài thử chưa có chữ ký số.

Thoát ứng dụng đang chạy trước khi cài nâng cấp. Bản mới tiếp tục dùng lịch sử hiện có. Không reset counter giữa một lượt in; nếu SOP yêu cầu reset đầu cuộn thì thực hiện trước lúc bắt đầu in để connector lấy baseline mới. Nguồn gửi khác vào cùng máy in phải được kiểm soát.

Lô cũ có 1.999 VALID đã ghi nhận / 2.504 EPC không tự được điền thành 2.505 VALID / 11 VOID từ ảnh máy. Muốn kết luận lại lượt thiếu cần hồ sơ tại máy xưởng hoặc bằng chứng đối soát có nguồn; dữ liệu gốc vẫn được giữ.
