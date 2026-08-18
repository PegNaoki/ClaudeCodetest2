// 3つのOTA（じゃらん / ウラカタ・アソビュー / アクティビティジャパン）から
// 読み取る予約データの「共通スキーマ」。
//
// サイトごとに管理画面の列構成が違うため、そのまま出力すると項目がバラバラになり、
// カレンダーの詳細も予約ごとに情報量が変わってしまう。ここで必ず同じキーを持つ
// オブジェクトに正規化し、そのサイトが本当に出していない項目は null で埋める。
// （「空文字」ではなく null にするのは、「取得できなかった」ことを明示するため）
export const FIELDS = [
  'site',       // 取得元サイト名
  'bookingNo',  // 予約番号（ウラカタは一覧に無いため null）
  'status',     // 確定 / 仮予約 / キャンセル
  'date',       // 体験日 YYYY-MM-DD
  'time',       // 体験開始 HH:MM
  'people',     // 人数（数値）
  'name',       // 氏名
  'kana',       // フリガナ
  'phone',      // 電話番号
  'plan',       // プラン／コース名
  'price',      // 金額（表示文字列のまま。数値化は利用側で行う）
  'payment',    // 決済方法
  'media',      // 販売媒体（ウラカタのみ実値。他はサイト名で代用）
  'applied',    // 申込日時
  'note',       // 備考
];

// 全角/半角・空白のゆらぎを吸収して片付ける。空になったら null。
export function clean(v) {
  if (v == null) return null;
  const s = String(v).replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
  return s === '' || s === '-' || s === '―' ? null : s;
}

// 共通スキーマに揃える。未指定のキーは null で必ず埋める。
export function normalize(rec) {
  const out = {};
  for (const k of FIELDS) {
    const v = rec[k];
    out[k] = (k === 'people') ? (Number.isFinite(v) ? v : (parseInt(v, 10) || null)) : clean(v);
  }
  return out;
}

// 「山根 綾菜(ヤマネ アヤナ)」のように氏名とフリガナが1セルに入っている表記を分解する。
export function splitKana(s) {
  const t = clean(s);
  if (!t) return { name: null, kana: null };
  const m = t.match(/^(.*?)[（(]([ぁ-んァ-ヶー\s]+)[）)]\s*\d*\s*$/);
  return m ? { name: clean(m[1]), kana: clean(m[2]) } : { name: t, kana: null };
}

// 「15,200円オンラインカード決済」から金額と決済方法を切り分ける。
export function splitPrice(s) {
  const t = clean(s);
  if (!t) return { price: null, payment: null };
  const m = t.match(/^([\d,]+\s*円)\s*(.*)$/);
  return m ? { price: clean(m[1]), payment: clean(m[2]) } : { price: t, payment: null };
}

// セル群から電話番号らしき文字列を拾う。列位置が分からないサイト用。
export function findPhone(cells) {
  for (const c of cells) {
    const m = String(c).match(/0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{3,4}/);
    if (m) return m[0];
  }
  return null;
}
