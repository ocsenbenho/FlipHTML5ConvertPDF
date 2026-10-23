# Flipbook to PDF – Chrome Extension

Tự động quét, lật trang và tải flipbook HTML5 thành file PDF.

> ⚠️ **Lưu ý**: Chỉ sử dụng cho tài liệu bạn sở hữu hoặc có quyền tải. Extension không xử lý nội dung có DRM hay yêu cầu đăng nhập trả phí.

---

## 📦 Cài đặt

1. **Tải source code** về máy (hoặc clone repo).

2. Mở Chrome, truy cập: `chrome://extensions/`

3. Bật **Developer mode** (Chế độ nhà phát triển) ở góc trên bên phải.

4. Nhấn **Load unpacked** (Tải tiện ích chưa đóng gói).

5. Chọn thư mục `flipbook-dl/` (thư mục chứa `manifest.json`).

6. Extension sẽ xuất hiện trên thanh toolbar – nhấn vào icon 📖 để mở popup.

---

## 🚀 Cách dùng

### Bước 1: Mở flipbook
Truy cập trang flipbook HTML5 bạn muốn tải (FlipHTML5, AnyFlip, Heyzine, hoặc bất kỳ nền tảng nào).

### Bước 2: Quét trang
Nhấn vào icon extension trên toolbar → nhấn **🔍 Quét trang**.

Extension sẽ:
- Nhận diện nền tảng flipbook
- Quét DOM, config, và network để tìm ảnh trang
- Hiển thị số trang tìm thấy

### Bước 3: Tự lật & Tải PDF
Nhấn **⚡ Tự lật & Tải PDF**.

Extension sẽ:
1. Tự động lật từng trang để kích hoạt lazy load
2. Thu thập ảnh mỗi trang
3. Ghép tất cả thành 1 file PDF
4. Mở hộp thoại tải file

### Các nút điều khiển
- **⏸ Tạm dừng**: Dừng lật trang (có thể tiếp tục)
- **▶ Tiếp tục**: Tiếp tục lật sau khi tạm dừng
- **✕ Hủy**: Dừng hoàn toàn

### Tùy chọn
Mở phần **⚙ Tùy chọn** để điều chỉnh:
- **Tốc độ lật**: Thời gian chờ giữa các lần lật (mặc định 800ms)
- **Chất lượng JPG**: Chất lượng ảnh khi chuyển đổi WebP → JPG (mặc định 92%)
- **Từ trang / Đến trang**: Chỉ tải một khoảng trang cụ thể

---

## 🏗 Cấu trúc thư mục

```
flipbook-dl/
├── manifest.json         # Cấu hình Manifest V3
├── background.js         # Service worker: sniff network, điều phối message
├── content.js            # Quét DOM, điều khiển auto-flip
├── popup.html/js/css     # Giao diện popup
├── offscreen.html/js     # Fetch ảnh, chuyển đổi, ghép PDF (cần DOM)
├── adapters/
│   ├── generic.js        # Adapter mặc định (DOM + network heuristic)
│   ├── fliphtml5.js      # Adapter cho FlipHTML5
│   ├── anyflip.js        # Adapter cho AnyFlip / FlipBuilder
│   └── heyzine.js        # Adapter cho Heyzine
├── lib/
│   └── pdf-lib.min.js    # Thư viện ghép PDF (cục bộ, không CDN)
└── README.md
```

---

## 🔧 Nền tảng được hỗ trợ

| Nền tảng | Nhận diện | Ghi chú |
|---|---|---|
| **FlipHTML5** | ✅ Tự động | Đọc `bookConfig`, `defined_pagesCount` |
| **AnyFlip** | ✅ Tự động | Đọc `defined_totalPage`, `defined_basePath` |
| **Heyzine** | ✅ Tự động | Đọc `__NEXT_DATA__` |
| **Khác** | ✅ Generic | Quét DOM + phân tích network URL pattern |

---

## 🐛 Xử lý lỗi thường gặp

### "Không tìm thấy trang nào"
- **Nguyên nhân**: Trang chưa load xong hoặc ảnh dùng format đặc biệt.
- **Cách xử lý**:
  1. Lật vài trang thủ công trước để kích hoạt lazy load.
  2. Chờ vài giây rồi nhấn **Quét trang** lại.

### "Lỗi fetch ảnh"
- **Nguyên nhân**: Server chặn cross-origin request hoặc ảnh cần authentication.
- **Cách xử lý**:
  1. Đảm bảo bạn đã đăng nhập vào trang chứa flipbook.
  2. Thử reload trang và quét lại.

### "PDF bị thiếu trang"
- **Nguyên nhân**: Một số trang tải thất bại.
- **Cách xử lý**:
  1. Giảm tốc độ lật (tăng thời gian chờ lên 1500-2000ms).
  2. Kiểm tra nhật ký trong popup để biết trang nào bị lỗi.

### "Extension không phản hồi"
- Mở `chrome://extensions/` → tìm "Flipbook to PDF" → nhấn **Service worker** > **Inspect** để xem console log.

---

## 🔒 Quyền sử dụng

| Quyền | Lý do |
|---|---|
| `activeTab` | Truy cập tab đang mở để quét và lật trang |
| `scripting` | Inject content script vào trang flipbook |
| `webRequest` | Theo dõi network request để phát hiện URL ảnh |
| `downloads` | Tải file PDF về máy |
| `storage` | Lưu tùy chọn người dùng |
| `offscreen` | Tạo offscreen document để xử lý ảnh và ghép PDF |
| `<all_urls>` | Hỗ trợ tải ảnh từ mọi domain (flipbook host khác nhau) |

---

## 📋 Debug

1. Mở `chrome://extensions/`
2. Bật **Developer mode**
3. Tìm "Flipbook to PDF"
4. Nhấn link **Service worker** → cửa sổ DevTools mở ra với console log
5. Nhấn **Inspect views: popup.html** (khi popup đang mở) để debug popup
6. Mở DevTools của trang flipbook (F12) để xem log content script (`[Flipbook-DL]`)

---

## 📄 License

MIT – Sử dụng có trách nhiệm, chỉ cho tài liệu bạn được phép tải.
