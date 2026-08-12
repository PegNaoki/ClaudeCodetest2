// ============================================================
// Googleカレンダー同期（OTA実データを正とする）
// ------------------------------------------------------------
// これまでカレンダー登録は GAS の registerApprovedToCalendar が
// スプレッドシートを見て行っていた。そのためシートへの転記が漏れた予約は
// 永久にカレンダーへ載らなかった。ここでは Reconcile が各OTAから読んだ
// 実データ（*-reservations.json）を直接の入力にして、シートを経由しない。
//
// 冪等性：予約ごとに安定キーを作り、イベントの extendedProperties に
//   埋めて突き合わせる。同じ予約を二重登録しない／消えた予約は削除する。
//   キーは「サイト|予約番号」。予約番号が無いサイト（ウラカタのWeb予約等）は
//   「サイト|日付|時刻|氏名」で代用する。
//
// 環境変数：
//   GCAL_ID          … 対象カレンダーID（例 xxx@group.calendar.google.com）
//   GCAL_SA_KEY      … サービスアカウントのJSONキー（丸ごと）
//   RES_FILES        … 予約JSON（既定 jalan/urakata/aj-reservations.json）
//   EVENT_HOURS      … 所要時間（既定 2）
//   CAL_DRY_RUN      … "true" なら書き込まず差分だけ出す（既定 false）
//   CAL_PRUNE        … "false" なら消えた予約の削除を行わない（既定 true）
// ============================================================

import fs from 'fs';
import crypto from 'crypto';

const CONFIG = {
  calendarId: process.env.GCAL_ID || '',
  saKeyRaw:   process.env.GCAL_SA_KEY || '',
  resFiles:  (process.env.RES_FILES || 'jalan-reservations.json,urakata-reservations.json,aj-reservations.json')
    .split(',').map(s => s.trim()).filter(Boolean),
  eventHours: Number(process.env.EVENT_HOURS || 2),
  dryRun:  process.env.CAL_DRY_RUN === 'true',
  prune:   process.env.CAL_PRUNE !== 'false',
};

// 予約枠の日付は日本時間で考える（ランナーはUTC）。sync-overbooking.js と同じ方式。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const JST_SUFFIX = '+09:00';
function todayJst() {
  const d = new Date(Date.now() + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function log(event, data = {}) {
  console.log(`${new Date().toISOString()} [${event}] ${JSON.stringify(data)}`);
}

function normTime(v) {
  const m = String(v == null ? '' : v).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
}

// ---- サービスアカウントで access token を取得（依存を増やさず自前でJWT署名）----
async function getAccessToken() {
  let sa;
  try { sa = JSON.parse(CONFIG.saKeyRaw); }
  catch (e) { throw new Error(`GCAL_SA_KEY のJSON解析に失敗: ${e.message}`); }
  if (!sa.client_email || !sa.private_key) throw new Error('GCAL_SA_KEY に client_email / private_key がありません');

  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const claim = b64({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  });
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${claim}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).end()
    .sign(sa.private_key).toString('base64url');

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${unsigned}.${sig}`,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) {
    throw new Error(`アクセストークン取得失敗 HTTP ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  }
  return j.access_token;
}

async function api(token, path, init = {}) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 204) return {};
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Calendar API ${init.method || 'GET'} ${path} → HTTP ${res.status}: ${JSON.stringify(j.error || j).slice(0, 300)}`);
  return j;
}

// ---- 予約JSONを読み、確定・今日以降だけを対象にする ----
function loadReservations() {
  const today = todayJst();
  const out = new Map(); // key -> reservation
  const missing = [];
  for (const f of CONFIG.resFiles) {
    let data;
    try { data = JSON.parse(fs.readFileSync(f, 'utf8')); }
    catch (e) { log('res_file_skip', { file: f, error: e.message }); missing.push(f); continue; }
    const site = String(data.site || f.replace(/-reservations\.json$/, ''));
    for (const r of (Array.isArray(data.reservations) ? data.reservations : [])) {
      if (r.status !== '確定') continue;              // 在庫計算と同じ基準
      const date = String(r.date || '').trim();
      const time = normTime(r.time);
      if (!date || !time || date < today) continue;
      const no = String(r.bookingNo || '').trim();
      const name = String(r.name || '').trim();
      // 予約番号が無いサイトは 日付|時刻|氏名 で代用する
      const key = no ? `${site}|${no}` : `${site}|${date}|${time}|${name}`;
      out.set(key, { key, site, no, name, date, time,
                     people: r.people || '', plan: r.plan || '', price: r.price || '', phone: r.phone || '' });
    }
  }
  return { wanted: out, missing };
}

function buildEvent(r) {
  const start = `${r.date}T${r.time}:00${JST_SUFFIX}`;
  const endMs = new Date(`${r.date}T${r.time}:00${JST_SUFFIX}`).getTime() + CONFIG.eventHours * 3600 * 1000;
  const e = new Date(endMs + JST_OFFSET_MS);
  const end = `${e.getUTCFullYear()}-${String(e.getUTCMonth() + 1).padStart(2, '0')}-${String(e.getUTCDate()).padStart(2, '0')}`
            + `T${String(e.getUTCHours()).padStart(2, '0')}:${String(e.getUTCMinutes()).padStart(2, '0')}:00${JST_SUFFIX}`;
  const lines = [
    `予約サイト: ${r.site}`,
    r.no    ? `予約番号: ${r.no}` : '',
    r.name  ? `お名前: ${r.name}` : '',
    r.people ? `人数: ${r.people}名` : '',
    r.plan  ? `プラン: ${r.plan}` : '',
    r.price ? `金額: ${r.price}` : '',
    r.phone ? `電話: ${r.phone}` : '',
    '',
    '※このイベントは各OTAの予約データから自動生成されています。',
  ].filter(Boolean);
  return {
    summary: `SUP ${r.people ? r.people + '名 ' : ''}${r.name || ''}（${r.site}）`.trim(),
    description: lines.join('\n'),
    start: { dateTime: start, timeZone: 'Asia/Tokyo' },
    end:   { dateTime: end,   timeZone: 'Asia/Tokyo' },
    extendedProperties: { private: { supKey: r.key, supSource: 'ota-reconcile' } },
  };
}

// 自動生成したイベントだけを対象に、今日以降を取得する
async function fetchManaged(token) {
  const map = new Map(); // supKey -> event
  let pageToken = '';
  const timeMin = new Date(`${todayJst()}T00:00:00${JST_SUFFIX}`).toISOString();
  do {
    const q = new URLSearchParams({
      timeMin, singleEvents: 'true', maxResults: '250',
      privateExtendedProperty: 'supSource=ota-reconcile',
    });
    if (pageToken) q.set('pageToken', pageToken);
    const j = await api(token, `/calendars/${encodeURIComponent(CONFIG.calendarId)}/events?${q}`);
    for (const ev of (j.items || [])) {
      const k = ev.extendedProperties?.private?.supKey;
      if (k) map.set(k, ev);
    }
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return map;
}

function sameEvent(ev, want) {
  return ev.summary === want.summary
    && ev.description === want.description
    && new Date(ev.start?.dateTime || 0).getTime() === new Date(want.start.dateTime).getTime()
    && new Date(ev.end?.dateTime   || 0).getTime() === new Date(want.end.dateTime).getTime();
}

async function main() {
  if (!CONFIG.calendarId) throw new Error('GCAL_ID が未設定です');
  if (!CONFIG.saKeyRaw)   throw new Error('GCAL_SA_KEY が未設定です');

  const { wanted, missing } = loadReservations();
  // 予約JSONが欠けていると「消えた予約」と誤判定して既存イベントを消しかねない。
  // 在庫反映と同じ考え方で、欠損時は削除を行わない（追加・更新のみ）。
  const prune = CONFIG.prune && missing.length === 0;
  if (missing.length) log('prune_disabled', { reason: '予約データが不完全', missing });

  const token = await getAccessToken();
  const existing = await fetchManaged(token);
  log('scope', { wanted: wanted.size, existing: existing.size, dryRun: CONFIG.dryRun, prune });

  let created = 0, updated = 0, deleted = 0, kept = 0;
  const changes = [];

  for (const [key, r] of wanted) {
    const want = buildEvent(r);
    const ev = existing.get(key);
    if (!ev) {
      changes.push({ op: 'create', key, when: `${r.date} ${r.time}`, who: r.name });
      if (!CONFIG.dryRun) await api(token, `/calendars/${encodeURIComponent(CONFIG.calendarId)}/events`,
        { method: 'POST', body: JSON.stringify(want) });
      created++;
    } else if (!sameEvent(ev, want)) {
      changes.push({ op: 'update', key, when: `${r.date} ${r.time}`, who: r.name });
      if (!CONFIG.dryRun) await api(token, `/calendars/${encodeURIComponent(CONFIG.calendarId)}/events/${ev.id}`,
        { method: 'PATCH', body: JSON.stringify(want) });
      updated++;
    } else {
      kept++;
    }
  }

  if (prune) {
    for (const [key, ev] of existing) {
      if (wanted.has(key)) continue;
      changes.push({ op: 'delete', key, when: ev.start?.dateTime || '', who: ev.summary || '' });
      if (!CONFIG.dryRun) await api(token, `/calendars/${encodeURIComponent(CONFIG.calendarId)}/events/${ev.id}`,
        { method: 'DELETE' });
      deleted++;
    }
  }

  for (const c of changes) log(`cal_${c.op}`, c);
  log('done', { created, updated, deleted, kept, dryRun: CONFIG.dryRun });

  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`## カレンダー同期（OTA実データ基準）`, '',
      `- 追加 **${created}** / 更新 **${updated}** / 削除 **${deleted}** / 変更なし ${kept}`,
      CONFIG.dryRun ? '- DRY_RUN のため書き込みはしていません' : '',
      prune ? '' : '- 予約データが不完全なため削除は行いませんでした', ''].filter(Boolean).join('\n');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  }
}

main().catch(e => { log('error', { message: e.message }); process.exitCode = 1; });
