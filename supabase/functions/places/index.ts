// =====================================================================
// Google マップ（Places API (New)）中継関数（Supabase Edge Function）
//   ブラウザは Google の API を直接呼ばず、この関数だけを呼ぶ。API キー（GOOGLE_PLACES_API_KEY）はサーバー側の Secret にだけ置く。
//   用途（op）:
//     details      店舗ページ用の店舗情報・口コミ・写真一覧（匿名可）。Place ID はクライアントからではなく stores.doc から取る
//     photo        写真（匿名可）。店舗の写真一覧に含まれる写真だけを、Google の画像 URL へ 302 で転送（mode=bytes はスタッフのみ）
//     details_for  任意の Place ID の店舗情報（スタッフのみ。管理者設定の取り込み・チャットの選定用）
//     search       店名検索（スタッフのみ）
//   制限:
//     - 匿名は IP ごとに 1分あたり ANON_PER_MIN 回。スタッフは JWT でログイン確認
//     - Google への実呼び出しは google_cache で 6〜12 時間キャッシュし、店舗（またはスタッフ）ごとの 24 時間上限（DAILY）で打ち切る
//     - 取得項目（FieldMask）・写真サイズ（400 / 900px）・検索語の長さは固定
// =====================================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const GOOGLE_KEY = Deno.env.get("GOOGLE_PLACES_API_KEY") ?? "";
const FIELDS = "displayName,rating,userRatingCount,reviews,googleMapsUri,photos,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,regularOpeningHours.weekdayDescriptions,websiteUri,priceRange,primaryTypeDisplayName,editorialSummary,paymentOptions,parkingOptions,goodForChildren";
const ALLOWED_ORIGINS = [
  "https://robata-naru-hanoi-booking.web.app",
  "https://yoyaku-daicho-704a0.web.app",
  "https://yoyaku-daicho-704a0.firebaseapp.com",
  "https://yuya-kuroki-pif.github.io",
  "http://127.0.0.1:8210",
  "http://localhost:8210",
];
const ANON_PER_MIN = 60;
const DETAILS_TTL = 6 * 60 * 60 * 1000;
const PHOTO_TTL = 12 * 60 * 60 * 1000;
const DAILY = { details: 200, photo: 3000, search: 300, details_for: 300 };

function corsHeaders(origin: string) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return { "Access-Control-Allow-Origin": allow, "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Vary": "Origin" };
}
function json(status: number, body: unknown, origin: string, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json", ...extra } });
}

// 匿名アクセスの IP ごとの簡易レート制限（インスタンス内メモリ。上限超過の連打を抑える）
const hits = new Map<string, number[]>();
function tooMany(ip: string) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > ANON_PER_MIN;
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
async function cacheGet(key: string, ttl: number) {
  const { data } = await admin.from("google_cache").select("data,at").eq("key", key).maybeSingle();
  if (!data) return null;
  if (Date.now() - new Date(data.at).getTime() > ttl) return null;
  return data.data;
}
async function cacheSet(key: string, value: unknown) {
  await admin.from("google_cache").upsert({ key, data: value, at: new Date().toISOString() });
}
async function overDaily(bucket: string, op: keyof typeof DAILY) {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { count } = await admin.from("google_usage").select("id", { count: "exact", head: true }).eq("bucket", bucket).eq("op", op).gte("created_at", since);
  return (count ?? 0) >= DAILY[op];
}
async function countUse(bucket: string, op: string) {
  await admin.from("google_usage").insert({ bucket, op });
}
async function googleDetails(placeId: string, lang: string, bucket: string, origin: string) {
  const key = `details:${placeId}:${lang}`;
  const cached = await cacheGet(key, DETAILS_TTL);
  if (cached) return { data: cached };
  if (await overDaily(bucket, "details")) return { err: json(429, { error: "daily_limit" }, origin) };
  await countUse(bucket, "details");
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=${encodeURIComponent(lang)}`, { headers: { "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": FIELDS } });
  if (!res.ok) { let msg = `HTTP ${res.status}`; try { const e = await res.json(); msg = e?.error?.message ?? msg; } catch { /* ignore */ } return { err: json(502, { error: "upstream", message: String(msg).slice(0, 300) }, origin) }; }
  const data = await res.json();
  await cacheSet(key, data);
  return { data };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  const url = new URL(req.url);
  const op = url.searchParams.get("op") ?? "";
  const lang = url.searchParams.get("lang") === "vi" ? "vi" : "ja";
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!GOOGLE_KEY) return json(503, { error: "not_configured" }, origin);

  // スタッフか（JWT）。匿名でも details / photo は使える
  let userId = "";
  const authHeader = req.headers.get("authorization") ?? "";
  if (authHeader.startsWith("Bearer ") && authHeader.length > 40) {
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
    const { data } = await userClient.auth.getUser();
    userId = data?.user?.id ?? "";
  }
  const staffOnly = () => (userId ? null : json(401, { error: "unauthorized" }, origin));
  const bucketFor = (store: string) => (userId ? `u:${userId}` : `s:${store}`);

  if (!userId && tooMany(ip)) return json(429, { error: "rate_limited", retry_after: 60 }, origin);

  if (op === "details" || op === "photo") {
    const store = url.searchParams.get("store") ?? "";
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(store)) return json(400, { error: "bad_store" }, origin);
    const { data: row } = await admin.from("stores").select("doc").eq("id", store).maybeSingle();
    const placeId = String(row?.doc?.settings?.googlePlaceId ?? "").trim();
    if (!row || !/^[A-Za-z0-9_-]{10,200}$/.test(placeId)) return json(404, { error: "no_place" }, origin);
    const bucket = `s:${store}`;
    const d = await googleDetails(placeId, lang, bucket, origin);
    if (d.err) return d.err;
    if (op === "details") return json(200, d.data, origin, { "Cache-Control": "private, max-age=600" });

    // photo: 店舗の写真一覧に含まれる写真だけ
    const name = url.searchParams.get("name") ?? "";
    const w = url.searchParams.get("w") === "400" ? 400 : 900;
    const mode = url.searchParams.get("mode") === "bytes" ? "bytes" : "redirect";
    const names = new Set(((d.data?.photos ?? []) as { name: string }[]).map((p) => p.name));
    if (!names.has(name)) return json(404, { error: "no_photo" }, origin);
    if (mode === "bytes" && !userId) return json(401, { error: "unauthorized" }, origin);
    const ck = `photo:${name}:${w}`;
    let photoUri = (await cacheGet(ck, PHOTO_TTL)) as string | null;
    if (!photoUri) {
      if (await overDaily(bucket, "photo")) return json(429, { error: "daily_limit" }, origin);
      await countUse(bucket, "photo");
      const res = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=${w}&skipHttpRedirect=true&key=${encodeURIComponent(GOOGLE_KEY)}`);
      if (!res.ok) return json(502, { error: "upstream", message: `HTTP ${res.status}` }, origin);
      const j = await res.json();
      photoUri = String(j.photoUri ?? "");
      if (!/^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//.test(photoUri) && !/^https:\/\/lh\d\.googleusercontent\.com\//.test(photoUri)) return json(502, { error: "upstream", message: "bad photo uri" }, origin);
      await cacheSet(ck, photoUri);
    }
    if (mode === "redirect") return new Response(null, { status: 302, headers: { ...corsHeaders(origin), Location: photoUri, "Cache-Control": "public, max-age=3600" } });
    const img = await fetch(photoUri);
    if (!img.ok) return json(502, { error: "upstream", message: `HTTP ${img.status}` }, origin);
    return new Response(img.body, { status: 200, headers: { ...corsHeaders(origin), "Content-Type": img.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "private, max-age=3600" } });
  }

  if (op === "details_for") {
    const denied = staffOnly(); if (denied) return denied;
    const place = url.searchParams.get("place") ?? "";
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(place)) return json(400, { error: "bad_place" }, origin);
    const d = await googleDetails(place, lang, bucketFor(""), origin);
    if (d.err) return d.err;
    return json(200, d.data, origin, { "Cache-Control": "private, max-age=600" });
  }

  if (op === "search") {
    const denied = staffOnly(); if (denied) return denied;
    const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 100);
    if (!q) return json(400, { error: "bad_query" }, origin);
    const ck = `search:${lang}:${q.toLowerCase()}`;
    const cached = await cacheGet(ck, DETAILS_TTL);
    if (cached) return json(200, cached, origin);
    const bucket = bucketFor("");
    if (await overDaily(bucket, "search")) return json(429, { error: "daily_limit" }, origin);
    await countUse(bucket, "search");
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": GOOGLE_KEY, "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress" },
      body: JSON.stringify({ textQuery: q, languageCode: lang, maxResultCount: 5 }),
    });
    if (!res.ok) { let msg = `HTTP ${res.status}`; try { const e = await res.json(); msg = e?.error?.message ?? msg; } catch { /* ignore */ } return json(502, { error: "upstream", message: String(msg).slice(0, 300) }, origin); }
    const data = await res.json();
    await cacheSet(ck, data);
    return json(200, data, origin);
  }

  return json(400, { error: "bad_op" }, origin);
});
