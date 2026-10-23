/**
 * heyzine.js – Adapter cho Heyzine
 * Nhận diện qua URL hoặc cấu trúc DOM/API đặc trưng.
 */

window.__flipbookAdapters = window.__flipbookAdapters || [];

window.__flipbookAdapters.push({
  name: 'Heyzine',
  priority: 10,

  match(url) {
    return (
      /heyzine\.com/i.test(url) ||
      !!document.querySelector('.heyzine-viewer, [data-heyzine], #heyzine-container')
    );
  },

  async extractPages(context) {
    const pages = [];
    let total = null;
    let title = document.title || 'heyzine-book';

    // ─── Cách 1: Tìm dữ liệu trong window.__NEXT_DATA__ hoặc biến tương tự ───
    const nextData = window.__NEXT_DATA__;
    if (nextData?.props?.pageProps) {
      const props = nextData.props.pageProps;
      // Heyzine thường dùng Next.js
      if (props.flipbook?.pages || props.pages) {
        const pagesData = props.flipbook?.pages || props.pages;
        if (Array.isArray(pagesData)) {
          for (const p of pagesData) {
            const src = typeof p === 'string' ? p : p?.src || p?.url || p?.image;
            if (src) pages.push(this._resolveUrl(src));
          }
        }
        total = props.flipbook?.totalPages || props.totalPages || pagesData.length;
        title = props.flipbook?.title || props.title || title;
      }
    }

    // ─── Cách 2: Quét thẻ <script> tìm JSON data ───
    if (pages.length === 0) {
      const scripts = document.querySelectorAll('script:not([src])');
      for (const script of scripts) {
        const text = script.textContent || '';
        // Tìm mảng pages trong JSON
        const match = text.match(/"pages"\s*:\s*(\[[\s\S]*?\])/);
        if (match) {
          try {
            const arr = JSON.parse(match[1]);
            for (const p of arr) {
              const src = typeof p === 'string' ? p : p?.src || p?.url || p?.image;
              if (src) pages.push(this._resolveUrl(src));
            }
          } catch { /* parse thất bại */ }
        }
        if (pages.length > 0) break;
      }
    }

    // ─── Cách 3: Quét DOM ───
    if (pages.length === 0) {
      const selectors = [
        '.page-image img',
        '.flipbook-page img',
        'canvas.page-canvas',
        '[class*="page"] img[src*="heyzine"]'
      ];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => {
          if (el.tagName === 'CANVAS') {
            // Canvas cần xử lý riêng (toDataURL)
            return;
          }
          const src = el.src || el.dataset.src;
          if (src && !pages.includes(src)) {
            pages.push(src);
          }
        });
        if (pages.length > 0) break;
      }
    }

    // ─── Cách 4: Network URLs ───
    if (pages.length === 0 && context.networkUrls?.length > 0) {
      const heyUrls = context.networkUrls.filter((u) =>
        /heyzine\.com/i.test(u) && /\.(jpe?g|png|webp)/i.test(u)
      );
      if (heyUrls.length > 0) {
        // Sắp xếp theo số trang
        heyUrls.sort((a, b) => {
          const na = parseInt(a.match(/(\d+)\.[^.]+$/)?.[1] || '0');
          const nb = parseInt(b.match(/(\d+)\.[^.]+$/)?.[1] || '0');
          return na - nb;
        });
        pages.push(...heyUrls);
      }
    }

    return {
      pages: [...new Set(pages)],
      total: total || pages.length,
      title,
      platform: 'Heyzine'
    };
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
