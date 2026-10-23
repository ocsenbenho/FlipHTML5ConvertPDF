/**
 * anyflip.js – Adapter cho AnyFlip (eFlip, FlipBuilder)
 * Nhận diện qua URL hoặc cấu trúc DOM/config đặc trưng.
 */

window.__flipbookAdapters = window.__flipbookAdapters || [];

window.__flipbookAdapters.push({
  name: 'AnyFlip',
  priority: 10,

  match(url) {
    return (
      /anyflip\.com|eflip\.com|flipbuilder\.com/i.test(url) ||
      !!document.querySelector('.anyflip-viewer, #flipbook-container, .flipbook-desktop, .right-arrow-page') ||
      Array.from(document.scripts).some((s) => /defined_totalPage|anyflip/i.test(s.textContent || ''))
    );
  },

  async extractPages(context) {
    const { networkUrls = [], mainWorldData = {} } = context;
    const pages = [];
    let total = null;
    let title = mainWorldData.title || document.title || 'anyflip-book';
    let patternPrefix = null;
    let patternExt = 'jpg';

    // 1. Kiểm tra mainWorldData
    if (mainWorldData.defined_totalPage) {
      total = parseInt(mainWorldData.defined_totalPage);
    } else if (mainWorldData.defined_totalPageCount) {
      total = parseInt(mainWorldData.defined_totalPageCount);
    }

    const cfg = mainWorldData.bookConfig || mainWorldData.htmlConfig;
    if (cfg) {
      total = total || cfg.totalPage || cfg.pageCount || null;
      title = cfg.title || cfg.bookTitle || title;
      if (Array.isArray(cfg.pages)) {
        for (const p of cfg.pages) {
          const src = typeof p === 'string' ? p : p?.src || p?.n;
          if (src) pages.push(this._resolveUrl(src));
        }
      }
    }

    // 2. Kiểm tra script tags trong DOM
    if (!total || pages.length === 0) {
      for (const s of document.scripts) {
        const text = s.textContent || '';
        if (!text) continue;
        if (!total) {
          const m = text.match(/defined_totalPage\s*[:=]\s*(\d+)/i) ||
                    text.match(/totalPage(?:Count)?\s*[:=]\s*(\d+)/i);
          if (m) total = parseInt(m[1]);
        }
      }
    }

    // 3. Tìm pattern từ network URLs hoặc ảnh DOM
    const allImageUrls = [
      ...networkUrls,
      ...Array.from(document.images).map((img) => img.src || img.dataset.src || '').filter(Boolean)
    ];

    for (const u of allImageUrls) {
      const match = u.match(/(https?:\/\/[^?#]+\/files\/(?:large|mobile|page)\/)(\d+)\.([a-z0-9]+)/i);
      if (match) {
        patternPrefix = match[1];
        patternExt = match[3];
        break;
      }
    }

    const baseUrl = this._getBaseUrl();
    const effectivePrefix = patternPrefix || (mainWorldData.defined_basePath ? this._resolveUrl(mainWorldData.defined_basePath) + 'files/large/' : `${baseUrl}files/large/`);

    // 4. Nếu có tổng số trang và prefix: tạo toàn bộ danh sách trang
    if (total && total > 0) {
      const generatedPages = [];
      for (let i = 1; i <= total; i++) {
        generatedPages.push(`${effectivePrefix}${i}.${patternExt}`);
      }
      return {
        pages: generatedPages,
        total,
        title,
        platform: 'AnyFlip'
      };
    }

    // 5. Fallback: Dùng pages đã tìm được
    if (pages.length > 0) {
      return {
        pages: this._sortPages(pages),
        total: total || pages.length,
        title,
        platform: 'AnyFlip'
      };
    }

    // 6. Fallback: Network URLs
    const flipUrls = networkUrls.filter((u) =>
      /files\/(large|mobile|page)\/\d+\.(jpe?g|png|webp)/i.test(u)
    );
    if (flipUrls.length > 0) {
      const sorted = this._sortPages(flipUrls);
      return {
        pages: sorted,
        total: total || sorted.length,
        title,
        platform: 'AnyFlip'
      };
    }

    return {
      pages: [],
      total: total || 0,
      title,
      platform: 'AnyFlip'
    };
  },

  _getBaseUrl() {
    let href = location.href.split('#')[0].split('?')[0];
    if (/\.[a-z0-9]+$/i.test(href)) {
      href = href.substring(0, href.lastIndexOf('/') + 1);
    } else if (!href.endsWith('/')) {
      href = href + '/';
    }
    return href;
  },

  _sortPages(urls) {
    const unique = [...new Set(urls)];
    return unique.sort((a, b) => {
      const na = parseInt(a.match(/\/(\d+)\.[^/]+$/)?.[1] || '0');
      const nb = parseInt(b.match(/\/(\d+)\.[^/]+$/)?.[1] || '0');
      return na - nb;
    });
  },

  _resolveUrl(url) {
    if (url.startsWith('http')) return url;
    try {
      return new URL(url, document.baseURI).href;
    } catch {
      return url;
    }
  }
});
