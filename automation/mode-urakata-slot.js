// ============================================================
// ウラカタ (the-retreat-place.urkt.in ＝ アソビュー共通在庫) 枠モード切替（バッチ対応）
// ------------------------------------------------------------
// ウラカタは「販売状態」と「即時販売在庫」の2軸で決まる：
//   [data-test=calendarOpen]          ◯=販売中 / ✕=売止（クリックでトグル→保存）
//   [data-test=calendarRealtimeLimit] ( n )＝即時販売在庫
//   → mode の対応：
//       closed    → ✕（売止）。在庫は触らない
//       request   → ◯ かつ ( 0 )（即時販売は止めるがリクエストは受ける）
//       immediate → ◯ かつ ( stock )
//   売止からの復帰は ◯ に戻してから在庫を設定する（保存は最後に1回）。
//
// ログイン〜予約枠〜対象日ジャンプ〜セル特定〜入力保存 は reduce-urakata-slot.js から流用。
//
// 環境変数：
//   URKT_ID / URKT_PASSWORD / COURSE_KEYWORD (既定 'SUP')
//   ▼ 一括指定（優先）:
//     SLOTS: '[{"date":"2026-08-08","time":"10:00","mode":"immediate","stock":6}, ...]'
//   ▼ 単一指定（手動テスト用）:
//     SLOT_DATE / SLOT_TIME / MODE(request|immediate|closed) / STOCK
//   DRY_RUN (既定 true) / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:   'https://the-retreat-place.urkt.in/login',
  id:       process.env.URKT_ID,
  password: process.env.URKT_PASSWORD,
  course:   process.env.COURSE_KEYWORD || 'SUP',
  dryRun:   process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  logPath:  process.env.LOG_PATH || 'run-log-urakata-mode.jsonl',
};

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

// mode → 目標の即時販売在庫（( ) の数字）
function targetLimitFor(mode, stock) {
  return mode === 'request' ? 0 : stock;
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
    if (!['request', 'immediate', 'closed'].includes(mode)) throw new Error(`slots[${i}]: mode は request|immediate|closed`);
    if (mode === 'immediate' && !stock) throw new Error(`slots[${i}]: 即予約には stock(残り枠) が必要`);
    return { date, time, mode, stock };
  }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
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
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP', viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();
  const results = [];

  try {
    // ---------- ログイン（1回・認証コードはGmail経由で自動入力） ----------
    await urakataLogin(page, CONFIG.topUrl, CONFIG.id, CONFIG.password, '予約枠');

    // ---------- 予約枠ページ（1回） ----------
    await page.getByRole('link', { name: '予約枠' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
    log('slot_page_opened');

    for (const task of tasks) {
      try {
        const r = await switchOneSlot(page, task);
        results.push({ ...task, ...r });
      } catch (e) {
        const skip = /見つかり|特定できません|到達できません/.test(e.message);
        log(skip ? 'slot_skip' : 'slot_error', { date: task.date, time: task.time, mode: task.mode, message: e.message });
        results.push({ ...task, result: skip ? 'skipped' : 'error', message: e.message });
      }
    }

    const ok      = results.filter(r => ['switched', 'already', 'dry_run'].includes(r.result)).length;
    const skipped = results.filter(r => r.result === 'skipped').length;
    const ng      = results.filter(r => r.result === 'error').length;
    log('done', { total: results.length, ok, skipped, ng });
    if (ng > 0) process.exitCode = 1;
    await page.screenshot({ path: 'result-urakata-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await shot(page);
    process.exitCode = 1;
  } finally {
    flushLog({ results });
    await browser.close();
  }
}

// 1枠のモード（＝即時販売在庫の数字）を設定する
async function switchOneSlot(page, task) {
  const { date, time, mode, stock } = task;
  const target = targetLimitFor(mode, stock);

  // 各枠の開始時にリロードして状態をリセット（前枠で開いたdatepicker等の持ち越しを防ぐ）
  await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
  await page.keyboard.press('Escape').catch(() => {});
  await jumpToDate(page, date);
  let found = await locateCell(page, date, time);
  if (!found.ok) throw new SlotSyncError(`対象枠が見つかりません: ${found.reason}`);
  let cell = page.locator('[data-urkt-target="1"]');

  // 販売状態（◯/✕）の実DOMを調査する。変更も例外送出もしない。
  if (process.env.DUMP_CELL === 'true') {
    const info = await cell.evaluate(el => {
      const marks = [...el.querySelectorAll('*')]
        .filter(n => /^[◯○◎✕✖×△]$/.test((n.textContent || '').trim()))
        .map(n => ({ tag: n.tagName, cls: n.className, dt: n.getAttribute('data-test') || '',
                     text: (n.textContent || '').trim() }));
      return { html: el.outerHTML.slice(0, 2500), text: (el.innerText || '').trim(), marks };
    });
    log('dump_cell', info);
    return { result: 'dumped' };
  }

  // 販売状態（◯/✕）は在庫数とは別軸。売止は✕にするだけで在庫は触らない。
  const openBefore = await readOpen(cell);
  if (mode === 'closed') {
    log('slot_before', { date, time, mode, openBefore });
    if (openBefore === null) throw new SlotSyncError('販売状態(calendarOpen)を読み取れませんでした');
    if (openBefore === false) {
      log('slot_already', { date, time, note: '既に売止(✕)' });
      return { result: 'already' };
    }
    if (CONFIG.dryRun) {
      log('slot_dry_run', { date, time, note: '販売(◯) → 売止(✕)（変更せず）' });
      return { result: 'dry_run' };
    }
    await cell.locator(OPEN_SELECTOR).first().click();
    await page.waitForTimeout(600);
    await saveAndWait(page);
    const after = await reloadAndReadOpen(page, date, time);
    if (after !== false) throw new SlotSyncError(`売止検証NG：想定(✕)だがリロード後は(${after})`);
    log('slot_switched', { date, time, from: '◯', to: '✕', mode });
    return { result: 'switched' };
  }

  const before = await readLimit(cell);
  log('slot_before', { date, time, mode, before, target, openBefore });
  if (before === null) throw new SlotSyncError('即時販売在庫(calendarRealtimeLimit)を読み取れませんでした');

  // 販売状態(◯/✕)と在庫の両方を見て「変更が要るか」を判断する。
  // 在庫が目標どおりでも売止のままなら復帰が必要なので、ここで打ち切ってはいけない。
  const needReopen = openBefore === false;
  const needLimit  = before !== target;
  if (!needReopen && !needLimit) {
    log('slot_already', { date, time, note: `既に販売(◯) かつ (${target}) ＝ ${mode}` });
    return { result: 'already' };
  }
  if (CONFIG.dryRun) {
    const parts = [];
    if (needReopen) parts.push('売止(✕) → 販売(◯)');
    if (needLimit)  parts.push(`( ${before} ) → ( ${target} )`);
    log('slot_dry_run', { date, time, note: `${parts.join(' かつ ')}（変更せず）` });
    return { result: 'dry_run' };
  }

  // 売止(✕)から復帰する場合は、先に◯へ戻してから在庫を設定する（保存は最後に1回）。
  if (needReopen) {
    await cell.locator(OPEN_SELECTOR).first().click();
    await page.waitForTimeout(600);
    log('reopened', { date, time, note: '売止(✕) → 販売(◯)' });
  }
  if (!needLimit) {
    // 在庫は目標どおり。復帰の反映だけ保存して検証する。
    await saveAndWait(page);
    const openAfter = await reloadAndReadOpen(page, date, time);
    if (openAfter !== true) throw new SlotSyncError(`復帰検証NG：想定(◯)だがリロード後は(${openAfter})`);
    log('slot_switched', { date, time, from: '✕', to: '◯', mode });
    return { result: 'switched' };
  }

  // 編集：( n ) をクリック→入力→フォーカス外し→保存
  await cell.locator('[data-test=calendarRealtimeLimit]').first().click();
  await page.waitForTimeout(600);
  let input = cell.locator('input:visible').first();
  if (await input.count() === 0) input = page.locator('.ui.transparent.input input:visible').first();
  if (!(await input.isVisible().catch(() => false))) {
    await cell.click();
    await page.waitForTimeout(600);
    input = cell.locator('input:visible').first();
    if (await input.count() === 0) input = page.locator('.ui.transparent.input input:visible').first();
    if (!(await input.isVisible().catch(() => false))) throw new SlotSyncError('編集用の入力欄が開きませんでした');
  }
  await input.fill(String(target));
  await input.press('Tab').catch(() => {});
  await input.blur().catch(() => {});
  await page.locator('[data-test=courseName]').first().click({ position: { x: 5, y: 5 } }).catch(() => {});

  await saveAndWait(page);

  // リロードして検証
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
  await jumpToDate(page, date);
  found = await locateCell(page, date, time);
  if (!found.ok) throw new SlotSyncError('保存後の再特定に失敗（要手動確認）');
  const after = await readLimit(page.locator('[data-urkt-target="1"]'));
  if (after !== target) throw new SlotSyncError(`保存検証NG：想定(${target})だがリロード後は(${after})`);
  // 売止から復帰した場合は、販売状態(◯)まで保存されたか確かめる。
  if (needReopen) {
    const openAfter = await readOpen(page.locator('[data-urkt-target="1"]'));
    if (openAfter !== true) throw new SlotSyncError(`復帰検証NG：想定(◯)だがリロード後は(${openAfter})`);
  }
  log('slot_switched', { date, time, from: before, to: after, mode, reopened: needReopen });
  return { result: 'switched', from: before, to: after };
}

// ---- reduce-urakata-slot.js から流用 ----
async function jumpToDate(page, ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const boxes = page.getByRole('textbox');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    try { await boxes.nth(i).click({ timeout: 1500 }); } catch (e) { continue; }
    const nextBtn = page.getByRole('button', { name: 'Next Month' });
    if (await nextBtn.count() === 0) continue;
    if (!(await nextBtn.first().isVisible().catch(() => false))) continue;
    let stuck = false;
    for (let hop = 0; hop < 18; hop++) {
      // 日付セルの role は gridcell。option で探していたため常に0件になり、
      // 「カレンダー入力欄が見つからない」と誤判定していた（予約検索側と同じ誤り）。
      // 実際のラベルは曜日込みの「Choose 2026年8月10日月曜日」。
      const opt = page.getByRole('gridcell', { name: new RegExp(`Choose ${y}年${m}月${d}日`) });
      if (await opt.count() > 0 && await opt.first().isVisible().catch(() => false)) {
        await opt.first().click();
        await page.waitForTimeout(1200);
        return;
      }
      try {
        await nextBtn.first().click({ timeout: 4000 });
      } catch (e) { stuck = true; break; } // ボタンが押せない＝この textbox は不適。次の候補へ
      await page.waitForTimeout(400);
    }
    if (!stuck) throw new SlotSyncError(`datepickerで ${ymd} に到達できませんでした`);
    // stuck の場合は次の textbox 候補で再試行（ループ継続）
  }
  throw new SlotSyncError('datepicker（カレンダー入力欄）が見つかりませんでした');
}

async function locateCell(page, date, time) {
  return await page.evaluate(({ dateStr, time, course }) => {
    const [yy, mm, dd] = dateStr.split('-').map(Number);
    const youbi = ['日', '月', '火', '水', '木', '金', '土'][new Date(yy, mm - 1, dd).getDay()];
    document.querySelectorAll('[data-urkt-target]').forEach(el => el.removeAttribute('data-urkt-target'));
    const labels = [...document.querySelectorAll('[data-test=courseName]')];
    const rowIdx = labels.findIndex(td => {
      const txt = td.textContent || '';
      return txt.includes(time) && (course ? txt.includes(course) : true);
    });
    if (rowIdx < 0) return { ok: false, reason: `時間 ${time} の行が見つからない` };
    const headerDivs = [...document.querySelectorAll('[data-test=calendarDayHeader]')];
    const headerDiv = headerDivs.find(h => (h.textContent || '').replace(/\s+/g, '') === `${dd}${youbi}`);
    if (!headerDiv) return { ok: false, reason: `日付 ${dd}(${youbi}) のヘッダが見つからない` };
    const headerCell = headerDiv.closest('th, td');
    const headerRowCells = [...headerCell.parentElement.children];
    const colIdx = headerRowCells.indexOf(headerCell);
    const probe = document.querySelector('[data-test=calendarSeatCount]');
    if (!probe) return { ok: false, reason: 'カレンダーセルが見つからない' };
    const grid = probe.closest('table');
    const gridRows = [...grid.querySelectorAll('tbody tr')];
    if (rowIdx >= gridRows.length) return { ok: false, reason: 'グリッド行数不足' };
    const rowCells = [...gridRows[rowIdx].cells];
    if (colIdx >= rowCells.length) return { ok: false, reason: 'グリッド列数不足' };
    rowCells[colIdx].setAttribute('data-urkt-target', '1');
    return { ok: true, rowIdx, colIdx, header: `${dd}(${youbi})` };
  }, { dateStr: date, time: time, course: CONFIG.course });
}

// 保存ボタンが有効になるのを待って押し、レスポンスを待つ。
async function saveAndWait(page) {
  const saveBtn = page.locator('[data-test="saveBtn"]');
  await saveBtn.waitFor({ state: 'visible', timeout: 10000 });
  for (let w = 0; w < 20; w++) {
    if (await saveBtn.isEnabled().catch(() => false)) break;
    await page.waitForTimeout(500);
  }
  if (!(await saveBtn.isEnabled().catch(() => false))) throw new SlotSyncError('保存ボタンが有効になりませんでした');
  const saveResp = page.waitForResponse(res => res.request().method() !== 'GET', { timeout: 15000 }).catch(() => null);
  await saveBtn.click();
  await saveResp;
  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle').catch(() => {});
}

// リロードして対象セルを取り直し、販売状態を読む（保存検証用）。
async function reloadAndReadOpen(page, date, time) {
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
  await jumpToDate(page, date);
  const found = await locateCell(page, date, time);
  if (!found.ok) throw new SlotSyncError('保存後の再特定に失敗（要手動確認）');
  return await readOpen(page.locator('[data-urkt-target="1"]'));
}

// 販売状態（◯=販売中 / ✕=売止）。data-test で安定して取得できる。
const OPEN_SELECTOR = '[data-test=calendarOpen]';
async function readOpen(cell) {
  const t = await cell.locator(OPEN_SELECTOR).first().innerText().catch(() => null);
  if (t === null) return null;
  const s = t.trim();
  if (/[◯○◎]/.test(s)) return true;
  if (/[✕✖×]/.test(s)) return false;
  return null;
}

async function readLimit(cell) {
  const txt = await cell.locator('[data-test=calendarRealtimeLimit]').first().innerText().catch(() => null);
  if (txt === null) return null;
  const n = parseInt(txt.replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

async function shot(p) { await p.screenshot({ path: 'error-urakata-mode.png', fullPage: true }).catch(() => {}); }

// ウラカタにログイン。認証コード（2段階認証）が要求されたら、GAS経由でGmailから
// 最新コードを取得して入力する。landingName はログイン後に現れるリンク名（例 '予約枠'）。
async function urakataLogin(page, url, id, password, landingName) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.getByRole('textbox', { name: 'ログインID' }).fill(id);
  await page.getByRole('textbox', { name: 'パスワード' }).fill(password);
  const loginStart = Date.now() - 3000;
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForTimeout(3000);

  const landing = page.getByRole('link', { name: landingName });
  const loggedIn = async () => (await landing.count()) > 0 && await landing.first().isVisible().catch(() => false);
  if (await loggedIn()) { log('login_ok'); return; }

  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (/認証コード|認証番号|コードを入力|ワンタイム/.test(bodyText)) {
    log('auth_code_required');
    const code = await fetchAuthCode(loginStart);
    if (!code) throw new SlotSyncError('認証コードをGmail(GAS)から取得できませんでした');
    log('auth_code_fetched', { code: '****' + code.slice(-2) });
    let input = page.locator('input:visible').first();
    if (await input.count() === 0) input = page.locator('input[type=text], input[type=tel], input[type=number], input:not([type])').first();
    await input.fill(code);
    const btn = page.getByRole('button', { name: /認証|ログイン|送信|確認|次へ/ }).first();
    if (await btn.count() > 0) await btn.click(); else await input.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  await landing.first().waitFor({ state: 'visible', timeout: 20000 });
  log('login_ok');
}

async function fetchAuthCode(sinceMs) {
  const gurl = process.env.GAS_RECONCILE_URL, token = process.env.RECONCILE_TOKEN;
  if (!gurl || !token) throw new SlotSyncError('GAS_RECONCILE_URL / RECONCILE_TOKEN 未設定（認証コード取得に必要）');
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(gurl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action: 'urkt_auth_code', sinceMs }), redirect: 'follow',
      });
      const txt = await res.text();
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { const j = JSON.parse(m[0]); if (j && j.code) return String(j.code); }
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 4000));
  }
  return '';
}

main();
