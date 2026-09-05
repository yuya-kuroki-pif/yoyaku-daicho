'use strict';

/* ===== 自社予約サイト（グルメサイト風 店舗ページ） / Trang cửa hàng & đặt bàn =====
 * 予約台帳（index.html）と同じ localStorage を共有し、ネット予約は台帳に「予約」として自動反映されます。
 *  - タブ構成: トップ / コース / 写真 / 口コミ / ネット予約 / 店舗情報
 *  - 店舗情報・コース・写真は台帳の「店舗情報」設定と連動
 *  - 口コミ・評価・写真の一部は Google マップ（Places API (New)）から取得（Place ID と API キーを台帳で設定）
 *  - URL の ?site= で予約経路を指定、#reserve で予約タブを直接開く
 * 注意: データはブラウザ内保存のため、別端末から開いた場合は店舗の台帳に届きません。
 */

const LS_KEY = 'yoyaku-daicho-v1';
const LS_REGISTRY = 'yoyaku-daicho-stores';
const LANG_KEY = 'yoyaku-booking-lang';
const GCACHE_KEY = 'yoyaku-google-place-cache-v3';
const MAX_GOOGLE_PHOTOS = 10;   // Places API が返す写真の上限
const GCACHE_TTL = 6 * 60 * 60 * 1000;   // Google 取得結果のキャッシュ（6時間）
const DUR = 120;         // 滞在想定（分）
const MAX_MONTHS = 3;    // 何か月先まで予約可能か
const MAX_ADULTS = 20;
const MAX_CHILDREN = 10;
const TABS = ['top', 'menu', 'photo', 'review', 'map'];
/* 店舗情報（詳細）に表示する任意項目（台帳の「店舗詳細」設定と対応） */
const EXTRA_KEYS = ['storePrivateRoom', 'storeCharter', 'storeSmoking', 'storeParking', 'storeFacilities', 'storeDrink', 'storeFood',
  'storeScene', 'storeService', 'storeKids', 'storeWebsite', 'storeSns', 'storeOpenDate', 'storeRemarks'];

const T = {
  ja: {
    title: 'ネット予約',
    loading: '読み込み中…',
    tabTop: 'トップ', tabMenu: 'メニュー・コース', tabPhoto: '写真', tabReview: '口コミ', tabMap: '地図・店舗情報',
    crumbHome: 'トップ', station: '最寄り', reservableYes: 'ネット予約可', reservablePhone: '電話予約のみ', hasCourse: 'コースあり',
    basicInfo: '店舗基本情報', quickHead: '空席確認・予約', quickNote: '日付をタップすると予約画面に進みます（○ 空きあり ／ × 満席 ／ 定休日）',
    seeCalendar: '空席カレンダーから予約する', callStore: '電話で問い合わせる', backToStore: '‹ 店舗ページに戻る',
    moreMenu: 'メニュー・コースをもっと見る', budgetDinner: '夜', budgetLunch: '昼', reserveContact: '予約・お問い合わせ', reservable: '予約可否', transport: '交通手段',
    googleReview: 'Google マップの口コミ', detailHead: '店舗情報（詳細）',
    photoCount(n) { return `写真 ${n}枚`; }, morePhotosN(n) { return `写真をもっと見る（${n}枚）`; }, paxUnit(n) { return `${n}名`; },
    extraLabels: { storePrivateRoom: '個室', storeCharter: '貸切', storeSmoking: '禁煙・喫煙', storeParking: '駐車場', storeFacilities: '空間・設備',
      storeDrink: 'ドリンク', storeFood: '料理', storeScene: '利用シーン', storeService: 'サービス', storeKids: 'お子様連れ',
      storeWebsite: 'ホームページ', storeSns: '公式アカウント', storeOpenDate: 'オープン日', storeRemarks: '備考' },
    reserveCta: 'ネット予約する', netReserve: 'ネット予約', call: '電話',
    aboutHead: 'お店について', infoHead: '店舗情報', mapHead: '地図', courseHead: 'コース', photoHead: '写真', reviewHead: '口コミ',
    latestReviews: '最新の口コミ', moreReviews: 'すべての口コミを見る', morePhotos: '写真をもっと見る', moreCourses: 'コース一覧を見る', moreInfo: '店舗情報を見る',
    ratingLabel: 'Google 評価', reviewsCount(n) { return `${n}件の口コミ`; }, ratingNone: '評価なし',
    viewOnGoogle: 'Googleマップで見る', reviewNoteSetup: '口コミ・評価は Google マップから取得して表示します。（店舗側で Google の Place ID と API キーを設定すると表示されます）',
    reviewLoading: '口コミを読み込み中…', reviewError: '口コミを取得できませんでした。しばらくしてからもう一度お試しください。', reviewNone: 'まだ口コミがありません',
    poweredGoogle: '口コミ・評価・一部の写真は Google 提供', readMore: '続きを読む', photoBy: '写真:',
    noCourses: 'コースは準備中です。お席のみのご予約を承ります。', noPhotos: '写真は準備中です', reserveWithCourse: 'このコースで予約',
    infoName: '店名', genre: 'ジャンル', phone: '電話番号', address: '住所', access: 'アクセス', hours: '営業時間', closedDays: '定休日',
    budget: '予算', seats: '席数', payment: 'お支払い', noClosed: '定休日なし', seatsUnit(n) { return `${n}席`; }, dash: '—',
    /* 予約フロー */
    bookTab: '予約する', lookupTab: '予約の確認・キャンセル',
    stepDatetime: '日時・人数', stepCourse: 'コース選択', stepInfo: 'お客様情報', stepConfirm: '確認',
    condHead: '来店日・人数・時間', visitDate: '来店日', anyTime: '指定なし', checkAvail: '空席を確認する', availHead: '空席カレンダー',
    legendPlenty: '空席あり', legendFew: '残りわずか', timeNote: '時間をタップするとコース選択に進みます', change: '変更',
    seatOnly: '席のみ予約', seatOnlyDesc: 'コースを選ばず、お席だけをご予約いただけます', reserveBtn: '予約する', childrenOf: 'うちお子様',
    agree: '上記の注意事項に同意する', agreeRequired: '注意事項への同意にチェックを入れてください',
    defaultNotes: 'ご予約時間を15分過ぎてもご連絡がない場合は、キャンセルとさせていただくことがあります。人数・時間の変更は「予約の確認・キャンセル」からキャンセル後、改めてご予約ください。',
    toConfirm: '予約内容を確認する', confirmBtn: '予約を確定する',
    timesFor(d) { return `${d} の空席状況`; }, courseFor(n) { return `× ${n}名`; },
    prevWeek: '前の週', nextWeek: '次の週', legendNa: '受付なし', cellNote: '◎・△ をタップすると、その日時で次に進みます。左右にスクロールすると他の日も確認できます。',
    date: '日付', pax: '人数', adults: '大人', children: '子供', time: '時間',
    legendOpen: '空きあり', legendFull: '満席', legendClosed: '定休日',
    next: '次へ', back: '戻る',
    noCourse: 'コースなし（お席のみ）', courseNote: 'コースはご希望の場合のみお選びください。数量はご来店人数に合わせて調整できます。',
    qty: '数量',
    name: 'お名前', kana: 'フリガナ', email: 'メールアドレス',
    purpose: 'ご利用目的', purposeNone: '指定なし', memo: 'ご要望（アレルギー・お席のご希望など）',
    requiredNote: '※ は必須項目です', required: '必須項目を入力してください',
    invalidPhone: '電話番号は数字10桁以上で入力してください', invalidEmail: 'メールアドレスの形式が正しくありません',
    confirmHead: 'ご予約内容の確認', notesHead: 'ご来店にあたって', submit: 'この内容で予約する',
    done: 'ご予約を受け付けました', doneSub: 'ご来店を心よりお待ちしております。',
    resNo: '予約番号', keepCode: '予約の確認・キャンセルには、ご予約時の電話番号とこの予約番号が必要です。スクリーンショット等で控えをお取りください。',
    toLookup: '予約内容を確認・キャンセルする', newBooking: '新しい予約をする',
    lookupNote: 'ご予約時の電話番号と予約番号を入力してください。', search: '検索',
    notFound: '該当するご予約が見つかりませんでした。電話番号と予約番号をご確認ください。',
    cancelRes: 'この予約をキャンセルする', cancelConfirm: 'この予約をキャンセルします。よろしいですか？', cancelDone: 'ご予約をキャンセルしました',
    closed: '現在ネット予約を受け付けておりません。お電話にてお問い合わせください。', noData: 'ただいま準備中です。',
    closedDay: '定休日のためご予約いただけません。別の日をお選びください。',
    noSlot: '選択できる時間がありません。別の日をお選びください。',
    taken: '申し訳ありません、その時間は埋まりました。別の時間をお選びください。',
    course: 'コース', channel: '予約経路',
    stayNote(n) { return `お席は${n / 60}時間制です`; },
    monthsNote(n) { return `${n}か月先までご予約いただけます`; },
    pax_(a, c) { return c ? `大人${a}名・子供${c}名` : `${a}名`; },
    fmtDate(y, m, d, wd) { return `${y}年${m}月${d}日（${I18N.ja.weekdays[wd]}）`; },
    fmtMonth(y, m) { return `${y}年${m}月`; },
    status: { reserved: '予約済', seated: 'ご来店中', finished: 'ご来店済', noshow: '不来店', cancelled: 'キャンセル済' },
    powered: '予約台帳 ネット予約',
  },
  vi: {
    title: 'Đặt bàn trực tuyến',
    loading: 'Đang tải…',
    tabTop: 'Trang chủ', tabMenu: 'Thực đơn & Course', tabPhoto: 'Ảnh', tabReview: 'Đánh giá', tabMap: 'Bản đồ & Thông tin',
    crumbHome: 'Trang chủ', station: 'Ga gần nhất', reservableYes: 'Đặt bàn online', reservablePhone: 'Chỉ đặt qua điện thoại', hasCourse: 'Có course',
    basicInfo: 'Thông tin cơ bản', quickHead: 'Kiểm tra chỗ trống & đặt bàn', quickNote: 'Chạm vào ngày để đến màn hình đặt bàn (○ còn chỗ / × hết chỗ / ngày nghỉ)',
    seeCalendar: 'Đặt bàn từ lịch chỗ trống', callStore: 'Gọi điện cho quán', backToStore: '‹ Về trang cửa hàng',
    moreMenu: 'Xem thêm thực đơn & course', budgetDinner: 'Tối', budgetLunch: 'Trưa', reserveContact: 'Đặt bàn / Liên hệ', reservable: 'Đặt bàn', transport: 'Đường đi',
    googleReview: 'Đánh giá trên Google Maps', detailHead: 'Thông tin cửa hàng (chi tiết)',
    photoCount(n) { return `${n} ảnh`; }, morePhotosN(n) { return `Xem thêm ảnh (${n})`; }, paxUnit(n) { return `${n} khách`; },
    extraLabels: { storePrivateRoom: 'Phòng riêng', storeCharter: 'Bao trọn quán', storeSmoking: 'Hút thuốc', storeParking: 'Bãi đỗ xe', storeFacilities: 'Không gian & tiện nghi',
      storeDrink: 'Đồ uống', storeFood: 'Món ăn', storeScene: 'Dịp sử dụng', storeService: 'Dịch vụ', storeKids: 'Trẻ em',
      storeWebsite: 'Website', storeSns: 'Tài khoản chính thức', storeOpenDate: 'Ngày khai trương', storeRemarks: 'Ghi chú' },
    reserveCta: 'Đặt bàn trực tuyến', netReserve: 'Đặt bàn trực tuyến', call: 'Gọi',
    aboutHead: 'Về cửa hàng', infoHead: 'Thông tin cửa hàng', mapHead: 'Bản đồ', courseHead: 'Course', photoHead: 'Ảnh', reviewHead: 'Đánh giá',
    latestReviews: 'Đánh giá mới nhất', moreReviews: 'Xem tất cả đánh giá', morePhotos: 'Xem thêm ảnh', moreCourses: 'Xem danh sách course', moreInfo: 'Xem thông tin cửa hàng',
    ratingLabel: 'Điểm Google', reviewsCount(n) { return `${n} đánh giá`; }, ratingNone: 'Chưa có điểm',
    viewOnGoogle: 'Xem trên Google Maps', reviewNoteSetup: 'Đánh giá được lấy từ Google Maps. (Cửa hàng cần cài đặt Place ID và API key của Google)',
    reviewLoading: 'Đang tải đánh giá…', reviewError: 'Không tải được đánh giá. Vui lòng thử lại sau.', reviewNone: 'Chưa có đánh giá',
    poweredGoogle: 'Đánh giá, điểm và một số ảnh do Google cung cấp', readMore: 'Xem thêm', photoBy: 'Ảnh:',
    noCourses: 'Course đang chuẩn bị. Có thể đặt bàn không kèm course.', noPhotos: 'Ảnh đang chuẩn bị', reserveWithCourse: 'Đặt bàn với course này',
    infoName: 'Tên quán', genre: 'Loại hình', phone: 'Số điện thoại', address: 'Địa chỉ', access: 'Đường đi', hours: 'Giờ mở cửa', closedDays: 'Ngày nghỉ',
    budget: 'Ngân sách', seats: 'Số chỗ', payment: 'Thanh toán', noClosed: 'Không nghỉ cố định', seatsUnit(n) { return `${n} chỗ`; }, dash: '—',
    bookTab: 'Đặt bàn', lookupTab: 'Kiểm tra / Hủy đặt bàn',
    stepDatetime: 'Ngày giờ & số khách', stepCourse: 'Chọn course', stepInfo: 'Thông tin khách', stepConfirm: 'Xác nhận',
    condHead: 'Ngày đến · Số khách · Giờ', visitDate: 'Ngày đến', anyTime: 'Không chỉ định', checkAvail: 'Kiểm tra chỗ trống', availHead: 'Lịch chỗ trống',
    legendPlenty: 'Còn chỗ', legendFew: 'Sắp hết', timeNote: 'Chạm vào giờ để chọn course', change: 'Đổi',
    seatOnly: 'Chỉ đặt bàn', seatOnlyDesc: 'Đặt bàn không kèm course', reserveBtn: 'Đặt bàn', childrenOf: 'Trong đó trẻ em',
    agree: 'Tôi đồng ý với các lưu ý trên', agreeRequired: 'Vui lòng đánh dấu đồng ý với lưu ý',
    defaultNotes: 'Nếu quá 15 phút so với giờ đặt mà không liên lạc, đặt bàn có thể bị hủy. Để đổi số khách hoặc giờ, vui lòng hủy ở mục "Kiểm tra / Hủy đặt bàn" rồi đặt lại.',
    toConfirm: 'Xác nhận nội dung', confirmBtn: 'Hoàn tất đặt bàn',
    timesFor(d) { return `Chỗ trống ngày ${d}`; }, courseFor(n) { return `× ${n} khách`; },
    prevWeek: 'Tuần trước', nextWeek: 'Tuần sau', legendNa: 'Không nhận', cellNote: 'Chạm vào ◎ hoặc △ để chọn ngày giờ đó. Cuộn ngang để xem các ngày khác.',
    date: 'Ngày', pax: 'Số khách', adults: 'Người lớn', children: 'Trẻ em', time: 'Giờ',
    legendOpen: 'Còn chỗ', legendFull: 'Hết chỗ', legendClosed: 'Ngày nghỉ',
    next: 'Tiếp', back: 'Quay lại',
    noCourse: 'Không chọn course (chỉ đặt bàn)', courseNote: 'Chỉ chọn course nếu quý khách muốn. Có thể điều chỉnh số lượng theo số khách.',
    qty: 'Số lượng',
    name: 'Tên khách', kana: 'Tên (phiên âm)', email: 'Email',
    purpose: 'Mục đích', purposeNone: 'Không chỉ định', memo: 'Yêu cầu (dị ứng, vị trí bàn...)',
    requiredNote: '※ là mục bắt buộc', required: 'Vui lòng nhập các mục bắt buộc',
    invalidPhone: 'Số điện thoại cần ít nhất 10 chữ số', invalidEmail: 'Email không đúng định dạng',
    confirmHead: 'Xác nhận nội dung đặt bàn', notesHead: 'Lưu ý khi đến quán', submit: 'Xác nhận đặt bàn',
    done: 'Đã nhận đặt bàn!', doneSub: 'Rất mong được đón tiếp quý khách.',
    resNo: 'Mã đặt bàn', keepCode: 'Để kiểm tra hoặc hủy, cần số điện thoại đã đăng ký và mã đặt bàn này. Vui lòng chụp màn hình lưu lại.',
    toLookup: 'Kiểm tra / hủy đặt bàn', newBooking: 'Đặt bàn mới',
    lookupNote: 'Nhập số điện thoại đã đăng ký và mã đặt bàn.', search: 'Tìm',
    notFound: 'Không tìm thấy đặt bàn phù hợp. Vui lòng kiểm tra lại số điện thoại và mã.',
    cancelRes: 'Hủy đặt bàn này', cancelConfirm: 'Hủy đặt bàn này?', cancelDone: 'Đã hủy đặt bàn',
    closed: 'Hiện không nhận đặt bàn trực tuyến. Vui lòng gọi điện cho cửa hàng.', noData: 'Đang chuẩn bị.',
    closedDay: 'Ngày nghỉ của cửa hàng, không nhận đặt bàn. Vui lòng chọn ngày khác.',
    noSlot: 'Không có khung giờ trống. Vui lòng chọn ngày khác.',
    taken: 'Rất tiếc, khung giờ đó vừa kín. Vui lòng chọn giờ khác.',
    course: 'Course', channel: 'Kênh',
    stayNote(n) { return `Thời gian sử dụng bàn: ${n / 60} giờ`; },
    monthsNote(n) { return `Có thể đặt trước tối đa ${n} tháng`; },
    pax_(a, c) { return c ? `${a} người lớn, ${c} trẻ em` : `${a} khách`; },
    fmtDate(y, m, d, wd) { return `${I18N.vi.weekdays[wd]}, ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`; },
    fmtMonth(y, m) { return `Tháng ${m}/${y}`; },
    status: { reserved: 'Đã đặt', seated: 'Đang tại bàn', finished: 'Đã đến', noshow: 'Không đến', cancelled: 'Đã hủy' },
    powered: 'Sổ đặt bàn - Đặt bàn trực tuyến',
  },
};

/* ---------- 状態 ---------- */
let lang = (() => { try { return localStorage.getItem(LANG_KEY) === 'vi' ? 'vi' : 'ja'; } catch (e) { return 'ja'; } })();
let view = (location.hash || '') === '#reserve' ? 'reserve' : 'store';   // 'store'（店舗ページ） | 'reserve'（予約画面）
let tab = 'top';
let mode = 'book';          // 予約タブ内: 'book' | 'lookup'
let stepIdx = 0;
let doneRes = null;
let calYM = null;
const sel = {
  date: todayStr(), adults: 2, children: 0, time: null,
  courseId: '',             // 選択コース（'' = 席のみ）
  agree: false,             // 注意事項への同意
  name: '', kana: '', phone: '', email: '', purpose: '', memo: '',
};
const lookup = { phone: '', code: '', results: null, msg: '', msgOk: false };
const google = { status: 'idle', data: null, key: '' };   // Google マップ連携の取得状態

/* ---------- helpers ---------- */
function t(k) { return T[lang][k] ?? T.ja[k] ?? k; }
function tr() { return T[lang]; }
function pad2(n) { return String(n).padStart(2, '0'); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function fmtTime(min) { return `${pad2(Math.floor(min / 60))}:${pad2(min % 60)}`; }
function uid() { return 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function normPhone(p) { return String(p || '').replace(/\D/g, ''); }
function fmtYmd(date) { const [y, m, d] = date.split('-').map(Number); return tr().fmtDate(y, m, d, new Date(y, m - 1, d).getDay()); }
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const rnd = new Uint32Array(6);
  (window.crypto || window.msCrypto).getRandomValues(rnd);
  for (let i = 0; i < 6; i++) s += chars[rnd[i] % chars.length];
  return s;
}
function totalPax() { return sel.adults + sel.children; }
function safeUrl(u) { return /^https?:\/\//i.test(String(u || '').trim()) ? String(u).trim() : ''; }

/* 店舗ごとのデータキー: URL の ?store= を優先し、無ければ台帳で表示中の店舗、それも無ければ旧形式 */
const storeParam = new URLSearchParams(location.search).get('store');
function dataKeyName() {
  if (storeParam) return `${LS_KEY}:${storeParam}`;
  try { const reg = JSON.parse(localStorage.getItem(LS_REGISTRY)); if (reg && reg.currentId) return `${LS_KEY}:${reg.currentId}`; } catch (e) { /* ignore */ }
  return LS_KEY;
}
/* クラウド時: 店舗の公開情報＋期間内の占有状況（個人情報なし）をキャッシュして同期的に使う */
let cloudSt = null;
let cloudErr = '';
async function refreshCloud() {
  if (!storeParam) { cloudSt = null; cloudErr = 'nostore'; return; }
  const [store, occ] = await Promise.all([Cloud.bookingStore(storeParam), Cloud.bookingOccupancy(storeParam, todayStr(), maxDateStr())]);
  if (!store) { cloudSt = null; cloudErr = 'nostore'; return; }
  cloudErr = '';
  cloudSt = { settings: store.settings || {}, tables: store.tables || [], sites: store.sites || [], courses: store.courses || [], combos: store.combos || [], reservations: occ };
}
function db() {
  if (Cloud.enabled) return cloudSt;
  try { return JSON.parse(localStorage.getItem(dataKeyName())); } catch (e) { return null; }
}
function saveDb(st) { localStorage.setItem(dataKeyName(), JSON.stringify(st)); }
/* 店舗設定。台帳で未入力の項目は Google マップの情報（取得済みのとき）で補完する */
function settings(st) {
  const s = (st && st.settings) || {};
  const inf = google.status === 'ok' && google.data && google.data.info;
  if (!inf) return s;
  const merged = Object.assign({}, inf);
  Object.keys(s).forEach((k) => { if (s[k] !== '' && s[k] != null) merged[k] = s[k]; });
  return merged;
}

const siteParam = new URLSearchParams(location.search).get('site');
function ownSite(st) {
  const sites = st.sites || [];
  return sites.find((s) => s.id === siteParam) || sites.find((s) => s.own);
}

function isClosed(st, date) {
  const s = settings(st);
  const [y, m, d] = date.split('-').map(Number);
  const wd = new Date(y, m - 1, d).getDay();
  return (s.closedDays || []).includes(wd) || (s.closedDates || []).includes(date);
}
function closedDaysText(st) {
  const days = settings(st).closedDays || [];
  return days.length ? days.map((d) => I18N[lang].weekdays[d]).join('・') : t('noClosed');
}
function hoursText(st) {
  const s = settings(st);
  if (s.storeHours) return s.storeHours;
  return `${fmtTime(s.openMin || 0)}〜${fmtTime(s.closeMin || 0)}`;
}
function totalSeats(st) { return (st.tables || []).reduce((a, tb) => a + (tb.seats || 0), 0); }
function storePhotos(st) {
  return String(settings(st).storePhotos || '').split(/\r?\n/).map(safeUrl).filter(Boolean);
}
function allPhotos(st) {
  const own = storePhotos(st).map((u) => ({ url: u, g: false }));
  const g = google.status === 'ok' && google.data ? google.data.photos.map((p) => ({ ...p, g: true })) : [];
  return [...own, ...g];
}
/* Google 写真の帰属表示（投稿者名・プロフィールへのリンク） */
function photoCreditHtml(p) {
  if (!p.g) return '';
  const who = p.author ? (p.authorUri ? `<a href="${esc(p.authorUri)}" target="_blank" rel="noopener">${esc(p.author)}</a>` : esc(p.author)) : 'Google';
  return `${esc(t('photoBy'))} ${who}`;
}
function mapEmbedUrl(st) {
  const s = settings(st);
  const q = s.googlePlaceId ? `place_id:${s.googlePlaceId}` : (s.storeAddress || s.storeName || '');
  return q ? `https://www.google.com/maps?q=${encodeURIComponent(q)}&hl=${lang}&output=embed` : '';
}
function googleMapsLink(st) {
  const s = settings(st);
  if (google.data && google.data.mapsUri) return google.data.mapsUri;
  if (s.googlePlaceId) return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(s.googlePlaceId)}`;
  const q = [s.storeName, s.storeAddress].filter(Boolean).join(' ');
  return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : '';
}

function slotsFor(st) {
  const { openMin, closeMin } = st.settings;
  const out = [];
  for (let m = openMin; m <= closeMin - DUR; m += 30) out.push(m);
  return out;
}
function nowMin() { const n = new Date(); return n.getHours() * 60 + n.getMinutes(); }
function isPastSlot(date, start) { return date === todayStr() && start < nowMin(); }

/* 指定日時・人数で確保するテーブルを決定（1卓 → 結合テーブルの順）。空きがなければ null */
function findAssignment(st, site, date, start, pax) {
  const actives = st.reservations.filter((r) => r.date === date && r.status !== 'cancelled' && r.status !== 'noshow');
  const isFree = (id) => !actives.some((r) => (r.tableIds || []).includes(id) && r.start < start + DUR && start < r.start + r.duration);
  const linked = new Set(site.tableIds || []);
  const singles = st.tables.filter((tb) => linked.has(tb.id) && tb.seats >= pax && (tb.min || 1) <= pax && isFree(tb.id));
  if (singles.length) {
    singles.sort((a, b) => a.seats - b.seats);
    return [singles[0].id];
  }
  const combos = (st.combos || []).filter((c) =>
    (c.max || 0) >= pax && (c.min || 1) <= pax && c.tableIds.length >= 2 &&
    c.tableIds.every((id) => linked.has(id) && st.tables.some((tb) => tb.id === id) && isFree(id)));
  if (combos.length) {
    combos.sort((a, b) => a.max - b.max);
    return [...combos[0].tableIds];
  }
  return null;
}
function dayHasAvailability(st, site, date, pax) {
  return slotsFor(st).some((m) => !isPastSlot(date, m) && !!findAssignment(st, site, date, m, pax));
}
function maxDateStr() {
  const d = new Date();
  d.setMonth(d.getMonth() + MAX_MONTHS);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
/* ---------- Google マップ連携（Places API (New)） ---------- */
function loadGoogle(st) {
  const s = settings(st);
  const placeId = String(s.googlePlaceId || '').trim();
  const key = String(s.googleApiKey || '').trim();
  if (!placeId || !key) { google.status = 'none'; google.data = null; return; }
  const cacheId = `${placeId}|${lang}`;
  if (google.key === cacheId && google.status !== 'idle') return;
  google.key = cacheId;
  try {
    const c = JSON.parse(localStorage.getItem(GCACHE_KEY));
    if (c && c.key === cacheId && Date.now() - c.at < GCACHE_TTL) { google.data = c.data; google.status = 'ok'; return; }
  } catch (e) { /* ignore */ }
  google.status = 'loading';
  fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?languageCode=${encodeURIComponent(lang)}`, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': GOOGLE_PLACE_FIELDS,
    },
  })
    .then((res) => { if (!res.ok) throw new Error('HTTP ' + res.status); return res.json(); })
    .then((data) => {
      google.data = {
        rating: data.rating ?? null,
        count: data.userRatingCount ?? 0,
        mapsUri: safeUrl(data.googleMapsUri),
        info: googlePlaceToInfo(data, lang),   // 住所・電話・営業時間などの補完用
        reviews: (data.reviews || []).map((r) => ({
          author: r.authorAttribution?.displayName || '',
          authorUri: safeUrl(r.authorAttribution?.uri),
          photo: safeUrl(r.authorAttribution?.photoUri),
          rating: r.rating || 0,
          text: r.text?.text || r.originalText?.text || '',
          when: r.relativePublishTimeDescription || '',
          uri: safeUrl(r.googleMapsUri),
        })),
        // 写真は投稿者の帰属表示（authorAttributions）付きで保持する
        photos: (data.photos || []).slice(0, MAX_GOOGLE_PHOTOS).map((p) => ({
          url: `https://places.googleapis.com/v1/${p.name}/media?maxWidthPx=900&key=${encodeURIComponent(key)}`,
          author: p.authorAttributions?.[0]?.displayName || '',
          authorUri: safeUrl(p.authorAttributions?.[0]?.uri),
        })),
      };
      google.status = 'ok';
      try { localStorage.setItem(GCACHE_KEY, JSON.stringify({ key: cacheId, at: Date.now(), data: google.data })); } catch (e) { /* ignore */ }
      render();
    })
    .catch(() => { google.status = 'error'; render(); });
}

function starsHtml(rating) {
  const r = Number(rating) || 0;
  let html = '<span class="stars" aria-hidden="true">';
  for (let i = 1; i <= 5; i++) {
    if (r >= i - 0.25) html += '<span>★</span>';
    else if (r >= i - 0.75) html += '<span class="h">★</span>';
    else html += '<span class="e">★</span>';
  }
  return html + '</span>';
}

/* ---------- 描画 ---------- */
function render() {
  if (Cloud.enabled && !cloudSt && !cloudErr) { document.getElementById('content').innerHTML = `<div class="closed">${esc(t('loading'))}</div>`; return; }
  const st = db();
  document.documentElement.lang = lang;
  const s = settings(st);
  document.title = (s.storeName ? s.storeName + ' | ' : '') + t('title');
  document.querySelectorAll('#langSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.lang === lang));

  const photos = st ? allPhotos(st) : [];
  const counts = {
    menu: st ? (st.courses || []).length : 0,
    photo: photos.length,
    review: google.status === 'ok' && google.data ? (google.data.reviews || []).length : 0,
  };
  const tabLabels = { top: t('tabTop'), menu: t('tabMenu'), photo: t('tabPhoto'), review: t('tabReview'), map: t('tabMap') };
  document.querySelectorAll('#siteTabs button').forEach((b) => {
    const k = b.dataset.tab;
    b.innerHTML = esc(tabLabels[k]) + (counts[k] ? `<span class="cnt">${counts[k]}</span>` : '');
    b.classList.toggle('active', view === 'store' && k === tab);
  });
  document.getElementById('foot').textContent = t('powered') + (google.status === 'ok' ? '　·　' + t('poweredGoogle') : '');
  renderHeader(st);
  renderCta(st);

  const el = document.getElementById('content');
  const side = document.getElementById('side');
  if (!st) { el.innerHTML = `<div class="closed">${esc(t('noData'))}</div>`; side.innerHTML = ''; return; }
  loadGoogle(st);

  if (view === 'reserve') { side.innerHTML = ''; renderReserve(el, st); return; }

  // PC: 右カラムに空席確認・予約と店舗基本情報（スマホではトップ内に同じ内容を表示）
  side.innerHTML = quickReserveHtml(st) + basicInfoCardHtml(st);
  bindQuick(side, st);

  if (tab === 'top') renderTop(el, st);
  else if (tab === 'menu') renderMenuTab(el, st);
  else if (tab === 'photo') renderPhotoTab(el, st);
  else if (tab === 'review') renderReviewTab(el, st);
  else renderMapTab(el, st);
}

function renderHeader(st) {
  const s = settings(st);
  const site = st ? ownSite(st) : null;
  document.getElementById('crumb').innerHTML =
    [t('crumbHome'), s.storeGenre, s.storeName].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join('');
  document.getElementById('hTitle').textContent = s.storeName || t('title');
  document.getElementById('hKana').textContent = s.storeKana || '';

  const r = document.getElementById('hRating');
  if (google.status === 'ok' && google.data && google.data.rating != null) {
    r.innerHTML = `<span class="score">${google.data.rating.toFixed(1)}</span>${starsHtml(google.data.rating)}` +
      `<a href="${esc(googleMapsLink(st))}" target="_blank" rel="noopener"><span class="rc">${esc(t('tabReview'))}</span> ${esc(tr().reviewsCount(google.data.count))}</a>`;
  } else if (google.status === 'loading') {
    r.innerHTML = `<span>${esc(t('reviewLoading'))}</span>`;
  } else {
    r.innerHTML = '';
  }

  const meta = [];
  if (s.storeGenre) meta.push(`<span><span class="k">${esc(t('genre'))}</span>${esc(s.storeGenre)}</span>`);
  if (s.storeAccess) meta.push(`<span><span class="k">${esc(t('station'))}</span>${esc(s.storeAccess)}</span>`);
  if (s.storeBudget || s.storeBudgetLunch) {
    meta.push(`<span><span class="k">${esc(t('budget'))}</span>` +
      [s.storeBudget ? `🌙 ${esc(s.storeBudget)}` : '', s.storeBudgetLunch ? `☀️ ${esc(s.storeBudgetLunch)}` : ''].filter(Boolean).join('　') + `</span>`);
  }
  meta.push(`<span><span class="k">${esc(t('closedDays'))}</span>${esc(closedDaysText(st))}</span>`);
  document.getElementById('hMeta').innerHTML = meta.join('');

  const badges = [];
  if (site && site.enabled) badges.push(`<span class="badge">${esc(t('reservableYes'))}</span>`);
  else badges.push(`<span class="badge gray">${esc(t('reservablePhone'))}</span>`);
  if ((st && st.courses || []).length) badges.push(`<span class="badge gray">${esc(t('hasCourse'))}</span>`);
  if (site && !site.own) badges.push(`<span class="badge gray">${esc(t('channel'))}: ${esc(site.name)}</span>`);
  document.getElementById('hBadges').innerHTML = badges.join('');
}

function renderCta(st) {
  const s = settings(st);
  document.getElementById('ctaBar').hidden = view === 'reserve';
  document.getElementById('ctaReserve').textContent = t('reserveCta');
  const call = document.getElementById('ctaCall');
  if (s.storePhone) {
    call.hidden = false;
    call.href = 'tel:' + normPhone(s.storePhone);
    call.textContent = '📞 ' + t('call');
  } else {
    call.hidden = true;
  }
}

/* --- 写真カルーセル（トップ） --- */
function carouselHtml(st) {
  const photos = allPhotos(st);
  if (!photos.length) return `<div class="hero-placeholder">🍽</div>`;
  return `<div class="carousel-wrap"><div class="carousel">` +
    photos.map((p, i) => `<div class="car-item"><img src="${esc(p.url)}" data-photo="${i}" alt="" ${i > 1 ? 'loading="lazy"' : ''}>` +
      (p.g ? `<div class="car-cap">${photoCreditHtml(p)}</div>` : '') + `</div>`).join('') +
    `</div><button type="button" class="car-count" data-go="photo">📷 ${esc(tr().photoCount(photos.length))}</button></div>`;
}

/* --- 店舗基本情報（サマリー） --- */
function basicInfoCardHtml(st) {
  const s = settings(st);
  const rows = [
    ['🕒', t('hours'), hoursText(st)],
    ['🚫', t('closedDays'), closedDaysText(st)],
    ['📞', t('phone'), s.storePhone ? `<a href="tel:${esc(normPhone(s.storePhone))}">${esc(s.storePhone)}</a>` : '', true],
    ['💴', t('budget'), [s.storeBudget ? `${t('budgetDinner')} ${s.storeBudget}` : '', s.storeBudgetLunch ? `${t('budgetLunch')} ${s.storeBudgetLunch}` : ''].filter(Boolean).join(' / ')],
    ['📍', t('address'), s.storeAddress],
    ['🚃', t('access'), s.storeAccess],
  ].filter(([, , v]) => v);
  return `<div class="card"><h2>${esc(t('basicInfo'))}</h2><div class="basic">` +
    rows.map(([ic, k, v, raw]) => `<div class="b"><span class="ic">${ic}</span><span><span class="k">${esc(k)}</span>${raw ? v : esc(v)}</span></div>`).join('') +
    `</div></div>`;
}

function ratingCardHtml(st) {
  if (google.status === 'none') return '';
  if (google.status === 'loading') return `<div class="skeleton" style="width:40%"></div><div class="skeleton" style="width:70%"></div>`;
  if (google.status === 'error') return `<p class="hint">${esc(t('reviewError'))}</p>`;
  const d = google.data || {};
  return `<div class="rating-box">` +
    `<div class="big">${d.rating != null ? d.rating.toFixed(1) : '–'}</div>` +
    `<div class="rb-sub">${starsHtml(d.rating)}<br>${esc(t('ratingLabel'))}　${esc(tr().reviewsCount(d.count || 0))}` +
    `<br><a href="${esc(googleMapsLink(st))}" target="_blank" rel="noopener">${esc(t('viewOnGoogle'))} ›</a></div>` +
    `</div>`;
}

/* 口コミカード（投稿者・評価・本文・Googleへのリンク） */
function reviewHtml(rv, clip) {
  const avatar = rv.photo
    ? `<img class="rv-avatar" src="${esc(rv.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
    : `<div class="rv-avatar ph">${esc((rv.author || '?').charAt(0))}</div>`;
  const name = rv.authorUri ? `<a href="${esc(rv.authorUri)}" target="_blank" rel="noopener">${esc(rv.author)}</a>` : esc(rv.author);
  return `<div class="review"><div class="rv-head">${avatar}<div><div class="rv-name">${name}</div>` +
    `<div class="rv-sub">${esc(t('googleReview'))}</div></div></div>` +
    `<div class="rv-score"><b>${(Number(rv.rating) || 0).toFixed(1)}</b>${starsHtml(rv.rating)}<span>${esc(rv.when)}</span></div>` +
    (rv.text ? `<div class="rv-text${clip ? ' clip' : ''}">${esc(rv.text)}</div>` : '') +
    (clip && rv.text && rv.text.length > 80 ? `<button type="button" class="more-link" data-expand>${esc(t('readMore'))}</button>` : '') +
    (rv.uri ? `<div class="rv-foot"><span></span><a href="${esc(rv.uri)}" target="_blank" rel="noopener">${esc(t('viewOnGoogle'))} ›</a></div>` : '') +
    `</div>`;
}

function reviewsBlockHtml(st, limit) {
  if (google.status === 'none') return `<div class="review-note">${esc(t('reviewNoteSetup'))}` +
    (googleMapsLink(st) ? `<br><a href="${esc(googleMapsLink(st))}" target="_blank" rel="noopener">${esc(t('viewOnGoogle'))} ›</a></div>` : '</div>');
  if (google.status === 'loading') return `<div class="skeleton" style="width:60%"></div><div class="skeleton"></div><div class="skeleton" style="width:80%"></div>`;
  if (google.status === 'error') return `<div class="empty">${esc(t('reviewError'))}</div>`;
  const list = (google.data && google.data.reviews) || [];
  if (!list.length) return `<div class="empty">${esc(t('reviewNone'))}</div>`;
  return list.slice(0, limit || list.length).map((rv) => reviewHtml(rv, !!limit)).join('');
}

/* --- 店舗情報（詳細）テーブル --- */
function infoTableHtml(st) {
  const s = settings(st);
  const site = ownSite(st);
  const dash = t('dash');
  const link = (u) => safeUrl(u) ? `<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(u)}</a>` : esc(u);
  const budget = [s.storeBudget ? `<span class="sub-k">${esc(t('budgetDinner'))}</span>${esc(s.storeBudget)}` : '',
    s.storeBudgetLunch ? `<span class="sub-k">${esc(t('budgetLunch'))}</span>${esc(s.storeBudgetLunch)}` : ''].filter(Boolean).join('<br>');
  const rows = [
    [t('infoName'), esc(s.storeName || dash)],
    [t('genre'), esc(s.storeGenre || dash)],
    [t('reserveContact'), s.storePhone ? `<a href="tel:${esc(normPhone(s.storePhone))}">${esc(s.storePhone)}</a>` : dash],
    [t('reservable'), esc(site && site.enabled ? t('reservableYes') : t('reservablePhone'))],
    [t('address'), esc(s.storeAddress || dash)],
    [t('transport'), esc(s.storeAccess || dash)],
    [t('hours'), esc(hoursText(st))],
    [t('closedDays'), esc(closedDaysText(st))],
    [t('budget'), budget || dash],
    [t('payment'), esc(s.storePayment || dash)],
    [t('seats'), esc(tr().seatsUnit(totalSeats(st)))],
  ];
  const labels = tr().extraLabels;
  EXTRA_KEYS.forEach((k) => {
    if (!s[k]) return;
    const v = (k === 'storeWebsite' || k === 'storeSns') ? link(s[k]) : esc(s[k]);
    rows.push([labels[k] || k, v]);
  });
  return `<table class="info-table">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`).join('')}</table>`;
}

function mapHtml(st) {
  const url = mapEmbedUrl(st);
  if (!url) return '';
  return `<div class="card"><h2>${esc(t('mapHead'))}</h2>` +
    (settings(st).storeAddress ? `<p class="hint" style="margin-bottom:8px">📍 ${esc(settings(st).storeAddress)}</p>` : '') +
    `<iframe class="map" src="${esc(url)}" loading="lazy" referrerpolicy="no-referrer-when-downgrade" allowfullscreen></iframe>` +
    (googleMapsLink(st) ? `<p style="margin-top:8px"><a class="link-btn" href="${esc(googleMapsLink(st))}" target="_blank" rel="noopener">${esc(t('viewOnGoogle'))} ›</a></p>` : '') + `</div>`;
}

function courseItemHtml(c) {
  return `<div class="course-item"><div class="ci-head"><div class="ci-name">${esc(c.name)}</div>` +
    (c.price ? `<div class="ci-price">${esc(c.price)}</div>` : '') + `</div>` +
    (c.desc ? `<div class="ci-desc">${esc(c.desc)}</div>` : '') +
    `<div class="ci-act"><button type="button" class="btn-sm solid" data-course-reserve="${esc(c.id)}">${esc(t('reserveWithCourse'))}</button></div></div>`;
}

/* --- トップ --- */
function renderTop(el, st) {
  const s = settings(st);
  const courses = st.courses || [];
  const photos = allPhotos(st);
  let html = carouselHtml(st);
  // スマホ: 店舗基本情報 → 空席確認・予約（PCは右カラム）
  html += `<div class="inline-side">${basicInfoCardHtml(st)}${quickReserveHtml(st)}</div>`;
  if (s.storeCatch || s.storeDescription) {
    html += `<div class="card"><h2>${esc(t('aboutHead'))}</h2>` +
      (s.storeCatch ? `<div class="catch">${esc(s.storeCatch)}</div>` : '') +
      (s.storeDescription ? `<div class="desc">${esc(s.storeDescription)}</div>` : '') + `</div>`;
  }
  if (courses.length) {
    html += `<div class="card"><h2>${esc(t('tabMenu'))}</h2>` + courses.slice(0, 3).map((c) => courseItemHtml(c)).join('') +
      (courses.length > 3 ? `<button type="button" class="more-btn" data-go="menu">${esc(t('moreMenu'))} ›</button>` : '') + `</div>`;
  }
  html += `<div class="card"><h2>${esc(t('reviewHead'))}` +
    (google.status === 'ok' && google.data ? `<span class="sub">${esc(tr().reviewsCount(google.data.count || 0))}</span>` : '') + `</h2>` +
    ratingCardHtml(st) + reviewsBlockHtml(st, 3) +
    (google.status === 'ok' ? `<button type="button" class="more-btn" data-go="review">${esc(t('moreReviews'))} ›</button>` : '') + `</div>`;
  if (photos.length) {
    html += `<div class="card"><h2>${esc(t('photoHead'))}<span class="sub">${esc(tr().photoCount(photos.length))}</span></h2>` +
      `<div class="photo-grid">${photos.slice(0, 6).map((p, i) => `<div class="${p.g ? 'g' : ''}"><img src="${esc(p.url)}" data-photo="${i}" alt="" loading="lazy">` +
        (p.g ? `<div class="pcap">${photoCreditHtml(p)}</div>` : '') + `</div>`).join('')}</div>` +
      (photos.length > 6 ? `<button type="button" class="more-btn" data-go="photo">${esc(tr().morePhotosN(photos.length))} ›</button>` : '') + `</div>`;
  }
  html += `<div class="card"><h2>${esc(t('detailHead'))}</h2>${infoTableHtml(st)}</div>`;
  html += mapHtml(st);
  el.innerHTML = html;
  bindCommon(el, st);
  bindQuick(el, st);
}

/* --- メニュー・コース --- */
function renderMenuTab(el, st) {
  const courses = st.courses || [];
  el.innerHTML = `<div class="card"><h2>${esc(t('tabMenu'))}</h2>` +
    (courses.length ? courses.map((c) => courseItemHtml(c)).join('') : `<div class="empty">${esc(t('noCourses'))}</div>`) + `</div>`;
  bindCommon(el, st);
}

/* --- 写真 --- */
function renderPhotoTab(el, st) {
  const photos = allPhotos(st);
  el.innerHTML = `<div class="card"><h2>${esc(t('photoHead'))}<span class="sub">${esc(tr().photoCount(photos.length))}</span></h2>` +
    (photos.length ? `<div class="photo-grid">${photos.map((p, i) =>
      `<div class="${p.g ? 'g' : ''}"><img src="${esc(p.url)}" data-photo="${i}" alt="" loading="lazy">` +
      (p.g ? `<div class="pcap">${photoCreditHtml(p)}</div>` : '') + `</div>`).join('')}</div>` +
      (photos.some((p) => p.g) ? `<div class="g-badge">${esc(t('poweredGoogle'))}</div>` : '')
      : `<div class="empty">${esc(t('noPhotos'))}</div>`) + `</div>`;
  bindCommon(el, st);
}

/* --- 口コミ --- */
function renderReviewTab(el, st) {
  el.innerHTML = `<div class="card"><h2>${esc(t('reviewHead'))}</h2>${ratingCardHtml(st)}${reviewsBlockHtml(st, 0)}` +
    (google.status === 'ok' && googleMapsLink(st) ? `<p style="margin-top:12px"><a class="link-btn" href="${esc(googleMapsLink(st))}" target="_blank" rel="noopener">${esc(t('viewOnGoogle'))} ›</a></p>` : '') +
    (google.status === 'ok' ? `<div class="g-badge">${esc(t('poweredGoogle'))}</div>` : '') + `</div>`;
  bindCommon(el, st);
}

/* --- 地図・店舗情報 --- */
function renderMapTab(el, st) {
  el.innerHTML = mapHtml(st) + `<div class="card"><h2>${esc(t('detailHead'))}</h2>${infoTableHtml(st)}</div>`;
  bindCommon(el, st);
}

/* 店舗ページ共通のイベント */
function bindCommon(el) {
  el.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  el.querySelectorAll('[data-course-reserve]').forEach((b) => b.addEventListener('click', () => {
    sel.courseId = b.dataset.courseReserve;
    resetFlowPosition();
    calYM = null;
    openReserve();
  }));
  el.querySelectorAll('[data-photo]').forEach((img) => img.addEventListener('click', () => {
    const p = allPhotos(db())[Number(img.dataset.photo)];
    openLightbox(img.src, p ? photoCreditHtml(p) : '');
  }));
  el.querySelectorAll('[data-expand]').forEach((b) => b.addEventListener('click', () => {
    b.previousElementSibling.classList.remove('clip');
    b.remove();
  }));
}

function openLightbox(src, captionHtml) {
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `<img src="${esc(src)}" alt="">` + (captionHtml ? `<div class="lb-cap">${captionHtml}</div>` : '');
  lb.addEventListener('click', (e) => { if (!e.target.closest('a')) lb.remove(); });
  document.body.appendChild(lb);
}

function go(target) { if (target === 'reserve') openReserve(); else setTab(target); }
function setTab(next) {
  closeCalModal();
  view = 'store';
  tab = TABS.includes(next) ? next : 'top';
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  render();
  window.scrollTo(0, 0);
}
function openReserve() {
  view = 'reserve';
  if (mode === 'lookup' && !lookup.results) mode = 'book';
  try { history.replaceState(null, '', '#reserve'); } catch (e) { /* ignore */ }
  render();
  window.scrollTo(0, 0);
}
function resetFlowPosition() { doneRes = null; stepIdx = 0; mode = 'book'; }

/* ======================= 予約画面（食べログ風）=======================
 * 店舗ページの「ネット予約」パネルで 来店日・人数・時間 を選び「空席を確認する」
 *  → 空席カレンダー（◎ 空席あり／△ 残りわずか／× 満席／休 定休日）と当日の時間一覧
 *  → 時間をタップ → コース選択（席のみ予約 or コースの「予約する」）
 *  → 予約内容の入力（注意事項への同意） → 確認「予約を確定する」 → 完了（予約番号）
 */
function stepKeys(st) {
  const keys = ['datetime'];
  if ((st.courses || []).length) keys.push('course');
  keys.push('info', 'confirm');
  return keys;
}
function gotoStep(st, key) {
  const keys = stepKeys(st);
  stepIdx = Math.max(0, keys.indexOf(key));
  render();
  window.scrollTo(0, 0);
}

/* 指定日時・人数で選べる席の候補数（1卓＋結合テーブル）。0 = 満席 */
function freeOptions(st, site, date, start, pax) {
  const actives = st.reservations.filter((r) => r.date === date && r.status !== 'cancelled' && r.status !== 'noshow');
  const isFree = (id) => !actives.some((r) => (r.tableIds || []).includes(id) && r.start < start + DUR && start < r.start + r.duration);
  const linked = new Set(site.tableIds || []);
  let n = st.tables.filter((tb) => linked.has(tb.id) && tb.seats >= pax && (tb.min || 1) <= pax && isFree(tb.id)).length;
  n += (st.combos || []).filter((c) =>
    (c.max || 0) >= pax && (c.min || 1) <= pax && c.tableIds.length >= 2 &&
    c.tableIds.every((id) => linked.has(id) && st.tables.some((tb) => tb.id === id) && isFree(id))).length;
  return n;
}
/* 時間枠の空席記号 */
function slotMark(n) { return n >= 2 ? { mark: '◎', cls: 'plenty' } : n === 1 ? { mark: '△', cls: 'few' } : { mark: '×', cls: 'full' }; }
/* 日付の空席記号（時間指定ありはその時間、指定なしは一日の空き枠数で判定） */
function dayMark(st, site, date, pax, time) {
  const today = todayStr();
  if (date < today || date > maxDateStr()) return { mark: '－', cls: 'na', ok: false };
  if (isClosed(st, date)) return { mark: t('legendClosed'), cls: 'closed', ok: false };
  if (time != null) {
    if (isPastSlot(date, time)) return { mark: '×', cls: 'full', ok: false };
    const n = freeOptions(st, site, date, time, pax);
    return { ...slotMark(n), ok: n > 0 };
  }
  const slots = slotsFor(st).filter((m) => !isPastSlot(date, m));
  const free = slots.filter((m) => freeOptions(st, site, date, m, pax) > 0).length;
  if (!free) return { mark: '×', cls: 'full', ok: false };
  if (free <= 2 || free <= slots.length / 4) return { mark: '△', cls: 'few', ok: true };
  return { mark: '◎', cls: 'plenty', ok: true };
}
function fmtMd(date) {
  const [y, m, d] = date.split('-').map(Number);
  return `${m}/${d}(${I18N[lang].weekdays[new Date(y, m - 1, d).getDay()]})`;
}
function dateOptions() {
  const out = [];
  const max = maxDateStr();
  const d = new Date();
  for (let i = 0; i < 120; i++) {
    const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    if (date > max) break;
    out.push(date);
    d.setDate(d.getDate() + 1);
  }
  return out;
}
/* 来店日（カレンダー）・人数・時間のパネル（店舗ページのネット予約パネルと、予約画面の「日時・人数」ステップで共用）
 * 食べログ準拠: 来店日をタップ → カレンダー（◎△×休）で日付を選ぶ → 人数 → 時間（空きのある時間だけ選択可） → 予約する */
function availableSlots(st, site, date, pax) {
  const closed = isClosed(st, date);
  return slotsFor(st).map((s) => ({ s, n: (closed || isPastSlot(date, s)) ? 0 : freeOptions(st, site, date, s, pax) }));
}
/* いまの日付・人数で選べない時間なら、19:00 → 最初の空き時間の順で選び直す */
function ensureTime(st, site) {
  const av = availableSlots(st, site, sel.date, sel.adults);
  const okAt = (s) => av.some((x) => x.s === s && x.n > 0);
  if (sel.time != null && okAt(sel.time)) return;
  if (okAt(19 * 60)) { sel.time = 19 * 60; return; }
  const first = av.find((x) => x.n > 0);
  sel.time = first ? first.s : null;
}
function condPanelHtml(st, site, prefix, btnLabel) {
  ensureTime(st, site);
  const av = availableSlots(st, site, sel.date, sel.adults);
  const anyOk = av.some((x) => x.n > 0);
  // 人数ごとに、選択中の来店日の空き状況（◎ 空席あり／△ 残りわずか／× 満席）を付ける。× は選択不可（選択中の人数は除く）
  const paxOpts = Array.from({ length: MAX_ADULTS }, (_, i) => i + 1).map((n) => {
    const mk = dayMark(st, site, sel.date, n, null);
    const dis = !mk.ok && n !== sel.adults;
    return `<option value="${n}" ${n === sel.adults ? 'selected' : ''} ${dis ? 'disabled' : ''}>${esc(tr().paxUnit(n))}　${esc(mk.mark)}</option>`;
  }).join('');
  const timeOpts = av.map(({ s, n }) =>
    `<option value="${s}" ${sel.time === s ? 'selected' : ''} ${n > 0 ? '' : 'disabled'}>${fmtTime(s)}　${slotMark(n).mark}</option>`).join('');
  return `<div class="cond-panel">` +
    `<div class="cp-row"><label>${esc(t('visitDate'))}</label>` +
      `<button type="button" class="date-btn ${prefix}-date">📅 <b>${esc(fmtYmd(sel.date))}</b><span class="chev">▾</span></button></div>` +
    `<div class="cp-row"><label>${esc(t('pax'))}</label><select class="${prefix}-pax">` +
      paxOpts + `</select></div>` +
    `<div class="cp-row"><label>${esc(t('time'))}</label>` +
      (anyOk ? `<select class="${prefix}-time">${timeOpts}</select>` : `<div class="cp-none">${esc(isClosed(st, sel.date) ? t('closedDay') : t('noSlot'))}</div>`) + `</div>` +
    `<p class="qr-note">◎ ${esc(t('legendPlenty'))} ／ △ ${esc(t('legendFew'))} ／ × ${esc(t('legendFull'))}　${esc(tr().stayNote(DUR))}</p>` +
    `<button type="button" class="qr-btn ${prefix}-go" ${anyOk && sel.time != null ? '' : 'disabled'}>${esc(btnLabel)}</button>` +
    `</div>`;
}
function bindCondPanel(root, prefix, st, site, onGo) {
  root.querySelectorAll(`.${prefix}-date`).forEach((b) => b.addEventListener('click', () => openCalModal(st, site)));
  root.querySelectorAll(`.${prefix}-pax`).forEach((s) => s.addEventListener('change', (e) => { sel.adults = Number(e.target.value) || 1; ensureTime(st, site); render(); }));
  root.querySelectorAll(`.${prefix}-time`).forEach((s) => s.addEventListener('change', (e) => { sel.time = Number(e.target.value); render(); }));
  root.querySelectorAll(`.${prefix}-go`).forEach((b) => b.addEventListener('click', () => { if (!b.disabled) onGo(); }));
}

/* 来店日カレンダー（モーダル）: 人数に応じた ◎△×休 を日付ごとに表示 */
function openCalModal(st, site) {
  closeCalModal();
  if (!calYM) { const [y, m] = sel.date.split('-').map(Number); calYM = { y, m }; }
  const wrap = document.createElement('div');
  wrap.className = 'cal-modal';
  wrap.id = 'calModal';
  wrap.innerHTML = `<div class="cm-box">${calModalBodyHtml(st, site)}</div>`;
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closeCalModal(); });
  document.body.appendChild(wrap);
  bindCalModal(wrap, st, site);
}
function calModalBodyHtml(st, site) {
  const today = todayStr();
  const { y, m } = calYM;
  const firstDow = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const [ty, tm] = today.split('-').map(Number);
  const [xy, xm] = maxDateStr().split('-').map(Number);
  const prevOk = y * 12 + m > ty * 12 + tm;
  const nextOk = y * 12 + m < xy * 12 + xm;
  let html = `<div class="cm-head"><h3>${esc(t('visitDate'))}<span class="sub">${esc(tr().paxUnit(sel.adults))}</span></h3><button type="button" class="cm-close" data-cm-close>✕</button></div>` +
    `<div class="bcal-head"><button type="button" data-cm-prev ${prevOk ? '' : 'disabled'}>‹</button><span class="bcal-title">${esc(tr().fmtMonth(y, m))}</span><button type="button" data-cm-next ${nextOk ? '' : 'disabled'}>›</button></div><div class="bcal">` +
    I18N[lang].weekdays.map((w, i) => `<div class="wd${i === 0 ? ' sun' : i === 6 ? ' sat' : ''}">${esc(w)}</div>`).join('');
  for (let i = 0; i < firstDow; i++) html += '<div class="bcal-cell empty"></div>';
  for (let d = 1; d <= days; d++) {
    const date = `${y}-${pad2(m)}-${pad2(d)}`;
    const mk = dayMark(st, site, date, sel.adults, null);
    let cls = `bcal-cell ${mk.cls}`;
    if (date === today) cls += ' today';
    if (date === sel.date) cls += ' sel';
    html += `<button type="button" class="${cls}" data-date="${date}" ${mk.ok ? '' : 'disabled'}>${d}<span class="mark">${esc(mk.mark)}</span></button>`;
  }
  html += `</div><div class="legend"><span><b class="o">◎</b> ${esc(t('legendPlenty'))}</span><span><b class="t">△</b> ${esc(t('legendFew'))}</span>` +
    `<span><b class="x">×</b> ${esc(t('legendFull'))}</span><span>${esc(t('legendClosed'))}</span><span>${esc(tr().monthsNote(MAX_MONTHS))}</span></div>`;
  return html;
}
function bindCalModal(wrap, st, site) {
  wrap.querySelector('[data-cm-close]').addEventListener('click', closeCalModal);
  wrap.querySelector('[data-cm-prev]').addEventListener('click', () => { shiftCalYM(-1); rerenderCalModal(wrap, st, site); });
  wrap.querySelector('[data-cm-next]').addEventListener('click', () => { shiftCalYM(1); rerenderCalModal(wrap, st, site); });
  wrap.querySelectorAll('.bcal-cell[data-date]').forEach((b) => b.addEventListener('click', () => {
    if (b.disabled) return;
    sel.date = b.dataset.date;
    ensureTime(st, site);
    closeCalModal();
    render();
  }));
}
function rerenderCalModal(wrap, st, site) {
  wrap.querySelector('.cm-box').innerHTML = calModalBodyHtml(st, site);
  bindCalModal(wrap, st, site);
}
function shiftCalYM(n) {
  let { y, m } = calYM;
  m += n;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  calYM = { y, m };
}
function closeCalModal() { document.getElementById('calModal')?.remove(); }

/* --- ネット予約パネル（トップ内 / PC右カラム）: ここで来店日・人数・時間が完結し「予約する」でコース選択へ --- */
function quickReserveHtml(st) {
  const site = ownSite(st);
  const s = settings(st);
  let html = `<div class="qr"><h2>🗓 ${esc(t('netReserve'))}` +
    (site && site.enabled ? `<span class="badge">${esc(t('reservableYes'))}</span>` : '') + `</h2>`;
  if (!site || !site.enabled) html += `<p class="hint">${esc(t('closed'))}</p>`;
  else html += condPanelHtml(st, site, 'qr', t('reserveBtn'));
  if (s.storePhone) html += `<a class="qr-call" href="tel:${esc(normPhone(s.storePhone))}">📞 ${esc(t('callStore'))}　${esc(s.storePhone)}</a>`;
  return html + `</div>`;
}
function bindQuick(root, st) {
  const site = ownSite(st);
  if (site && site.enabled) bindCondPanel(root, 'qr', st, site, () => startReserve(st));
}
/* 日時・人数が決まった状態で予約画面へ（コース選択。コース固定／コース無しの店舗は入力へ） */
function startReserve(st) {
  resetFlowPosition();
  view = 'reserve';
  try { history.replaceState(null, '', '#reserve'); } catch (e) { /* ignore */ }
  gotoStep(st, sel.courseId || !(st.courses || []).length ? 'info' : 'course');
}

/* --- ステップ1: 日時・人数（パネルと同じ UI） --- */
function datetimeStepHtml(st, site) {
  return `<div class="card plain"><h2>${esc(t('condHead'))}</h2>${condPanelHtml(st, site, 'cond', t('next'))}</div>`;
}
function bindDatetimeStep(el, st, site) {
  bindCondPanel(el, 'cond', st, site, () => gotoStep(st, sel.courseId || !(st.courses || []).length ? 'info' : 'course'));
}

function renderReserve(el, st) {
  const site = ownSite(st);
  let html = `<button type="button" class="back-store">${esc(t('backToStore'))}</button>` +
    `<div class="tabs"><button type="button" data-mode="book" class="${mode === 'book' ? 'active' : ''}">${esc(t('bookTab'))}</button>` +
    `<button type="button" data-mode="lookup" class="${mode === 'lookup' ? 'active' : ''}">${esc(t('lookupTab'))}</button></div>`;
  let cur = null;
  if (mode === 'lookup') {
    html += lookupHtml(st);
  } else if (!site || !site.enabled) {
    html += `<div class="closed">${esc(t('closed'))}</div>`;
  } else if (doneRes) {
    html += doneHtml(st);
  } else {
    const keys = stepKeys(st);
    if (stepIdx >= keys.length) stepIdx = keys.length - 1;
    cur = keys[stepIdx];
    html += renderStepper(keys) + condBarHtml(st, cur);
    if (cur === 'datetime') html += datetimeStepHtml(st, site);
    else if (cur === 'course') html += courseStepHtml(st);
    else if (cur === 'info') html += infoStepHtml(st);
    else html += confirmStepHtml(st);
  }
  el.innerHTML = html;
  el.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { mode = b.dataset.mode; render(); }));
  el.querySelector('.back-store').addEventListener('click', () => setTab('top'));
  if (mode === 'lookup') bindLookup(el);
  else if (doneRes) bindDone(el);
  else if (cur) bindStep(cur, st, site, el);
}

function renderStepper(keys) {
  const labels = { datetime: t('stepDatetime'), course: t('stepCourse'), info: t('stepInfo'), confirm: t('stepConfirm') };
  return `<div class="stepper">` + keys.map((k, i) =>
    `<div class="st${i === stepIdx ? ' active' : i < stepIdx ? ' done' : ''}"><span class="n">${i + 1}</span>${esc(labels[k])}</div>`
  ).join('') + `</div>`;
}

/* 条件バー: 空席確認ステップでは選択可能、それ以降は確定内容＋「変更」 */
function condBarHtml(st, cur) {
  if (cur === 'datetime') return '';
  const course = sel.courseId ? (st.courses || []).find((c) => c.id === sel.courseId) : null;
  return `<div class="cond-bar"><div class="cb-main">` +
    `<b>${esc(fmtYmd(sel.date))}　${sel.time != null ? fmtTime(sel.time) + '〜' : ''}</b>` +
    `<span>${esc(tr().paxUnit(sel.adults))}　${esc(t('course'))}: ${esc(course ? course.name : t('seatOnly'))}</span></div>` +
    `<button type="button" class="more-link" data-change>${esc(t('change'))}</button></div>`;
}

/* --- ステップ2: コース選択（席のみ or コース） --- */
function courseStepHtml(st) {
  let html = `<div class="card plain"><h2>${esc(t('stepCourse'))}</h2>` +
    `<div class="pick-card"><div class="pk-main"><div class="pk-name">${esc(t('seatOnly'))}</div><div class="pk-desc">${esc(t('seatOnlyDesc'))}</div></div>` +
    `<button type="button" class="btn-sm solid" data-pick-course="">${esc(t('reserveBtn'))}</button></div>`;
  (st.courses || []).forEach((c) => {
    html += `<div class="pick-card"><div class="pk-main"><div class="pk-name">${esc(c.name)}</div>` +
      (c.price ? `<div class="pk-price">${esc(c.price)}<small>${esc(tr().courseFor(sel.adults))}</small></div>` : '') +
      (c.desc ? `<div class="pk-desc">${esc(c.desc)}</div>` : '') + `</div>` +
      `<button type="button" class="btn-sm solid" data-pick-course="${esc(c.id)}">${esc(t('reserveBtn'))}</button></div>`;
  });
  return html + `</div><div class="actions"><button type="button" class="btn ghost" id="btnBack">${esc(t('back'))}</button></div>`;
}

/* --- ステップ3: 予約内容の入力 --- */
function infoStepHtml(st) {
  const purposes = I18N[lang].purposeOptions || [];
  const notes = settings(st).storeNote || t('defaultNotes');
  return `<div class="card plain"><h2>${esc(t('stepInfo'))}<span class="sub">${esc(t('requiredNote'))}</span></h2>` +
    `<div class="field"><label>${esc(t('name'))}<span class="req">※</span></label><input type="text" id="fName" value="${esc(sel.name)}" autocomplete="name" maxlength="100"></div>` +
    `<div class="field"><label>${esc(t('kana'))}</label><input type="text" id="fKana" value="${esc(sel.kana)}" maxlength="100"></div>` +
    `<div class="field"><label>${esc(t('phone'))}<span class="req">※</span></label><input type="tel" id="fPhone" value="${esc(sel.phone)}" placeholder="090-0000-0000" autocomplete="tel" maxlength="40"></div>` +
    `<div class="field"><label>${esc(t('email'))}</label><input type="email" id="fEmail" value="${esc(sel.email)}" placeholder="example@email.com" autocomplete="email" maxlength="200"></div>` +
    `<div class="field"><label>${esc(t('childrenOf'))}</label><select id="fChildren">` +
      Array.from({ length: sel.adults }, (_, i) => i).map((n) => `<option value="${n}" ${n === sel.children ? 'selected' : ''}>${esc(tr().paxUnit(n))}</option>`).join('') + `</select></div>` +
    `<div class="field"><label>${esc(t('purpose'))}</label><select id="fPurpose"><option value="">${esc(t('purposeNone'))}</option>` +
      purposes.map((p, i) => `<option value="${i + 1}" ${String(sel.purpose) === String(i + 1) ? 'selected' : ''}>${esc(p)}</option>`).join('') + `</select></div>` +
    `<div class="field"><label>${esc(t('memo'))}</label><textarea id="fMemo" maxlength="1000">${esc(sel.memo)}</textarea></div>` +
    `<div class="notes"><b>${esc(t('notesHead'))}</b>\n${esc(notes)}</div>` +
    `<label class="agree"><input type="checkbox" id="fAgree" ${sel.agree ? 'checked' : ''}> ${esc(t('agree'))}</label>` +
    `<div class="msg" id="formMsg" hidden></div></div>` +
    `<div class="actions"><button type="button" class="btn ghost" id="btnBack">${esc(t('back'))}</button>` +
    `<button type="button" class="btn primary" id="btnNext">${esc(t('toConfirm'))}</button></div>`;
}

function courseText(st, courses) {
  return (courses || []).map((c) => {
    const m = (st.courses || []).find((x) => x.id === c.courseId);
    return m ? (c.quantity > 1 ? `${m.name}×${c.quantity}` : m.name) : '';
  }).filter(Boolean).join('・');
}
function selCourses() { return sel.courseId ? [{ courseId: sel.courseId, quantity: sel.adults }] : []; }
function summaryHtml(st, r) {
  const purposes = I18N[lang].purposeOptions || [];
  const rows = [
    [t('visitDate'), fmtYmd(r.date)],
    [t('time'), `${fmtTime(r.start)}〜${fmtTime(r.start + DUR)}`],
    [t('pax'), tr().pax_(r.adults, r.children)],
    [t('course'), courseText(st, r.courses) || t('seatOnly')],
    [t('name'), r.name + (r.kana ? `（${r.kana}）` : '')],
    [t('phone'), r.phone],
    [t('email'), r.email || t('dash')],
    [t('purpose'), r.purpose ? (purposes[r.purpose - 1] || t('dash')) : t('dash')],
    [t('memo'), r.memo || t('dash')],
  ];
  return `<div class="summary">${rows.map(([k, v]) => `<b>${esc(k)}</b><span>${esc(v)}</span>`).join('')}</div>`;
}
function draftRes() {
  return { date: sel.date, start: sel.time, adults: sel.adults - sel.children, children: sel.children, courses: selCourses(),
    name: sel.name, kana: sel.kana, phone: sel.phone, email: sel.email, purpose: sel.purpose, memo: sel.memo };
}

/* --- ステップ4: 確認 --- */
function confirmStepHtml(st) {
  return `<div class="card plain"><h2>${esc(t('confirmHead'))}</h2>${summaryHtml(st, draftRes())}<div class="msg" id="formMsg" hidden></div></div>` +
    `<div class="actions"><button type="button" class="btn ghost" id="btnBack">${esc(t('back'))}</button>` +
    `<button type="button" class="btn primary" id="btnSubmit">${esc(t('confirmBtn'))}</button></div>`;
}

/* --- 完了 --- */
function doneHtml(st) {
  return `<div class="card done">` +
    `<div class="mark">✅</div><h2>${esc(t('done'))}</h2><p>${esc(t('doneSub'))}</p>` +
    `<div class="code-box"><div class="lbl">${esc(t('resNo'))}</div><div class="code">${esc(doneRes.code)}</div></div>` +
    `<p class="hint">${esc(t('keepCode'))}</p>` +
    summaryHtml(st, doneRes) +
    `<div class="actions">` +
      `<button type="button" class="btn ghost" id="btnToLookup">${esc(t('toLookup'))}</button>` +
      `<button type="button" class="btn link" id="btnNew">${esc(t('newBooking'))}</button>` +
    `</div></div>`;
}
function bindDone(el) {
  el.querySelector('#btnToLookup').addEventListener('click', () => {
    lookup.phone = doneRes.phone;
    lookup.code = doneRes.code;
    lookup.results = null;
    lookup.msg = '';
    mode = 'lookup';
    doLookup();
  });
  el.querySelector('#btnNew').addEventListener('click', () => { resetBooking(); render(); });
}
function resetBooking() {
  doneRes = null;
  stepIdx = 0;
  sel.time = null;
  sel.courseId = '';
  sel.children = 0;
  sel.agree = false;
  sel.name = ''; sel.kana = ''; sel.phone = ''; sel.email = ''; sel.purpose = ''; sel.memo = '';
}

/* --- 予約の確認・キャンセル --- */
function lookupHtml(st) {
  let html = `<div class="card plain"><h2>${esc(t('lookupTab'))}</h2><p class="hint" style="margin-bottom:10px">${esc(t('lookupNote'))}</p>` +
    `<div class="lookup-grid">` +
      `<div class="field"><label>${esc(t('phone'))}</label><input type="tel" id="lPhone" value="${esc(lookup.phone)}" placeholder="090-0000-0000"></div>` +
      `<div class="field"><label>${esc(t('resNo'))}</label><input type="text" id="lCode" value="${esc(lookup.code)}" placeholder="ABC123" autocapitalize="characters" style="text-transform:uppercase"></div>` +
    `</div>` +
    (lookup.msg ? `<div class="msg${lookup.msgOk ? ' ok' : ''}">${esc(lookup.msg)}</div>` : '') +
    `<div class="actions"><button type="button" class="btn primary" id="btnLookup">${esc(t('search'))}</button></div>`;
  if (lookup.results && lookup.results.length) {
    const today = todayStr();
    html += lookup.results.map((r) => {
      const cancellable = r.status === 'reserved' && r.date >= today;
      return `<div class="res-item">` +
        `<div class="r-head"><span>${esc(fmtYmd(r.date))}　${fmtTime(r.start)}〜</span><span class="chip ${esc(r.status)}">${esc(tr().status[r.status] || r.status)}</span></div>` +
        `<div class="r-body">${esc(tr().pax_(r.adults || 0, r.children || 0))}　${esc(r.name)}<br>` +
          `${esc(t('resNo'))}: <b>${esc(r.code)}</b>` + (courseText(st, r.courses) ? `　🍴 ${esc(courseText(st, r.courses))}` : '') + `</div>` +
        (cancellable ? `<div class="actions"><button type="button" class="btn danger" data-cancel="${esc(r.id)}">${esc(t('cancelRes'))}</button></div>` : '') +
        `</div>`;
    }).join('');
  }
  return html + `</div>`;
}
function bindLookup(el) {
  el.querySelector('#lPhone').addEventListener('input', (e) => { lookup.phone = e.target.value; });
  el.querySelector('#lCode').addEventListener('input', (e) => { lookup.code = e.target.value; });
  el.querySelector('#btnLookup').addEventListener('click', doLookup);
  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => cancelReservation(b.dataset.cancel)));
}
async function doLookup() {
  const st = db();
  const p = normPhone(lookup.phone);
  const code = String(lookup.code || '').trim().toUpperCase();
  lookup.msgOk = false;
  if (Cloud.enabled) {
    if (p.length < 10 || !code) { lookup.results = null; lookup.msg = t('notFound'); render(); return; }
    try {
      const found = await Cloud.bookingLookup(storeParam, lookup.phone, code);
      lookup.results = found;
      lookup.msg = found.length ? '' : t('notFound');
    } catch (e) { lookup.results = null; lookup.msg = t('notFound'); }
    render();
    return;
  }
  if (!st || p.length < 10 || !code) { lookup.results = null; lookup.msg = t('notFound'); render(); return; }
  const found = st.reservations.filter((r) => normPhone(r.phone) === p && String(r.code || '').toUpperCase() === code);
  lookup.results = found;
  lookup.msg = found.length ? '' : t('notFound');
  render();
}
async function cancelReservation(id) {
  if (!confirm(t('cancelConfirm'))) return;
  if (Cloud.enabled) {
    try {
      const done = await Cloud.bookingCancel(storeParam, lookup.phone, lookup.code, id);
      lookup.msg = done ? t('cancelDone') : t('notFound');
      lookup.msgOk = done;
      lookup.results = await Cloud.bookingLookup(storeParam, lookup.phone, lookup.code);
    } catch (e) { lookup.msg = t('notFound'); lookup.msgOk = false; }
    render();
    return;
  }
  const st = db();
  const r = st && st.reservations.find((x) => x.id === id);
  if (!r) { lookup.msg = t('notFound'); render(); return; }
  r.status = 'cancelled';
  r.isNew = false;
  r.updatedAt = new Date().toISOString();
  saveDb(st);
  lookup.msg = t('cancelDone');
  lookup.msgOk = true;
  lookup.results = st.reservations.filter((x) => normPhone(x.phone) === normPhone(lookup.phone) && String(x.code || '').toUpperCase() === String(lookup.code).trim().toUpperCase());
  render();
}

/* --- ステップごとのイベント --- */
function bindStep(cur, st, site, el) {
  el.querySelectorAll('[data-change]').forEach((b) => b.addEventListener('click', () => gotoStep(st, 'datetime')));
  if (cur === 'datetime') {
    bindDatetimeStep(el, st, site);
  } else if (cur === 'course') {
    el.querySelectorAll('[data-pick-course]').forEach((b) => b.addEventListener('click', () => {
      sel.courseId = b.dataset.pickCourse;
      gotoStep(st, 'info');
    }));
    el.querySelector('#btnBack').addEventListener('click', () => gotoStep(st, 'datetime'));
  } else if (cur === 'info') {
    const bind = (id, key) => el.querySelector(id).addEventListener('input', (e) => { sel[key] = e.target.value; });
    bind('#fName', 'name'); bind('#fKana', 'kana'); bind('#fPhone', 'phone'); bind('#fEmail', 'email'); bind('#fMemo', 'memo');
    el.querySelector('#fPurpose').addEventListener('change', (e) => { sel.purpose = e.target.value; });
    el.querySelector('#fChildren').addEventListener('change', (e) => { sel.children = Number(e.target.value) || 0; });
    el.querySelector('#fAgree').addEventListener('change', (e) => { sel.agree = e.target.checked; if (sel.agree) el.querySelector('#formMsg').hidden = true; });
    el.querySelector('#btnBack').addEventListener('click', () => gotoStep(st, (st.courses || []).length ? 'course' : 'datetime'));
    el.querySelector('#btnNext').addEventListener('click', () => {
      const msg = el.querySelector('#formMsg');
      const err = validateInfo();
      if (err) { msg.textContent = err; msg.hidden = false; return; }
      gotoStep(st, 'confirm');
    });
  } else if (cur === 'confirm') {
    el.querySelector('#btnBack').addEventListener('click', () => gotoStep(st, 'info'));
    el.querySelector('#btnSubmit').addEventListener('click', submit);
  }
}

function validateInfo() {
  sel.name = sel.name.trim();
  sel.phone = sel.phone.trim();
  sel.email = sel.email.trim();
  if (!sel.name || !sel.phone) return t('required');
  if (normPhone(sel.phone).length < 10) return t('invalidPhone');
  if (sel.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sel.email)) return t('invalidEmail');
  if (!sel.agree) return t('agreeRequired');
  return '';
}
function shiftCal(n) {
  let { y, m } = calYM;
  m += n;
  while (m < 1) { m += 12; y -= 1; }
  while (m > 12) { m -= 12; y += 1; }
  calYM = { y, m };
  render();
}

async function submit() {
  const st = db();
  const site = st && ownSite(st);
  if (!site || !site.enabled) { render(); return; }
  const fail = (msg) => { sel.time = null; stepIdx = 0; render(); alert(msg); };
  if (isClosed(st, sel.date)) { fail(t('closedDay')); return; }
  if (sel.time == null || isPastSlot(sel.date, sel.time)) { fail(t('taken')); return; }
  const assign = findAssignment(st, site, sel.date, sel.time, sel.adults);
  if (!assign) { fail(t('taken')); return; }

  const d = draftRes();
  if (Cloud.enabled) {
    // サーバー側（RPC）で必須項目・受付状態・重複を再検証して登録
    try {
      const created = await Cloud.bookingCreate(storeParam, {
        date: d.date, start: d.start, duration: DUR, adults: d.adults, children: d.children,
        name: d.name, kana: d.kana.trim(), phone: d.phone, email: d.email, purpose: d.purpose ? Number(d.purpose) : '',
        tableIds: assign, courses: d.courses, memo: d.memo.trim(), channel: site.id,
      });
      doneRes = created;
      await refreshCloud();
    } catch (e) {
      const m = String(e.message || '');
      try { await refreshCloud(); } catch (err) { /* ignore */ }
      if (m.includes('closed')) fail(t('closed')); else fail(t('taken'));
      return;
    }
    render();
    window.scrollTo(0, 0);
    return;
  }
  const now = new Date().toISOString();
  const res = {
    id: uid(),
    code: genCode(),
    date: d.date,
    start: d.start,
    duration: DUR,
    end: d.start + DUR,
    adults: d.adults,
    children: d.children,
    name: d.name.slice(0, 100),
    kana: d.kana.trim().slice(0, 100),
    phone: d.phone.slice(0, 40),
    email: d.email.slice(0, 200),
    purpose: d.purpose ? Number(d.purpose) : '',
    tableIds: assign,
    courses: d.courses,
    tags: [],
    memo: d.memo.trim().slice(0, 1000),
    status: 'reserved',
    walkIn: false,
    channel: site.id,
    isNew: true,
    createdAt: now,
    updatedAt: now,
  };
  // 保存直前に最新データを読み直し、予約の追加だけを書き込む（台帳側の設定変更を巻き戻さない）
  const fresh = db() || st;
  if (!Array.isArray(fresh.reservations)) fresh.reservations = [];
  fresh.reservations.push(res);
  saveDb(fresh);
  doneRes = res;
  render();
  window.scrollTo(0, 0);
}

/* ---------- 初期化 ---------- */
document.getElementById('langSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-lang]');
  if (!b) return;
  lang = b.dataset.lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch (err) { /* ignore */ }
  google.status = 'idle';   // 言語に合わせて口コミを再取得（キャッシュは言語別）
  render();
});
document.getElementById('siteTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) setTab(b.dataset.tab);
});
document.getElementById('ctaReserve').addEventListener('click', openReserve);
window.addEventListener('hashchange', () => { if (location.hash === '#reserve' && view !== 'reserve') openReserve(); });
// 台帳側の変更（予約・設定）を即時反映
window.addEventListener('storage', (e) => { if (Cloud.enabled) return; if (e.key === dataKeyName() || e.key === LS_REGISTRY) { google.status = 'idle'; render(); } });

if (Cloud.enabled) {
  Cloud.init();
  render();
  refreshCloud().then(render).catch((e) => { cloudErr = e.message || 'error'; render(); });
  setInterval(() => { if (view === 'reserve' && !doneRes) refreshCloud().then(render).catch(() => {}); }, 60000);   // 空席状況を定期更新
} else {
  render();
}
