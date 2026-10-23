/**
 * content.js – Content Script
 * Quét DOM, điều khiển auto-flip cho đến hết cuốn sách, thu thập URL ảnh trang flipbook.
 * Chạy trong context của trang web đang mở.
 */

(() => {
  'use strict';

  /* ────────────── Trạng thái ────────────── */
  const state = {
    status: 'idle', // idle | scanning | flipping | paused | done | error
    pages: [],      // Danh sách URL ảnh đã thu thập
    total: null,    // Tổng số trang (nếu biết)
    title: '',
    platform: '',
    flipPaused: false,
    flipCancelled: false,
    currentFlipPage: 0
  };

  /* ────────────── Nhận message từ background ────────────── */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'SCAN_PAGES':
        handleScan(msg.tabId, msg.mainWorldData).then(sendResponse).catch((e) =>
          sendResponse({ error: e.message })
        );
        return true;

      case 'START_FLIP':
        sendResponse({ ok: true });
        handleFlip(msg.options, msg.mainWorldData).catch((e) =>
          console.error('[Flipbook-DL] Lỗi flip:', e)
        );
        break;

      case 'PAUSE_FLIP':
        state.flipPaused = true;
        state.status = 'paused';
        console.log('[Flipbook-DL] Tạm dừng lật.');
        sendResponse({ ok: true });
        break;

      case 'FLIP_ONCE':
        doFlip(1).then((result) =>
          sendResponse({ result, info: getFlipbookPageInfo() })
        ).catch((e) => sendResponse({ error: e.message }));
        return true;

      case 'PAGE_INFO':
        sendResponse({ info: getFlipbookPageInfo() });
        break;

      case 'RESUME_FLIP':
        state.flipPaused = false;
        state.status = 'flipping';
        console.log('[Flipbook-DL] Tiếp tục lật.');
        sendResponse({ ok: true });
        break;

      case 'CANCEL_FLIP':
        state.flipCancelled = true;
        state.status = 'idle';
        console.log('[Flipbook-DL] Đã hủy lật.');
        sendResponse({ ok: true });
        break;

      case 'GET_STATUS':
        sendResponse({
          status: state.status,
          pages: state.pages,
          total: state.total,
          title: state.title,
          platform: state.platform,
          currentFlipPage: state.currentFlipPage
        });
        break;
    }
  });

  /* ────────────── Quét trang ────────────── */
  async function handleScan(tabId, mainWorldData = {}) {
    state.status = 'scanning';
    console.log('[Flipbook-DL] Bắt đầu quét trang...');

    let networkUrls = [];
    try {
      const resp = await sendToBackground({
        type: 'GET_NETWORK_IMAGES',
        tabId
      });
      networkUrls = resp?.urls || [];
    } catch (e) {
      console.warn('[Flipbook-DL] Không lấy được network URLs:', e);
    }

    const context = { tabId, networkUrls, mainWorldData };
    const adapters = window.__flipbookAdapters || [];

    const results = await Promise.allSettled(
      adapters.map(async (adapter) => {
        try {
          if (!adapter.match(location.href)) return null;
          const result = await adapter.extractPages(context);
          return { ...result, adapterName: adapter.name, priority: adapter.priority };
        } catch (e) {
          console.warn(`[Flipbook-DL] Adapter ${adapter.name} lỗi:`, e);
          return null;
        }
      })
    );

    const validResults = results
      .filter((r) => r.status === 'fulfilled' && r.value && r.value.pages?.length > 0)
      .map((r) => r.value)
      .sort((a, b) => {
        if (a.priority !== b.priority) return b.priority - a.priority;
        return b.pages.length - a.pages.length;
      });

    // Cũng thử lấy tổng số trang từ UI nếu adapter chưa tìm được
    const uiInfo = getFlipbookPageInfo();
    const uiTotal = uiInfo.total;

    if (validResults.length === 0) {
      state.status = 'idle';
      state.total = uiTotal || null;
      return {
        pages: [],
        total: uiTotal || 0,
        title: document.title,
        platform: 'Chưa xác định',
        message: uiTotal
          ? `Nhận diện sách có ${uiTotal} trang. Nhấn "Tự lật & Tải PDF" để bắt đầu lật hết sách.`
          : 'Chưa tải được ảnh trang. Nhấn "Tự lật & Tải PDF" để lật từ trang đầu đến hết sách.'
      };
    }

    const best = validResults[0];
    state.pages = sortImageUrls(best.pages);
    state.total = best.total || uiTotal || state.pages.length;
    state.title = best.title || document.title;
    state.platform = best.platform;
    state.status = 'idle';

    console.log(`[Flipbook-DL] Nền tảng: ${best.platform}, Tìm thấy: ${state.pages.length}/${state.total} trang`);

    return {
      pages: state.pages,
      total: state.total,
      title: state.title,
      platform: best.platform
    };
  }

  /* ════════════════════════════════════════════════════════════
     TỰ ĐỘNG LẬT TRANG ĐẾN HẾT CUỐN SÁCH
     ════════════════════════════════════════════════════════════ */

  async function handleFlip(options = {}, mainWorldData = {}) {
    const {
      flipDelay = 800,
      pageFrom = 1,
      pageTo = Infinity
    } = options;

    state.status = 'flipping';
    state.flipPaused = false;
    state.flipCancelled = false;
    state.currentFlipPage = 0;

    // Cập nhật tổng số trang nếu chưa biết
    if (!state.total) {
      const uiInfo = getFlipbookPageInfo();
      state.total = uiInfo.total ||
                    mainWorldData.defined_pagesCount ||
                    mainWorldData.htmlConfig?.totalPageCount ||
                    mainWorldData.bookConfig?.totalPageCount ||
                    null;
      if (state.total) {
        state.total = parseInt(state.total);
        console.log(`[Flipbook-DL] Tổng số trang đã nhận diện: ${state.total}`);
      }
    }

    const seenUrls = new Set(state.pages);

    // 1. Thu thập ảnh trang hiện tại trước khi lật
    const currentImages = collectVisiblePageImages();
    for (const url of currentImages) {
      if (!seenUrls.has(url)) {
        seenUrls.add(url);
        state.pages.push(url);
      }
    }

    // 2. Thu thập ảnh từ network hiện có
    try {
      const resp = await sendToBackground({ type: 'GET_NETWORK_IMAGES' });
      const initialNet = (resp?.urls || []).filter(isFlipbookImageUrl);
      for (const url of initialNet) {
        if (!seenUrls.has(url)) {
          seenUrls.add(url);
          state.pages.push(url);
        }
      }
    } catch {}

    let noNewCount = 0;
    let flipCount = 0;
    const MAX_NO_NEW = state.total ? 10 : 8; // Cho phép nhiều lần thử để không dừng giữa chừng

    console.log(`[Flipbook-DL] Bắt đầu tự động lật đến hết sách (delay: ${flipDelay}ms, mục tiêu: ${state.total || pageTo || 'cuối'})...`);
    reportProgress(false);

    while (!state.flipCancelled) {
      // Chờ nếu tạm dừng
      while (state.flipPaused && !state.flipCancelled) {
        await sleep(200);
      }
      if (state.flipCancelled) break;

      // ── Kiểm tra điều kiện dừng: đạt trang cuối ──
      if (state.pages.length >= pageTo) {
        console.log(`[Flipbook-DL] Đạt giới hạn trang người dùng chỉ định (${pageTo}), hoàn thành.`);
        break;
      }

      if (state.total && state.pages.length >= state.total) {
        console.log(`[Flipbook-DL] Đã thu thập đủ tất cả ${state.total} trang của sách!`);
        break;
      }

      // Kiểm tra chỉ số trang từ giao diện sách (ví dụ: "50 / 50")
      const pageInfoBefore = getFlipbookPageInfo();
      if (pageInfoBefore.current && pageInfoBefore.total && pageInfoBefore.current >= pageInfoBefore.total) {
        // Đang ở trang cuối cùng, chờ một chút để ảnh trang cuối nạp đủ
        console.log(`[Flipbook-DL] Đã tới trang cuối cùng trên giao diện (${pageInfoBefore.current}/${pageInfoBefore.total}).`);
        await waitForNewImages(seenUrls, 2500);
        break;
      }

      flipCount++;
      state.currentFlipPage = flipCount;

      // ── Thực hiện lật trang ──
      const flipResult = await doFlip(flipCount);
      if (flipResult === 'end') {
        console.log('[Flipbook-DL] Nút next bị vô hiệu hóa hoặc đã đến cuối sách.');
        // Thu thập nốt ảnh trang cuối trước khi kết thúc
        await waitForNewImages(seenUrls, 2000);
        break;
      }

      // ── Chờ ảnh mới nạp từ DOM và Network ──
      const waitTimeout = Math.max(2500, flipDelay * 2.5);
      const newUrls = await waitForNewImages(seenUrls, waitTimeout);

      // Kiểm tra lại UI xem số trang có tăng không
      const pageInfoAfter = getFlipbookPageInfo();
      const pageNumberChanged =
        pageInfoAfter.current && pageInfoBefore.current &&
        pageInfoAfter.current > pageInfoBefore.current;

      if (newUrls.length > 0) {
        for (const url of newUrls) {
          if (!seenUrls.has(url)) {
            seenUrls.add(url);
            state.pages.push(url);
          }
        }
        noNewCount = 0;
        console.log(`[Flipbook-DL] Thu thập được ${newUrls.length} ảnh mới (Tổng: ${state.pages.length}/${state.total || '?'})`);
      } else if (pageNumberChanged) {
        // UI đã lật sang trang mới nhưng ảnh có thể đang tải chậm
        console.log(`[Flipbook-DL] Trang đã chuyển sang trang ${pageInfoAfter.current}, tiếp tục...`);
        noNewCount = 0;
      } else {
        noNewCount++;
        console.log(`[Flipbook-DL] Lần lật #${flipCount}: chưa thấy ảnh mới (${noNewCount}/${MAX_NO_NEW})`);

        if (noNewCount >= MAX_NO_NEW) {
          console.log(`[Flipbook-DL] Đã lật ${MAX_NO_NEW} lần liên tiếp không có thêm ảnh. Kết thúc lật.`);
          break;
        }
      }

      // Cập nhật tiến trình cho popup
      reportProgress(false);

      // Nghỉ giữa các lần lật theo cấu hình của user
      await sleep(flipDelay);
    }

    // Sắp xếp lại danh sách ảnh theo thứ tự số trang
    state.pages = sortImageUrls(state.pages);
    state.status = state.flipCancelled ? 'idle' : 'done';
    console.log(`[Flipbook-DL] Đã lật xong! Tổng thu thập: ${state.pages.length} trang.`);

    reportProgress(true);

    return {
      pages: state.pages,
      total: state.total || state.pages.length,
      title: state.title,
      platform: state.platform
    };
  }

  /* ────────────── Thực hiện lật trang ────────────── */

  let cachedNextButton = null;

  async function doFlip(attempt = 1) {
    // 1. Thử dùng nút Next
    const nextBtn = findNextButton();
    if (nextBtn) {
      if (isButtonDisabled(nextBtn)) {
        return 'end'; // Đã ở trang cuối
      }
      triggerFullClick(nextBtn);
      return 'ok';
    }

    // 2. Gửi phím mũi tên phải (ArrowRight) và PageDown
    sendKey('ArrowRight');
    sendKey('PageDown');
    await sleep(200);

    // 3. Click vùng bên phải sách (chuột full mousedown + mouseup + click)
    clickRightSide();

    // 4. Click góc dưới bên phải (nơi gập trang của FlipHTML5/TurnJS)
    clickBottomRightCorner();

    // 5. Thử tìm input số trang và tăng trang
    tryIncrementPageInput();

    return 'ok';
  }

  /**
   * Tìm nút Next bằng danh sách selector đặc thù
   */
  function findNextButton() {
    if (cachedNextButton && isElementClickable(cachedNextButton)) {
      return cachedNextButton;
    }

    const selectors = [
      // FlipHTML5
      '.stArrowRight',
      '#btn_right_arrow',
      '.flip-arrow-right',
      '.arrow-right',
      '.btnRightArrow',
      '.button-right',
      '.fliphtml5-next',
      '#nextBtn',
      '#next-button',
      '.flowpaper-btn-next',
      '.flowpaper_bttnNextPage',
      '.flowpaper-btn-forward',
      // AnyFlip
      '.right-arrow-page',
      '.nextPage',
      '.buttonNext',
      // Heyzine
      '[data-action="next"]',
      '.hz-nav-next',
      // Selectors phổ biến khác
      '[class*="ArrowRight" i]',
      '[class*="rightArrow" i]',
      '[class*="arrow-right" i]',
      '[class*="btn-next" i]',
      '[class*="next-btn" i]',
      '[class*="nextPage" i]',
      '[class*="next-page" i]',
      '[class*="page-next" i]',
      '[class*="nav-next" i]',
      '[class*="navRight" i]',
      '[id*="next" i]',
      '[id*="arrow_right" i]',
      '[id*="btnRight" i]',
      'button[title*="Next" i]',
      'button[title*="trang sau" i]',
      'button[aria-label*="Next" i]',
      'button[aria-label*="trang sau" i]',
      'a[title*="Next" i]',
      'a[title*="trang sau" i]',
      '[role="button"][title*="Next" i]',
      '[role="button"][aria-label*="Next" i]',
      '.flipbook-nav-next',
      '.turn-next'
    ];

    // Tìm trong document chính
    for (const sel of selectors) {
      try {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (isElementClickable(el)) {
            cachedNextButton = el;
            return el;
          }
        }
      } catch {}
    }

    // Tìm trong các iframe (nếu cùng nguồn)
    try {
      const iframes = document.querySelectorAll('iframe');
      for (const iframe of iframes) {
        try {
          const doc = iframe.contentDocument;
          if (!doc) continue;
          for (const sel of selectors) {
            const el = doc.querySelector(sel);
            if (el && isElementClickable(el)) {
              cachedNextButton = el;
              return el;
            }
          }
        } catch {}
      }
    } catch {}

    // Heuristic: Tìm button ở nửa phải màn hình có text hoặc icon chỉ trang sau
    const candidates = document.querySelectorAll('button, a, [role="button"], [onclick], div[class*="btn"], span[class*="btn"]');
    for (const el of candidates) {
      if (!isElementClickable(el)) continue;
      const text = (el.textContent || '').trim();
      const title = el.getAttribute('title') || '';
      const aria = el.getAttribute('aria-label') || '';
      const comb = `${text} ${title} ${aria}`.toLowerCase();

      if (
        text === '›' || text === '>' || text === '→' || text === '▶' || text === '»' ||
        comb.includes('next') || comb.includes('trang sau') || comb.includes('forward')
      ) {
        const rect = el.getBoundingClientRect();
        if (rect.left > window.innerWidth / 2) {
          cachedNextButton = el;
          return el;
        }
      }
    }

    return null;
  }

  function isElementClickable(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (style.pointerEvents === 'none') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isButtonDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const cls = el.className || '';
    if (typeof cls === 'string' && /(disabled|btn-disable|btn-disabled|disable|flowpaper-btn-disabled)/i.test(cls)) {
      return true;
    }
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    return false;
  }

  /**
   * Phát đầy đủ chuỗi sự kiện chuột/pointer để kích hoạt lật trang
   */
  function triggerFullClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y
    };

    try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch {}
    try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch {}
    try { el.dispatchEvent(new MouseEvent('click', opts)); } catch {}
    try {
      if (typeof el.click === 'function') el.click();
    } catch {}
  }

  /**
   * Gửi phím bàn phím tới window, document và viewer container
   */
  function sendKey(key) {
    const keyCode = key === 'ArrowRight' ? 39 : key === 'PageDown' ? 34 : key === 'Space' ? 32 : 0;
    const eventParams = {
      key,
      code: key,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      view: window
    };

    const targets = [
      window,
      document,
      document.documentElement,
      document.body,
      document.activeElement,
      document.querySelector('#flipbook, .flipbook, .viewer, #bookContainer, .flowpaper, .flowpaper-viewer')
    ].filter(Boolean);

    for (const type of ['keydown', 'keypress', 'keyup']) {
      for (const target of targets) {
        try {
          target.dispatchEvent(new KeyboardEvent(type, eventParams));
        } catch {}
      }
    }
  }

  /**
   * Click vào vùng bên phải của sách
   */
  function clickRightSide() {
    const viewer = document.querySelector(
      '#flipbook, .flipbook, .flip-viewer, .viewer, .book-container, ' +
      '#bookContainer, .fliphtml5-viewer, .anyflip-viewer, [class*="flipbook"], .flowpaper'
    ) || document.body;

    const rect = viewer.getBoundingClientRect();
    const x = rect.left + rect.width * 0.85;
    const y = rect.top + rect.height * 0.5;

    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    viewer.dispatchEvent(new MouseEvent('mousedown', opts));
    viewer.dispatchEvent(new MouseEvent('mouseup', opts));
    viewer.dispatchEvent(new MouseEvent('click', opts));
  }

  /**
   * Click và kéo góc dưới bên phải (gập trang)
   */
  function clickBottomRightCorner() {
    const viewer = document.querySelector(
      '#flipbook, .flipbook, .flip-viewer, .viewer, #bookContainer, .flowpaper'
    ) || document.body;

    const rect = viewer.getBoundingClientRect();
    const startX = rect.left + rect.width * 0.95;
    const startY = rect.top + rect.height * 0.95;
    const endX = rect.left + rect.width * 0.5;
    const endY = startY;

    try {
      viewer.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: startX, clientY: startY, view: window }));
      viewer.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: endX, clientY: endY, view: window }));
      viewer.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: endX, clientY: endY, view: window }));
    } catch {}
  }

  /**
   * Tăng số trang trong input nếu có
   */
  function tryIncrementPageInput() {
    const inputs = document.querySelectorAll('input.flowpaper-input-page, input[type="text"], input[type="number"], input:not([type])');
    for (const input of inputs) {
      const val = parseInt(input.value);
      if (!isNaN(val) && val >= 1) {
        const nextVal = val + 1;
        input.value = String(nextVal);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return true;
      }
    }
    return false;
  }

  /* ────────────── Thông tin số trang từ UI ────────────── */

  function getFlipbookPageInfo() {
    let current = null;
    let total = null;

    // 1. Input số trang
    const inputs = document.querySelectorAll('input.flowpaper-input-page, input[type="text"], input[type="number"], input:not([type])');
    for (const input of inputs) {
      const val = parseInt(input.value);
      const max = parseInt(input.max || input.getAttribute('data-total') || input.getAttribute('data-pages'));
      if (!isNaN(val) && val >= 1) {
        current = val;
        if (!isNaN(max) && max > val) {
          return { current: val, total: max };
        }
        const parent = input.parentElement;
        if (parent) {
          const match = parent.textContent.match(/\/\s*(\d+)/);
          if (match) {
            return { current: val, total: parseInt(match[1]) };
          }
        }
      }
    }

    // 2. Text dạng "X / Y" hoặc "X of Y"
    const textEls = document.querySelectorAll(
      '.flowpaper-lbl-page, .page-number, .page-num, .hz-page-number, [class*="pageNum"], [class*="pageCount"], #lblTotalPages'
    );
    for (const el of textEls) {
      const match = el.textContent.match(/(\d+)\s*(?:\/|of|trên)\s*(\d+)/i);
      if (match) {
        return { current: parseInt(match[1]), total: parseInt(match[2]) };
      }
      const matchTotalOnly = el.textContent.match(/\/\s*(\d+)/);
      if (matchTotalOnly && !total) {
        total = parseInt(matchTotalOnly[1]);
      }
    }

    return { current, total };
  }

  /* ────────────── Chờ ảnh mới (kết hợp DOM + Network) ────────────── */

  function waitForNewImages(seenUrls, timeout = 4000) {
    return new Promise((resolve) => {
      const newUrls = [];
      let settled = false;
      let foundTimer = null;

      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(pollInterval);
        if (foundTimer) clearTimeout(foundTimer);
        resolve(newUrls);
      };

      const addIfNew = (src) => {
        if (!src || seenUrls.has(src) || newUrls.includes(src)) return false;
        if (!isFlipbookImageUrl(src)) return false;
        newUrls.push(src);
        return true;
      };

      const checkAll = async () => {
        let found = false;

        // 1. Quét DOM img
        document.querySelectorAll('img').forEach((img) => {
          const src = img.src || img.dataset.src || img.dataset.lazySrc || img.dataset.original;
          if (!src || !src.startsWith('http')) return;
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (Math.max(w, h) >= 300 || (w === 0 && h === 0 && !src.includes('data:'))) {
            if (addIfNew(src)) found = true;
          }
        });

        // 2. background-image
        document.querySelectorAll('[style*="background"]').forEach((el) => {
          const bg = getComputedStyle(el).backgroundImage;
          const match = bg?.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
          if (match && addIfNew(match[1])) found = true;
        });

        // 3. SVG image
        document.querySelectorAll('image').forEach((img) => {
          const href = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
          if (href && href.startsWith('http') && addIfNew(href)) found = true;
        });

        // 4. KIỂM TRA NETWORK TỪ BACKGROUND (CỰC KỲ QUAN TRỌNG CHO CANVAS/WEBGL FLIPBOOK)
        try {
          const resp = await sendToBackground({ type: 'GET_NETWORK_IMAGES' });
          const netUrls = resp?.urls || [];
          for (const u of netUrls) {
            if (addIfNew(u)) found = true;
          }
        } catch {}

        if (found && !foundTimer) {
          // Chờ thêm 600ms phòng trường hợp sách dạng 2 trang (spread) tải cùng lúc
          foundTimer = setTimeout(finish, 600);
        }
      };

      const observer = new MutationObserver(() => checkAll());
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'data-src', 'style', 'class']
      });

      const pollInterval = setInterval(checkAll, 300);
      const timer = setTimeout(finish, timeout);
      setTimeout(checkAll, 100);
    });
  }

  function isFlipbookImageUrl(url) {
    if (!url || !url.startsWith('http')) return false;
    if (/thumb|icon|logo|avatar|sprite|favicon|loader|spinner/i.test(url)) return false;
    // Pattern FlipHTML5, AnyFlip, Heyzine
    if (/files\/(large|page|mobile|shot)\/\d+\.(jpe?g|png|webp)/i.test(url)) return true;
    if (/(?:page|slide|img|p)[_-]?\d+\.(jpe?g|png|webp)/i.test(url)) return true;
    if (/\.(jpe?g|png|webp)(\?.*)?$/i.test(url)) return true;
    return false;
  }

  /* ────────────── Thu thập ảnh trang hiện tại ────────────── */

  function collectVisiblePageImages() {
    const urls = [];
    document.querySelectorAll('img').forEach((img) => {
      const src = img.src || img.dataset.src || img.dataset.lazySrc || img.dataset.original;
      if (!src || !src.startsWith('http')) return;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (Math.max(w, h) >= 300 && isFlipbookImageUrl(src)) {
        if (!urls.includes(src)) urls.push(src);
      }
    });

    document.querySelectorAll('[style*="background"]').forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      const match = bg?.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
      if (match && isFlipbookImageUrl(match[1]) && !urls.includes(match[1])) {
        urls.push(match[1]);
      }
    });

    return urls;
  }

  function sortImageUrls(urls) {
    const rank = (u) => (/\/files\/large\//i.test(u) ? 0 : /\/files\/page\//i.test(u) ? 1 : 2);
    const baseName = (u) => (u.split(/[?#]/)[0].split('/').pop() || '').replace(/\.[a-z0-9]+$/i, '');

    const order = [];
    const best = new Map();
    for (const u of new Set(urls)) {
      const key = u.startsWith('data:') ? u : baseName(u);
      if (!best.has(key)) {
        best.set(key, u);
        order.push(key);
      } else if (rank(u) < rank(best.get(key))) {
        best.set(key, u);
      }
    }
    const unique = order.map((k) => best.get(k));

    if (unique.every((u) => /^\d+$/.test(baseName(u)))) {
      unique.sort((a, b) => parseInt(baseName(a)) - parseInt(baseName(b)));
    }
    return unique;
  }

  /* ────────────── Helpers ────────────── */

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function sendToBackground(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function reportProgress(done = false) {
    try {
      chrome.runtime.sendMessage({
        type: 'FLIP_PROGRESS',
        data: {
          currentPage: state.pages.length,
          total: state.total || state.pages.length,
          status: state.status,
          done,
          pages: done ? state.pages : undefined
        }
      });
    } catch {}
  }

  console.log('[Flipbook-DL] Content script đã khởi tạo với hỗ trợ lật toàn bộ cuốn sách.');
})();
