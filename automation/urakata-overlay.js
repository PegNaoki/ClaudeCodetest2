// ウラカタの画面には、アプリ本体とは関係のない案内モーダルが出ることがある。
// 実例: 「OTA予約取り込み機能（β版）の利用希望アンケート」
//   <div data-suir-portal="true"> のオーバーレイが画面全体を覆い、
//   「予約枠」リンクは見えているのにクリックが届かず30秒後にタイムアウトする。
//   （2026-08-28 の mode_urakata / mode_jalan 失敗の実際の原因）
//
// 閉じるボタンがあれば押す。押せない・見つからない場合は、その要素を
// DOMから取り除いて先へ進む。消すのは自動化用ブラウザの中だけで、
// ウラカタ側のデータには一切触れない。

const CLOSE_LABELS = /閉じる|とじる|あとで|後で|いいえ|キャンセル|回答しない|스킵|skip|close|×/i;

export async function dismissUrakataOverlay(page, log) {
  const portal = page.locator('div[data-suir-portal="true"]');
  if (await portal.count() === 0) return false;
  if (!await portal.first().isVisible().catch(() => false)) return false;

  const title = await portal.first().innerText().catch(() => '');
  const label = title.replace(/\s+/g, ' ').trim().slice(0, 60);

  // 1. まっとうに閉じる
  for (const loc of [
    portal.getByRole('button', { name: CLOSE_LABELS }),
    portal.locator('i.close, .close.icon, [aria-label="Close"]'),
  ]) {
    if (await loc.count() === 0) continue;
    await loc.first().click({ timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
    if (!await portal.first().isVisible().catch(() => false)) {
      if (log) log('overlay_dismissed', { by: 'button', title: label });
      return true;
    }
  }

  // 2. 閉じられないものは取り除く。放置すると全操作が届かなくなるため。
  const removed = await page.evaluate(() => {
    const els = [...document.querySelectorAll('div[data-suir-portal="true"], .ui.dimmer')];
    els.forEach((el) => el.remove());
    return els.length;
  }).catch(() => 0);
  if (log) log('overlay_removed', { count: removed, title: label });
  return removed > 0;
}
