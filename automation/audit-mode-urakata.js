// ============================================================
// ウラカタ（アソビュー共通在庫）枠モード「監査（読み取り専用）」スクリプト
// ------------------------------------------------------------
// ウラカタには「即予約/リクエスト」の切替UIが無く、即時販売在庫
// calendarRealtimeLimit「( n )」の数字だけで決まる：
//   n > 0 → 即予約（immediate）  ／  n = 0 → リクエスト受付（request）
// その数字を読み取るだけ。変更は一切しない。mode-urakata-slot.js を流用。
//
// 環境変数：
//   URKT_ID / URKT_PASSWORD / COURSE_KEYWORD (既定 'SUP')
//   GAS_RECONCILE_URL / RECONCILE_TOKEN（2段階認証コード取得に必要）
//   SLOTS: JSON配列 '[{"date":"2026-08-14","time":"13:30"}, ...]'
//   OUT_PATH (既定 audit-urakata-mode.json) / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:   'https://the-retreat-place.urkt.in/login',
  id:       process.env.URKT_ID,
  password: process.env.URKT_PASSWORD,
  course:   process.env.COURSE_KEYWORD || 'SUP',
  headless: process.env.HEADLESS !== 'false',
  outPath:  process.env.OUT_PATH || 'audit-urakata-mode.json',
};

function log(event, data = {}) {
  console.log(`${new Date().toISOString()} [${event}] ${JSON.stringify(data)}`);
}
class AuditError extends Error {}

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
// 即時販売在庫の数字 → 共通モード語彙
// 販売状態(◯/✕)は在庫数とは別軸。売止(✕)なら在庫数に関係なく closed。
// これを見ていなかったため、売止だが在庫数が残っている枠を「即予約」と
// 誤報告していた（8/16 10:00 を「即予約/2」と誤表示した原因）。
function limitToMode(n, open) {
  if (open === false) return 'closed';
  if (n === null) return 'unknown';
  return n > 0 ? 'immediate' : 'request';
}

function buildTargets() {
  if (!process.env.SLOTS) throw new Error('SLOTS が未設定です');
  let raw;
  try { raw = JSON.parse(process.env.SLOTS); }
  catch (e) { throw new Error(`SLOTS のJSON解析に失敗: ${e.message}`); }
  if (!Array.isArray(raw)) throw new Error('SLOTS はJSON配列である必要があります');
  return raw.map((s, i) => {
    const date = normalizeYmd(s.date);
    const time = normalizeHm(s.time);
    if (!date || !time) throw new Error(`slots[${i}]: date/time が不正 (${JSON.stringify(s)})`);
    return { date, time };
  }).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function assertConfig() {
  const miss = [];
  ['id', 'password'].forEach(k => { if (!CONFIG[k]) miss.push(k.toUpperCase()); });
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}

async function main() {
  assertConfig();
  const targets = buildTargets();
  log('start', { count: targets.length });

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
    await urakataLogin(page, CONFIG.topUrl, CONFIG.id, CONFIG.password, '予約枠');
    await page.getByRole('link', { name: '予約枠' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
    log('slot_page_opened');

    for (const t of targets) {
      try {
        const r = await auditOneSlot(page, t);
        const row = {
          site: 'urakata', date: t.date, time: t.time,
          mode: limitToMode(r.limit, r.open), raw: r.limit, open: r.open,
          remainImmediate: r.limit, booked: r.booked, capacity: r.capacity,
        };
        results.push(row);
        log('slot', row);
      } catch (e) {
        results.push({ site: 'urakata', date: t.date, time: t.time, mode: 'not_found', raw: null, message: e.message });
        log('slot_skip', { date: t.date, time: t.time, message: e.message });
      }
    }
    log('done', { total: results.length });
    await page.screenshot({ path: 'audit-urakata-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'audit-urakata-mode-error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(CONFIG.outPath, JSON.stringify(results, null, 2));
    await browser.close();
  }
}

async function auditOneSlot(page, task) {
  const { date, time } = task;
  await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
  await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
  await page.keyboard.press('Escape').catch(() => {});
  await jumpToDate(page, date);
  const found = await locateCell(page, date, time);
  if (!found.ok) throw new AuditError(`対象枠が見つかりません: ${found.reason}`);
  const cell = page.locator('[data-urkt-target="1"]');
  const limit = await readLimit(cell);   // 残り即予約可能数（即時販売在庫 ( n )）
  const seat = await readSeat(cell);      // { booked, capacity }（予約数/定員）
  const open = await readOpen(cell);      // 販売状態 ◯=true / ✕=false（別軸）
  return { limit, open, booked: seat.booked, capacity: seat.capacity };
}

// ---- 以下 mode-urakata-slot.js から流用（ナビゲーション・読み取り・ログイン） ----
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
      const opt = page.getByRole('option', { name: new RegExp(`Choose ${y}年${m}月${d}日`) });
      if (await opt.count() > 0 && await opt.first().isVisible().catch(() => false)) {
        await opt.first().click();
        await page.waitForTimeout(1200);
        return;
      }
      try {
        await nextBtn.first().click({ timeout: 4000 });
      } catch (e) { stuck = true; break; }
      await page.waitForTimeout(400);
    }
    if (!stuck) throw new AuditError(`datepickerで ${ymd} に到達できませんでした`);
  }
  throw new AuditError('datepicker（カレンダー入力欄）が見つかりませんでした');
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

// 販売状態（◯=販売中 / ✕=売止）。mode-urakata-slot.js と同じ読み方。
async function readOpen(cell) {
  const t = await cell.locator('[data-test=calendarOpen]').first().innerText().catch(() => null);
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

// セル内の "予約数/定員"（例 "3/20"）を読む
async function readSeat(cell) {
  const txt = await cell.locator('[data-test=calendarSeatCount]').first().innerText().catch(() => null);
  if (txt === null) return { booked: null, capacity: null };
  const m = txt.replace(/\s/g, '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return { booked: null, capacity: null };
  return { booked: parseInt(m[1], 10), capacity: parseInt(m[2], 10) };
}

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
    if (!code) throw new AuditError('認証コードをGmail(GAS)から取得できませんでした');
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
  if (!gurl || !token) throw new AuditError('GAS_RECONCILE_URL / RECONCILE_TOKEN 未設定（認証コード取得に必要）');
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
