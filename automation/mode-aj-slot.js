// ============================================================
// アクティビティジャパン (ptn.activityjapan.com) 枠モード切替スクリプト（バッチ対応）
// ------------------------------------------------------------
// 枠を「即予約 ⇄ リクエスト」に切り替える。
//   status: 1=即予約(在庫あり) / 3=リクエスト / 4=満席
//   リクエスト化：日セルを選択 → 「リクエスト にする」ボタン（即反映）
//   即予約化　　：日セルを選択 → 在庫数を入力 → 「設定」ボタン
//
// 複数枠を1回のログインでまとめて処理できる（GASからの一括同期用）。
//
// 環境変数：
//   AJ_ID / AJ_PASSWORD
//   ▼ 一括指定（優先）:
//     SLOTS: JSON配列 '[{"date":"2026-08-14","time":"13:30","mode":"request","stock":0}, ...]'
//   ▼ 単一指定（手動テスト用）:
//     SLOT_DATE (YYYY-MM-DD) / SLOT_TIME (HH:MM) / MODE(request|immediate) / STOCK
//   DRY_RUN (既定 true) / HEADLESS (既定 true)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  loginUrl: 'https://ptn.activityjapan.com/login',
  id:       process.env.AJ_ID,
  password: process.env.AJ_PASSWORD,
  dryRun:   process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  logPath:  process.env.LOG_PATH || 'run-log-aj-mode.jsonl',
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
function ymdCompact(d) { return d.replace(/-/g, ''); }
// status=4 は「満席」。検証で「満席 にする」を押した結果が4だったため確定。
// （以前は 4=開催なし と誤って記載していた）
function statusMeaning(s) { return { 1: '即予約', 3: 'リクエスト', 4: '満席' }[s] || `不明(${s})`; }

// 処理対象の枠リストを組み立てる（SLOTS優先、無ければ単一env）
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
    if (mode === 'immediate' && !stock) throw new Error(`slots[${i}]: 即予約化には stock が必要`);
    return { date, time, mode, stock, compact: ymdCompact(date) };
  });
}

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('AJ_ID');
  if (!CONFIG.password) miss.push('AJ_PASSWORD');
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
    // ---------- ログイン（1回だけ） ----------
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログインする' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    if (/\/login/.test(page.url())) throw new SlotSyncError('ログインに失敗しました（ID/パスワードを確認）');
    log('login_ok', { url: page.url() });

    // ---------- カレンダー管理・在庫管理へ（1回だけ） ----------
    await openCalendarMenu(page);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('tr.plan-stock', { timeout: 20000 });
    log('calendar_opened');

    // ---------- 各枠を順に処理 ----------
    for (const task of tasks) {
      try {
        const r = await switchOneSlot(page, task);
        results.push({ ...task, ...r });
      } catch (e) {
        // 枠がAJに存在しない/月に届かない等のデータ不整合は「スキップ」（全体は失敗にしない）。
        // 保存検証NGなど運用上の異常だけを「error」として失敗＋通知対象にする。
        const skip = /見つかりません|移動できません/.test(e.message);
        log(skip ? 'slot_skip' : 'slot_error', { date: task.date, time: task.time, mode: task.mode, message: e.message });
        results.push({ ...task, result: skip ? 'skipped' : 'error', message: e.message });
      }
    }

    const ok      = results.filter(r => ['switched', 'already', 'dry_run'].includes(r.result)).length;
    const skipped = results.filter(r => r.result === 'skipped').length;
    const ng      = results.filter(r => r.result === 'error').length;
    log('done', { total: results.length, ok, skipped, ng });
    if (ng > 0) { process.exitCode = 1; } // 本当の異常時のみ失敗（🚨通知が飛ぶ）
    await page.screenshot({ path: 'result-aj-mode.png', fullPage: true }).catch(() => {});
  } catch (err) {
    log('error', { message: err.message, type: err.constructor.name });
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'error-aj-mode.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    flushLog({ results });
    await browser.close();
  }
}

// 1枠のモードを切り替える。page はログイン済み・カレンダー表示済み。
async function switchOneSlot(page, task) {
  const { date, time, mode, stock, compact } = task;
  await ensureMonthShown(page, compact);

  // 同じ時間の行が複数プラン分ある（旧プランは売止で在庫を持たない）。
  // 先頭行を決め打ちすると、対象月の在庫を持たない旧プランを掴んで
  // status が読めず「不明(null)」になる。対象日の status が実在する行を選ぶ。
  const cands = await page.evaluate((t) => {
    const out = [];
    for (const row of document.querySelectorAll('tr.plan-stock')) {
      const el = row.querySelector('.plan-time span');
      if (el && (el.textContent || '').trim() === t) {
        out.push({ plan: (row.querySelector('.plan_id') || {}).textContent?.trim() || '',
                   course: (row.querySelector('.plan_course_id') || {}).textContent?.trim() || '' });
      }
    }
    return out;
  }, time);
  if (!cands.length) throw new SlotSyncError(`時間 ${time} の行が見つかりません`);

  let ids = null, statusId = '', beforeStatus = null;
  for (const c of cands) {
    const sid = `${c.plan}_${c.course}_${compact}_status`;
    const v = await readStatus(page, sid);
    if (v !== null) { ids = c; statusId = sid; beforeStatus = v; break; }
  }
  if (!ids) {
    // 全候補で status が読めない＝その日にこのプランの枠が無い（未開設など）。
    // 書き込みに進んでも失敗するだけなので、明示的にスキップして次の枠へ。
    log('slot_skip', { date, time, mode,
      message: `対象日の枠が見つかりません（候補${cands.length}件すべて status 無し。AJ側で枠が未開設の可能性）`,
      candidates: cands.map(c => `${c.plan}_${c.course}`) });
    return { result: 'skipped', message: '対象日の枠が未開設（status無し）' };
  }
  const targetStatus = { request: 3, closed: 4, immediate: 1 }[mode];
  log('slot_before', { date, time, mode, statusId, beforeStatus, meaning: statusMeaning(beforeStatus) });

  // 予約方式が一致していても、在庫が目標とズレていれば直す必要がある。
  // 以前はここで打ち切っていたため、定員を上げても既に即予約だった枠は
  // 古い在庫のまま取り残されていた（チャネル間で残数がズレる原因）。
  let stockOk = true;
  if (mode === 'immediate') {
    const cur = await readStatusVal(page, statusId.replace(/_status$/, '_val'));
    const want = Math.max(0, Number(stock) || 0);
    stockOk = (cur === null) ? true : (cur === want);
    if (!stockOk) log('stock_mismatch', { date, time, current: cur, target: want });
  }
  if (beforeStatus === targetStatus && stockOk) {
    log('slot_already', { date, time, note: `既に${statusMeaning(targetStatus)}` });
    return { result: 'already' };
  }
  // 満席(4) は本システムが設定する状態なので、シートに従って開け直してよい。
  // （以前は 4 を「開催なし」と誤解し、復帰できない原因になっていた）
  if (CONFIG.dryRun) {
    log('slot_dry_run', { date, time, note: `${statusMeaning(beforeStatus)} → ${statusMeaning(targetStatus)}（変更せず）` });
    return { result: 'dry_run' };
  }

  // 対象行の日セルを選択
  const rowCellBtn = page.locator(`tr.plan-stock:has(.plan_course_id:text-is("${ids.course}")) .day_${compact} button`).first();
  await rowCellBtn.click();
  await page.waitForTimeout(500);

  // 実際に出ているボタンを記録する（アクセシブル名でのクリックが
  // 意図と違う要素に当たる事例があったため、押す前の状態を残す）。
  const panelButtons = await page.locator('button:visible')
    .evaluateAll(els => els.map(e => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 30))
    .catch(() => []);
  log('panel_buttons', { buttons: panelButtons });

  if (mode === 'request') {
    await clickButtonByText(page, 'リクエスト にする');
  } else if (mode === 'closed') {
    await clickButtonByText(page, '満席 にする');
  } else {
    const spin = page.getByRole('spinbutton').first();
    await spin.waitFor({ state: 'visible', timeout: 8000 });
    await spin.fill(String(stock));
    await page.getByRole('button', { name: '設定' }).click();
  }
  await page.waitForTimeout(2000);
  await page.waitForLoadState('networkidle').catch(() => {});

  // リロードして検証
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('tr.plan-stock', { timeout: 20000 });
  await ensureMonthShown(page, compact);
  const afterStatus = await readStatus(page, statusId);
  if (afterStatus !== targetStatus) {
    throw new SlotSyncError(`切替検証NG：想定(${statusMeaning(targetStatus)})だがリロード後は(${statusMeaning(afterStatus)})`);
  }
  log('slot_switched', { date, time, from: statusMeaning(beforeStatus), to: statusMeaning(afterStatus) });
  return { result: 'switched', from: beforeStatus, to: afterStatus };
}

// 「カレンダー管理・在庫管理」へ（hrefポーリング＋メニュー展開フォールバック）
async function openCalendarMenu(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  let href = null;
  for (let i = 0; i < 20; i++) {
    href = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').replace(/\s+/g, '').includes('カレンダー管理・在庫管理'));
      return a ? a.getAttribute('href') : null;
    });
    if (href) break;
    await page.waitForTimeout(1000);
  }
  if (href && href !== '#' && !href.startsWith('javascript')) {
    await page.goto(new URL(href, page.url()).href, { waitUntil: 'networkidle' });
    return;
  }
  const parent = page.locator('a, li, span', { hasText: 'カレンダー管理' }).first();
  if (await parent.count() > 0) { await parent.click().catch(() => {}); await page.waitForTimeout(1500); }
  const link = page.getByRole('link', { name: 'カレンダー管理・在庫管理' }).first();
  if (await link.count() > 0) { await link.click({ force: true }).catch(() => {}); await page.waitForLoadState('networkidle').catch(() => {}); return; }
  throw new SlotSyncError('カレンダー管理・在庫管理メニューを開けませんでした');
}

// 対象月を表示する。reduce-aj-slot.js の実装（textScan方式）と揃える。
// getByRole の accessible name では遠い月の月ボタンを拾えず、「次月」送りも
// AJ の画面には該当要素が無いため、9月以降へ移動できず全枠スキップになっていた。
async function ensureMonthShown(page, compact) {
  if (await page.locator(`.day_${compact}`).count() > 0) { log('month_ok', { compact, nav: 0 }); return; }

  const year  = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));

  // 「YYYY年M月」ボタンをテキスト内容で走査してクリックする。
  // 描画のAJAX遅延に備え waitForSelector で待ち、数回リトライする。
  for (let attempt = 1; attempt <= 4; attempt++) {
    const clicked = await page.evaluate(({ year, month }) => {
      const want = `${year}年${month}月`;
      const els = [...document.querySelectorAll('button, a, [role="button"]')];
      const el = els.find(e => (e.textContent || '').replace(/\s+/g, '') === want);
      if (el) { el.click(); return true; }
      return false;
    }, { year, month });
    if (clicked) {
      try {
        await page.waitForSelector(`.day_${compact}`, { timeout: 6000 });
        log('month_ok', { compact, via: 'textScan', attempt });
        return;
      } catch { /* 未描画。次のリトライへ */ }
    }
    await page.waitForTimeout(600);
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  // 見つからない場合は候補をログに出して停止（手掛かり用）
  const buttons = await page.$$eval('button', els => els.map(e => (e.textContent || '').replace(/\s+/g, '').trim()).filter(t => /\d{4}年\d{1,2}月/.test(t)).slice(0, 20)).catch(() => []);
  const months = await page.$$eval('[class*="_day"]', els => {
    const s = new Set(); els.forEach(e => { const m = (e.className.match(/(\d{4}-\d{2})_day/) || [])[1]; if (m) s.add(m); }); return [...s];
  }).catch(() => []);
  throw new SlotSyncError(`対象月に移動できません（${compact}）。月ボタン候補: ${JSON.stringify(buttons)} / 表示中: ${JSON.stringify(months)}`);
}

// ボタンを「表示テキストの完全一致」で押す。getByRole の accessible name は
// AJ の画面で意図しない要素に当たることがあったため、テキストで厳密に選ぶ。
async function clickButtonByText(page, label) {
  const want = label.replace(/\s+/g, '');
  const res = await page.evaluate((w) => {
    // AJ の「〜にする」は button ではないため要素種別を問わず探す。
    // 同じ文字列は祖先にも一致するので、最も内側（子孫に一致が無い）を押す。
    const all = [...document.querySelectorAll('*')].filter(e => {
      if (!(e.offsetParent)) return false;                       // 表示中のみ
      return (e.textContent || '').replace(/\s+/g, '') === w;
    });
    const innermost = all.filter(e => !all.some(o => o !== e && e.contains(o)));
    const el = innermost[0] || all[0];
    if (!el) {
      const cand = [...document.querySelectorAll('*')]
        .filter(e => e.offsetParent && /にする/.test(e.textContent || '')
                     && e.children.length === 0)
        .map(e => ({ tag: e.tagName, cls: e.className,
                     text: (e.textContent || '').replace(/\s+/g, ' ').trim() }))
        .slice(0, 20);
      return { ok: false, candidates: cand };
    }
    el.click();
    return { ok: true, tag: el.tagName, cls: String(el.className || '') };
  }, want);
  if (!res.ok) {
    log('button_not_found', { label, candidates: res.candidates });
    throw new SlotSyncError(`ボタン「${label}」が見つかりません`);
  }
  log('button_clicked', { label, tag: res.tag, cls: res.cls });
}

// 在庫（残り即予約可能数）の hidden input を読む。読めなければ null。
async function readStatusVal(page, valId) {
  const v = await page.locator(`input[id="${valId}"]`).inputValue().catch(() => null);
  if (v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

async function readStatus(page, statusId) {
  const v = await page.locator(`input[id="${statusId}"]`).inputValue().catch(() => null);
  if (v === null || v === '') return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

main();
