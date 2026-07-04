'use strict';

/* ===== 予約台帳 / Sổ đặt bàn =====
 * タブレット・スマホ向け。データはブラウザの localStorage に保存されます。
 * トレタ風の操作:
 *  - 空きマスをタップ → その時間・テーブルで新規予約
 *  - 予約ブロックをタップ → 詳細・編集
 *  - 予約ブロックを長押し（PCはドラッグ）→ 配席移動・時間変更
 *  - ブロック右端をドラッグ → 滞在時間の変更
 */

const LS_KEY = 'yoyaku-daicho-v1';
const SLOT_MIN = 30;   // タイムテーブルの1マス（分）
const SNAP_MIN = 15;   // ドラッグ時のスナップ単位（分）
const LONG_PRESS_MS = 400;

const STATUSES = ['reserved', 'seated', 'finished', 'noshow', 'cancelled'];

let state = null;
let currentDate = todayStr();
let view = 'timetable';
let editingId = null;          // 編集中の予約ID（新規は null）
let modalStatus = 'reserved';  // モーダル内で選択中のステータス
let modalTables = new Set();   // モーダル内で選択中のテーブルID
let modalWalkIn = false;

let ttCtx = null;              // タイムテーブル描画コンテキスト（ドラッグ用）
let drag = null;               // 進行中のドラッグ情報
let suppressClick = false;     // ドラッグ直後のclick誤発火防止

/* ---------- helpers ---------- */
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtTime(min) { return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }
function uid() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function t(key) {
  const d = I18N[state.settings.lang] || I18N.ja;
  return d[key] ?? I18N.ja[key] ?? key;
}
function dict() { return I18N[state.settings.lang] || I18N.ja; }

/* 端末幅に応じたタイムテーブルの寸法 */
function ttMetrics() {
  const phone = window.matchMedia('(max-width: 700px)').matches;
  return phone
    ? { slotW: 44, labelW: 88, rowH: 56 }
    : { slotW: 56, labelW: 136, rowH: 64 };
}

/* ---------- state ---------- */
function defaultState() {
  const tables = [
    { id: 't1', name: 'T1', seats: 4 },
    { id: 't2', name: 'T2', seats: 4 },
    { id: 't3', name: 'T3', seats: 4 },
    { id: 't4', name: 'T4', seats: 6 },
    { id: 't5', name: 'C1', seats: 2 },
    { id: 't6', name: 'C2', seats: 2 },
    { id: 't7', name: 'VIP', seats: 8 },
  ];
  const today = todayStr();
  const reservations = [
    { id: uid(), date: today, start: 12 * 60, duration: 90, adults: 2, children: 0, name: '田中', kana: 'タナカ', phone: '090-1111-2222', tableIds: ['t1'], course: '', memo: '', status: 'finished', walkIn: false },
    { id: uid(), date: today, start: 18 * 60, duration: 120, adults: 4, children: 0, name: '佐藤', kana: 'サトウ', phone: '090-3333-4444', tableIds: ['t2'], course: '飲み放題', memo: '窓際希望', status: 'reserved', walkIn: false },
    { id: uid(), date: today, start: 18 * 60 + 30, duration: 120, adults: 5, children: 1, name: 'Nguyễn Văn An', kana: '', phone: '070-5555-6666', tableIds: ['t7'], course: '', memo: 'Sinh nhật / 誕生日', status: 'reserved', walkIn: false },
    { id: uid(), date: today, start: 19 * 60, duration: 90, adults: 2, children: 0, name: '山本', kana: 'ヤマモト', phone: '', tableIds: ['t5'], course: '', memo: '', status: 'reserved', walkIn: false },
  ];
  return {
    tables,
    reservations,
    settings: { lang: 'ja', openMin: 11 * 60, closeMin: 23 * 60 },
  };
}
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { state = JSON.parse(raw); return; }
  } catch (e) { /* 壊れたデータは初期化 */ }
  state = defaultState();
  save();
}
function save() { localStorage.setItem(LS_KEY, JSON.stringify(state)); }

function dayReservations(date) {
  return state.reservations
    .filter((r) => r.date === date)
    .sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
}
function tableById(id) { return state.tables.find((tb) => tb.id === id); }
function tableNames(ids) {
  const names = (ids || []).map((id) => tableById(id)?.name).filter(Boolean);
  return names.length ? names.join(', ') : t('unassigned');
}

/* ---------- i18n ---------- */
function applyStaticI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.documentElement.lang = state.settings.lang;
  document.querySelectorAll('#langSwitch button').forEach((b) => {
    b.classList.toggle('active', b.dataset.lang === state.settings.lang);
  });
}
function statusLabel(s) {
  return t('status' + s.charAt(0).toUpperCase() + s.slice(1));
}

/* ---------- header / date bar ---------- */
function renderDateBar() {
  const [y, m, d] = currentDate.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  document.getElementById('dateDisplay').textContent = dict().fmtDate(y, m, d, wd);
  document.getElementById('datePicker').value = currentDate;

  const list = dayReservations(currentDate).filter((r) => r.status !== 'cancelled' && r.status !== 'noshow');
  const guests = list.reduce((sum, r) => sum + (r.adults || 0) + (r.children || 0), 0);
  document.getElementById('daySummary').textContent = dict().fmtSummary(list.length, guests);
}

/* ---------- timetable view ---------- */
function renderTimetable() {
  const { openMin, closeMin } = state.settings;
  const m = ttMetrics();
  document.documentElement.style.setProperty('--slot-w', m.slotW + 'px');
  document.documentElement.style.setProperty('--label-w', m.labelW + 'px');
  document.documentElement.style.setProperty('--row-h', m.rowH + 'px');

  const slots = Math.ceil((closeMin - openMin) / SLOT_MIN);
  const rowW = slots * m.slotW;

  const wrap = document.getElementById('ttScroll');
  const grid = document.createElement('div');
  grid.className = 'tt-grid';

  // 時間ヘッダー
  const head = document.createElement('div');
  head.className = 'tt-line head';
  const corner = document.createElement('div');
  corner.className = 'tt-label';
  head.appendChild(corner);
  const timehead = document.createElement('div');
  timehead.className = 'tt-timehead';
  timehead.style.width = rowW + 'px';
  for (let min = openMin; min < closeMin; min += 60) {
    const lbl = document.createElement('div');
    lbl.className = 'tt-hour-label';
    lbl.style.left = ((min - openMin) / SLOT_MIN) * m.slotW + 'px';
    lbl.style.width = (60 / SLOT_MIN) * m.slotW + 'px';
    lbl.textContent = fmtTime(min);
    timehead.appendChild(lbl);
  }
  head.appendChild(timehead);
  grid.appendChild(head);

  const resList = dayReservations(currentDate);
  const rows = [];

  state.tables.forEach((tb) => {
    const line = document.createElement('div');
    line.className = 'tt-line';

    const label = document.createElement('div');
    label.className = 'tt-label';
    label.innerHTML = `<span class="tname">${esc(tb.name)}</span><span class="tseats">${tb.seats} ${esc(t('seatsUnit'))}</span>`;
    line.appendChild(label);

    const row = document.createElement('div');
    row.className = 'tt-row';
    row.style.width = rowW + 'px';

    resList
      .filter((r) => (r.tableIds || []).includes(tb.id) && r.status !== 'cancelled')
      .forEach((r) => {
        const start = Math.max(r.start, openMin);
        const end = Math.min(r.start + r.duration, closeMin);
        if (end <= openMin || start >= closeMin) return;
        const block = document.createElement('div');
        block.className = 'tt-block ' + r.status;
        block.dataset.resId = r.id;
        block.style.left = ((start - openMin) / SLOT_MIN) * m.slotW + 1 + 'px';
        block.style.width = ((end - start) / SLOT_MIN) * m.slotW - 3 + 'px';
        const pax = (r.adults || 0) + (r.children || 0);
        block.innerHTML =
          `<div class="b-name">${esc(r.name)}</div>` +
          `<div class="b-info">${esc(dict().fmtPax(pax))} ${fmtTime(r.start)}-${fmtTime(r.start + r.duration)}</div>`;

        // 右端: 滞在時間変更ハンドル
        const rh = document.createElement('div');
        rh.className = 'b-resize';
        rh.addEventListener('pointerdown', (e) => onResizePointerDown(e, r.id, tb.id));
        block.appendChild(rh);

        // 長押し（PCはドラッグ）で移動、タップで編集
        block.addEventListener('pointerdown', (e) => onBlockPointerDown(e, r.id, tb.id));
        block.addEventListener('click', (e) => e.stopPropagation());
        row.appendChild(block);
      });

    // 空きマスをタップ → その時間・テーブルで新規予約
    row.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; return; }
      if (e.target.closest('.tt-block')) return;
      const rect = row.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const min = openMin + Math.floor(x / m.slotW) * SLOT_MIN;
      openResModal(null, { start: min, tableId: tb.id });
    });

    line.appendChild(row);
    grid.appendChild(line);
    rows.push({ tableId: tb.id, lineEl: line, rowEl: row });
  });

  // 現在時刻ライン
  if (currentDate === todayStr()) {
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (nowMin >= openMin && nowMin <= closeMin) {
      const nl = document.createElement('div');
      nl.className = 'now-line';
      nl.style.left = m.labelW + ((nowMin - openMin) / SLOT_MIN) * m.slotW + 'px';
      grid.appendChild(nl);
    }
  }

  wrap.replaceChildren(grid);
  ttCtx = { grid, scroll: wrap, rows, openMin, closeMin, metrics: m };
  renderLegend();
}

function renderLegend() {
  const colors = { reserved: 'var(--reserved)', seated: 'var(--seated)', finished: 'var(--finished)', noshow: 'var(--noshow)', cancelled: 'var(--cancelled)' };
  document.getElementById('legend').innerHTML =
    STATUSES.map((s) =>
      `<span class="lg"><span class="sw" style="background:${colors[s]}"></span>${esc(statusLabel(s))}</span>`
    ).join('') +
    `<span class="hint">${esc(t('dragHint'))}</span>`;
}

/* ---------- drag & drop（配席移動・滞在時間変更） ---------- */
function onBlockPointerDown(e, resId, tableId) {
  if (drag || !ttCtx) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  const r = state.reservations.find((x) => x.id === resId);
  if (!r) return;
  drag = {
    mode: 'move', resId, r, fromTableId: tableId,
    startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
    pointerType: e.pointerType, started: false, longTimer: null,
    newStart: r.start, newTableId: tableId, newDuration: r.duration,
  };
  // タッチ・ペンは長押しで移動開始（それまではスクロール優先）
  if (e.pointerType !== 'mouse') {
    drag.longTimer = setTimeout(() => { if (drag && !drag.started) startDrag(); }, LONG_PRESS_MS);
  }
}

function onResizePointerDown(e, resId, tableId) {
  if (drag || !ttCtx) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  e.stopPropagation();
  const r = state.reservations.find((x) => x.id === resId);
  if (!r) return;
  drag = {
    mode: 'resize', resId, r, fromTableId: tableId,
    startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
    pointerType: e.pointerType, started: false, longTimer: null,
    newStart: r.start, newTableId: tableId, newDuration: r.duration,
  };
  startDrag(); // ハンドルは即ドラッグ開始（touch-action:noneでスクロールと競合しない）
}

function startDrag() {
  if (!drag || drag.started) return;
  drag.started = true;
  if (navigator.vibrate) navigator.vibrate(15);

  const ghost = document.createElement('div');
  ghost.className = 'tt-block tt-ghost ' + drag.r.status;
  ttCtx.grid.appendChild(ghost);
  drag.ghost = ghost;

  document.querySelectorAll(`.tt-block[data-res-id="${drag.resId}"]`).forEach((b) => b.classList.add('drag-src'));

  // つかんだ位置と予約開始時刻のズレ（分）を記録
  const gr = ttCtx.grid.getBoundingClientRect();
  const pointerMin = ttCtx.openMin + ((drag.lastX - gr.left - ttCtx.metrics.labelW) / ttCtx.metrics.slotW) * SLOT_MIN;
  drag.grabOffset = pointerMin - drag.r.start;

  updateDragFromPointer();
}

function onDragMove(e) {
  if (!drag) return;
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;

  if (!drag.started) {
    const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
    if (drag.pointerType === 'mouse') {
      if (dist > 4) startDrag();
    } else if (dist > 12) {
      // 長押し前に動いた → スクロール操作として扱う
      clearTimeout(drag.longTimer);
      drag = null;
    }
    return;
  }
  updateDragFromPointer();
  autoScroll(e);
}

function updateDragFromPointer() {
  if (!drag || !drag.started || !ttCtx) return;
  const m = ttCtx.metrics;
  const gr = ttCtx.grid.getBoundingClientRect();
  const x = drag.lastX - gr.left;
  const y = drag.lastY - gr.top;

  if (drag.mode === 'move') {
    let startMin = ttCtx.openMin + ((x - m.labelW) / m.slotW) * SLOT_MIN - drag.grabOffset;
    startMin = Math.round(startMin / SNAP_MIN) * SNAP_MIN;
    drag.newStart = clamp(startMin, ttCtx.openMin, Math.max(ttCtx.openMin, ttCtx.closeMin - drag.r.duration));

    let idx = ttCtx.rows.findIndex((row) => {
      const top = row.lineEl.offsetTop;
      return y >= top && y < top + row.lineEl.offsetHeight;
    });
    if (idx < 0) idx = y < ttCtx.rows[0].lineEl.offsetTop ? 0 : ttCtx.rows.length - 1;
    drag.newTableId = ttCtx.rows[idx].tableId;
    ttCtx.rows.forEach((row, i) => row.rowEl.classList.toggle('drop-target', i === idx));
  } else {
    let endMin = ttCtx.openMin + ((x - m.labelW) / m.slotW) * SLOT_MIN;
    endMin = Math.round(endMin / SNAP_MIN) * SNAP_MIN;
    endMin = clamp(endMin, drag.r.start + 30, ttCtx.closeMin);
    drag.newDuration = endMin - drag.r.start;
  }
  updateGhost();
}

function updateGhost() {
  const m = ttCtx.metrics;
  const row = ttCtx.rows.find((rw) => rw.tableId === (drag.mode === 'move' ? drag.newTableId : drag.fromTableId));
  if (!row) return;
  const start = drag.mode === 'move' ? drag.newStart : drag.r.start;
  const dur = drag.mode === 'move' ? drag.r.duration : drag.newDuration;
  const end = Math.min(start + dur, ttCtx.closeMin);

  const g = drag.ghost;
  g.style.top = row.lineEl.offsetTop + 5 + 'px';
  g.style.height = row.lineEl.offsetHeight - 11 + 'px';
  g.style.bottom = 'auto';
  g.style.left = m.labelW + ((Math.max(start, ttCtx.openMin) - ttCtx.openMin) / SLOT_MIN) * m.slotW + 1 + 'px';
  g.style.width = ((end - Math.max(start, ttCtx.openMin)) / SLOT_MIN) * m.slotW - 3 + 'px';

  const pax = (drag.r.adults || 0) + (drag.r.children || 0);
  g.innerHTML =
    `<div class="b-name">${esc(drag.r.name)}</div>` +
    `<div class="b-info">${esc(dict().fmtPax(pax))} ${fmtTime(start)}-${fmtTime(start + dur)}</div>`;
}

function autoScroll(e) {
  const sc = ttCtx.scroll;
  const rect = sc.getBoundingClientRect();
  const m = ttCtx.metrics;
  if (e.clientX > rect.right - 48) sc.scrollLeft += 14;
  else if (e.clientX < rect.left + m.labelW + 14) sc.scrollLeft -= 14;
  if (e.clientY > rect.bottom - 48) sc.scrollTop += 12;
  else if (e.clientY < rect.top + 52) sc.scrollTop -= 12;
}

function onDragUp() {
  if (!drag) return;
  clearTimeout(drag.longTimer);
  const d = drag;
  drag = null;

  if (!d.started) {
    // 動かさずに離した → タップ＝詳細を開く（リサイズハンドルは無視）
    if (d.mode === 'move') openResModal(d.resId);
    return;
  }

  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 350);
  cleanupDragVisuals(d);

  const r = d.r;
  if (d.mode === 'move') {
    if (d.newStart === r.start && d.newTableId === d.fromTableId) { renderTimetable(); return; }
    const newTableIds = [...new Set(r.tableIds.map((id) => (id === d.fromTableId ? d.newTableId : id)))];
    const updated = { ...r, start: d.newStart, tableIds: newTableIds };
    if (hasConflict(updated) && !confirm(t('conflictWarn'))) { renderTimetable(); return; }
    Object.assign(r, updated);
  } else {
    if (d.newDuration === r.duration) { renderTimetable(); return; }
    const updated = { ...r, duration: d.newDuration };
    if (hasConflict(updated) && !confirm(t('conflictWarn'))) { renderTimetable(); return; }
    r.duration = d.newDuration;
  }
  save();
  renderAll();
}

function onDragCancel() {
  if (!drag) return;
  clearTimeout(drag.longTimer);
  const d = drag;
  drag = null;
  if (d.started) { cleanupDragVisuals(d); renderTimetable(); }
}

function cleanupDragVisuals(d) {
  d.ghost?.remove();
  document.querySelectorAll('.tt-block.drag-src').forEach((b) => b.classList.remove('drag-src'));
  document.querySelectorAll('.tt-row.drop-target').forEach((rw) => rw.classList.remove('drop-target'));
}

/* ---------- list view ---------- */
function renderList() {
  const wrap = document.getElementById('listWrap');
  const list = dayReservations(currentDate);
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-note">${esc(t('noReservations'))}</div>`;
    return;
  }
  wrap.innerHTML = '';
  list.forEach((r) => {
    const pax = (r.adults || 0) + (r.children || 0);
    const card = document.createElement('div');
    card.className = 'res-card ' + r.status;
    let quick = '';
    if (r.status === 'reserved') quick = `<button class="btn small primary" data-quick="seated">${esc(t('quickSeat'))}</button>`;
    else if (r.status === 'seated') quick = `<button class="btn small secondary" style="border:1px solid var(--line)" data-quick="finished">${esc(t('quickFinish'))}</button>`;
    card.innerHTML =
      `<div class="rc-time">${fmtTime(r.start)}<small>${fmtTime(r.start + r.duration)}</small></div>` +
      `<div class="rc-main">` +
        `<div class="rc-name">${esc(r.name)}　${esc(dict().fmtPax(pax))}</div>` +
        `<div class="rc-sub">${esc(tableNames(r.tableIds))}${r.phone ? '　📞 ' + esc(r.phone) : ''}${r.course ? '　🍴 ' + esc(r.course) : ''}${r.memo ? '　📝 ' + esc(r.memo) : ''}</div>` +
      `</div>` +
      `<div class="rc-actions">${quick}<span class="status-chip ${r.status}">${esc(statusLabel(r.status))}</span></div>`;
    card.addEventListener('click', () => openResModal(r.id));
    const qbtn = card.querySelector('[data-quick]');
    if (qbtn) {
      qbtn.addEventListener('click', (e) => {
        e.stopPropagation();
        r.status = qbtn.dataset.quick;
        save();
        renderAll();
      });
    }
    wrap.appendChild(card);
  });
}

/* ---------- customers view ---------- */
function buildCustomers() {
  const map = new Map();
  state.reservations.forEach((r) => {
    if (!r.name && !r.phone) return;
    const key = r.phone ? 'p:' + r.phone : 'n:' + r.name;
    if (!map.has(key)) map.set(key, { name: r.name, kana: r.kana, phone: r.phone, visits: 0, lastVisit: '' });
    const c = map.get(key);
    if (r.name) c.name = r.name;
    if (r.kana) c.kana = r.kana;
    if (r.status === 'seated' || r.status === 'finished') {
      c.visits += 1;
      if (r.date > c.lastVisit) c.lastVisit = r.date;
    }
  });
  return [...map.values()].sort((a, b) => (b.lastVisit || '').localeCompare(a.lastVisit || '') || b.visits - a.visits);
}

function renderCustomers() {
  const q = (document.getElementById('custSearch').value || '').trim().toLowerCase();
  let customers = buildCustomers();
  if (q) {
    customers = customers.filter((c) =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.kana || '').toLowerCase().includes(q) ||
      (c.phone || '').includes(q)
    );
  }
  const wrap = document.getElementById('custWrap');
  if (!customers.length) {
    wrap.innerHTML = `<div class="empty-note">${esc(t('noCustomers'))}</div>`;
    return;
  }
  wrap.innerHTML =
    `<table class="cust-table"><thead><tr>` +
    `<th>${esc(t('name'))}</th><th>${esc(t('nameKana'))}</th><th>${esc(t('phone'))}</th>` +
    `<th>${esc(t('visitCount'))}</th><th>${esc(t('lastVisit'))}</th>` +
    `</tr></thead><tbody>` +
    customers.map((c) =>
      `<tr><td>${esc(c.name)}</td><td>${esc(c.kana || '')}</td><td>${esc(c.phone || '')}</td>` +
      `<td class="num">${c.visits} ${esc(t('timesUnit'))}</td><td>${esc(c.lastVisit || '-')}</td></tr>`
    ).join('') +
    `</tbody></table>`;
}

/* ---------- reservation modal ---------- */
function fillTimeSelects() {
  const { openMin, closeMin } = state.settings;
  const startSel = document.getElementById('fStart');
  startSel.innerHTML = '';
  for (let min = openMin; min < closeMin; min += 15) {
    const opt = document.createElement('option');
    opt.value = min;
    opt.textContent = fmtTime(min);
    startSel.appendChild(opt);
  }
  const durSel = document.getElementById('fDur');
  durSel.innerHTML = '';
  [30, 45, 60, 90, 120, 150, 180, 240].forEach((d) => {
    const opt = document.createElement('option');
    opt.value = d;
    opt.textContent = `${d} ${t('minutesUnit')}`;
    durSel.appendChild(opt);
  });
}

function renderModalTables() {
  const wrap = document.getElementById('fTables');
  wrap.innerHTML = '';
  state.tables.forEach((tb) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (modalTables.has(tb.id) ? ' active' : '');
    chip.textContent = `${tb.name} (${tb.seats})`;
    chip.addEventListener('click', () => {
      if (modalTables.has(tb.id)) modalTables.delete(tb.id); else modalTables.add(tb.id);
      renderModalTables();
    });
    wrap.appendChild(chip);
  });
}

function renderModalStatus() {
  const row = document.getElementById('fStatusRow');
  row.innerHTML = '';
  STATUSES.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'status-btn ' + s + (modalStatus === s ? ' active' : '');
    b.textContent = statusLabel(s);
    b.addEventListener('click', () => { modalStatus = s; renderModalStatus(); });
    row.appendChild(b);
  });
}

function openResModal(resId, prefill = {}) {
  editingId = resId;
  const r = resId ? state.reservations.find((x) => x.id === resId) : null;
  modalWalkIn = prefill.walkIn || (r ? !!r.walkIn : false);

  fillTimeSelects();

  document.getElementById('resModalTitle').textContent = r ? t('editResTitle') : (modalWalkIn ? t('walkIn') : t('newResTitle'));
  document.getElementById('fDate').value = r ? r.date : currentDate;

  const { openMin, closeMin } = state.settings;
  let start = r ? r.start : (prefill.start ?? defaultStart());
  start = clamp(start - (start % 15), openMin, closeMin - 15);
  document.getElementById('fStart').value = start;
  document.getElementById('fDur').value = r ? r.duration : 120;

  document.getElementById('fAdults').textContent = r ? r.adults : 2;
  document.getElementById('fChildren').textContent = r ? r.children : 0;
  document.getElementById('fName').value = r ? r.name : (modalWalkIn ? t('walkInName') : '');
  document.getElementById('fKana').value = r ? (r.kana || '') : '';
  document.getElementById('fPhone').value = r ? (r.phone || '') : '';
  document.getElementById('fCourse').value = r ? (r.course || '') : '';
  document.getElementById('fMemo').value = r ? (r.memo || '') : '';

  modalTables = new Set(r ? r.tableIds : (prefill.tableId ? [prefill.tableId] : []));
  renderModalTables();

  modalStatus = r ? r.status : (modalWalkIn ? 'seated' : 'reserved');
  const statusRow = document.getElementById('fStatusRow');
  statusRow.classList.toggle('hidden', !r);
  if (r) renderModalStatus();

  document.getElementById('btnResDelete').classList.toggle('hidden', !r);
  document.getElementById('resModal').classList.remove('hidden');
}

function defaultStart() {
  // 現在時刻を15分単位に丸めた時間（今日以外は18:00）
  if (currentDate !== todayStr()) return 18 * 60;
  const now = new Date();
  const min = now.getHours() * 60 + now.getMinutes();
  return min - (min % 15);
}

function closeResModal() {
  document.getElementById('resModal').classList.add('hidden');
  editingId = null;
}

function hasConflict(res) {
  return state.reservations.some((o) =>
    o.id !== res.id &&
    o.date === res.date &&
    o.status !== 'cancelled' && o.status !== 'noshow' &&
    (o.tableIds || []).some((id) => res.tableIds.includes(id)) &&
    o.start < res.start + res.duration &&
    res.start < o.start + o.duration
  );
}

function saveReservation() {
  const name = document.getElementById('fName').value.trim();
  if (!name) { alert(t('nameRequired')); return; }

  const res = {
    id: editingId || uid(),
    date: document.getElementById('fDate').value || currentDate,
    start: Number(document.getElementById('fStart').value),
    duration: Number(document.getElementById('fDur').value),
    adults: Number(document.getElementById('fAdults').textContent),
    children: Number(document.getElementById('fChildren').textContent),
    name,
    kana: document.getElementById('fKana').value.trim(),
    phone: document.getElementById('fPhone').value.trim(),
    tableIds: [...modalTables],
    course: document.getElementById('fCourse').value.trim(),
    memo: document.getElementById('fMemo').value.trim(),
    status: modalStatus,
    walkIn: modalWalkIn,
  };

  if (res.tableIds.length && hasConflict(res) && !confirm(t('conflictWarn'))) return;

  const idx = state.reservations.findIndex((x) => x.id === res.id);
  if (idx >= 0) state.reservations[idx] = res; else state.reservations.push(res);
  save();
  closeResModal();
  renderAll();
}

function deleteReservation() {
  if (!editingId) return;
  if (!confirm(t('deleteConfirm'))) return;
  state.reservations = state.reservations.filter((x) => x.id !== editingId);
  save();
  closeResModal();
  renderAll();
}

/* ---------- table settings modal ---------- */
function openSettingsModal() {
  const openSel = document.getElementById('sOpen');
  const closeSel = document.getElementById('sClose');
  openSel.innerHTML = '';
  closeSel.innerHTML = '';
  for (let h = 0; h <= 24; h++) {
    if (h < 24) {
      const o = document.createElement('option');
      o.value = h * 60;
      o.textContent = fmtTime(h * 60);
      openSel.appendChild(o);
    }
    if (h > 0) {
      const c = document.createElement('option');
      c.value = h * 60;
      c.textContent = fmtTime(h * 60);
      closeSel.appendChild(c);
    }
  }
  openSel.value = state.settings.openMin;
  closeSel.value = state.settings.closeMin;

  const wrap = document.getElementById('tblRows');
  wrap.innerHTML = '';
  state.tables.forEach((tb) => addTableRow(tb));
  document.getElementById('settingsModal').classList.remove('hidden');
}

function addTableRow(tb) {
  const wrap = document.getElementById('tblRows');
  const row = document.createElement('div');
  row.className = 'tbl-row';
  row.dataset.id = tb ? tb.id : '';
  row.innerHTML =
    `<input type="text" class="tr-name" value="${esc(tb ? tb.name : '')}">` +
    `<input type="number" class="tr-seats" min="1" max="99" value="${tb ? tb.seats : 4}">` +
    `<button type="button" class="icon-btn tr-del">🗑</button>`;
  row.querySelector('.tr-del').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

function saveSettings() {
  const openMin = Number(document.getElementById('sOpen').value);
  const closeMin = Number(document.getElementById('sClose').value);
  if (closeMin > openMin) {
    state.settings.openMin = openMin;
    state.settings.closeMin = closeMin;
  }
  const tables = [];
  document.querySelectorAll('#tblRows .tbl-row').forEach((row) => {
    const name = row.querySelector('.tr-name').value.trim();
    if (!name) return;
    const seats = Math.max(1, Number(row.querySelector('.tr-seats').value) || 1);
    tables.push({ id: row.dataset.id || uid(), name, seats });
  });
  if (tables.length) state.tables = tables;
  save();
  document.getElementById('settingsModal').classList.add('hidden');
  renderAll();
}

/* ---------- view switching / render ---------- */
function setView(v) {
  view = v;
  document.querySelectorAll('#viewSwitch .vs-btn, #bottomNav .bn-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
  });
  document.getElementById('view-timetable').classList.toggle('hidden', v !== 'timetable');
  document.getElementById('view-list').classList.toggle('hidden', v !== 'list');
  document.getElementById('view-customers').classList.toggle('hidden', v !== 'customers');
  renderAll();
}

function renderAll() {
  applyStaticI18n();
  renderDateBar();
  if (view === 'timetable') renderTimetable();
  else if (view === 'list') renderList();
  else renderCustomers();
}

function shiftDate(days) {
  const [y, m, d] = currentDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  currentDate = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  renderAll();
}

/* ---------- init ---------- */
function init() {
  load();

  const onNavClick = (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) setView(btn.dataset.view);
  };
  document.getElementById('viewSwitch').addEventListener('click', onNavClick);
  document.getElementById('bottomNav').addEventListener('click', onNavClick);

  document.getElementById('langSwitch').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-lang]');
    if (!btn) return;
    state.settings.lang = btn.dataset.lang;
    save();
    renderAll();
  });

  document.getElementById('btnPrevDay').addEventListener('click', () => shiftDate(-1));
  document.getElementById('btnNextDay').addEventListener('click', () => shiftDate(1));
  document.getElementById('btnToday').addEventListener('click', () => { currentDate = todayStr(); renderAll(); });
  document.getElementById('datePicker').addEventListener('change', (e) => {
    if (e.target.value) { currentDate = e.target.value; renderAll(); }
  });

  document.getElementById('btnNew').addEventListener('click', () => openResModal(null));
  document.getElementById('btnWalkIn').addEventListener('click', () => openResModal(null, { walkIn: true }));
  document.getElementById('fabNew').addEventListener('click', () => openResModal(null));
  document.getElementById('fabWalkIn').addEventListener('click', () => openResModal(null, { walkIn: true }));

  document.getElementById('btnResClose').addEventListener('click', closeResModal);
  document.getElementById('btnResCancel').addEventListener('click', closeResModal);
  document.getElementById('btnResSave').addEventListener('click', saveReservation);
  document.getElementById('btnResDelete').addEventListener('click', deleteReservation);

  document.querySelectorAll('.step-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const el = document.getElementById(b.dataset.step === 'adults' ? 'fAdults' : 'fChildren');
      el.textContent = Math.max(0, Number(el.textContent) + Number(b.dataset.d));
    });
  });

  document.getElementById('btnSettings').addEventListener('click', openSettingsModal);
  document.getElementById('btnSetClose').addEventListener('click', () => document.getElementById('settingsModal').classList.add('hidden'));
  document.getElementById('btnSetCancel').addEventListener('click', () => document.getElementById('settingsModal').classList.add('hidden'));
  document.getElementById('btnSetSave').addEventListener('click', saveSettings);
  document.getElementById('btnAddTable').addEventListener('click', () => addTableRow(null));

  document.getElementById('custSearch').addEventListener('input', () => {
    if (view === 'customers') renderCustomers();
  });

  // ドラッグ用グローバルリスナー
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);
  window.addEventListener('pointercancel', onDragCancel);
  // ドラッグ確定後はスクロールを止める（passive:false 必須）
  document.addEventListener('touchmove', (e) => {
    if (drag && drag.started) e.preventDefault();
  }, { passive: false });

  // 画面回転・リサイズで寸法を再計算
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (view === 'timetable') renderTimetable(); }, 150);
  });

  // 現在時刻ラインを1分ごとに更新
  setInterval(() => { if (view === 'timetable' && !drag) renderTimetable(); }, 60000);

  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
