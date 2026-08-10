// ============================================================
// じゃらん遊び・体験 (ACTIVITY BOARD) 枠の予約タイプ切替スクリプト（バッチ対応）
// ------------------------------------------------------------
// 枠を「即時予約 ⇄ リクエスト予約」に切り替える。
//   カレンダー(時間×日付)で対象セルを特定 → セル内の「(N人)」リンクを開く
//   → select[name="reservationType"] を選択 → 「一括変更する」
//   reservationType: KeyCONFIRMED=即時予約 / KeyUNCONFIRMED=リクエスト予約 / KeyCOMBINATION=併用
//   （「一括」はその1枠の中の複数プランをまとめて、の意味。日付×時間の1枠単位）
//
// 環境変数：
//   JALAN_ID / JALAN_PASSWORD / SHOP_NAME
//   ▼ 一括指定（優先）:
//     SLOTS: JSON配列 '[{"date":"2026-08-14","time":"13:30","mode":"request"}, ...]'
//   ▼ 単一指定（手動テスト用）:
//     SLOT_DATE (YYYY-MM-DD) / SLOT_TIME (HH:MM) / MODE(request|immediate)
//   DRY_RUN (既定 true) / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:   'https://activityboard.jp/',
  id:       process.env.JALAN_ID,
  password: process.env.JALAN_PASSWORD,
  shopName: process.env.SHOP_NAME || 'のみくい処 七ツ家',
  dryRun:   process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  logPath:  process.env.LOG_PATH || 'run-log-jalan-mode.jsonl',
  maxWindowAdvance: 30,
};

// mode ⇄ reservationType の対応
const MODE_TO_RT = { request: 'KeyUNCONFIRMED', immediate: 'KeyCONFIRMED', combination: 'KeyCOMBINATION' };
const RT_TO_MODE = { KeyUNCONFIRMED: 'request', KeyCONFIRMED: 'immediate', KeyCOMBINATION: 'combination' };
function rtMeaning(rt) {
  return { KeyCONFIRMED: '即時予約', KeyUNCONFIRMED: 'リクエスト予約', KeyCOMBINATION: '併用' }[rt] || `不明(${rt})`;
}
// modeをそのまま日本語化（closed は reservationType を持たないため rtMeaning では表せない）
function modeMeaning(mode) {
  return { immediate: '即時予約', request: 'リクエスト予約', combination: '併用', closed: '売止' }[mode] || `不明(${mode})`;
}

const RUN_LOG = [];
function log(event, data = {}) {
  const rec = { ts: new Date().toISOString(), event, ...data };
  RUN_LOG.push(rec);
  console.log(`${rec.ts} [${event}] ${JSON.stringify(data)}`);
}
function flushLog(extra = {}) {
  try {
    RUN_LOG.push({ ts: new Date().toISOString(), event: 'summary', dryRun: CONFIG.dryRun, ...extra });
    fs.writeFileSync(CONFIG.logPath, RUN_LOG.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch (e) { console.error('ログ書き出し失敗:', e.message); }
}
class SlotSyncError extends Error {}

function normalizeHm(t) {
  if (!t) return '';
  const m = String(t).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : String(t).trim();
}
function normalizeYmd(d) {
  if (!d) return '';
  const m = String(d).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return String(d).trim();
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function buildTasks() {
  let raw = [];
  if (process.env.SLOTS) {
    try { raw = JSON.parse(process.env.SLOTS); }
    catch (e) { throw new Error(`SLOTS のJSON解析に失敗: ${e.message}`); }
    if (!Array.isArray(raw)) throw new Error('SLOTS はJSON配列である必要があります');
  } else if (process.env.SLOT_DATE) {
    raw = [{ date: process.env.SLOT_DATE, time: process.env.SLOT_TIME, mode: process.env.MODE, stock: process.env.STOCK }];
  } else {
    throw new Error('SLOTS または SLOT_DATE が未設定です');
  }
  return raw.map((s, i) => {
    const date = normalizeYmd(s.date);
    const time = normalizeHm(s.time);
    const mode = String(s.mode || '').toLowerCase();
    const stock = parseInt(s.stock || 0, 10);
    if (!date || !time) throw new Error(`slots[${i}]: date/time が不正 (${JSON.stringify(s)})`);
    if (mode !== 'closed' && !MODE_TO_RT[mode]) throw new Error(`slots[${i}]: mode は request|immediate|combination|closed`);
    if (mode === 'combination' && !stock) throw new Error(`slots[${i}]: 併用には stock(定員) が必要`);
    return { date, time, mode, stock };
  })
  // 日付昇順に処理する。カレンダーは「次へ」しか無く前の月へ戻れないため、
  // 昇順にすることで前進のみで全枠に到達できる（バッチ時の取りこぼし防止）。
  .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function assertConfig() {
  const miss = [];
  ['id', 'password'].forEach(k => { if (!CONFIG[k]) miss.push(k.toUpperCase()); });
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}

async function main() {
  assertConfig();
  const tasks = buildTasks();
  log('start', { count: tasks.length, dryRun: CONFIG.dryRun });

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  // ヘッドレス検知で管理画面が簡易UIになりパネルが開かない問題を回避
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP', viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();
  let mng = null;
  const results = [];

  try {
    // ---------- ログイン（AirID） ----------
    await page.goto(CONFIG.topUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'ログイン' }).click();
    await page.getByRole('textbox', { name: 'AirIDまたはメールアドレス' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 店舗選択 ----------
    await page.getByRole('link', { name: CONFIG.shopName }).click();
    await page.waitForLoadState('networkidle');
    log('shop_selected', { shop: CONFIG.shopName });

    // ---------- 予約・販売管理（別ウィンドウ or 同一タブ） ----------
    const mngLink = page.getByRole('link', { name: '予約・販売管理', exact: true });
    await mngLink.waitFor({ state: 'visible', timeout: 30000 });
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await mngLink.click();
    const popup = await popupPromise;
    mng = popup || page;
    await mng.waitForLoadState('networkidle');
    log('management_opened', { popup: !!popup });

    // ---------- 各枠を順に処理 ----------
    for (const task of tasks) {
      try {
        const r = await switchOneSlot(mng, task);
        results.push({ ...task, ...r });
      } catch (e) {
        const skip = /特定できません|見つかりません/.test(e.message);
        log(skip ? 'slot_skip' : 'slot_error', { date: task.date, time: task.time, mode: task.mode, message: e.message });
        results.push({ ...task, result: skip ? 'skipped' : 'error', message: e.message });
      }
    }

    const ok      = results.filter(r => ['switched', 'already', 'dry_run'].includes(r.result)).length;
    const skipped = results.filter(r => r.result === 'skipped').length;
    const ng      = results.filter(r => r.result === 'error').length;
    log('done', { total: results.length, ok, skipped, ng });
    if (ng > 0) process.exitCode = 1;
    await mng.screenshot({ path: 'result-jalan-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await dumpAndShot(mng || page);
    process.exitCode = 1;
  } finally {
    flushLog({ results });
    await browser.close();
  }
}

// 1枠の予約タイプを切り替える。mng はログイン済み・予約販売管理を開いた状態。
async function switchOneSlot(mng, task) {
  const { date, time, mode, stock } = task;
  const targetRt = MODE_TO_RT[mode];

  // 1. 対象セルから現在の予約タイプ（アイコン）を読む
  let cell = await getCell(mng, date, time);
  const beforeMode = await readCellMode(cell);
  log('slot_before', { date, time, mode, beforeMode, meaning: modeMeaning(beforeMode) });

  // 現在モードが読めない＝セル描画待ち失敗など。全体を落とさずスキップ（誤通知防止）。
  if (beforeMode === null) {
    log('slot_skip', { date, time, note: '現在モードを読めずスキップ（要確認）' });
    return { result: 'skipped' };
  }

  // 追加入力欄の調査（変更はしない）。既存状態に関係なく必ずダンプする。
  if (process.env.DUMP_PANEL === 'true') {
    const link0 = cell.locator('a.action-link, a').first();
    await link0.click();
    const sel0 = mng.locator('select[name="reservationType"]').first();
    await sel0.waitFor({ state: 'visible', timeout: 10000 });
    await sel0.selectOption(MODE_TO_RT[mode]);
    await mng.waitForTimeout(500);
    // 受付制限を「変更する(1)」にして数値入力欄を出現させる
    const limitSel0 = mng.locator('select').filter({ has: mng.getByRole('option', { name: '変更する', exact: true }) }).first();
    if (await limitSel0.count() > 0) { await limitSel0.selectOption('1').catch(() => {}); await mng.waitForTimeout(500); }
    const combos = await mng.locator('select').evaluateAll(els => els.map((el, i) => ({
      i, name: el.name || '', value: el.value,
      options: [...el.options].map(o => ({ v: o.value, t: (o.textContent||'').trim() })),
    }))).catch(() => []);
    const inputs = await mng.locator('input').evaluateAll(els => els.map((el, i) => ({
      i, name: el.name || '', type: el.type, placeholder: el.placeholder || '',
      value: el.value, visible: !!(el.offsetParent), cls: el.className,
    }))).catch(() => []);
    log('dump_panel_selects', { count: combos.length, selects: combos });
    log('dump_panel_inputs', { count: inputs.length, inputs: inputs.filter(x => x.visible) });
    await backToCalendar(mng);
    return { result: 'dumped' };
  }

  // 予約方式が一致していても、在庫（残数）が目標とズレていれば直す必要がある。
  // 以前はここで打ち切っていたため、定員を14に上げても既に即予約だった枠は
  // 6のまま取り残されていた（ウラカタだけ14でチャネル間がズレる原因）。
  let stockOk = true;
  if (mode === 'immediate' || mode === 'combination') {
    const cur = await readStock(cell);
    const want = Math.max(1, Number(stock) || 0);
    stockOk = (cur === null) ? true : (cur === want);
    if (!stockOk) log('stock_mismatch', { date, time, current: cur, target: want });
  }
  if (beforeMode === mode && stockOk) {
    log('slot_already', { date, time, note: `既に${modeMeaning(mode)}` });
    return { result: 'already' };
  }
  if (CONFIG.dryRun) {
    log('slot_dry_run', { date, time, note: `${modeMeaning(beforeMode)} → ${modeMeaning(mode)}（変更せず）` });
    return { result: 'dry_run' };
  }

  // 2. セルのリンクを開いてパネルを変更 → 一括変更する
  const link = cell.locator('a.action-link, a').first();
  await link.click();

  // 販売可否は予約方式(reservationType)とは独立した軸。
  //   '' = 変更しない / 'true' = 販売 / 'false' = 売止
  // name="saleStatus" の実体は hidden（js-groupFrontOpenFlg）で操作できない。
  // 実際に操作するのは name を持たない表示中のselect。値で見分ける。
  const saleSel = mng.locator('select:visible')
    .filter({ has: mng.locator('option[value="false"]') }).first();

  if (mode === 'closed') {
    // 売止にする。予約方式は触らない（変更しない）。
    await saleSel.waitFor({ state: 'visible', timeout: 10000 });
    await saleSel.selectOption('false');
  } else {
    // 売止から復帰できるよう、必ず「販売」に戻したうえで予約方式を設定する。
    if (await saleSel.count() > 0) await saleSel.selectOption('true').catch(() => {});
    const sel = mng.locator('select[name="reservationType"]').first();
    await sel.waitFor({ state: 'visible', timeout: 10000 });
    await sel.selectOption(targetRt);
  }

  // 併用・即時は「受付制限を変更する＋定員の数値」も必要。
  // リクエスト予約の枠は定員を持たないため、定員を与えずに即時へ変えても
  // じゃらん側が受け付けずリクエストのまま戻る（request→immediate が全滅していた原因）。
  // 併用・売止からの即時化が通っていたのは、その枠が既に定員を持っていたから。
  if (mode === 'combination' || mode === 'immediate') {
    const limitSel = mng.locator('select').filter({ has: mng.getByRole('option', { name: '変更する', exact: true }) }).first();
    await limitSel.selectOption('1');
    await mng.waitForTimeout(400);
    const numInput = mng.locator('input.js-panel-textBox-input').first();
    await numInput.waitFor({ state: 'visible', timeout: 8000 });
    // 即時で定員0を書くと売れない枠になる。在庫は必ず1以上にする。
    const n = Math.max(1, Number(stock) || 0);
    await numInput.fill(String(n));
    log('limit_set', { date, time, mode, stock: n });
  }

  await mng.getByRole('button', { name: '一括変更する' }).click();
  await mng.waitForLoadState('networkidle').catch(() => {});
  await mng.waitForTimeout(1500);

  // 保存が黙って弾かれても分かるよう、画面のエラー表示を拾っておく。
  // （これが無かったため「検証NG」としか分からず原因究明に時間がかかった）
  const errText = await mng.evaluate(() => {
    const sels = ['.error', '.errorMessage', '.error-message', '[class*="error"]', '.alert'];
    const seen = new Set();
    for (const s of sels) {
      for (const el of document.querySelectorAll(s)) {
        if (!el.offsetParent) continue;
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t && t.length < 300) seen.add(t);
      }
    }
    return [...seen].slice(0, 5);
  }).catch(() => []);
  if (errText.length) log('panel_error', { date, time, mode, errors: errText });

  // 3. カレンダーをリロードして、セルのアイコンで検証
  // 保存直後は再描画が間に合わずアイコンを読めない（null）ことがある。
  // null は「切替失敗」ではなく「読めていない」なので、読み直してから判定する。
  let afterMode = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await backToCalendar(mng);
    cell = await getCell(mng, date, time);
    afterMode = await readCellMode(cell);
    if (afterMode !== null) break;
    log('verify_retry', { date, time, attempt, note: 'セルの状態を読めず再取得' });
    await mng.waitForTimeout(1500);
  }
  if (afterMode !== mode) {
    throw new SlotSyncError(`切替検証NG：想定(${mode})だが実際は(${afterMode})`);
  }
  log('slot_switched', { date, time, from: beforeMode, to: afterMode });
  return { result: 'switched', from: beforeMode, to: afterMode };
}

// 対象日時のセル(li)を返す
async function getCell(mng, date, time) {
  const col = await locateDateColumn(mng, date);
  if (col.index < 0) throw new SlotSyncError(`対象日 ${date} をカレンダーで特定できません`);
  const cell = await locateSlotCell(mng, time, col.index);
  if (!cell) throw new SlotSyncError(`時間 ${time} の枠を特定できません`);
  if (process.env.DEBUG_DOM === 'true') {
    const cellHtml = await cell.evaluate(el => el.outerHTML).catch(() => '');
    log('debug_cell_html', { date, time, html: cellHtml.slice(0, 1200) });
  }
  return cell;
}

// セルの sales-status アイコンから現在モードを判定：
//   icon-confirmed=即時予約(immediate) / icon-unconfirmed=リクエスト(request) / icon-combination=併用
async function readCellMode(cell) {
  // アイコンの描画が遅れることがあるため数回リトライ
  let cls = null;
  for (let i = 0; i < 6; i++) {
    cls = await cell.locator('.sales-status-wrapper [class^="icon-"]').first()
      .getAttribute('class').catch(() => null);
    if (cls) break;
    await cell.page().waitForTimeout(500);
  }
  // 売止のセルは予約方式アイコンが消え「売止」表記だけになる。
  // アイコンが取れない＝判定不能ではなく、まず売止かどうかを本文で確かめる。
  if (!cls) {
    // null を返す前にセルの実DOMを残す。null の原因（描画待ちなのか、
    // 想定外のマークアップなのか）がログだけでは切り分けられなかったため。
    const dump = await cell.evaluate(el => ({
      html: (el.outerHTML || '').slice(0, 1500),
      text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
      icons: [...el.querySelectorAll('[class*="icon"]')].map(n => n.className).slice(0, 10),
    })).catch(() => null);
    log('cell_unreadable', dump || { note: 'セルのDOMも取得できず' });
    const txt = await cell.innerText().catch(() => '');
    if (txt.includes('売止')) return 'closed';
    return null;
  }
  const s = cls.toLowerCase();
  // 売止は <div class="icon-salestop"> で表される。予約方式より先に判定する
  // （売止セルは span.sale-stop に元の予約方式クラスも併記されるため）。
  if (s.includes('salestop') || s.includes('sale-stop')) return 'closed';
  if (s.includes('combination'))  return 'combination';
  if (s.includes('unconfirmed'))  return 'request';   // ※ 'confirmed' 判定より前に
  if (s.includes('confirmed'))    return 'immediate';
  // icon-close は span.no-operation 内に出る「開催なし」。売止と同じく
  // 新規予約が入らない状態なので closed 扱いにする。これが無かったため
  // 全枠が判定不能になり、じゃらんへの反映が丸ごとスキップされていた。
  if (s.includes('close') || s.includes('nosale') || s.includes('none')) return 'closed';
  // アイコンは取れているのに既知のクラスに当てはまらない。ここが実際に
  // null を返している経路なので、判定材料をそのまま残す（8/3・8/10 の 10:00
  // が「現在モードを読めずスキップ」になっていた原因の切り分け用）。
  const dump = await cell.evaluate(el => ({
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    icons: [...el.querySelectorAll('[class*="icon"]')].map(n => n.className).slice(0, 10),
    html: (el.outerHTML || '').slice(0, 1200),
  })).catch(() => null);
  log('cell_class_unknown', { cls, ...(dump || {}) });
  return null;
}

// セルの残数 .stock-cnt を読む（audit-mode-jalan.js と同じ）
async function readStock(cell) {
  const txt = await cell.locator('.stock-cnt').first().innerText().catch(() => null);
  if (txt === null) return null;
  const n = parseInt(txt.replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

// 編集パネルからカレンダーに戻る（リロードで確実に一覧へ）
async function backToCalendar(mng) {
  await mng.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await mng.waitForTimeout(500);
}

// ------- 以下は reduce-jalan-slot.js と同じカレンダー特定ロジック -------
const DATE_HEADER_SELECTOR = process.env.DATE_HEADER_SELECTOR || 'span.day';
const NEXT_BUTTON_SELECTOR = process.env.NEXT_BUTTON_SELECTOR || '.calendar > div:nth-child(3) > .action-link';

async function locateDateColumn(mng, targetDate) {
  const [, tm, td] = targetDate.split('-').map(Number);
  let prevFirst = '';
  for (let advance = 0; advance <= CONFIG.maxWindowAdvance; advance++) {
    const days = await mng.locator(DATE_HEADER_SELECTOR).allInnerTexts().catch(() => []);
    for (let i = 0; i < days.length; i++) {
      const m = days[i].match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
      if (m && Number(m[1]) === tm && Number(m[2]) === td) return { index: i, label: days[i].trim() };
    }
    const first = days[0] || '';
    if (advance > 0 && first === prevFirst) break;
    prevFirst = first;
    const next = mng.locator(NEXT_BUTTON_SELECTOR).first();
    if (await next.count() === 0) break;
    await next.click();
    await mng.waitForTimeout(900);
  }
  return { index: -1, label: '' };
}

async function locateSlotCell(mng, time, colIndex) {
  const rows = mng.locator('.calendar-wrap, .slot-row, tr').filter({ has: mng.locator('.time') });
  const rowCount = await rows.count();
  for (let r = 0; r < rowCount; r++) {
    const row = rows.nth(r);
    const timeText = (await row.locator('.time').first().innerText().catch(() => '')).trim();
    if (normalizeHm(timeText) === time) {
      const cells = row.locator('.calendar ol > li');
      if (await cells.count() > colIndex) return cells.nth(colIndex);
    }
  }
  const times = mng.locator('.time');
  const n = await times.count();
  for (let i = 0; i < n; i++) {
    const t = normalizeHm((await times.nth(i).innerText().catch(() => '')).trim());
    if (t === time) {
      const ol = times.nth(i).locator('xpath=ancestor::*[.//ol][1]').locator('.calendar ol > li');
      if (await ol.count() > colIndex) return ol.nth(colIndex);
    }
  }
  return null;
}

async function dumpAndShot(p) {
  if (!p) return;
  await p.screenshot({ path: 'error-jalan-mode.png', fullPage: true }).catch(() => {});
}

main();
