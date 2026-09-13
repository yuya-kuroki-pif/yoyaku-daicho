// =====================================================================
// 予約台帳 AI 中継関数（Supabase Edge Function）
//   ブラウザは Claude API を直接呼ばず、この関数だけを呼ぶ。API キー（ANTHROPIC_API_KEY）はサーバー側の Secret にだけ置く。
//   アクセス制限:
//     1. ログイン済みスタッフであること（Supabase Auth の JWT）
//     2. 対象店舗の AI 利用が許可されていること（store_members.ai_allowed）
//     3. 利用上限: 利用者ごと 1分あたり USER_PER_MIN 回、店舗ごと 24時間あたり settings.aiDailyLimit 回（ai_usage で集計）
//     4. 用途と入力の制限: purpose は extract_reservation / chat_command のみ。モデル・出力トークン数・画像枚数とサイズ・文字数を固定
// =====================================================================
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-5";
const USER_PER_MIN = 10;
const DEFAULT_DAILY = 50;
const ALLOWED_ORIGINS = [
  "https://yoyaku-daicho-704a0.web.app",
  "https://yoyaku-daicho-704a0.firebaseapp.com",
  "https://yuya-kuroki-pif.github.io",
  "http://127.0.0.1:8210",
  "http://localhost:8210",
];
type PurposeSpec = { maxTokens: number; maxImages: number; imageMaxChars: number; effort: string };
const PURPOSES: Record<string, PurposeSpec> = {
  extract_reservation: { maxTokens: 1200, maxImages: 1, imageMaxChars: 2_800_000, effort: "medium" },  // 画像1枚（縮小済み JPEG、約2MBまで）
  chat_command: { maxTokens: 1500, maxImages: 10, imageMaxChars: 600_000, effort: "low" },             // Google 写真の選定用サムネイル（各 約450KB まで）
};

function corsHeaders(origin: string) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
function json(status: number, body: unknown, origin: string) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(origin), "Content-Type": "application/json" } });
}
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const fmtTime = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
const WEEKDAYS: Record<string, string[]> = { ja: ["日", "月", "火", "水", "木", "金", "土"], vi: ["CN", "T2", "T3", "T4", "T5", "T6", "T7"] };

const EXTRACT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    found: { type: "boolean" },
    date: { type: ["string", "null"] }, time: { type: ["string", "null"] },
    adults: { type: ["integer", "null"] }, children: { type: ["integer", "null"] },
    name: { type: ["string", "null"] }, kana: { type: ["string", "null"] }, phone: { type: ["string", "null"] },
    course: { type: ["string", "null"] }, memo: { type: ["string", "null"] }, channel: { type: ["string", "null"] },
    missing: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["found", "date", "time", "adults", "children", "name", "kana", "phone", "course", "memo", "channel", "missing", "notes"],
};

// deno-lint-ignore no-explicit-any
function extractSystemPrompt(settings: any, courses: any[], today: string, lang: string) {
  const [y, m, d] = today.split("-").map(Number);
  const wd = WEEKDAYS[lang][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  const courseNames = (courses || []).map((c) => c.name).filter(Boolean).join(" / ") || "なし";
  return `あなたは飲食店「${settings.storeName || ""}」の予約台帳アシスタントです。` +
    `お客様とのDM（Instagram・LINE・メール等）のスクリーンショットから、予約に必要な情報を読み取り、指定のJSONだけを返してください。\n` +
    `今日は ${today}（${wd}曜日）です。「明日」「来週金曜」などの相対表現は今日を基準に YYYY-MM-DD に変換してください。年が書かれていない日付は、今日以降で最も近い日付にしてください。\n` +
    `営業時間は ${fmtTime(Number(settings.openMin) || 660)}〜${fmtTime(Number(settings.closeMin) || 1380)}。時間は 24時間表記の HH:MM（例 19:00）。「夜7時」は 19:00 です。\n` +
    `人数は大人と子供に分け、区別が無ければ全員を adults にしてください。コースは店舗のコース名（${courseNames}）に一致する場合のみその名前を、無ければ null。\n` +
    `memo にはアレルギー・席の希望・お祝い等の要望を短くまとめ、channel には DM の媒体名（Instagram / LINE / メール 等、不明なら null）。\n` +
    `読み取れない項目は null にし、missing に項目名（date/time/adults/name/phone）を列挙。notes には判断の根拠や不確かな点を日本語で1〜2文。\n` +
    `予約に関する情報が含まれない画像なら found を false にしてください。`;
}

function chatSystemPrompt(context: string, today: string) {
  return `あなたは飲食店の予約台帳の設定アシスタントです。ユーザーの日本語（またはベトナム語）の指示を、次のアクションの配列に変換して JSON だけを返してください。\n` +
    `アクション:\n` +
    `- {"type":"set_field","field":F,"value":文字列}  F は storeName/storeKana/storeGenre/storePhone/storeAddress/storeAccess/storeHours/storeBudget/storeBudgetLunch/storePayment/storeCatch/storeDescription/storeNote/googlePlaceId\n` +
    `- {"type":"set_flag","flag":"showReviews"|"showGooglePhotos","value":true|false}  予約サイトでの Google 口コミ／写真の表示\n` +
    `- {"type":"import_google"}  Google マップから店舗情報を取り込む\n- {"type":"find_place","query":店名など}  Google マップで店舗を検索して設定\n` +
    `- {"type":"set_closed_days","days":[0-6]}  定休日（0=日曜）\n- {"type":"add_closed_date","date":"YYYY-MM-DD"} / {"type":"remove_closed_date","date":...}  臨時休業\n` +
    `- {"type":"set_hours","open":分,"close":分}  営業時間（例 17:00 → 1020）\n` +
    `- {"type":"table_add","name":..,"seats":n,"min":n,"group":..} / {"type":"table_update","name":..,"seats"?:n,"min"?:n,"group"?:..,"newName"?:..} / {"type":"table_delete","name":..}\n` +
    `- {"type":"site_toggle","name":予約サイト名,"enabled":true|false}\n- {"type":"course_set","name":..,"price"?:..,"desc"?:..} / {"type":"course_delete","name":..}\n` +
    `- {"type":"extra_set","label":項目名,"value":内容} / {"type":"extra_delete","label":..}  店舗詳細（個室・駐車場など自由項目）\n` +
    `- {"type":"photo_list"} / {"type":"review_list"}  Google マップの写真／口コミを番号付きで一覧表示\n` +
    `- {"type":"photo_select","use"?:[番号...(表示順)],"main"?:番号,"hide"?:[番号...],"unhide"?:[番号...],"reset"?:true}  予約サイトに出す写真の選定（番号は下の写真一覧の番号。画像が添付されていれば内容を見て選ぶ）\n` +
    `- {"type":"review_filter","minRating"?:1-5,"sort"?:"newest"|"highest"|"lowest","limit"?:n,"keyword"?:文字列,"hide"?:[番号...],"unhide"?:[番号...],"reset"?:true}  予約サイトに出す口コミの絞り込み。低評価だけを隠す目的の指示には、Google の規約上できないと reply で説明し hide を出さない\n` +
    `現在の状態: ${context} / 今日=${today}\n` +
    `該当する操作が無い、または予約の登録・変更（お客様の予約）に関する指示なら {"actions":[],"reply":"理由"} を返してください。文言の改善提案を求められたら、改善した文言で set_field を提案してください。出力は {"actions":[...],"reply":"短い日本語の説明"} のみ。`;
}

// deno-lint-ignore no-explicit-any
async function callAnthropic(body: any) {
  return await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "server-side-fallback-2026-07-01",
    },
    body: JSON.stringify(body),
  });
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin") ?? "";
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(origin) });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" }, origin);

  // 1. ログイン済みか（JWT）
  const authHeader = req.headers.get("authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return json(401, { error: "unauthorized" }, origin);

  // deno-lint-ignore no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return json(400, { error: "bad_json" }, origin); }
  const store = String(body.store ?? "").slice(0, 40);
  const purpose = String(body.purpose ?? "");
  const lang = body.lang === "vi" ? "vi" : "ja";
  const spec = PURPOSES[purpose];
  if (!spec) return json(400, { error: "bad_purpose" }, origin);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(store)) return json(400, { error: "bad_store" }, origin);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  // 2. 店舗の AI 利用権限（DB）
  const { data: member } = await admin.from("store_members").select("ai_allowed").eq("store_id", store).eq("user_id", user.id).maybeSingle();
  if (!member || !member.ai_allowed) return json(403, { error: "forbidden" }, origin);
  const { data: storeRow } = await admin.from("stores").select("name,doc").eq("id", store).maybeSingle();
  if (!storeRow) return json(404, { error: "store_not_found" }, origin);
  const settings = storeRow.doc?.settings ?? {};
  const daily = clamp(Number(settings.aiDailyLimit) || DEFAULT_DAILY, 1, 1000);

  // 3. 利用上限（利用者: 1分あたり / 店舗: 24時間あたり）
  const since1m = new Date(Date.now() - 60_000).toISOString();
  const since24h = new Date(Date.now() - 86_400_000).toISOString();
  const { count: perMin } = await admin.from("ai_usage").select("id", { count: "exact", head: true }).eq("user_id", user.id).gte("created_at", since1m);
  if ((perMin ?? 0) >= USER_PER_MIN) return json(429, { error: "rate_limited", retry_after: 60 }, origin);
  const { count: perDay } = await admin.from("ai_usage").select("id", { count: "exact", head: true }).eq("store_id", store).gte("created_at", since24h);
  if ((perDay ?? 0) >= daily) return json(429, { error: "daily_limit", limit: daily }, origin);

  // 4. 入力の検証（用途ごとの枚数・サイズ・文字数）
  const images = Array.isArray(body.images) ? body.images.slice(0, spec.maxImages) : [];
  for (const im of images) {
    if (!im || typeof im.data !== "string" || !/^image\/(jpeg|png|webp|gif)$/.test(String(im.media_type)) ||
      im.data.length > spec.imageMaxChars || !/^[A-Za-z0-9+/]+={0,2}$/.test(im.data.slice(0, 64))) {
      return json(400, { error: "bad_image" }, origin);
    }
  }
  const text = String(body.text ?? "").slice(0, 2000);
  const context = String(body.context ?? "").slice(0, 8000);
  const hint = String(body.hint ?? "").slice(0, 500);
  const today = /^\d{4}-\d{2}-\d{2}$/.test(String(body.today ?? "")) ? String(body.today) :
    new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
  if (purpose === "extract_reservation" && images.length !== 1) return json(400, { error: "image_required" }, origin);
  if (purpose === "chat_command" && !text.trim()) return json(400, { error: "text_required" }, origin);
  if (!ANTHROPIC_API_KEY) return json(503, { error: "not_configured" }, origin);

  // deno-lint-ignore no-explicit-any
  let request: any;
  if (purpose === "extract_reservation") {
    request = {
      model: MODEL, max_tokens: spec.maxTokens, fallbacks: "default",
      system: extractSystemPrompt(settings, storeRow.doc?.courses ?? [], today, lang),
      output_config: { effort: spec.effort, format: { type: "json_schema", schema: EXTRACT_SCHEMA } },
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: images[0].media_type, data: images[0].data } },
        { type: "text", text: (hint ? `補足: ${hint}\n` : "") + "このスクリーンショットから予約情報を読み取って、JSONで返してください。" },
      ] }],
    };
  } else {
    // deno-lint-ignore no-explicit-any
    const content: any[] = [];
    images.forEach((im: { media_type: string; data: string }, i: number) => {
      content.push({ type: "text", text: `写真 ${i + 1}:` });
      content.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } });
    });
    content.push({ type: "text", text });
    request = {
      model: MODEL, max_tokens: spec.maxTokens, fallbacks: "default",
      system: chatSystemPrompt(context, today),
      output_config: { effort: spec.effort },
      messages: [{ role: "user", content: content.length === 1 ? text : content }],
    };
  }

  // 利用回数は「試行」で数える（失敗の連打も上限に含める）
  const { data: usageRow } = await admin.from("ai_usage").insert({ store_id: store, user_id: user.id, purpose, model: MODEL }).select("id").single();

  let res = await callAnthropic(request);
  if (res.status === 400 && request.output_config?.format) {
    // 構造化出力が使えない場合は本文の JSON を解析する（クライアント側で対応）
    delete request.output_config.format;
    res = await callAnthropic(request);
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const e = await res.json(); msg = e?.error?.message ?? msg; } catch { /* ignore */ }
    return json(502, { error: "upstream", message: msg.slice(0, 300) }, origin);
  }
  const data = await res.json();
  const textOut = (data.content ?? []).filter((b: { type: string }) => b.type === "text").map((b: { text: string }) => b.text).join("\n");
  if (usageRow?.id) {
    await admin.from("ai_usage").update({ model: data.model ?? MODEL, input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 }).eq("id", usageRow.id);
  }
  return json(200, { text: textOut, stop_reason: data.stop_reason ?? "", usage: { input_tokens: data.usage?.input_tokens ?? 0, output_tokens: data.usage?.output_tokens ?? 0 }, remaining: Math.max(0, daily - (perDay ?? 0) - 1) }, origin);
});
