/**
 * popup.js – Logic điều khiển giao diện popup
 * Giao tiếp với background.js để quét, chụp màn hình, và ghép PDF.
 */

(() => {
  'use strict';

  /* ────────────── DOM Elements ────────────── */
  const $ = (sel) => document.querySelector(sel);
  const el = {
    bookTitle: $('#bookTitle'),
    platform: $('#platform'),
    pageCount: $('#pageCount'),
    progressSection: $('#progressSection'),
    progressLabel: $('#progressLabel'),
    progressBar: $('#progressBar'),
    progressDetail: $('#progressDetail'),
    btnScreenshot: $('#btnScreenshot'),
    btnTest20: $('#btnTest20'),
    btnScan: $('#btnScan'),
    btnCancel: $('#btnCancel'),
    logArea: $('#logArea'),
    btnCopyLog: $('#btnCopyLog'),
    btnClearLog: $('#btnClearLog'),
    flipSpeed: $('#flipSpeed'),
    jpgQuality: $('#jpgQuality'),
    jpgQualityVal: $('#jpgQualityVal'),
    pageFrom: $('#pageFrom'),
    pageTo: $('#pageTo')
  };

  /* ────────────── Trạng thái ────────────── */
  let scanResult = null;
  let isProcessing = false;

  /* ────────────── Khởi tạo ────────────── */
  init();

  async function init() {
    // Load tùy chọn đã lưu
    await loadSettings();

    // Kiểm tra trạng thái hiện tại
    try {
      const status = await sendMessage({ type: 'GET_STATUS' });
      if (status?.recentLogs?.length > 0) {
        el.logArea.innerHTML = '';
        for (const log of status.recentLogs) {
          addLog(log.text, log.level || 'info', log.source || '', log.hint || '', log.time);
        }
      } else if (status && status.pages?.length > 0) {
        scanResult = status;
        updateInfo(status);
        addLog(`Đã tìm thấy ${status.pages.length} trang từ phiên trước.`, 'info', 'tab');
      }
    } catch (e) {
      addLog('Mở trang flipbook rồi chọn phương thức bên dưới.', 'info', 'system');
    }

    // Lắng nghe sự kiện
    el.btnScreenshot.addEventListener('click', handleScreenshot);
    el.btnTest20.addEventListener('click', handleTest20);
    el.btnScan.addEventListener('click', handleScanAndDownload);
    el.btnCancel.addEventListener('click', handleCancel);

    // Sao chép toàn bộ nhật ký
    if (el.btnCopyLog) {
      el.btnCopyLog.addEventListener('click', async () => {
        const text = el.logArea.innerText;
        if (!text.trim()) return;
        try {
          await navigator.clipboard.writeText(text);
          const oldText = el.btnCopyLog.textContent;
          el.btnCopyLog.textContent = '✓ Đã chép!';
          setTimeout(() => { el.btnCopyLog.textContent = oldText; }, 1500);
        } catch {
          const ta = document.createElement('textarea');
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          const oldText = el.btnCopyLog.textContent;
          el.btnCopyLog.textContent = '✓ Đã chép!';
          setTimeout(() => { el.btnCopyLog.textContent = oldText; }, 1500);
        }
      });
    }

    el.btnClearLog.addEventListener('click', () => {
      el.logArea.innerHTML = '';
      sendMessage({ type: 'CLEAR_LOGS' }).catch(() => {});
    });

    // Slider chất lượng
    el.jpgQuality.addEventListener('input', () => {
      el.jpgQualityVal.textContent = Math.round(el.jpgQuality.value * 100) + '%';
    });

    // Lưu tùy chọn khi thay đổi
    [el.flipSpeed, el.jpgQuality, el.pageFrom, el.pageTo].forEach((input) => {
      input.addEventListener('change', saveSettings);
    });

    // Lắng nghe tiến trình & log chi tiết từ background
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'LOG_MESSAGE') {
        addLog(msg.text, msg.level || 'info', msg.source || '', msg.hint || '', msg.time);
      } else if (msg.type === 'FLIP_PROGRESS_UPDATE') {
        if (msg.data?.shot) {
          const d = msg.data;
          showProgress(d.label || '📸 Đang chụp...', d.total ? Math.round((d.currentPage / d.total) * 100) : 0);
          el.pageCount.textContent = `${d.currentPage} / ${d.total || '?'}`;
        }
      } else if (msg.type === 'PDF_PROGRESS_UPDATE') {
        handlePdfProgress(msg.data);
      } else if (msg.type === 'SHOT_PROGRESS_TEXT') {
        showProgress(msg.text, 100);
      } else if (msg.type === 'SHOT_DONE') {
        handleShotDone(msg.result);
      }
    });
  }

  /* ────────────── Chụp thử 20 trang đầu → PDF ────────────── */
  async function handleTest20() {
    if (isProcessing) return;
    isProcessing = true;
    el.btnScan.disabled = true;
    el.btnScreenshot.disabled = true;
    el.btnTest20.disabled = true;
    el.btnCancel.style.display = '';

    const options = {
      flipDelay: parseInt(el.flipSpeed.value) || 800,
      quality: parseFloat(el.jpgQuality.value) || 0.95,
      pageFrom: 1,
      pageTo: 20,
      isTest: true
    };

    addLog('🧪 Bắt đầu CHỤP THỬ 20 TRANG ĐẦU (#p=1 đến #p=20). Giữ tab flipbook ở phía trước.', 'info');
    showProgress('🧪 Đang chụp thử 20 trang...', 0);

    try {
      const resp = await sendMessage({ type: 'SCREENSHOT_PDF', options });
      if (resp?.error) {
        addLog(`Lỗi: ${resp.error}`, 'error');
        resetUI();
      }
    } catch (e) {
      addLog(`Lỗi: ${e.message}`, 'error');
      resetUI();
    }
  }

  /* ────────────── Chụp màn hình → PDF (Toàn bộ) ────────────── */
  async function handleScreenshot() {
    if (isProcessing) return;
    isProcessing = true;
    el.btnScan.disabled = true;
    el.btnScreenshot.disabled = true;
    el.btnTest20.disabled = true;
    el.btnCancel.style.display = '';

    const options = {
      flipDelay: parseInt(el.flipSpeed.value) || 800,
      quality: parseFloat(el.jpgQuality.value) || 0.95,
      pageFrom: parseInt(el.pageFrom.value) || 1,
      pageTo: parseInt(el.pageTo.value) || null,
      isTest: false
    };

    addLog('📸 Bắt đầu chụp toàn bộ màn hình (tự động điều hướng #p=[n+2] và cắt theo khung sách). Giữ tab flipbook ở phía trước.', 'info');
    showProgress('📸 Đang chụp...', 0);

    try {
      const resp = await sendMessage({ type: 'SCREENSHOT_PDF', options });
      if (resp?.error) {
        addLog(`Lỗi: ${resp.error}`, 'error');
        resetUI();
      }
    } catch (e) {
      addLog(`Lỗi: ${e.message}`, 'error');
      resetUI();
    }
  }

  function handleShotDone(result) {
    if (result?.error) {
      addLog(`Lỗi chụp/ghép PDF: ${result.error}`, 'error');
      hideProgress();
    } else {
      addLog(`✅ PDF hoàn tất: ${result.successCount}/${result.totalPages} trang (${formatSize(result.sizeBytes)})`, 'success');
      for (const err of result.errors || []) addLog(`⚠ Trang ${err.page}: ${err.error}`, 'warn');
      showProgress('✅ Hoàn tất!', 100);
      if (result.downloadError) addLog(`Lỗi tải file: ${result.downloadError}`, 'error');
      else addLog(`📥 Đã tải xuống: ${result.filename}`, 'success');
    }
    resetUI();
  }

  /* ────────────── Quét & Tải PDF từ ảnh gốc ────────────── */
  async function handleScanAndDownload() {
    if (isProcessing) return;
    isProcessing = true;

    el.btnScan.disabled = true;
    el.btnScreenshot.disabled = true;
    el.btnTest20.disabled = true;
    el.btnCancel.style.display = '';
    el.btnScan.classList.add('scanning');
    showProgress('🔍 Đang quét cấu hình trang...', 0);
    addLog('Bắt đầu quét trang...', 'info');

    try {
      const result = await sendMessage({ type: 'SCAN_PAGES' });

      if (result.error) {
        addLog(`Lỗi quét: ${result.error}`, 'error');
        hideProgress();
        resetUI();
        return;
      }

      scanResult = result;
      updateInfo(result);

      if (result.pages && result.pages.length > 0) {
        addLog(`✅ Tìm thấy ${result.pages.length} trang (${result.platform}). Tiến hành ghép PDF...`, 'success');
        await buildPdf(result.pages);
      } else {
        addLog(result.message || 'Chưa tìm thấy URL ảnh trực tiếp. Vui lòng sử dụng nút "📸 Chụp màn hình & Tải PDF".', 'warn');
        hideProgress();
        resetUI();
      }
    } catch (e) {
      addLog(`Lỗi: ${e.message}`, 'error');
      hideProgress();
      resetUI();
    }
  }

  /* ────────────── Ghép PDF từ mảng URL ảnh ────────────── */
  async function buildPdf(pages) {
    const options = {
      quality: parseFloat(el.jpgQuality.value) || 0.92,
      batchSize: 10,
      title: scanResult?.title || document.title || 'flipbook'
    };

    // Lọc khoảng trang
    const from = parseInt(el.pageFrom.value) || 1;
    const to = parseInt(el.pageTo.value) || pages.length;
    const filteredPages = pages.slice(from - 1, to);

    const rangeInfo = (from > 1 || to < pages.length) ? ` (trang ${from} → ${to})` : '';
    addLog(`📄 Bắt đầu tải và ghép PDF: ${filteredPages.length} trang${rangeInfo}, chất lượng ${Math.round(options.quality * 100)}%...`, 'info');
    showProgress('📄 Đang tải ảnh & ghép PDF...', 0);

    try {
      const result = await sendMessage({
        type: 'BUILD_PDF',
        pages: filteredPages,
        options
      });

      if (result.error) {
        addLog(`Lỗi ghép PDF: ${result.error}`, 'error');
        resetUI();
        return;
      }

      // Tải file PDF
      addLog(`✅ PDF hoàn tất: ${result.successCount}/${result.totalPages} trang (${formatSize(result.sizeBytes)})`, 'success');

      if (result.errors?.length > 0) {
        for (const err of result.errors) {
          addLog(`⚠ Trang ${err.page}: ${err.error}`, 'warn');
        }
      }

      showProgress('✅ Hoàn tất!', 100);

      if (result.downloadError) {
        addLog(`Lỗi tải file: ${result.downloadError}`, 'error');
      } else {
        addLog(`📥 Đã tải xuống: ${result.filename}`, 'success');
      }

    } catch (e) {
      addLog(`Lỗi: ${e.message}`, 'error');
    }

    resetUI();
  }

  /* ────────────── Tiến trình ghép PDF ────────────── */
  function handlePdfProgress(data) {
    const pct = data.total ? Math.round((data.current / data.total) * 100) : 0;
    showProgress(
      `📄 Ghép PDF: ${data.current}/${data.total} trang (${data.successCount} OK, ${data.errors} lỗi)`,
      pct
    );
  }

  /* ────────────── Hủy tác vụ ────────────── */
  async function handleCancel() {
    await sendMessage({ type: 'CANCEL_FLIP' });
    addLog('✕ Đã hủy.', 'warn');
    resetUI();
  }

  /* ────────────── UI Helpers ────────────── */
  function updateInfo(data) {
    el.bookTitle.textContent = truncate(data.title || '—', 40);
    el.bookTitle.title = data.title || '';
    el.platform.textContent = data.platform || '—';
    el.pageCount.textContent = `${data.pages?.length || 0} / ${data.total || '—'}`;
  }

  function showProgress(label, pct) {
    el.progressSection.style.display = '';
    el.progressLabel.textContent = label;
    el.progressBar.style.width = `${Math.min(pct, 100)}%`;
  }

  function hideProgress() {
    el.progressSection.style.display = 'none';
  }

  function resetUI() {
    isProcessing = false;
    el.btnScan.disabled = false;
    el.btnScan.classList.remove('scanning');
    el.btnScreenshot.disabled = false;
    el.btnTest20.disabled = false;
    el.btnCancel.style.display = 'none';
  }

  function addLog(text, type = 'info', source = '', hint = '', time = null) {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    
    const displayTime = time || new Date().toLocaleTimeString('vi-VN', { hour12: false });
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = `[${displayTime}] `;
    entry.appendChild(timeSpan);

    if (source) {
      const sourceSpan = document.createElement('span');
      sourceSpan.className = `log-source log-source-${source.toLowerCase()}`;
      const sourceMap = {
        tab: '[Tab]',
        shot: '[Chụp]',
        offscreen: '[Xử lý ảnh]',
        pdf: '[Ghép PDF]',
        download: '[Tải về]',
        system: '[Hệ thống]',
        warn: '[Cảnh báo]',
        error: '[Lỗi]'
      };
      sourceSpan.textContent = (sourceMap[source.toLowerCase()] || `[${source}]`) + ' ';
      entry.appendChild(sourceSpan);
    }

    const textSpan = document.createElement('span');
    textSpan.className = 'log-text';
    textSpan.textContent = text;
    entry.appendChild(textSpan);

    if (hint) {
      const hintDiv = document.createElement('div');
      hintDiv.className = 'log-hint';
      hintDiv.textContent = `💡 Cần xử lý: ${hint}`;
      entry.appendChild(hintDiv);
    }

    el.logArea.appendChild(entry);
    el.logArea.scrollTop = el.logArea.scrollHeight;
  }

  function truncate(str, max) {
    return str.length > max ? str.slice(0, max) + '…' : str;
  }

  function formatSize(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  }

  /* ────────────── Settings ────────────── */
  async function loadSettings() {
    try {
      const data = await chrome.storage.local.get(['flipSpeed', 'jpgQuality', 'pageFrom', 'pageTo']);
      if (data.flipSpeed) el.flipSpeed.value = data.flipSpeed;
      if (data.jpgQuality) {
        el.jpgQuality.value = data.jpgQuality;
        el.jpgQualityVal.textContent = Math.round(data.jpgQuality * 100) + '%';
      }
      if (data.pageFrom) el.pageFrom.value = data.pageFrom;
      if (data.pageTo) el.pageTo.value = data.pageTo;
    } catch { /* lần đầu chạy */ }
  }

  async function saveSettings() {
    try {
      await chrome.storage.local.set({
        flipSpeed: parseInt(el.flipSpeed.value) || 800,
        jpgQuality: parseFloat(el.jpgQuality.value) || 0.92,
        pageFrom: parseInt(el.pageFrom.value) || 1,
        pageTo: parseInt(el.pageTo.value) || null
      });
    } catch { /* bỏ qua */ }
  }

  /* ────────────── Messaging ────────────── */
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(msg, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }
})();
