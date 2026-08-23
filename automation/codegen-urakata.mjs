// ============================================================
// ウラカタの検索画面を調べるための対話用スクリプト
// ------------------------------------------------------------
// 自動操作から見える画面と、人が操作する画面が同じなのかを確かめるためのもの。
// ログのかけらから推測して直すのを繰り返して外し続けたので、実物を採る。
//
// 使い方（automation ディレクトリで）:
//   npm install
//   node codegen-urakata.mjs
//
// ブラウザと Playwright Inspector が開くので、
//   1. 手でログインする（認証コードもそのまま入力してよい）
//   2. 予約検索の画面まで進む
//   3. 参加日の欄をクリックしてカレンダーが出るか見る
//   4. Inspector の Resume（▶）を押す
// これだけで、画面のHTML・入力欄の一覧・スクリーンショットが保存される。
//
// Inspector の Record（●）を押しておくと操作に対応するコードも出る。
// ただしパスワード入力もそのまま記録されるので、貼り付ける前に消すこと。
// ============================================================
import { chromium } from 'playwright';
import fs from 'fs';

const LOGIN_URL = process.env.URKT_LOGIN_URL || 'https://the-retreat-place.urkt.in/login';

const browser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
const context = await browser.newContext({
  locale: 'ja-JP',
  viewport: { width: 1440, height: 900 },
});
const page = await context.newPage();
await page.goto(LOGIN_URL);

console.log(`
============================================================
ブラウザを開きました。次の順で操作してください。

  1. ログインする（パスワード・認証コードはそのまま入力して大丈夫です）
  2. 「予約検索」の画面まで進む
  3. 参加日の欄をクリックして、カレンダーが出るか確認する
  4. Playwright Inspector の Resume（▶ボタン）を押す

Resume を押した時点の画面を保存します。
============================================================
`);

await page.pause();   // ← Inspector が開く。操作が終わったら Resume

// Resume 後、その時点の画面をそのまま採る
const inputs = await page.evaluate(() =>
  [...document.querySelectorAll('input, select, textarea')].map((el, i) => ({
    i,
    tag: el.tagName,
    type: el.type || '',
    name: el.name || '',
    id: el.id || '',
    cls: (el.className || '').toString().slice(0, 80),
    placeholder: el.placeholder || '',
    value: (el.value || '').slice(0, 30),
    readOnly: el.readOnly === true,
    // 入力欄の近くにある見出しテキスト。ラベルが付いているかを確認する
    near: (el.closest('div,label,td,li') || {}).textContent
      ? el.closest('div,label,td,li').textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : '',
  }))
);

fs.writeFileSync('urakata-inputs.json', JSON.stringify(inputs, null, 2));
fs.writeFileSync('urakata-page.html', await page.content());
await page.screenshot({ path: 'urakata-screen.png', fullPage: true });

console.log('\n===== 入力欄の一覧 =====');
for (const e of inputs) {
  if (e.type === 'hidden') continue;
  console.log(`[${e.i}] ${e.type.padEnd(9)} name=${(e.name || '-').padEnd(22)} id=${(e.id || '-').padEnd(16)} 値=${e.value || '-'}  近くの文字: ${e.near}`);
}
console.log(`
============================================================
保存しました:
  urakata-inputs.json  … 入力欄の一覧
  urakata-page.html    … 画面のHTML
  urakata-screen.png   … スクリーンショット

上の「入力欄の一覧」をコピーして送っていただければ、それで足ります。
（お客様情報が含まれる場合は該当行を消してください）
============================================================
`);

await browser.close();
