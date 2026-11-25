(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const bridge = window.bridge;
  const state = {
    results: [], selected: -1, type: 'all', query: '', seq: 0,
    status: null, settings: null, toastTimer: null, searchTimer: null,
  };

  const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M14 3v4h4" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const DIR_ICON = '<svg viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }

  function mergeRanges(ranges) {
    const clean = ranges.filter((r) => r && r.end > r.start).sort((a, b) => a.start - b.start);
    const out = [];
    for (const r of clean) {
      const last = out[out.length - 1];
      if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
      else out.push({ start: r.start, end: r.end });
    }
    return out;
  }

  function highlight(text, ranges) {
    const merged = mergeRanges(ranges || []);
    if (!merged.length) return escapeHtml(text);
    let html = '';
    let cursor = 0;
    for (const r of merged) {
      if (r.start > text.length) break;
      html += escapeHtml(text.slice(cursor, r.start));
      html += '<mark>' + escapeHtml(text.slice(r.start, Math.min(r.end, text.length))) + '</mark>';
      cursor = Math.min(r.end, text.length);
    }
    return html + escapeHtml(text.slice(cursor));
  }

  function formatSize(bytes) {
    if (!bytes) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
    return (i === 0 ? n : n.toFixed(n >= 10 ? 0 : 1)) + ' ' + units[i];
  }

  function formatTime(seconds) {
    if (!seconds) return '';
    const diff = (Date.now() / 1000) - seconds;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 2592000) return Math.floor(diff / 86400) + ' 天前';
    const d = new Date(seconds * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function toast(text) {
    const el = $('#toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function showEmpty(title, desc) {
    const empty = $('#emptyState');
    empty.classList.remove('hidden');
    $('#emptyTitle').textContent = title;
    $('#emptyDesc').textContent = desc;
    $('#resultList').innerHTML = '';
  }

  function renderResults() {
    const count = $('#resultCount');
    const q = state.query;
    if (!q) {
      state.results = [];
      showEmpty('输入关键词，秒级找到文件', '支持名称、路径、拼音首字母（wx）与全拼（weixin）搜索');
      count.textContent = '输入关键词开始搜索';
      return;
    }
    if (!state.results.length) {
      showEmpty('没有找到匹配的文件', '换个关键词试试，或检查索引是否已包含该目录');
      count.textContent = '找到 0 个结果';
      return;
    }
    $('#emptyState').classList.add('hidden');
    const token = q.split(/\s+/).pop().toLowerCase();
    $('#resultList').innerHTML = state.results.map((result, i) => {
      const item = result.item;
      const pathRanges = result.pathHighlight >= 0
        ? [{ start: result.pathHighlight, end: result.pathHighlight + token.length }] : [];
      return `<div class="row${i === 0 ? ' selected' : ''}" data-i="${i}">
        <div class="row-icon ${item.isDir ? 'dir' : ''}">${item.isDir ? DIR_ICON : FILE_ICON}</div>
        <div class="row-main">
          <div class="row-name">${highlight(item.name, result.highlights)}</div>
          <div class="row-path">${highlight(item.path, pathRanges)}</div>
        </div>
        <div class="row-side">${item.isDir ? '文件夹' : formatSize(item.size)}<br>${formatTime(item.mtime)}</div>
      </div>`;
    }).join('');
    state.selected = 0;
    count.textContent = `找到 ${state.results.length} 个结果` +
      (state.results.length >= 200 ? '（仅显示前 200 个）' : '');
  }

  async function runSearch() {
    const q = $('#searchInput').value.trim();
    state.query = q;
    $('#btnClear').classList.toggle('hidden', !q);
    if (!q) { state.seq += 1; state.results = []; renderResults(); return; }
    const seq = ++state.seq;
    try {
      const response = await bridge.search(q, state.type, 200);
      if (seq !== state.seq) return;
      state.results = response.results;
      renderResults();
    } catch (err) {
      toast('搜索失败: ' + err.message);
    }
  }

  function scheduleSearch() {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(runSearch, 45);
  }

  function setSelected(index) {
    if (!state.results.length) return;
    const next = Math.max(0, Math.min(state.results.length - 1, index));
    const rows = document.querySelectorAll('.row');
    if (rows[state.selected]) rows[state.selected].classList.remove('selected');
    state.selected = next;
    if (rows[next]) {
      rows[next].classList.add('selected');
      rows[next].scrollIntoView({ block: 'nearest' });
    }
  }

  async function openSelected(reveal = false) {
    const result = state.results[state.selected];
    if (!result) return;
    const target = result.item.path;
    try {
      const err = reveal ? (bridge.reveal(target), null) : await bridge.open(target);
      if (err) toast('打开失败: ' + err);
    } catch (e) { toast('打开失败: ' + e.message); }
  }

  function updateStatus(s) {
    state.status = s;
    const badge = $('#engineBadge');
    const mode = s.meta && s.meta.mode;
    const label = s.indexing ? '索引中' : mode === 'mft' ? 'MFT 直读' : mode === 'walk' ? '目录遍历' : '未索引';
    badge.className = 'engine-badge ' + (s.indexing ? 'busy' : mode || '');
    badge.innerHTML = '<span class="dot"></span>' + label;
    $('#btnRebuild').disabled = !!s.indexing;

    const track = $('#progressTrack');
    const fill = $('#progressFill');
    track.classList.toggle('hidden', !s.indexing);
    fill.classList.toggle('indeterminate', !!s.indexing);
    if (s.indexing) {
      fill.style.width = '';
      $('#statusText').textContent = `索引中 · 已处理 ${(s.progress.done || 0).toLocaleString()} 条` +
        (s.progress.message ? ' · ' + s.progress.message : '');
      $('#statusDot').className = 'status-dot busy';
    } else {
      $('#statusDot').className = 'status-dot';
      $('#statusText').textContent = s.count
        ? `索引就绪 · ${s.count.toLocaleString()} 个条目`
        : '索引为空，点击「重建索引」开始';
    }

    const meta = s.meta;
    $('#indexInfo').textContent = meta
      ? `索引 ${meta.count.toLocaleString()} 项 · ${formatTime(meta.builtAt)}更新`
      : '尚未建立索引';

    const dismissed = localStorage.getItem('localsearch.noticeDismissed') === '1';
    $('#adminNotice').classList.toggle('hidden', s.admin || dismissed);
  }

  async function openSettings() {
    const settings = await bridge.getSettings();
    state.settings = settings;
    $('#settingMode').value = settings.mode || 'auto';
    $('#settingDrives').value = (settings.drives || []).join(' ');
    $('#settingRoots').value = (settings.roots || []).join('\n');
    $('#settingPython').value = settings.pythonPath || '';
    $('#settingsModal').classList.remove('hidden');
  }

  function closeSettings() { $('#settingsModal').classList.add('hidden'); }

  async function saveSettings() {
    const drives = $('#settingDrives').value.split(/[\s,，]+/).filter(Boolean)
      .map((d) => d.replace(/[\\/:]$/, '') + ':');
    const roots = $('#settingRoots').value.split(/\n+/).map((r) => r.trim()).filter(Boolean);
    await bridge.setSettings({
      mode: $('#settingMode').value,
      drives: [...new Set(drives)],
      roots,
      pythonPath: $('#settingPython').value.trim(),
    });
    closeSettings();
    toast('设置已保存，正在重建索引…');
    await bridge.buildIndex({});
  }

  function bindEvents() {
    const input = $('#searchInput');
    input.addEventListener('input', scheduleSearch);
    input.focus();

    $('#btnClear').addEventListener('click', () => {
      input.value = '';
      input.focus();
      runSearch();
    });

    document.querySelectorAll('.chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        state.type = chip.dataset.type;
        runSearch();
      });
    });

    $('#resultList').addEventListener('click', (e) => {
      const row = e.target.closest('.row');
      if (row) setSelected(Number(row.dataset.i));
    });
    $('#resultList').addEventListener('dblclick', (e) => {
      const row = e.target.closest('.row');
      if (row) { setSelected(Number(row.dataset.i)); openSelected(); }
    });

    document.querySelectorAll('.example').forEach((btn) => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.q;
        runSearch();
        input.focus();
      });
    });

    $('#btnRebuild').addEventListener('click', () => bridge.buildIndex({}));
    $('#btnSettings').addEventListener('click', openSettings);
    $('#btnCloseSettings').addEventListener('click', closeSettings);
    $('#btnCancelSettings').addEventListener('click', closeSettings);
    $('#btnSaveSettings').addEventListener('click', saveSettings);
    $('#settingsModal').addEventListener('click', (e) => {
      if (e.target.id === 'settingsModal') closeSettings();
    });

    $('#btnElevate').addEventListener('click', () => bridge.elevate());
    $('#btnDismissNotice').addEventListener('click', () => {
      localStorage.setItem('localsearch.noticeDismissed', '1');
      $('#adminNotice').classList.add('hidden');
    });

    $('#btnMin').addEventListener('click', () => bridge.minimize());
    $('#btnMax').addEventListener('click', () => bridge.maximize());
    $('#btnClose').addEventListener('click', () => bridge.close());

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('#settingsModal').classList.contains('hidden')) closeSettings();
        else if (input.value) { input.value = ''; runSearch(); }
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        input.focus();
        input.select();
        return;
      }
      if (!$('#settingsModal').classList.contains('hidden')) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(state.selected + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(state.selected - 1); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        openSelected(e.ctrlKey);
      } else if (e.ctrlKey && e.key.toLowerCase() === 'c' && document.activeElement !== input) {
        const item = state.results[state.selected] && state.results[state.selected].item;
        if (item) { bridge.copy(item.path); toast('路径已复制'); }
      }
    });
  }

  function init() {
    bindEvents();
    bridge.onStatus(updateStatus);
    bridge.onToast(toast);
    bridge.onError((text) => {
      toast(text);
      $('#statusDot').className = 'status-dot error';
      $('#statusText').textContent = text;
    });
    bridge.getStatus().then(updateStatus).catch(() => {});
    bridge.getSettings().then((s) => { state.settings = s; }).catch(() => {});
  }

  init();
})();
