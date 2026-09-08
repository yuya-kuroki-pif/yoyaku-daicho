'use strict';
/* ---------- 接続設定 ----------
 * Supabase を使う場合は、プロジェクトの URL と anon（公開）キーを設定してください。
 *   Supabase ダッシュボード → Project Settings → API → Project URL / anon public
 * 空のままなら、従来どおり端末（ブラウザ）内保存で動作します。
 * anon キーは公開しても問題ない値です（データの保護は Supabase 側の行レベルセキュリティで行います）。 */
window.APP_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: '',
  /* 予約サイトの URL（例: 'https://example.github.io/yoyaku-site/'）。空なら隣の booking/ を使います。
   * 予約サイトを別ドメインで公開する場合は、台帳・予約サイトの両方で Supabase を設定してください（端末内保存はドメインをまたいで共有できません）。 */
  bookingUrl: '',
};
