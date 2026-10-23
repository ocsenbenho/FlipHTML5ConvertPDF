/**
 * offscreen.js – Chạy trong offscreen document
 * Fetch ảnh, chuyển đổi WebP/AVIF → JPG, ghép PDF bằng pdf-lib.
 * Service worker không có DOM nên mọi thao tác ảnh phải làm ở đây.
 */

(() => {
  'use strict';

  const { PDFDocument } = PDFLib; // pdf-lib đã load qua <script>

  /* ────────────── Nhận message ────────────── */
  const shots = []; // data URL ảnh chụp màn hình (đã cắt)
  let lastShot = null;

  /**
   * Tự động quét viền và loại bỏ màu nền đồng nhất bao quanh cuốn sách (loại bỏ viền đen, thanh toolbar)
   */
  function detectContentBoundingBox(bmp) {
    const W = bmp.width;
    const H = bmp.height;
    if (W < 200 || H < 200) return null;

    const scale = Math.min(1, 500 / Math.max(W, H));
    const sw = Math.round(W * scale);
    const sh = Math.round(H * scale);

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, sw, sh);

    const imgData = ctx.getImageData(0, 0, sw, sh);
    const data = imgData.data;

    function getPixel(x, y) {
      const idx = (y * sw + x) * 4;
      return [data[idx], data[idx + 1], data[idx + 2]];
    }

    const leftBg = getPixel(Math.min(10, Math.floor(sw * 0.02)), Math.floor(sh / 2));

    function colorDiff(c1, c2) {
      return Math.abs(c1[0] - c2[0]) + Math.abs(c1[1] - c2[1]) + Math.abs(c1[2] - c2[2]);
    }

    const topMargin = Math.round(40 * (H / 1080) * scale);
    const botMargin = Math.round(50 * (H / 1080) * scale);

    function isBackground(x, y) {
      const c = getPixel(x, y);
      return colorDiff(c, leftBg) < 32;
    }

    // Quét từ trái sang phải
    let minX = 0;
    for (let x = 0; x < sw / 2; x++) {
      let nonBgCount = 0;
      for (let y = topMargin; y < sh - botMargin; y += 3) {
        if (!isBackground(x, y)) nonBgCount++;
      }
      if (nonBgCount > (sh - topMargin - botMargin) / 3 * 0.2) {
        minX = x;
        break;
      }
    }

    // Quét từ phải sang trái
    let maxX = sw - 1;
    for (let x = sw - 1; x > sw / 2; x--) {
      let nonBgCount = 0;
      for (let y = topMargin; y < sh - botMargin; y += 3) {
        if (!isBackground(x, y)) nonBgCount++;
      }
      if (nonBgCount > (sh - topMargin - botMargin) / 3 * 0.2) {
        maxX = x;
        break;
      }
    }

    // Quét từ trên xuống dưới
    let minY = topMargin;
    for (let y = topMargin; y < sh / 2; y++) {
      let nonBgCount = 0;
      for (let x = minX + 5; x < maxX - 5; x += 3) {
        if (!isBackground(x, y)) nonBgCount++;
      }
      if (nonBgCount > (maxX - minX) / 3 * 0.2) {
        minY = y;
        break;
      }
    }

    // Quét từ dưới lên trên
    let maxY = sh - botMargin;
    for (let y = sh - botMargin; y > sh / 2; y--) {
      let nonBgCount = 0;
      for (let x = minX + 5; x < maxX - 5; x += 3) {
        if (!isBackground(x, y)) nonBgCount++;
      }
      if (nonBgCount > (maxX - minX) / 3 * 0.2) {
        maxY = y;
        break;
      }
    }

    const inv = 1 / scale;
    const realMinX = Math.max(0, Math.round(minX * inv));
    const realMaxX = Math.min(W, Math.round(maxX * inv));
    const realMinY = Math.max(0, Math.round(minY * inv));
    const realMaxY = Math.min(H, Math.round(maxY * inv));

    const realW = realMaxX - realMinX;
    const realH = realMaxY - realMinY;

    if (realW > 150 && realH > 150 && (realW < W * 0.96 || realH < H * 0.96)) {
      return { sx: realMinX, sy: realMinY, sw: realW, sh: realH };
    }
    return null;
  }

  /** Cắt ảnh chụp theo khung sách (crop tính bằng CSS px) và mã hoá JPEG */
  async function cropShot(dataUrl, crop, quality) {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    let sx = 0;
    let sy = 0;
    let sw = bmp.width;
    let sh = bmp.height;

    const s = (crop && crop.vw > 0) ? (bmp.width / crop.vw) : 1;

    if (crop && crop.w > 0 && crop.h > 0) {
      sx = Math.max(0, Math.round(crop.x * s));
      sy = Math.max(0, Math.round(crop.y * s));
      sw = Math.min(bmp.width - sx, Math.round(crop.w * s));
      sh = Math.min(bmp.height - sy, Math.round(crop.h * s));
    }

    // Tự động nhận diện cắt viền nền nếu crop trả về kích thước gần full màn hình (hoặc không có crop)
    if (sw >= bmp.width * 0.97 && sh >= bmp.height * 0.97) {
      const autoTrim = detectContentBoundingBox(bmp);
      if (autoTrim) {
        sx = autoTrim.sx;
        sy = autoTrim.sy;
        sw = autoTrim.sw;
        sh = autoTrim.sh;
        console.log('[Flipbook-DL] Đã tự động cắt viền nền ảnh:', { sx, sy, sw, sh, origW: bmp.width, origH: bmp.height });
      }
    }

    if (sw < 50 || sh < 50) {
      sx = 0; sy = 0; sw = bmp.width; sh = bmp.height;
    }

    const canvas = new OffscreenCanvas(sw, sh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    bmp.close();

    const out = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const url = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(out);
    });
    return { url, sw, sh, sx, sy };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'OFFSCREEN_BUILD_PDF') {
      buildPdf(msg.pages, msg.options)
        .then((result) => sendResponse(result))
        .catch((e) => sendResponse({ error: e.message }));
      return true; // async
    }
    if (msg.type === 'OFFSCREEN_SHOT_RESET') {
      shots.length = 0;
      lastShot = null;
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'OFFSCREEN_SHOT_ADD') {
      cropShot(msg.data, msg.crop, msg.quality || 0.95)
        .then(({ url: cropped }) => {
          shots.push(cropped);
          sendResponse({ count: shots.length });
        })
        .catch((e) => sendResponse({ error: e.message }));
      return true;
    }
    if (msg.type === 'OFFSCREEN_SHOT_POP') {
      shots.pop();
      sendResponse({ count: shots.length });
      return;
    }
    if (msg.type === 'OFFSCREEN_SHOT_BUILD') {
      buildPdf(shots.slice(), msg.options)
        .then((result) => { shots.length = 0; sendResponse(result); })
        .catch((e) => sendResponse({ error: e.message }));
      return true;
    }
  });

  /* ────────────── Ghép PDF ────────────── */
  /**
   * Tải ảnh và ghép thành 1 file PDF
   * @param {string[]} pageUrls - Danh sách URL ảnh
   * @param {Object} options - { quality, batchSize }
   * @returns {{ blobUrl: string, filename: string }}
   */
  async function buildPdf(pageUrls, options = {}) {
    const {
      quality = 0.92,
      batchSize = 10,
      title = 'flipbook'
    } = options;

    const totalPages = pageUrls.length;
    console.log(`[Flipbook-DL] Bắt đầu ghép PDF: ${totalPages} trang`);

    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(title);
    pdfDoc.setCreator('Flipbook to PDF Extension');

    let successCount = 0;
    const errors = [];

    // Xử lý theo lô để tiết kiệm bộ nhớ
    for (let batchStart = 0; batchStart < totalPages; batchStart += batchSize) {
      const batchEnd = Math.min(batchStart + batchSize, totalPages);
      const batch = pageUrls.slice(batchStart, batchEnd);

      // Fetch song song trong lô (giới hạn 3 concurrent)
      const batchResults = await fetchBatchWithConcurrency(batch, 3, quality);

      for (let i = 0; i < batchResults.length; i++) {
        const pageIndex = batchStart + i;
        const result = batchResults[i];

        if (result.error) {
          errors.push({ page: pageIndex + 1, error: result.error });
          console.warn(`[Flipbook-DL] Trang ${pageIndex + 1}: ${result.error}`);
          continue;
        }

        try {
          // Nhúng ảnh vào PDF (giữ nguyên dữ liệu gốc → chất lượng cao nhất)
          const imgBytes = result.data;
          let image;

          try {
            image = result.type === 'image/png'
              ? await pdfDoc.embedPng(imgBytes)
              : await pdfDoc.embedJpg(imgBytes);
          } catch (embedErr) {
            // JPEG/PNG đặc biệt (CMYK, interlaced...) → giải mã lại bằng canvas, chất lượng cao
            const re = await convertToJpeg(imgBytes, result.type, Math.max(quality, 0.95));
            image = await pdfDoc.embedJpg(re);
          }

          // Kích thước trang PDF = kích thước ảnh gốc (đơn vị point = px * 72/96 ≈ 0.75)
          // Nhưng để giữ nguyên pixel, dùng đúng width/height
          const page = pdfDoc.addPage([image.width, image.height]);
          page.drawImage(image, {
            x: 0,
            y: 0,
            width: image.width,
            height: image.height
          });

          successCount++;
        } catch (e) {
          errors.push({ page: pageIndex + 1, error: `Lỗi nhúng ảnh: ${e.message}` });
          console.warn(`[Flipbook-DL] Trang ${pageIndex + 1} lỗi nhúng:`, e);
        }
      }

      // Báo tiến trình
      reportProgress({
        phase: 'pdf',
        current: Math.min(batchEnd, totalPages),
        total: totalPages,
        successCount,
        errors: errors.length
      });

      // Nghỉ ngắn giữa các lô để GC có cơ hội dọn
      if (batchEnd < totalPages) {
        await sleep(50);
      }
    }

    if (successCount === 0) {
      const sample = errors.slice(0, 3).map((e) => `Trang ${e.page}: ${e.error}`).join(' | ');
      return { error: `Không nhúng được trang nào vào PDF. ${sample}` };
    }

    // Xuất PDF
    console.log('[Flipbook-DL] Đang xuất file PDF...');
    const pdfBytes = await pdfDoc.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    const blobUrl = URL.createObjectURL(blob);

    // Tên file sạch
    const cleanTitle = title
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 100);
    const filename = `${cleanTitle || 'flipbook'}.pdf`;

    console.log(`[Flipbook-DL] PDF hoàn tất: ${successCount}/${totalPages} trang, ${(pdfBytes.length / 1024 / 1024).toFixed(1)} MB`);

    return {
      blobUrl,
      filename,
      successCount,
      totalPages,
      errors,
      sizeBytes: pdfBytes.length
    };
  }

  /* ────────────── Fetch ảnh có retry + concurrency ────────────── */
  /**
   * Fetch 1 lô ảnh với giới hạn concurrent requests
   */
  async function fetchBatchWithConcurrency(urls, maxConcurrent, quality) {
    const results = new Array(urls.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < urls.length) {
        const idx = nextIndex++;
        results[idx] = await fetchImageWithRetry(urls[idx], quality);
      }
    }

    const workers = [];
    for (let i = 0; i < Math.min(maxConcurrent, urls.length); i++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    return results;
  }

  /**
   * Fetch 1 ảnh với retry tối đa 3 lần, backoff
   */
  /** Sinh các URL thay thế (large/page/mobile × jpg/webp/png) khi URL đoán bị 404 */
  function urlVariants(url) {
    const m = url.match(/^(.*\/files\/)(large|page|mobile|shot)(\/[^/?#]*?)(\.[a-z0-9]+)(\?.*)?$/i);
    if (!m) return [url];
    const [, head, folder, name, ext, qs = ''] = m;
    const folders = [folder, ...['large', 'page', 'mobile'].filter((f) => f !== folder.toLowerCase())];
    const exts = [ext, ...['.jpg', '.webp', '.png', '.jpeg'].filter((e) => e !== ext.toLowerCase())];
    const out = [];
    for (const f of folders) for (const e of exts) out.push(`${head}${f}${name}${e}${qs}`);
    return out;
  }

  /** Nhận diện định dạng từ byte đầu (không tin Content-Type) */
  function sniffType(bytes) {
    if (bytes.length > 3 && bytes[0] === 0xFF && bytes[1] === 0xD8) return 'image/jpeg';
    if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return 'image/png';
    return null;
  }

  async function fetchOne(url, quality) {
    const resp = await fetch(url, { credentials: 'include', headers: { Accept: 'image/*' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (bytes.length < 200) throw new Error('Dữ liệu ảnh rỗng');
    const sniffed = sniffType(bytes);
    if (sniffed) return { data: bytes, type: sniffed };
    // WebP / AVIF / GIF / BMP... → giải mã và mã hoá JPEG chất lượng cao
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('text/') || ct.includes('json')) throw new Error('Phản hồi không phải ảnh');
    const converted = await convertToJpeg(bytes, ct, Math.max(quality, 0.95));
    return { data: converted, type: 'image/jpeg' };
  }

  async function fetchImageWithRetry(url, quality, maxRetries = 2) {
    if (url.startsWith('data:')) {
      try {
        const resp = await fetch(url);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        return { data: bytes, type: sniffType(bytes) || 'image/jpeg' };
      } catch (e) {
        return { error: `Data URL không hợp lệ: ${e.message}` };
      }
    }

    let lastErr = 'unknown';
    for (const candidate of urlVariants(url)) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          return await fetchOne(candidate, quality);
        } catch (e) {
          lastErr = `${e.message} (${candidate})`;
          // 404/403 → thử URL biến thể khác ngay, không retry
          if (/HTTP (4\d\d)/.test(e.message)) break;
          if (attempt < maxRetries) await sleep(attempt * 700);
        }
      }
    }
    return { error: `Tải thất bại: ${lastErr}` };
  }

  /**
   * Chuyển WebP/AVIF sang JPG bằng OffscreenCanvas
   */
  async function convertToJpeg(arrayBuffer, contentType, quality = 0.92) {
    const blob = new Blob([arrayBuffer], { type: contentType && contentType.startsWith('image/') ? contentType : '' });
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const jpegBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    const buffer = await jpegBlob.arrayBuffer();
    return new Uint8Array(buffer);
  }

  /* ────────────── Helpers ────────────── */
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function reportProgress(data) {
    try {
      chrome.runtime.sendMessage({ type: 'PDF_PROGRESS', data });
    } catch { /* bỏ qua nếu popup đóng */ }
  }

  console.log('[Flipbook-DL] Offscreen worker đã sẵn sàng.');
})();
