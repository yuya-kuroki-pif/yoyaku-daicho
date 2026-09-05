-- =====================================================================
-- 予約台帳 / Sổ đặt bàn — Supabase スキーマ
-- Supabase ダッシュボード → SQL Editor にこのファイルの内容を貼り付けて実行してください。
-- （再実行しても壊れないよう if not exists / or replace で書いています）
--
-- 構成
--   stores        店舗ごとの設定（テーブル・予約サイト・コース・タグ・結合・店舗情報）を JSON で保持
--   reservations  予約 1件 = 1行（同時書き込みで予約が消えないように分離）
--   スタッフ（Supabase Auth でログイン）: 全店舗を読み書き
--   お客様（匿名）: 直接アクセス不可。booking_* 関数（security definer）経由でのみ
--                  空席計算・予約作成・予約番号での確認／取消ができる（氏名・電話番号は読めない）
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- テーブル ----------
create table if not exists public.stores (
  id          text primary key,
  name        text not null default '',
  doc         jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create table if not exists public.reservations (
  id            text primary key,
  store_id      text not null references public.stores(id) on delete cascade,
  date          text not null,                 -- 'YYYY-MM-DD'
  start_min     integer not null default 0,    -- 開始（分）
  duration      integer not null default 120,  -- 滞在（分）
  status        text not null default 'reserved',
  table_ids     text[] not null default '{}',
  code          text,                          -- 予約番号（ネット予約）
  phone_digits  text,                          -- 電話番号（数字のみ、照合用）
  data          jsonb not null,                -- 予約オブジェクト全体（アプリと同じ形）
  updated_at    timestamptz not null default now()
);
create index if not exists reservations_store_date on public.reservations (store_id, date);
create index if not exists reservations_lookup on public.reservations (store_id, phone_digits, code);

-- updated_at 自動更新
create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists stores_touch on public.stores;
create trigger stores_touch before update on public.stores for each row execute function public.touch_updated_at();
drop trigger if exists reservations_touch on public.reservations;
create trigger reservations_touch before update on public.reservations for each row execute function public.touch_updated_at();

-- ---------- 行レベルセキュリティ ----------
alter table public.stores enable row level security;
alter table public.reservations enable row level security;

drop policy if exists "staff select stores" on public.stores;
drop policy if exists "staff insert stores" on public.stores;
drop policy if exists "staff update stores" on public.stores;
drop policy if exists "staff delete stores" on public.stores;
create policy "staff select stores" on public.stores for select to authenticated using (true);
create policy "staff insert stores" on public.stores for insert to authenticated with check (true);
create policy "staff update stores" on public.stores for update to authenticated using (true) with check (true);
create policy "staff delete stores" on public.stores for delete to authenticated using (true);

drop policy if exists "staff select reservations" on public.reservations;
drop policy if exists "staff insert reservations" on public.reservations;
drop policy if exists "staff update reservations" on public.reservations;
drop policy if exists "staff delete reservations" on public.reservations;
create policy "staff select reservations" on public.reservations for select to authenticated using (true);
create policy "staff insert reservations" on public.reservations for insert to authenticated with check (true);
create policy "staff update reservations" on public.reservations for update to authenticated using (true) with check (true);
create policy "staff delete reservations" on public.reservations for delete to authenticated using (true);
-- anon（お客様）にはポリシーを作らない = 直接の読み書き不可

-- ---------- リアルタイム（台帳の即時反映） ----------
do $$ begin
  alter publication supabase_realtime add table public.reservations;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.stores;
exception when duplicate_object then null; end $$;

-- ---------- 予約サイト向け関数（匿名アクセス） ----------

-- 店舗の公開情報（秘密情報を除いた設定・テーブル・予約サイト・コース・結合）
create or replace function public.booking_store(p_store text)
returns jsonb
language sql security definer set search_path = public stable as $$
  select jsonb_build_object(
    'id', s.id,
    'name', s.name,
    'settings', coalesce(s.doc->'settings', '{}'::jsonb) - 'claudeApiKey' - 'claudeApiKeyEnc',
    'tables',  coalesce(s.doc->'tables',  '[]'::jsonb),
    'sites',   coalesce(s.doc->'sites',   '[]'::jsonb),
    'courses', coalesce(s.doc->'courses', '[]'::jsonb),
    'combos',  coalesce(s.doc->'combos',  '[]'::jsonb)
  )
  from public.stores s where s.id = p_store;
$$;

-- 期間内の席の占有状況（個人情報なし。空席計算用）
create or replace function public.booking_occupancy(p_store text, p_from text, p_to text)
returns table (id text, date text, start integer, duration integer, table_ids text[], status text)
language sql security definer set search_path = public stable as $$
  select r.id, r.date, r.start_min, r.duration, r.table_ids, r.status
  from public.reservations r
  where r.store_id = p_store
    and r.date >= p_from and r.date <= p_to
    and r.status not in ('cancelled', 'noshow');
$$;

-- 予約作成（必須項目・文字数・受付中か・同じ卓の重複をサーバー側で検証。店舗行をロックして直列化）
create or replace function public.booking_create(p_store text, p_res jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_store   public.stores%rowtype;
  v_enabled boolean;
  v_id      text;
  v_code    text := '';
  v_date    text;
  v_start   integer;
  v_dur     integer;
  v_tables  text[];
  v_name    text;
  v_phone   text;
  v_now     text;
  v_res     jsonb;
  i         integer;
begin
  select * into v_store from public.stores where id = p_store for update;
  if not found then raise exception 'store not found'; end if;

  v_date  := p_res->>'date';
  v_start := nullif(p_res->>'start', '')::integer;
  v_dur   := coalesce(nullif(p_res->>'duration', '')::integer, 120);
  v_name  := left(btrim(coalesce(p_res->>'name', '')), 100);
  v_phone := left(btrim(coalesce(p_res->>'phone', '')), 40);
  if v_date !~ '^\d{4}-\d{2}-\d{2}$' or v_start is null or v_start < 0 or v_start > 1440
     or v_dur < 30 or v_dur > 600 or v_name = '' or regexp_replace(v_phone, '\D', '', 'g') = '' then
    raise exception 'invalid';
  end if;

  select array_agg(x) into v_tables from jsonb_array_elements_text(coalesce(p_res->'tableIds', '[]'::jsonb)) x;
  if v_tables is null or array_length(v_tables, 1) is null then raise exception 'no table'; end if;

  -- 指定された予約サイト（経路）が受付中か
  select coalesce(bool_or((s->>'enabled')::boolean), false) into v_enabled
  from jsonb_array_elements(coalesce(v_store.doc->'sites', '[]'::jsonb)) s
  where s->>'id' = p_res->>'channel';
  if not v_enabled then raise exception 'closed'; end if;

  -- 同じ卓・時間帯の重複（キャンセル・ノーショーは除く）
  if exists (
    select 1 from public.reservations r
    where r.store_id = p_store and r.date = v_date
      and r.status not in ('cancelled', 'noshow')
      and r.table_ids && v_tables
      and r.start_min < v_start + v_dur and v_start < r.start_min + r.duration
  ) then raise exception 'taken'; end if;

  v_id := 'r' || replace(gen_random_uuid()::text, '-', '');
  for i in 1..6 loop
    v_code := v_code || substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', (get_byte(gen_random_bytes(1), 0) % 32) + 1, 1);
  end loop;
  v_now := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');

  v_res := jsonb_build_object(
    'id', v_id, 'code', v_code, 'date', v_date, 'start', v_start, 'duration', v_dur, 'end', v_start + v_dur,
    'adults',   greatest(1, least(99, coalesce(nullif(p_res->>'adults', '')::integer, 2))),
    'children', greatest(0, least(99, coalesce(nullif(p_res->>'children', '')::integer, 0))),
    'name', v_name,
    'kana',  left(coalesce(p_res->>'kana', ''), 100),
    'phone', v_phone,
    'email', left(coalesce(p_res->>'email', ''), 200),
    'purpose', case when jsonb_typeof(p_res->'purpose') = 'number' then p_res->'purpose' else to_jsonb(''::text) end,
    'tableIds', to_jsonb(v_tables),
    'courses', case when jsonb_typeof(p_res->'courses') = 'array' then p_res->'courses' else '[]'::jsonb end,
    'tags', '[]'::jsonb,
    'memo', left(coalesce(p_res->>'memo', ''), 1000),
    'status', 'reserved', 'walkIn', false,
    'channel', coalesce(p_res->>'channel', ''),
    'isNew', true, 'createdAt', v_now, 'updatedAt', v_now
  );

  insert into public.reservations (id, store_id, date, start_min, duration, status, table_ids, code, phone_digits, data)
  values (v_id, p_store, v_date, v_start, v_dur, 'reserved', v_tables, v_code, regexp_replace(v_phone, '\D', '', 'g'), v_res);
  return v_res;
end $$;

-- 予約番号＋電話番号で自分の予約を確認（返す項目を限定）
create or replace function public.booking_lookup(p_store text, p_phone text, p_code text)
returns setof jsonb
language sql security definer set search_path = public stable as $$
  select jsonb_build_object(
    'id', r.id, 'code', r.code, 'date', r.date, 'start', r.start_min, 'duration', r.duration,
    'status', r.status, 'name', r.data->>'name', 'adults', r.data->'adults', 'children', r.data->'children',
    'courses', coalesce(r.data->'courses', '[]'::jsonb)
  )
  from public.reservations r
  where r.store_id = p_store
    and regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> ''
    and r.phone_digits = regexp_replace(p_phone, '\D', '', 'g')
    and r.code = upper(btrim(coalesce(p_code, '')))
  order by r.date desc, r.start_min desc;
$$;

-- 予約番号＋電話番号で自分の予約を取消（来店前の「予約」状態のみ）
create or replace function public.booking_cancel(p_store text, p_phone text, p_code text, p_id text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.reservations
     set status = 'cancelled',
         data = data || jsonb_build_object('status', 'cancelled', 'isNew', false,
                  'updatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
   where store_id = p_store and id = p_id
     and code = upper(btrim(coalesce(p_code, '')))
     and phone_digits = regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')
     and status = 'reserved';
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- 関数の実行権限（匿名・ログイン済みの両方から呼べる。テーブルは直接触れない）
revoke all on function public.booking_store(text) from public;
revoke all on function public.booking_occupancy(text, text, text) from public;
revoke all on function public.booking_create(text, jsonb) from public;
revoke all on function public.booking_lookup(text, text, text) from public;
revoke all on function public.booking_cancel(text, text, text, text) from public;
grant execute on function public.booking_store(text) to anon, authenticated;
grant execute on function public.booking_occupancy(text, text, text) to anon, authenticated;
grant execute on function public.booking_create(text, jsonb) to anon, authenticated;
grant execute on function public.booking_lookup(text, text, text) to anon, authenticated;
grant execute on function public.booking_cancel(text, text, text, text) to anon, authenticated;

-- ---------- 流入計測（予約サイトの閲覧・予約画面到達・予約完了） ----------
create table if not exists public.events (
  id        bigserial primary key,
  store_id  text not null references public.stores(id) on delete cascade,
  t         timestamptz not null default now(),
  type      text not null,      -- view / reserve / submit
  site      text,               -- 予約サイト（経路）ID
  ref       text,               -- リファラーのホスト名
  dev       text,               -- m=スマホ / d=PC
  utm       text                -- utm_source
);
create index if not exists events_store_t on public.events (store_id, t);
alter table public.events enable row level security;
drop policy if exists "staff select events" on public.events;
create policy "staff select events" on public.events for select to authenticated using (true);
drop policy if exists "staff delete events" on public.events;
create policy "staff delete events" on public.events for delete to authenticated using (true);

create or replace function public.booking_track(p_store text, p_event jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.stores where id = p_store) then return; end if;
  if coalesce(p_event->>'type', '') not in ('view', 'reserve', 'submit') then return; end if;
  insert into public.events (store_id, type, site, ref, dev, utm)
  values (p_store, p_event->>'type', left(coalesce(p_event->>'site', ''), 40), left(coalesce(p_event->>'ref', ''), 100),
          left(coalesce(p_event->>'dev', ''), 1), left(coalesce(p_event->>'utm', ''), 60));
end $$;
revoke all on function public.booking_track(text, jsonb) from public;
grant execute on function public.booking_track(text, jsonb) to anon, authenticated;
