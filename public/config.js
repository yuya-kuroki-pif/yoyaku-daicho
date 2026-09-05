'use strict';
/* ---------- 接続設定 ----------
 * Supabase を使う場合は、プロジェクトの URL と anon（公開）キーを設定してください。
 *   Supabase ダッシュボード → Project Settings → API → Project URL / anon public
 * 空のままなら、従来どおり端末（ブラウザ）内保存で動作します。
 * anon キーは公開しても問題ない値です（データの保護は Supabase 側の行レベルセキュリティで行います）。 */
window.APP_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
};
