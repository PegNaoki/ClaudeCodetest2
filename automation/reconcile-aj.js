// ============================================================
// アクティビティジャパン (ptn.activityjapan.com) 予約一覧 読み取り（リコンサイル用）
// ------------------------------------------------------------
// 予約一覧から体験日が今日以降の予約を読み取り、JSON出力。
//
// 画面構造（実DOM確認済み）：
//   - 予約管理 → 予約一覧 → 実施日 from(#performSt02)/to(#performEnd02) → 「条件で検索する」
//   - 結果行: tr.date-url-target（data-url に予約番号）
//     予約番号: 1列目 small / ステータス: badge（確定予約/リクエスト/キャンセル等）
//     実施日: 「2026-08-08 (土) 10:00」/ 氏名: b / 人数: 専用セル b
//
// 環境変数：
//   AJ_ID / AJ_PASSWORD / HEADLESS (既定 true)
//   OUT_PATH (既定 aj-reservations.json) / RANGE_DAYS (既定 210)
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import { normalize, splitKana, splitPrice, findPhone, clean, contactFromText } from './reservation-schema.js';

const CONFIG = {
  loginUrl: 'https://ptn.activityjapan.com/login',
  id:       process.env.AJ_ID,
  password: process.env.AJ_PASSWORD,
  headless: process.env.HEADLESS !== 'false',
  outPath:  process.env.OUT_PATH || 'aj-reservations.json',
  rangeDays: parseInt(process.env.RANGE_DAYS || '210', 10),
};

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('AJ_ID');
  if (!CONFIG.password) miss.push('AJ_PASSWORD');
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}
function log(event, data = {}) { console.log(`${new Date().toISOString()} [${event}] ${JSON.stringify(data)}`); }
function ymd(d) { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }

async function main() {
  assertConfig();
  log('start');
  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
    args: ['--disable-blink-features=AutomationControlled'],
  });
  // ヘッドレス検知（HeadlessChrome UA / navigator.webdriver）を回避して通常Chromeに見せる
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    locale: 'ja-JP',
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
  const page = await context.newPage();

  try {
    // ---------- 1. ログイン ----------
    await page.goto(CONFIG.loginUrl, { waitUntil: 'networkidle' });
    await page.getByRole('textbox', { name: 'ID' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログインする' }).click();
    await page.waitForLoadState('networkidle');
    // ログイン成功をURLで確認（/login のままなら失敗）
    await page.waitForTimeout(1500);
    if (/\/login/.test(page.url())) {
      const msg = await page.evaluate(() => {
        const el = document.querySelector('.alert, .error, .help-block, .invalid-feedback');
        return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
      }).catch(() => '');
      await page.screenshot({ path: 'reconcile-aj-error.png', fullPage: true }).catch(() => {});
      throw new Error(`ログインに失敗しました（ID/パスワードを確認してください）${msg ? ' 画面メッセージ: ' + msg : ''}`);
    }
    log('login_ok', { url: page.url() });

    // ---------- 2. 予約一覧へ ----------
    await openReservationList(page);
    // 検索フォームは折りたたまれている場合があるため「存在（attached）」で待つ
    await page.waitForSelector('#performSt02', { state: 'attached', timeout: 30000 });
    log('list_page_opened', { url: page.url() });

    // 検索フォームの入力欄をダンプ（実施日from/toの正しい id を特定するため）
    if (process.env.DUMP_FORM === 'true') {
      const fields = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('input, select').forEach((el) => {
          const s = `${el.id} ${el.getAttribute('name') || ''} ${el.getAttribute('placeholder') || ''}`;
          if (/perform|date|日|st|end|from|to|jisshi|実施/i.test(s) || el.type === 'date' || el.type === 'text') {
            out.push({ tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '', id: el.id || '', name: el.getAttribute('name') || '', placeholder: el.getAttribute('placeholder') || '' });
          }
        });
        return out.slice(0, 40);
      });
      log('aj_form_dump', { fields });
    }

    // ---------- 3. 実施日 from/to で検索（RECON_FROM/RECON_TO 指定時は過去も読む） ----------
    const RECON_FROM = process.env.RECON_FROM || '';
    const RECON_TO   = process.env.RECON_TO || '';
    const today = RECON_FROM ? new Date(RECON_FROM + 'T00:00:00') : new Date();
    const to = RECON_TO ? new Date(RECON_TO + 'T00:00:00') : (() => { const d = new Date(today); d.setDate(today.getDate() + CONFIG.rangeDays); return d; })();
    await fillDate(page, '#performSt02', today);
    await fillDate(page, '#performEnd02', to);
    // 予約ステータスのチェックボックス（reservationStatus[1..13]）を全てONにする。
    // 未チェックだと結果が0件になるため、全ステータスを対象にして取りこぼしを防ぐ。
    const checked = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll('input[type=checkbox][name^="reservationStatus"]').forEach((cb) => {
        if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        n++;
      });
      return n;
    });
    log('status_checked', { count: checked });
    // 検索ボタンが隠れている可能性があるので force クリック
    await page.getByRole('button', { name: '条件で検索する' }).click({ force: true });
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    log('search_done');

    // ---------- 4. 結果を読み取り（ページ送り対応） ----------
    const all = [];
    for (let p = 0; p < 30; p++) {
      const rows = await page.$$eval('tr.date-url-target', (trs) => trs.map((tr) => {
        const url = tr.getAttribute('data-url') || '';
        const bookingNo = (url.match(/(\d{6,})/) || [])[1] || (tr.querySelector('small') ? tr.querySelector('small').textContent.trim() : '');
        // ステータスbadge
        const badge = tr.querySelector('.badge');
        const status = badge ? badge.textContent.replace(/\s+/g, '').trim() : '';
        // 実施日セル：「2026-08-08 (土) 10:00」を含むtd
        let perform = '';
        tr.querySelectorAll('td').forEach(td => {
          const t = td.textContent.replace(/\s+/g, ' ').trim();
          if (/\d{4}-\d{1,2}-\d{1,2}.*\d{1,2}:\d{2}/.test(t) && !perform) perform = t;
        });
        // 氏名（b要素の最初）
        const nameB = tr.querySelector('td b');
        const name = nameB ? nameB.textContent.trim() : '';
        // 人数：text-center セルの b（× N ではない単独数字）
        let people = '';
        const pc = tr.querySelector('td.text-center b.hidden-xs');
        if (pc) people = pc.textContent.trim();
        // 診断（DUMP_ROW=true）：一覧行に実際どんな列があるかを丸ごと出す。
        // 推測でセレクタを書くと取りこぼすため、実DOMを見てから抽出を決める。
        const cells = [...tr.querySelectorAll('td')].map((td, i) =>
          `[${i}] ${td.textContent.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
        return { bookingNo, status, perform, name, people, _cells: cells, _detailUrl: url };
      }));
      if (process.env.DUMP_ROW === 'true') {
        for (const r of rows.slice(0, 3)) log('dump_row', { name: r.name, detailUrl: r._detailUrl, cells: r._cells });
      }
      // 列位置が未確認のサイトなので、セル一覧をそのまま持ち回って後段で
      // 正規表現により項目を拾う（推測のセレクタ固定は取りこぼしの原因になる）。
      rows.forEach(r => all.push(r));
      log('page_read', { page: p + 1, rows: rows.length, total: all.length });

      // 次ページ（ページネーションの「次」）
      const next = page.locator('.pagination a[rel=next], .pagination li.next a, a[aria-label="Next"]').first();
      if (await next.count() === 0 || !(await next.isVisible().catch(() => false))) break;
      await next.click();
      await page.waitForTimeout(1500);
    }

    // 0件のときは切り分けプローブ：日付フィルタを外して再検索し、AJに予約が1件でも存在するか確認
    if (all.length === 0) {
      await page.evaluate(() => {
        ['performSt02', 'performEnd02'].forEach((id) => {
          const el = document.getElementById(id);
          if (el) { el.removeAttribute('readonly'); el.value = ''; el.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        document.querySelectorAll('input[type=checkbox][name^="reservationStatus"]').forEach((cb) => {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
        });
      });
      await page.getByRole('button', { name: '条件で検索する' }).click({ force: true }).catch(() => {});
      await page.waitForTimeout(2500);
      const probe = await page.$$eval('tr.date-url-target', (trs) => trs.slice(0, 8).map((tr) => {
        let perform = '';
        tr.querySelectorAll('td').forEach((td) => { const t = td.textContent.replace(/\s+/g, ' ').trim(); if (/\d{4}-\d{1,2}-\d{1,2}/.test(t) && !perform) perform = t; });
        const nameB = tr.querySelector('td b');
        return { perform, name: nameB ? nameB.textContent.trim() : '' };
      })).catch(() => []);
      log('aj_probe_nofilter', { total: probe.length, sample: probe });
    }

    // ---------- 4c. 詳細ページから連絡先を補完 ----------
    // AJの一覧には電話番号の列が無い。行の data-url が詳細ページなので順に開いて
    // 本文から拾う。予約数ぶんページ遷移が増えるため、上限と無効化スイッチを持たせ、
    // 1件失敗しても在庫計算用の読み取り全体は落とさない。
    if (process.env.PHONE_DETAIL !== 'false') {
      const max = Number(process.env.DETAIL_MAX || 80);
      const targets = all.filter((r) => r._detailUrl).slice(0, max);
      const sub = await context.newPage();
      let ok = 0, ng = 0;
      for (const r of targets) {
        try {
          const url = new URL(r._detailUrl, page.url()).href;
          await sub.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          const body = await sub.evaluate(() => document.body.innerText);
          const c = contactFromText(body);
          r._phone = c.phone; r._email = c.email;
          if (c.phone) ok++; else ng++;
        } catch (e) {
          ng++;
          log('detail_failed', { bookingNo: r.bookingNo, message: e.message });
        }
      }
      await sub.close().catch(() => {});
      log('detail_scanned', { tried: targets.length, withPhone: ok, without: ng,
                              skipped: Math.max(0, all.length - targets.length) });
    }

    // ---------- 5. 体験日が今日以降に整形（キャンセルは除外して有効のみ） ----------
    const todayStr = ymd(today);
    const reservations = all.map((r) => {
      const m = String(r.perform).match(/(\d{4})-(\d{1,2})-(\d{1,2}).*?(\d{1,2}:\d{2})/);
      const date = m ? `${m[1]}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}` : '';
      const time = m ? m[4].padStart(5, '0') : '';
      // ステータス正規化
      let status = '確定';
      if (r.status.includes('キャンセル')) status = 'キャンセル';
      else if (r.status.includes('リクエスト')) status = '仮予約';
      // AJは列構成が未確定なため、セル本文から正規表現で項目を拾う。
      const cells = (r._cells || []).map((c) => String(c).replace(/^\[\d+\]\s*/, ''));
      // 金額：「12,000円」等を含むセル。実施日セルの数字と混同しないよう「円」を必須にする。
      const priceCell = cells.find((c) => /[\d,]+\s*円/.test(c)) || '';
      const { price, payment } = splitPrice((priceCell.match(/[\d,]+\s*円.*/) || [''])[0]);
      // 申込日：実施日セル以外に現れる日付。実施日は既に perform で取得済み。
      const appliedCell = cells.find((c) => /\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(c) && c !== r.perform && !/実施日/.test(c)) || '';
      // プラン名：日付・金額・人数・氏名のどれでもない、最も長い文章セルをプラン名とみなす。
      const planCell = cells
        .filter((c) => c.length > 8 && !/[\d,]+\s*円/.test(c) && !/\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(c) && !c.includes(r.name))
        .sort((a, b) => b.length - a.length)[0] || '';
      const { name: nm, kana } = splitKana(r.name);
      return normalize({
        site: 'アクティビティジャパン',
        bookingNo: r.bookingNo,
        status, date, time,
        people: r.people,
        name: nm, kana,
        phone: r._phone || findPhone(cells),
        email: r._email || null,
        plan: planCell,
        price, payment,
        media: 'アクティビティジャパン',
        applied: (appliedCell.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}[^\d]*(\d{1,2}:\d{2})?/) || [appliedCell])[0],
        note: clean(r._detailUrl),
      });
    }).filter((r) => r.date && (RECON_FROM ? (r.date >= RECON_FROM && r.date <= RECON_TO) : r.date >= todayStr));

    const result = {
      fetchedAt: new Date().toISOString(), site: 'アクティビティジャパン',
      totalFetched: all.length, totalFuture: reservations.length, today: todayStr, reservations,
    };
    fs.writeFileSync(CONFIG.outPath, JSON.stringify(result, null, 2));
    log('done', { fetched: all.length, future: reservations.length, out: CONFIG.outPath });

    console.log('\n===== 今日以降の予約（アクティビティジャパン）=====');
    for (const r of reservations) console.log(`${r.date} ${r.time} [${r.status}] ${r.bookingNo} ${r.name} ${r.people}名`);
  } catch (err) {
    log('error', { message: err.message });
    console.error('❌ エラー:', err.message);
    await page.screenshot({ path: 'reconcile-aj-error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// 「予約一覧」へ遷移する。サイドバーの描画を待ち、予約管理メニューを展開してから
// 予約一覧リンクをクリックする。
async function openReservationList(page) {
  await page.waitForLoadState('networkidle').catch(() => {});

  // サイドバーが出るまで待つ（最大25秒ポーリング）＋診断ログ
  let found = false;
  for (let i = 0; i < 25; i++) {
    const diag = await page.evaluate(() => ({
      url: location.href,
      hasReserveMenu: !!document.querySelector('#sidemenuReserve'),
      hasListLink: !!document.querySelector('a[href="/reserve/list"]'),
      anchorCount: document.querySelectorAll('a').length,
    }));
    if (i === 0 || diag.hasListLink) log('nav_diag', diag);
    if (diag.hasListLink) { found = true; break; }
    // 予約管理メニューを展開してみる
    const menu = page.locator('#sidemenuReserve');
    if (await menu.count() > 0) await menu.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
  if (!found) throw new Error('予約一覧リンク(a[href="/reserve/list"])が見つかりませんでした');

  // 予約管理メニューを展開してリンクを表示させる
  const menu = page.locator('#sidemenuReserve');
  const link = page.locator('a[href="/reserve/list"]').first();
  for (let i = 0; i < 5; i++) {
    if (await link.isVisible().catch(() => false)) break;
    if (await menu.count() > 0) await menu.click().catch(() => {});
    await page.waitForTimeout(700);
  }
  // 表示されていれば通常クリック、ダメでもJSで直接ナビ
  if (await link.isVisible().catch(() => false)) {
    await link.click();
  } else {
    await page.evaluate(() => {
      const a = document.querySelector('a[href="/reserve/list"]');
      if (a) a.click();
    });
  }
  await page.waitForLoadState('networkidle').catch(() => {});
}

// 日付入力欄に値をセット。readonly の datepicker のため JS で直接値を書き込む。
async function fillDate(page, selector, d) {
  const val = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const ok = await page.evaluate(({ sel, v }) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.removeAttribute('readonly');
    el.value = v;
    // datepicker/フレームワークに変更を通知
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, { sel: selector, v: val });
  log(ok ? 'date_set' : 'date_box_missing', { selector, val });
}

main();
