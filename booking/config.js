'use strict';
/* ---------- 接続設定（予約サイト） ----------
 * 予約台帳と同じ Supabase プロジェクトを設定してください。
 * Supabase を使う場合は、プロジェクトの URL と anon（公開）キーを設定してください。
 *   Supabase ダッシュボード → Project Settings → API → Project URL / anon public
 * 空のままなら、従来どおり端末（ブラウザ）内保存で動作します。
 * anon キーは公開しても問題ない値です（データの保護は Supabase 側の行レベルセキュリティで行います）。 */
window.APP_CONFIG = {
  supabaseUrl: 'https://rlzltklfclzakcmpctga.supabase.co',
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJsemx0a2xmY2x6YWtjbXBjdGdhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4NjY3NzEsImV4cCI6MjEwNDQ0Mjc3MX0.t6tABzs2KBuLOHv5NquOqkCOMLUaCcWhjFMU3Ads6S0',
};
