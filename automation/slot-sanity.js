// 送られてきた枠の日付が現実的かを確かめる。
//
// 実測（2026-08-27 / 08-28 / 08-30 / 09-01 の mode_jalan）では、
// 毎回「今日と同じ月日の、ちょうど1年後」の枠が指示されていた。
//   例) 2026-08-30 の実行 → 2027-08-30 10:00 / 13:30 (request, stock 6)
// 存在しない枠を切り替えようとして毎日失敗し、🚨通知が飛び続けていた。
//
// 定員マスターが持つのは「今日〜11/30（12月なら翌年の11/30）」だけで、
// それより先の枠は作られない。よってその範囲外の日付は実在しない。
// 送信元（GAS側の年の解釈）が本来の原因だが、こちら側でも
// 範囲外の日付は実行対象から外す。外した事実はログに残す。

// 定員マスターの最終日。GAS側の生成規則と同じ（11月=月index10, 30日）。
export function masterHorizon(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600000); // UTC→JSTで日付を見る
  const y = jst.getUTCFullYear() + (jst.getUTCMonth() >= 11 ? 1 : 0);
  return `${y}-11-30`;
}

export function splitImplausible(tasks, log, now = new Date()) {
  const limit = masterHorizon(now);
  const ok = [], ignored = [];
  for (const t of tasks) (t.date > limit ? ignored : ok).push(t);
  if (ignored.length && log) {
    log('slots_ignored_out_of_range', {
      limit,
      count: ignored.length,
      slots: ignored.map((t) => `${t.date} ${t.time} → ${t.mode}`),
      note: '定員マスターの範囲外。実在しない枠のため実行しない（送信元の日付計算が疑わしい）',
    });
  }
  return { tasks: ok, ignored };
}
