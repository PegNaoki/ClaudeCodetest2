// ============================================================
// 3サイトの枠監査結果（audit-*-mode.json）を1枚の一覧表にまとめる。
// モード（即予約/リクエスト）に加え、在庫の数値も集計：
//   即予約可能数（定員）/ 予約が入っている数 / 残りの即予約可能数
// 数値ソース：
//   ウラカタ … calendarSeatCount "予約数/定員" ＋ calendarRealtimeLimit "(残り即予約可)"
//              （アソビュー共通在庫マスタ。3値すべて取得）
//   AJ       … 在庫 hidden input（残り即予約可能数）
//   じゃらん … .stock-cnt（残数＝残り即予約可能数）
// 出力：
//   audit-mode-summary.json … 統合データ
//   audit-mode-summary.md   … Markdown表（Actionsサマリにも出力）
// ============================================================

import fs from 'fs';

const SITES = [
  { key: 'urakata', label: 'ウラカタ',        file: 'audit-urakata-mode.json' },
  { key: 'jalan',   label: 'じゃらん',        file: 'audit-jalan-mode.json' },
  { key: 'aj',      label: 'アクティビティJP', file: 'audit-aj-mode.json' },
];

const MODE_JA = {
  immediate:   '即予約',
  request:     'リクエスト',
  combination: '併用',
  closed:      '売止/満席',
  not_found:   '—',
  unknown:     '不明',
};

function load(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return []; }
}
function num(v) { return (v === null || v === undefined) ? '—' : String(v); }

// key: "date time" -> { date, time, <site>: row }
const grid = new Map();
const allRows = [];

for (const site of SITES) {
  for (const r of load(site.file)) {
    allRows.push({ ...r, siteLabel: site.label });
    const k = `${r.date} ${r.time}`;
    if (!grid.has(k)) grid.set(k, { date: r.date, time: r.time });
    grid.get(k)[site.key] = r;
  }
}
const keys = [...grid.keys()].sort();

let md = '# OTA 枠監査（モード＋在庫数）\n\n';
md += `監査日時: ${new Date().toISOString()}\n\n`;

// ---- 表1：モード一覧（枠×サイト） ----
md += '## 1. 予約方式（即予約 / リクエスト）\n\n';
md += '| 日付 | 時間 | ウラカタ | じゃらん | アクティビティJP |\n';
md += '|---|---|---|---|---|\n';
for (const k of keys) {
  const g = grid.get(k);
  const cell = (r) => (r ? (MODE_JA[r.mode] || r.mode) : '—');
  md += `| ${g.date} | ${g.time} | ${cell(g.urakata)} | ${cell(g.jalan)} | ${cell(g.aj)} |\n`;
}

// ---- 表2：在庫数（定員 / 予約済 / 残り即予約可） ----
md += '\n## 2. 在庫数（即予約可能数・予約済・残り）\n\n';
md += 'ウラカタ＝アソビュー共通在庫マスタ（定員・予約済・残りをすべて保持）。';
md += 'じゃらん・AJ は各チャネルの「残り即予約可能数」を表示。\n\n';
md += '| 日付 | 時間 | 定員(ｳﾗｶﾀ) | 予約済(ｳﾗｶﾀ) | 残り即予約可(ｳﾗｶﾀ) | 残り(じゃらん) | 残り(AJ) |\n';
md += '|---|---|---|---|---|---|---|\n';
for (const k of keys) {
  const g = grid.get(k);
  const u = g.urakata || {}, j = g.jalan || {}, a = g.aj || {};
  md += `| ${g.date} | ${g.time} | ${num(u.capacity)} | ${num(u.booked)} | ${num(u.remainImmediate)} | ${num(j.remainImmediate)} | ${num(a.remainImmediate)} |\n`;
}

md += '\n**凡例**: 即予約=自動確定 / リクエスト=承認待ち / 併用=在庫内は即時+超過リクエスト / —=当該OTAに枠なし or 未取得\n';
md += '\n_ウラカタは専用の予約方式UIを持たず、残り即予約可 `(n)` が n>0 で即予約・0 でリクエスト受付として判定。定員・予約済は共通在庫の「予約数/定員」表示に基づく。_\n';

fs.writeFileSync('audit-mode-summary.md', md);
fs.writeFileSync('audit-mode-summary.json', JSON.stringify({
  auditedAt: new Date().toISOString(),
  grid: keys.map(k => grid.get(k)),
  rows: allRows,
}, null, 2));

console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
