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
const LS_REGISTRY = 'yoyaku-daicho-stores';   // 店舗一覧と表示中の店舗ID
const cloudMode = typeof Cloud !== 'undefined' && Cloud.enabled;   // config.js に Supabase の接続先があればクラウド保存
/* Google API キーは公開リポジトリに含めない（端末ごとにテーブル設定で入力する） */
/* 最初の店舗の初期値（Robata Naru-Charcoal Grill / ハノイ）。店舗情報は設定画面で変更可 */
const DEFAULT_STORE_INFO = {
  storeName: 'Robata Naru-Charcoal Grill',
  storeKana: 'ろばた なる',
  storeGenre: '居酒屋・炉端焼き',
  storePhone: '+84 333 995 532',
  storeAddress: '36 Linh Lang, Ngọc Hà, Hà Nội 111000, Vietnam',
  googlePlaceId: 'ChIJvXU5_t2rNTERUExSW6o5yiI',
};
let registry = null;                          // { stores: [{id, name}], currentId }
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
let modalCourses = [];         // モーダル内で選択中のコース [{courseId, quantity}]
let modalTags = new Set();     // モーダル内で選択中のタグID

let ttCtx = null;              // タイムテーブル描画コンテキスト（ドラッグ用）
let drag = null;               // 進行中のドラッグ情報
let suppressClick = false;     // ドラッグ直後のclick誤発火防止
let cellPick = null;           // 空きマスタップのポップオーバー状態 {start, tableId, mode, selectEl}
let listFilter = { q: '', status: 'all' };   // 予約一覧の検索語・ステータス絞り込み
let calMonth = null;                          // カレンダー表示中の年月 {y, m}
let courseWork = [];                          // 設定モーダル内のコースマスタ作業コピー
let tagWork = [];                             // 設定モーダル内のタグマスタ作業コピー
let closedDaysWork = new Set();               // 設定モーダル内の定休日（曜日）
let closedDatesWork = [];                     // 設定モーダル内の臨時休業日
/* 予約サイトの店舗情報に使うテキスト設定（STORE_EXTRA_KEYS は入力欄を動的生成） */
const STORE_EXTRA_KEYS = ['storePrivateRoom', 'storeCharter', 'storeSmoking', 'storeParking', 'storeFacilities', 'storeDrink', 'storeFood',
  'storeScene', 'storeService', 'storeKids', 'storeWebsite', 'storeSns', 'storeOpenDate', 'storeRemarks'];
const STORE_TEXT_KEYS = ['storeKana', 'storeGenre', 'storeAccess', 'storeHours', 'storeBudget', 'storeBudgetLunch', 'storePayment', 'storeCatch',
  'storeDescription', 'storePhotos', 'googlePlaceId', 'googleApiKey', 'claudeApiKey', ...STORE_EXTRA_KEYS];
const settingInputId = (k) => 's' + k.charAt(0).toUpperCase() + k.slice(1);

/* ---------- helpers ---------- */
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function fmtTime(min) { return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }
function uid() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
/* 文字数の上限（保存データの肥大化・表示崩れの防止） */
function lim(s, n) { return String(s ?? '').slice(0, n); }
/* 予約サイトの色: 16進カラー以外は既定色に置き換え（style 属性への注入防止） */
function safeColor(c) { return /^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#9aa7af'; }
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
    { id: uid(), date: today, start: 12 * 60, duration: 90, adults: 2, children: 0, name: '田中', kana: 'タナカ', phone: '090-1111-2222', company: '株式会社ABC', reservationName: '', email: 'tanaka@example.com', gender: 1, purpose: 2, hasTimeLimit: false, resetTime: 0, tableIds: ['t1'], courses: [], tags: ['tag10'], memo: '', status: 'finished', walkIn: false },
    { id: uid(), date: today, start: 18 * 60, duration: 120, adults: 4, children: 0, name: '佐藤', kana: 'サトウ', phone: '090-3333-4444', company: '', reservationName: '', email: '', gender: 0, purpose: 1, hasTimeLimit: true, resetTime: 15, tableIds: ['t2'], courses: [{ courseId: 'crs1', quantity: 4 }], tags: ['tag1', 'tag2'], memo: '窓際希望', status: 'reserved', walkIn: false },
    { id: uid(), date: today, start: 18 * 60 + 30, duration: 120, adults: 5, children: 1, name: 'Nguyễn Văn An', kana: '', phone: '070-5555-6666', tableIds: ['t7'], course: '', memo: 'Sinh nhật / 誕生日', status: 'reserved', walkIn: false },
    { id: uid(), date: today, start: 19 * 60, duration: 90, adults: 2, children: 0, name: '山本', kana: 'ヤマモト', phone: '', tableIds: ['t5'], course: '', memo: '', status: 'reserved', walkIn: false },
    { id: uid(), date: today, start: 21 * 60, duration: 90, adults: 4, children: 0, name: 'あいだ はなこ', kana: 'アイダ ハナコ', phone: '080-7777-8888', tableIds: [], course: '', memo: '', status: 'reserved', walkIn: false },
  ];
  return {
    tables,
    reservations,
    sites: defaultSites(),
    courses: defaultCourses(),
    tags: defaultTags(),
    sitesV2: true,
    tablesV2: true,
    combos: [{ id: 'cb1', tableIds: ['t1', 't2'], max: 8 }],
    settings: { lang: 'ja', openMin: 11 * 60, closeMin: 23 * 60, closedDays: [], closedDates: [], googleApiKey: '', ...DEFAULT_STORE_INFO },
  };
}
/* コースマスタ（reservation_courses が参照） */
function defaultCourses() {
  return [
    { id: 'crs1', name: 'MSスタンダードコース' },
    { id: 'crs2', name: 'MSマグロ堪能コース' },
    { id: 'crs3', name: 'マグロ極みコース' },
  ];
}
/* タグマスタ（reservation_tags が参照） */
function defaultTags() {
  return ['記念日', '席指定', 'アレルギー', '予約クーポン', 'ポイント割引', 'コース', '対応注文', '短時OK', '要連絡', '初来店', '知人紹介', '口コミ', '2時間', '性飲み放題', 'SNS']
    .map((name, i) => ({ id: 'tag' + (i + 1), name }));
}
function defaultSites() {
  return [
    { id: 's4', name: '自社予約サイト', color: '#0ea5e9', enabled: true, own: true, tableIds: ['t1', 't4', 't7'] },
    { id: 's5', name: 'Instagram', color: '#ec4899', enabled: true, tableIds: ['t1', 't2', 't3'] },
    { id: 's6', name: 'Googleマップ', color: '#16a34a', enabled: true, tableIds: ['t2', 't3', 't4'] },
  ];
}
function ownSite() { return (state.sites || []).find((s) => s.own); }
/* ---------- 店舗の切替（店舗ごとに台帳データを分離して保存） ---------- */
function dataKey(id) { return `${LS_KEY}:${id}`; }
function saveRegistry() { localStorage.setItem(LS_REGISTRY, JSON.stringify(registry)); }
function currentStore() { return registry.stores.find((s) => s.id === registry.currentId) || registry.stores[0]; }
function loadRegistry() {
  try { registry = JSON.parse(localStorage.getItem(LS_REGISTRY)); } catch (e) { registry = null; }
  if (!registry || !Array.isArray(registry.stores) || !registry.stores.length) {
    // 初回: 旧形式（単一店舗）のデータがあれば店舗 st1 として引き継ぐ
    const legacy = localStorage.getItem(LS_KEY);
    let name = '';
    if (legacy) {
      try { name = (JSON.parse(legacy).settings || {}).storeName || ''; } catch (e) { /* ignore */ }
      localStorage.setItem(dataKey('st1'), legacy);
      localStorage.removeItem(LS_KEY);
    }
    registry = { stores: [{ id: 'st1', name: name || (legacy ? '店舗1' : DEFAULT_STORE_INFO.storeName) }], currentId: 'st1' };
    saveRegistry();
  }
  if (!registry.stores.some((s) => s.id === registry.currentId)) registry.currentId = registry.stores[0].id;
}
async function switchStore(id) {
  if (!registry.stores.some((s) => s.id === id)) return;
  registry.currentId = id;
  saveRegistry();
  try { await loadState(); } catch (e) { setCloudStatus('error', `${t('cloudLoadError')} ${e.message || ''}`); return; }
  await loadSessionKeys();
  renderAll();
}
function addStore() {
  const input = prompt(t('addStorePrompt'), '');
  if (input == null) { renderStoreSwitch(); return; }
  const name = input.trim() || t('newStoreDefault');
  const id = 's' + Date.now().toString(36);
  registry.stores.push({ id, name });
  registry.currentId = id;
  saveRegistry();
  // 新しい店舗は空の台帳（テーブル・サイト・コース等の初期設定のみ）で開始
  state = defaultState();
  state.reservations = [];
  Object.keys(DEFAULT_STORE_INFO).forEach((k) => { state.settings[k] = ''; });
  state.settings.storeName = name;
  if (cloudMode) { cloudSync.resSnap = new Map(); cloudSync.docSnap = ''; cloudSync.ready = true; subscribeCloud(id); }
  save();
  renderAll();
}
async function deleteStore() {
  if (registry.stores.length <= 1) { alert(t('lastStoreWarn')); return; }
  const cur = currentStore();
  if (!confirm(t('deleteStoreConfirm').replace('{name}', cur.name))) return;
  if (cloudMode) {
    try { await Cloud.deleteStore(cur.id); } catch (e) { alert(`${t('cloudSaveError')} ${e.message || ''}`); return; }
    localStorage.removeItem(secretsKey(cur.id));
  }
  localStorage.removeItem(dataKey(cur.id));
  registry.stores = registry.stores.filter((s) => s.id !== cur.id);
  registry.currentId = registry.stores[0].id;
  saveRegistry();
  document.getElementById('settingsModal').classList.add('hidden');
  await loadState();
  await loadSessionKeys();
  renderAll();
}
function renderStoreSwitch() {
  const sel = document.getElementById('storeSwitch');
  sel.innerHTML = registry.stores.map((s) =>
    `<option value="${esc(s.id)}" ${s.id === registry.currentId ? 'selected' : ''}>${esc(s.name)}</option>`).join('') +
    `<option value="__add">${esc(t('addStoreBtn'))}</option>`;
}

/* 旧データの移行（端末内保存・クラウド共通）。変更があれば true */
function migrateState() {
  let changed = false;
  if (!state.settings) { state.settings = { lang: 'ja', openMin: 11 * 60, closeMin: 23 * 60 }; changed = true; }
  if (!Array.isArray(state.tables)) { state.tables = defaultState().tables; changed = true; }
  if (!Array.isArray(state.reservations)) { state.reservations = []; changed = true; }
  if (!state.sites) { state.sites = defaultSites(); changed = true; }
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
    changed = true;
  }
  if (!state.tablesV2) {
    const defs = { t1: 'ホール', t2: 'ホール', t3: 'ホール', t4: 'ホール', t5: 'カウンター', t6: 'カウンター', t7: '個室' };
    state.tables.forEach((tb) => { if (tb.group === undefined) tb.group = defs[tb.id] || ''; });
    state.tablesV2 = true;
    changed = true;
  }
  if (!state.combos) {
    state.combos = (tableById('t1') && tableById('t2')) ? [{ id: uid(), tableIds: ['t1', 't2'], max: 8 }] : [];
    changed = true;
  }
  if (!state.courses) { state.courses = defaultCourses(); changed = true; }
  if (!state.tags) { state.tags = defaultTags(); changed = true; }
  if (!state.settings.closedDays) { state.settings.closedDays = []; changed = true; }
  if (!state.settings.closedDates) { state.settings.closedDates = []; changed = true; }
  // Google 連携の初期値（未設定のときだけ。意図的に空にした設定は保持）
  if (state.settings.googlePlaceId === undefined && !state.settings.storeName) {
    Object.assign(state.settings, DEFAULT_STORE_INFO);
    const cs = currentStore();
    if (cs && cs.name === '店舗1') { cs.name = DEFAULT_STORE_INFO.storeName; saveRegistry(); }
    changed = true;
  }
  return changed;
}
/* 端末内保存の読み込み */
function load() {
  try {
    const raw = localStorage.getItem(dataKey(registry.currentId));
    if (raw) {
      state = JSON.parse(raw);
      if (migrateState()) save();
      return;
    }
  } catch (e) { /* 壊れたデータは初期化 */ }
  state = defaultState();
  save();
}
function save() {
  if (cloudMode) { saveCloud(); return; }
  localStorage.setItem(dataKey(registry.currentId), JSON.stringify(state));
}

/* ---------- 定休日・顧客照合・席数チェックの共通ヘルパー ---------- */
function isClosedDate(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y) return false;
  const wd = new Date(y, m - 1, d).getDay();
  return (state.settings.closedDays || []).includes(wd) || (state.settings.closedDates || []).includes(date);
}
function normPhone(p) { return String(p || '').replace(/\D/g, ''); }
function isActiveRes(r) { return r.status !== 'cancelled' && r.status !== 'noshow' && r.status !== 'block'; }
/* 未確認のネット予約（今日以降・予約ステータス） */
function newReservations() {
  const today = todayStr();
  return state.reservations.filter((r) => r.isNew && r.status === 'reserved' && r.date >= today);
}
function seatsOf(ids) { return (ids || []).reduce((s, id) => s + (tableById(id)?.seats || 0), 0); }
function overCapacity(res) {
  const pax = (res.adults || 0) + (res.children || 0);
  return (res.tableIds || []).length > 0 && pax > seatsOf(res.tableIds);
}

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

  // 未確認のネット予約バッジ（今日以降の全日程）
  const newCount = newReservations().length;
  const badge = document.getElementById('newBadge');
  badge.classList.toggle('hidden', newCount === 0);
  badge.textContent = dict().fmtNew(newCount);
  renderBackupNote();
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
function courseById(id) { return (state.courses || []).find((c) => c.id === id); }
/* 予約にコースが付いているか（構造化 courses 優先、旧 course 文字列も許容） */
function resHasCourse(r) { return !!(r.courses && r.courses.length) || !!r.course; }
/* コース名の表示文字列（例: MSスタンダードコース×4・マグロ極みコース） */
function resCourseText(r) {
  if (r.courses && r.courses.length) {
    return r.courses.map((c) => {
      const m = courseById(c.courseId);
      if (!m) return '';
      return c.quantity > 1 ? `${m.name}×${c.quantity}` : m.name;
    }).filter(Boolean).join('・');
  }
  return r.course || '';
}
function blockNameHtml(r, visitMap) {
  const pax = (r.adults || 0) + (r.children || 0);
  const visits = visitMap.get(custKey(r)) || 0;
  const chip = visits > 0
    ? `<span class="chip-visit">${esc(dict().fmtVisits(visits))}</span>`
    : `<span class="chip-visit">${esc(t('firstVisit'))}</span>`;
  const courseIco = resHasCourse(r) ? '<span class="b-ico">🍴</span>' : '';
  const site = siteById(r.channel);
  const dot = site ? `<span class="ch-dot" style="background:${safeColor(site.color)}"></span>` : '';
  const newChip = r.isNew ? '<span class="chip-new">NEW</span>' : '';
  return `${newChip}${dot}${esc(r.name)} <span>${esc(dict().fmtPax(pax))}</span> ${chip}${courseIco}`;
}

/* ---------- timetable view ---------- */
function renderTimetable() {
  const { openMin, closeMin } = state.settings;
  // 定休日バナー
  const banner = document.getElementById('closedBanner');
  const closedToday = isClosedDate(currentDate);
  banner.classList.toggle('hidden', !closedToday);
  banner.textContent = closedToday ? t('closedBanner') : '';
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
    if (r.status === 'reserved' && resHasCourse(r)) cls += ' course';
    if (fromTableId === null) cls += ' unassigned';
    if (span) cls += ' span'; // 複数卓を1つの枠として表示（グリッド直下に配置）
    if (r.isNew) cls += ' isnew';
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
    // 予約最小人数を席数と併記。席数＞最小なら「3〜4席」、席数＝最小なら「2名〜2席」形式で明示
    const unit = esc(t('seatsUnit'));
    let seatsText;
    if (tb.min && tb.min > 1 && tb.min < tb.seats) {
      seatsText = `${tb.min}〜${tb.seats} ${unit}`;
    } else if (tb.min && tb.min > 1) {
      seatsText = `${tb.min}${esc(t('guestsUnit'))}〜${tb.seats} ${unit}`;
    } else {
      seatsText = `${tb.seats} ${unit}`;
    }
    label.innerHTML = `<span class="tname">${esc(tb.name)}</span><span class="tseats">${seatsText}</span>`;
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

/* ---------- list view（当日一覧 / 全期間検索 / ステータス絞り込み） ---------- */
function renderListFilters() {
  const wrap = document.getElementById('listFilters');
  const opts = [['all', t('filterAll')], ['new', t('filterNew')], ...STATUSES.map((s) => [s, statusLabel(s)])];
  wrap.innerHTML = opts.map(([v, l]) =>
    `<button type="button" class="fchip${listFilter.status === v ? ' active' : ''}" data-f="${v}">${esc(l)}</button>`).join('');
  wrap.querySelectorAll('.fchip').forEach((b) => {
    b.addEventListener('click', () => { listFilter.status = b.dataset.f; renderList(); });
  });
  const inp = document.getElementById('listSearch');
  if (inp.value !== listFilter.q) inp.value = listFilter.q;
}

function renderList() {
  renderListFilters();
  const wrap = document.getElementById('listWrap');
  const q = listFilter.q.trim().toLowerCase();
  const qDigits = q.replace(/\D/g, '');
  // 検索語あり・未確認フィルタ時は全期間を対象にする
  const global = !!q || listFilter.status === 'new';
  let list;
  if (global) {
    list = state.reservations.filter((r) => r.status !== 'block');
    if (q) {
      list = list.filter((r) =>
        (r.name || '').toLowerCase().includes(q) ||
        (r.kana || '').toLowerCase().includes(q) ||
        (r.reservationName || '').toLowerCase().includes(q) ||
        (qDigits.length >= 3 && normPhone(r.phone).includes(qDigits)));
    }
    list.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.start - b.start);
  } else {
    list = dayReservations(currentDate).filter((r) => r.status !== 'block');
  }
  if (listFilter.status === 'new') list = list.filter((r) => r.isNew);
  else if (listFilter.status !== 'all') list = list.filter((r) => r.status === listFilter.status);

  if (!list.length) {
    wrap.innerHTML = `<div class="empty-note">${esc(global || listFilter.status !== 'all' ? t('noResults') : t('noReservations'))}</div>`;
    return;
  }
  wrap.innerHTML = '';
  const visitMap = buildVisitMap();
  list.forEach((r) => {
    const card = document.createElement('div');
    let cls = 'res-card ' + r.status;
    if (r.status === 'reserved' && resHasCourse(r)) cls += ' course';
    if (r.isNew) cls += ' isnew';
    card.className = cls;
    let quick = '';
    if (r.isNew) quick += `<button class="btn small secondary" data-quick="confirm">${esc(t('confirmBtn'))}</button>`;
    if (r.status === 'reserved') quick += `<button class="btn small primary" data-quick="seated">${esc(t('quickSeat'))}</button>`;
    else if (r.status === 'seated') quick += `<button class="btn small secondary" data-quick="finished">${esc(t('quickFinish'))}</button>`;
    const site = siteById(r.channel);
    card.innerHTML =
      `<div class="rc-time">${global ? `<small class="rc-date">${esc(fmtYmd(r.date))}</small>` : ''}${fmtTime(r.start)}<small>${fmtTime(r.start + r.duration)}</small></div>` +
      `<div class="rc-main">` +
        `<div class="rc-name">${blockNameHtml(r, visitMap)}</div>` +
        `<div class="rc-sub">${esc(tableNames(r.tableIds))}${site ? '　🌐 ' + esc(site.name) : ''}${r.phone ? '　📞 ' + esc(r.phone) : ''}${r.code ? '　🔖 ' + esc(r.code) : ''}${resHasCourse(r) ? '　🍴 ' + esc(resCourseText(r)) : ''}${r.memo ? '　📝 ' + esc(r.memo) : ''}</div>` +
      `</div>` +
      `<div class="rc-actions">${quick}<span class="status-chip ${r.status}">${esc(statusLabel(r.status))}</span></div>`;
    card.addEventListener('click', () => openResModal(r.id));
    card.querySelectorAll('[data-quick]').forEach((qbtn) => {
      qbtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (qbtn.dataset.quick !== 'confirm') r.status = qbtn.dataset.quick;
        r.isNew = false;   // 来店・会計・確認のいずれでも未確認を解除
        save();
        renderAll();
      });
    });
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
    if (!map.has(key)) map.set(key, { key, name: r.name, kana: r.kana, phone: r.phone, company: '', email: '', visits: 0, lastVisit: '' });
    const c = map.get(key);
    if (r.name) c.name = r.name;
    if (r.kana) c.kana = r.kana;
    if (r.company) c.company = r.company;
    if (r.email) c.email = r.email;
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
      (c.phone || '').includes(q) ||
      (c.company || '').toLowerCase().includes(q) ||
      (c.email || '').toLowerCase().includes(q)
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
    `<th>${esc(t('company'))}</th><th>${esc(t('email'))}</th>` +
    `<th>${esc(t('visitCount'))}</th><th>${esc(t('lastVisit'))}</th>` +
    `</tr></thead><tbody>` +
    customers.map((c) =>
      `<tr class="cust-row" data-key="${esc(c.key)}"><td>${esc(c.name)}</td><td>${esc(c.kana || '')}</td><td>${esc(c.phone || '')}</td>` +
      `<td>${esc(c.company || '')}</td><td>${esc(c.email || '')}</td>` +
      `<td class="num">${c.visits} ${esc(t('timesUnit'))}</td><td>${esc(c.lastVisit || '-')}</td></tr>`
    ).join('') +
    `</tbody></table>`;
  // 顧客行タップ → 来店・予約履歴の詳細
  wrap.querySelectorAll('.cust-row').forEach((tr) => {
    tr.addEventListener('click', () => openCustomerDetail(tr.dataset.key));
  });
}

/* ---------- 顧客詳細（来店・予約履歴） ---------- */
function tagNames(ids) {
  return (ids || []).map((id) => { const tg = (state.tags || []).find((x) => x.id === id); return tg ? tg.name : ''; }).filter(Boolean);
}
function genderLabel(g) { return t('genderOptions')[g || 0] || ''; }
function purposeLabel(p) { return p ? (t('purposeOptions')[p - 1] || '') : ''; }
function fmtYmd(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  if (!y) return s;
  const wd = new Date(y, m - 1, d).getDay();
  return dict().fmtDateBox(y, m, d, wd);
}
/* 指定顧客の予約を日付降順で取得（ブロックは除外） */
function customerReservations(key) {
  return state.reservations
    .filter((r) => r.status !== 'block' && custKey(r) === key)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.start - a.start));
}

function openCustomerDetail(key) {
  const list = customerReservations(key);
  if (!list.length) return;
  // 顧客の基本情報（最新の非空値を採用）
  let name = '', kana = '', phone = '', company = '', email = '', gender = 0, resName = '', visits = 0, lastVisit = '';
  list.forEach((r) => {
    if (r.name && !name) name = r.name;
    if (r.kana && !kana) kana = r.kana;
    if (r.phone && !phone) phone = r.phone;
    if (r.company && !company) company = r.company;
    if (r.email && !email) email = r.email;
    if (r.gender && !gender) gender = r.gender;
    if (r.reservationName && !resName) resName = r.reservationName;
    if (r.status === 'seated' || r.status === 'finished') { visits += 1; if (r.date > lastVisit) lastVisit = r.date; }
  });

  document.getElementById('custModalTitle').textContent = name || phone || '';

  const info = [
    [t('nameKana'), kana],
    [t('phone'), phone],
    [t('company'), company],
    [t('reservationName'), resName],
    [t('email'), email],
    [t('gender'), gender ? genderLabel(gender) : ''],
    [t('visitCount'), `${visits} ${t('timesUnit')}`],
    [t('lastVisit'), lastVisit ? fmtYmd(lastVisit) : '-'],
  ];
  document.getElementById('custDetailInfo').innerHTML = info
    .map(([k, v]) => `<div class="cd-item"><span class="cd-k">${esc(k)}</span><span class="cd-v">${esc(v || '-')}</span></div>`).join('');

  document.getElementById('custHistHead').textContent = `${t('visitHistory')}（${list.length}）`;
  document.getElementById('custHistHint').textContent = t('historyHint');

  const hist = document.getElementById('custHistory');
  hist.innerHTML = list.map((r) => {
    const time = `${fmtTime(r.start)}〜${fmtTime(r.start + r.duration)}`;
    const pax = `${(r.adults || 0) + (r.children || 0)}${t('guestsUnit')}`;
    const tbls = tableNames(r.tableIds) || t('unassigned');
    const site = siteById(r.channel);
    const purpose = purposeLabel(r.purpose);
    const course = resCourseText(r);
    const tags = tagNames(r.tags);
    const parts = [`🍽 ${esc(tbls)}`, `👥 ${esc(pax)}`];
    if (site) parts.push(`🌐 ${esc(site.name)}`);
    if (purpose) parts.push(`🎯 ${esc(purpose)}`);
    if (course) parts.push(`🍴 ${esc(course)}`);
    return `<div class="ch-row" data-res="${esc(r.id)}">` +
      `<div class="ch-head"><span class="ch-date">${esc(fmtYmd(r.date))}　${esc(time)}</span>` +
      `<span class="status-chip ${r.status}">${esc(statusLabel(r.status))}</span></div>` +
      `<div class="ch-body">${parts.join('　')}</div>` +
      (tags.length ? `<div class="ch-tags">${tags.map((tg) => `<span class="mini-tag">${esc(tg)}</span>`).join('')}</div>` : '') +
      (r.memo ? `<div class="ch-memo">📝 ${esc(r.memo)}</div>` : '') +
      `</div>`;
  }).join('');
  // 履歴行タップ → その予約を開く
  hist.querySelectorAll('.ch-row').forEach((row) => {
    row.addEventListener('click', () => { closeCustomerDetail(); openResModal(row.dataset.res); });
  });

  document.getElementById('custModal').classList.remove('hidden');
}
function closeCustomerDetail() {
  document.getElementById('custModal').classList.add('hidden');
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
  if (overCapacity(res) && !confirm(t('capacityWarn'))) return;
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
  // 台帳と同じディレクトリの booking.html（GitHub Pages のサブパスや file: でも動くよう相対で組み立てる）
  const base = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '') + 'booking.html';
  const q = `store=${encodeURIComponent(registry.currentId)}` + (siteId ? `&site=${encodeURIComponent(siteId)}` : '');
  return `${base}?${q}`;
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
      `<span class="site-color" style="background:${safeColor(s.color)}"></span>` +
      `<div class="site-main">` +
        `<div class="site-name">${esc(s.name)}</div>` +
        `<div class="site-sub">${esc(t('linkedTables'))}: ${esc(tableNames(s.tableIds))}</div>` +
        `<div class="site-url"><code>${esc(url)}</code></div>` +
      `</div>` +
      `<div class="site-actions">` +
        `<button class="pill ${s.enabled ? 'on' : 'off'}" data-act="toggle">${esc(s.enabled ? t('acceptOn') : t('acceptOff'))}</button>` +
        `<button class="btn primary small" data-act="copy">${esc(t('copyUrl'))}</button>` +
        `<button class="btn ghost small" data-act="edit">${esc(t('editSiteBtn'))}</button>` +
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
    card.querySelector('[data-act="edit"]').addEventListener('click', (e) => {
      e.stopPropagation();
      openSiteModal(s.id);
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
    html += `<tr><th><span class="ch-dot" style="background:${safeColor(s.color)}"></span>${esc(s.name)}</th>`;
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
  renderSiteCombos();
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
      renderSiteCombos();
    });
    wrap.appendChild(chip);
  });
}

/* 結合テーブル（合席）をサイトに連携。選択すると構成卓すべてを連携済みにする */
function renderSiteCombos() {
  const wrap = document.getElementById('sCombos');
  wrap.innerHTML = '';
  const combos = (state.combos || []).filter((c) => c.tableIds.every((id) => tableById(id)));
  if (!combos.length) {
    wrap.innerHTML = `<div class="empty-note">${esc(t('noCombos'))}</div>`;
    return;
  }
  combos.forEach((c) => {
    const active = c.tableIds.every((id) => siteModalTables.has(id));
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (active ? ' active' : '');
    chip.textContent = `${c.tableIds.map((id) => tableById(id).name).join('+')} (〜${c.max}${t('seatsUnit')})`;
    chip.addEventListener('click', () => {
      if (active) c.tableIds.forEach((id) => siteModalTables.delete(id));
      else c.tableIds.forEach((id) => siteModalTables.add(id));
      renderSiteTables();
      renderSiteCombos();
    });
    wrap.appendChild(chip);
  });
}

function closeSiteModal() {
  document.getElementById('siteModal').classList.add('hidden');
  editingSiteId = null;
}

function saveSite() {
  const name = lim(document.getElementById('sName').value.trim(), 60);
  if (!name) { alert(t('siteName')); return; }
  if (!SITE_COLORS.includes(siteModalColor)) siteModalColor = SITE_COLORS[0];
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
  // リセットタイム（0 / 15 / 30分）
  const resetSel = document.getElementById('fReset');
  resetSel.innerHTML = '';
  [0, 15, 30].forEach((m) => {
    const opt = document.createElement('option');
    opt.value = m;
    opt.textContent = `${m} ${t('minutesUnit')}`;
    resetSel.appendChild(opt);
  });
  // 性別（0:不明 / 1:男性 / 2:女性）
  const genSel = document.getElementById('fGender');
  genSel.innerHTML = t('genderOptions')
    .map((label, i) => `<option value="${i}">${esc(label)}</option>`).join('');
  // 利用目的（指定なし + 1〜9）
  const purSel = document.getElementById('fPurpose');
  purSel.innerHTML = `<option value="">${esc(t('purposeNone'))}</option>` +
    t('purposeOptions').map((label, i) => `<option value="${i + 1}">${esc(label)}</option>`).join('');
}

/* コース（reservation_courses）: マスタから選択＋数量。1予約に複数登録可 */
function renderModalCourses() {
  const wrap = document.getElementById('fCourses');
  wrap.innerHTML = '';
  modalCourses.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'course-row';
    const opts = (state.courses || [])
      .map((m) => `<option value="${esc(m.id)}"${m.id === c.courseId ? ' selected' : ''}>${esc(m.name)}</option>`).join('');
    row.innerHTML =
      `<select class="cr-course"><option value="">${esc(t('courseSelect'))}</option>${opts}</select>` +
      `<input type="number" class="cr-qty" min="1" max="99" value="${c.quantity || 1}" title="${esc(t('quantity'))}">` +
      `<button type="button" class="icon-btn cr-del">🗑</button>`;
    row.querySelector('.cr-course').addEventListener('change', (e) => { c.courseId = e.target.value; });
    row.querySelector('.cr-qty').addEventListener('change', (e) => { c.quantity = Math.max(1, Number(e.target.value) || 1); });
    row.querySelector('.cr-del').addEventListener('click', () => { modalCourses.splice(i, 1); renderModalCourses(); });
    wrap.appendChild(row);
  });
}

/* タグ（reservation_tags）: マスタから複数選択（多対多） */
function renderModalTags() {
  const wrap = document.getElementById('fTags');
  wrap.innerHTML = '';
  (state.tags || []).forEach((tg) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (modalTags.has(tg.id) ? ' active' : '');
    chip.textContent = tg.name;
    chip.addEventListener('click', () => {
      if (modalTags.has(tg.id)) modalTags.delete(tg.id); else modalTags.add(tg.id);
      renderModalTags();
    });
    wrap.appendChild(chip);
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
  const base = r || prefill.copy || null;   // 複製時は元予約のお客様情報・内容を引き継ぐ
  modalWalkIn = prefill.walkIn || (r ? !!r.walkIn : false);

  fillTimeSelects();

  document.getElementById('resModalTitle').textContent =
    (r ? t('editResTitle') : (modalWalkIn ? t('walkIn') : t('newResTitle'))) + (r && r.isNew ? '　🆕' : '') + (r && r.code ? `　#${r.code}` : '');
  document.getElementById('fDate').value = r ? r.date : (prefill.date || currentDate);

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

  document.getElementById('fReset').value = base ? (base.resetTime || 0) : 0;
  document.getElementById('fHasLimit').checked = base ? !!base.hasTimeLimit : false;

  document.getElementById('fAdults').textContent = base ? base.adults : (prefill.adults ?? 2);
  document.getElementById('fChildren').textContent = base ? (base.children || 0) : 0;
  document.getElementById('fName').value = base ? base.name : (modalWalkIn ? t('walkInName') : '');
  document.getElementById('fKana').value = base ? (base.kana || '') : '';
  document.getElementById('fPhone').value = base ? (base.phone || '') : '';
  document.getElementById('fGender').value = base ? (base.gender || 0) : 0;
  document.getElementById('fCompany').value = base ? (base.company || '') : '';
  document.getElementById('fResName').value = base ? (base.reservationName || '') : '';
  document.getElementById('fEmail').value = base ? (base.email || '') : '';
  document.getElementById('fPurpose').value = base ? (base.purpose || '') : '';
  document.getElementById('fMemo').value = base ? (base.memo || '') : '';
  document.getElementById('fPhoneHint').classList.add('hidden');

  // コース（構造化）: 旧データの course 文字列があれば移行表示はせず、courses配列を優先
  modalCourses = base && base.courses ? base.courses.map((c) => ({ ...c })) : [];
  renderModalCourses();
  // タグ
  modalTags = new Set(base ? (base.tags || []) : []);
  renderModalTags();

  // 予約経路（店頭・電話＋登録済みサイト）
  const chSel = document.getElementById('fChannel');
  chSel.innerHTML = `<option value="">${esc(t('channelNone'))}</option>` +
    state.sites.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
  chSel.value = base ? (base.channel || '') : (prefill.channel || '');

  modalTables = new Set(r ? r.tableIds : (prefill.tableIds ?? (prefill.tableId ? [prefill.tableId] : [])));
  renderModalTables();

  modalStatus = r ? r.status : (modalWalkIn ? 'seated' : 'reserved');
  const statusRow = document.getElementById('fStatusRow');
  statusRow.classList.toggle('hidden', !r);
  if (r) renderModalStatus();

  document.getElementById('btnResDelete').classList.toggle('hidden', !r);
  document.getElementById('btnResDup').classList.toggle('hidden', !r);
  document.getElementById('resModal').classList.remove('hidden');
}

/* 編集中の予約を元に新規予約を作成（同じお客様の別日予約などに） */
function duplicateReservation() {
  const r = state.reservations.find((x) => x.id === editingId);
  if (!r) return;
  closeResModal();
  openResModal(null, { copy: r, start: r.start, duration: r.duration });
}

/* 電話番号から過去の予約を探し、空欄のお客様情報を自動入力 */
function findCustomerByPhone(phone) {
  const p = normPhone(phone);
  if (p.length < 10) return null;
  return state.reservations
    .filter((r) => r.id !== editingId && r.status !== 'block' && normPhone(r.phone) === p)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] || null;
}
function autofillFromPhone() {
  const hint = document.getElementById('fPhoneHint');
  const src = findCustomerByPhone(document.getElementById('fPhone').value);
  if (!src) { hint.classList.add('hidden'); return; }
  const fill = (id, v) => { const el = document.getElementById(id); if (!el.value.trim() && v) el.value = v; };
  fill('fName', src.name);
  fill('fKana', src.kana);
  fill('fCompany', src.company);
  fill('fResName', src.reservationName);
  fill('fEmail', src.email);
  const g = document.getElementById('fGender');
  if (Number(g.value) === 0 && src.gender) g.value = src.gender;
  const visits = buildVisitMap().get(custKey(src)) || 0;
  hint.textContent = `✓ ${t('autofilled')}（${visits ? dict().fmtVisits(visits) : t('firstVisit')}）`;
  hint.classList.remove('hidden');
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
  const phone = document.getElementById('fPhone').value.trim();
  // 携帯番号かお名前のいずれか必須（CSVのCHECK制約に合わせる）
  if (!name && !phone) { alert(t('nameRequired')); return; }

  const prev = state.reservations.find((x) => x.id === editingId);
  const now = new Date().toISOString();
  const start = Number(document.getElementById('fStart').value);
  const duration = Number(document.getElementById('fDur').value);
  const res = {
    id: editingId || uid(),
    date: document.getElementById('fDate').value || currentDate,
    start,
    duration,
    end: start + duration,                                   // end_time（start + 滞在時間）
    hasTimeLimit: document.getElementById('fHasLimit').checked,
    resetTime: Number(document.getElementById('fReset').value) || 0,
    adults: Number(document.getElementById('fAdults').textContent),
    children: Number(document.getElementById('fChildren').textContent),
    name: lim(name, 100),
    kana: lim(document.getElementById('fKana').value.trim(), 100),
    phone: lim(phone, 40),
    gender: Number(document.getElementById('fGender').value) || 0,
    company: lim(document.getElementById('fCompany').value.trim(), 100),
    reservationName: lim(document.getElementById('fResName').value.trim(), 100),
    email: lim(document.getElementById('fEmail').value.trim(), 200),
    purpose: document.getElementById('fPurpose').value ? Number(document.getElementById('fPurpose').value) : '',
    tableIds: [...modalTables],
    courses: modalCourses.filter((c) => c.courseId).map((c) => ({ courseId: c.courseId, quantity: Math.max(1, c.quantity || 1) })),
    tags: [...modalTags],
    memo: lim(document.getElementById('fMemo').value.trim(), 2000),
    channel: document.getElementById('fChannel').value,
    status: modalStatus,
    walkIn: modalWalkIn,
    createdAt: prev ? (prev.createdAt || now) : now,
    updatedAt: now,
  };

  if (res.tableIds.length && hasConflict(res) && !confirm(t('conflictWarn'))) return;
  if (overCapacity(res) && !confirm(t('capacityWarn'))) return;

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

  // 定休日・臨時休業日
  closedDaysWork = new Set(state.settings.closedDays || []);
  closedDatesWork = [...(state.settings.closedDates || [])];
  renderClosedSettings();
  // コース・タグのマスタ（作業コピー）
  courseWork = (state.courses || []).map((c) => ({ ...c }));
  tagWork = (state.tags || []).map((c) => ({ ...c }));
  renderCourseRows();
  renderMasterRows('tagRows', tagWork);
  // 店舗情報（予約サイトに表示）
  document.getElementById('sStoreName').value = state.settings.storeName || '';
  document.getElementById('sStorePhone').value = state.settings.storePhone || '';
  document.getElementById('sStoreAddress').value = state.settings.storeAddress || '';
  document.getElementById('sStoreNote').value = state.settings.storeNote || '';
  // 店舗詳細（任意項目）の入力欄を生成してから値を反映
  document.getElementById('storeExtraFields').innerHTML = STORE_EXTRA_KEYS.map((k) =>
    `<div class="field"><label>${esc(t('storeExtraLabels')[k] || k)}</label><input type="text" id="${settingInputId(k)}"></div>`).join('');
  STORE_TEXT_KEYS.forEach((k) => { document.getElementById(settingInputId(k)).value = state.settings[k] || ''; });
  document.getElementById('sClaudeApiKey').value = getClaudeKey();
  document.getElementById('sClaudeApiKey').type = 'password';
  document.getElementById('sClaudeShow').checked = false;
  document.getElementById('sGoogleApiKey').type = 'password';
  document.getElementById('sGoogleShow').checked = false;
  document.getElementById('sAiDailyLimit').value = state.settings.aiDailyLimit || 50;
  renderLockSettings();

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
      `<label>${esc(t('comboMin'))}</label>` +
      `<input type="number" class="cf-min" min="1" max="99" value="${c.min || 1}">` +
      `<label>${esc(t('comboMax'))}</label>` +
      `<input type="number" class="cf-max" min="1" max="99" value="${c.max || 0}">` +
      `<button type="button" class="icon-btn">🗑</button>`;
    foot.querySelector('.cf-min').addEventListener('change', (e) => { c.min = Math.max(1, Number(e.target.value) || 1); });
    foot.querySelector('.cf-max').addEventListener('change', (e) => { c.max = Math.max(1, Number(e.target.value) || 1); });
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
    `<input type="number" class="tr-min" min="1" max="99" value="${tb ? (tb.min || 1) : 1}">` +
    `<button type="button" class="icon-btn tr-del">🗑</button>`;
  row.querySelector('.tr-del').addEventListener('click', () => row.remove());
  wrap.appendChild(row);
}

async function saveSettings() {
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
    const min = Math.min(seats, Math.max(1, Number(row.querySelector('.tr-min').value) || 1));
    const group = row.querySelector('.tr-group').value.trim();
    tables.push({ id: row.dataset.id || uid(), name, seats, min, group });
  });
  if (tables.length) state.tables = tables;
  // 結合設定を保存（存在するテーブル2卓以上のみ有効）
  state.combos = comboWork
    .map((c) => ({
      ...c,
      tableIds: c.tableIds.filter((id) => state.tables.some((tb) => tb.id === id)),
      min: Math.min(Math.max(1, c.min || 1), c.max || 1),
    }))
    .filter((c) => c.tableIds.length >= 2 && (c.max || 0) >= 1);
  // 定休日・臨時休業日
  state.settings.closedDays = [...closedDaysWork].sort((a, b) => a - b);
  state.settings.closedDates = [...new Set(closedDatesWork)].sort();
  // 店舗情報
  state.settings.storeName = document.getElementById('sStoreName').value.trim();
  if (state.settings.storeName) { currentStore().name = state.settings.storeName; saveRegistry(); }
  state.settings.storePhone = document.getElementById('sStorePhone').value.trim();
  state.settings.storeAddress = document.getElementById('sStoreAddress').value.trim();
  state.settings.storeNote = document.getElementById('sStoreNote').value.trim();
  STORE_TEXT_KEYS.forEach((k) => { state.settings[k] = document.getElementById(settingInputId(k)).value.trim(); });
  state.settings.aiDailyLimit = Math.max(1, Math.min(1000, Number(document.getElementById('sAiDailyLimit').value) || 50));
  // Claude API キー: ロック有効時は暗号化して保存し、平文は残さない
  if (lockEnabled() && lockState.cryptoKey) {
    const plain = state.settings.claudeApiKey;
    sessionKeys.claude = plain;
    state.settings.claudeApiKeyEnc = plain ? await encryptStr(lockState.cryptoKey, plain) : '';
    state.settings.claudeApiKey = '';
  } else {
    state.settings.claudeApiKeyEnc = '';
    sessionKeys.claude = state.settings.claudeApiKey;
  }
  // コース・タグのマスタ（空名は除外）
  state.courses = courseWork.filter((c) => c.name.trim()).map((c) => ({ id: c.id, name: c.name.trim(), price: (c.price || '').trim(), desc: (c.desc || '').trim() }));
  state.tags = tagWork.filter((c) => c.name.trim()).map((c) => ({ id: c.id, name: c.name.trim() }));
  save();
  document.getElementById('settingsModal').classList.add('hidden');
  renderAll();
}

/* ---------- クラウド保存（Supabase）: 台帳側 ----------
 * config.js に接続先があるときだけ有効（cloudMode）。設定類は stores.doc、予約は reservations 行として保存し、
 * 他端末・予約サイトからの変更はリアルタイムで反映する。秘密情報（Claude キー）はクラウドへ送らず端末内のみ。 */
const cloudSync = { resSnap: new Map(), docSnap: '', queue: Promise.resolve(), unsubscribe: null, reloadTimer: null, saving: 0, ready: false, ignoreLocal: false };
const SECRET_KEYS = ['claudeApiKey', 'claudeApiKeyEnc'];
function secretsKey(id) { return `yoyaku-secrets:${id}`; }
function secretsGet(id) { try { return JSON.parse(localStorage.getItem(secretsKey(id))) || {}; } catch (e) { return {}; } }
function secretsSet(id, obj) { localStorage.setItem(secretsKey(id), JSON.stringify(obj)); }
/* クラウドに保存する設定 JSON（予約と秘密情報を除く） */
function docOf(st) {
  const doc = JSON.parse(JSON.stringify(st));
  delete doc.reservations;
  if (doc.settings) SECRET_KEYS.forEach((k) => { delete doc.settings[k]; });
  return doc;
}
function setCloudStatus(kind, msg) {
  const el = document.getElementById('cloudStatus');
  if (!el) return;
  el.className = 'cloud-status ' + kind;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}
function showAuth(show, msg) {
  document.getElementById('authScreen').classList.toggle('hidden', !show);
  document.getElementById('authMsg').textContent = msg || '';
  if (show) setTimeout(() => document.getElementById('authEmail').focus(), 50);
}
async function loadState() { if (cloudMode) await loadCloud(); else load(); }

async function loadCloud() {
  const id = registry.currentId;
  const { store, reservations } = await Cloud.loadStore(id);
  if (!store) {
    // クラウドに無い店舗: 端末内のデータがあればそれを移行、無ければ初期状態で作成
    let parsed = null;
    if (!cloudSync.ignoreLocal) { try { parsed = JSON.parse(localStorage.getItem(dataKey(id))); } catch (e) { parsed = null; } }
    state = parsed || defaultState();
    if (!parsed) state.reservations = [];
    migrateState();
    await Cloud.saveDoc(id, currentStore().name, docOf(state));
    await Cloud.upsertReservations(id, state.reservations);
  } else {
    state = Object.assign({}, store.doc, { reservations: reservations || [] });
    if (migrateState()) await Cloud.saveDoc(id, store.name || currentStore().name, docOf(state));
  }
  Object.assign(state.settings, secretsGet(id));
  cloudSync.resSnap = new Map(state.reservations.map((r) => [r.id, JSON.stringify(r)]));
  cloudSync.docSnap = JSON.stringify(docOf(state));
  cloudSync.ready = true;
  subscribeCloud(id);
}

/* 変更分だけをクラウドへ書き込む（予約は行単位の差分、設定は JSON 全体） */
function saveCloud() {
  if (!cloudSync.ready) return;
  const id = registry.currentId;
  secretsSet(id, { claudeApiKey: state.settings.claudeApiKey || '', claudeApiKeyEnc: state.settings.claudeApiKeyEnc || '' });
  const cur = new Map(state.reservations.map((r) => [r.id, JSON.stringify(r)]));
  const changed = state.reservations.filter((r) => cloudSync.resSnap.get(r.id) !== cur.get(r.id)).map((r) => JSON.parse(JSON.stringify(r)));
  const removed = [...cloudSync.resSnap.keys()].filter((k) => !cur.has(k));
  const docNow = JSON.stringify(docOf(state));
  const docChanged = docNow !== cloudSync.docSnap;
  cloudSync.resSnap = cur;
  cloudSync.docSnap = docNow;
  if (!changed.length && !removed.length && !docChanged) return;
  const name = currentStore().name;
  cloudSync.saving += 1;
  cloudSync.queue = cloudSync.queue.then(async () => {
    try {
      if (docChanged) await Cloud.saveDoc(id, name, JSON.parse(docNow));
      if (changed.length) await Cloud.upsertReservations(id, changed);
      if (removed.length) await Cloud.deleteReservations(removed);
      setCloudStatus('ok', '');
    } catch (e) {
      setCloudStatus('error', `${t('cloudSaveError')} ${e.message || ''}`);
      // 失敗分は次回の保存で再送されるようにスナップショットを戻す
      changed.forEach((r) => cloudSync.resSnap.delete(r.id));
      if (docChanged) cloudSync.docSnap = '';
    } finally {
      cloudSync.saving -= 1;
    }
  });
}
function subscribeCloud(id) {
  if (cloudSync.unsubscribe) { try { cloudSync.unsubscribe(); } catch (e) { /* ignore */ } }
  cloudSync.unsubscribe = Cloud.subscribe(id, () => {
    clearTimeout(cloudSync.reloadTimer);
    cloudSync.reloadTimer = setTimeout(reloadFromCloud, 400);
  });
}
/* 他端末・予約サイトの変更を取り込む */
async function reloadFromCloud() {
  if (!cloudMode || !cloudSync.ready) return;
  if (cloudSync.saving > 0) { cloudSync.reloadTimer = setTimeout(reloadFromCloud, 500); return; }
  const id = registry.currentId;
  try {
    const { store, reservations } = await Cloud.loadStore(id);
    if (!store) return;
    const secrets = {};
    SECRET_KEYS.forEach((k) => { secrets[k] = state.settings[k]; });
    state = Object.assign({}, store.doc, { reservations: reservations || [] });
    migrateState();
    Object.assign(state.settings, secrets);
    cloudSync.resSnap = new Map(state.reservations.map((r) => [r.id, JSON.stringify(r)]));
    cloudSync.docSnap = JSON.stringify(docOf(state));
    if (store.name && currentStore().name !== store.name) { currentStore().name = store.name; saveRegistry(); }
    renderAll();
  } catch (e) {
    setCloudStatus('error', `${t('cloudLoadError')} ${e.message || ''}`);
  }
}
/* 店舗一覧をクラウドから。クラウドが空なら端末内データの移行を確認 */
async function syncStoresFromCloud() {
  const list = await Cloud.listStores();
  if (list.length) {
    registry.stores = list.map((s) => ({ id: s.id, name: s.name || s.id }));
  } else {
    const localStores = registry.stores.filter((s) => localStorage.getItem(dataKey(s.id)));
    if (localStores.length && confirm(t('cloudMigrateConfirm'))) {
      for (const s of localStores) {
        let data = null;
        try { data = JSON.parse(localStorage.getItem(dataKey(s.id))); } catch (e) { data = null; }
        if (!data) continue;
        await Cloud.saveDoc(s.id, s.name, docOf(data));
        await Cloud.upsertReservations(s.id, data.reservations || []);
        secretsSet(s.id, { claudeApiKey: (data.settings || {}).claudeApiKey || '', claudeApiKeyEnc: (data.settings || {}).claudeApiKeyEnc || '' });
      }
      registry.stores = localStores.map((s) => ({ id: s.id, name: s.name }));
    } else {
      cloudSync.ignoreLocal = true;
      registry.stores = [{ id: 'st1', name: DEFAULT_STORE_INFO.storeName }];
    }
  }
  if (!registry.stores.some((s) => s.id === registry.currentId)) registry.currentId = registry.stores[0].id;
  saveRegistry();
}
async function afterLogin(sessionObj) {
  try {
    setCloudStatus('info', t('cloudLoading'));
    await syncStoresFromCloud();
    await loadCloud();
    await loadSessionKeys();
    showAuth(false);
    setCloudStatus('ok', '');
    const who = document.getElementById('cloudUser');
    if (who) who.textContent = t('cloudSignedInAs').replace('{email}', (sessionObj && sessionObj.user && sessionObj.user.email) || '');
    renderAll();
  } catch (e) {
    setCloudStatus('error', `${t('cloudLoadError')} ${e.message || ''}`);
  }
}
async function doSignIn() {
  const email = document.getElementById('authEmail').value.trim();
  const pw = document.getElementById('authPassword').value;
  const btn = document.getElementById('btnSignIn');
  if (!email || !pw) return;
  btn.disabled = true;
  try {
    const s = await Cloud.signIn(email, pw);
    document.getElementById('authPassword').value = '';
    await afterLogin(s);
  } catch (e) {
    showAuth(true, `${t('authError')} ${e.message || ''}`);
  } finally {
    btn.disabled = false;
  }
}
async function doSignOut() {
  document.getElementById('settingsModal').classList.add('hidden');
  await Cloud.signOut();
  cloudSync.ready = false;
  if (cloudSync.unsubscribe) { try { cloudSync.unsubscribe(); } catch (e) { /* ignore */ } cloudSync.unsubscribe = null; }
  state = defaultState();
  state.reservations = [];
  renderAll();
  showAuth(true);
}

/* ---------- 端末ロック（PIN）と API キーの保護 ----------
 * PIN は塩付き SHA-256 で店舗共通の registry に保存。Claude API キーは PIN から PBKDF2 で導出した鍵（AES-GCM）で
 * 暗号化して保存し、ロック解除中だけメモリ上で保持する。（Google のキーは予約サイト側でも必要なため平文のまま。
 * 参照元ドメインと API の制限で保護する） */
const lockState = { locked: false, cryptoKey: null, fails: 0, lockedUntil: 0, lastActivity: Date.now() };
const sessionKeys = { claude: '' };
const textEnc = new TextEncoder();
const textDec = new TextDecoder();
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function unb64(s) { return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
async function sha256Hex(str) {
  const h = await crypto.subtle.digest('SHA-256', textEnc.encode(str));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function deriveKey(pin, saltB64) {
  const km = await crypto.subtle.importKey('raw', textEnc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: unb64(saltB64), iterations: 150000, hash: 'SHA-256' }, km,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encryptStr(key, str) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, textEnc.encode(str));
  return `${b64(iv)}.${b64(ct)}`;
}
async function decryptStr(key, packed) {
  const [ivs, cts] = String(packed).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivs) }, key, unb64(cts));
  return textDec.decode(pt);
}
function lockConfig() { return (registry && registry.lock) || null; }
function lockEnabled() { return !!lockConfig(); }
/* 使用する Claude API キー（暗号化保存時はロック解除中のメモリ上の値） */
function getClaudeKey() { return (sessionKeys.claude || state.settings.claudeApiKey || '').trim(); }

/* 全店舗の Claude キーを（旧鍵で復号 →）新鍵で暗号化、または平文に戻す */
async function reencryptKeysAllStores(oldKey, newKey) {
  if (cloudMode) {
    for (const s of registry.stores) {
      const sec = secretsGet(s.id);
      let plain = sec.claudeApiKey || '';
      if (sec.claudeApiKeyEnc && oldKey) { try { plain = await decryptStr(oldKey, sec.claudeApiKeyEnc); } catch (e) { plain = ''; } }
      secretsSet(s.id, newKey ? { claudeApiKey: '', claudeApiKeyEnc: plain ? await encryptStr(newKey, plain) : '' } : { claudeApiKey: plain, claudeApiKeyEnc: '' });
    }
    Object.assign(state.settings, secretsGet(registry.currentId));
    await loadSessionKeys();
    return;
  }
  for (const s of registry.stores) {
    const raw = localStorage.getItem(dataKey(s.id));
    if (!raw) continue;
    let data;
    try { data = JSON.parse(raw); } catch (e) { continue; }
    const st = data.settings || (data.settings = {});
    let plain = st.claudeApiKey || '';
    if (st.claudeApiKeyEnc && oldKey) { try { plain = await decryptStr(oldKey, st.claudeApiKeyEnc); } catch (e) { plain = ''; } }
    if (newKey) { st.claudeApiKeyEnc = plain ? await encryptStr(newKey, plain) : ''; st.claudeApiKey = ''; }
    else { st.claudeApiKey = plain; st.claudeApiKeyEnc = ''; }
    localStorage.setItem(dataKey(s.id), JSON.stringify(data));
  }
  load();
  await loadSessionKeys();
}
async function loadSessionKeys() {
  sessionKeys.claude = '';
  if (state.settings.claudeApiKeyEnc && lockState.cryptoKey) {
    try { sessionKeys.claude = await decryptStr(lockState.cryptoKey, state.settings.claudeApiKeyEnc); } catch (e) { sessionKeys.claude = ''; }
  }
}
async function setPin(pin, minutes) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await sha256Hex(`${salt}:${pin}`);
  const newKey = await deriveKey(pin, salt);
  const oldKey = lockState.cryptoKey;
  registry.lock = { salt, hash, minutes: Number(minutes) || 0 };
  saveRegistry();
  lockState.cryptoKey = newKey;
  await reencryptKeysAllStores(oldKey, newKey);
}
async function clearPin() {
  const oldKey = lockState.cryptoKey;
  registry.lock = null;
  saveRegistry();
  lockState.cryptoKey = null;
  await reencryptKeysAllStores(oldKey, null);
}
function lockApp() {
  if (!lockEnabled() || lockState.locked) return;
  lockState.locked = true;
  sessionKeys.claude = '';
  lockState.cryptoKey = null;
  closeCellPopover();
  document.getElementById('lockScreen').classList.remove('hidden');
  document.getElementById('lockMsg').textContent = '';
  const inp = document.getElementById('lockPin');
  inp.value = '';
  setTimeout(() => inp.focus(), 50);
}
async function tryUnlock() {
  const inp = document.getElementById('lockPin');
  const msg = document.getElementById('lockMsg');
  const now = Date.now();
  if (now < lockState.lockedUntil) { msg.textContent = t('lockWait').replace('{sec}', Math.ceil((lockState.lockedUntil - now) / 1000)); return; }
  const pin = inp.value.trim();
  const c = lockConfig();
  if (!c || !pin) return;
  if ((await sha256Hex(`${c.salt}:${pin}`)) !== c.hash) {
    lockState.fails += 1;
    inp.value = '';
    if (lockState.fails >= 5) {
      // 5回以上の失敗で待ち時間（30秒 × 超過回数、最大4分）
      lockState.lockedUntil = now + 30000 * Math.min(8, lockState.fails - 4);
      msg.textContent = t('lockWait').replace('{sec}', Math.ceil((lockState.lockedUntil - now) / 1000));
    } else {
      msg.textContent = t('lockWrong');
    }
    return;
  }
  lockState.fails = 0;
  lockState.cryptoKey = await deriveKey(pin, c.salt);
  await loadSessionKeys();
  lockState.locked = false;
  lockState.lastActivity = Date.now();
  document.getElementById('lockScreen').classList.add('hidden');
  inp.value = '';
  renderAll();
}
function touchActivity() { lockState.lastActivity = Date.now(); }
function checkAutoLock() {
  const c = lockConfig();
  if (!c || lockState.locked || !c.minutes) return;
  if (Date.now() - lockState.lastActivity > c.minutes * 60000) lockApp();
}
/* 設定画面: ロック設定 */
function renderLockSettings() {
  const c = lockConfig();
  document.getElementById('lockStatus').textContent = c
    ? t('lockOn').replace('{min}', c.minutes ? `${c.minutes}${t('minutesUnit')}` : t('lockNever'))
    : t('lockOff');
  document.getElementById('btnLockClear').classList.toggle('hidden', !c);
  document.getElementById('sLockMinutes').value = c ? String(c.minutes) : '10';
  document.getElementById('sLockPin').value = '';
  document.getElementById('sLockPin2').value = '';
}
async function saveLockSettings() {
  const pin = document.getElementById('sLockPin').value.trim();
  const pin2 = document.getElementById('sLockPin2').value.trim();
  const minutes = Number(document.getElementById('sLockMinutes').value) || 0;
  const c = lockConfig();
  if (!pin && c) { c.minutes = minutes; saveRegistry(); renderLockSettings(); alert(t('lockUpdated')); return; }
  if (!/^\d{4,8}$/.test(pin)) { alert(t('lockPinFormat')); return; }
  if (pin !== pin2) { alert(t('lockPinMismatch')); return; }
  await setPin(pin, minutes);
  renderLockSettings();
  alert(t('lockSet'));
}
async function removeLock() {
  if (!confirm(t('lockClearConfirm'))) return;
  await clearPin();
  renderLockSettings();
}

/* ---------- バックアップの催促（7日以上未保存なら上部に表示） ---------- */
function renderBackupNote() {
  const bn = document.getElementById('backupNote');
  const days = registry.lastBackupAt ? (Date.now() - registry.lastBackupAt) / 86400000 : Infinity;
  const show = state.reservations.length > 0 && days > 7 && registry.backupDismissed !== todayStr();
  bn.classList.toggle('hidden', !show);
  if (show) {
    document.getElementById('backupNoteText').textContent = registry.lastBackupAt
      ? t('backupOld').replace('{d}', String(Math.floor(days)))
      : t('backupNever');
  }
}

/* ---------- チャットへの画像貼り付け（DMのスクリーンショット → 予約内容の読み取り） ----------
 * Claude の Messages API（画像入力）で、スクリーンショットから日時・人数・お名前・電話番号・コース・ご要望を抽出し、
 * 予約フォームに反映して担当者が確認・登録する。API キーは店舗設定に保存（ブラウザから直接呼び出し）。 */
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-opus-5';
const MAX_IMAGE_PX = 1600;   // 送信前に長辺を縮小（トークン節約）

function chatAppendNode(role, node) {
  const log = document.getElementById('chatLog');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.appendChild(node);
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

/* 画像ファイルを縮小した JPEG の dataURL にする */
function fileToJpegDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, MAX_IMAGE_PX / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    img.src = url;
  });
}

/* 抽出 JSON のスキーマ（構造化出力） */
const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    found: { type: 'boolean' },
    date: { type: ['string', 'null'] },
    time: { type: ['string', 'null'] },
    adults: { type: ['integer', 'null'] },
    children: { type: ['integer', 'null'] },
    name: { type: ['string', 'null'] },
    kana: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
    course: { type: ['string', 'null'] },
    memo: { type: ['string', 'null'] },
    channel: { type: ['string', 'null'] },
    missing: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
  },
  required: ['found', 'date', 'time', 'adults', 'children', 'name', 'kana', 'phone', 'course', 'memo', 'channel', 'missing', 'notes'],
};

function extractSystemPrompt() {
  const today = todayStr();
  const wd = dict().weekdays[new Date().getDay()];
  const courses = (state.courses || []).map((c) => c.name).join(' / ') || 'なし';
  return `あなたは飲食店「${state.settings.storeName || ''}」の予約台帳アシスタントです。` +
    `お客様とのDM（Instagram・LINE・メール等）のスクリーンショットから、予約に必要な情報を読み取り、指定のJSONだけを返してください。\n` +
    `今日は ${today}（${wd}曜日）です。「明日」「来週金曜」などの相対表現は今日を基準に YYYY-MM-DD に変換してください。年が書かれていない日付は、今日以降で最も近い日付にしてください。\n` +
    `営業時間は ${fmtTime(state.settings.openMin)}〜${fmtTime(state.settings.closeMin)}。時間は 24時間表記の HH:MM（例 19:00）。「夜7時」は 19:00 です。\n` +
    `人数は大人と子供に分け、区別が無ければ全員を adults にしてください。コースは店舗のコース名（${courses}）に一致する場合のみその名前を、無ければ null。\n` +
    `memo にはアレルギー・席の希望・お祝い等の要望を短くまとめ、channel には DM の媒体名（Instagram / LINE / メール 等、不明なら null）。\n` +
    `読み取れない項目は null にし、missing に項目名（date/time/adults/name/phone）を列挙。notes には判断の根拠や不確かな点を日本語で1〜2文。\n` +
    `予約に関する情報が含まれない画像なら found を false にしてください。`;
}

async function callClaudeExtract(dataUrl, hintText, withSchema) {
  const key = getClaudeKey();
  const base64 = dataUrl.split(',')[1];
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 2048,
    fallbacks: 'default',
    system: extractSystemPrompt(),
    output_config: { effort: 'medium' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: (hintText ? `補足: ${hintText}\n` : '') + 'このスクリーンショットから予約情報を読み取って、JSONで返してください。' },
      ],
    }],
  };
  if (withSchema) body.output_config.format = { type: 'json_schema', schema: EXTRACT_SCHEMA };
  const res = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const e = await res.json(); msg = (e.error && e.error.message) || msg; } catch (err) { /* ignore */ }
    const error = new Error(msg);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

/* スクリーンショット → 予約情報（構造化出力が使えない環境では本文のJSONを解析） */
async function extractReservationFromImage(dataUrl, hintText) {
  let data;
  try {
    data = await callClaudeExtract(dataUrl, hintText, true);
  } catch (e) {
    if (e.status === 400) data = await callClaudeExtract(dataUrl, hintText, false);
    else throw e;
  }
  if (data.stop_reason === 'refusal') throw new Error(t('aiRefused'));
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(t('aiNoJson'));
  return JSON.parse(m[0]);
}

/* 抽出結果を予約フォームの初期値に変換 */
function extractionToPrefill(info) {
  const [h, mi] = String(info.time || '').split(':').map(Number);
  const start = Number.isFinite(h) ? clamp(h * 60 + (mi || 0), state.settings.openMin, state.settings.closeMin - 15) : undefined;
  const course = info.course ? (state.courses || []).find((c) => c.name === info.course || c.name.includes(info.course) || info.course.includes(c.name)) : null;
  const adults = Math.max(1, Number(info.adults) || 0) || 2;
  const ch = String(info.channel || '').toLowerCase();
  const site = ch ? (state.sites || []).find((s) => s.name.toLowerCase().includes(ch) || ch.includes(s.name.toLowerCase())) : null;
  return {
    date: /^\d{4}-\d{2}-\d{2}$/.test(info.date || '') ? info.date : undefined,
    start,
    adults,
    channel: site ? site.id : '',
    copy: {
      name: info.name || '',
      kana: info.kana || '',
      phone: info.phone || '',
      memo: [info.memo || '', info.channel ? `（${info.channel} のDMより）` : ''].filter(Boolean).join(' '),
      adults,
      children: Math.max(0, Number(info.children) || 0),
      courses: course ? [{ courseId: course.id, quantity: adults + (Number(info.children) || 0) }] : [],
      channel: site ? site.id : '',
      tags: [],
      resetTime: 0,
      hasTimeLimit: false,
    },
  };
}

function renderExtraction(info, hintText) {
  const card = document.createElement('div');
  card.className = 'ai-card';
  if (!info || info.found === false) {
    card.innerHTML = `<div class="ai-title">${esc(t('aiResult'))}</div><div>${esc(t('aiNotFound'))}</div>` +
      (info && info.notes ? `<div class="ai-notes">${esc(info.notes)}</div>` : '');
    chatAppendNode('bot', card);
    return;
  }
  const pax = `${info.adults != null ? dict().fmtPax(info.adults) : '—'}${info.children ? `（${t('children')} ${info.children}）` : ''}`;
  const rows = [
    [t('date'), info.date ? fmtYmd(info.date) : '—'],
    [t('startTime'), info.time || '—'],
    [t('adults'), pax],
    [t('name'), info.name || '—'],
    [t('phone'), info.phone || '—'],
    [t('course'), info.course || '—'],
    [t('memo'), info.memo || '—'],
    [t('channel'), info.channel || '—'],
  ];
  const missing = (info.missing || []).map((k) => ({ date: t('date'), time: t('startTime'), adults: t('adults'), name: t('name'), phone: t('phone') }[k] || k));
  card.innerHTML =
    `<div class="ai-title">📋 ${esc(t('aiResult'))}</div>` +
    `<table class="ai-table">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</table>` +
    (missing.length ? `<div class="ai-missing">⚠ ${esc(t('aiMissing'))}: ${esc(missing.join('・'))}</div>` : '') +
    (info.notes ? `<div class="ai-notes">${esc(info.notes)}</div>` : '') +
    `<button type="button" class="btn primary small ai-open">${esc(t('aiOpenForm'))}</button>`;
  card.querySelector('.ai-open').addEventListener('click', () => {
    const p = extractionToPrefill(info);
    if (p.date) { currentDate = p.date; }
    openResModal(null, p);
  });
  chatAppendNode('bot', card);
}

/* 画像の受け取り（添付ボタン・貼り付け・ドロップ共通） */
async function chatHandleImages(files, hintText) {
  const list = [...files].filter((f) => f && f.type && f.type.startsWith('image/')).slice(0, 3);
  if (!list.length) return;
  for (const file of list) {
    let dataUrl;
    try { dataUrl = await fileToJpegDataUrl(file); } catch (e) { chatAppend('bot', t('aiError') + ' ' + t('aiBadImage')); continue; }
    const img = document.createElement('img');
    img.className = 'chat-img';
    img.src = dataUrl;
    img.alt = 'screenshot';
    const wrap = document.createElement('div');
    wrap.appendChild(img);
    if (hintText) { const p = document.createElement('div'); p.textContent = hintText; wrap.appendChild(p); }
    chatAppendNode('user', wrap);

    if (!getClaudeKey()) { chatAppend('bot', t('aiNeedKey')); continue; }
    // 1日あたりの読み取り回数の上限（キーの悪用・誤操作による費用の上振れ防止）
    const today = todayStr();
    registry.ai = registry.ai && registry.ai.date === today ? registry.ai : { date: today, count: 0 };
    const limit = Math.max(1, Number(state.settings.aiDailyLimit) || 50);
    if (registry.ai.count >= limit) { chatAppend('bot', t('aiLimitReached').replace('{n}', String(limit))); continue; }
    registry.ai.count += 1;
    saveRegistry();
    const waiting = chatAppend('bot', t('aiReading'));
    try {
      const info = await extractReservationFromImage(dataUrl, hintText);
      waiting.remove();
      renderExtraction(info, hintText);
    } catch (e) {
      waiting.textContent = `${t('aiError')} ${e.message || ''}`;
    }
  }
}

/* ---------- チャット操作（ルールベースの日本語/ベトナム語コマンド解析） ---------- */
function chatAppend(role, text) {
  const log = document.getElementById('chatLog');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  return div;
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

/* ---------- 月間カレンダー（日別の組数・人数、定休日、未確認ネット予約） ---------- */
function renderCalendar() {
  if (!calMonth) {
    const [y, m] = currentDate.split('-').map(Number);
    calMonth = { y, m };
  }
  const { y, m } = calMonth;
  document.getElementById('calTitle').textContent = dict().fmtMonth(y, m);
  const firstDow = new Date(y, m - 1, 1).getDay();
  const daysInMonth = new Date(y, m, 0).getDate();
  const prefix = `${y}-${pad2(m)}-`;

  const counts = new Map();
  state.reservations.forEach((r) => {
    if (!isActiveRes(r) || !String(r.date).startsWith(prefix)) return;
    const c = counts.get(r.date) || { groups: 0, pax: 0, isNew: 0 };
    c.groups += 1;
    c.pax += (r.adults || 0) + (r.children || 0);
    if (r.isNew) c.isNew += 1;
    counts.set(r.date, c);
  });

  const today = todayStr();
  let html = '<div class="cal-grid">' +
    dict().weekdays.map((w, i) => `<div class="cal-wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${esc(w)}</div>`).join('');
  for (let i = 0; i < firstDow; i++) html += '<div class="cal-cell empty"></div>';
  for (let d = 1; d <= daysInMonth; d++) {
    const date = prefix + pad2(d);
    const dow = (firstDow + d - 1) % 7;
    const c = counts.get(date);
    const closed = isClosedDate(date);
    let cls = 'cal-cell';
    if (date === today) cls += ' today';
    if (date === currentDate) cls += ' selected';
    if (closed) cls += ' closed';
    if (dow === 0) cls += ' sun';
    if (dow === 6) cls += ' sat';
    html += `<div class="${cls}" data-date="${date}">` +
      `<div class="cal-day">${d}` +
        (closed ? `<span class="cal-closed">${esc(t('closedShort'))}</span>` : '') +
        (c && c.isNew ? `<span class="chip-new">${c.isNew}</span>` : '') +
      `</div>` +
      (c ? `<div class="cal-count">${c.groups}${esc(t('groupsUnit'))}</div><div class="cal-pax">${c.pax}${esc(t('guestsUnit'))}</div>` : '') +
      `</div>`;
  }
  html += '</div>';
  const wrap = document.getElementById('calWrap');
  wrap.innerHTML = html;
  // 日付タップ → その日のタイムラインへ
  wrap.querySelectorAll('.cal-cell[data-date]').forEach((el) => {
    el.addEventListener('click', () => { currentDate = el.dataset.date; setView('timetable'); });
  });
}

function shiftCalMonth(n) {
  if (!calMonth) renderCalendar();
  let { y, m } = calMonth;
  m += n;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  calMonth = { y, m };
  renderCalendar();
}

/* ---------- 設定モーダル: 定休日・臨時休業日 ---------- */
function renderClosedSettings() {
  const wd = document.getElementById('sClosedDays');
  wd.innerHTML = '';
  dict().weekdays.forEach((w, i) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (closedDaysWork.has(i) ? ' active' : '');
    chip.textContent = w;
    chip.addEventListener('click', () => {
      if (closedDaysWork.has(i)) closedDaysWork.delete(i); else closedDaysWork.add(i);
      renderClosedSettings();
    });
    wd.appendChild(chip);
  });
  const dw = document.getElementById('sClosedDates');
  dw.innerHTML = '';
  [...closedDatesWork].sort().forEach((d) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip active';
    chip.textContent = `${fmtYmd(d)} ✕`;
    chip.addEventListener('click', () => {
      closedDatesWork = closedDatesWork.filter((x) => x !== d);
      renderClosedSettings();
    });
    dw.appendChild(chip);
  });
}

/* ---------- 設定モーダル: 「Googleマップから取得」— 店名やリンクから店舗を検索して Place ID を設定 ---------- */
function parseGoogleQuery(q) {
  const s = String(q || '').trim();
  const pid = s.match(/place_id[:=]([A-Za-z0-9_-]{10,})/) || s.match(/\b(ChIJ[A-Za-z0-9_-]{10,})\b/);
  if (pid) return { placeId: pid[1] };
  const m = s.match(/\/maps\/place\/([^/?#]+)/) || s.match(/[?&]q(?:uery)?=([^&#]+)/);
  if (m) { try { return { text: decodeURIComponent(m[1].replace(/\+/g, ' ')) }; } catch (e) { return { text: m[1] }; } }
  return { text: s };
}
async function findPlaceFromGoogle() {
  const key = document.getElementById('sGoogleApiKey').value.trim();
  const q = parseGoogleQuery(document.getElementById('sGoogleQuery').value);
  const list = document.getElementById('googleCandidates');
  if (!key) { alert(t('googleFindNeedKey')); return; }
  if (q.placeId) { document.getElementById('sGooglePlaceId').value = q.placeId; list.classList.add('hidden'); await importStoreInfoFromGoogle(); return; }
  if (!q.text) { alert(t('googleFindNeedQuery')); return; }
  const btn = document.getElementById('btnGoogleFind');
  btn.disabled = true;
  try {
    const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress' },
      body: JSON.stringify({ textQuery: q.text, languageCode: state.settings.lang || 'ja', maxResultCount: 5 }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const e = await res.json(); msg = (e.error && e.error.message) || msg; } catch (err) { /* ignore */ }
      throw new Error(msg);
    }
    const places = ((await res.json()).places || []).filter((p) => p.id);
    if (!places.length) { alert(t('googleFindNone')); return; }
    list.innerHTML = `<div class="cand-note">${esc(t('googleFindPick'))}</div>` + places.map((p) =>
      `<button type="button" class="cand" data-pid="${esc(p.id)}"><b>${esc(p.displayName ? p.displayName.text : p.id)}</b><span>${esc(p.formattedAddress || '')}</span></button>`).join('');
    list.classList.remove('hidden');
    list.querySelectorAll('.cand').forEach((b) => b.addEventListener('click', async () => {
      document.getElementById('sGooglePlaceId').value = b.dataset.pid;
      list.classList.add('hidden');
      await importStoreInfoFromGoogle();
    }));
  } catch (e) {
    alert(`${t('googleImportError')} ${e.message || ''}`);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 設定モーダル: Google マップから店舗情報を取り込む（空欄のみ埋める。保存はユーザーが確認して行う） ---------- */
async function importStoreInfoFromGoogle() {
  const pid = document.getElementById('sGooglePlaceId').value.trim();
  const key = document.getElementById('sGoogleApiKey').value.trim();
  if (!pid || !key) { alert(t('googleImportNeed')); return; }
  const btn = document.getElementById('btnGoogleImport');
  btn.disabled = true;
  try {
    const fields = GOOGLE_PLACE_FIELDS.split(',').filter((f) => f !== 'reviews' && f !== 'photos').join(',');
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(pid)}?languageCode=${encodeURIComponent(state.settings.lang || 'ja')}`, {
      headers: { 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': fields },
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const e = await res.json(); msg = (e.error && e.error.message) || msg; } catch (err) { /* ignore */ }
      throw new Error(msg);
    }
    const info = googlePlaceToInfo(await res.json(), state.settings.lang);
    let n = 0;
    Object.entries(info).forEach(([k, v]) => {
      const el = document.getElementById(settingInputId(k));
      if (el && !el.value.trim() && v) { el.value = v; n += 1; }
    });
    alert(n ? t('googleImportDone').replace('{n}', n) : t('googleImportNone'));
  } catch (e) {
    alert(`${t('googleImportError')} ${e.message || ''}`);
  } finally {
    btn.disabled = false;
  }
}

/* ---------- 設定モーダル: コース・タグのマスタ編集 ---------- */
/* コースマスタ（名称・料金・説明。予約サイトのコース一覧に表示） */
function renderCourseRows() {
  const wrap = document.getElementById('courseRows');
  wrap.innerHTML = '';
  courseWork.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'course-master-row';
    row.innerHTML =
      `<input type="text" class="cr-name" value="${esc(c.name)}">` +
      `<input type="text" class="cr-price" value="${esc(c.price || '')}" placeholder="${esc(t('coursePricePlaceholder'))}">` +
      `<button type="button" class="icon-btn">🗑</button>` +
      `<input type="text" class="cr-desc" value="${esc(c.desc || '')}" placeholder="${esc(t('courseDescPlaceholder'))}">`;
    row.querySelector('.cr-name').addEventListener('input', (e) => { c.name = e.target.value; });
    row.querySelector('.cr-price').addEventListener('input', (e) => { c.price = e.target.value; });
    row.querySelector('.cr-desc').addEventListener('input', (e) => { c.desc = e.target.value; });
    row.querySelector('.icon-btn').addEventListener('click', () => { courseWork.splice(i, 1); renderCourseRows(); });
    wrap.appendChild(row);
  });
}
function renderMasterRows(wrapId, list) {
  const wrap = document.getElementById(wrapId);
  wrap.innerHTML = '';
  list.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'master-row';
    row.innerHTML = `<input type="text" value="${esc(item.name)}"><button type="button" class="icon-btn">🗑</button>`;
    row.querySelector('input').addEventListener('input', (e) => { item.name = e.target.value; });
    row.querySelector('.icon-btn').addEventListener('click', () => { list.splice(i, 1); renderMasterRows(wrapId, list); });
    wrap.appendChild(row);
  });
}

/* ---------- データのバックアップ・復元・CSV出力 ---------- */
function downloadFile(name, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
function exportJson() {
  downloadFile(`yoyaku-backup-${todayStr()}.json`, JSON.stringify(state, null, 2), 'application/json');
  registry.lastBackupAt = Date.now();
  saveRegistry();
  renderBackupNote();
}
function importJsonFile(file) {
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) { alert(t('importError')); return; }   // 10MB 超は拒否
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid');
      if (!Array.isArray(data.reservations) || !Array.isArray(data.tables) || !data.settings || typeof data.settings !== 'object') throw new Error('invalid');
      ['sites', 'courses', 'tags', 'combos'].forEach((k) => { if (data[k] != null && !Array.isArray(data[k])) throw new Error('invalid'); });
      if (!confirm(t('importConfirm'))) return;
      if (cloudMode) {
        // クラウド: 復元内容で全置換（無くなった予約は削除、残りは差分で再送）
        const oldSnap = cloudSync.resSnap;
        state = data;
        migrateState();
        Object.assign(state.settings, secretsGet(registry.currentId));
        cloudSync.resSnap = new Map([...oldSnap.keys()].map((k) => [k, '__stale__']));
        cloudSync.docSnap = '';
        save();
      } else {
        localStorage.setItem(dataKey(registry.currentId), JSON.stringify(data));
        load(); // 旧形式の移行処理も適用
      }
      // 復元データに平文の Claude キーがあり、ロックが有効なら暗号化し直す
      if (lockEnabled() && lockState.cryptoKey) reencryptKeysAllStores(lockState.cryptoKey, lockState.cryptoKey);
      else loadSessionKeys();
      document.getElementById('settingsModal').classList.add('hidden');
      renderAll();
    } catch (e) {
      alert(t('importError'));
    }
  };
  reader.readAsText(file);
}
function csvCell(v) {
  let s = String(v ?? '');
  // CSV/数式インジェクション対策: 先頭が = + - @ やタブの場合は先頭に ' を付けて数式として評価されないようにする
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function exportCsv() {
  const head = [t('date'), t('startTime'), t('endTime'), t('statusLabel'), t('name'), t('nameKana'), t('phone'),
    t('adults'), t('children'), t('tablesLabel'), t('channel'), t('coursesLabel'), t('tagsLabel'), t('memo')];
  const rows = state.reservations
    .filter((r) => r.status !== 'block')
    .sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.start - b.start)
    .map((r) => [
      r.date, fmtTime(r.start), fmtTime(r.start + r.duration), statusLabel(r.status),
      r.name || '', r.kana || '', r.phone || '', r.adults || 0, r.children || 0,
      (r.tableIds || []).map((id) => tableById(id)?.name).filter(Boolean).join('+'),
      siteById(r.channel)?.name || (r.walkIn ? t('walkInName') : t('channelNone')),
      resCourseText(r), tagNames(r.tags).join('/'), r.memo || '',
    ]);
  const csv = '﻿' + [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  downloadFile(`yoyaku-${todayStr()}.csv`, csv, 'text/csv;charset=utf-8');
}

/* ---------- view switching / render ---------- */
function setView(v) {
  view = v;
  if (v === 'calendar') {
    const [y, m] = currentDate.split('-').map(Number);
    calMonth = { y, m };
  }
  document.querySelectorAll('.rail-btn[data-view], #bottomNav .bn-btn, #viewSwitch .vs-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === v);
  });
  document.getElementById('view-timetable').classList.toggle('hidden', v !== 'timetable');
  document.getElementById('view-list').classList.toggle('hidden', v !== 'list');
  document.getElementById('view-customers').classList.toggle('hidden', v !== 'customers');
  document.getElementById('view-sites').classList.toggle('hidden', v !== 'sites');
  document.getElementById('view-chat').classList.toggle('hidden', v !== 'chat');
  document.getElementById('view-calendar').classList.toggle('hidden', v !== 'calendar');
  if (v === 'chat' && !document.getElementById('chatLog').childElementCount) {
    chatAppend('bot', t('chatHello') + '\n' + t('chatExamples'));
  }
  renderAll();
}

function renderAll() {
  closeCellPopover();
  applyStaticI18n();
  renderStoreSwitch();
  renderDateBar();
  if (view === 'timetable') renderTimetable();
  else if (view === 'list') renderList();
  else if (view === 'sites') renderSites();
  else if (view === 'customers') renderCustomers();
  else if (view === 'calendar') renderCalendar();
  /* chat はDOMを保持するため再描画しない */
}

function shiftDate(days) {
  const [y, m, d] = currentDate.split('-').map(Number);
  const dt = new Date(y, m - 1, d + days);
  currentDate = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
  renderAll();
}

/* ---------- init ---------- */
async function init() {
  loadRegistry();
  if (cloudMode) {
    Cloud.init();
    state = defaultState();
    state.reservations = [];   // ログイン完了までの仮の状態
    document.getElementById('cloudSection').classList.remove('hidden');
    document.getElementById('btnSignIn').addEventListener('click', doSignIn);
    document.getElementById('authPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn(); });
    document.getElementById('btnSignOut').addEventListener('click', doSignOut);
    Cloud.onAuth((s) => { if (!s) { cloudSync.ready = false; showAuth(true); } });
  } else {
    load();
  }

  // 店舗の切替・追加
  document.getElementById('storeSwitch').addEventListener('change', (e) => {
    if (e.target.value === '__add') addStore(); else switchStore(e.target.value);
  });
  // 端末ロック（PIN）
  document.getElementById('btnUnlock').addEventListener('click', tryUnlock);
  document.getElementById('lockPin').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, touchActivity, { passive: true }));
  setInterval(checkAutoLock, 15000);
  document.addEventListener('visibilitychange', () => { if (document.hidden && lockEnabled()) lockApp(); });
  document.getElementById('btnLockSave').addEventListener('click', saveLockSettings);
  document.getElementById('btnLockClear').addEventListener('click', removeLock);
  if (lockEnabled()) lockApp();
  // バックアップ催促
  document.getElementById('btnBackupNow').addEventListener('click', exportJson);
  document.getElementById('btnBackupDismiss').addEventListener('click', () => { registry.backupDismissed = todayStr(); saveRegistry(); renderBackupNote(); });
  // API キーの表示切替
  document.getElementById('sClaudeShow').addEventListener('change', (e) => { document.getElementById('sClaudeApiKey').type = e.target.checked ? 'text' : 'password'; });
  document.getElementById('sGoogleShow').addEventListener('change', (e) => { document.getElementById('sGoogleApiKey').type = e.target.checked ? 'text' : 'password'; });
  document.getElementById('btnGoogleImport').addEventListener('click', importStoreInfoFromGoogle);
  document.getElementById('btnGoogleFind').addEventListener('click', findPlaceFromGoogle);
  document.getElementById('sGoogleQuery').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); findPlaceFromGoogle(); } });
  document.getElementById('btnAddStore').addEventListener('click', () => { document.getElementById('settingsModal').classList.add('hidden'); addStore(); });
  document.getElementById('btnDeleteStore').addEventListener('click', deleteStore);

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
  document.getElementById('btnAddCourse').addEventListener('click', () => {
    modalCourses.push({ courseId: '', quantity: 1 });
    renderModalCourses();
  });
  document.getElementById('btnCustClose').addEventListener('click', closeCustomerDetail);
  document.getElementById('btnCustCloseFooter').addEventListener('click', closeCustomerDetail);

  document.querySelectorAll('.step-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const el = document.getElementById(b.dataset.step === 'adults' ? 'fAdults' : 'fChildren');
      el.textContent = Math.max(0, Number(el.textContent) + Number(b.dataset.d));
    });
  });

  // チャット操作
  document.getElementById('btnChatPhone').addEventListener('click', () => setView('chat'));
  document.getElementById('chatSend').addEventListener('click', chatSubmit);
  // 画像の添付（📷ボタン）・貼り付け（Ctrl+V / 長押し貼り付け）・ドラッグ＆ドロップ
  document.getElementById('chatAttach').addEventListener('click', () => document.getElementById('chatFile').click());
  document.getElementById('chatFile').addEventListener('change', (e) => {
    const hint = document.getElementById('chatInput').value.trim();
    document.getElementById('chatInput').value = '';
    chatHandleImages(e.target.files, hint);
    e.target.value = '';
  });
  document.addEventListener('paste', (e) => {
    if (view !== 'chat' || !e.clipboardData) return;
    const files = [...e.clipboardData.items].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    const hint = document.getElementById('chatInput').value.trim();
    document.getElementById('chatInput').value = '';
    chatHandleImages(files, hint);
  });
  const dropZone = document.getElementById('view-chat');
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragover'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer && e.dataTransfer.files.length) chatHandleImages(e.dataTransfer.files, document.getElementById('chatInput').value.trim());
  });
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
    if (cloudMode) return;   // クラウド時はリアルタイム購読で反映
    if (e.key === LS_REGISTRY) { loadRegistry(); load(); renderAll(); }
    else if (e.key === dataKey(registry.currentId)) { load(); renderAll(); }
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

  // 予約一覧: 全期間検索・印刷
  document.getElementById('listSearch').addEventListener('input', (e) => {
    listFilter.q = e.target.value;
    if (view === 'list') renderList();
  });
  document.getElementById('btnPrint').addEventListener('click', () => window.print());

  // 未確認ネット予約バッジ → 一覧を「未確認」で絞り込み
  document.getElementById('newBadge').addEventListener('click', () => {
    listFilter = { q: '', status: 'new' };
    setView('list');
  });

  // 月間カレンダー
  document.getElementById('calPrev').addEventListener('click', () => shiftCalMonth(-1));
  document.getElementById('calNext').addEventListener('click', () => shiftCalMonth(1));
  document.getElementById('calToday').addEventListener('click', () => {
    const [y, m] = todayStr().split('-').map(Number);
    calMonth = { y, m };
    renderCalendar();
  });

  // 予約フォーム: 電話番号から顧客情報を自動入力 / 複製
  document.getElementById('fPhone').addEventListener('input', autofillFromPhone);
  document.getElementById('fPhone').addEventListener('change', autofillFromPhone);
  document.getElementById('btnResDup').addEventListener('click', duplicateReservation);

  // 設定: 定休日・マスタ・バックアップ
  document.getElementById('btnAddClosedDate').addEventListener('click', () => {
    const inp = document.getElementById('sClosedDateInput');
    if (inp.value && !closedDatesWork.includes(inp.value)) closedDatesWork.push(inp.value);
    inp.value = '';
    renderClosedSettings();
  });
  document.getElementById('btnAddCourseMaster').addEventListener('click', () => {
    courseWork.push({ id: 'crs' + uid(), name: '' });
    renderCourseRows();
    const inputs = document.querySelectorAll('#courseRows input.cr-name');
    inputs[inputs.length - 1]?.focus();
  });
  document.getElementById('btnAddTagMaster').addEventListener('click', () => {
    tagWork.push({ id: 'tag' + uid(), name: '' });
    renderMasterRows('tagRows', tagWork);
    const inputs = document.querySelectorAll('#tagRows input');
    inputs[inputs.length - 1]?.focus();
  });
  document.getElementById('btnExportJson').addEventListener('click', exportJson);
  document.getElementById('btnExportCsv').addEventListener('click', exportCsv);
  document.getElementById('btnImportJson').addEventListener('click', () => document.getElementById('importFile').click());
  document.getElementById('importFile').addEventListener('change', (e) => {
    importJsonFile(e.target.files[0]);
    e.target.value = '';
  });

  renderAll();
  if (cloudMode) {
    try {
      const s = await Cloud.session();
      if (s) afterLogin(s); else showAuth(true);
    } catch (e) { showAuth(true, `${t('authError')} ${e.message || ''}`); }
  }
}

document.addEventListener('DOMContentLoaded', init);
