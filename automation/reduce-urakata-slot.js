// ============================================================
// ウラカタ (urkt.in) 在庫枠 自動調整スクリプト
// ------------------------------------------------------------
// ウラカタ＝アソビューの在庫は共通のため、ここを調整すれば両方に反映される。
//
// 画面構造（実DOM確認済み）：
//   - 予約枠ページ：左表=行ラベル（td[data-test=courseName] に コース名/時間）、
//     右グリッド=日付ごとのセル（行順は左表と対応）
//   - セル内: [data-test=calendarSeatCount]="0/20"（予約数/定員）
//             [data-test=calendarRealtimeLimit]="( 6 )"（即時販売の在庫数）
//   - セルをクリック → 入力欄が出る → 絶対値を入力 → [data-test=saveBtn] で保存
//   - 日付ジャンプ：datepicker（Next Monthボタン + "Choose YYYY年M月D日..."オプション）
//
// 環境変数：
//   URKT_ID / URKT_PASSWORD
//   SLOT_DATE (YYYY-MM-DD or YYYY/MM/DD) / SLOT_TIME (HH:MM)
//   SLOT_DELTA  : 符号付き増減（例 "-2"=2減らす / "+2"=2戻す）
//   DRY_RUN (既定 true) / HEADLESS (既定 true) / MAX_ABS_DELTA (既定 10)
//   COURSE_KEYWORD : 行の絞り込み用コース名キーワード（既定 "SUP"）
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  topUrl:   'https://the-retreat-place.urkt.in/login',
  id:       process.env.URKT_ID,
  password: process.env.URKT_PASSWORD,
  date:     normalizeYmd(process.env.SLOT_DATE),
  time:     normalizeHm(process.env.SLOT_TIME),
  delta:    parseInt(process.env.SLOT_DELTA || '0', 10),
  // 絶対値同期用：指定があれば before+delta ではなくこの値を目標在庫にする
  targetStock: (process.env.SLOT_TARGET_STOCK != null && process.env.SLOT_TARGET_STOCK !== '')
    ? parseInt(process.env.SLOT_TARGET_STOCK, 10) : null,
  course:   process.env.COURSE_KEYWORD || 'SUP',
  dryRun:   process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  maxAbs:   parseInt(process.env.MAX_ABS_DELTA || '10', 10),
  logPath:  process.env.LOG_PATH || 'run-log-urakata.jsonl',
};

const RUN_LOG = [];
function log(event, data = {}) {
  const rec = { ts: new Date().toISOString(), event, ...data };
  RUN_LOG.push(rec);
  console.log(`${rec.ts} [${event}] ${JSON.stringify(data)}`);
}
function flushLog(extra = {}) {
  try {
    RUN_LOG.push({ ts: new Date().toISOString(), event: 'summary',
      date: CONFIG.date, time: CONFIG.time, delta: CONFIG.delta, dryRun: CONFIG.dryRun, ...extra });
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

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('URKT_ID');
  if (!CONFIG.password) miss.push('URKT_PASSWORD');
  if (!CONFIG.date)     miss.push('SLOT_DATE');
  if (!CONFIG.time)     miss.push('SLOT_TIME');
  if (CONFIG.targetStock === null && !CONFIG.delta) miss.push('SLOT_DELTA または SLOT_TARGET_STOCK');
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
  if (Math.abs(CONFIG.delta) > CONFIG.maxAbs) {
    throw new Error(`増減 ${CONFIG.delta} が上限 ±${CONFIG.maxAbs} を超えています（安全停止）`);
  }
}

async function main() {
  assertConfig();
  log('start', { date: CONFIG.date, time: CONFIG.time, delta: CONFIG.delta, dryRun: CONFIG.dryRun });

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();
  let result = 'unknown';

  try {
    // ---------- 1. ログイン（認証コードが要求されたらGmail経由で自動入力） ----------
    await urakataLogin(page, CONFIG.topUrl, CONFIG.id, CONFIG.password, '予約枠');

    // ---------- 2. 予約枠ページへ ----------
    await page.getByRole('link', { name: '予約枠' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
    log('slot_page_opened');

    // ---------- 3. 対象日へジャンプ（datepicker） ----------
    await jumpToDate(page, CONFIG.date);

    // ---------- 4. 対象セルを特定 ----------
    const found = await locateCell(page);
    if (!found.ok) {
      await shot(page);
      throw new SlotSyncError(`対象枠が見つかりません: ${found.reason}（headers=${JSON.stringify(found.headers || [])} rows=${JSON.stringify(found.rows || [])}）`);
    }
    log('cell_located', { row: found.rowIdx, col: found.colIdx, header: found.header });

    const cell = page.locator('[data-urkt-target="1"]');
    const before = await readLimit(cell);
    log('limit_before', { before });
    if (before === null) {
      await shot(page);
      throw new SlotSyncError('即時販売在庫（calendarRealtimeLimit）を読み取れませんでした');
    }

    const target = CONFIG.targetStock !== null
      ? Math.max(0, CONFIG.targetStock)
      : Math.max(0, before + CONFIG.delta);
    log('plan', { before, target, mode: CONFIG.targetStock !== null ? 'absolute' : 'delta' });

    if (CONFIG.dryRun) {
      result = 'dry_run';
      log('dry_run', { note: '変更せず確認のみ' });
    } else {
      // ---------- 5. セルをクリック→入力→保存 ----------
      // 在庫数の表示部分（( n ) の部分）をクリックすると編集モードになる
      await cell.locator('[data-test=calendarRealtimeLimit]').first().click();
      await page.waitForTimeout(600);

      // 入力欄はセル内に現れるはず。まずセル内→見つからなければページ全体で探す
      let input = cell.locator('input:visible').first();
      if (await input.count() === 0) {
        input = page.locator('.ui.transparent.input input:visible').first();
      }
      const inputVisible = await input.isVisible().catch(() => false);
      log('editor_state', { inputVisible });
      if (!inputVisible) {
        // クリック位置を変えて再試行（セル本体）
        await cell.click();
        await page.waitForTimeout(600);
        input = cell.locator('input:visible').first();
        if (await input.count() === 0) input = page.locator('.ui.transparent.input input:visible').first();
        if (!(await input.isVisible().catch(() => false))) {
          await shot(page);
          throw new SlotSyncError('編集用の入力欄が開きませんでした（クリック位置のセレクタ要調整）');
        }
      }

      await input.fill(String(target));
      const typed = await input.inputValue().catch(() => null);
      log('input_filled', { typed });

      // 入力欄からフォーカスを外さないと保存ボタンが有効にならない
      await input.press('Tab').catch(() => {});
      await input.blur().catch(() => {});
      await page.locator('[data-test=courseName]').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
      const saveBtn = page.locator('[data-test="saveBtn"]');
      await saveBtn.waitFor({ state: 'visible', timeout: 10000 });
      // 有効になるまで待つ（最大10秒）
      for (let w = 0; w < 20; w++) {
        if (await saveBtn.isEnabled().catch(() => false)) break;
        await page.waitForTimeout(500);
      }
      const btnEnabled = await saveBtn.isEnabled().catch(() => null);
      log('save_button', { count: await saveBtn.count(), enabled: btnEnabled });
      if (!btnEnabled) {
        await shot(page);
        throw new SlotSyncError('保存ボタンが有効になりませんでした（フォーカス外し方法の要調整）');
      }

      const saveResp = page.waitForResponse(
        res => res.request().method() !== 'GET',
        { timeout: 15000 },
      ).catch(() => null);
      await saveBtn.click();
      const resp = await saveResp;
      log('save_request', { matched: !!resp, url: resp ? resp.url() : null, status: resp ? resp.status() : null });
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle').catch(() => {});

      // ---------- 6. リロードしてサーバー値で検証 ----------
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('[data-test=courseName]', { timeout: 20000 });
      await jumpToDate(page, CONFIG.date);
      const found2 = await locateCell(page);
      if (!found2.ok) throw new SlotSyncError('保存後の再特定に失敗（要手動確認）');
      const after = await readLimit(page.locator('[data-urkt-target="1"]'));
      log('limit_after', { after });
      if (after !== target) {
        result = 'not_persisted';
        await shot(page);
        throw new SlotSyncError(`保存検証NG：想定(${target})だがリロード後は(${after})`);
      }
      result = 'adjusted';
      log('adjusted', { before, after });
    }
    await page.screenshot({ path: 'result-urakata.png', fullPage: true }).catch(() => {});
  } catch (err) {
    result = result === 'unknown' ? 'error' : result;
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await shot(page);
    process.exitCode = 1;
  } finally {
    flushLog({ result });
    await browser.close();
  }
}

// datepickerで対象日に移動する。
// テキストボックスを順に試し、カレンダー（Next Monthボタン）が開いたものを使う。
async function jumpToDate(page, ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const boxes = page.getByRole('textbox');
  const n = await boxes.count();
  for (let i = 0; i < n; i++) {
    try {
      await boxes.nth(i).click({ timeout: 1500 });
    } catch (e) { continue; }
    const nextBtn = page.getByRole('button', { name: 'Next Month' });
    if (await nextBtn.count() === 0) continue;
    if (!(await nextBtn.first().isVisible().catch(() => false))) continue;

    // カレンダーが開いた。対象月まで送って日付を選ぶ
    for (let hop = 0; hop < 18; hop++) {
      // 日付セルの role は gridcell。option で探していたため常に0件になり、
      // 「カレンダー入力欄が見つからない」と誤判定していた（予約検索側と同じ誤り）。
      // 実際のラベルは曜日込みの「Choose 2026年8月10日月曜日」。
      const opt = page.getByRole('gridcell', { name: new RegExp(`Choose ${y}年${m}月${d}日`) });
      if (await opt.count() > 0 && await opt.first().isVisible().catch(() => false)) {
        await opt.first().click();
        await page.waitForTimeout(1200);
        log('date_jumped', { ymd, viaTextbox: i });
        return;
      }
      await nextBtn.first().click();
      await page.waitForTimeout(400);
    }
    throw new SlotSyncError(`datepickerで ${ymd} に到達できませんでした`);
  }
  throw new SlotSyncError('datepicker（カレンダー入力欄）が見つかりませんでした');
}

// 対象の「行（コース×時間）×列（日付）」のセルを特定し、data-urkt-target="1" を付与する
async function locateCell(page) {
  const [y, m, d] = CONFIG.date.split('-').map(Number);
  // 曜日照合用（別月の同じ日を誤選択しないための安全チェック）
  const youbi = ['日', '月', '火', '水', '木', '金', '土'][new Date(y, m - 1, d).getDay()];
  return await page.evaluate(({ dd, youbi, time, course }) => {
    // 既存マーカーを掃除
    document.querySelectorAll('[data-urkt-target]').forEach(el => el.removeAttribute('data-urkt-target'));

    // --- 行の特定（左表の courseName） ---
    const labels = [...document.querySelectorAll('[data-test=courseName]')];
    const rows = labels.map(td => (td.textContent || '').replace(/\s+/g, ' ').trim());
    const rowIdx = labels.findIndex(td => {
      const txt = td.textContent || '';
      return txt.includes(time) && (course ? txt.includes(course) : true);
    });
    if (rowIdx < 0) return { ok: false, reason: `時間 ${time} の行が見つからない`, rows };

    // --- 列の特定（data-test=calendarDayHeader：日にち数字＋曜日） ---
    const headerDivs = [...document.querySelectorAll('[data-test=calendarDayHeader]')];
    const headers = headerDivs.map(h => (h.textContent || '').replace(/\s+/g, ''));
    const headerDiv = headerDivs.find(h => {
      const t = (h.textContent || '').replace(/\s+/g, '');
      return t === `${dd}${youbi}`;   // 例: "14木"（日にち＋曜日の完全一致）
    });
    if (!headerDiv) return { ok: false, reason: `日付 ${dd}(${youbi}) のヘッダが見つからない`, headers, rows };
    const headerCell = headerDiv.closest('th, td');
    if (!headerCell) return { ok: false, reason: 'ヘッダのセル要素が特定できない', headers };
    const headerRowCells = [...headerCell.parentElement.children];
    const colIdx = headerRowCells.indexOf(headerCell);

    // --- セルの特定（在庫グリッドの同じ行番号・列番号） ---
    const probe = document.querySelector('[data-test=calendarSeatCount]');
    if (!probe) return { ok: false, reason: 'カレンダーセルが見つからない', rows };
    const grid = probe.closest('table');
    const gridRows = [...grid.querySelectorAll('tbody tr')];
    if (rowIdx >= gridRows.length) return { ok: false, reason: `グリッド行数不足 (${gridRows.length})`, rows };
    const rowCells = [...gridRows[rowIdx].cells];
    if (colIdx >= rowCells.length) return { ok: false, reason: `グリッド列数不足 (${rowCells.length}, col=${colIdx})`, headers };
    rowCells[colIdx].setAttribute('data-urkt-target', '1');
    return { ok: true, rowIdx, colIdx, header: `${dd}(${youbi})` };
  }, { dd: d, youbi, time: CONFIG.time, course: CONFIG.course });
}

// セル内の即時販売在庫 "( 6 )" を読む
async function readLimit(cell) {
  const txt = await cell.locator('[data-test=calendarRealtimeLimit]').first().innerText().catch(() => null);
  if (txt === null) return null;
  const n = parseInt(txt.replace(/[^\d]/g, ''), 10);
  return Number.isNaN(n) ? null : n;
}

async function shot(p) {
  await p.screenshot({ path: 'error-urakata.png', fullPage: true }).catch(() => {});
}

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
