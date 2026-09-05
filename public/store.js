'use strict';

/* ---------- クラウド保存（Supabase）データ層 ----------
 * config.js に接続先があるときだけ有効（Cloud.enabled）。台帳（index.html）と予約サイト（booking.html）で共用。
 *  - 台帳: stores（店舗ごとの設定 JSON）と reservations（予約 1件 1行）をログイン済みユーザーとして読み書き
 *  - 予約サイト: 匿名で booking_* 関数（RPC）だけを呼ぶ（氏名・電話番号は取得できない） */
const Cloud = (() => {
  const cfg = window.APP_CONFIG || {};
  const enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase && window.supabase.createClient);
  let client = null;

  function init() {
    if (enabled && !client) {
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      });
    }
    return client;
  }
  function rowFromRes(storeId, r) {
    return {
      id: r.id, store_id: storeId, date: r.date, start_min: r.start, duration: r.duration, status: r.status,
      table_ids: r.tableIds || [], code: r.code || null,
      phone_digits: String(r.phone || '').replace(/\D/g, '') || null, data: r,
    };
  }
  function fail(error) { const e = new Error(error.message || String(error)); e.code = error.code; throw e; }

  /* ---- 台帳（要ログイン） ---- */
  async function listStores() {
    const { data, error } = await client.from('stores').select('id,name,updated_at').order('name');
    if (error) fail(error);
    return data || [];
  }
  async function loadStore(storeId) {
    const [s, r] = await Promise.all([
      client.from('stores').select('*').eq('id', storeId).maybeSingle(),
      client.from('reservations').select('data').eq('store_id', storeId),
    ]);
    if (s.error) fail(s.error);
    if (r.error) fail(r.error);
    return { store: s.data, reservations: (r.data || []).map((x) => x.data) };
  }
  async function saveDoc(storeId, name, doc) {
    const { error } = await client.from('stores').upsert({ id: storeId, name, doc });
    if (error) fail(error);
  }
  async function upsertReservations(storeId, list) {
    if (!list.length) return;
    const { error } = await client.from('reservations').upsert(list.map((r) => rowFromRes(storeId, r)));
    if (error) fail(error);
  }
  async function deleteReservations(ids) {
    if (!ids.length) return;
    const { error } = await client.from('reservations').delete().in('id', ids);
    if (error) fail(error);
  }
  async function deleteStore(storeId) {
    const { error } = await client.from('stores').delete().eq('id', storeId);
    if (error) fail(error);
  }
  function subscribe(storeId, onChange) {
    const ch = client.channel('store-' + storeId)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations', filter: `store_id=eq.${storeId}` }, onChange)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'stores', filter: `id=eq.${storeId}` }, onChange)
      .subscribe();
    return () => client.removeChannel(ch);
  }

  /* ---- 認証（スタッフ） ---- */
  async function session() { const { data } = await client.auth.getSession(); return data.session; }
  async function signIn(email, password) {
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) fail(error);
    return data.session;
  }
  async function signOut() { await client.auth.signOut(); }
  function onAuth(cb) { client.auth.onAuthStateChange((_event, s) => cb(s)); }

  /* ---- 予約サイト（匿名・RPC のみ） ---- */
  async function bookingStore(storeId) {
    const { data, error } = await client.rpc('booking_store', { p_store: storeId });
    if (error) fail(error);
    return data;
  }
  async function bookingOccupancy(storeId, from, to) {
    const { data, error } = await client.rpc('booking_occupancy', { p_store: storeId, p_from: from, p_to: to });
    if (error) fail(error);
    return (data || []).map((r) => ({ id: r.id, date: r.date, start: r.start, duration: r.duration, tableIds: r.table_ids || [], status: r.status }));
  }
  async function bookingCreate(storeId, res) {
    const { data, error } = await client.rpc('booking_create', { p_store: storeId, p_res: res });
    if (error) fail(error);
    return data;
  }
  async function bookingLookup(storeId, phone, code) {
    const { data, error } = await client.rpc('booking_lookup', { p_store: storeId, p_phone: phone, p_code: code });
    if (error) fail(error);
    return data || [];
  }
  async function bookingCancel(storeId, phone, code, id) {
    const { data, error } = await client.rpc('booking_cancel', { p_store: storeId, p_phone: phone, p_code: code, p_id: id });
    if (error) fail(error);
    return !!data;
  }

  return { enabled, init, listStores, loadStore, saveDoc, upsertReservations, deleteReservations, deleteStore, subscribe,
    session, signIn, signOut, onAuth, bookingStore, bookingOccupancy, bookingCreate, bookingLookup, bookingCancel };
})();
