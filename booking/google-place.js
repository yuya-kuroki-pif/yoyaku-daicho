'use strict';
/* Google Places API (New) の応答 → 店舗情報。予約台帳（daicho/）と予約サイト（booking/）で同じ内容のファイルを使う */
/* ---------- Google Places API (New) の応答 → 店舗情報（台帳の設定項目と同じキー） ----------
 * 予約サイト（空欄の補完）と台帳の設定画面（取り込みボタン）で共用する。 */
const GOOGLE_PLACE_FIELDS = 'displayName,rating,userRatingCount,reviews,googleMapsUri,photos,formattedAddress,nationalPhoneNumber,internationalPhoneNumber,regularOpeningHours.weekdayDescriptions,websiteUri,priceRange,primaryTypeDisplayName,editorialSummary,paymentOptions,parkingOptions,goodForChildren';
function googlePlaceToInfo(data, lang) {
  const L = lang === 'vi'
    ? { card: 'Thẻ tín dụng', debit: 'Thẻ ghi nợ', nfc: 'Thanh toán không tiếp xúc', cash: 'Chỉ tiền mặt',
        freeLot: 'Bãi đỗ miễn phí', paidLot: 'Bãi đỗ có phí', freeStreet: 'Đỗ ven đường (miễn phí)', paidStreet: 'Đỗ ven đường (có phí)',
        valet: 'Valet', freeGarage: 'Gara miễn phí', paidGarage: 'Gara có phí', kids: 'Phù hợp với trẻ em', sep: ', ' }
    : { card: 'クレジットカード可', debit: 'デビットカード可', nfc: 'タッチ決済（電子マネー）可', cash: '現金のみ',
        freeLot: '無料駐車場あり', paidLot: '有料駐車場あり', freeStreet: '路上駐車（無料）可', paidStreet: '路上駐車（有料）',
        valet: 'バレーパーキング', freeGarage: '無料ガレージあり', paidGarage: '有料ガレージあり', kids: 'お子様連れ歓迎', sep: '・' };
  const info = {};
  if (!data) return info;
  if (data.displayName && data.displayName.text) info.storeName = data.displayName.text;
  if (data.primaryTypeDisplayName && data.primaryTypeDisplayName.text) info.storeGenre = data.primaryTypeDisplayName.text;
  if (data.nationalPhoneNumber || data.internationalPhoneNumber) info.storePhone = data.nationalPhoneNumber || data.internationalPhoneNumber;
  if (data.formattedAddress) info.storeAddress = data.formattedAddress;
  const wd = data.regularOpeningHours && data.regularOpeningHours.weekdayDescriptions;
  if (wd && wd.length) info.storeHours = wd.join(' / ');
  if (/^https?:\/\//i.test(String(data.websiteUri || ''))) info.storeWebsite = data.websiteUri;   // http(s) 以外のスキームは捨てる
  if (data.priceRange && (data.priceRange.startPrice || data.priceRange.endPrice)) {
    // 例: 200,000〜400,000 VND（通貨は末尾に1回）
    const sp = data.priceRange.startPrice, ep = data.priceRange.endPrice;
    const num = (p) => p ? Number(p.units || 0).toLocaleString() : '';
    const cur = (ep && ep.currencyCode) || (sp && sp.currencyCode) || '';
    info.storeBudget = ([num(sp), num(ep)].filter(Boolean).join('〜') + ' ' + cur).trim();
  }
  if (data.editorialSummary && data.editorialSummary.text) info.storeDescription = data.editorialSummary.text;
  const po = data.paymentOptions;
  if (po) {
    const pay = [];
    if (po.acceptsCashOnly) pay.push(L.cash);
    if (po.acceptsCreditCards) pay.push(L.card);
    if (po.acceptsDebitCards) pay.push(L.debit);
    if (po.acceptsNfc) pay.push(L.nfc);
    if (pay.length) info.storePayment = pay.join(L.sep);
  }
  const pk = data.parkingOptions;
  if (pk) {
    const park = [];
    if (pk.freeParkingLot) park.push(L.freeLot);
    if (pk.paidParkingLot) park.push(L.paidLot);
    if (pk.freeStreetParking) park.push(L.freeStreet);
    if (pk.paidStreetParking) park.push(L.paidStreet);
    if (pk.valetParking) park.push(L.valet);
    if (pk.freeGarageParking) park.push(L.freeGarage);
    if (pk.paidGarageParking) park.push(L.paidGarage);
    if (park.length) info.storeParking = park.join(L.sep);
  }
  if (data.goodForChildren) info.storeKids = L.kids;
  return info;
}
