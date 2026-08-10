// ============================================================
// じゃらん遊び・体験 枠モード「監査（読み取り専用）」スクリプト
// ------------------------------------------------------------
// 各枠の現在の予約タイプ（即時予約 / リクエスト予約 / 併用 / 販売なし）を
// セルアイコンから読み取るだけ。変更は一切しない。mode-jalan-slot.js を流用。
//   icon-confirmed=即時 / icon-unconfirmed=リクエスト / icon-combination=併用
//
// 環境変数：
//   JALAN_ID / JALAN_PASSWORD / SHOP_NAME
//   SLOTS: JSON配列 '[{"date":"2026-08-14","time":"13:30"}, ...]'
//   OUT_PATH (既定 audit-jalan-mode.json) / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:   'https://activityboard.jp/',
  id:       process.env.JALAN_ID,
  password: process.env.JALAN_PASSWORD,
  shopName: process.env.SHOP_NAME || 'のみくい処 七ツ家',
  headless: process.env.HEADLESS !== 'false',
  outPath:  process.env.OUT_PATH || 'audit-jalan-mode.json',
  maxWindowAdvance: 30,
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
  })
  // 昇順（カレンダーは前進のみ）
  .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
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
  let mng = null;
  const results = [];

  try {
    await page.goto(CONFIG.topUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'ログイン' }).click();
    await page.getByRole('textbox', { name: 'AirIDまたはメールアドレス' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    await page.getByRole('link', { name: CONFIG.shopName }).click();
    await page.waitForLoadState('networkidle');
    log('shop_selected', { shop: CONFIG.shopName });

    const mngLink = page.getByRole('link', { name: '予約・販売管理', exact: true });
    await mngLink.waitFor({ state: 'visible', timeout: 30000 });
    const popupPromise = page.waitForEvent('popup', { timeout: 8000 }).catch(() => null);
    await mngLink.click();
    const popup = await popupPromise;
    mng = popup || page;
    await mng.waitForLoadState('networkidle');
    log('management_opened', { popup: !!popup });

    for (const t of targets) {
      try {
        const cell = await getCell(mng, t.date, t.time);
        const mode = await readCellMode(cell);
        const remainImmediate = await readStock(cell); // 残数
        results.push({ site: 'jalan', date: t.date, time: t.time, mode: mode || 'unknown', raw: mode, remainImmediate });
        log('slot', { date: t.date, time: t.time, mode, remainImmediate });
      } catch (e) {
        results.push({ site: 'jalan', date: t.date, time: t.time, mode: 'not_found', raw: null, message: e.message });
        log('slot_skip', { date: t.date, time: t.time, message: e.message });
      }
    }
    log('done', { total: results.length });
    await mng.screenshot({ path: 'audit-jalan-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await (mng || page).screenshot({ path: 'audit-jalan-mode-error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(CONFIG.outPath, JSON.stringify(results, null, 2));
    await browser.close();
  }
}

// ---- 以下 mode-jalan-slot.js から流用（セル特定・アイコン判定） ----
async function getCell(mng, date, time) {
  const col = await locateDateColumn(mng, date);
  if (col.index < 0) throw new AuditError(`対象日 ${date} をカレンダーで特定できません`);
  const cell = await locateSlotCell(mng, time, col.index);
  if (!cell) throw new AuditError(`時間 ${time} の枠を特定できません`);
  return cell;
}

async function readCellMode(cell) {
  let cls = null;
  for (let i = 0; i < 6; i++) {
    cls = await cell.locator('.sales-status-wrapper [class^="icon-"]').first()
      .getAttribute('class').catch(() => null);
    if (cls) break;
    await cell.page().waitForTimeout(500);
  }
  // 売止のセルは予約方式アイコンが消え「売止」表記だけになる。これを見て
  // いなかったため、✗で正しく閉じている枠まで「不明」と報告していた。
  // 判定は mode-jalan-slot.js の readCellMode と揃える。
  if (!cls) {
    const txt = await cell.innerText().catch(() => '');
    if (txt.includes('売止')) return 'closed';
    log('cell_unreadable', { text: txt.replace(/\s+/g, ' ').trim().slice(0, 160) });
    return null;
  }
  const s = cls.toLowerCase();
  // 売止は icon-salestop。予約方式より先に判定する（売止セルは span.sale-stop に
  // 元の予約方式クラスも併記されるため）。
  if (s.includes('salestop') || s.includes('sale-stop')) return 'closed';
  if (s.includes('combination'))  return 'combination';
  if (s.includes('unconfirmed'))  return 'request';
  if (s.includes('confirmed'))    return 'immediate';
  // icon-close は span.no-operation 内の「開催なし」。mode 側と判定を揃える。
  if (s.includes('close') || s.includes('nosale') || s.includes('none')) return 'closed';
  // アイコンはあるが既知クラスに一致しない。判定材料を残す。
  const dump = await cell.evaluate(el => ({
    text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    icons: [...el.querySelectorAll('[class*="icon"]')].map(n => n.className).slice(0, 10),
  })).catch(() => null);
  log('cell_class_unknown', { cls, ...(dump || {}) });
  return null;
}

// セルの残数 .stock-cnt を読む
async function readStock(cell) {
  const txt = await cell.locator('.stock-cnt').first().innerText().catch(() => null);
  if (txt === null) return null;
  const n = parseInt(txt.replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

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

main();
