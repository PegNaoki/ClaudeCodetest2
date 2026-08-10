// ============================================================
// オーバーブッキング防止 絶対値同期（Actions側・ライブ予約ベース）
// ------------------------------------------------------------
// B（予約総数）は「実サイトのライブ予約（確定のみ）」から算出する。
//   → Reconcile が読んだ *-reservations.json を入力に使う（転記シートは使わない）。
// C（定員）は「定員マスター」タブを CSV公開したURLから読む。
//   セル意味：数字=定員 / △=リクエスト強制 / ✗=受付停止 / 空=既定(B列)
//
// 状態機械（R = C − B）：
//   ✗      : 満席（受付停止）
//   △      : リクエスト ＋ 在庫0
//   R >= 1 : 即予約 ／ 即予約在庫 = R（残り1名でも売る）
//   R <= 0 : 満席（予約で埋まった）
//   しきい値は REQUEST_AT_OR_BELOW で変更できる（既定0）。
//
// 既定は DRY_RUN=true（無操作でプラン表を出すだけ）。
// DRY_RUN=false のとき、各OTAの mode-*/reduce-* を絶対値で実行して同期する。
//
// 環境変数：
//   CAPACITY_CSV_URL … 定員マスターの「ウェブに公開(CSV)」URL（必須）
//   RES_FILES … カンマ区切りの予約JSONパス（既定 jalan/urakata/aj-reservations.json）
//   REQUEST_AT_OR_BELOW … 満席化しきい値（既定 0）
//   SYNC_HORIZON_DAYS … この日数以内は全枠を同期（既定 45）
//   ONLY_FUTURE … 今日以降のみ（既定 true）
//   DRY_RUN（既定 true）/ HEADLESS（enforce時に子プロセスへ継承）
//   ※enforce（DRY_RUN=false）には各サイトのログイン情報が env に必要
//     （JALAN_ID/PASSWORD, URKT_ID/PASSWORD, AJ_ID/PASSWORD, GAS_RECONCILE_URL, RECONCILE_TOKEN）
// ============================================================

import fs from 'fs';
import { execFileSync } from 'child_process';

const CONFIG = {
  capacityCsvUrl: process.env.CAPACITY_CSV_URL || '',
  resFiles: (process.env.RES_FILES || 'jalan-reservations.json,urakata-reservations.json,aj-reservations.json')
    .split(',').map(s => s.trim()).filter(Boolean),
  // 残りRがこの値以下なら満席にする。既定0＝「残り1名でも即予約で売る」。
  requestAtOrBelow: parseInt(process.env.REQUEST_AT_OR_BELOW || '0', 10),
  onlyFuture: process.env.ONLY_FUTURE !== 'false',
  dryRun: process.env.DRY_RUN !== 'false',
  sites: ['urakata', 'jalan', 'aj'],
};
// 定員マスターのセル記号。似た見た目の別コードポイントが多く、取りこぼすと
// 「空欄＝既定」と誤読して閉じたはずの枠を売ってしまうため、まとめて定義する。
//   x X Ｘ ×(00D7) ☓(2613) ✕(2715) ✖(2716) ✗(2717) ✘(2718) ❌(274C) ❎(274E) 🗙(1F5D9)
const STOP_RE    = /^[xXＸ×☓✕✖✗✘❌❎🗙]$/u;
// リクエスト強制の記号。IMEで「さんかく」を変換すると △▲▽▼∆⊿ が候補に出るため
// まとめて拾う。取りこぼすと「未知」＝安全側の受付停止に倒れ、リクエストに
// したい枠が閉じてしまう。
//   △(25B3) ▲(25B2) ▵(25B5) ▴(25B4) ▽(25BD) ▼(25BC) ▿(25BF) ▾(25BE) ∆(2206) ⊿(22BF)
const REQUEST_RE = /^[△▲▵▴▽▼▿▾∆⊿]$/u;

const MODE_SCRIPT   = { urakata: 'mode-urakata-slot.js',   jalan: 'mode-jalan-slot.js',   aj: 'mode-aj-slot.js' };
const REDUCE_SCRIPT = { urakata: 'reduce-urakata-slot.js', jalan: 'reduce-jalan-slot.js', aj: 'reduce-aj-slot.js' };
const WD = ['日', '月', '火', '水', '木', '金', '土'];

function log(event, data = {}) {
  console.log(`${new Date().toISOString()} [${event}] ${JSON.stringify(data)}`);
}
// 予約枠の日付はすべて日本時間で考える。Actionsのランナーは UTC なので、
// そのまま new Date() を使うと日本の朝(00:00-09:00 JST)は前日と判定され、
// 当日の枠を「未来」として扱ってしまう。UTC+9 にずらして UTC 系メソッドで
// 読むことで、実行環境のタイムゾーンに依存せず日本時間の暦日を得る。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
function jstDate(ms = Date.now()) { return new Date(ms + JST_OFFSET_MS); }
function jstYmd(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function todayStr() { return jstYmd(jstDate()); }
function normTime(v) {
  const m = String(v == null ? '' : v).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

// ---- 予約総数B：ライブ予約JSON（確定のみ・人数合計）をキー"date time"で集計 ----
function computeBooked() {
  const booked = new Map(); // "YYYY-MM-DD HH:MM" -> 人数合計（確定）
  const missing = [];
  for (const f of CONFIG.resFiles) {
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { log('res_file_skip', { file: f, error: e.message }); missing.push(f); continue; }
    const list = Array.isArray(data.reservations) ? data.reservations : [];
    for (const r of list) {
      if (r.status !== '確定') continue;            // ★確定のみ
      const date = String(r.date || '');
      const time = normTime(r.time);
      if (!date || !time) continue;
      const k = `${date} ${time}`;
      booked.set(k, (booked.get(k) || 0) + (Number(r.people) || 0));
    }
  }
  if (missing.length) log('booked_incomplete', { missing });
  return { booked, missing };
}

// ---- 定員マスターCSV（マトリクス）をパース → [{date,time,capacity,override}] ----
function parseCsv(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function parseDateHeader(s) {
  const t = String(s == null ? '' : s).trim();
  const m = t.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
  if (!m) return '';
  const mo = Number(m[1]), da = Number(m[2]);
  const wdM = t.match(/[(（]([日月火水木金土])[)）]/);
  const wd = wdM ? WD.indexOf(wdM[1]) : -1;
  // 年の推定も日本時間の「今日」を基準にする（UTCだと日本の朝に前日基準となり、
  // 年末年始やシート先頭付近で1年ずれた日付を作りうる）。
  const nowY = jstDate().getUTCFullYear();
  const cands = [nowY, nowY + 1, nowY - 1];
  if (wd >= 0) {
    for (const y of cands) if (new Date(Date.UTC(y, mo - 1, da)).getUTCDay() === wd) return fmt(y, mo, da);
  }
  const todayYmd = todayStr();
  let best = '';
  for (const y of cands) {
    const ymd = fmt(y, mo, da);
    if (ymd >= todayYmd && (!best || ymd < best)) best = ymd;
  }
  return best || fmt(nowY, mo, da);
}
function fmt(y, mo, da) { return `${y}-${String(mo).padStart(2, '0')}-${String(da).padStart(2, '0')}`; }

// 公開URLをCSV取得用に補正する（pubhtml→pub、output=csv付与）
function toCsvUrl(url) {
  let u = String(url || '');
  u = u.replace('/pubhtml', '/pub');
  if (!/[?&]output=csv/.test(u)) u += (u.includes('?') ? '&' : '?') + 'output=csv';
  return u;
}

async function loadCapacity() {
  if (!CONFIG.capacityCsvUrl) throw new Error('CAPACITY_CSV_URL が未設定です（定員マスターのCSV公開URL）');
  const url = toCsvUrl(CONFIG.capacityCsvUrl);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`定員マスターCSV取得失敗: HTTP ${res.status}`);
  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('定員マスターCSVが空です');
  const header = rows[0];
  const dateCols = [];
  for (let c = 2; c < header.length; c++) {           // C列(index2)以降が日付
    const d = parseDateHeader(header[c]);
    if (d) dateCols.push({ col: c, date: d });
  }
  log('capacity_loaded', { rows: rows.length, dateCols: dateCols.length, header: header.slice(0, 6) });
  if (dateCols.length === 0) {
    log('capacity_warn', { note: '日付列を認識できません（CSVでない可能性）', head: text.slice(0, 160) });
  }
  const out = [];
  const unknown = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const time = normTime(row[0]);                    // A列＝時間
    if (!time) continue;
    const def = Number(String(row[1]).replace(/[^\d.-]/g, '')) || 0; // B列＝既定
    for (const dc of dateCols) {
      // 異体字セレクタ等の不可視文字は落としてから判定する（✗️ のような入力対策）。
      const cell = String(row[dc.col] == null ? '' : row[dc.col])
        .replace(/[︀-️​-‍﻿]/g, '').trim();
      let override = '', capacity = def, explicit = false;
      if (REQUEST_RE.test(cell)) { override = 'request'; explicit = true; }
      // 受付停止の記号。漏れると「空欄＝既定」と誤読して、閉じたはずの枠を
      // 即予約で売ってしまう（U+2717 の漏れで実際に起きた）。
      else if (STOP_RE.test(cell)) { override = 'stop'; capacity = 0; explicit = true; }
      else if (cell !== '' && !isNaN(Number(cell))) { capacity = Number(cell); explicit = true; }
      else if (cell !== '') {
        // 空欄でもないのにどの記号にも当てはまらない。既定(=販売)に倒すと
        // 売りすぎになるため、安全側の「受付停止」に倒して必ず報告する。
        override = 'stop'; capacity = 0; explicit = true;
        unknown.push({ date: dc.date, time, cell,
          codepoints: [...cell].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ') });
      }
      out.push({ date: dc.date, time, capacity, override, explicit });
    }
  }
  if (unknown.length) {
    log('capacity_cell_unrecognized', { count: unknown.length, cells: unknown.slice(0, 40) });
    console.error(`⚠️ 定員マスターに解釈できないセルが ${unknown.length} 件あります（安全のため受付停止として扱いました）`);
  }
  return out;
}

// ---- 状態機械 ----
function computeTarget(capacity, booked, override) {
  const C = Number(capacity) || 0, B = Number(booked) || 0;
  const R = C - B;
  // ✗(受付停止) は「満席」にする。△(リクエスト強制) とは別扱い。
  if (override === 'stop') return { R, mode: 'closed', stock: 0 };
  if (override === 'request') return { R, mode: 'request', stock: 0 };
  // 予約で埋まった（残り0以下）＝満席。残り1名でも即予約で売る。
  if (R <= CONFIG.requestAtOrBelow) return { R, mode: 'closed', stock: 0 };
  return { R, mode: 'immediate', stock: R };
}

async function main() {
  const slots = await loadCapacity();
  const today = todayStr();

  // 定員確認モード：シートに実際に入力された数値/△/x だけを表示して終了（軽量・予約読取なし）
  if (process.env.CAPACITY_ONLY === 'true') {
    const ex = slots.filter(s => s.explicit && (!CONFIG.onlyFuture || s.date >= today))
                    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
    let md = '# 定員マスター 実入力値（既定以外）\n\n';
    md += `取得日時: ${new Date().toISOString()} ／ 既定以外の入力: ${ex.length}件\n\n`;
    md += '| 日付 | 時間 | 定員 | 種別 |\n|---|---|---|---|\n';
    for (const s of ex) md += `| ${s.date} | ${s.time} | ${s.override === 'stop' ? '×(停止)' : (s.override === 'request' ? '△(ﾘｸｴｽﾄ)' : s.capacity)} | ${s.explicit ? '入力' : '既定'} |\n`;
    console.log(md);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
    log('capacity_only_done', { explicit: ex.length });
    return;
  }

  const { booked, missing } = computeBooked();
  const plan = [];

  for (const s of slots) {
    if (CONFIG.onlyFuture && s.date < today) continue;
    const B = booked.get(`${s.date} ${s.time}`) || 0;
    const t = computeTarget(s.capacity, B, s.override);
    plan.push({ date: s.date, time: s.time, capacity: s.capacity, booked: B, R: t.R,
                mode: t.mode, stock: t.stock, override: s.override || '' });
  }
  plan.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  // ---- レポート出力 ----
  let md = '# オーバーブッキング同期プラン（' + (CONFIG.dryRun ? 'DRY_RUN 無操作' : '本番') + '）\n\n';
  md += `算出日時: ${new Date().toISOString()}\n\n`;
  md += '| 日付 | 時間 | 定員C | 予約B(確定) | 残りR | 目標 | 在庫 | 備考 |\n|---|---|---|---|---|---|---|---|\n';
  for (const p of plan) {
    const note = [p.override ? `[${p.override}]` : '', p.R < 0 ? '⚠️定員超過' : ''].filter(Boolean).join(' ');
    const modeLabel = { immediate: '即予約', request: 'リクエスト', closed: '満席' }[p.mode] || p.mode;
    md += `| ${p.date} | ${p.time} | ${p.capacity} | ${p.booked} | ${p.R} | ${modeLabel} | ${p.stock} | ${note} |\n`;
  }
  fs.writeFileSync('sync-overbooking-plan.md', md);
  fs.writeFileSync('sync-overbooking-plan.json', JSON.stringify({ computedAt: new Date().toISOString(), plan }, null, 2));
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

  const danger = plan.filter(p => p.R < 0);
  if (danger.length) log('overbooking_detected', { count: danger.length, slots: danger.map(d => `${d.date} ${d.time} R=${d.R}`) });

  if (CONFIG.dryRun) { log('done', { mode: 'dry_run', slots: plan.length }); return; }

  // 予約JSONが1つでも欠けていると予約数Bが過少になり、残りRが過大＝売りすぎになる。
  // 反映は中止する（プラン表示までは行うので状況は確認できる）。
  if (missing.length) {
    log('enforce_aborted', { reason: '予約データが不完全', missing });
    throw new Error(`予約データが不完全なため反映を中止しました: ${missing.join(', ')}`);
  }

  // ---- enforce（DRY_RUN=false）：各OTAへ絶対値で反映 ----
  enforce(plan);
  log('done', { mode: 'enforce', slots: plan.length });
}

// 目標状態を各サイトの mode-*/reduce-* を子プロセスで実行して反映する。
//
// 対象の選び方：
//   直近 SYNC_HORIZON_DAYS 日以内は「全枠」を対象にする。閉じた枠を開け直すには
//   OTA側の現状を触りにいく必要があり、予約0の即予約枠を除外すると
//   シートから ✗/△ を外しても復帰できないため（実際にその不具合があった）。
//   それより先は、放置すると危険な枠だけに絞って処理量を抑える：
//     - request / closed … 自動確定を止める必要がある
//     - 予約が入っている枠 … 在庫を残Rに合わせる必要がある
//   期間外の枠も、日が近づいて期間内に入れば自動的に整う。
function enforce(plan) {
  const horizonDays = parseInt(process.env.SYNC_HORIZON_DAYS || '45', 10);
  const limitDate = jstYmd(jstDate(Date.now() + horizonDays * 86400000));
  const actionable = plan.filter(p =>
    p.date <= limitDate || p.mode === 'request' || p.mode === 'closed' || p.booked > 0);
  log('enforce_scope', { total: plan.length, actionable: actionable.length, horizonDays, limitDate });
  for (const site of CONFIG.sites) {
    const reqSlots = actionable.filter(p => p.mode === 'request').map(p => ({ date: p.date, time: p.time, mode: 'request' }));
    // 3サイトとも「売止/満席」を実装・検証済み。
    const clsSlots = actionable.filter(p => p.mode === 'closed').map(p => ({ date: p.date, time: p.time, mode: 'closed' }));
    const immSlots = actionable.filter(p => p.mode === 'immediate').map(p => ({ date: p.date, time: p.time, mode: 'immediate', stock: p.stock }));

    // モードはバッチ対応（SLOTS）。request / closed / immediate をまとめて渡す。
    const allMode = [...reqSlots, ...clsSlots, ...immSlots];
    if (allMode.length) {
      runNode(MODE_SCRIPT[site], { SLOTS: JSON.stringify(allMode), DRY_RUN: 'false', HEADLESS: 'true' }, site, 'mode');
    }
    // 在庫の絶対値セットは任意（ENFORCE_STOCK=true のときだけ）。
    // 既定はモードのみ反映＝各サイト1ログインで軽く、オーバーブッキング防御の本体を担う。
    // 在庫の細かい数合わせは既存の差分連動(reduce-*)がリアルタイムで担当する。
    if (process.env.ENFORCE_STOCK === 'true') {
      for (const p of immSlots) {
        runNode(REDUCE_SCRIPT[site], {
          SLOT_DATE: p.date, SLOT_TIME: p.time, SLOT_TARGET_STOCK: String(p.stock), DRY_RUN: 'false', HEADLESS: 'true',
        }, site, 'reduce');
      }
    }
  }
}
function runNode(script, extraEnv, site, kind) {
  try {
    log('run', { site, kind, script });
    execFileSync('node', [script], { stdio: 'inherit', env: { ...process.env, ...extraEnv } });
  } catch (e) {
    // 1サイトの失敗で全体を止めない（他サイトの同期は続行）。exitCodeは立てる。
    log('run_error', { site, kind, message: e.message });
    process.exitCode = 1;
  }
}

main().catch(e => { log('error', { message: e.message }); process.exitCode = 1; });
