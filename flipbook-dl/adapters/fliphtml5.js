/**
 * fliphtml5.js – Adapter cho FlipHTML5
 * Hỗ trợ nhận diện toàn bộ cuốn sách từ mainWorldData, script DOM, config file và network sniffing.
 */

window.__flipbookAdapters = window.__flipbookAdapters || [];

window.__flipbookAdapters.push({
  name: 'FlipHTML5',
  priority: 10,

  match(url) {
    return (
      /fliphtml5\.com/i.test(url) ||
      !!document.querySelector('#flipbook, .fliphtml5-viewer, #bookContainer, .flowpaper, .stArrowRight, #btn_right_arrow') ||
      !!document.querySelector('script[src*="fliphtml5"], script[src*="flowpaper"]') ||
      Array.from(document.scripts).some((s) => /htmlConfig|bookConfig|fliphtml5/i.test(s.textContent || ''))
    );
  },

  async extractPages(context) {
    const { networkUrls = [], mainWorldData = {} } = context;
    const pages = [];
    let total = null;
    let title = mainWorldData.title || document.title || 'fliphtml5-book';
    let patternPrefix = null;
    let patternExt = 'jpg';
    let isPadded = false;
    let padLength = 0;

    // ─── 0. Nếu main world đã trích xuất được danh sách trang thật ───
    if (Array.isArray(mainWorldData.pages) && mainWorldData.pages.length > 0) {
      console.log(`[Flipbook-DL] Trích xuất thành công ${mainWorldData.pages.length} trang từ main world!`);
      return {
        pages: mainWorldData.pages,
        total: mainWorldData.total || mainWorldData.pages.length,
        title: mainWorldData.title || title,
        platform: 'FlipHTML5'
      };
    }

    // ─── 1. Kiểm tra mainWorldData (lấy trực tiếp từ window của trang) ───
    const cfg = mainWorldData.htmlConfig || mainWorldData.bookConfig || mainWorldData.config;
    if (cfg) {
      total = cfg.totalPageCount || cfg.pageCount || cfg.total || null;
      title = cfg.bookTitle || cfg.title || title;

      if (Array.isArray(cfg.pages) && cfg.pages.length > 0) {
        for (const p of cfg.pages) {
          const src = typeof p === 'string' ? p : p?.src || p?.n || p?.url || p?.large;
          if (src) pages.push(this._resolveUrl(src));
        }
      }
    }

    if (!total && mainWorldData.defined_pagesCount) {
      total = parseInt(mainWorldData.defined_pagesCount);
    }
    if (!total && mainWorldData.defined_totalPage) {
      total = parseInt(mainWorldData.defined_totalPage);
    }

    // ─── 1b. FlipHTML5 thật: danh sách tên file ảnh nằm trong fliphtml5_pages ───
    let realNames = this._namesFromConfig(cfg);
    if (realNames.length === 0) {
      const baseForCfg = this._getBaseUrl();
      for (const rel of ['javascript/config.js', 'config.js', 'javascript/config.json']) {
        try {
          const resp = await fetch(baseForCfg + rel, { credentials: 'include' });
          if (!resp.ok) continue;
          const text = await resp.text();
          realNames = this._namesFromText(text);
          if (realNames.length > 0) break;
        } catch {}
      }
    }
    if (realNames.length > 0) {
      const filesBase = this._getBaseUrl() + 'files/large/';
      const realPages = realNames.map((n) => this._resolveWith(n, filesBase));
      return {
        pages: realPages,
        total: realPages.length,
        title,
        platform: 'FlipHTML5'
      };
    }

    // ─── 2. Quét các thẻ <script> trong DOM tìm config ───
    if (!total || pages.length === 0) {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const text = s.textContent || '';
        if (!text) continue;

        if (!total) {
          const matchTotal =
            text.match(/["']?totalPageCount["']?\s*[:=]\s*(\d+)/i) ||
            text.match(/["']?defined_pagesCount["']?\s*[:=]\s*(\d+)/i) ||
            text.match(/["']?pageCount["']?\s*[:=]\s*(\d+)/i) ||
            text.match(/["']?totalPage["']?\s*[:=]\s*(\d+)/i);
          if (matchTotal) {
            total = parseInt(matchTotal[1]);
          }
        }

        // Tìm mảng pages trong script
        if (pages.length === 0 && text.includes('pages')) {
          try {
            const pagesMatch = text.match(/["']?pages["']?\s*:\s*(\[[^\]]{20,}\])/);
            if (pagesMatch) {
              const parsed = JSON.parse(pagesMatch[1]);
              if (Array.isArray(parsed)) {
                for (const p of parsed) {
                  const src = typeof p === 'string' ? p : p?.src || p?.n || p?.url;
                  if (src) pages.push(this._resolveUrl(src));
                }
              }
            }
          } catch {}
        }
      }
    }

    // ─── 3. Quét UI DOM để tìm tổng số trang nếu chưa biết ───
    if (!total) {
      total = this._detectTotalFromUI();
    }

    // ─── 4. Tìm URL pattern từ network URLs hoặc ảnh DOM ───
    const allImageUrls = [
      ...networkUrls,
      ...Array.from(document.images).map((img) => img.src || img.dataset.src || '').filter(Boolean)
    ];

    for (const u of allImageUrls) {
      const match = u.match(/(https?:\/\/[^?#]+\/files\/(?:large|page|mobile)\/)(\d+)\.([a-z0-9]+)/i);
      if (match) {
        patternPrefix = match[1];
        const numStr = match[2];
        patternExt = match[3];
        if (numStr.length > 1 && numStr.startsWith('0')) {
          isPadded = true;
          padLength = numStr.length;
        }
        break;
      }
    }

    // ─── 5. Thử fetch file config nếu vẫn thiếu thông tin ───
    if ((!total || !patternPrefix) && pages.length === 0) {
      const baseUrl = this._getBaseUrl();
      const configCandidates = [
        `${baseUrl}javascript/config.js`,
        `${baseUrl}extdata/config.json`,
        `${baseUrl}config.js`,
        `${baseUrl}config.json`
      ];

      for (const cfgUrl of configCandidates) {
        try {
          const resp = await fetch(cfgUrl, { credentials: 'include' });
          if (!resp.ok) continue;
          const text = await resp.text();

          if (!total) {
            const m = text.match(/["']?totalPageCount["']?\s*[:=]\s*(\d+)/i) ||
                      text.match(/["']?pageCount["']?\s*[:=]\s*(\d+)/i);
            if (m) total = parseInt(m[1]);
          }

          // Kiểm tra mảng trang
          const mPages = text.match(/["']?pages["']?\s*:\s*(\[[^\]]+\])/);
          if (mPages) {
            try {
              const arr = JSON.parse(mPages[1]);
              for (const p of arr) {
                const src = typeof p === 'string' ? p : p?.src || p?.n;
                if (src) pages.push(this._resolveUrl(src));
              }
            } catch {}
          }
          if (total) break;
        } catch {}
      }
    }

    // ─── 6. Nếu đã có tổng số trang và pattern prefix: tạo đầy đủ danh sách trang ───
    const baseUrl = this._getBaseUrl();
    const effectivePrefix = patternPrefix || `${baseUrl}files/large/`;

    if (total && total > 0 && !patternPrefix) {
      const probe = `${effectivePrefix}1.${patternExt}`;
      let ok = false;
      for (const f of ['large', 'page', 'mobile']) {
        for (const e of ['jpg', 'webp', 'png', 'jpeg']) {
          try {
            const r = await fetch(probe.replace(/files\/[a-z]+\/1\.[a-z]+$/i, `files/${f}/1.${e}`), { method: 'HEAD', credentials: 'include' });
            if (r.ok) { ok = true; break; }
          } catch {}
        }
        if (ok) break;
      }
      if (!ok) {
        // Tên file ảnh không phải số thứ tự → cần lật để bắt URL thật
        return { pages: [], total, title, platform: 'FlipHTML5' };
      }
    }

    if (total && total > 0) {
      const generatedPages = [];
      for (let i = 1; i <= total; i++) {
        const pageNum = isPadded ? String(i).padStart(padLength, '0') : String(i);
        generatedPages.push(`${effectivePrefix}${pageNum}.${patternExt}`);
      }
      return {
        pages: generatedPages,
        total,
        title,
        platform: 'FlipHTML5'
      };
    }

    // ─── 7. Fallback: Nếu có danh sách pages đã parse được ───
    if (pages.length > 0) {
      const sortedPages = this._sortPages(pages);
      return {
        pages: sortedPages,
        total: total || sortedPages.length,
        title,
        platform: 'FlipHTML5'
      };
    }

    // ─── 8. Fallback: Lọc từ network URLs ───
    const flipUrls = networkUrls.filter((u) =>
      /files\/(large|page|mobile)\/\d+\.(jpe?g|png|webp)/i.test(u)
    );
    if (flipUrls.length > 0) {
      const sortedPages = this._sortPages(flipUrls);
      return {
        pages: sortedPages,
        total: total || sortedPages.length,
        title,
        platform: 'FlipHTML5'
      };
    }

    return {
      pages: [],
      total: total || 0,
      title,
      platform: 'FlipHTML5'
    };
  },

  _namesFromConfig(cfg) {
    const arr = cfg && (cfg.fliphtml5_pages || cfg.flipHtml5Pages);
    return this._namesFromArray(arr);
  },

  _namesFromArray(arr) {
    if (!Array.isArray(arr)) return [];
    const out = [];
    for (const p of arr) {
      let n = typeof p === 'string' ? p : p?.n ?? p?.src;
      if (Array.isArray(n)) n = n[0];
      if (typeof n === 'string' && n) out.push(n);
    }
    return out;
  },

  _namesFromText(text) {
    const idx = text.search(/["']?fliphtml5_pages["']?\s*[:=]/i);
    if (idx < 0) return [];
    const start = text.indexOf('[', idx);
    if (start < 0) return [];
    let depth = 0;
    let inStr = false;
    let quote = '';
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === quote) inStr = false;
        continue;
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; }
      else if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (depth === 0) {
          try {
            return this._namesFromArray(JSON.parse(text.slice(start, i + 1)));
          } catch { return []; }
        }
      }
    }
    return [];
  },

  _resolveWith(name, base) {
    try {
      return new URL(name, base).href;
    } catch {
      return base + name;
    }
  },

  _detectTotalFromUI() {
    // Tìm text dạng "X / Y"
    const textElements = document.querySelectorAll(
      '.flowpaper-lbl-page, .page-number, [class*="pageNum"], [class*="pageCount"], #lblTotalPages'
    );
    for (const el of textElements) {
      const m = el.textContent.match(/\/\s*(\d+)/);
      if (m) return parseInt(m[1]);
    }

    // Tìm input số trang có thuộc tính max
    const inputs = document.querySelectorAll('input.flowpaper-input-page, input[type="number"], input[type="text"]');
    for (const inp of inputs) {
      const max = parseInt(inp.max || inp.getAttribute('data-total'));
      if (!isNaN(max) && max > 1) return max;
      const parent = inp.parentElement;
      if (parent) {
        const m = parent.textContent.match(/\/\s*(\d+)/);
        if (m) return parseInt(m[1]);
      }
    }

    return null;
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
