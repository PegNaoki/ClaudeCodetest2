// ============================================================
// ウラカタ (urkt.in) 予約一覧 読み取りスクリプト（リコンサイル用）
// ------------------------------------------------------------
// ウラカタ＝アソビュー＝Web予約の予約を読み取り、体験日が今日以降の分をJSON出力。
// メール取りこぼし検出・在庫突合の照合源として使う。
//
// 画面構造（実DOM確認済み）：
//   - 予約検索ページ → 参加日 from/to を指定 → 「検索」
//   - 結果表: table.ui.celled ... / 各行 tr.nwigeYpcuPDbQYuZcYkD
//     列: 予約者(氏名/電話), 支払済, 支払方法, 申込日時, 参加日, コース(コース名+時間), 合計, 料金, 媒体
//   - キャンセルされた予約は検索結果に出ない想定（有効な予約のみ）
//
// 環境変数：
//   URKT_ID / URKT_PASSWORD / HEADLESS (既定 true)
//   OUT_PATH (既定 urakata-reservations.json)
//   RANGE_DAYS : 参加日 今日〜N日先まで検索（既定 210＝約7ヶ月＝シーズン網羅）
//
// 注意：ウラカタは予約番号を一覧に持たないため、突合キーは
//   「参加日 + 時間 + 氏名(カナ)」で構成する（GAS側で照合）。
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import { normalize, splitKana, splitPrice } from './reservation-schema.js';

const CONFIG = {
  loginUrl: 'https://the-retreat-place.urkt.in/login',
  id:       process.env.URKT_ID,
  password: process.env.URKT_PASSWORD,
  headless: process.env.HEADLESS !== 'false',
  outPath:  process.env.OUT_PATH || 'urakata-reservations.json',
  rangeDays: parseInt(process.env.RANGE_DAYS || '210', 10),
};

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('URKT_ID');
  if (!CONFIG.password) miss.push('URKT_PASSWORD');
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}
function log(event, data = {}) {
  console.log(`${new Date().toISOString()} [${event}] ${JSON.stringify(data)}`);
}
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

async function main() {
  assertConfig();
  log('start');
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  // ヘッドレス検知で明細の展開/描画が変わり statusText が読めない問題を回避
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP', viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();

  try {
    // ---------- 1. ログイン（認証コードが要求されたらGmail経由で自動入力） ----------
    await urakataLogin(page);

    // ---------- 2. 予約検索ページへ ----------
    await page.getByRole('link', { name: '予約検索' }).click();
    await page.waitForLoadState('networkidle');
    log('search_page_opened');

    // ---------- 3. 参加日 from/to で検索（RECON_FROM/RECON_TO 指定時は過去も読む） ----------
    const RECON_FROM = process.env.RECON_FROM || '';
    const RECON_TO   = process.env.RECON_TO || '';
    const today = RECON_FROM ? new Date(RECON_FROM + 'T00:00:00') : new Date();
    const to = RECON_TO ? new Date(RECON_TO + 'T00:00:00') : (() => { const d = new Date(today); d.setDate(today.getDate() + CONFIG.rangeDays); return d; })();
    await setDateRange(page, today, to);
    await page.getByRole('button', { name: '検索' }).click();
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('table.ui.celled tbody tr', { timeout: 20000 }).catch(() => null);
    log('search_done');

    // ---------- 4. 結果テーブルを読み取り ----------
    const rows = await page.$$eval('table.ui.celled tbody tr', (trs) => trs.map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      const txt = (el) => el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      // 列順: 0=展開, 1=予約者(氏名/電話), 2=支払済, 3=支払方法, 4=申込日時,
      //       5=参加日, 6=コース(コース名+時間), 7=合計, 8=料金, 9=媒体
      const nameCell = tds[1];
      const name  = nameCell ? txt(nameCell.querySelector('div')) : '';
      const phone = nameCell && nameCell.querySelectorAll('div')[1] ? txt(nameCell.querySelectorAll('div')[1]) : '';
      const applied = txt(tds[4]);
      const joinDate = txt(tds[5]);
      const courseCell = tds[6];
      const course = courseCell ? txt(courseCell.querySelector('div')) : '';
      const timeMatch = courseCell ? (courseCell.textContent.match(/(\d{1,2}:\d{2})/) || [])[1] : '';
      const people = txt(tds[7]);
      const price  = txt(tds[8]);
      const media  = txt(tds[9]);
      return { name, phone, applied, joinDate, course, time: timeMatch || '', people, price, media };
    }));
    log('rows_read', { count: rows.length });

    // ---------- 4a. 診断：一覧行のDOMをダンプ（状態ラベルの場所を特定するため） ----------
    if (process.env.DUMP_ROW === 'true') {
      const rowDiag = await page.$$eval('table.ui.celled tbody tr', trs =>
        trs.slice(0, 20).map(tr => tr.outerHTML.replace(/\s+/g, ' ').slice(0, 2200)));
      rowDiag.forEach((h, i) => log('row_html_dump', { i, html: h }));
    }

    // ---------- 4b. 各予約の詳細を開いてステータスを判定（方式2） ----------
    // 行の .caret.right を展開すると [data-test="statusText"] にステータスが出る。
    const statuses = await readStatuses(page, rows.length);

    // ---------- 5. 体験日が今日以降のものに整形して出力 ----------
    const todayStr = ymd(today);
    const reservations = rows.map((r, idx) => {
      const m = String(r.joinDate).match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/);
      const date = m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : '';
      // 氏名セルにフリガナが同居していることがあるので分解する。
      const { name: nm, kana } = splitKana(r.name);
      // 金額に決済方法が続く場合を切り分ける。
      const { price, payment } = splitPrice(r.price);
      return normalize({
        site: 'ウラカタ',
        bookingNo: null,           // ウラカタの一覧には予約番号の列が無い
        status: statuses[idx] || '確定',   // 確定 / 仮予約 / キャンセル
        date, time: r.time,
        people: r.people,
        name: nm, kana,
        phone: r.phone,
        plan: r.course,
        price, payment,
        media: r.media,
        applied: r.applied,        // 申込日時（読んでいたが出力から漏れていた）
        note: null,
      });
    }).filter((r) => r.date && (RECON_FROM ? (r.date >= RECON_FROM && r.date <= RECON_TO) : r.date >= todayStr));

    const result = {
      fetchedAt: new Date().toISOString(),
      site: 'ウラカタ',
      totalFetched: rows.length,
      totalFuture: reservations.length,
      today: todayStr,
      reservations,
    };
    fs.writeFileSync(CONFIG.outPath, JSON.stringify(result, null, 2));
    log('done', { fetched: rows.length, future: reservations.length, out: CONFIG.outPath });

    console.log('\n===== 今日以降の予約（ウラカタ）=====');
    for (const r of reservations) {
      console.log(`${r.date} ${r.time} [${r.status}] ${r.name} ${r.people}名 [${r.media}]`);
    }
  } catch (err) {
    log('error', { message: err.message });
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'reconcile-urakata-error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// ウラカタにログイン。認証コード（2段階認証）が要求されたら、
// GAS経由でGmailから最新コードを取得して入力する。
async function urakataLogin(page) {
  await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
  await page.getByRole('textbox', { name: 'ログインID' }).fill(CONFIG.id);
  await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
  const loginStart = Date.now() - 3000; // 直前に届いたコードも許容する余裕
  await page.getByRole('button', { name: 'ログイン' }).click();
  await page.waitForTimeout(3000);

  const searchLink = page.getByRole('link', { name: '予約検索' });
  const loggedIn = async () => (await searchLink.count()) > 0 && await searchLink.first().isVisible().catch(() => false);
  if (await loggedIn()) { log('login_ok'); return; }

  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  if (/認証コード|認証番号|コードを入力|ワンタイム/.test(bodyText)) {
    log('auth_code_required');
    const dump = await page.evaluate(() => ({
      inputs:  [...document.querySelectorAll('input')].map(el => ({ name: el.name, type: el.type, ph: el.placeholder, vis: !!el.offsetParent })),
      buttons: [...document.querySelectorAll('button')].map(el => ((el.textContent || '').trim())),
    })).catch(() => null);
    log('auth_page_dump', dump || {});

    const code = await fetchAuthCode(loginStart);
    if (!code) throw new Error('認証コードをGmail(GAS)から取得できませんでした');
    log('auth_code_fetched', { code: '****' + code.slice(-2) });

    let input = page.locator('input:visible').first();
    if (await input.count() === 0) input = page.locator('input[type=text], input[type=tel], input[type=number], input:not([type])').first();
    await input.fill(code);
    const btn = page.getByRole('button', { name: /認証|ログイン|送信|確認|次へ/ }).first();
    if (await btn.count() > 0) await btn.click(); else await input.press('Enter');
    await page.waitForLoadState('networkidle').catch(() => {});
  }

  await searchLink.first().waitFor({ state: 'visible', timeout: 20000 });
  log('login_ok');
}

// GAS のエンドポイントから、loginStart 以降に届いた認証コードを取得（メール到着待ちでリトライ）
async function fetchAuthCode(sinceMs) {
  const url = process.env.GAS_RECONCILE_URL, token = process.env.RECONCILE_TOKEN;
  if (!url || !token) throw new Error('GAS_RECONCILE_URL / RECONCILE_TOKEN 未設定（認証コード取得に必要）');
  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, action: 'urkt_auth_code', sinceMs }), redirect: 'follow',
      });
      const txt = await res.text();
      const m = txt.match(/\{[\s\S]*\}/);
      if (m) { const j = JSON.parse(m[0]); if (j && j.code) return String(j.code); }
    } catch (e) { /* リトライ */ }
    await new Promise(r => setTimeout(r, 4000));
  }
  return '';
}

// 各行の最後のセルのアイコンSVGの「パス形状(d)」で状態を判定する。
// ウラカタは色を currentColor（CSSクラス）で塗るため #色 は当てにならない。形状は状態固有：
//   チェック "M21.994 9.29102…"                 ＝ 確定
//   「R」字  "M10.6721 8.79797…"（リクエスト字形）＝ 仮予約(リクエスト・未承認)
//   ×       "M22.3 11.522…" / 横棒 "M29 14…"     ＝ キャンセル/却下
async function readStatuses(page, expectedCount) {
  const statuses = await page.$$eval('table.ui.celled tbody tr', (trs) => trs.map((tr) => {
    const tds   = tr.querySelectorAll('td');
    const last  = tds[tds.length - 1];
    const paths = last ? Array.from(last.querySelectorAll('svg path')) : [];
    const ds    = paths.map((p) => p.getAttribute('d') || '').join(' ');
    const fills = paths.map((p) => (p.getAttribute('fill') || '').toUpperCase());
    if (ds.includes('M22.3 11.522') || ds.includes('M29 14') || fills.includes('#808080')) return 'キャンセル';
    if (ds.includes('M10.6721')) return '仮予約';   // 「R」＝リクエスト字形
    if (ds.includes('M21.994')) return '確定';       // チェックマーク
    return '確定';                                    // 不明時は確定扱い
  })).catch(() => []);
  log('statuses_read', { count: statuses.length, expected: expectedCount, sample: statuses.slice(0, 8) });
  if (statuses.length !== expectedCount) log('statuses_count_mismatch', { got: statuses.length, expected: expectedCount });
  return statuses;
}

// ステータス表示文字列 → 確定 / 仮予約 / キャンセル
function mapUrakataStatus(t) {
  const s = String(t || '').replace(/\s+/g, '');
  if (s.includes('キャンセル') || s.includes('お断り') || s.includes('断り') || s.includes('不成立')) return 'キャンセル';
  if (s.includes('リクエスト') || s.includes('未確定') || s.includes('申込')) return '仮予約';
  return '確定'; // 確定 / 参加済 など
}

// 参加日 from/to を datepicker で設定する。
// ウラカタの検索フォームは「申込日(from,to)」「参加日(from,to)」の順で
// テキストボックスが並ぶ。参加日は録画上 4,5番目（0始まり）。
// 環境変数 DATE_BOX_FROM / DATE_BOX_TO で番号を上書き可能。
async function setDateRange(page, fromDate, toDate) {
  // 全テキストボックスの直前ラベルをログ出力（番号確認用のデバッグ）
  const labels = await page.$$eval('input[type=text], input:not([type])', (els) => els.map((el, i) => {
    // 近くの見出しテキストを拾う
    let lbl = '';
    const wrap = el.closest('.field, .column, form > div, div');
    if (wrap) lbl = (wrap.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    return `${i}:${lbl}`;
  }));
  log('textbox_labels', { labels });

  const fromIdx = parseInt(process.env.DATE_BOX_FROM || '4', 10);
  const toIdx   = parseInt(process.env.DATE_BOX_TO   || '5', 10);
  const boxes = page.getByRole('textbox');

  const failed = [];
  for (const [idx, t, which] of [[fromIdx, fromDate, 'from'], [toIdx, toDate, 'to']]) {
    const box = boxes.nth(idx);
    let ok = false;

    // まず直接入力を試す。カレンダーUIはサイト側の変更で壊れやすく、実際に
    // 「Choose YYYY年M月D日」が見つからず日付が入らないまま検索され、
    // 0件の結果を正常として扱ってしまう事故が起きたため、入力を先に試みる。
    for (const v of [ymd(t), ymd(t).replace(/-/g, '/')]) {
      await box.fill('').catch(() => {});
      await box.fill(v).catch(() => {});
      const got = await box.inputValue().catch(() => '');
      if (got && got.replace(/[\/]/g, '-').startsWith(ymd(t))) { ok = true; break; }
    }
    if (ok) { await page.keyboard.press('Escape').catch(() => {}); }

    // 直接入力が効かない実装のときはカレンダーから選ぶ（従来方式）。
    if (!ok) {
      await box.click();
      const nextBtn = page.getByRole('button', { name: 'Next Month' });
      if (!(await nextBtn.first().isVisible().catch(() => false))) {
        log('date_box_no_calendar', { which, idx });
      } else {
        const y = t.getFullYear(), m = t.getMonth() + 1, d = t.getDate();
        for (let hop = 0; hop < 24; hop++) {
          const opt = page.getByRole('option', { name: new RegExp(`Choose ${y}年${m}月${d}日`) });
          if (await opt.count() > 0 && await opt.first().isVisible().catch(() => false)) {
            await opt.first().click();
            await page.waitForTimeout(600);
            ok = true; break;
          }
          await nextBtn.first().click();
          await page.waitForTimeout(300);
        }
        // 見つからなかったときは、実際に何が並んでいるのかを残す。
        // ラベル書式が変わったのか、カレンダー自体が出ていないのかを
        // ログだけで切り分けられるようにする。
        if (!ok) {
          const opts = await page.getByRole('option').evaluateAll(
            els => els.slice(0, 10).map(e => e.getAttribute('aria-label') || e.textContent.trim())
          ).catch(() => []);
          log('date_option_dump', { which, options: opts });
        }
      }
    }

    log(ok ? 'date_set' : 'date_set_fail', { which, ymd: ymd(t), viaTextbox: idx });
    if (!ok) failed.push(which);
  }

  // 日付が入らないまま検索すると全期間や0件が返り、それを正常な「予約なし」と
  // 誤って扱ってしまう。実際にGASへ空の一覧を送り、既存予約が消えたように
  // 見える誤検知通知が出続けた。ここで明確に失敗させる。
  if (failed.length) {
    throw new Error(`検索日付を設定できませんでした（${failed.join(', ')}）。UI変更の可能性があります。`);
  }
}

main();
