/**
 * generic.js – Adapter mặc định (fallback)
 * Dùng kết hợp DOM scan + network heuristic để phát hiện ảnh trang flipbook.
 */

// Đăng ký adapter vào mảng global
window.__flipbookAdapters = window.__flipbookAdapters || [];

window.__flipbookAdapters.push({
  name: 'Generic',
  priority: 0, // thấp nhất, dùng làm fallback

  /**
   * Luôn match – đây là adapter mặc định
   */
  match(url) {
    return true;
  },

  /**
   * Quét DOM và network để tìm ảnh trang
   * @param {Object} context – { tabId, networkUrls }
   * @returns {Promise<{pages: string[], total: number|null, title: string, platform: string}>}
   */
  async extractPages(context) {
    const { networkUrls = [] } = context;
    const results = [];

    // ─── 1. Tìm config toàn cục ───
    const configInfo = this._findGlobalConfig();

    // ─── 2. Quét DOM: img, canvas, SVG image, background-image ───
    const domImages = this._scanDOM();

    // ─── 3. Phân tích network URLs ───
    const networkPages = this._analyzeNetworkUrls(networkUrls);

    // ─── 4. Kết hợp và dedup ───
    const allUrls = new Map(); // url -> { index, source }

    // Ưu tiên config nếu có
    if (configInfo.pages.length > 0) {
      configInfo.pages.forEach((url, i) => {
        allUrls.set(url, { index: i, source: 'config' });
      });
    }

    // Thêm network pages (thường có pattern rõ ràng)
    networkPages.forEach((url, i) => {
      if (!allUrls.has(url)) {
        allUrls.set(url, { index: allUrls.size + i, source: 'network' });
      }
    });

    // Thêm DOM images
    domImages.forEach((url, i) => {
      if (!allUrls.has(url)) {
        allUrls.set(url, { index: allUrls.size + i, source: 'dom' });
      }
    });

    // Sắp xếp theo số trang trong URL nếu có
    const sorted = [...allUrls.entries()].sort((a, b) => {
      const numA = this._extractPageNumber(a[0]);
      const numB = this._extractPageNumber(b[0]);
      if (numA !== null && numB !== null) return numA - numB;
      if (numA !== null) return -1;
      if (numB !== null) return 1;
      return a[1].index - b[1].index;
    });

    const pages = sorted.map(([url]) => url);

    return {
      pages,
      total: configInfo.total ?? pages.length,
      title: configInfo.title || document.title || 'flipbook',
      platform: 'Generic'
    };
  },

  /**
   * Tìm biến config toàn cục (bookConfig, htmlConfig, config…)
   */
  _findGlobalConfig() {
    const result = { pages: [], total: null, title: '' };

    // Danh sách tên biến phổ biến
    const configNames = ['bookConfig', 'htmlConfig', 'bookData', 'pageData', 'flipbookConfig'];
    for (const name of configNames) {
      try {
        const cfg = window[name];
        if (!cfg || typeof cfg !== 'object') continue;

        // Tìm mảng trang
        const pageArrayKeys = ['pages', 'pageImages', 'pageList', 'items', 'spreads'];
        for (const key of pageArrayKeys) {
          if (Array.isArray(cfg[key])) {
            const urls = cfg[key]
              .map((p) => (typeof p === 'string' ? p : p?.src || p?.url || p?.image || null))
              .filter(Boolean)
              .map((u) => this._resolveUrl(u));
            if (urls.length > 0) {
              result.pages = urls;
            }
          }
        }

        // Tổng trang
        if (cfg.totalPages || cfg.pageCount || cfg.total) {
          result.total = cfg.totalPages || cfg.pageCount || cfg.total;
        }

        // Tiêu đề
        if (cfg.title || cfg.bookTitle || cfg.name) {
          result.title = cfg.title || cfg.bookTitle || cfg.name;
        }

        if (result.pages.length > 0) break;
      } catch { /* bỏ qua lỗi cross-origin */ }
    }

    // Tìm trong thẻ <script> có JSON
    if (result.pages.length === 0) {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const script of scripts) {
        const text = script.textContent;
        // Tìm mảng URL ảnh
        const urlArrayMatch = text.match(/\[\s*"(https?:\/\/[^"]+\.(jpe?g|png|webp))"[\s\S]*?\]/);
        if (urlArrayMatch) {
          try {
            // Trích xuất mảng JSON
            const startIdx = text.indexOf(urlArrayMatch[0]);
            const jsonStr = urlArrayMatch[0];
            const arr = JSON.parse(jsonStr);
            const urls = arr.filter((u) => typeof u === 'string' && /\.(jpe?g|png|webp)/i.test(u));
            if (urls.length >= 2) {
              result.pages = urls.map((u) => this._resolveUrl(u));
            }
          } catch { /* parse thất bại, bỏ qua */ }
        }
      }
    }

    return result;
  },

  /**
   * Quét DOM tìm ảnh lớn (loại thumbnail, icon)
   */
  _scanDOM() {
    const MIN_SIZE = 400; // Ngưỡng cạnh dài tối thiểu (px)
    const urls = [];

    // <img>
    document.querySelectorAll('img').forEach((img) => {
      const w = img.naturalWidth || img.width || parseInt(img.getAttribute('width')) || 0;
      const h = img.naturalHeight || img.height || parseInt(img.getAttribute('height')) || 0;
      if (Math.max(w, h) >= MIN_SIZE || (w === 0 && h === 0)) {
        const src = img.src || img.dataset.src || img.dataset.lazySrc;
        if (src && src.startsWith('http')) {
          urls.push(src);
        }
      }
    });

    // <canvas> – không thể lấy URL, đánh dấu để xử lý riêng
    // (sẽ xử lý bằng toDataURL khi flip)

    // SVG <image>
    document.querySelectorAll('image').forEach((img) => {
      const href = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
      if (href && href.startsWith('http')) {
        urls.push(href);
      }
    });

    // background-image
    const allElements = document.querySelectorAll('[style*="background"]');
    allElements.forEach((el) => {
      const bg = getComputedStyle(el).backgroundImage;
      const match = bg?.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
      if (match) {
        const rect = el.getBoundingClientRect();
        if (Math.max(rect.width, rect.height) >= MIN_SIZE) {
          urls.push(match[1]);
        }
      }
    });

    // Dedup giữ thứ tự
    return [...new Set(urls)];
  },

  /**
   * Phân tích URLs từ network, phát hiện pattern số trang tăng dần
   */
  _analyzeNetworkUrls(urls) {
    if (!urls || urls.length === 0) return [];

    // Lọc chỉ ảnh lớn (bỏ thumbnail, icon)
    const imageUrls = urls.filter((u) =>
      /\.(jpe?g|png|webp|avif)(\?|$)/i.test(u) &&
      !/thumb|icon|logo|avatar|sprite|banner/i.test(u)
    );

    if (imageUrls.length === 0) return [];

    // Tìm pattern số tăng dần
    const patterns = new Map(); // pattern template -> [{ url, num }]

    for (const url of imageUrls) {
      // Tìm các số trong URL
      const matches = [...url.matchAll(/(\d+)/g)];
      for (const m of matches) {
        const num = parseInt(m[1]);
        if (num > 5000) continue; // Số quá lớn, không phải trang
        const template = url.slice(0, m.index) + '###' + url.slice(m.index + m[1].length);
        if (!patterns.has(template)) {
          patterns.set(template, []);
        }
        patterns.get(template).push({ url, num });
      }
    }

    // Chọn pattern có nhiều URL nhất và số liên tục
    let bestPattern = null;
    let bestCount = 0;

    for (const [template, items] of patterns) {
      // Dedup theo số
      const unique = new Map();
      items.forEach((item) => unique.set(item.num, item.url));
      if (unique.size > bestCount && unique.size >= 2) {
        bestCount = unique.size;
        bestPattern = { template, items: unique };
      }
    }

    if (!bestPattern) return imageUrls;

    // Sắp xếp theo số trang
    const sorted = [...bestPattern.items.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, url]) => url);

    // Suy ra các trang thiếu
    const nums = [...bestPattern.items.keys()].sort((a, b) => a - b);
    const min = nums[0];
    const max = nums[nums.length - 1];
    const allPages = [];

    for (let i = min; i <= max; i++) {
      if (bestPattern.items.has(i)) {
        allPages.push(bestPattern.items.get(i));
      } else {
        // Sinh URL cho trang thiếu
        const numStr = String(i).padStart(String(max).length, '0');
        const inferredUrl = bestPattern.template.replace('###', numStr);
        allPages.push(inferredUrl);
      }
    }

    return allPages;
  },

  /**
   * Trích xuất số trang từ URL
   */
  _extractPageNumber(url) {
    // Tìm pattern phổ biến: page_1, page-1, /1.jpg, 001.webp…
    const patterns = [
      /page[_-]?(\d+)/i,
      /p(\d+)\./i,
      /(\d+)\.(jpe?g|png|webp|avif)(\?|$)/i,
      /[/_-](\d+)[/_-]/
    ];
    for (const pat of patterns) {
      const m = url.match(pat);
      if (m) return parseInt(m[1]);
    }
    return null;
  },

  /**
   * Chuyển URL tương đối thành tuyệt đối
   */
  _resolveUrl(url) {
    if (url.startsWith('http')) return url;
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }
});
