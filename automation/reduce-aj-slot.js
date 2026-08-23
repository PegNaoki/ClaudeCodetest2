// ============================================================
// アクティビティジャパン (ptn.activityjapan.com) 在庫枠 自動調整スクリプト
// ------------------------------------------------------------
// 画面構造（実DOM確認済み）：
//   - カレンダー管理・在庫管理ページ
//   - 行 tr.plan-stock：左端 th.plan-time に <span>10:00</span> /
//     <span class="plan_course_id">199565</span> / <span class="plan_id">42022</span>
//   - 各日セル td.day-block：hidden input id="{plan}_{course}_{YYYYMMDD}_val"（在庫数）
//     と div.day_{YYYYMMDD} > button
//   - 編集：日セルの button をクリック → spinbutton に絶対値入力 → 「設定」ボタン
//
// 環境変数：
//   AJ_ID / AJ_PASSWORD
//   SLOT_DATE (YYYY-MM-DD or /) / SLOT_TIME (HH:MM) / SLOT_DELTA (符号付き)
//   DRY_RUN (既定 true) / HEADLESS (既定 true) / MAX_ABS_DELTA (既定 10)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';

const CONFIG = {
  loginUrl: 'https://ptn.activityjapan.com/login',
  id:       process.env.AJ_ID,
  password: process.env.AJ_PASSWORD,
  date:     normalizeYmd(process.env.SLOT_DATE),
  time:     normalizeHm(process.env.SLOT_TIME),
  delta:    parseInt(process.env.SLOT_DELTA || '0', 10),
  // 絶対値同期用：指定があれば before+delta ではなくこの値を目標在庫にする
  targetStock: (process.env.SLOT_TARGET_STOCK != null && process.env.SLOT_TARGET_STOCK !== '')
    ? parseInt(process.env.SLOT_TARGET_STOCK, 10) : null,
  dryRun:   process.env.DRY_RUN !== 'false',
  headless: process.env.HEADLESS !== 'false',
  maxAbs:   parseInt(process.env.MAX_ABS_DELTA || '10', 10),
  logPath:  process.env.LOG_PATH || 'run-log-aj.jsonl',
  maxMonthNav: 14,
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
function ymdCompact(d) { return d.replace(/-/g, ''); } // 2026-08-14 -> 20260814

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('AJ_ID');
  if (!CONFIG.password) miss.push('AJ_PASSWORD');
  if (!CONFIG.date)     miss.push('SLOT_DATE');
  if (!CONFIG.time)     miss.push('SLOT_TIME');
  if (process.env.DIAG_FIELDS !== 'true' && CONFIG.targetStock === null && !CONFIG.delta) miss.push('SLOT_DELTA または SLOT_TARGET_STOCK');
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
    slowMo: parseInt(process.env.SLOW_MO || '0', 10), // 録画/目視用に各操作を遅延（ms）
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();
  let result = 'unknown';

  try {
    // ---------- 1. ログイン ----------
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログインする' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 2. カレンダー管理・在庫管理へ ----------
    await openCalendarMenu(page);
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('tr.plan-stock', { timeout: 20000 });
    log('calendar_opened');

    // ---------- 3. 対象月を表示 ----------
    const compact = ymdCompact(CONFIG.date);   // 20260814
    await ensureMonthShown(page, compact);

    // ---------- 4. 対象の行(時間)を特定し plan/course を取得 ----------
    const ids = await page.evaluate((time) => {
      const rows = [...document.querySelectorAll('tr.plan-stock')];
      for (const row of rows) {
        const t = row.querySelector('.plan-time span');
        if (t && (t.textContent || '').trim() === time) {
          const course = row.querySelector('.plan_course_id');
          const plan   = row.querySelector('.plan_id');
          return { plan: plan ? plan.textContent.trim() : '', course: course ? course.textContent.trim() : '' };
        }
      }
      return null;
    }, CONFIG.time);
    if (!ids) throw new SlotSyncError(`時間 ${CONFIG.time} の行が見つかりません`);
    log('row_located', ids);

    const valId = `${ids.plan}_${ids.course}_${compact}_val`;
    const before = await readVal(page, valId);
    log('val_before', { valId, before });
    if (before === null) throw new SlotSyncError(`在庫値(${valId})を読み取れませんでした（対象月/枠を要確認）`);

    const target = CONFIG.targetStock !== null
      ? Math.max(0, CONFIG.targetStock)
      : Math.max(0, before + CONFIG.delta);
    log('plan', { before, target, mode: CONFIG.targetStock !== null ? 'absolute' : 'delta' });

    // 診断：日セルのフォームを開き、表示中の入力欄を洗い出す（保存・例外なし＝LINE誤報を出さない）
    if (process.env.DIAG_FIELDS === 'true') {
      const dayBtn = page.locator(`.day_${compact} button`).first();
      await dayBtn.click();
      await page.waitForTimeout(1200);
      const fields = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('input, select, textarea').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return; // 非表示は除外
          out.push({ tag: el.tagName, type: el.type || '', id: el.id || '', name: el.name || '',
                     value: el.value, role: el.getAttribute('role') || '',
                     aria: el.getAttribute('aria-label') || '', ph: el.placeholder || '' });
        });
        return out.slice(0, 60);
      });
      log('diag_fields', { count: fields.length, fields });
      result = 'diag';
      await page.screenshot({ path: 'result-aj.png', fullPage: true }).catch(() => {});
      return;
    }

    if (CONFIG.dryRun) {
      result = 'dry_run';
      log('dry_run', { note: '変更せず確認のみ' });
    } else {
      // ---------- 5. 日セルのボタン→spinbutton→設定 ----------
      // 同じ .day_YYYYMMDD が全時間帯の行に存在するため、first() では
      // 常に先頭行(最も早い時間)を選んでしまう。対象の在庫値(valId)を
      // 内包するセルに限定して、正しい行×日付のボタンを押す。
      const dayBtn = page.locator(`td:has(input[id="${valId}"]) button`).first();
      if (await dayBtn.count() === 0) {
        throw new SlotSyncError(`対象セルのボタンが見つかりません（valId=${valId}）`);
      }
      await dayBtn.click();
      const spin = page.getByRole('spinbutton').first();
      await spin.waitFor({ state: 'visible', timeout: 8000 });
      // 診断：入力欄の上限(max/min)と、fill後に実際に入った値（AJ側で丸められると分かる）
      const spinAttrs = await spin.evaluate(el => ({ max: el.max, min: el.min, step: el.step })).catch(() => ({}));
      log('spin_attrs', spinAttrs);
      await spin.fill(String(target));
      const spinFilled = await spin.inputValue().catch(() => null);
      log('spin_filled', { requested: target, actual: spinFilled });
      const saveResp = page.waitForResponse(res => res.request().method() !== 'GET', { timeout: 12000 }).catch(() => null);
      await page.getByRole('button', { name: '設定' }).click();
      const resp = await saveResp;
      log('save_request', { matched: !!resp, url: resp ? resp.url() : null, status: resp ? resp.status() : null });
      await page.waitForTimeout(2000);
      await page.waitForLoadState('networkidle').catch(() => {});

      // ---------- 6. リロードして検証 ----------
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('tr.plan-stock', { timeout: 20000 });
      await ensureMonthShown(page, compact);
      const after = await readVal(page, valId);
      log('val_after', { after });
      if (after !== target) {
        result = 'not_persisted';
        await shot(page);
        throw new SlotSyncError(`保存検証NG：想定(${target})だがリロード後は(${after})`);
      }
      result = 'adjusted';
      log('adjusted', { before, after });
    }
    await page.screenshot({ path: 'result-aj.png', fullPage: true }).catch(() => {});
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

// 「カレンダー管理・在庫管理」へ遷移する。メニュー展開に頼らずhrefを直接たどる（ヘッドレス対応）。
async function openCalendarMenu(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  // サイドバー描画を待ちつつ、対象リンクのhrefを取得（最大20秒ポーリング）
  let href = null;
  for (let i = 0; i < 20; i++) {
    href = await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find(x => (x.textContent || '').replace(/\s+/g, '').includes('カレンダー管理・在庫管理'));
      return a ? a.getAttribute('href') : null;
    });
    if (href) break;
    await page.waitForTimeout(1000);
  }
  if (href && href !== '#') {
    await page.goto(new URL(href, page.url()).href, { waitUntil: 'networkidle' });
    return;
  }
  // hrefが取れない場合はメニュー展開→クリック
  const parent = page.locator('a, li, span', { hasText: 'カレンダー管理' }).first();
  if (await parent.count() > 0) { await parent.click().catch(() => {}); await page.waitForTimeout(1500); }
  const link = page.getByRole('link', { name: 'カレンダー管理・在庫管理' }).first();
  if (await link.count() > 0) {
    await link.click({ force: true }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    return;
  }
  throw new SlotSyncError('カレンダー管理・在庫管理メニューを開けませんでした');
}

// 対象日(YYYYMMDD)のセルが表示されるまで対象月へ移動する。
// AJは「2026年8月」のような月ボタンを直接クリックして飛ぶ方式。
async function ensureMonthShown(page, compact) {
  if (await page.locator(`.day_${compact}`).count() > 0) { log('month_ok', { compact, nav: 0 }); return; }

  const year  = Number(compact.slice(0, 4));
  const month = Number(compact.slice(4, 6));
  const want  = `${year}年${month}月`;
  const key   = (t) => { const m = String(t).match(/(\d{4})年(\d{1,2})月/); return m ? Number(m[1]) * 12 + Number(m[2]) : -1; };
  const target = key(want);

  const listMonths = () => page.evaluate(() =>
    [...document.querySelectorAll('button, a, [role="button"]')]
      .map(e => (e.textContent || '').replace(/\s+/g, ''))
      .filter(t => /^\d{4}年\d{1,2}月$/.test(t)));

  const clickMonth = (label) => page.evaluate((w) => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')]
      .find(e => (e.textContent || '').replace(/\s+/g, '') === w);
    if (el) { el.click(); return true; }
    return false;
  }, label);

  // 目的の月ボタンが画面に無いことがある（近い月しか出ない）。その場合は
  // 表示されている中で目的月に最も近い先の月へ進み、再走査して辿っていく。
  // 以前は「目的月のボタンが無ければ即あきらめる」実装だったため、9〜11月が
  // まとめて「枠が無い」扱いになっていた。実際は月へ移動できていないだけ。
  let last = '';
  for (let hop = 0; hop < 14; hop++) {
    const months = await listMonths();

    if (months.includes(want)) {
      if (await clickMonth(want)) {
        try {
          await page.waitForSelector(`.day_${compact}`, { timeout: 8000 });
          log('month_ok', { compact, via: 'textScan', hop });
          return;
        } catch { /* 未描画。次へ */ }
      }
    }

    // 目的月へ近づく踏み台を選ぶ。目的より手前で最も先の月、無ければ最も先の月。
    const below = months.filter(t => key(t) < target).sort((a, b) => key(b) - key(a));
    const step  = below[0] || months.sort((a, b) => key(b) - key(a))[0];
    if (!step || step === last) {
      log('month_nav_stuck', { compact, hop, months });
      break;                       // これ以上進めない
    }
    log('month_nav', { compact, hop, step, months });
    last = step;
    await clickMonth(step);
    await page.waitForTimeout(700);
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  const buttons = await page.$$eval('button', els => els.map(e => (e.textContent || '').replace(/\s+/g, '').trim()).filter(t => /\d{4}年\d{1,2}月/.test(t)).slice(0, 20)).catch(() => []);
  const shown = await page.$$eval('[class*="_day"]', els => {
    const s = new Set(); els.forEach(e => { const m = (e.className.match(/(\d{4}-\d{2})_day/) || [])[1]; if (m) s.add(m); }); return [...s];
  }).catch(() => []);
  throw new SlotSyncError(`対象月に移動できません（${compact}）。月ボタン候補: ${JSON.stringify(buttons)} / 表示中: ${JSON.stringify(shown)}`);
}

// hidden input の在庫値を読む（idが数字始まりのため属性セレクタを使う）
async function readVal(page, valId) {
  const loc = page.locator(`input[id="${valId}"]`);
  const statusId = valId.replace(/_val$/, '_status');
  let exists = 0, raw = null, rawStatus = null;
  // 値が未反映（空）で返ることがあるので、数回リトライして待つ。
  for (let i = 0; i < 3; i++) {
    exists = await loc.count();
    raw = exists ? await loc.inputValue().catch(() => null) : null;
    rawStatus = await page.locator(`input[id="${statusId}"]`).inputValue().catch(() => null);
    if (raw !== null && raw !== '') break;
    await page.waitForTimeout(700);
  }
  log('read_val_detail', { exists, raw, status: rawStatus });
  if (raw === null || raw === '') return null;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? null : n;
}

async function shot(p) { await p.screenshot({ path: 'error-aj.png', fullPage: true }).catch(() => {}); }

main();
