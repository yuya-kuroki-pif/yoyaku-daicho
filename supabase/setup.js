'use strict';
/* =====================================================================
 * Supabase の一括セットアップ（Node 18 以上。追加パッケージ不要）
 *   1. プロジェクト作成（既存プロジェクトを使う場合は --ref）
 *   2. schema.sql の適用（再実行しても壊れません）
 *   3. anon キーを取得して daicho/config.js と booking/config.js に書き込み
 *   4. スタッフ用ログインユーザーの作成（--staff-email / --staff-password）
 *   5. 予約サイト向け関数（booking_store）が匿名で呼べるか確認
 *
 * 使い方（PowerShell）:
 *   $env:SUPABASE_ACCESS_TOKEN = 'sbp_xxxxxxxx'     # Supabase → Account → Access Tokens で発行
 *   node supabase/setup.js --name yoyaku-daicho --region ap-southeast-1 --staff-email staff@example.com --staff-password 'xxxxxxxx'
 *   既存プロジェクトに適用するだけ:
 *   node supabase/setup.js --ref abcdefghijklmnop --staff-email ... --staff-password ...
 *
 * 出力される DB パスワードは Supabase ダッシュボードの操作に必要になることがあるので控えてください。
 * ===================================================================== */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.supabase.com/v1';
const ROOT = path.resolve(__dirname, '..');
const args = parseArgs(process.argv.slice(2));
const TOKEN = args.token || process.env.SUPABASE_ACCESS_TOKEN || '';

function parseArgs(list) {
  const o = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a.startsWith('--')) { const k = a.slice(2); const v = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : 'true'; o[k] = v; }
  }
  return o;
}
async function mgmt(method, p, body) {
  const res = await fetch(API + p, { method, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
  if (!res.ok) throw new Error(`${method} ${p} → HTTP ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(`▶ ${s}`);

async function main() {
  if (!TOKEN) { console.error('SUPABASE_ACCESS_TOKEN（または --token）が必要です。Supabase → Account → Access Tokens で発行してください。'); process.exit(1); }
  let ref = args.ref || '';
  let dbPass = '';

  // ---- 1. プロジェクト ----
  if (!ref) {
    const orgs = await mgmt('GET', '/organizations');
    if (!orgs.length) throw new Error('組織がありません。Supabase ダッシュボードで組織を作成してください。');
    const org = args.org ? orgs.find((o) => o.id === args.org || o.name === args.org) : orgs[0];
    if (!org) throw new Error(`組織が見つかりません: ${args.org}`);
    const name = args.name || 'yoyaku-daicho';
    const region = args.region || 'ap-southeast-1';   // シンガポール（ハノイ・東京の両方から近い）
    dbPass = crypto.randomBytes(18).toString('base64url');
    log(`プロジェクトを作成: ${name}（組織: ${org.name} / リージョン: ${region}）`);
    const created = await mgmt('POST', '/projects', { name, organization_id: org.id, db_pass: dbPass, region });
    ref = created.id;
    log(`作成しました: ref=${ref}`);
    console.log(`   DB パスワード（控えてください）: ${dbPass}`);
  }
  // ---- 起動待ち ----
  log('起動を待っています…');
  for (let i = 0; i < 60; i++) {
    const p = await mgmt('GET', `/projects/${ref}`);
    if (p.status === 'ACTIVE_HEALTHY') break;
    if (i === 59) throw new Error(`起動が完了しません（status=${p.status}）。しばらくしてから --ref ${ref} で再実行してください。`);
    await sleep(5000);
  }
  await sleep(3000);
  log('起動しました');

  // ---- 2. スキーマ ----
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  log('schema.sql を適用…');
  await mgmt('POST', `/projects/${ref}/database/query`, { query: sql });
  log('スキーマを適用しました（stores / reservations / events / booking_* 関数）');

  // ---- 3. キー取得 → config.js ----
  const keys = await mgmt('GET', `/projects/${ref}/api-keys?reveal=true`);
  const anon = (keys.find((k) => k.name === 'anon') || {}).api_key;
  const service = (keys.find((k) => k.name === 'service_role') || {}).api_key;
  if (!anon) throw new Error('anon キーを取得できませんでした。ダッシュボードの Project Settings → API から手動で config.js に設定してください。');
  const url = `https://${ref}.supabase.co`;
  for (const f of ['daicho/config.js', 'booking/config.js']) {
    const fp = path.join(ROOT, f);
    let s = fs.readFileSync(fp, 'utf8');
    s = s.replace(/supabaseUrl:\s*'[^']*'/, `supabaseUrl: '${url}'`).replace(/supabaseAnonKey:\s*'[^']*'/, `supabaseAnonKey: '${anon}'`);
    fs.writeFileSync(fp, s);
    log(`${f} に接続先を書き込みました`);
  }

  // ---- 4. スタッフユーザー ----
  if (args['staff-email'] && args['staff-password']) {
    if (!service) throw new Error('service_role キーを取得できませんでした。ダッシュボードの Authentication → Users から手動で作成してください。');
    const res = await fetch(`${url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: service, authorization: `Bearer ${service}`, 'content-type': 'application/json' },
      body: JSON.stringify({ email: args['staff-email'], password: args['staff-password'], email_confirm: true }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) log(`スタッフユーザーを作成しました: ${args['staff-email']}`);
    else if (res.status === 422 && /already/i.test(JSON.stringify(body))) log(`スタッフユーザーは既に存在します: ${args['staff-email']}`);
    else throw new Error(`スタッフユーザーの作成に失敗: HTTP ${res.status} ${JSON.stringify(body)}`);
  } else {
    log('スタッフユーザーは作成していません（--staff-email / --staff-password を付けると作成します）');
  }

  // ---- 5. 動作確認（匿名で booking_store を呼ぶ） ----
  const chk = await fetch(`${url}/rest/v1/rpc/booking_store`, {
    method: 'POST', headers: { apikey: anon, authorization: `Bearer ${anon}`, 'content-type': 'application/json' },
    body: JSON.stringify({ p_store: 'st1' }),
  });
  if (!chk.ok) throw new Error(`booking_store の呼び出しに失敗: HTTP ${chk.status} ${await chk.text()}`);
  log('予約サイト向け関数の呼び出しを確認しました');

  console.log('\n完了しました。');
  console.log(`  Project URL : ${url}`);
  console.log(`  ダッシュボード: https://supabase.com/dashboard/project/${ref}`);
  console.log('  次の手順: daicho/ と booking/ の config.js をコミット・公開 → 台帳を開くとログイン画面が出ます。');
}
main().catch((e) => { console.error('エラー:', e.message); process.exit(1); });
