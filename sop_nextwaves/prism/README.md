# Nextwaves poster editable LaTeX

- `main.tex`: toàn bộ chữ, khối, màu và mũi tên đều sửa được bằng LaTeX/TikZ.
- `nextwaves-logo.png`: logo gốc lấy từ PDF tham khảo, giữ nguyên điểm ảnh. Đặt cùng thư mục với main.tex để hiện đúng logo. Nếu chỉ nhập main.tex, tài liệu dùng chữ Nextwaves thay thế và vẫn biên dịch được.
- Khổ A3 ngang, một trang. Poster Rev01, theo SOP Rev06; app 3.3.0 và connector 0.7.0 không đổi.

Dùng UTF-8. Khuyến nghị XeLaTeX hoặc LuaLaTeX; có nhánh tương thích pdfLaTeX với các gói tiếng Việt T5/babel/lmodern. Font tự dùng Arial nếu có, nếu không dùng TeX Gyre Heros. Font thay thế có thể làm ngắt dòng khác đôi chút so với PDF gốc.

Các phần dễ sửa trong main.tex:

1. Khối Versions: mã tài liệu, revision, app, ngày soạn, ví dụ Roll ID.
2. Khối Colours: mã màu HTML.
3. `\StepCard`: số bước, tiêu đề, tọa độ, kích thước và màu khối.
4. `\PosterText`, `\BulletText`: nội dung, tọa độ, độ rộng, cỡ chữ và giãn dòng.
5. Khối Flow arrows: đường đi mũi tên.

Tọa độ tính bằng bp (1/72 inch), gốc ở góc trên trái. Tăng x để dịch phải, tăng y để dịch xuống. Chỉ thay đổi định dạng không làm tăng revision quy trình; nếu sửa yêu cầu vận hành, cập nhật revision và phê duyệt theo SOP.

Không có đường dẫn máy cá nhân, lệnh shell hoặc tài nguyên tải từ mạng trong main.tex. Khi sửa nhiều chữ, kiểm lại PDF để tránh chữ tràn hoặc đè sang khối khác.
