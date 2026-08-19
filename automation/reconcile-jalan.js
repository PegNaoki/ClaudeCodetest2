// ============================================================
// じゃらん (ACTIVITY BOARD) 予約一覧 読み取りスクリプト（リコンサイル用）
// ------------------------------------------------------------
// 予約検索の結果一覧から「体験日が今日以降」の全予約を読み取り、
// JSONで出力する。メール取りこぼし検出・在庫突合の照合源として使う。
//
// 画面構造（実DOMで確認済み）：
//   - 予約・販売管理（ポップアップ）→「予約検索」→「検索する」
//   - 結果表: #tblReserveSearchResult / 行: #bookingSearchList > tr
//   - 予約番号: 1列目の a.js-popupReserveNum のテキスト
//   - 体験日時: td.termCol（例 "2026/07/04(土) 13:30～15:30"）
//   - 人数:     td.nameData .is-twoRow
//   - ステータス: .reserveDecision=確定 / .cancelDecision=キャンセル / .label.is-tmpReserve=仮予約
//   - ページ送り: .paginate li.next a（.hide が付いていたら最終ページ）
//
// 環境変数：
//   JALAN_ID / JALAN_PASSWORD / SHOP_NAME
//   HEADLESS (既定 true) / OUT_PATH (既定 jalan-reservations.json)
//
// 出力（OUT_PATH）：
//   { fetchedAt, site:"じゃらん", total, reservations: [
//       { bookingNo, status, date:"YYYY-MM-DD", time:"HH:MM", people, name, plan, price } ] }
// ============================================================

import { chromium } from 'playwright';
import fs from 'fs';
import { normalize, splitKana, splitPrice, findPhone, contactFromText } from './reservation-schema.js';

const CONFIG = {
  topUrl:   'https://activityboard.jp/',
  id:       process.env.JALAN_ID,
  password: process.env.JALAN_PASSWORD,
  shopName: process.env.SHOP_NAME || 'のみくい処 七ツ家',
  headless: process.env.HEADLESS !== 'false',
  outPath:  process.env.OUT_PATH || 'jalan-reservations.json',
  maxPages: 30, // ページ送りの上限（暴走防止）
};

function assertConfig() {
  const miss = [];
  if (!CONFIG.id)       miss.push('JALAN_ID');
  if (!CONFIG.password) miss.push('JALAN_PASSWORD');
  if (miss.length) throw new Error(`必須の環境変数が未設定: ${miss.join(', ')}`);
}

function log(event, data = {}) {
  console.log(`${new Date().toISOString()} [${event}] ${JSON.stringify(data)}`);
}

// "2026/07/04(土) 13:30～15:30" → { date:"2026-07-04", time:"13:30" }
function parseExperience(text) {
  const m = String(text).match(/(\d{4})\/(\d{1,2})\/(\d{1,2}).*?(\d{1,2}:\d{2})/);
  if (!m) return { date: '', time: '' };
  return {
    date: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`,
    time: m[4].padStart(5, '0'),
  };
}

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  assertConfig();
  log('start', { shop: CONFIG.shopName });

  const browser = await chromium.launch({
    headless: CONFIG.headless,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined,
  });
  const page = await browser.newPage();
  let mng = null;

  try {
    // ---------- 1. ログイン ----------
    await page.goto(CONFIG.topUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('link', { name: 'ログイン' }).click();
    await page.getByRole('textbox', { name: 'AirIDまたはメールアドレス' }).fill(CONFIG.id);
    await page.getByRole('textbox', { name: 'パスワード' }).fill(CONFIG.password);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.waitForLoadState('networkidle');
    log('login_ok');

    // ---------- 2. 店舗選択 → 予約・販売管理 ----------
    await page.getByRole('link', { name: CONFIG.shopName }).click();
    await page.waitForLoadState('networkidle');
    const popupPromise = page.waitForEvent('popup', { timeout: 15000 }).catch(() => null);
    await page.getByRole('link', { name: '予約・販売管理', exact: true }).click();
    const popup = await popupPromise;
    mng = popup || page;
    await mng.waitForLoadState('networkidle');
    log('management_opened', { popup: !!popup, url: mng.url() });

    // ---------- 3. 予約検索ページへ直接移動 ----------
    // 「予約検索」リンクはヘッダーメニュー内に隠れているため、URLへ直接遷移する
    await mng.goto('https://activityboard.jp/activityboard/booking/list/?from=header', { waitUntil: 'networkidle' });
    log('search_page_opened', { url: mng.url() });

    // 検索フォームの入力欄をダンプ（体験日from/toの id / name を特定するため）
    if (process.env.DUMP_FORM === 'true') {
      const fields = await mng.evaluate(() => {
        const out = [];
        document.querySelectorAll('input, select').forEach((el) => {
          out.push({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || '',
            id: el.id || '',
            name: el.getAttribute('name') || '',
            placeholder: el.getAttribute('placeholder') || '',
            className: (el.className || '').toString().slice(0, 60),
          });
        });
        // 「体験日」「期間」などのラベル近傍も拾う
        const labels = [];
        document.querySelectorAll('label, th, .form-label, dt').forEach((el) => {
          const t = el.textContent.replace(/\s+/g, ' ').trim();
          if (/日|期間|検索|ステータス|状態/.test(t) && t.length < 20) labels.push(t);
        });
        return { fields: out, labels };
      });
      log('form_dump', fields);
    }

    // 体験日レンジを検索条件にセット（RECON_FROM/RECON_TO 指定時）。
    // 入力欄の id/name が確定するまでは複数の候補セレクタに順に流し込む。
    const RF = process.env.RECON_FROM || '';
    const RT = process.env.RECON_TO || '';
    if (RF && RT) {
      const setJalanDates = await mng.evaluate(({ from, to }) => {
        const write = (id, v) => {
          const el = document.getElementById(id);
          if (!el) return false;
          el.removeAttribute('readonly'); el.value = v;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        // 体験日 from/to（experienceDay）
        const okFrom = write('bookingFromDt', from);
        const okTo   = write('bookingToDt', to);
        // 予約ステータス（確定/仮予約/キャンセル）を全てチェックして取りこぼしを防ぐ
        let statusChecked = 0;
        document.querySelectorAll('input.bookingStatusCd[name="bookingStatusCdList"]').forEach((cb) => {
          if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); }
          statusChecked++;
        });
        return { okFrom, okTo, statusChecked };
      }, { from: RF.replace(/-/g, '/'), to: RT.replace(/-/g, '/') });
      log('jalan_date_set', setJalanDates);
    }

    await mng.getByRole('button', { name: '検索する' }).click();
    await mng.waitForSelector('#bookingSearchList tr', { timeout: 20000 });
    log('search_done');

    // ---------- 4. 全ページの行を読み取り ----------
    const all = [];
    // 詳細巡回の集計と件数上限（予約数ぶんクリックが増えるため上限を設ける）
    let detailBudget = Number(process.env.DETAIL_MAX || 80), detailOk = 0, detailNg = 0;
    for (let p = 0; p < CONFIG.maxPages; p++) {
      const rows = await mng.$$eval('#bookingSearchList > tr', (trs) => trs.map((tr) => {
        const pick = (sel) => { const el = tr.querySelector(sel); return el ? el.textContent.trim() : ''; };
        const bookingNo = pick('a.js-popupReserveNum');
        // 予約番号リンクは href="#" で data-booking-id を使いJSで開く方式のため、
        // URLとしては辿れない。詳細はクリックして開く（後段）。構造が変わったときの
        // 手掛かりとしてリンクのHTMLだけ診断用に残す。
        const noEl = tr.querySelector('a.js-popupReserveNum');
        const detailHtml = noEl ? noEl.outerHTML.slice(0, 300) : '';
        const expText   = pick('td.termCol');
        const people    = pick('td.nameData .is-twoRow');
        const name      = (tr.querySelector('td.nameData span') || {}).textContent || '';
        // ステータス判定（行内のクラスで確実に判別できる）
        let status = '不明';
        if (tr.querySelector('.cancelDecision'))      status = 'キャンセル';
        else if (tr.querySelector('.is-tmpReserve'))  status = '仮予約';
        else if (tr.querySelector('.reserveDecision')) status = '確定';
        // プラン名・金額（列位置ではなくtd走査で頑健に）
        const tds  = tr.querySelectorAll('td');
        const plan  = tds.length > 5 ? tds[5].textContent.trim() : '';
        const price = tds.length > 6 ? tds[6].textContent.trim().split('\n')[0] : '';
        // 申込日時は [2]、氏名+フリガナは [4]。列構成は DUMP_ROW で実DOMを確認済み。
        const applied  = tds.length > 2 ? tds[2].textContent.replace(/\s+/g, ' ').trim() : '';
        const nameCell = tds.length > 4 ? tds[4].textContent.replace(/\s+/g, ' ').trim() : '';
        const route    = tds.length > 1 ? tds[1].textContent.replace(/\s+/g, ' ').trim() : '';
        // 診断（DUMP_ROW=true）：一覧行の全セルを出して、取得できる項目を確認する。
        const cells = [...tds].map((td, i) =>
          `[${i}] ${td.textContent.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
        return { bookingNo, expText, people, name: name.trim().replace(/\s+/g, ' '), status,
                 plan, price, applied, nameCell, route, detailHtml, _cells: cells };
      }));

      if (process.env.DUMP_ROW === 'true') {
        for (const r of rows.slice(0, 3)) log('dump_row', { name: r.name, cells: r._cells, detailHtml: r.detailHtml });
      }
      for (const r of rows) {
        const cells = r._cells || [];
        delete r._cells;
        const { date, time } = parseExperience(r.expText);
        // 氏名セルにフリガナが同居している（例「山根 綾菜(ヤマネ アヤナ)」）ので分解する。
        const { name: nm, kana } = splitKana(r.nameCell);
        // 金額セルは「15,200円オンラインカード決済」のように決済方法が続く。
        const { price, payment } = splitPrice(r.price);
        // 電話番号はじゃらんの一覧に列が無い。行内に現れていれば拾い、無ければ null。
        all.push(normalize({
          site: 'じゃらん',
          bookingNo: r.bookingNo,
          status:    r.status,
          date, time,
          people:    r.people,
          name:      nm || r.name,
          kana,
          phone:     findPhone(cells),   // 詳細ページからの補完は後段で上書きする
          email:     null,
          plan:      r.plan,
          price,
          payment,
          media:     'じゃらん',
          applied:   r.applied,
          note:      r.route,
        }));
      }
      // ---------- 詳細から連絡先を補完（このページ分） ----------
      // じゃらんの一覧に電話番号の列は無く、予約番号リンクは href="#" で
      // data-booking-id を使いJSで開く方式のため、URL直打ちでは辿れない。
      // リンクを実際にクリックして開いた内容から拾う。別ウィンドウ／同一ページ内
      // モーダルのどちらで開くか断定できないので、両方に対応する。
      // ページ送りで行が入れ替わるため、必ずこのページを読み終えた直後に行う。
      if (process.env.PHONE_DETAIL !== 'false' && detailBudget > 0) {
        const links = mng.locator('#bookingSearchList > tr a.js-popupReserveNum');
        const n = Math.min(await links.count(), detailBudget);
        for (let i = 0; i < n; i++) {
          const no = (await links.nth(i).textContent().catch(() => ''))?.trim();
          const rec = no ? all.find((x) => x.bookingNo === no) : null;
          if (!rec) continue;
          detailBudget--;
          try {
            const popupP = mng.waitForEvent('popup', { timeout: 4000 }).catch(() => null);
            await links.nth(i).click({ timeout: 8000 });
            const pop = await popupP;
            const target = pop || mng;
            if (pop) await pop.waitForLoadState('domcontentloaded').catch(() => {});
            else await mng.waitForTimeout(1500);   // モーダルの描画待ち
            const c = contactFromText(await target.evaluate(() => document.body.innerText));
            if (c.phone) { rec.phone = c.phone; detailOk++; } else detailNg++;
            if (c.email) rec.email = c.email;
            if (pop) await pop.close().catch(() => {});
            else await closeDetailModal(mng);
          } catch (e) {
            detailNg++;
            log('detail_failed', { bookingNo: no, message: e.message });
          }
        }
      }

      log('page_read', { page: p + 1, rows: rows.length, total: all.length });

      // 次ページがあるか（.next の a に .hide が付いていたら終わり）
      const next = mng.locator('#listUpPaginate li.next a:not(.hide)').first();
      if (await next.count() === 0) break;
      await next.click();
      await mng.waitForTimeout(1200);
    }

    if (process.env.PHONE_DETAIL !== 'false') log('detail_scanned', { withPhone: detailOk, without: detailNg });

    // ---------- 5. 体験日で絞って出力（RECON_FROM/RECON_TO 指定時は過去も対象） ----------
    const RECON_FROM = process.env.RECON_FROM || '';
    const RECON_TO   = process.env.RECON_TO || '';
    const today = todayYmd();
    const future = all.filter((r) => r.date && (RECON_FROM ? (r.date >= RECON_FROM && r.date <= RECON_TO) : r.date >= today));
    const result = {
      fetchedAt: new Date().toISOString(),
      site: 'じゃらん',
      totalFetched: all.length,
      totalFuture: future.length,
      today,
      reservations: future,
    };
    fs.writeFileSync(CONFIG.outPath, JSON.stringify(result, null, 2));
    log('done', { fetched: all.length, future: future.length, out: CONFIG.outPath });

    // サマリーを人間向けにも出す
    console.log('\n===== 今日以降の予約 =====');
    for (const r of future) {
      console.log(`${r.date} ${r.time} [${r.status}] ${r.bookingNo} ${r.people}名`);
    }
  } catch (err) {
    log('error', { message: err.message });
    console.error('❌ エラー:', err.message);
    if (mng) await mng.screenshot({ path: 'reconcile-error.png', fullPage: true }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

// 予約詳細モーダルを確実に閉じる。閉じ残るとオーバーレイが次の行のリンクを
// 覆ってしまい、2件目以降のクリックがタイムアウトする（実際に発生した）。
// 閉じるボタンの実装を断定できないので複数候補を試し、最後にオーバーレイが
// 消えたことを確認してから戻る。
async function closeDetailModal(page) {
  const closers = ['.modal.show [data-dismiss="modal"]', '.modal [data-dismiss="modal"]',
                   '.modal.show .close', '.modal .close',
                   'button:has-text("閉じる")', 'a:has-text("閉じる")'];
  for (const sel of closers) {
    const l = page.locator(sel).first();
    if (await l.count().catch(() => 0) && await l.isVisible().catch(() => false)) {
      await l.click({ timeout: 3000 }).catch(() => {});
      break;
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForFunction(() => {
    const els = [...document.querySelectorAll('.modal, .modal-backdrop, [role=dialog]')];
    return !els.some((e) => e.offsetParent !== null);
  }, { timeout: 5000 }).catch(() => {});
}

main();
