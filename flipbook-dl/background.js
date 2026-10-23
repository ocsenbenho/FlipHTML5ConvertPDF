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

/* ────────────── Chế độ chụp màn hình ────────────── */
let shotRunning = false;
let shotCancelled = false;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const broadcast = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

/** Hàm chạy TRONG trang: tìm khung hiển thị chính xác của cuốn sách (loại bỏ thanh công cụ và khoảng đen) */
function findBookRectInPage() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // 1. Kiểm tra đối tượng sách nội bộ của FlipHTML5
  try {
    const bookObj = window.BookInfo?.getBook?.() || window.flipBook || window.singlePageBook;
    const el = bookObj?.flipBookElement?.[0] || bookObj?.book?.[0] || bookObj?.$book?.[0] || bookObj?.[0];
    if (el && el.getBoundingClientRect) {
      const r = el.getBoundingClientRect();
      if (r.width > 150 && r.height > 150 && r.width <= vw && r.height <= vh) {
        return {
          x: Math.max(0, r.left),
          y: Math.max(0, r.top),
          w: Math.min(vw - Math.max(0, r.left), r.width),
          h: Math.min(vh - Math.max(0, r.top), r.height),
          vw, vh
        };
      }
    }
  } catch {}

  // 2. Kiểm tra container DOM của FlipHTML5 (#bookContainer)
  const container = document.querySelector('#bookContainer, .bookContainer');
  if (container) {
    const r = container.getBoundingClientRect();
    if (r.width > 150 && r.height > 150 && r.width <= vw && r.height <= vh) {
      return {
        x: Math.max(0, r.left),
        y: Math.max(0, r.top),
        w: Math.min(vw - Math.max(0, r.left), r.width),
        h: Math.min(vh - Math.max(0, r.top), r.height),
        vw, vh
      };
    }
  }

  // 3. Khung bao quanh tất cả các thẻ canvas hiển thị trang sách (FlipHTML5 render các trang lên canvas)
  const canvases = Array.from(document.querySelectorAll('canvas')).filter((cv) => {
    const r = cv.getBoundingClientRect();
    // Bỏ qua thumbnail progress bar, icon nhỏ hoặc canvas toàn màn hình
    return r.width > 150 && r.height > 150 &&
           r.width < vw * 0.98 && r.height < vh * 0.98 &&
           r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
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
    if (maxX > minX + 100 && maxY > minY + 100) {
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, vw, vh };
    }
  }

  // 4. Các nền tảng flipbook khác (AnyFlip, TurnJS, FlowPaper, Heyzine...)
  const fallbackSelectors = [
    '#flipbook', '.flipbook', '#book', '.flowpaper_viewer',
    '.heyzine-container', '.magazine', '.turn-page-wrapper',
    '.stage-container', '#centerWindow'
  ];
  for (const sel of fallbackSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const r = el.getBoundingClientRect();
      if (r.width > 200 && r.height > 200 && r.width <= vw && r.height <= vh) {
        return {
          x: Math.max(0, r.left),
          y: Math.max(0, r.top),
          w: Math.min(vw - Math.max(0, r.left), r.width),
          h: Math.min(vh - Math.max(0, r.top), r.height),
          vw, vh
        };
      }
    }
  }

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
            if (book && book.flipping) return false;
          } catch {}

          // B. Kiểm tra FlipHTML5 đã chuyển tới trang này chưa
          try {
            if (typeof window.BookInfo?.getCurrentPages === 'function') {
              const cur = window.BookInfo.getCurrentPages().map(Number);
              if (cur.length > 0) {
                // Trang mục tiêu p phải nằm trong trang hiển thị, hoặc cách không quá 1 trang
                const match = cur.includes(p) || cur.some((cp) => Math.abs(cp - p) <= 1);
                if (!match) return false;
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
                return false; // vẫn đang hiện icon loading
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
            if (!img.complete || img.naturalWidth === 0) return false;
          }

          // E. Kiểm tra các thẻ canvas hiển thị nội dung trang sách
          const canvases = Array.from(container.querySelectorAll('canvas')).filter((cv) => {
            const r = cv.getBoundingClientRect();
            return r.width > 120 && r.height > 120;
          });

          if (canvases.length === 0 && imgs.length === 0) {
            return false; // chưa có canvas lẫn img
          }

          // Kiểm tra xem canvas đã có kích thước thực tế và dữ liệu vẽ chưa
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
                validCanvas = true; // tainted context (cross-origin image) coi như đã vẽ
                break;
              }
            }
          }

          return validCanvas || imgs.length > 0;
        }

        // Chờ đến khi checkLoaded trả về true
        while (Date.now() - start < timeout) {
          if (checkLoaded()) {
            // Chờ thêm 350ms để text sharpen và khử răng cưa canvas hoàn tất
            await new Promise((r) => setTimeout(r, 350));
            return { ready: true, time: Date.now() - start };
          }
          await new Promise((r) => setTimeout(r, 100));
        }

        return { ready: false, timeout: true, time: Date.now() - start };
      }
    });

    return res?.[0]?.result || { ready: false };
  } catch (e) {
    return { ready: false, error: e.message };
  }
}

async function runScreenshotJob(tab, options) {
  shotRunning = true;
  shotCancelled = false;
  const delay = Math.max(600, options.flipDelay || 800); // thời gian chờ render trang
  const quality = Math.round(Math.min(1, Math.max(0.5, options.quality || 0.95)) * 100);
  const pageFrom = Math.max(1, options.pageFrom || 1);
  const pageTo = Number.isFinite(options.pageTo) ? options.pageTo : Infinity;

  const progress = (current, total, label) =>
    broadcast({
      type: 'FLIP_PROGRESS_UPDATE',
      data: { currentPage: current, total: total || null, done: false, label, shot: true }
    });

  try {
    await ensureOffscreen();
    await chrome.runtime.sendMessage({ type: 'OFFSCREEN_SHOT_RESET' });

    // 1. Lấy thông tin sách từ main world
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

    // 2. Tạo danh sách các trang cần chụp:
    // Trang bìa là #p=1
    // Các trang sau là hai trang mở rộng (spread): #p=2 (trang 2-3), #p=4 (trang 4-5), #p=6 (trang 6-7)...
    const pagesToCapture = [];
    if (isDouble) {
      if (pageFrom <= 1) pagesToCapture.push(1);
      const startEven = Math.max(2, pageFrom % 2 === 0 ? pageFrom : pageFrom + 1);
      for (let p = startEven; p <= endPage; p += 2) {
        pagesToCapture.push(p);
      }
      // Nếu trang cuối là số lẻ (ví dụ 401 là bìa sau) và chưa có trong danh sách
      if (endPage % 2 !== 0 && endPage > 1 && !pagesToCapture.includes(endPage)) {
        pagesToCapture.push(endPage);
      }
    } else {
      for (let p = pageFrom; p <= endPage; p++) {
        pagesToCapture.push(p);
      }
    }

    const totalSteps = pagesToCapture.length;
    broadcast({
      type: 'SHOT_PROGRESS_TEXT',
      text: options.isTest
        ? `🧪 Đang chụp thử 20 trang đầu (${totalSteps} khung hình)...`
        : `📸 Chuẩn bị chụp ${totalSteps} khung hình (tổng ${totalPages} trang, chế độ ${isDouble ? 'hai trang #p=[n+2]' : 'trang đơn'})...`
    });

    let kept = 0;

    for (let i = 0; i < pagesToCapture.length; i++) {
      if (shotCancelled) break;

      const targetPage = pagesToCapture[i];
      const stepIndex = i + 1;

      // Chuyển trang trực tiếp trong Main World
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
      if (!current.active) throw new Error('Tab bị chuyển đi. Vui lòng giữ tab flipbook ở phía trước khi chụp.');

      // Lấy khung cuốn sách
      const crop = await getBookRect(tab.id);

      if (stepIndex === 1) {
        broadcast({
          type: 'SHOT_PROGRESS_TEXT',
          text: crop
            ? `✂ Tự động cắt theo khung sách: ${Math.round(crop.w)}×${Math.round(crop.h)}px (loại bỏ thanh công cụ và khoảng đen)`
            : '⚠ Không xác định được khung sách, chụp toàn bộ màn hình.'
        });
      }

      // Chụp màn hình tab hiển thị (PNG sắc nét)
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });

      // Gửi sang offscreen để cắt theo khung sách và lưu trữ
      const resp = await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_SHOT_ADD',
        data: dataUrl,
        crop,
        quality: quality / 100
      });
      if (resp?.error) throw new Error(`Lỗi cắt ảnh trang ${targetPage}: ${resp.error}`);

      kept++;
      const testPrefix = options.isTest ? '🧪 [Thử nghiệm] ' : '';
      progress(stepIndex, totalSteps, `${testPrefix}📸 Đã chụp trang ${targetPage} (${stepIndex}/${totalSteps})`);
    }

    if (shotCancelled) {
      broadcast({ type: 'SHOT_DONE', result: { error: 'Đã hủy.' } });
      return;
    }
    if (kept === 0) throw new Error('Không chụp được trang nào.');

    broadcast({ type: 'SHOT_PROGRESS_TEXT', text: `📄 Đang ghép ${kept} trang đã chụp thành PDF...` });
    const baseTitle = meta.title || tab.title || 'flipbook';
    const finalTitle = options.isTest ? `${baseTitle}_test_20trang` : baseTitle;
    const result = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_SHOT_BUILD',
      options: { quality: quality / 100, batchSize: 5, title: finalTitle }
    });
    if (!result || result.error) throw new Error(result?.error || 'Offscreen không phản hồi.');

    try {
      result.downloadId = await chrome.downloads.download({
        url: result.blobUrl,
        filename: result.filename,
        saveAs: false
      });
    } catch (e) {
      result.downloadError = e.message;
    }
    broadcast({ type: 'SHOT_DONE', result });
  } catch (e) {
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
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const mainWorldData = await getMainWorldData(tab.id);
      const results = await chrome.tabs.sendMessage(tab.id, {
        type: 'SCAN_PAGES',
        tabId: tab.id,
        mainWorldData
      });
      sendResponse(results);
    } catch (e) {
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
        sendResponse({ error: 'Offscreen không phản hồi (có thể hết bộ nhớ). Thử giảm số trang bằng "Từ trang/Đến trang".' });
        return;
      }
      if (!result.error && result.blobUrl) {
        try {
          result.downloadId = await chrome.downloads.download({
            url: result.blobUrl,
            filename: result.filename,
            saveAs: false
          });
        } catch (e) {
          result.downloadError = e.message;
        }
      }
      sendResponse(result);
    } catch (e) {
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

  /* Lấy trạng thái hiện tại từ content script */
  GET_STATUS: async (_msg, _sender, sendResponse) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const result = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATUS' });
      sendResponse(result);
    } catch (e) {
      sendResponse({ status: 'idle', error: e.message });
    }
  }
};

console.log('[Flipbook-DL] Service worker đã khởi tạo.');
