/**
 * background.js – Service Worker (Manifest V3)
 * Điều phối: sniff network, mở offscreen, trung chuyển message giữa content ↔ offscreen.
 */

/* ────────────── Biến trạng thái ────────────── */
let networkImages = new Map(); // tabId -> Set<url>
let offscreenCreated = false;

/* ────────────── Network Sniffing ────────────── */
// Lọc các request ảnh trả về thành công để hỗ trợ phát hiện pattern
chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url;
    // Chỉ quan tâm ảnh
    const isImage =
      /\.(jpe?g|png|webp|avif|bmp|gif|svg)(\?|$)/i.test(url) ||
      (details.responseHeaders ?? []).some(
        (h) => h.name.toLowerCase() === 'content-type' && h.value?.startsWith('image/')
      );
    if (!isImage) return;

    if (!networkImages.has(details.tabId)) {
      networkImages.set(details.tabId, new Set());
    }
    networkImages.get(details.tabId).add(url);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// Dọn dẹp khi tab đóng
chrome.tabs.onRemoved.addListener((tabId) => {
  networkImages.delete(tabId);
});

/* ────────────── Offscreen Document ────────────── */
async function ensureOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctx.length > 0) return;
    }
  } catch { /* bỏ qua */ }
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER', 'BLOBS'],
      justification: 'Fetch ảnh, chuyển đổi WebP→JPG và ghép PDF bằng pdf-lib'
    });
    await new Promise((r) => setTimeout(r, 300)); // chờ offscreen.js đăng ký listener
  } catch (e) {
    if (!e.message?.includes('already exists')) throw e;
  }
}

/* ────────────── Message Router ────────────── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = messageHandlers[msg.type];
  if (handler) {
    handler(msg, sender, sendResponse);
    return true; // Giữ kênh sendResponse mở cho async
  }
});

/* ────────────── Quản lý Nhật ký & Sự kiện ────────────── */
const recentLogs = [];

function logToPopup(source, text, level = 'info', hint = '') {
  const entry = {
    source, // 'system' | 'tab' | 'shot' | 'offscreen' | 'pdf' | 'download'
    text,
    level, // 'info' | 'warn' | 'error' | 'success'
    hint,
    time: new Date().toLocaleTimeString('vi-VN', { hour12: false })
  };
  recentLogs.push(entry);
  if (recentLogs.length > 200) recentLogs.shift();
  broadcast({ type: 'LOG_MESSAGE', ...entry });
  console.log(`[Flipbook-DL][${source.toUpperCase()}] ${text}${hint ? ' | Cần xử lý: ' + hint : ''}`);
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

/* ────────────── Chế độ chụp màn hình ────────────── */
let shotRunning = false;
let shotCancelled = false;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const broadcast = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

/** Hàm chạy TRONG trang: tìm khung hiển thị chính xác của cuốn sách (loại bỏ thanh công cụ và khoảng đen) */
function findBookRectInPage() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  function isValidBookRect(r) {
    if (!r) return false;
    const w = r.width || r.w || 0;
    const h = r.height || r.h || 0;
    if (w < 120 || h < 120) return false;
    // Khung cuốn sách không thể bao trọn 100% cả chiều rộng lẫn chiều cao màn hình (vì luôn có thanh công cụ hoặc viền trang trí)
    if (w >= vw * 0.98 && h >= vh * 0.98) return false;
    return true;
  }

  function formatRect(r, source) {
    const x = Math.max(0, Math.round(r.left !== undefined ? r.left : r.x));
    const y = Math.max(0, Math.round(r.top !== undefined ? r.top : r.y));
    const w = Math.min(vw - x, Math.round(r.width !== undefined ? r.width : r.w));
    const h = Math.min(vh - y, Math.round(r.height !== undefined ? r.height : r.h));
    return { x, y, w, h, vw, vh, source };
  }

  // 1. Tọa độ chính xác từ API chính thức của FlipHTML5: window.BookInfo
  try {
    if (window.BookInfo && typeof window.BookInfo.left === 'function' && typeof window.BookInfo.top === 'function' &&
        typeof window.BookInfo.width === 'function' && typeof window.BookInfo.height === 'function') {
      const rect = {
        left: window.BookInfo.left(),
        top: window.BookInfo.top(),
        width: window.BookInfo.width(),
        height: window.BookInfo.height()
      };
      if (isValidBookRect(rect)) return formatRect(rect, 'BookInfo.api');
    }
  } catch {}

  // 2. Kiểm tra container phần tử sách từ BookInfo.container() hoặc BookInfo.getBook()
  try {
    const bookObj = window.BookInfo?.getBook?.() || window.flipBook || window.singlePageBook;
    
    // Thuộc tính parameters: { width, height, left, top }
    const params = bookObj?.parameters;
    if (params && params.width > 120 && params.height > 120) {
      const pRect = {
        left: params.left !== undefined ? params.left : (vw - params.width) / 2,
        top: params.top !== undefined ? params.top : (vh - params.height) / 2,
        width: params.width,
        height: params.height
      };
      if (isValidBookRect(pRect)) return formatRect(pRect, 'bookObj.parameters');
    }

    // Các biến thể DOM element của bookObj
    const bookEl = bookObj?.flipBookElement?.[0] || bookObj?.flipBookElement ||
                   bookObj?.container?.[0] || bookObj?.container ||
                   bookObj?.stage?.[0] || bookObj?.stage ||
                   bookObj?.$book?.[0] || bookObj?.book?.[0] ||
                   bookObj?.$element?.[0] || bookObj?.element?.[0] ||
                   bookObj?.[0];
    if (bookEl?.getBoundingClientRect) {
      const r = bookEl.getBoundingClientRect();
      if (isValidBookRect(r)) return formatRect(r, 'bookObj.dom');
    }
  } catch {}

  // 3. Bao quanh tất cả các thẻ <canvas> hiển thị trang sách đang mở
  // FlipHTML5 luôn vẽ từng trang sách lên thẻ canvas!
  try {
    const canvases = Array.from(document.querySelectorAll('canvas')).filter((cv) => {
      const cs = getComputedStyle(cv);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) <= 0.05) return false;
      const r = cv.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) return false; // bỏ qua icon, thanh bar
      if (r.width >= vw * 0.98 && r.height >= vh * 0.98) return false; // bỏ qua canvas full màn hình
      if (r.right <= 10 || r.bottom <= 10 || r.left >= vw - 10 || r.top >= vh - 10) return false;
      return true;
    });

    if (canvases.length > 0) {
      let minX = vw, minY = vh, maxX = 0, maxY = 0;
      for (const cv of canvases) {
        const r = cv.getBoundingClientRect();
        minX = Math.min(minX, Math.max(0, r.left));
        minY = Math.min(minY, Math.max(0, r.top));
        maxX = Math.max(maxX, Math.min(vw, r.right));
        maxY = Math.max(maxY, Math.min(vh, r.bottom));
      }
      const cRect = { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
      if (isValidBookRect(cRect)) return formatRect(cRect, `canvases(${canvases.length})`);
    }
  } catch {}

  // 4. Bao quanh tất cả các thẻ <img> hiển thị trang sách đang mở
  try {
    const imgs = Array.from(document.querySelectorAll('#bookContainer img, .bookContainer img, #flipbook img, .magazine img, .turn-page img, .page img')).filter((img) => {
      const cs = getComputedStyle(img);
      if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) <= 0.05) return false;
      const r = img.getBoundingClientRect();
      if (r.width < 120 || r.height < 120) return false;
      if (r.width >= vw * 0.98 && r.height >= vh * 0.98) return false;
      if (r.right <= 10 || r.bottom <= 10 || r.left >= vw - 10 || r.top >= vh - 10) return false;
      return true;
    });

    if (imgs.length > 0) {
      let minX = vw, minY = vh, maxX = 0, maxY = 0;
      for (const img of imgs) {
        const r = img.getBoundingClientRect();
        minX = Math.min(minX, Math.max(0, r.left));
        minY = Math.min(minY, Math.max(0, r.top));
        maxX = Math.max(maxX, Math.min(vw, r.right));
        maxY = Math.max(maxY, Math.min(vh, r.bottom));
      }
      const iRect = { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
      if (isValidBookRect(iRect)) return formatRect(iRect, `imgs(${imgs.length})`);
    }
  } catch {}

  // 5. Thử các selector phần tử sách thực sự (loại bỏ hoàn toàn #bookContainer vì nó luôn chiếm 100% cửa sổ)
  const bookSelectors = [
    '.turn-page-wrapper', '.turn-page', '.magazine', '#book', '#flipbook',
    '.flowpaper_viewer', '.heyzine-container', '.stage-container', '#centerWindow'
  ];
  for (const sel of bookSelectors) {
    try {
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els) {
        const r = el.getBoundingClientRect();
        if (isValidBookRect(r)) return formatRect(r, `selector(${sel})`);
      }
    } catch {}
  }

  // 6. Tính toán kích thước hình học chính xác từ bookConfig (pageWidth & pageHeight)
  try {
    const bc = window.bookConfig;
    const pw = parseInt(bc?.largePageWidth || bc?.pageWidth || 0);
    const ph = parseInt(bc?.largePageHeight || bc?.pageHeight || 0);
    if (pw > 100 && ph > 100) {
      let isDouble = true;
      try {
        if (typeof window.BookInfo?.isDoublePage === 'function') {
          isDouble = window.BookInfo.isDoublePage();
        } else if (bc?.showDoublePage === 'single') {
          isDouble = false;
        }
      } catch {}

      // Kiểm tra xem trang hiện tại có phải là bìa (cover #1) không
      let isSingleCover = false;
      try {
        const cur = window.BookInfo?.getCurrentPages?.();
        if (cur && (cur.length === 1 || cur.includes(1))) isSingleCover = true;
      } catch {}

      const totalBookW = (isDouble && !isSingleCover) ? pw * 2 : pw;
      const totalBookH = ph;

      // Trừ thanh công cụ trên (thường 40px) và dưới (thường 45px)
      const topBarH = 45;
      const botBarH = 50;
      const availW = Math.max(200, vw - 80);
      const availH = Math.max(200, vh - topBarH - botBarH);

      const scale = Math.min(availW / totalBookW, availH / totalBookH);
      const w = Math.round(totalBookW * scale);
      const h = Math.round(totalBookH * scale);
      const x = Math.round((vw - w) / 2);
      const y = Math.round(topBarH + (availH - h) / 2);

      return formatRect({ left: x, top: y, width: w, height: h }, 'bookConfig.calc');
    }
  } catch {}

  console.warn('[Flipbook-DL] Không phát hiện được khung sách riêng biệt.');
  return null;
}

async function getBookRect(tabId) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: findBookRectInPage
    });
    return res?.[0]?.result || null;
  } catch {
    return null;
  }
}

/**
 * Chờ trang sách nạp và render thành công nội dung thật trước khi chụp:
 * 1. Hoạt cảnh lật trang 3D đã kết thúc (flipping === false)
 * 2. Chỉ số trang hiện tại của FlipHTML5 đã cập nhật khớp với trang mục tiêu
 * 3. Các ảnh <img> trong trang đã hoàn thành tải (complete && naturalWidth > 0)
 * 4. Các thẻ <canvas> đã có kích thước lớn và đã vẽ nội dung (pixels > 0)
 * 5. Các biểu tượng loading spinner đã biến mất hoàn toàn
 * 6. Nghỉ một khoảng ngắn để render sharpen / khử răng cưa ổn định
 */
async function waitForPageContentReady(tabId, targetPage, timeoutMs = 8000) {
  try {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [targetPage, timeoutMs],
      func: async (p, timeout) => {
        const start = Date.now();

        function checkLoaded() {
          // A. Sách có đang trong hoạt cảnh lật trang 3D không?
          try {
            const book = window.BookInfo?.getBook?.() || window.flipBook || window.singlePageBook;
            if (book && book.flipping) return { ok: false, stage: 'flipping_3d' };
          } catch {}

          // B. Kiểm tra FlipHTML5 đã chuyển tới trang này chưa
          try {
            if (typeof window.BookInfo?.getCurrentPages === 'function') {
              const cur = window.BookInfo.getCurrentPages().map(Number);
              if (cur.length > 0) {
                const match = cur.includes(p) || cur.some((cp) => Math.abs(cp - p) <= 1);
                if (!match) return { ok: false, stage: 'page_index_sync' };
              }
            }
          } catch {}

          // C. Kiểm tra các loading spinner / icon chờ còn hiển thị không
          const spinners = document.querySelectorAll(
            '.loading, .page-loading, .loading-gif, .loadImg, .loadingPicture, .loadingIcon'
          );
          for (const sp of spinners) {
            const cs = getComputedStyle(sp);
            if (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0) {
              const r = sp.getBoundingClientRect();
              if (r.width > 20 && r.height > 20 && r.top < window.innerHeight && r.bottom > 0) {
                return { ok: false, stage: 'spinner_visible' };
              }
            }
          }

          // D. Kiểm tra các thẻ img trong container sách
          const container = document.querySelector('#bookContainer, .bookContainer, #flipbook, .flipbook') || document.body;
          const imgs = Array.from(container.querySelectorAll('img')).filter((img) => {
            const r = img.getBoundingClientRect();
            return r.width > 120 && r.height > 120;
          });
          for (const img of imgs) {
            if (!img.complete || img.naturalWidth === 0) return { ok: false, stage: 'img_loading' };
          }

          // E. Kiểm tra các thẻ canvas hiển thị nội dung trang sách
          const canvases = Array.from(container.querySelectorAll('canvas')).filter((cv) => {
            const r = cv.getBoundingClientRect();
            return r.width > 120 && r.height > 120;
          });

          if (canvases.length === 0 && imgs.length === 0) {
            return { ok: false, stage: 'no_media_yet' };
          }

          let validCanvas = false;
          for (const cv of canvases) {
            if (cv.width >= 100 && cv.height >= 100) {
              try {
                const ctx = cv.getContext('2d', { willReadFrequently: true });
                if (ctx) {
                  const pix = ctx.getImageData(Math.floor(cv.width / 2), Math.floor(cv.height / 2), 1, 1).data;
                  if (pix[3] > 0) {
                    validCanvas = true;
                    break;
                  }
                }
              } catch {
                validCanvas = true;
                break;
              }
            }
          }

          if (validCanvas || imgs.length > 0) {
            return { ok: true };
          }
          return { ok: false, stage: 'canvas_empty' };
        }

        while (Date.now() - start < timeout) {
          const chk = checkLoaded();
          if (chk.ok) {
            await new Promise((r) => setTimeout(r, 350));
            return { ready: true, time: Date.now() - start };
          }
          await new Promise((r) => setTimeout(r, 100));
        }

        return { ready: false, timeout: true, time: Date.now() - start };
      }
    });

    const status = res?.[0]?.result || { ready: false };
    if (status.ready) {
      logToPopup('tab', `Trang #${targetPage} đã sẵn sàng (${status.time}ms: dừng lật 3D, canvas/ảnh đã vẽ pixel).`);
    } else if (status.timeout) {
      logToPopup('tab', `Trang #${targetPage} tải chậm (sau ${status.time || timeoutMs}ms chưa xong hoạt cảnh/canvas). Vẫn tiến hành chụp...`, 'warn', 'Nếu trang bị mờ hoặc trắng hình, hãy tăng "Tốc độ lật" lên 1200ms - 1500ms trong mục "⚙ Tùy chọn".');
    }
    return status;
  } catch (e) {
    logToPopup('tab', `Không thể kiểm tra trạng thái trang #${targetPage}: ${e.message}`, 'warn', 'Kiểm tra quyền truy cập tab hoặc reload lại sách.');
    return { ready: false, error: e.message };
  }
}

async function runScreenshotJob(tab, options) {
  shotRunning = true;
  shotCancelled = false;
  const delay = Math.max(600, options.flipDelay || 800);
  const quality = Math.round(Math.min(1, Math.max(0.5, options.quality || 0.95)) * 100);
  const pageFrom = Math.max(1, options.pageFrom || 1);
  const pageTo = Number.isFinite(options.pageTo) ? options.pageTo : Infinity;

  const progress = (current, total, label) =>
    broadcast({
      type: 'FLIP_PROGRESS_UPDATE',
      data: { currentPage: current, total: total || null, done: false, label, shot: true }
    });

  try {
    logToPopup('system', options.isTest ? '🧪 Bắt đầu: Chụp thử 20 trang đầu (cắt chuẩn theo khung sách gốc)' : '📸 Bắt đầu: Chụp toàn bộ sách (cắt chuẩn theo khung sách gốc) và ghép PDF');
    logToPopup('offscreen', 'Đang kích hoạt môi trường Offscreen Document để xử lý ảnh & ghép PDF...');
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_SHOT_RESET' });

    // 1. Lấy thông tin sách từ main world
    logToPopup('tab', `Đang đọc cấu hình sách từ tab #${tab.id} ("${tab.title || ''}")...`);
    const metaRes = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: () => {
        let total = window.bookConfig?.totalPageCount ||
                    (Array.isArray(window.fliphtml5_pages) ? window.fliphtml5_pages.length : 0) ||
                    window.defined_pagesCount ||
                    window.defined_totalPage ||
                    0;
        total = parseInt(total) || 0;
        let isDouble = true;
        try {
          if (typeof window.BookInfo?.isDoublePage === 'function') {
            isDouble = window.BookInfo.isDoublePage();
          } else if (window.bookConfig?.showDoublePage === 'single') {
            isDouble = false;
          }
        } catch {}
        return {
          total,
          isDouble,
          title: window.bookConfig?.bookTitle || document.title || 'flipbook'
        };
      }
    });

    const meta = metaRes?.[0]?.result || {};
    const totalPages = meta.total || 401;
    const isDouble = meta.isDouble !== false;
    const endPage = Math.min(totalPages, pageTo);

    logToPopup('tab', `Phát hiện: Tổng ${totalPages} trang, chế độ ${isDouble ? 'hai trang (spread #p=[n+2])' : 'trang đơn'}, tiêu đề: "${meta.title || tab.title}".`);

    // 2. Tạo danh sách các trang cần chụp
    const pagesToCapture = [];
    if (isDouble) {
      if (pageFrom <= 1) pagesToCapture.push(1);
      const startEven = Math.max(2, pageFrom % 2 === 0 ? pageFrom : pageFrom + 1);
      for (let p = startEven; p <= endPage; p += 2) {
        pagesToCapture.push(p);
      }
      if (endPage % 2 !== 0 && endPage > 1 && !pagesToCapture.includes(endPage)) {
        pagesToCapture.push(endPage);
      }
    } else {
      for (let p = pageFrom; p <= endPage; p++) {
        pagesToCapture.push(p);
      }
    }

    const totalSteps = pagesToCapture.length;
    const rangeText = (pageFrom > 1 || endPage < totalPages) ? `, trang ${pageFrom} → ${endPage}` : '';
    
    logToPopup('shot', `Lên lịch chụp ${totalSteps} khung hình (chất lượng nén ${quality}%, tốc độ chờ ${delay}ms${rangeText}).`);
    broadcast({
      type: 'SHOT_PROGRESS_TEXT',
      text: options.isTest
        ? `🧪 Đang chụp thử 20 trang đầu (${totalSteps} khung hình)...`
        : `📸 Chuẩn bị chụp ${totalSteps} khung hình (tổng ${totalPages} trang${rangeText}, chất lượng ${quality}%, chế độ ${isDouble ? 'hai trang #p=[n+2]' : 'trang đơn'})...`
    });

    let kept = 0;

    for (let i = 0; i < pagesToCapture.length; i++) {
      if (shotCancelled) {
        logToPopup('system', 'Người dùng đã bấm hủy tiến trình.', 'warn');
        break;
      }

      const targetPage = pagesToCapture[i];
      const stepIndex = i + 1;

      // Chuyển trang trực tiếp trong Main World
      logToPopup('tab', `[Bước ${stepIndex}/${totalSteps}] Đang chuyển tới trang #${targetPage}...`);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        args: [targetPage],
        func: (p) => {
          try {
            if (typeof window.gotoPageFun === 'function') {
              window.gotoPageFun(p, false);
              return;
            }
          } catch {}
          try {
            if (window.BookInfo?.getBook?.()?.gotoPage) {
              window.BookInfo.getBook().gotoPage(p, false);
              return;
            }
          } catch {}
          try {
            location.hash = '#p=' + p;
          } catch {}
        }
      });

      // Chờ cho đến khi trang nạp thành công nội dung hoàn toàn
      await waitForPageContentReady(tab.id, targetPage, Math.max(8000, delay * 8));

      const current = await chrome.tabs.get(tab.id);
      if (!current.active) {
        logToPopup('tab', 'Tab flipbook bị mất active (người dùng chuyển sang tab khác).', 'error', 'Giữ tab chứa flipbook ở phía trước (active tab) trong suốt quá trình chụp, không chuyển tab.');
        throw new Error('Tab bị chuyển đi. Vui lòng giữ tab flipbook ở phía trước khi chụp.');
      }

      // Lấy khung cuốn sách
      const crop = await getBookRect(tab.id);

      if (stepIndex === 1) {
        if (crop) {
          logToPopup('shot', `Đã lấy đúng khung nội dung sách: ${Math.round(crop.w)}×${Math.round(crop.h)}px (loại bỏ hoàn toàn thanh công cụ và khoảng đen ngoài sách).`);
          broadcast({
            type: 'SHOT_PROGRESS_TEXT',
            text: `✂ Tự động cắt theo khung sách: ${Math.round(crop.w)}×${Math.round(crop.h)}px (loại bỏ thanh công cụ và khoảng đen)`
          });
        } else {
          logToPopup('shot', 'Không nhận diện được khung sách riêng biệt. Chụp toàn bộ màn hình tab.', 'warn', 'Để chụp khít viền sách, hãy phóng to cửa sổ hoặc reset zoom về 100% (Cmd/Ctrl + 0).');
          broadcast({
            type: 'SHOT_PROGRESS_TEXT',
            text: '⚠ Không xác định được khung sách, chụp toàn bộ màn hình.'
          });
        }
      }

      // Chụp màn hình tab hiển thị (PNG sắc nét)
      let dataUrl;
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      } catch (capErr) {
        logToPopup('shot', `Lỗi chụp màn hình trang #${targetPage}: ${capErr.message}`, 'error', 'Đảm bảo cửa sổ Chrome không bị thu nhỏ cực tiểu (minimize) và tab đang hiển thị đầy đủ.');
        throw capErr;
      }

      // Gửi sang offscreen để cắt theo khung sách và lưu trữ
      const resp = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_SHOT_ADD',
        data: dataUrl,
        crop,
        quality: quality / 100
      });
      if (resp?.error) {
        logToPopup('offscreen', `Lỗi cắt/nén ảnh trang #${targetPage}: ${resp.error}`, 'error', 'OffscreenCanvas gặp sự cố bộ nhớ. Thử đóng bớt tab hoặc hạ chất lượng JPG.');
        throw new Error(`Lỗi cắt ảnh trang ${targetPage}: ${resp.error}`);
      }

      logToPopup('offscreen', `[Bước ${stepIndex}/${totalSteps}] Đã cắt gọn khung sách: ${resp.sw}×${resp.sh}px (loại bỏ hoàn toàn viền đen và thanh công cụ).`);

      kept++;
      const testPrefix = options.isTest ? '🧪 [Thử nghiệm] ' : '';
      progress(stepIndex, totalSteps, `${testPrefix}📸 Đã chụp trang ${targetPage} (${stepIndex}/${totalSteps})`);
    }

    if (shotCancelled) {
      logToPopup('system', 'Tiến trình chụp đã dừng theo yêu cầu của bạn.', 'warn');
      broadcast({ type: 'SHOT_DONE', result: { error: 'Đã hủy.' } });
      return;
    }
    if (kept === 0) {
      logToPopup('system', 'Không chụp được trang nào.', 'error', 'Kiểm tra lại khoảng trang "Từ trang / Đến trang" hoặc reload lại trang sách.');
      throw new Error('Không chụp được trang nào.');
    }

    logToPopup('pdf', `Đã hoàn thành chụp ${kept} khung hình. Đang tiến hành tạo file PDF bằng pdf-lib...`);
    broadcast({ type: 'SHOT_PROGRESS_TEXT', text: `📄 Đang ghép ${kept} trang đã chụp thành PDF...` });
    
    const baseTitle = meta.title || tab.title || 'flipbook';
    const finalTitle = options.isTest ? `${baseTitle}_test_20trang` : baseTitle;
    const result = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_SHOT_BUILD',
      options: { quality: quality / 100, batchSize: 5, title: finalTitle }
    });
    
    if (!result || result.error) {
      logToPopup('pdf', `Lỗi tạo file PDF: ${result?.error || 'Offscreen không phản hồi'}`, 'error', 'Bộ nhớ trình duyệt có thể bị đầy do quá nhiều trang chất lượng cao. Hãy giảm "Chất lượng JPG" xuống 80-85% hoặc dùng "Từ trang / Đến trang" để chia nhỏ.');
      throw new Error(result?.error || 'Offscreen không phản hồi.');
    }

    logToPopup('pdf', `Tạo file PDF thành công! Gồm ${result.successCount}/${result.totalPages} trang, kích thước ${formatBytes(result.sizeBytes)}.`, 'success');

    try {
      logToPopup('download', `Đang chuyển file "${result.filename}" cho trình tải xuống của Chrome...`);
      result.downloadId = await chrome.downloads.download({
        url: result.blobUrl,
        filename: result.filename,
        saveAs: false
      });
      logToPopup('download', `Tải file thành công! Mã tải: #${result.downloadId}`, 'success');
    } catch (e) {
      result.downloadError = e.message;
      logToPopup('download', `Lỗi khi tải file: ${e.message}`, 'error', 'Chrome chặn tải tự động hoặc thư mục tải xuống không có quyền ghi. Kiểm tra cài đặt Tải xuống của Chrome.');
    }
    broadcast({ type: 'SHOT_DONE', result });
  } catch (e) {
    logToPopup('system', `Tiến trình chụp gặp sự cố: ${e.message}`, 'error', 'Kiểm tra tab flipbook và đảm bảo tab vẫn mở và ở phía trước.');
    broadcast({ type: 'SHOT_DONE', result: { error: e.message } });
  } finally {
    shotRunning = false;
  }
}

async function getMainWorldData(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const out = {
          title: document.title || '',
          total: 0,
          pages: [],
          platform: 'FlipHTML5'
        };

        try {
          const total = window.bookConfig?.totalPageCount ||
                        (Array.isArray(window.fliphtml5_pages) ? window.fliphtml5_pages.length : 0) ||
                        window.defined_pagesCount ||
                        window.defined_totalPage ||
                        0;
          out.total = parseInt(total) || 0;
          if (window.bookConfig?.bookTitle) out.title = window.bookConfig.bookTitle;

          const rawBase = location.href.split('#')[0].split('?')[0];
          const base = rawBase.endsWith('/') ? rawBase : rawBase.substring(0, rawBase.lastIndexOf('/') + 1);

          // 1. Lấy từ window.fliphtml5_pages (đã được deString giải mã trong main world)
          const fp = window.fliphtml5_pages;
          if (Array.isArray(fp) && fp.length > 0) {
            for (let i = 0; i < fp.length; i++) {
              const item = fp[i];
              let name = item?.l || item?.n || item?.t || item?.src;
              if (Array.isArray(name)) name = name[0];
              if (name && typeof name === 'string') {
                const fullUrl = name.startsWith('http')
                  ? name
                  : (base + (name.startsWith('files/') ? name : 'files/large/' + name));
                out.pages.push(fullUrl);
              }
            }
          }

          // 2. Lấy từ hàm realPageDir hoặc pageDirWidthPath của FlipHTML5
          if (out.pages.length === 0 && out.total > 0) {
            for (let i = 1; i <= out.total; i++) {
              let u = null;
              try {
                if (typeof window.realPageDir === 'function') {
                  u = window.realPageDir(i, 'large') || window.realPageDir(i, 'normal');
                } else if (typeof window.pageDirWidthPath === 'function') {
                  u = window.pageDirWidthPath(i, 'large') || window.pageDirWidthPath(i, 'normal');
                }
              } catch {}
              if (u && typeof u === 'string') {
                const fullUrl = u.startsWith('http')
                  ? u
                  : (base + (u.startsWith('files/') ? u : 'files/large/' + u));
                out.pages.push(fullUrl);
              }
            }
          }

          // 3. AnyFlip
          if (out.pages.length === 0 && window.defined_totalPage && window.defined_basePath) {
            const tot = parseInt(window.defined_totalPage);
            for (let i = 1; i <= tot; i++) {
              out.pages.push(window.defined_basePath + 'files/large/' + i + '.jpg');
            }
            out.total = tot;
            out.platform = 'AnyFlip';
          }
        } catch (e) {
          console.warn('[Flipbook-DL] Lỗi đọc main world:', e);
        }

        return out;
      }
    });
    return results?.[0]?.result || {};
  } catch (e) {
    return {};
  }
}

const messageHandlers = {
  /* Content script yêu cầu danh sách URL ảnh từ network */
  GET_NETWORK_IMAGES: (msg, sender, sendResponse) => {
    const tabId = msg.tabId ?? sender.tab?.id;
    const urls = networkImages.has(tabId) ? [...networkImages.get(tabId)] : [];
    sendResponse({ urls });
  },

  /* Popup yêu cầu quét trang – chuyển tiếp sang content script */
  SCAN_PAGES: async (msg, _sender, sendResponse) => {
    try {
      logToPopup('tab', 'Bắt đầu quét cấu hình trang và tìm URL ảnh gốc...');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('Không tìm thấy tab flipbook.');
      const mainWorldData = await getMainWorldData(tab.id);
      const results = await chrome.tabs.sendMessage(tab.id, {
        type: 'SCAN_PAGES',
        tabId: tab.id,
        mainWorldData
      });
      if (results?.pages?.length > 0) {
        logToPopup('tab', `Đã tìm thấy ${results.pages.length} trang ảnh gốc (${results.platform || 'FlipHTML5'}).`, 'success');
      } else {
        logToPopup('tab', 'Không tìm thấy URL ảnh gốc trực tiếp từ mã HTML.', 'warn', 'Sách sử dụng canvas động hoặc mã hóa đặc biệt. Hãy sử dụng nút "📸 Chụp màn hình & Tải PDF".');
      }
      sendResponse(results);
    } catch (e) {
      logToPopup('tab', `Lỗi quét trang: ${e.message}`, 'error', 'F5 tải lại trang sách và mở lại popup.');
      sendResponse({ error: e.message });
    }
  },

  /**
   * Popup yêu cầu auto-flip – GỬI LỆNH rồi TRẢ LỜI NGAY
   * Content script sẽ tự lật và báo tiến trình qua FLIP_PROGRESS
   */
  START_FLIP: async (msg, _sender, sendResponse) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const mainWorldData = await getMainWorldData(tab.id);
      chrome.tabs.sendMessage(tab.id, {
        type: 'START_FLIP',
        options: msg.options,
        mainWorldData
      });
      // Trả lời popup ngay lập tức
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  },

  /* Điều khiển flip – chuyển tiếp đến content script */
  PAUSE_FLIP: async (_msg, _sender, sendResponse) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.tabs.sendMessage(tab.id, { type: 'PAUSE_FLIP' });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  },

  RESUME_FLIP: async (_msg, _sender, sendResponse) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.tabs.sendMessage(tab.id, { type: 'RESUME_FLIP' });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  },

  CANCEL_FLIP: async (_msg, _sender, sendResponse) => {
    shotCancelled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      chrome.tabs.sendMessage(tab.id, { type: 'CANCEL_FLIP' });
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  },

  /* Content script báo tiến trình flip → broadcast cho popup */
  FLIP_PROGRESS: (msg, _sender, sendResponse) => {
    chrome.runtime.sendMessage({
      type: 'FLIP_PROGRESS_UPDATE',
      data: msg.data
    }).catch(() => {});
    sendResponse({ ok: true });
  },

  /* Chế độ chụp màn hình: chụp → lật → chụp … → ghép PDF */
  SCREENSHOT_PDF: async (msg, _sender, sendResponse) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) throw new Error('Không tìm thấy tab đang mở.');
      if (shotRunning) throw new Error('Đang chạy chế độ chụp màn hình.');
      sendResponse({ ok: true });
      runScreenshotJob(tab, msg.options || {});
    } catch (e) {
      sendResponse({ error: e.message });
    }
  },

  /* Yêu cầu ghép PDF – chuyển sang offscreen */
  BUILD_PDF: async (msg, _sender, sendResponse) => {
    try {
      logToPopup('pdf', `Đang tải & ghép ${msg.pages?.length || 0} trang ảnh thành PDF...`);
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.url) {
          const origin = new URL(tab.url).origin;
          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [9001],
            addRules: [{
              id: 9001,
              priority: 1,
              action: {
                type: 'modifyHeaders',
                requestHeaders: [
                  { header: 'Referer', operation: 'set', value: tab.url },
                  { header: 'Origin', operation: 'set', value: origin }
                ]
              },
              condition: {
                initiatorDomains: [chrome.runtime.id],
                resourceTypes: ['xmlhttprequest', 'image', 'other']
              }
            }]
          });
        }
      } catch (e) {
        console.warn('[Flipbook-DL] Không đặt được Referer rule:', e);
      }
      await ensureOffscreen();
      const result = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_BUILD_PDF',
        pages: msg.pages,
        options: msg.options
      });
      if (!result) {
        logToPopup('pdf', 'Offscreen không phản hồi (có thể hết bộ nhớ).', 'error', 'Thử giảm số trang bằng "Từ trang / Đến trang" hoặc giảm chất lượng JPG.');
        sendResponse({ error: 'Offscreen không phản hồi (có thể hết bộ nhớ). Thử giảm số trang bằng "Từ trang/Đến trang".' });
        return;
      }
      if (result.error) {
        logToPopup('pdf', `Lỗi tạo PDF: ${result.error}`, 'error');
      } else {
        logToPopup('pdf', `Ghép PDF hoàn tất: ${result.successCount}/${result.totalPages} trang (${formatBytes(result.sizeBytes)}).`, 'success');
      }
      if (!result.error && result.blobUrl) {
        try {
          logToPopup('download', `Đang gửi file "${result.filename}" sang trình tải xuống...`);
          result.downloadId = await chrome.downloads.download({
            url: result.blobUrl,
            filename: result.filename,
            saveAs: false
          });
          logToPopup('download', `Tải file thành công (Mã tải: #${result.downloadId})!`, 'success');
        } catch (e) {
          result.downloadError = e.message;
          logToPopup('download', `Lỗi khi tải file: ${e.message}`, 'error', 'Trình duyệt chặn tải tự động hoặc thư mục tải xuống không có quyền ghi.');
        }
      }
      sendResponse(result);
    } catch (e) {
      logToPopup('system', `Lỗi hệ thống khi ghép PDF: ${e.message}`, 'error');
      sendResponse({ error: e.message });
    }
  },

  /* Offscreen gửi progress ghép PDF → broadcast cho popup */
  PDF_PROGRESS: (msg, _sender, sendResponse) => {
    chrome.runtime.sendMessage({
      type: 'PDF_PROGRESS_UPDATE',
      data: msg.data
    }).catch(() => {});
    sendResponse({ ok: true });
  },

  /* Tải file PDF */
  DOWNLOAD_PDF: async (msg, _sender, sendResponse) => {
    try {
      const downloadId = await chrome.downloads.download({
        url: msg.url,
        filename: msg.filename,
        saveAs: true
      });
      sendResponse({ downloadId });
    } catch (e) {
      sendResponse({ error: e.message });
    }
  },

  /* Xóa nhật ký */
  CLEAR_LOGS: (_msg, _sender, sendResponse) => {
    recentLogs.length = 0;
    sendResponse({ ok: true });
  },

  /* Lấy trạng thái hiện tại từ content script & lịch sử log */
  GET_STATUS: async (_msg, _sender, sendResponse) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
      sendResponse({ ...(result || {}), recentLogs: [...recentLogs] });
    } catch (e) {
      sendResponse({ status: 'idle', recentLogs: [...recentLogs], error: e.message });
    }
  }
};

console.log('[Flipbook-DL] Service worker đã khởi tạo.');
