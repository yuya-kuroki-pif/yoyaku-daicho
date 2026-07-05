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
let cellPick = null;           // 空きマスタップのポップオーバー状態 {start, tableId, mode, selectEl}

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
    { id: 't1', name: 'T1', seats: 4, group: 'ホール' },
    { id: 't2', name: 'T2', seats: 4, group: 'ホール' },
    { id: 't3', name: 'T3', seats: 4, group: 'ホール' },
    { id: 't4', name: 'T4', seats: 6, group: 'ホール' },
    { id: 't5', name: 'C1', seats: 2, group: 'カウンター' },
    { id: 't6', name: 'C2', seats: 2, group: 'カウンター' },
    { id: 't7', name: 'VIP', seats: 8, group: '個室' },
  ];
  const today = todayStr();
  const reservations = [
    { id: uid(), date: today, start: 12 * 60, duration: 90, adults: 2, children: 0, name: '田中', kana: 'タナカ', phone: '090-1111-2222', tableIds: ['t1'], course: '', memo: '', status: 'finished', walkIn: false },
    { id: uid(), date: today, start: 18 * 60, duration: 120, adults: 4, children: 0, name: '佐藤', kana: 'サトウ', phone: '090-3333-4444', tableIds: ['t2'], course: '飲み放題', memo: '窓際希望', status: 'reserved', walkIn: false },
    { id: uid(), date: today, start: 18 * 60 + 30, duration: 120, adults: 5, children: 1, name: 'Nguyễn Văn An', kana: '', phone: '070-5555-6666', tableIds: ['t7'], course: '', memo: 'Sinh nhật / 誕生日', status: 'reserved', walkIn: false },
    { id: uid(), date: today, start: 19 * 60, duration: 90, adults: 2, children: 0, name: '山本', kana: 'ヤマモト', phone: '', tableIds: ['t5'], course: '', memo: '', status: 'reserved', walkIn: false },
    { id: uid(), date: today, start: 21 * 60, duration: 90, adults: 4, children: 0, name: 'あいだ はなこ', kana: 'アイダ ハナコ', phone: '080-7777-8888', tableIds: [], course: '', memo: '', status: 'reserved', walkIn: false },
  ];
  return {
    tables,
    reservations,
    sites: defaultSites(),
    sitesV2: true,
    tablesV2: true,
    combos: [{ id: 'cb1', tableIds: ['t1', 't2'], max: 8 }],
    settings: { lang: 'ja', openMin: 11 * 60, closeMin: 23 * 60 },
  };
}
function defaultSites() {
  return [
    { id: 's4', name: '自社予約サイト', color: '#0ea5e9', enabled: true, own: true, tableIds: ['t1', 't4', 't7'] },
    { id: 's5', name: 'Instagram', color: '#ec4899', enabled: true, tableIds: ['t1', 't2', 't3'] },
    { id: 's6', name: 'Googleマップ', color: '#16a34a', enabled: true, tableIds: ['t2', 't3', 't4'] },
  ];
}
function ownSite() { return (state.sites || []).find((s) => s.own); }
function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      state = JSON.parse(raw);
      // 旧データの移行
      if (!state.sites) { state.sites = defaultSites(); save(); }
      if (!state.sitesV2) {
        // グルメサイトの初期登録を廃止し、URL発行型のチャネル構成へ
        state.sites = state.sites.filter((s) => !['食べログ', 'ホットペッパー', 'ぐるなび'].includes(s.name));
        const own = state.sites.find((s) => s.own) || state.sites.find((s) => s.name === '自社サイト');
        if (own) {
          own.own = true;
          if (own.name === '自社サイト') own.name = '自社予約サイト';
        } else {
          state.sites.unshift({ id: uid(), name: '自社予約サイト', color: '#0ea5e9', enabled: true, own: true, tableIds: state.tables.slice(0, 3).map((tb) => tb.id) });
        }
        if (!state.sites.some((s) => s.name === 'Instagram')) {
          state.sites.push({ id: uid(), name: 'Instagram', color: '#ec4899', enabled: true, tableIds: state.tables.slice(0, 3).map((tb) => tb.id) });
        }
        if (!state.sites.some((s) => s.name === 'Googleマップ')) {
          state.sites.push({ id: uid(), name: 'Googleマップ', color: '#16a34a', enabled: true, tableIds: state.tables.slice(0, 3).map((tb) => tb.id) });
        }
        state.sitesV2 = true;
        save();
      }
      if (!state.tablesV2) {
        // 既定テーブルへ初期グループを付与
        const defs = { t1: 'ホール', t2: 'ホール', t3: 'ホール', t4: 'ホール', t5: 'カウンター', t6: 'カウンター', t7: '個室' };
        state.tables.forEach((tb) => { if (tb.group === undefined) tb.group = defs[tb.id] || ''; });
        state.tablesV2 = true;
        save();
      }
      if (!state.combos) {
        // 結合（合席）の初期サンプル: T1+T2で8名まで
        state.combos = (tableById('t1') && tableById('t2')) ? [{ id: uid(), tableIds: ['t1', 't2'], max: 8 }] : [];
        save();
      }
      return;
    }
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
  document.querySelectorAll('.lang-switch button').forEach((b) => {
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
  document.getElementById('dateDisplay').textContent = dict().fmtDateBox(y, m, d, wd);
  document.getElementById('datePicker').value = currentDate;

  const list = dayReservations(currentDate).filter((r) => r.status !== 'cancelled' && r.status !== 'noshow' && r.status !== 'block');
  const guests = list.reduce((sum, r) => sum + (r.adults || 0) + (r.children || 0), 0);
  document.getElementById('daySummary').textContent = dict().fmtSummary(list.length, guests);
}

/* ---------- 来店回数（dinii風「n回」チップ用） ---------- */
function custKey(r) { return r.phone ? 'p:' + r.phone : (r.name ? 'n:' + r.name : ''); }
function buildVisitMap() {
  const map = new Map();
  state.reservations.forEach((r) => {
    const key = custKey(r);
    if (!key) return;
    if (r.status === 'seated' || r.status === 'finished') {
      map.set(key, (map.get(key) || 0) + 1);
    }
  });
  return map;
}
/* ブロック/カード内の名前行（経路色・名前・人数・来店回数チップ・コースアイコン） */
function siteById(id) { return (state.sites || []).find((s) => s.id === id); }
function blockNameHtml(r, visitMap) {
  const pax = (r.adults || 0) + (r.children || 0);
  const visits = visitMap.get(custKey(r)) || 0;
  const chip = visits > 0
    ? `<span class="chip-visit">${esc(dict().fmtVisits(visits))}</span>`
    : `<span class="chip-visit">${esc(t('firstVisit'))}</span>`;
  const courseIco = r.course ? '<span class="b-ico">🍴</span>' : '';
  const site = siteById(r.channel);
  const dot = site ? `<span class="ch-dot" style="background:${esc(site.color)}"></span>` : '';
  return `${dot}${esc(r.name)} <span>${esc(dict().fmtPax(pax))}</span> ${chip}${courseIco}`;
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
  const visitMap = buildVisitMap();
  const rows = [];

  // 予約ブロック生成（fromTableId: null = 未配席行）
  const makeBlock = (r, fromTableId, span) => {
    const start = Math.max(r.start, openMin);
    const end = Math.min(r.start + r.duration, closeMin);
    if (end <= openMin || start >= closeMin) return null;
    const block = document.createElement('div');
    let cls = 'tt-block ' + r.status;
    if (r.status === 'reserved' && r.course) cls += ' course';
    if (fromTableId === null) cls += ' unassigned';
    if (span) cls += ' span'; // 複数卓を1つの枠として表示（グリッド直下に配置）
    block.className = cls;
    block.dataset.resId = r.id;
    block.style.left = (span ? m.labelW : 0) + ((start - openMin) / SLOT_MIN) * m.slotW + 1 + 'px';
    block.style.width = ((end - start) / SLOT_MIN) * m.slotW - 3 + 'px';
    if (r.status === 'block') {
      // 予約ブロック（ネット予約の在庫から除外される帯）
      block.innerHTML =
        `<div class="b-name">🚫 ${esc(t('statusBlock'))}</div>` +
        `<div class="b-info">${fmtTime(r.start)}-${fmtTime(r.start + r.duration)}</div>`;
    } else {
      const info = r.memo ? esc(r.memo) : `${fmtTime(r.start)}-${fmtTime(r.start + r.duration)}`;
      block.innerHTML =
        `<div class="b-name">${blockNameHtml(r, visitMap)}</div>` +
        `<div class="b-info">${info}</div>`;
    }

    // 右端: 滞在時間変更ハンドル
    const rh = document.createElement('div');
    rh.className = 'b-resize';
    rh.addEventListener('pointerdown', (e) => onResizePointerDown(e, r.id, fromTableId));
    block.appendChild(rh);

    // 長押し（PCはドラッグ）で移動、タップで編集
    block.addEventListener('pointerdown', (e) => onBlockPointerDown(e, r.id, fromTableId));
    block.addEventListener('click', (e) => e.stopPropagation());
    return block;
  };

  // 空きマスタップ → トレタ風ポップオーバー（長押しドラッグで範囲選択はonRowPointerDown側）
  const attachRowTap = (row, tableId) => {
    row.addEventListener('pointerdown', (e) => onRowPointerDown(e, tableId));
    row.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; return; }
      if (e.target.closest('.tt-block')) return;
      const rect = row.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const min = openMin + Math.floor((x / m.slotW) * SLOT_MIN / 15) * 15;
      openCellPopover(e.clientX, e.clientY, min, tableId ? [tableId] : [], 120);
    });
  };

  // 未配席行（dinii風: テーブル未割当の予約を上段に表示、ドラッグで配席）
  const uaList = resList.filter((r) => !(r.tableIds || []).length && r.status !== 'cancelled' && r.status !== 'noshow');
  {
    const line = document.createElement('div');
    line.className = 'tt-line unassigned-line';
    const label = document.createElement('div');
    label.className = 'tt-label';
    label.innerHTML = `<span class="tname">${esc(t('unassigned'))}<span class="ua-badge">${uaList.length}</span></span>`;
    line.appendChild(label);
    const row = document.createElement('div');
    row.className = 'tt-row unassigned-row';
    row.style.width = rowW + 'px';
    uaList.forEach((r) => {
      const block = makeBlock(r, null);
      if (block) row.appendChild(block);
    });
    attachRowTap(row, null);
    line.appendChild(row);
    grid.appendChild(line);
    rows.push({ tableId: null, lineEl: line, rowEl: row });
  }

  let prevGroup = null;
  state.tables.forEach((tb) => {
    // グループ見出し行
    const g = (tb.group || '').trim();
    if (g && g !== prevGroup) {
      const gline = document.createElement('div');
      gline.className = 'tt-line group-line';
      gline.innerHTML =
        `<div class="tt-label"><span class="tname">${esc(g)}</span></div>` +
        `<div class="tt-grouprow" style="width:${rowW}px"></div>`;
      grid.appendChild(gline);
    }
    prevGroup = g;

    const line = document.createElement('div');
    line.className = 'tt-line';

    const label = document.createElement('div');
    label.className = 'tt-label';
    label.innerHTML = `<span class="tname">${esc(tb.name)}</span><span class="tseats">${tb.seats} ${esc(t('seatsUnit'))}</span>`;
    line.appendChild(label);

    const row = document.createElement('div');
    row.className = 'tt-row';
    row.style.width = rowW + 'px';

    // テーブル名をタップ → そのテーブルでポップオーバー
    label.addEventListener('click', (e) => {
      if (suppressClick) { suppressClick = false; return; }
      openCellPopover(e.clientX, e.clientY, defaultStart(), [tb.id], 120);
    });

    attachRowTap(row, tb.id);
    line.appendChild(row);
    grid.appendChild(line);
    rows.push({ tableId: tb.id, lineEl: line, rowEl: row });
  });

  // 予約ブロックの配置: 複数卓は連続する行をまとめて1つの枠として表示
  const spanBlocks = [];
  const idxByTable = new Map(rows.map((rw, i) => [rw.tableId, i]));
  resList
    .filter((r) => r.status !== 'cancelled' && (r.tableIds || []).length)
    .forEach((r) => {
      const idxs = [...new Set(r.tableIds.map((id) => idxByTable.get(id)).filter((i) => i !== undefined && i > 0))]
        .sort((a, b) => a - b);
      if (!idxs.length) return;
      // 連続した行ごとにまとめる（離れた卓は別の枠）
      const runs = [[idxs[0]]];
      for (let k = 1; k < idxs.length; k++) {
        if (idxs[k] === idxs[k - 1] + 1) runs[runs.length - 1].push(idxs[k]);
        else runs.push([idxs[k]]);
      }
      runs.forEach((run) => {
        const anchorTable = rows[run[0]].tableId;
        if (run.length === 1) {
          const block = makeBlock(r, anchorTable);
          if (block) rows[run[0]].rowEl.appendChild(block);
        } else {
          const block = makeBlock(r, anchorTable, true);
          if (block) {
            grid.appendChild(block);
            spanBlocks.push({ el: block, first: run[0], last: run[run.length - 1] });
          }
        }
      });
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

  // 複数卓の枠を行位置に合わせて縦に伸ばす（DOM配置後に実寸で計算）
  spanBlocks.forEach(({ el, first, last }) => {
    const top = rows[first].lineEl.offsetTop + 5;
    const bottom = rows[last].lineEl.offsetTop + rows[last].lineEl.offsetHeight - 6;
    el.style.top = top + 'px';
    el.style.height = (bottom - top) + 'px';
    el.style.bottom = 'auto';
  });

  ttCtx = { grid, scroll: wrap, rows, openMin, closeMin, metrics: m };
  renderLegend();
}

function renderLegend() {
  const items = [
    { color: '#fff', label: statusLabel('reserved') },
    { color: 'var(--green-bg)', label: `${statusLabel('reserved')}(${t('course')})` },
    { color: 'var(--slate)', label: statusLabel('seated') },
    { color: 'var(--gray-block)', label: statusLabel('finished') },
    { color: 'var(--red)', label: statusLabel('noshow') },
    { color: 'var(--pink-bg)', label: t('unassigned') },
    { color: 'repeating-linear-gradient(45deg, #e2e8ee 0 4px, #f6f8fa 4px 8px)', label: statusLabel('block') },
  ];
  document.getElementById('legend').innerHTML =
    items.map((it) =>
      `<span class="lg"><span class="sw" style="background:${it.color}"></span>${esc(it.label)}</span>`
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

    const idx = rowIdxAtClientY(drag.lastY);
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
    // 動かさずに離した → タップ＝詳細を開く（ブロックは解除確認、リサイズハンドルは無視）
    if (d.mode === 'move') {
      if (d.r.status === 'block') {
        if (confirm(t('unblockConfirm'))) {
          state.reservations = state.reservations.filter((x) => x.id !== d.resId);
          save();
          renderAll();
        }
      } else {
        openResModal(d.resId);
      }
    }
    return;
  }

  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 350);
  cleanupDragVisuals(d);

  const r = d.r;
  if (d.mode === 'move') {
    if (d.newStart === r.start && d.newTableId === d.fromTableId) { renderTimetable(); return; }
    // 配席の更新: 未配席行へ→割当解除 / 未配席から→配席 / テーブル間→付け替え
    let newTableIds;
    if (d.newTableId === null) newTableIds = [];
    else if (d.fromTableId === null) newTableIds = [d.newTableId];
    else if ((r.tableIds || []).length > 1) {
      // 複数卓（1つの枠）はまとめて行方向へ平行移動。はみ出す場合は席を変えない
      const idxOf = (id) => ttCtx.rows.findIndex((rw) => rw.tableId === id);
      const delta = idxOf(d.newTableId) - idxOf(d.fromTableId);
      const shifted = r.tableIds.map((id) => {
        const i = idxOf(id);
        const target = i > 0 ? ttCtx.rows[i + delta] : null;
        return target && target.tableId ? target.tableId : null;
      });
      newTableIds = shifted.every(Boolean) ? [...new Set(shifted)] : r.tableIds;
    } else {
      newTableIds = [...new Set((r.tableIds || []).map((id) => (id === d.fromTableId ? d.newTableId : id)))];
    }
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
  const list = dayReservations(currentDate).filter((r) => r.status !== 'block');
  if (!list.length) {
    wrap.innerHTML = `<div class="empty-note">${esc(t('noReservations'))}</div>`;
    return;
  }
  wrap.innerHTML = '';
  const visitMap = buildVisitMap();
  list.forEach((r) => {
    const card = document.createElement('div');
    let cls = 'res-card ' + r.status;
    if (r.status === 'reserved' && r.course) cls += ' course';
    card.className = cls;
    let quick = '';
    if (r.status === 'reserved') quick = `<button class="btn small primary" data-quick="seated">${esc(t('quickSeat'))}</button>`;
    else if (r.status === 'seated') quick = `<button class="btn small secondary" data-quick="finished">${esc(t('quickFinish'))}</button>`;
    card.innerHTML =
      `<div class="rc-time">${fmtTime(r.start)}<small>${fmtTime(r.start + r.duration)}</small></div>` +
      `<div class="rc-main">` +
        `<div class="rc-name">${blockNameHtml(r, visitMap)}</div>` +
        `<div class="rc-sub">${esc(tableNames(r.tableIds))}${(() => { const s = siteById(r.channel); return s ? '　🌐 ' + esc(s.name) : ''; })()}${r.phone ? '　📞 ' + esc(r.phone) : ''}${r.course ? '　🍴 ' + esc(r.course) : ''}${r.memo ? '　📝 ' + esc(r.memo) : ''}</div>` +
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
    if (r.status === 'block') return;
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

/* ---------- 空きマスタップ/ドラッグのポップオーバー（トレタ風の予約/ウォークイン入力）
 * タップ: 1席・既定2時間 / 長押し（PCはドラッグ）で枠をなぞる: 横=時間枠・縦=複数席を選択 ---------- */
function openCellPopover(clientX, clientY, start, tableIds, duration) {
  closeCellPopover();
  const { openMin, closeMin } = state.settings;
  start = clamp(start - (start % 15), openMin, closeMin - 15);
  cellPick = {
    start,
    duration: clamp(duration || 120, 30, closeMin - start),
    tables: new Set(tableIds || []),
    mode: 'res',
    selectEls: [],
  };

  setCpMode('res');

  const paxWrap = document.getElementById('cpPax');
  paxWrap.innerHTML = '';
  for (let n = 1; n <= 8; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = dict().fmtPax(n);
    b.addEventListener('click', () => onCpPax(n));
    paxWrap.appendChild(b);
  }

  renderCpSelection();

  const pop = document.getElementById('cellPopover');
  pop.classList.remove('hidden');
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = clamp(clientX + 10, 8, window.innerWidth - w - 8) + 'px';
  pop.style.top = clamp(clientY + 10, 8, window.innerHeight - h - 8) + 'px';
}

/* 選択中の時間枠・テーブルの表示とタイムライン上のハイライトを更新 */
function renderCpSelection() {
  if (!cellPick) return;
  const { openMin } = state.settings;
  const names = [...cellPick.tables].map((id) => tableById(id)?.name).filter(Boolean);
  document.getElementById('cpInfo').textContent =
    `${names.length ? names.join(', ') : t('unassigned')}　${fmtTime(cellPick.start)}〜${fmtTime(cellPick.start + cellPick.duration)}`;

  // 選択ハイライト（選択中の全テーブル行に青帯）
  cellPick.selectEls.forEach((el) => el.remove());
  cellPick.selectEls = [];
  if (ttCtx && view === 'timetable') {
    const m = ttCtx.metrics;
    cellPick.tables.forEach((id) => {
      const row = ttCtx.rows.find((rw) => rw.tableId === id);
      if (!row) return;
      const sel = document.createElement('div');
      sel.className = 'tt-select';
      sel.style.left = ((cellPick.start - openMin) / SLOT_MIN) * m.slotW + 1 + 'px';
      sel.style.width = (cellPick.duration / SLOT_MIN) * m.slotW - 3 + 'px';
      row.rowEl.appendChild(sel);
      cellPick.selectEls.push(sel);
    });
  }

  // ブロックは1席以上選択時のみ
  document.getElementById('cpBlock').classList.toggle('hidden', cellPick.tables.size === 0);
}

/* ---------- 枠をなぞって範囲選択（横=時間・縦=複数席） ---------- */
let selDrag = null;

function timeAtClientX(clientX) {
  const m = ttCtx.metrics;
  const gr = ttCtx.grid.getBoundingClientRect();
  return ttCtx.openMin + ((clientX - gr.left - m.labelW) / m.slotW) * SLOT_MIN;
}
function rowIdxAtClientY(clientY) {
  // グループ見出し行の上でも最も近いテーブル行を返す
  const gr = ttCtx.grid.getBoundingClientRect();
  const y = clientY - gr.top;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ttCtx.rows.length; i++) {
    const top = ttCtx.rows[i].lineEl.offsetTop;
    const h = ttCtx.rows[i].lineEl.offsetHeight;
    if (y >= top && y < top + h) return i;
    const d = y < top ? top - y : y - (top + h);
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best;
}

function onRowPointerDown(e, tableId) {
  if (drag || selDrag || !ttCtx) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.target.closest('.tt-block')) return;
  if (!tableId) return; // 未配席行はタップのみ
  selDrag = {
    tableId,
    startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY,
    pointerType: e.pointerType, started: false, moved: false, longTimer: null, els: [],
    selStart: 0, selDur: 30, minIdx: 0, maxIdx: 0,
  };
  if (e.pointerType !== 'mouse') {
    selDrag.longTimer = setTimeout(() => { if (selDrag && !selDrag.started) startSelDrag(); }, 350);
  }
}

function startSelDrag() {
  if (!selDrag || !ttCtx) return;
  selDrag.started = true;
  if (navigator.vibrate) navigator.vibrate(15);
  closeCellPopover();
  const totalCells = Math.ceil((ttCtx.closeMin - ttCtx.openMin) / 30);
  selDrag.anchorCell = clamp(Math.floor((timeAtClientX(selDrag.startX) - ttCtx.openMin) / 30), 0, totalCells - 1);
  selDrag.anchorIdx = Math.max(1, ttCtx.rows.findIndex((rw) => rw.tableId === selDrag.tableId));
  updateSelDrag();
}

function updateSelDrag() {
  const totalCells = Math.ceil((ttCtx.closeMin - ttCtx.openMin) / 30);
  const curCell = clamp(Math.floor((timeAtClientX(selDrag.lastX) - ttCtx.openMin) / 30), 0, totalCells - 1);
  const curIdx = clamp(rowIdxAtClientY(selDrag.lastY), 1, ttCtx.rows.length - 1);
  if (curCell !== selDrag.anchorCell || curIdx !== selDrag.anchorIdx) selDrag.moved = true;
  const startCell = Math.min(selDrag.anchorCell, curCell);
  const endCell = Math.max(selDrag.anchorCell, curCell);
  selDrag.selStart = ttCtx.openMin + startCell * 30;
  selDrag.selDur = (endCell - startCell + 1) * 30;
  selDrag.minIdx = Math.min(selDrag.anchorIdx, curIdx);
  selDrag.maxIdx = Math.max(selDrag.anchorIdx, curIdx);

  // 選択バンドを再描画
  selDrag.els.forEach((el) => el.remove());
  selDrag.els = [];
  const m = ttCtx.metrics;
  for (let i = selDrag.minIdx; i <= selDrag.maxIdx; i++) {
    const row = ttCtx.rows[i];
    if (!row || row.tableId == null) continue;
    const sel = document.createElement('div');
    sel.className = 'tt-select';
    sel.style.left = ((selDrag.selStart - ttCtx.openMin) / SLOT_MIN) * m.slotW + 1 + 'px';
    sel.style.width = (selDrag.selDur / SLOT_MIN) * m.slotW - 3 + 'px';
    row.rowEl.appendChild(sel);
    selDrag.els.push(sel);
  }
}

function onSelMove(e) {
  if (!selDrag) return;
  selDrag.lastX = e.clientX;
  selDrag.lastY = e.clientY;
  if (!selDrag.started) {
    const dist = Math.hypot(e.clientX - selDrag.startX, e.clientY - selDrag.startY);
    if (selDrag.pointerType === 'mouse') {
      if (dist > 4) startSelDrag();
    } else if (dist > 12) {
      // 長押し前に動いた → スクロール操作
      clearTimeout(selDrag.longTimer);
      selDrag = null;
    }
    return;
  }
  updateSelDrag();
  autoScroll(e);
}

function onSelUp(e) {
  if (!selDrag) return;
  clearTimeout(selDrag.longTimer);
  const d = selDrag;
  selDrag = null;
  if (!d.started) return; // 通常タップ → rowのclickで処理
  d.els.forEach((el) => el.remove());
  suppressClick = true;
  setTimeout(() => { suppressClick = false; }, 350);
  // なぞらず離した長押しは通常タップ扱い（1席・既定2時間）
  if (!d.moved) {
    openCellPopover(e.clientX, e.clientY, d.selStart, [d.tableId], 120);
    return;
  }
  const tables = [];
  for (let i = d.minIdx; i <= d.maxIdx; i++) {
    const row = ttCtx.rows[i];
    if (row && row.tableId != null) tables.push(row.tableId);
  }
  openCellPopover(e.clientX, e.clientY, d.selStart, tables, d.selDur);
}

function onSelCancel() {
  if (!selDrag) return;
  clearTimeout(selDrag.longTimer);
  selDrag.els.forEach((el) => el.remove());
  selDrag = null;
}

function setCpMode(mode) {
  if (cellPick) cellPick.mode = mode;
  document.getElementById('cpTabRes').classList.toggle('active', mode === 'res');
  document.getElementById('cpTabWalkIn').classList.toggle('active', mode === 'walkin');
}

function onCpPax(n) {
  if (!cellPick) return;
  const { start, duration, tables, mode } = cellPick;
  const ids = [...tables];
  closeCellPopover();
  if (mode === 'walkin') createWalkIn(start, ids, n, duration);
  else openResModal(null, { start, tableIds: ids, adults: n, duration });
}

/* 予約ブロック: 選択した席×時間枠をネット予約の在庫から外す */
function createBlock(start, tableIds, duration, date) {
  if (!tableIds.length) return;
  state.reservations.push({
    id: uid(),
    date: date || currentDate,
    start,
    duration: duration || 120,
    adults: 0,
    children: 0,
    name: t('statusBlock'),
    kana: '',
    phone: '',
    tableIds,
    course: '',
    memo: '',
    status: 'block',
    walkIn: false,
    channel: '',
  });
  save();
  renderAll();
}

function closeCellPopover() {
  if (cellPick) cellPick.selectEls.forEach((el) => el.remove());
  cellPick = null;
  document.getElementById('cellPopover').classList.add('hidden');
}

/* ウォークインをその場で即時登録（来店中） */
function createWalkIn(start, tableIds, pax, duration, date) {
  const res = {
    id: uid(),
    date: date || currentDate,
    start,
    duration: duration || 120,
    adults: pax,
    children: 0,
    name: t('walkInName'),
    kana: '',
    phone: '',
    tableIds: tableIds || [],
    course: '',
    memo: '',
    status: 'seated',
    walkIn: true,
  };
  if (res.tableIds.length && hasConflict(res) && !confirm(t('conflictWarn'))) return;
  state.reservations.push(res);
  save();
  renderAll();
}

/* ---------- 予約サイト設定・在庫連携 ---------- */
const SITE_COLORS = ['#f59e0b', '#ef4444', '#8b5cf6', '#0ea5e9', '#16a34a', '#ec4899'];
let editingSiteId = null;
let siteModalTables = new Set();
let siteModalColor = SITE_COLORS[0];

/* サイトごとの予約URL（経路パラメータ付き） */
function bookingUrl(siteId) {
  const base = location.protocol === 'file:'
    ? location.href.replace(/index\.html.*$/, '') + 'booking.html'
    : `${location.protocol}//${location.host}/booking.html`;
  return siteId ? `${base}?site=${encodeURIComponent(siteId)}` : base;
}

function copyText(txt) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(txt);
  const ta = document.createElement('textarea');
  ta.value = txt;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}

function renderSites() {
  const wrap = document.getElementById('siteCards');
  wrap.innerHTML = '';
  if (!state.sites.length) {
    wrap.innerHTML = `<div class="empty-note">${esc(t('noSites'))}</div>`;
  }
  // 自社予約サイトを先頭に表示
  [...state.sites].sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0)).forEach((s) => {
    const url = bookingUrl(s.id);
    const card = document.createElement('div');
    card.className = 'site-card';
    card.innerHTML =
      `<span class="site-color" style="background:${esc(s.color)}"></span>` +
      `<div class="site-main">` +
        `<div class="site-name">${esc(s.name)}</div>` +
        `<div class="site-sub">${esc(t('linkedTables'))}: ${esc(tableNames(s.tableIds))}</div>` +
        `<div class="site-url"><code>${esc(url)}</code></div>` +
      `</div>` +
      `<div class="site-actions">` +
        `<button class="pill ${s.enabled ? 'on' : 'off'}" data-act="toggle">${esc(s.enabled ? t('acceptOn') : t('acceptOff'))}</button>` +
        `<button class="btn primary small" data-act="copy">${esc(t('copyUrl'))}</button>` +
        `<button class="btn ghost small" data-act="open">${esc(t('openSite'))}</button>` +
      `</div>`;
    card.querySelector('[data-act="toggle"]').addEventListener('click', (e) => {
      e.stopPropagation();
      s.enabled = !s.enabled;
      save();
      renderSites();
    });
    card.querySelector('[data-act="copy"]').addEventListener('click', async (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      try {
        await copyText(url);
        btn.textContent = t('copied');
        setTimeout(() => { btn.textContent = t('copyUrl'); }, 1600);
      } catch (err) { prompt('URL', url); }
    });
    card.querySelector('[data-act="open"]').addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(url, '_blank');
    });
    card.addEventListener('click', () => openSiteModal(s.id));
    wrap.appendChild(card);
  });
  renderInventory();
}

/* 台帳の予約状況からサイトごとの空席在庫を計算して表示 */
function renderInventory() {
  const wrap = document.getElementById('invGrid');
  const { openMin, closeMin } = state.settings;
  const DUR = 120; // 滞在想定（分）
  const lastStart = closeMin - DUR;
  const sites = [...state.sites].sort((a, b) => (b.own ? 1 : 0) - (a.own ? 1 : 0)).filter((s) => s.enabled);
  if (!sites.length || lastStart < openMin) {
    wrap.innerHTML = `<div class="empty-note">${esc(t('noSites'))}</div>`;
    return;
  }
  const slots = [];
  for (let m2 = openMin; m2 <= lastStart; m2 += 30) slots.push(m2);

  const actives = dayReservations(currentDate).filter((r) => r.status !== 'cancelled' && r.status !== 'noshow');
  const busy = (tableId, start) =>
    actives.some((r) => (r.tableIds || []).includes(tableId) && r.start < start + DUR && start < r.start + r.duration);

  let html = '<table class="inv-table"><thead><tr><th></th>' +
    slots.map((s2) => `<th>${fmtTime(s2)}</th>`).join('') +
    '</tr></thead><tbody>';
  sites.forEach((s) => {
    html += `<tr><th><span class="ch-dot" style="background:${esc(s.color)}"></span>${esc(s.name)}</th>`;
    slots.forEach((m2) => {
      const n = s.tableIds.filter((id) => tableById(id) && !busy(id, m2)).length;
      const cls = n === 0 ? 'full' : n === 1 ? 'low' : 'ok';
      html += `<td class="inv-cell ${cls}" data-site="${esc(s.id)}" data-start="${m2}" title="${n === 0 ? esc(t('full')) : ''}">${n === 0 ? '×' : n}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  // 空きマスタップ → そのサイト経由の予約を登録
  wrap.querySelectorAll('.inv-cell.ok, .inv-cell.low').forEach((td) => {
    td.addEventListener('click', () => {
      const site = siteById(td.dataset.site);
      const start = Number(td.dataset.start);
      if (!site) return;
      const freeTable = site.tableIds.find((id) => tableById(id) && !busy(id, start));
      openResModal(null, { start, tableId: freeTable, channel: site.id });
    });
  });
}

function openSiteModal(siteId) {
  editingSiteId = siteId || null;
  const s = siteId ? siteById(siteId) : null;
  document.getElementById('siteModalTitle').textContent = s ? t('editSite') : t('addSite');
  document.getElementById('sName').value = s ? s.name : '';
  siteModalColor = s ? s.color : SITE_COLORS[state.sites.length % SITE_COLORS.length];
  siteModalTables = new Set(s ? s.tableIds : []);
  renderSiteColors();
  renderSiteTables();
  // 自社サイトは削除不可（URL発行元のため）
  document.getElementById('btnSiteDelete').classList.toggle('hidden', !s || !!s.own);
  document.getElementById('siteModal').classList.remove('hidden');
}

function renderSiteColors() {
  const wrap = document.getElementById('sColors');
  wrap.innerHTML = '';
  SITE_COLORS.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.style.background = c;
    b.className = c === siteModalColor ? 'active' : '';
    b.addEventListener('click', () => { siteModalColor = c; renderSiteColors(); });
    wrap.appendChild(b);
  });
}

function renderSiteTables() {
  const wrap = document.getElementById('sTables');
  wrap.innerHTML = '';
  state.tables.forEach((tb) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (siteModalTables.has(tb.id) ? ' active' : '');
    chip.textContent = `${tb.name} (${tb.seats})`;
    chip.addEventListener('click', () => {
      if (siteModalTables.has(tb.id)) siteModalTables.delete(tb.id); else siteModalTables.add(tb.id);
      renderSiteTables();
    });
    wrap.appendChild(chip);
  });
}

function closeSiteModal() {
  document.getElementById('siteModal').classList.add('hidden');
  editingSiteId = null;
}

function saveSite() {
  const name = document.getElementById('sName').value.trim();
  if (!name) { alert(t('siteName')); return; }
  if (editingSiteId) {
    const s = siteById(editingSiteId);
    if (s) { s.name = name; s.color = siteModalColor; s.tableIds = [...siteModalTables]; }
  } else {
    state.sites.push({ id: uid(), name, color: siteModalColor, enabled: true, tableIds: [...siteModalTables] });
  }
  save();
  closeSiteModal();
  renderSites();
}

function deleteSite() {
  if (!editingSiteId) return;
  if (!confirm(t('deleteSiteConfirm'))) return;
  state.sites = state.sites.filter((s) => s.id !== editingSiteId);
  save();
  closeSiteModal();
  renderSites();
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
  const durSel = document.getElementById('fDur');
  const durVal = r ? r.duration : (prefill.duration ?? 120);
  if (![...durSel.options].some((o) => Number(o.value) === durVal)) {
    const opt = document.createElement('option');
    opt.value = durVal;
    opt.textContent = `${durVal} ${t('minutesUnit')}`;
    durSel.appendChild(opt);
  }
  durSel.value = durVal;

  document.getElementById('fAdults').textContent = r ? r.adults : (prefill.adults ?? 2);
  document.getElementById('fChildren').textContent = r ? r.children : 0;
  document.getElementById('fName').value = r ? r.name : (modalWalkIn ? t('walkInName') : '');
  document.getElementById('fKana').value = r ? (r.kana || '') : '';
  document.getElementById('fPhone').value = r ? (r.phone || '') : '';
  document.getElementById('fCourse').value = r ? (r.course || '') : '';
  document.getElementById('fMemo').value = r ? (r.memo || '') : '';

  // 予約経路（店頭・電話＋登録済みサイト）
  const chSel = document.getElementById('fChannel');
  chSel.innerHTML = `<option value="">${esc(t('channelNone'))}</option>` +
    state.sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  chSel.value = r ? (r.channel || '') : (prefill.channel || '');

  modalTables = new Set(r ? r.tableIds : (prefill.tableIds ?? (prefill.tableId ? [prefill.tableId] : [])));
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
    channel: document.getElementById('fChannel').value,
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

  // 結合（合席）設定の作業コピー
  comboWork = (state.combos || []).map((c) => ({ ...c, tableIds: [...c.tableIds] }));
  renderComboRows();

  document.getElementById('settingsModal').classList.remove('hidden');
}

/* 結合テーブル（合席）設定 */
let comboWork = [];
function renderComboRows() {
  const wrap = document.getElementById('comboRows');
  wrap.innerHTML = '';
  comboWork.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'combo-row';
    const chips = document.createElement('div');
    chips.className = 'combo-tables';
    state.tables.forEach((tb) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip' + (c.tableIds.includes(tb.id) ? ' active' : '');
      chip.textContent = `${tb.name} (${tb.seats})`;
      chip.addEventListener('click', () => {
        if (c.tableIds.includes(tb.id)) c.tableIds = c.tableIds.filter((id) => id !== tb.id);
        else c.tableIds.push(tb.id);
        // 最大人数は席数合計で自動計算（保存前に手動調整可）
        c.max = c.tableIds.reduce((s, id) => s + (tableById(id)?.seats || 0), 0);
        renderComboRows();
      });
      chips.appendChild(chip);
    });
    const foot = document.createElement('div');
    foot.className = 'combo-foot';
    foot.innerHTML =
      `<label>${esc(t('comboMax'))}</label>` +
      `<input type="number" min="1" max="99" value="${c.max || 0}">` +
      `<button type="button" class="icon-btn">🗑</button>`;
    foot.querySelector('input').addEventListener('change', (e) => { c.max = Math.max(1, Number(e.target.value) || 1); });
    foot.querySelector('.icon-btn').addEventListener('click', () => { comboWork.splice(i, 1); renderComboRows(); });
    row.appendChild(chips);
    row.appendChild(foot);
    wrap.appendChild(row);
  });
}

function addTableRow(tb) {
  const wrap = document.getElementById('tblRows');
  const row = document.createElement('div');
  row.className = 'tbl-row';
  row.dataset.id = tb ? tb.id : '';
  row.innerHTML =
    `<input type="text" class="tr-name" value="${esc(tb ? tb.name : '')}">` +
    `<input type="text" class="tr-group" placeholder="${esc(t('groupPlaceholder'))}" value="${esc(tb ? (tb.group || '') : '')}">` +
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
    const group = row.querySelector('.tr-group').value.trim();
    tables.push({ id: row.dataset.id || uid(), name, seats, group });
  });
  if (tables.length) state.tables = tables;
  // 結合設定を保存（存在するテーブル2卓以上のみ有効）
  state.combos = comboWork
    .map((c) => ({ ...c, tableIds: c.tableIds.filter((id) => state.tables.some((tb) => tb.id === id)) }))
    .filter((c) => c.tableIds.length >= 2 && (c.max || 0) >= 1);
  save();
  document.getElementById('settingsModal').classList.add('hidden');
  renderAll();
}

/* ---------- チャット操作（ルールベースの日本語/ベトナム語コマンド解析） ---------- */
function chatAppend(role, text) {
  const log = document.getElementById('chatLog');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function chatOffsetDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function chatFindRes(name, date) {
  const key = name.toLowerCase();
  return state.reservations.find((r) =>
    r.date === date && r.status !== 'cancelled' && r.status !== 'block' &&
    r.name.toLowerCase().includes(key));
}

function chatSummary(date, start, dur, tableIds, name, pax) {
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  const parts = [dict().fmtDateBox(y, m, d, wd), `${fmtTime(start)}〜${fmtTime(start + dur)}`];
  if (tableIds && tableIds.length) parts.push(tableNames(tableIds));
  if (name) parts.push(name);
  if (pax) parts.push(dict().fmtPax(pax));
  return parts.join('　');
}

function chatExecute(text) {
  const lower = text.toLowerCase();
  const { openMin, closeMin } = state.settings;

  if (/ヘルプ|使い方|help|hướng dẫn/.test(lower)) return t('chatHello') + '\n' + t('chatExamples');

  // 日付
  let date = currentDate;
  const md = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (/明後日|ngày kia/.test(lower)) date = chatOffsetDate(2);
  else if (/明日|ngày mai/.test(lower)) date = chatOffsetDate(1);
  else if (/今日|hôm nay/.test(lower)) date = todayStr();
  else if (md) date = `${new Date().getFullYear()}-${pad2(+md[1])}-${pad2(+md[2])}`;

  // 時間（19時 / 19時半 / 19:30 / 19h30）
  let start = null;
  const tm = text.match(/(\d{1,2})\s*[:時h]\s*(\d{2})?(半)?/);
  if (tm) start = clamp((+tm[1]) * 60 + (tm[2] ? +tm[2] : 0) + (tm[3] ? 30 : 0), 0, 24 * 60);

  // 滞在時間（2時間 / 2 giờ / 1.5時間）
  let dur = null;
  const dm = text.match(/(\d+(?:\.\d+)?)\s*(時間|giờ)/);
  if (dm) dur = Math.round(parseFloat(dm[1]) * 60);

  // 人数（4名 / 4人 / 4 khách）
  let pax = null;
  const pm = text.match(/(\d+)\s*(名様?|人|khách)/);
  if (pm) pax = +pm[1];

  // テーブル（登録名と一致、長い名前を優先）
  const tables = [...state.tables]
    .sort((a, b) => b.name.length - a.name.length)
    .filter((tb) => {
      const re = new RegExp(tb.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + (/\d$/.test(tb.name) ? '(?!\\d)' : ''), 'i');
      return re.test(text);
    });
  const tableIds = tables.map((tb) => tb.id);

  // 名前（〇〇様/さん、または「tên 〜」）
  let name = null;
  const nm = text.match(/([^\s、。,]+?)(様|さま|さん)/);
  if (nm) name = nm[1];
  else {
    const tn = text.match(/tên\s+([^\s,、。]+(?:\s[^\s,、。]+)?)/i);
    if (tn) name = tn[1];
  }

  // 営業時間: 「営業時間を17時から23時に」
  const bh = text.match(/営業時間.*?(\d{1,2})\s*時.*?(\d{1,2})\s*時/);
  if (bh) {
    const o = (+bh[1]) * 60, c = (+bh[2]) * 60;
    if (c > o) {
      state.settings.openMin = o;
      state.settings.closeMin = c;
      save();
      return `✅ ${fmtTime(o)}〜${fmtTime(c)} — ${t('chatUpdated')}`;
    }
  }

  // テーブル追加: 「テーブルT9を4席で追加」
  if (/追加|thêm/.test(lower) && /テーブル|bàn/.test(lower)) {
    const an = text.match(/テーブル\s*([^\s、。を]+)/) || text.match(/bàn\s+(\S+)/i);
    const as = text.match(/(\d+)\s*(席|ghế)/);
    if (an) {
      state.tables.push({ id: uid(), name: an[1], seats: as ? +as[1] : 4, group: '' });
      save();
      return `✅ ${an[1]} (${as ? +as[1] : 4}${t('seatsUnit')}) — ${t('chatDone')}`;
    }
    return t('chatNeedTable');
  }

  // グループ設定: 「T1をホールグループに」
  const gm = text.match(/を(.+?)グループ/) || text.match(/nhóm\s+([^\s,、。]+)/i);
  if (gm && tableIds.length && /グループ|nhóm/.test(lower)) {
    tables.forEach((tb) => { tb.group = gm[1].trim(); });
    save();
    return `✅ ${tables.map((tb) => tb.name).join(', ')} → ${gm[1].trim()} — ${t('chatUpdated')}`;
  }

  // 席数変更: 「T1を6席に変更」
  const scm = text.match(/(\d+)\s*(席|ghế)/);
  if (scm && tableIds.length && /(席|ghế)\s*(に|へ|đổi)|変更/.test(text) && !/追加|thêm/.test(lower)) {
    tables.forEach((tb) => { tb.seats = +scm[1]; });
    save();
    return `✅ ${tables.map((tb) => tb.name).join(', ')} → ${scm[1]}${t('seatsUnit')} — ${t('chatUpdated')}`;
  }

  // 結合解除: 「T1とT2の結合を解除」
  if (/(結合|合席|ghép)/.test(lower) && /(解除|削除|bỏ|xóa)/.test(lower) && tableIds.length) {
    const before = (state.combos || []).length;
    state.combos = (state.combos || []).filter((c) => !c.tableIds.some((id) => tableIds.includes(id)));
    if (state.combos.length === before) return t('chatNotFound');
    save();
    return `✅ ${tables.map((tb) => tb.name).join('+')} — ${t('chatDeleted')}`;
  }

  // 結合（合席）: 「T1とT2を合わせて8名まで」
  if (/(結合|合わせて|合席|ghép)/.test(lower) && tableIds.length >= 2) {
    const max = pax || tables.reduce((s, tb) => s + tb.seats, 0);
    state.combos = state.combos || [];
    state.combos.push({ id: uid(), tableIds, max });
    save();
    return `✅ ${tables.map((tb) => tb.name).join('+')} → ${dict().fmtPax(max)} — ${t('chatUpdated')}`;
  }

  // テーブル削除: 「T9を削除」
  if (/(削除|xóa)/.test(lower) && tableIds.length) {
    state.tables = state.tables.filter((tb) => !tableIds.includes(tb.id));
    state.sites.forEach((s) => { s.tableIds = s.tableIds.filter((id) => !tableIds.includes(id)); });
    save();
    return `✅ ${tables.map((tb) => tb.name).join(', ')} — ${t('chatDeleted')}`;
  }

  // ブロック解除: 「T2のブロック解除」
  if (/(ブロック|chặn)/.test(lower) && /(解除|bỏ)/.test(lower)) {
    const before = state.reservations.length;
    state.reservations = state.reservations.filter((r) =>
      !(r.status === 'block' && r.date === date &&
        (!tableIds.length || r.tableIds.some((id) => tableIds.includes(id)))));
    if (state.reservations.length === before) return t('chatNotFound');
    save();
    return `✅ ${t('chatUnblocked')}`;
  }

  // ブロック: 「T2を19時から2時間ブロック」
  if (/ブロック|chặn/.test(lower)) {
    if (!tableIds.length) return t('chatNeedTable');
    if (start == null) return t('chatNeedTime');
    createBlock(start, tableIds, dur || 120, date);
    return `✅ ${chatSummary(date, start, dur || 120, tableIds)} — ${t('chatBlocked')}`;
  }

  // ウォークイン: 「ウォークイン 2名 C1」
  if (/ウォークイン|walk|vãng lai/.test(lower)) {
    const s2 = start ?? clamp(defaultStart(), openMin, closeMin - 30);
    createWalkIn(s2, tableIds, pax || 2, dur || 120, date);
    return `✅ ${chatSummary(date, s2, dur || 120, tableIds, t('walkInName'), pax || 2)} — ${t('chatDone')}`;
  }

  // キャンセル: 「田中様の予約をキャンセル」
  if (/キャンセル|hủy/.test(lower)) {
    if (!name) return t('chatNeedName');
    const r = chatFindRes(name, date);
    if (!r) return t('chatNotFound');
    r.status = 'cancelled';
    save();
    renderAll();
    return `✅ ${chatSummary(r.date, r.start, r.duration, r.tableIds, r.name)} — ${t('chatCancelled')}`;
  }

  // 来店 / 会計
  if (name && /来店|đã đến/.test(text)) {
    const r = chatFindRes(name, date);
    if (!r) return t('chatNotFound');
    r.status = 'seated';
    save();
    renderAll();
    return `✅ ${r.name} — ${statusLabel('seated')}`;
  }
  if (name && /会計|退店|thanh toán/.test(lower)) {
    const r = chatFindRes(name, date);
    if (!r) return t('chatNotFound');
    r.status = 'finished';
    save();
    renderAll();
    return `✅ ${r.name} — ${statusLabel('finished')}`;
  }

  // 予約（既定）: 「明日19時 田中様 4名 T3で予約」
  if (/予約|đặt/.test(lower) || (start != null && (pax != null || name))) {
    if (start == null) return t('chatNeedTime');
    if (!name) return t('chatNeedName');
    const res = {
      id: uid(),
      date,
      start: clamp(start, openMin, closeMin - 30),
      duration: dur || 120,
      adults: pax || 2,
      children: 0,
      name,
      kana: '',
      phone: '',
      tableIds,
      course: '',
      memo: '',
      status: 'reserved',
      walkIn: false,
      channel: '',
    };
    const conflict = res.tableIds.length && hasConflict(res);
    state.reservations.push(res);
    save();
    renderAll();
    return `✅ ${chatSummary(res.date, res.start, res.duration, res.tableIds, res.name, res.adults)} — ${t('chatDone')}${conflict ? '\n' + t('chatConflict') : ''}`;
  }

  return t('chatUnknown') + '\n' + t('chatExamples');
}

function chatSubmit() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  chatAppend('user', text);
  let reply;
  try {
    reply = chatExecute(text);
  } catch (e) {
    reply = t('chatUnknown') + '\n' + t('chatExamples');
  }
  chatAppend('bot', reply);
}

/* ---------- view switching / render ---------- */
function setView(v) {
  view = v;
  document.querySelectorAll('.rail-btn[data-view], #bottomNav .bn-btn, #viewSwitch .vs-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
  });
  document.getElementById('view-timetable').classList.toggle('hidden', v !== 'timetable');
  document.getElementById('view-list').classList.toggle('hidden', v !== 'list');
  document.getElementById('view-customers').classList.toggle('hidden', v !== 'customers');
  document.getElementById('view-sites').classList.toggle('hidden', v !== 'sites');
  document.getElementById('view-chat').classList.toggle('hidden', v !== 'chat');
  if (v === 'chat' && !document.getElementById('chatLog').childElementCount) {
    chatAppend('bot', t('chatHello') + '\n' + t('chatExamples'));
  }
  renderAll();
}

function renderAll() {
  closeCellPopover();
  applyStaticI18n();
  renderDateBar();
  if (view === 'timetable') renderTimetable();
  else if (view === 'list') renderList();
  else if (view === 'sites') renderSites();
  else if (view === 'customers') renderCustomers();
  /* chat はDOMを保持するため再描画しない */
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
  document.getElementById('rail').addEventListener('click', onNavClick);
  document.getElementById('bottomNav').addEventListener('click', onNavClick);
  document.getElementById('viewSwitch').addEventListener('click', onNavClick);
  document.getElementById('railSettings').addEventListener('click', openSettingsModal);

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

  document.getElementById('fabNew').addEventListener('click', () => openResModal(null));
  document.getElementById('fabWalkIn').addEventListener('click', () => openResModal(null, { walkIn: true }));

  // ポップオーバー
  document.getElementById('cpTabRes').addEventListener('click', () => setCpMode('res'));
  document.getElementById('cpTabWalkIn').addEventListener('click', () => setCpMode('walkin'));
  document.getElementById('cpBlock').addEventListener('click', () => {
    if (!cellPick) return;
    const { start, duration, tables } = cellPick;
    const ids = [...tables];
    closeCellPopover();
    createBlock(start, ids, duration);
  });
  // ポップオーバーの外側をタップで閉じる
  document.addEventListener('pointerdown', (e) => {
    if (cellPick && !e.target.closest('#cellPopover')) closeCellPopover();
  });

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

  // チャット操作
  document.getElementById('btnChatPhone').addEventListener('click', () => setView('chat'));
  document.getElementById('chatSend').addEventListener('click', chatSubmit);
  document.getElementById('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) chatSubmit();
  });

  // 予約サイト設定
  document.getElementById('btnSitesPhone').addEventListener('click', () => setView('sites'));
  document.getElementById('btnAddSite').addEventListener('click', () => openSiteModal(null));
  document.getElementById('btnSiteClose').addEventListener('click', closeSiteModal);
  document.getElementById('btnSiteCancel').addEventListener('click', closeSiteModal);
  document.getElementById('btnSiteSave').addEventListener('click', saveSite);
  document.getElementById('btnSiteDelete').addEventListener('click', deleteSite);

  document.getElementById('btnSettings').addEventListener('click', openSettingsModal);
  document.getElementById('btnSetClose').addEventListener('click', () => document.getElementById('settingsModal').classList.add('hidden'));
  document.getElementById('btnSetCancel').addEventListener('click', () => document.getElementById('settingsModal').classList.add('hidden'));
  document.getElementById('btnSetSave').addEventListener('click', saveSettings);
  document.getElementById('btnAddTable').addEventListener('click', () => addTableRow(null));
  document.getElementById('btnAddCombo').addEventListener('click', () => {
    comboWork.push({ id: uid(), tableIds: [], max: 0 });
    renderComboRows();
  });

  document.getElementById('custSearch').addEventListener('input', () => {
    if (view === 'customers') renderCustomers();
  });

  // 別タブ（自社予約サイト等）での予約を即時反映
  window.addEventListener('storage', (e) => {
    if (e.key === LS_KEY) { load(); renderAll(); }
  });

  // ドラッグ用グローバルリスナー（予約ブロック移動＋範囲選択）
  window.addEventListener('pointermove', onDragMove);
  window.addEventListener('pointerup', onDragUp);
  window.addEventListener('pointercancel', onDragCancel);
  window.addEventListener('pointermove', onSelMove);
  window.addEventListener('pointerup', onSelUp);
  window.addEventListener('pointercancel', onSelCancel);
  // ドラッグ確定後はスクロールを止める（passive:false 必須）
  document.addEventListener('touchmove', (e) => {
    if ((drag && drag.started) || (selDrag && selDrag.started)) e.preventDefault();
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
