# Giải pháp vận hành và truy xuất phòng in RFID Nextwaves

Ngày cập nhật: 16/10/2026. Tài liệu đi kèm: **Nextwaves_PrinterDepartment_SOP_Rev06.docx**, SOP-PRD-RFID-003, và poster **Nextwaves_QuyTrinh_TreoTuong_A3_Rev01_SOP_Rev06.pdf**. Rev06 giữ quy trình gọn của Rev05, thêm trách nhiệm, kiểm soát ban hành và liên kết bản treo tường. Lần cập nhật này chỉ sửa tài liệu; app 3.3.0, connector 0.7.0 và bộ cài giữ nguyên.

## 1. Yêu cầu đã thống nhất và lựa chọn giải pháp

Đơn vị bàn giao là một **cuộn thành phẩm có 2.500 tem GOOD**. Một cuộn thành phẩm có thể dùng nhiều cuộn trắng và nhiều lần in/bù. Hai loại công việc KIT và CUSTOM đều dùng template do kỹ thuật chốt; nhân viên không thiết kế lại trong khi sản xuất. ERP/kho sẽ gán khách hàng theo Job ID ở bước sau.

Luồng thường ngày được rút về năm bước:

1. Chọn đúng template, máy, Job/cuộn và vật tư; hoàn tất setup nếu cần.
2. Reset VALID/VOID về 0/0 đúng một lần khi bắt đầu cuộn thành phẩm.
3. Đặt lượng cần in, theo dõi counter và kiểm mẫu đúng mốc; giữ nguyên ID/counter khi đổi nguồn để bù.
4. Kết thúc ở VALID = 2.500 trong trường hợp bình thường, đối soát dữ liệu và kiểm cuối.
5. Chốt, chủ động xuất CSV, dán nhãn lõi cùng mã và upload thủ công theo quy định workspace của phòng in.

Kiểm thường quy gồm tem VALID đầu, một tem ngẫu nhiên ở vùng giữa và một tem vùng cuối. **Sau mọi thay đổi làm gián đoạn quá trình, kiểm ngay tem đầu sau khôi phục**; nếu tem đầu được đánh VOID thì kiểm tem VALID đầu tiên tiếp theo. Tem mẫu đạt và không hỏng được giữ trên cuộn. VOID nhận diện rõ có thể giữ trên cuộn theo yêu cầu của chủ quy trình, nhưng không tính vào 2.500 GOOD.

Không yêu cầu đếm tay lại 2.500 tem, chụp ảnh counter 0/0 ở mọi cuộn, ghi lặp các phiếu giấy hoặc mặc định thử rồi bỏ 10 tem sau thay giấy/ribbon. Người phụ trách chỉ yêu cầu kiểm mở rộng khi có dấu hiệu bất thường hoặc khi nghiệm thu một tổ hợp máy/template mới.

## 2. Vì sao VALID bằng 2.500 là mốc dùng được

Mốc này phù hợp với quy trình bình thường khi đồng thời có các điều kiện: counter đã reset đầu cuộn và liên tục, không có tem từng được tính VALID bị loại hoặc dùng thử ngoài hàng giao, các mẫu kiểm đạt và hồ sơ EPC trên app không còn bất thường. Kỹ thuật phải xác nhận trước ý nghĩa bộ đếm trên từng tổ hợp máy/firmware/template đọc EPC; đây là việc nghiệm thu khi đưa vào dùng hoặc có thay đổi ảnh hưởng, không lặp mỗi cuộn.

Trong trường hợp đó:

`GOOD giữ lại = VALID = 2500`

VOID là số riêng, **không lấy VALID − VOID để tính GOOD**. Nếu giữ mọi VOID thì số vị trí vật lý của cuộn là `2500 + VOID`; thứ tự GOOD vẫn chỉ từ 1 đến 2500.

Ngoại lệ cần tách rõ: RFID đọc thành công không bảo đảm mặt in đúng. Nếu đã tháo R tem từng được máy tính VALID, và counter liên tục, phần loại xác định đầy đủ, thì `GOOD giữ lại = VALID − R`. Ví dụ tháo hai tem in sai có thể phải in tới VALID = 2502 để giao 2500 GOOD. Tem còn nghi ngờ phải giữ riêng, chưa được tính vào GOOD. Không reset để làm màn hình trở lại 2500.

Nếu VALID đủ nhưng app thiếu EPC hoặc có trùng, phải giữ cuộn và điều tra. Phản hồi host bị mất không chứng minh tag chưa in và cũng không chứng minh tag VOID. Tự in lại toàn bộ yêu cầu trong tình huống này có thể tạo thêm tem trùng; vì vậy quy trình không cho dùng phép bù số học để che trạng thái chưa biết.

## 3. Điều gì thực sự đang có trong app 3.3.0

| Hạng mục | Hành vi hiện tại và cách vận hành |
|---|---|
| Mã Job/cuộn | Nhập trước khi in để liên kết bằng chứng ngay từ đầu. Khi kết thúc dùng lại mã đó cho CSV/nhãn lõi; đổi tên file không thay ID bên trong |
| Lượng còn thiếu | App tính từ EPC giữ lại, có nút “Đặt số in còn thiếu”. Sau khi lượt trước đã kết thúc/đối soát, khi không loại tem, kiểm số này với 2500 − VALID; lệch thì xử lý trước khi gửi |
| Dừng ở 2500 | App không tự theo số operator đang nhìn trên màn hình máy để cắt đúng lúc. Cần đặt đúng lượng yêu cầu, không gửi dư rồi trông chờ PAUSE đúng counter |
| Đối soát từng lần in | Cần một ghi chú ngắn, xác nhận và “Lưu đối soát lần in” trước khi bù/chốt. Ghi mốc thực đã kiểm hoặc tham chiếu hồ sơ cuộn; không giả khai kiểm đủ đầu/giữa/cuối cho từng run |
| Điều kiện chốt | Đủ 2500 EPC giữ lại riêng biệt, các run đã đối soát, không còn bằng chứng lỗi chưa giải quyết; nhập GOOD, VALID, VOID, VOID giữ, chiều tháo và ghi chú/xác nhận cuối |
| GOOD thực tế | Cuộn bình thường dùng counter liên tục, không loại tem và kết quả QC để đối soát; trường này không bắt buộc tháo ra đếm tay toàn bộ |
| Xuất và lưu | Dữ liệu gốc tự lưu để phục hồi. Báo cáo cuộn final tạo khi nhân viên bấm xuất; không tự upload cloud |
| Nhãn lõi | “Thông tin dán lõi” xuất dữ liệu TXT để dùng trên máy in nhãn riêng; app chưa điều khiển máy thứ hai |
| Kiểm tem đầu | Nhân viên thực hiện; app chưa có cơ chế tự dừng sau chính xác một tem hay nhắc đủ từng mốc lấy mẫu |
| Hồ sơ đã chốt | Không sửa/reopen qua luồng hiện tại. Nếu phát hiện sai, giữ cuộn và lập ghi nhận sửa đổi có người chịu trách nhiệm; không sửa trực tiếp CSV final |

Mốc target 2500 trong quản lý cuộn là chuẩn thành phẩm đã thống nhất. Nó khác giới hạn 2500 của một lệnh in kỹ thuật trước đây đã được bỏ. Việc đưa quy trình về năm bước không xóa các điều kiện chốt còn tồn tại trong bản 3.3.0.

Nhân viên nói “xuất rồi gán Job ID” có thể thực hiện theo nghĩa gắn nhãn và bàn giao cuối cuộn. Để tránh gán nhầm lịch sử, **giá trị ID phải được chọn một lần trước khi in**. Đây là một thao tác đầu cuộn, không phải cấp mã lại sau mỗi lần thay giấy hoặc in bù.

## 4. Cách xử lý gián đoạn ít bước nhưng kiểm đúng chỗ

Sự kiện cần kiểm đầu sau khôi phục gồm mở đầu in, thay giấy/ribbon, chỉnh/kẹt đường giấy, nối vật tư, hiệu chuẩn, thay cấu hình được duyệt, khôi phục mạng/nguồn hoặc can thiệp khác có thể làm lệch cặp chip–mặt in. Nếu thay template hoặc cấu hình ảnh hưởng nội dung, người phụ trách phải xử lý hồ sơ; không thay template của cuộn đang làm rồi tiếp tục vì app khóa fingerprint.

Sau lỗi đầu in/giấy/ribbon: dừng và hủy phần lệnh cũ theo app, xác nhận buffer được xử lý, đối soát phần đã in rồi tạo lượt mới cùng cuộn. Giữ nguyên counter. Khi in lại, kiểm ngay tem đầu theo quy tắc trên; dùng PAUSE để đọc đúng tem nếu cần, không mở đầu in chỉ để lấy mẫu. Mẫu đạt thì giữ lại và tiếp tục. Mẫu FAIL thì giữ phần từ điểm khôi phục đến lúc dừng, báo người phụ trách và xử lý nguyên nhân trước khi chạy lại.

Không có yêu cầu mặc định kiểm 10 tem. PAUSE chỉ để lấy mẫu, không đổi vật tư/cấu hình/queue, không kích hoạt thêm một vòng kiểm sau gián đoạn vô hạn. Một mẫu đạt sau phục hồi cũng không tự giải phóng đoạn nghi ngờ trước đó. Nếu lỗi chỉ được phát hiện ở giữa/cuối và không xác định được điểm bắt đầu, giữ toàn cuộn để quyết định phạm vi kiểm.

Về phần mềm, bản 3.3.0 gửi chunk RFID tối đa 10 và giới hạn dữ liệu gửi trước; khi quan sát fault, connector khóa lượt, gửi pause/clear và chặn Resume/append. ZPL dùng `^JZN` để tắt cơ chế tự reprint do lỗi; không tự reconnect rồi replay chunk chưa rõ kết quả. Tài liệu Zebra mô tả `^JZ` điều khiển reprint sau ribbon out, media out hoặc head open. [Zebra ZPL Programming Guide](https://cpws.zebra.com/cpws/docs/zpl/zpl-zbi2-pm-en.pdf), [Zebra reprint command](https://cpws.zebra.com/cpws/docs/zpl/zpl_reprint.htm).

Chunk 10 không có nghĩa là app cố ý in thêm đúng 10 sau khi mở đầu. Máy đã nhận buffer, độ trễ mạng và thời điểm polling khiến số tem tiếp tục ra có thể khác. Khi mất mạng, lệnh hủy có thể không tới máy; nhân viên cần giữ máy dừng, không Resume trước khi xử lý. SOP giữ kiểm đầu theo sự kiện chính vì phần mềm không chứng minh được trạng thái cơ học chỉ từ việc gửi byte thành công.

## 5. Một hồ sơ cuộn và ghi nhận tối thiểu

BM01 thể hiện nội dung cần lưu; **dùng ghi chú app hoặc bản điện tử/giấy tương đương**, không yêu cầu cả hai. App đã giữ Job/Roll/Run, nguồn/lot, template và người vận hành thì hồ sơ ngoài chỉ tham chiếu, không chép lại 2500 EPC.

| Khi nào | Nội dung thêm tối thiểu |
|---|---|
| Đầu cuộn | Xác nhận đúng việc và counter 0/0; không bắt buộc ảnh riêng |
| Mỗi mẫu kiểm | Mốc; VALID lúc kiểm; full EPC hoặc tham chiếu ảnh/log chứa EPC; đạt/không đạt |
| Sau thay đổi | Thao tác/thời điểm; kết quả kiểm tem đầu; có thể nằm cùng dòng ghi chú mẫu |
| Kết thúc | Counter cuối, GOOD và VOID giữ, chiều tháo; xác nhận mẫu đạt và không còn phần nghi ngờ |
| Có lỗi | Vùng giữ, EPC/ordinal bị loại nếu xác định được, xử lý và người quyết định |
| Bàn giao | CSV và nhãn lõi đúng ID; đường dẫn/tham chiếu workspace và kiểm đã có đúng file |

Ví dụ một dòng ghi chú: `Thay ribbon; V=1675; EPC=<full EPC hoặc link log>; chip/mặt in đạt; tiếp tục cùng cuộn`. Nếu reader xuất log, tham chiếu bản lưu đó để giảm gõ lại EPC dài. VALID lúc kiểm chỉ là mốc tương đối, không tự trở thành thứ tự chính xác của tem đang cầm vì máy có thể đã in tiếp.

Trạng thái upload xảy ra sau chốt. App đã chốt không sửa ghi chú; “chờ upload/đã upload” được theo dõi trong BM01 hoặc cơ chế workspace của phòng in. Chưa quy định thêm deadline, thư mục cloud, người nhận hoặc thời hạn giữ hồ sơ thay người dùng. Upload vẫn là công việc thủ công theo quy định họ sẽ ban hành.

## 6. Mã và quan hệ truy xuất

Quy ước tạm dùng `NW-MATERIAL-YYMMDD-NNN`; ví dụ Job `NW-4520-261016-001`, Roll `NW-4520-261016-001_01`. Một yêu cầu 10000 GOOD tạo bốn cuộn `_01` đến `_04`. Số Job cấp từ một sổ chung, không để mỗi PC tự cấp trùng. Các mã 4520, 5030, 5434 là mã vật tư/kích thước đã thống nhất; không tự suy ra mọi đặc tính inlay từ kích thước.

Quan hệ hồ sơ là `EPC → Run → Roll → Job`, kèm nguồn cuộn trắng/lot, template và người vận hành. Dùng full EPC, giữ số 0 đầu; phần suffix in trên nhãn chỉ dùng đối chiếu theo quy ước template. Một EPC trong danh sách giao truy về được Job, cuộn và thứ tự GOOD theo chiều tháo đã chốt. App lưu dữ liệu này nhưng chưa có ô tìm EPC tập trung toàn công ty; khi mở rộng nhiều trạm cần lớp tra cứu/index chung.

Với 4520 thiếu nguồn, ví dụ lượt đầu 2300 đạt rồi nguồn khác bù 200, vẫn là cùng Roll ID và counter không reset. Với template chỉ đọc EPC, nối phần in bù tiếp sau phần đã in; khi chốt chọn đúng chiều tháo. Nếu đảo toàn cuộn, app đảo toàn danh sách GOOD. Không chèn/đảo một đoạn riêng rồi giữ CSV cũ vì thứ tự vật lý đã khác.

Với template theo danh sách serial/data feed, người điều phối cấp dải riêng từng cuộn, ví dụ 1…2500 và 2501…5000. App kiểm tiếp nối trong từng cuộn; chưa có registry giữ chỗ dải toàn Job trên nhiều PC. Nếu loại tem giữa dải, không âm thầm in dòng đó ra cuối rồi coi thứ tự vẫn đúng; chuyển kỹ thuật phục hồi thứ tự. Đây là ngoại lệ của đơn hàng tuần tự, không tăng thao tác cho template chỉ đọc EPC.

## 7. CSV thể hiện được gì

Tên final hiện có dạng `<RollID>_FINAL_YYYY-MM-DD_HH-mm-ss_epc_Read_r<revision>.csv`; TXT nhãn lõi dùng `<RollID>_CORE_LABEL.txt`. Tải lại cùng final giữ cùng nội dung/tên theo thời điểm chốt. Bản PROVISIONAL là dữ liệu tạm, không dùng bàn giao.

CSV chứa ID Job/cuộn/run, `good_label_ordinal`, EPC, source row nếu có, thời gian host, offset/UTC, nguồn vật tư/lot, template/hash, người thực hiện, kết quả, sự kiện đối soát và tổng hợp. Chỉ dòng `label_readback` có kết quả `GOOD_OPERATOR_RELEASED` là danh sách tem giao, với `qc_method=sampled`.

VOID được đối soát **tổng phiên/cuộn**, đúng lựa chọn ưu tiên tốc độ theo chunk. Các dòng `VOID_TOTAL` hoặc `VOID_TOTAL_UNKNOWN` nêu tổng/không biết; không tự tạo EPC hay vị trí cho từng VOID. `NO_READBACK` là thiếu phản hồi, không đồng nghĩa VOID. Vì có dòng tổng hợp/sự kiện, CSV hơn 2500 dòng là bình thường; chỉ đếm dòng GOOD để đối soát thành phẩm.

Ví dụ thời gian `2026-10-14T02:44:00.6128408Z` là UTC, tương ứng 09:44 tại UTC+7. Báo cáo có giờ local/offset cùng UTC gốc, lấy từ PC connector khi nhận phản hồi. Đây không phải timestamp cơ học chính xác lúc tem rời đầu in; không dùng nó thay ordinal để xác định thứ tự. Khi đọc CSV bằng Excel cần import EPC dưới dạng Text để bảo toàn giá trị dài và số 0 đầu.

Dữ liệu gốc của app cài đặt nằm tại `%APPDATA%\ZbrePrinter\connector\rfid-sessions`; các thư mục capture/production dùng tên nội bộ, không đổi tên thủ công. Bằng chứng gốc tự lưu nhằm phục hồi khi gián đoạn; báo cáo final chỉ xuất theo yêu cầu và có archive/receipt. Bản local vẫn cần được nhân viên đưa lên workspace theo quy định để tránh phụ thuộc một PC.

## 8. Cắt thao tác nào và vẫn giữ kiểm soát nào

| Điểm cần tinh gọn hoặc làm rõ | Cách xử lý trong Rev05 | Kiểm soát còn giữ |
|---|---|---|
| Ba mẫu F01/F02/F03 có nhiều mục lặp | Một hồ sơ cuộn, dữ liệu app được tham chiếu | ID, nguồn, mẫu, xử lý lỗi và bàn giao vẫn truy được |
| Mặc định kiểm/loại 10 tem phục hồi | Kiểm ngay tem đầu; kiểm mở rộng khi có lý do | Kiểm đúng biên sau thao tác dễ phát sinh sai cặp |
| Nguy cơ nhầm mẫu kiểm với tem thử phải loại | Ghi rõ mẫu kiểm đạt, không phá hủy được giữ trên cuộn | Counter không cần cộng thêm phần mẫu vô ích |
| Ảnh reset và chữ ký phụ ở các bước bình thường | Nhìn xác nhận 0/0; operator ghi một lần; supervisor xử lý ngoại lệ | Trách nhiệm rõ mà không chờ phê duyệt lặp |
| Cân toàn bộ vật tư trong thao tác mỗi cuộn | GOOD từ counter/QC; VOID riêng; chi tiết khi loại/mất mốc | Không làm sai số khi có ngoại lệ thật |

Đây là giảm nội dung phải đọc và ghi trong ngày, không bỏ các dấu hiệu cần dừng. Năm bước là cấu trúc hướng dẫn, không phải tuyên bố app chỉ cần năm lần bấm.

## 9. Luận chứng hiệu quả và giới hạn

**Giảm công bằng cách ghi một lần và dùng lại.** ID đã có trong app đi theo CSV/nhãn lõi; bằng chứng EPC được máy ghi, người chỉ thêm quyết định QC. Với cuộn bình thường không gián đoạn, phần đọc độc lập là ba mẫu và một lần chốt. Có k thay đổi ảnh hưởng thì thêm kiểm đầu tương ứng, không bắt một bộ mười mẫu ở mỗi thay đổi. Hai mốc trùng cùng một mẫu có thể ghi rõ để tránh kiểm lặp.

**Kiểm ở thời điểm rủi ro phát sinh.** Hiện tượng người dùng mô tả là sai mặt in ở tem đầu sau thay vật tư. Kiểm ngay biên đó phù hợp cơ chế nghi ngờ hơn đợi cuối cuộn. Đây là suy luận từ quan sát thực tế của Nextwaves; chưa phải kết luận nguyên nhân firmware đã được chứng minh. Khi mẫu lỗi, dừng và giữ vùng ảnh hưởng hạn chế đưa tiếp lỗi vào hàng giao.

**Đối soát hai loại bằng chứng.** Counter phục vụ số lượng; hồ sơ EPC phục vụ danh tính, trùng/thiếu và quan hệ cuộn; reader độc lập đối chiếu chip với mặt in tại các mẫu. Ba nguồn có nhiệm vụ khác nhau, nên không thể thay tất cả bằng một con số VALID. App chặn hồ sơ không nhất quán giúp không buộc operator tự so 2500 dòng bằng mắt.

Thiết kế tham khảo nguyên lý jidoka của Toyota: làm cho công việc dễ thực hiện, phát hiện bất thường và dừng để xử lý; áp dụng ở đây là dừng khi mẫu FAIL hoặc số liệu lệch. Đây không phải tuyên bố Toyota dùng SOP hay phần mềm Zebra này. [Toyota Production System](https://global.toyota/en/company/vision-and-philosophy/production-system/).

ASQ mô tả mistake-proofing là ngăn sai sót hoặc làm sai sót hiện ra ngay. Khóa template/ID, dùng cùng dữ liệu cho báo cáo và kiểm điều kiện chốt là cách áp dụng cụ thể để giảm nhập lại và bỏ sót. [ASQ mistake-proofing](https://asq.org/quality-resources/mistake-proofing). Theo tư duy quản trị vận hành, phần ổn định được chuẩn hóa; nguồn lực của người phụ trách tập trung vào ngoại lệ có ảnh hưởng thay vì duyệt lại mọi bước bình thường.

Không thể chứng minh “không có một tem sai” bằng đầu/giữa/cuối. Minh họa toán học: nếu một lỗi nằm ngẫu nhiên trong 2500 vị trí và kiểm ba vị trí khác nhau, xác suất bắt được lỗi chỉ là 3/2500 = 0,12%. Đây không phải tỷ lệ lỗi của Nextwaves và không mô tả lỗi tập trung sau thay ribbon. Vì vậy SOP ghi QC lấy mẫu, kiểm thêm tại biên sự kiện, giữ vùng nghi ngờ và truy xuất; không ghi đã kiểm độc lập 100%. Nếu sau này cần bằng chứng đúng chip–mặt in cho từng tem, phải thêm kiểm 100% có đồng bộ vị trí và cơ chế xử lý tem lỗi, rồi nghiệm thu trên máy thật.

Chưa đo thời gian tiết kiệm hoặc tỷ lệ giảm lỗi, nên không gán phần trăm cải thiện. Hiệu quả có thể kiểm chứng bằng: thời gian thao tác ngoài thời gian máy chạy/cuộn; tỷ lệ cuộn có đủ CSV và nhãn lõi đúng ID; số chênh lệch chưa giải quyết tại bàn giao; thời gian truy một EPC về cuộn/run; số sự kiện thay vật tư có mẫu đầu được ghi. Lỗi chip–mặt in phải báo trên số tem thực đã kiểm, không suy rộng thành tỷ lệ của cả 2500.

## 10. Phần cần xác nhận trước áp dụng và hướng cải tiến sau

Người phụ trách nghiệm thu mỗi tổ hợp ZT610R/ZD621R, firmware, vật tư/inlay, ribbon, template và thông số: ý nghĩa VALID/VOID với read-only; thay giấy/ribbon và head-open; mạng gián đoạn; bù cuộn thiếu; thứ tự sau cuốn; hồ sơ khi thiếu/trùng phản hồi. Firmware `10.6.26.28275` là thông tin người dùng cung cấp, không tự coi hai model có hành vi giống nhau. Dừng nghiệm thu khi còn sai cặp, tự replay hoặc trạng thái buffer chưa kiểm soát.

Nhân viên chỉ làm việc theo tổ hợp đã duyệt. Giữ một PC/connector điều khiển máy trong phiên; khóa endpoint của app không bao phủ mọi PC hoặc bí danh IP khác. USB-B/Windows spool và tuyến Godex riêng chưa có bằng chứng tương đương TCP capture trong mô hình này. Các mẫu 7823 gập và on-metal 1,5 mm vẫn theo tuyến/cấu hình riêng trong hồ sơ vật tư gốc, không đưa vào quy trình Zebra chung chỉ vì cùng phòng in.

Để rút thêm thao tác trên app ở vòng phát triển sau, có thể làm các lựa chọn QC ngắn dùng lại theo cuộn, nhắc tem đầu theo sự kiện quan sát được, hiển thị bước chốt gọn và liên kết nơi lưu workspace. **Các mục này chưa được triển khai trong lần sửa SOP này.** Không xóa lịch sử gốc hoặc nới điều kiện đối soát chỉ để giảm số lần bấm.

Kiểm thử phần mềm của bản 3.3.0 được giữ trong `VALIDATION_3.3.0.md`. Kết quả simulator/build không thay nghiệm thu máy thật. Các lần chỉnh tài liệu Rev05/Rev06 kiểm tra nội dung và bố cục, không gửi lệnh in và không tạo bộ cài mới.

Rev05 đã rút gọn hướng dẫn vận hành/biểu mẫu của Rev04; Rev06 tiếp nối luồng đó và bổ sung kiểm soát ban hành. Bản cũ giữ để tra lịch sử, không dùng song song làm yêu cầu thêm. Tài liệu gốc trên ổ G được giữ nguyên. Người phụ trách xác nhận quy định workspace và ký hiệu lực trước khi ban hành; không cần nhân viên tự lập thêm bộ hồ sơ khác ngoài dữ liệu tối thiểu đã nêu.

## 11. Rà soát mức đầy đủ của SOP và bản treo tường

**Kết luận:** Rev05 đã rõ về mục đích/phạm vi, thao tác, mốc kiểm, tiêu chí chốt, xử lý lỗi và truy xuất. Phần còn thiếu là cách kiểm soát việc ban hành và trách nhiệm, không phải tăng số mẫu hay thêm phiếu. Rev06 bổ sung một trang dành cho người phụ trách; năm bước vận hành và BM01 giữ nguyên.

| Cấu phần | Đánh giá và xử lý trong Rev06 |
|---|---|
| Mục đích, phạm vi, thiết bị và phiên bản | Đã có; phân biệt SOP Rev06, poster Rev01, app 3.3.0, connector 0.7.0 |
| Thao tác và tiêu chí đạt | Giữ counter một lần/cuộn, kiểm mẫu theo mốc/sự kiện, chốt có điều kiện và xuất chủ động |
| Trách nhiệm và năng lực | Nêu operator được hướng dẫn; kỹ thuật duyệt tổ hợp/template; phụ trách cấp mã và quyết định ngoại lệ; người nhận đối chiếu |
| Hàng nghi ngờ | Gắn HOLD - CHƯA BÀN GIAO với Roll ID/lý do, tách hàng đạt; chỉ người phụ trách được ủy quyền quyết định giải phóng |
| Hồ sơ và sửa đổi | Liên kết CSV/QC/nhãn lõi bằng Roll ID; giữ bản cũ và dấu vết quyết định khi sửa sai; không ghi đè final |
| Kiểm soát tài liệu | Có ngày hiệu lực/phê duyệt, nguồn bản được kiểm soát, thay poster khi đổi revision và đánh dấu bản cũ chỉ tra cứu |
| Tài liệu dùng kèm | Danh mục template/tổ hợp đã duyệt, hướng dẫn hãng, BM01 và quy định workspace |

ISO 10013:2021 hướng dẫn phát triển và duy trì thông tin dạng văn bản phù hợp nhu cầu tổ chức. Vì vậy, tính đầy đủ cần đánh giá theo việc quy trình có dùng được và kiểm soát được hay không; số trang hoặc hình thức poster không tự chứng minh tuân thủ tiêu chuẩn. Phần bổ sung là thiết kế áp dụng cho Nextwaves, không phải trích nguyên văn điều khoản và không phải xác nhận chứng nhận ISO. [ISO 10013:2021, nguồn chính thức](https://www.iso.org/standard/75736.html).

Trước hiệu lực, chủ quy trình cần hoàn tất **một lần cho cả phòng**:

1. Chỉ định người phụ trách/ủy quyền, xác nhận người vận hành đã được hướng dẫn và tổ hợp máy–template đã nghiệm thu.
2. Chốt quy định workspace: nơi lưu, người quản lý quyền truy cập/sao lưu, thời hạn upload, thời hạn giữ và cách kiểm khôi phục. Trang 6 cho phép dẫn chiếu một chính sách chung; không tự áp đặt số năm lưu hoặc deadline chưa được người dùng chốt.
3. Ký/ngày hiệu lực; thay bản tại máy và bản treo tường cũ. Khi có thay đổi ảnh hưởng hoặc lỗi cho thấy kiểm soát chưa đủ, rà lại tài liệu.

Poster mới dùng mã **WI-PRD-RFID-003-P01 Rev01**, tham chiếu **SOP-PRD-RFID-003 Rev06**. Rev01 là phiên bản đầu của mã poster mới, không sao chép số Rev06 của SOP. Khi ban hành, thay bản treo cũ mang mã SOP-PRD-RFID-001 phiên bản 1.0 để không cùng tồn tại chỉ dẫn khác nhau.

Thiết kế poster giữ ba cột màu, logo và luồng mũi tên của PDF tham khảo, chuyển thành năm bước hiện tại. Khổ A3 ngang để đọc tại trạm; số 2500 và kiểm tem đầu sau thay đổi được nhấn mạnh. Loại bỏ quy định cũ in năm tem mẫu cố định, phân loại Express/Trial hoặc nhiều phiếu QC vì không còn là thao tác thường ngày đã thống nhất. Bản treo tường là nhắc việc, không thay phần ngoại lệ/HOLD và hồ sơ trong SOP.

Phạm vi kiểm chứng của lần này: rà nội dung chéo giữa poster/SOP/app hiện tại, kiểm phiên bản, giữ nguyên bản nguồn, dựng và kiểm bằng hình ảnh toàn bộ PDF/DOCX. Thao tác phát hành thực tế và nghiệm thu máy thuộc chủ quy trình, không được coi là đã hoàn tất chỉ vì tài liệu đã được soạn.
