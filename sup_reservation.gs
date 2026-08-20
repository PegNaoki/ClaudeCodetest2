// ============================================================
// SUP予約メール自動処理スクリプト
// ============================================================

const CONFIG = {
  SPREADSHEET_ID:     '1zaAb-6KRCoK4ACZWOlHZ3LnzKkDoVAs_In7aDOS9Vqo',
  SHEET_NAME:         '予約一覧',
  CALENDAR_ID:        '525a17f19df6b579e2ba94ea40b12c31a8b1fb21e1ae5610481c74314aab74e7@group.calendar.google.com',
  EVENT_DURATION_HOURS: 2,
  PROCESSED_LABEL:    'SUP予約/処理済',

  // 午前・午後の上限人数（超えそうな場合に警告）
  MORNING_LIMIT:   8,  // 午前枠（～12:00）の上限
  AFTERNOON_LIMIT: 8,  // 午後枠（12:00～）の上限

  SEARCH_QUERY: 'in:anywhere ('
    + 'from:reservation@activityboard.jp'
    + ' OR from:reservation_request@activityboard.jp'
    + ' OR from:mailsender@asoview.com'
    + ' OR from:reserve-system@activityjapan.com'
    + ' OR from:info@urkt.in'
    + ')',
};

// 「予約申込みが入りました」はウラカタのリクエスト（仮予約）件名なので確定に入れない。
// ウラカタ確定は「予約を確定しました」で拾う。
const CONFIRMED_KEYWORDS  = ['予約確定', '即時確定', '決済完了', '予約が確定', '予約を確定しました'];
const TENTATIVE_KEYWORDS  = ['仮予約', '予約のリクエスト', '予約申込みが入りました', '予約リクエストが届いています'];
const CANCEL_KEYWORDS     = ['キャンセル通知', 'キャンセルされました', 'キャンセルのご連絡', '予約取消'];
// 予約通知ではない（取り込まない）メールの件名キーワード。
// 認証コード／お客様宛ての中間通知など、予約データを持たないもの。
const IGNORE_SUBJECT_KEYWORDS = [
  '認証コード', 'ログイン',
  '予約申込み中', 'お取りできませんでした', 'お取りできません',
  'まだ予約は確定しておりません', '予約へお進みください',
  'パスワード',
];
function isIgnoredEmail_(subject) {
  const s = String(subject || '');
  return IGNORE_SUBJECT_KEYWORDS.some(k => s.includes(k));
}

// ウラカタ(urkt.in)のログイン認証コードメールから最新のコードを取り出す。
// sinceMs 指定時は「その時刻より後に届いたコード」だけを返す（使い回し防止）。
function getLatestUrktAuthCode_(sinceMs) {
  const threads = GmailApp.search('from:info@urkt.in 認証コード newer_than:1h', 0, 8);
  let best = null;
  threads.forEach(t => t.getMessages().forEach(m => {
    if (!String(m.getSubject() || '').includes('認証コード')) return;
    const when = m.getDate().getTime();
    if (sinceMs && when < sinceMs) return;
    const mm = String(m.getPlainBody() || '').match(/認証コード[　\s]*[:：]?\s*([0-9]{4,8})/);
    if (mm && (!best || when > best.when)) best = { code: mm[1], when };
  }));
  return best ? best.code : '';
}
const CHANGE_KEYWORDS     = ['変更通知', '変更されました', '内容が変更'];

const COLUMNS = {
  TIMESTAMP:          1,  // A: 処理日時
  SUBJECT:            2,  // B: メール件名
  BOOKING_SITE:       3,  // C: 予約サイト
  BOOKING_TYPE:       4,  // D: 予約タイプ
  BOOKING_NO:         5,  // E: 予約番号
  NAME:               6,  // F: 予約者名
  KANA:               7,  // G: フリガナ
  DATE:               8,  // H: 予約日
  TIME:               9,  // I: 予約時間
  PEOPLE:             10, // J: 人数（合計）
  PEOPLE_DETAIL:      11, // K: 人数内訳
  AMOUNT:             12, // L: 金額
  PAYMENT:            13, // M: 支払方法
  EMAIL:              14, // N: メールアドレス
  PHONE:              15, // O: 電話番号
  NOTES:              16, // P: 備考
  INSTRUCTOR_NEEDED:  17, // Q: 追加インストラクター（必要/不要）
  INSTRUCTOR_NAME:    18, // R: 追加インストラクター担当
  STATUS:             19, // S: ステータス
  ACTION_MEMO:        20, // T: 対応メモ
  CALENDAR_ID_COL:    21, // U: カレンダーイベントID
  MESSAGE_ID:         22, // V: メッセージID（重複防止）
  LINE_NOTIFIED:      23, // W: LINE通知済み
  REMINDER_SENT:      24, // X: 事前案内メール送信済み（YYYY-MM-DD 送信日 / 空=未送信）
};

// 集合案内メールの固定情報（じゃらん掲載情報より）
const MEETING_INFO = {
  placeName: 'Go Retreat Aizu（秋元湖）',
  address:   '〒969-2751 福島県耶麻郡猪苗代町若宮吾妻山甲2998-9',
  mapUrl:    'https://maps.app.goo.gl/aPqdN6dqMJSyx6c16',
  tel:       '080-2024-0863',
  senderName:'GoRETREAT AIZU',
};

const INSTRUCTOR_THRESHOLD = 6; // 追加インストラクターが必要な人数

// ============================================================
// メイン処理：メール取込
// ============================================================
function importReservationEmails() {
  importEmails_(50);
}

function importAllHistoricalEmails() {
  importEmails_(500);
}

// ウラカタ（GoRETREAT）の過去メールをまとめて取り込む
function importUrktHistoricalEmails() {
  const ss      = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet   = getOrCreateSheet(ss);
  const label   = getOrCreateLabel(CONFIG.PROCESSED_LABEL);
  const threads = GmailApp.search('from:info@urkt.in', 0, 500);
  const existing = loadExistingReservations(sheet);

  let newCount = 0, skipCount = 0;

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const msgId = message.getId();
      if (existing.byMsgId.has(msgId)) { skipCount++; return; }

      const subject     = message.getSubject();
      if (isIgnoredEmail_(subject)) return; // 認証コード等、予約でないメールは無視
      const bookingType = detectBookingType(subject);
      const r           = parseEmail(message);
      if (!r) return;

      const existingRow = r.bookingNo ? existing.byBookingNo.get(r.bookingNo) : null;

      if (bookingType === 'キャンセル') {
        if (existingRow) handleCancellation(sheet, existingRow, msgId, subject);
      } else if (existingRow) {
        updateRow(sheet, existingRow, r, msgId, subject, bookingType);
      } else {
        appendToSheet(sheet, r, msgId, subject, bookingType);
        newCount++;
      }
    });
    thread.addLabel(label);
  });

  SpreadsheetApp.flush();
  Logger.log(`ウラカタ取込完了：新規${newCount}件・スキップ${skipCount}件（対象${threads.length}スレッド）`);
}

function importEmails_(limit) {
  const ss       = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet    = getOrCreateSheet(ss);
  const label    = getOrCreateLabel(CONFIG.PROCESSED_LABEL);
  const threads  = GmailApp.search(CONFIG.SEARCH_QUERY, 0, limit);
  const existing = loadExistingReservations(sheet);

  let newCount = 0, updateCount = 0, cancelCount = 0;

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const msgId   = message.getId();
      if (existing.byMsgId.has(msgId)) return;

      const subject     = message.getSubject();
      if (isIgnoredEmail_(subject)) return; // 認証コード等、予約でないメールは無視
      const bookingType = detectBookingType(subject);
      const r           = parseEmail(message);
      if (!r) return;

      const existingRow = r.bookingNo ? existing.byBookingNo.get(r.bookingNo) : null;

      if (bookingType === 'キャンセル') {
        // キャンセル処理
        if (existingRow) {
          handleCancellation(sheet, existingRow, msgId, subject);
          cancelCount++;
        }
      } else if (existingRow) {
        // 既存行を更新（変更・確定など）
        updateRow(sheet, existingRow, r, msgId, subject, bookingType);
        updateCount++;
        // リクエスト承認（仮予約→確定）の昇格時も他OTAの枠を減らす。
        // 同一予約の重複dispatchは dedup_key で防止される。
        if (bookingType === '確定') {
          notifySlotReduction_(r);
        }
      } else {
        // 新規追加
        appendToSheet(sheet, r, msgId, subject, bookingType);
        newCount++;
        // 在庫連動は「確定」のみ。仮予約（リクエスト）は物理的に枠が
        // 埋まっていないため減算しない（承認されて確定メールが来た時に減算）。
        if (bookingType === '確定') {
          notifySlotReduction_(r);
        }
      }
    });
    thread.addLabel(label);
  });

  if (newCount > 0 || updateCount > 0 || cancelCount > 0) SpreadsheetApp.flush();
  Logger.log(`取込完了：新規${newCount}件・更新${updateCount}件・キャンセル${cancelCount}件（対象${threads.length}スレッド）`);

  // 取込後に容量チェック
  checkCapacityWarnings(sheet);

  // 予約状況が変わったら枠モード/在庫を再同期（delta減算ではなく実状況から再計算）
  if (newCount > 0 || updateCount > 0 || cancelCount > 0) { syncModesSafely_(); notifyNewSafely_(); }
}

// syncSlotModes を安全に呼ぶ（同期の失敗が取込/突合を止めないように）
function syncModesSafely_() {
  try { syncSlotModes(); }
  catch (e) { Logger.log(`枠モード同期の呼び出しで例外: ${e.message}`); }
}

// ============================================================
// カレンダー登録
// ============================================================
function registerApprovedToCalendar() {
  const ss       = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet    = getOrCreateSheet(ss);
  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);

  if (!calendar) {
    Logger.log('カレンダーが見つかりません。CALENDAR_IDを確認してください。');
    return;
  }

  const data = sheet.getDataRange().getValues();
  const gid  = sheet.getSheetId();
  let registeredCount = 0;

  // 既にカレンダー登録済みの予約番号を集める（同じ予約の二重登録を防ぐ）
  const registeredNos = {};
  for (let r = 1; r < data.length; r++) {
    const no  = String(data[r][COLUMNS.BOOKING_NO - 1] || '').trim();
    const cid = data[r][COLUMNS.CALENDAR_ID_COL - 1];
    if (no && cid) registeredNos[no] = true;
  }

  for (let i = 1; i < data.length; i++) {
    const row        = data[i];
    const status     = row[COLUMNS.STATUS - 1];
    const calEventId = row[COLUMNS.CALENDAR_ID_COL - 1];
    if (status !== '承認済' || calEventId) continue;

    // 二重登録ガード：同じ予約番号が既にカレンダー登録済みならスキップ
    const bookingNo = String(row[COLUMNS.BOOKING_NO - 1] || '').trim();
    if (bookingNo && registeredNos[bookingNo]) {
      sheet.getRange(i + 1, COLUMNS.STATUS).setValue('カレンダー登録済(重複スキップ)');
      Logger.log(`行${i + 1}: 予約番号 ${bookingNo} は登録済みのため重複スキップ`);
      continue;
    }

    const site               = row[COLUMNS.BOOKING_SITE - 1];
    const name               = row[COLUMNS.NAME - 1];
    const kana               = row[COLUMNS.KANA - 1];
    const dateStr            = row[COLUMNS.DATE - 1];
    const timeStr            = row[COLUMNS.TIME - 1];
    const people             = row[COLUMNS.PEOPLE - 1];
    const peopleDetail       = row[COLUMNS.PEOPLE_DETAIL - 1];
    const amount             = row[COLUMNS.AMOUNT - 1];
    const payment            = row[COLUMNS.PAYMENT - 1];
    const email              = row[COLUMNS.EMAIL - 1];
    const phone              = row[COLUMNS.PHONE - 1];
    const notes              = row[COLUMNS.NOTES - 1];
    const instructorNeeded   = row[COLUMNS.INSTRUCTOR_NEEDED - 1];
    const instructorName     = row[COLUMNS.INSTRUCTOR_NAME - 1];

    const startDate = parseDateTime(dateStr, timeStr);
    if (!startDate) {
      Logger.log(`行${i + 1}: 日時パース失敗 - "${dateStr}" "${timeStr}"`);
      continue;
    }

    const endDate = new Date(startDate.getTime() + CONFIG.EVENT_DURATION_HOURS * 3600 * 1000);
    const rowUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}/edit#gid=${gid}&range=A${i + 1}`;
    const { title, description } = buildCalendarEvent({
      site, name, kana, people, peopleDetail, amount, payment,
      email, phone, notes, instructorNeeded, instructorName, bookingNo, rowUrl,
    });

    try {
      const event = calendar.createEvent(title, startDate, endDate, { description });
      sheet.getRange(i + 1, COLUMNS.STATUS).setValue('カレンダー登録済');
      sheet.getRange(i + 1, COLUMNS.CALENDAR_ID_COL).setValue(event.getId());
      if (bookingNo) registeredNos[bookingNo] = true; // 同一予約の後続行を重複登録しない
      registeredCount++;
    } catch (e) {
      Logger.log(`行${i + 1} カレンダー登録エラー: ${e.message}`);
    }
  }

  if (registeredCount > 0) {
    SpreadsheetApp.flush();
    Logger.log(`${registeredCount}件をカレンダーに登録しました`);
  }
}

// ============================================================
// 既存カレンダーイベントの整理：重複削除＋残す1件を新形式に更新
// ------------------------------------------------------------
// ・cleanupCalendarEventsDry()   … 何をするかログに出すだけ（削除・変更しない）
// ・cleanupCalendarEventsApply() … 実際に重複削除＋説明文更新を行う
//   同一予約の判定キー：予約番号（無ければ 予約日|氏名）
// ============================================================
function cleanupCalendarEventsDry()   { return cleanupCalendarEvents_(false); }
function cleanupCalendarEventsApply()  { return cleanupCalendarEvents_(true); }

function cleanupCalendarEvents_(apply) {
  const ss       = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet    = getOrCreateSheet(ss);
  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!calendar) { Logger.log('カレンダーが見つかりません'); return; }

  const data = sheet.getDataRange().getValues();
  const gid  = sheet.getSheetId();

  // カレンダーイベントIDを持つ行を、同一予約キーでグループ化
  const groups = {}; // key -> [{ i, eventId }]
  for (let i = 1; i < data.length; i++) {
    const eventId = data[i][COLUMNS.CALENDAR_ID_COL - 1];
    if (!eventId) continue;
    const no   = String(data[i][COLUMNS.BOOKING_NO - 1] || '').trim();
    const dstr = formatDateLabel(data[i][COLUMNS.DATE - 1]);
    const nm   = String(data[i][COLUMNS.KANA - 1] || data[i][COLUMNS.NAME - 1] || '').replace(/\s/g, '');
    // 予約番号があれば予約番号で、無ければ「日付|氏名」で同一予約を判定。
    // 予約番号も氏名も空の行は誤って束ねないよう、必ず単独扱い（重複判定しない）。
    let key;
    if (no)      key = `no:${no}`;
    else if (nm) key = `dn:${dstr}|${nm}`;
    else         key = `uniq:${i}`;
    (groups[key] = groups[key] || []).push({ i, eventId });
  }

  let deleted = 0, refreshed = 0, dupGroups = 0;
  const report = [];

  Object.keys(groups).forEach(key => {
    const list = groups[key];
    const keep = list[0];
    const extras = list.slice(1);
    if (extras.length > 0) dupGroups++;

    // 重複（2件目以降）を削除
    extras.forEach(ex => {
      report.push(`削除予定: ${key} 行${ex.i + 1} event=${ex.eventId}`);
      if (apply) {
        try {
          const ev = calendar.getEventById(ex.eventId);
          if (ev) ev.deleteEvent();
          sheet.getRange(ex.i + 1, COLUMNS.CALENDAR_ID_COL).setValue('');
          sheet.getRange(ex.i + 1, COLUMNS.STATUS).setValue('重複削除');
          deleted++;
        } catch (e) { Logger.log(`削除エラー 行${ex.i + 1}: ${e.message}`); }
      } else { deleted++; }
    });

    // 残す1件を新形式に更新（精算状況・電話番号・URLを反映）
    const row = data[keep.i];
    const rowUrl = `https://docs.google.com/spreadsheets/d/${CONFIG.SPREADSHEET_ID}/edit#gid=${gid}&range=A${keep.i + 1}`;
    const { title, description } = buildCalendarEvent({
      site: row[COLUMNS.BOOKING_SITE - 1], name: row[COLUMNS.NAME - 1], kana: row[COLUMNS.KANA - 1],
      people: row[COLUMNS.PEOPLE - 1], peopleDetail: row[COLUMNS.PEOPLE_DETAIL - 1],
      amount: row[COLUMNS.AMOUNT - 1], payment: row[COLUMNS.PAYMENT - 1],
      email: row[COLUMNS.EMAIL - 1], phone: row[COLUMNS.PHONE - 1], notes: row[COLUMNS.NOTES - 1],
      instructorNeeded: row[COLUMNS.INSTRUCTOR_NEEDED - 1], instructorName: row[COLUMNS.INSTRUCTOR_NAME - 1],
      bookingNo: String(row[COLUMNS.BOOKING_NO - 1] || '').trim(), rowUrl,
    });
    report.push(`更新予定: ${key} 行${keep.i + 1} → ${title}`);
    if (apply) {
      try {
        const ev = calendar.getEventById(keep.eventId);
        if (ev) { ev.setTitle(title); ev.setDescription(description); refreshed++; }
      } catch (e) { Logger.log(`更新エラー 行${keep.i + 1}: ${e.message}`); }
    } else { refreshed++; }
  });

  if (apply) SpreadsheetApp.flush();
  Logger.log(`【カレンダー整理${apply ? '（実行）' : '（ドライラン）'}】\n重複グループ:${dupGroups} / 削除:${deleted}件 / 更新:${refreshed}件\n`
    + report.slice(0, 100).join('\n'));
  return { dupGroups, deleted, refreshed };
}

// ============================================================
// カレンダーを直接スキャンして重複イベントを削除（シートに紐づかない過去分も対象）
// ------------------------------------------------------------
// 「同じ開始時刻 ＋ 同じ内容（精算マーク/要追加ラベルを除いた正規化タイトル）」が
// 複数あるものだけを重複とみなし、1件だけ残して削除する。
// 別人の予約は氏名が異なる＝正規化タイトルが異なるため消えない。
// ・cleanupCalendarByScanDry()   … 確認のみ（削除しない）
// ・cleanupCalendarByScanApply() … 実際に削除する
//   既定の対象期間：今日の120日前〜300日後（環境に応じて調整可）
// ============================================================
function cleanupCalendarByScanDry()   { return cleanupCalendarByScan_(false); }
function cleanupCalendarByScanApply()  { return cleanupCalendarByScan_(true); }

function normTitleForDedup_(t) {
  return String(t || '')
    .replace(/【要追加インストラクター】/g, '')
    .replace(/[✅💰]/g, '')
    .replace(/精算済|未精算/g, '')
    .replace(/\s/g, '')
    .trim();
}

function cleanupCalendarByScan_(apply) {
  const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
  if (!calendar) { Logger.log('カレンダーが見つかりません'); return; }

  const now  = new Date();
  const from = new Date(now.getTime() - 120 * 24 * 3600 * 1000);
  const to   = new Date(now.getTime() + 300 * 24 * 3600 * 1000);
  const events = calendar.getEvents(from, to);

  // (開始時刻 + 正規化タイトル) でグループ化
  const groups = {};
  events.forEach(ev => {
    const key = ev.getStartTime().toISOString() + '|' + normTitleForDedup_(ev.getTitle());
    (groups[key] = groups[key] || []).push(ev);
  });

  let deleted = 0, dupGroups = 0;
  const report = [];
  Object.keys(groups).forEach(key => {
    const list = groups[key];
    if (list.length <= 1) return;
    dupGroups++;
    // 2件目以降を削除（1件だけ残す）
    list.slice(1).forEach(ev => {
      report.push(`削除: ${ev.getStartTime().toLocaleString()} ${ev.getTitle()}`);
      if (apply) { try { ev.deleteEvent(); deleted++; } catch (e) { Logger.log('削除エラー: ' + e.message); } }
      else deleted++;
    });
  });

  Logger.log(`【カレンダー重複スキャン${apply ? '（実行）' : '（確認）'}】`
    + `\n対象イベント:${events.length} / 重複グループ:${dupGroups} / 削除${apply ? '' : '予定'}:${deleted}件\n`
    + report.slice(0, 150).join('\n'));
  return { total: events.length, dupGroups, deleted };
}

// カレンダーイベントのタイトル・説明文を生成
function buildCalendarEvent({ site, name, kana, people, peopleDetail, amount, payment,
                               email, phone, notes, instructorNeeded, instructorName, bookingNo, rowUrl }) {
  const needsInstructor = instructorNeeded === '必要';
  const displayName     = kana || name;
  const peopleStr       = peopleDetail || `${people}名`;
  const instructorStr   = instructorName || '未定';
  const settled         = paymentSettled_(payment); // 精算済/未精算

  // タイトル：精算状況の絵文字＋（6名以上なら要追加インストラクター）
  const payMark    = settled === '未精算（現地払い）' ? '💰未精算 ' : settled ? '✅精算済 ' : '';
  const prefix     = (needsInstructor ? '【要追加インストラクター】' : '') + payMark;
  const titleParts = [`【${site}】${displayName}`, peopleStr, amount].filter(Boolean);
  const title      = prefix + titleParts.join('｜');

  // 説明文（分かりやすさ優先で精算状況・電話番号を上に）
  const lines = [
    settled      ? `精算状況: ${settled}`      : '',
    phone        ? `電話番号: ${phone}`        : '',
    `予約者: ${name}`,
    kana         ? `フリガナ: ${kana}`        : '',
    email        ? `メール: ${email}`          : '',
    peopleDetail ? `人数内訳: ${peopleDetail}` : `人数: ${people}名`,
    amount       ? `金額: ${amount}`           : '',
    payment      ? `支払方法: ${payment}`      : '',
    bookingNo    ? `予約番号: ${bookingNo}`    : '',
    notes        ? `備考: ${notes}`            : '',
  ];

  if (needsInstructor) {
    lines.push('');
    lines.push(`追加インストラクター：必要`);
    lines.push(`追加インストラクター担当：${instructorStr}`);
  }

  if (rowUrl) {
    lines.push('');
    lines.push(`▼ 詳細・編集（スプレッドシート）`);
    lines.push(rowUrl);
  }

  const description = lines.filter(l => l !== null && l !== undefined).join('\n').trim();
  return { title, description };
}

// 支払方法から精算状況を判定：現地払い＝未精算 / それ以外（事前決済）＝精算済
function paymentSettled_(payment) {
  const p = String(payment || '').trim();
  if (!p) return '';
  if (/現地|当日|現金|着地|来店|店頭/.test(p)) return '未精算（現地払い）';
  return '精算済（事前決済）';
}

// ============================================================
// onEdit：スプレッドシート編集時のフック（カレンダーは初回作成後に触らない）
// ============================================================
function onEdit(e) {
  // カレンダーへの自動反映は行わない。
  // 初回作成後の詳細欄は手動管理のため、上書きを防ぐために意図的に無効化している。
}

// ============================================================
// キャンセル処理
// ============================================================
function handleCancellation(sheet, rowNum, msgId, subject) {
  sheet.getRange(rowNum, COLUMNS.STATUS).setValue('キャンセル');
  sheet.getRange(rowNum, COLUMNS.TIMESTAMP).setValue(new Date());
  sheet.getRange(rowNum, COLUMNS.SUBJECT).setValue(subject);
  sheet.getRange(rowNum, COLUMNS.MESSAGE_ID).setValue(msgId);

  // カレンダーイベントが登録済みなら削除する
  const calEventId = sheet.getRange(rowNum, COLUMNS.CALENDAR_ID_COL).getValue();
  if (calEventId) {
    try {
      const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
      const event    = calendar.getEventById(calEventId);
      if (event) event.deleteEvent();
      sheet.getRange(rowNum, COLUMNS.CALENDAR_ID_COL).setValue('');
    } catch (e) {
      Logger.log(`カレンダー削除エラー: ${e.message}`);
    }
  }

  // キャンセル通知（LINE通知済みでも送る）
  const rowData  = sheet.getRange(rowNum, 1, 1, COLUMNS.LINE_NOTIFIED).getValues()[0];
  const dateVal  = rowData[COLUMNS.DATE - 1];
  const timeVal  = rowData[COLUMNS.TIME - 1];
  const r = {
    site:         rowData[COLUMNS.BOOKING_SITE - 1],
    name:         rowData[COLUMNS.NAME - 1],
    date:         dateVal,
    time:         timeVal,
    people:       rowData[COLUMNS.PEOPLE - 1],
    peopleDetail: rowData[COLUMNS.PEOPLE_DETAIL - 1],
    notes:        rowData[COLUMNS.NOTES - 1],
    instructorNeeded: rowData[COLUMNS.INSTRUCTOR_NEEDED - 1],
    instructorName:   rowData[COLUMNS.INSTRUCTOR_NAME - 1],
  };
  const slotInfo = getSlotCapacity(sheet, dateVal, timeVal);
  sendLineNotification(sheet, rowNum, 'キャンセル', r, slotInfo, true);

  // 在庫を戻す（確定だった予約のみ。仮予約のまま消えた予約は元々減らしていない）
  const prevType = String(rowData[COLUMNS.BOOKING_TYPE - 1] || '');
  if (prevType === '確定') {
    restoreSlotForSites_(r);
  }
}

// ============================================================
// LINE通知
// ============================================================

// どの通知種別を送るかを決定（null=通知不要）
function resolveLineNotifyType(bookingType, r, instructorNeeded) {
  if (bookingType === 'キャンセル') return 'キャンセル';
  if (bookingType === '変更')       return '変更';
  if (bookingType === '仮予約')     return '仮予約';
  if (!r.date || !r.time || !r.people) return '要確認（情報不足）';
  if (bookingType === '確定' && instructorNeeded === '必要') return '要対応（追加インストラクター必要）';
  if (bookingType === '確定') return '確認通知';
  return null;
}

// 同通知種別の重複チェックを含む通知送信
// forceResend=true でキャンセルなど既通知でも再送
function sendLineNotification(sheet, rowNum, notifyType, r, slotInfo, forceResend) {
  const notifiedCell = sheet.getRange(rowNum, COLUMNS.LINE_NOTIFIED);
  const notified     = notifiedCell.getValue() || '';

  // 同じ種別はスキップ（forceResend=trueの場合除く）
  if (!forceResend && notified.split(',').map(s => s.trim()).includes(notifyType)) return;

  const message = buildLineMessage(notifyType, r, slotInfo);
  postToLine(message);

  // 通知済み記録
  const updated = notified ? `${notified},${notifyType}` : notifyType;
  notifiedCell.setValue(updated);
}

function buildLineMessage(notifyType, r, slotInfo) {
  const isActionRequired = notifyType !== '確認通知';
  const header = isActionRequired
    ? `【要対応通知】対応が必要な予約があります`
    : `【確認通知】SUP予約が入りました`;

  const dateLabel   = formatDateLabel(r.date);
  const timeLabel   = formatTimeLabel(r.time);
  const slotLabel   = getSlotLabel(r.time);
  const dogLabel    = detectDog(r.notes) ? 'あり' : 'なし';
  const peopleStr   = r.peopleDetail ? `${r.people}名（${r.peopleDetail}）` : `${r.people}名`;
  const remaining   = slotInfo.limit - slotInfo.total;
  const remainLabel = remaining >= 0 ? `残${remaining}名` : `超過${Math.abs(remaining)}名`;

  const lines = [
    '',
    header,
    '─────────────────',
  ];

  if (isActionRequired) lines.push(`⚠️ 対応理由：${notifyType}`);

  lines.push(
    `📅 日付：${dateLabel}`,
    `🕐 時間帯：${slotLabel}（${timeLabel}）`,
    `👥 人数：${peopleStr}`,
    `🐕 犬：${dogLabel}`,
    `🏪 予約サイト：${r.site || '不明'}`,
  );

  lines.push(
    '',
    `📊 枠状況（${slotLabel}）`,
    `合計：${slotInfo.total}名 / 上限${slotInfo.limit}名`,
    remainLabel,
  );

  if (r.instructorNeeded === '必要') {
    const instructorStr = r.instructorName || '未定';
    lines.push('', `👨‍🏫 追加インストラクター担当：${instructorStr}`);
  }

  return lines.join('\n');
}

function postToLine(message) {
  const token  = PropertiesService.getScriptProperties().getProperty('LINE_CHANNEL_TOKEN');
  const userId = PropertiesService.getScriptProperties().getProperty('LINE_USER_ID');
  if (!token || !userId) {
    Logger.log('LINE_CHANNEL_TOKEN または LINE_USER_ID が未設定です（スクリプトプロパティに追加してください）');
    return;
  }
  try {
    UrlFetchApp.fetch('https://api.line.me/v2/bot/message/push', {
      method:      'post',
      contentType: 'application/json',
      headers:     { Authorization: `Bearer ${token}` },
      payload: JSON.stringify({
        to: userId,
        messages: [{ type: 'text', text: message }],
      }),
    });
  } catch (e) {
    Logger.log(`LINE通知エラー: ${e.message}`);
  }
}

// ============================================================
// 運用支援：前日リマインド／お客様事前案内メール／承認漏れアラート／当日集合リスト
// ------------------------------------------------------------
// 時間主導トリガー：
//   sendDayBeforeReminders  … 毎晩20時（翌日分の社内まとめ＋お客様メール）
//   checkPendingRequests    … 毎時（3時間以上未承認のリクエストを催促）
//   sendMorningList         … 毎朝7時（本日分の集合リスト）
// お客様メールは既定「テストモード」（自分宛て送信）。本番化は
//   スクリプトプロパティ CUSTOMER_MAIL_MODE = 'live' で切替。
// ============================================================

// --- 小さなヘルパー ---
function toYmd_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  const m = String(v).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}
function todayYmd_()      { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }
function offsetYmd_(days) { return Utilities.formatDate(new Date(Date.now() + days * 86400000), 'Asia/Tokyo', 'yyyy-MM-dd'); }
function startMinus5_(timeStr) {
  const t = normalizeSlotTime_(timeStr);
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return t;
  let mins = Number(m[1]) * 60 + Number(m[2]) - 5;
  if (mins < 0) mins = 0;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
function validEmail_(e) {
  const s = String(e || '').trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
}
// 確定予約か（予約タイプ列＝確定。仮予約/キャンセルは対象外）
function isConfirmedRow_(row) {
  const t = String(row[COLUMNS.BOOKING_TYPE - 1] || '');
  const st = String(row[COLUMNS.STATUS - 1] || '');
  if (st.includes('キャンセル')) return false;
  return t === '確定';
}

// お客様向け案内メールの件名・本文を作る
function buildCustomerReminderMail_(row) {
  const name  = row[COLUMNS.NAME - 1] || 'お客様';
  const dateY = toYmd_(row[COLUMNS.DATE - 1]);
  const start = normalizeSlotTime_(row[COLUMNS.TIME - 1]);
  const meet  = startMinus5_(row[COLUMNS.TIME - 1]);
  const people= row[COLUMNS.PEOPLE_DETAIL - 1] || `${row[COLUMNS.PEOPLE - 1]}名`;
  const plan  = row[COLUMNS.NOTES - 1] && String(row[COLUMNS.NOTES - 1]).length < 60 ? '' : ''; // プラン名は将来列追加時に差し込み
  const dLabel = formatDateLabel(row[COLUMNS.DATE - 1]);

  const subject = `【明日ご参加】秋元湖SUP体験 集合のご案内｜${MEETING_INFO.senderName}`;
  const body =
`${name} 様

この度は${MEETING_INFO.senderName}をご予約いただきありがとうございます。
明日のSUP体験について、集合のご案内をお送りします。

■ ご予約内容
　参加日：${dLabel}
　集合時間：${meet}（体験 ${start}〜、所要約2時間）
　人数：${people}

■ 集合場所
　${MEETING_INFO.placeName}
　${MEETING_INFO.address}
　地図：${MEETING_INFO.mapUrl}
　※専用駐車場あり（無料・4台）

■ 服装・持ち物
　【服装】濡れてもよい服装（水着＋ラッシュガードや速乾長袖を推奨）
　　　足元はかかとが固定できるサンダル／ウォーターシューズ
　　　※ウェットスーツは無料貸出、ライフジャケット着用必須
　【持ち物】着替え・タオル・飲み物・メガネストラップ
　【あると便利】帽子（あご紐付）・サングラス（紐付）・日焼け止め・虫よけ

■ トイレ・お着替え
　集合場所にトイレはありません。車で約5分の
　「五色沼入口観光プラザ」で事前にお済ませください。
　体験後のお着替えは簡易テントをご用意しています。

■ 集合・遅刻について
　開始5分前までに、お着替え・トイレを済ませてお越しください。
　10分以上遅れると当日キャンセル扱いとなる場合があります。

■ 天候について
　基本的に雨天催行です。荒天で中止の場合は、
　前日〜開始30分前までに当方よりご連絡します。

■ キャンセル規定
　7〜4日前：30％／3〜2日前：50％／前日・当日・無連絡：100％

■ 緊急連絡先（当日）
　TEL：${MEETING_INFO.tel}
　※体験中は電話に出られない場合があります。少し時間を空けてお掛け直しください。

当日お会いできるのを楽しみにしております！
${MEETING_INFO.senderName}`;
  return { subject, body };
}

// 毎晩20時：翌日分のお客様メール送信＋社内まとめLINE
function sendDayBeforeReminders() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const data  = sheet.getDataRange().getValues();
  const target = offsetYmd_(1); // 明日
  const mode   = PropertiesService.getScriptProperties().getProperty('CUSTOMER_MAIL_MODE') || 'test';
  const testTo = PropertiesService.getScriptProperties().getProperty('REMINDER_TEST_EMAIL') || Session.getActiveUser().getEmail();
  // 本番送信時の控え（BCC）。REMINDER_BCC 未設定ならプレビュー宛先（=自分）に控えを送る。
  // 空文字を明示設定すればBCCなしにできる。
  const bccProp = PropertiesService.getScriptProperties().getProperty('REMINDER_BCC');
  const bccTo   = (bccProp !== null ? bccProp : testTo);

  const bySlot = {}; // time -> [{name,people,phone,mailState}]
  const unsent = []; // メール未送信（アドレス無し等）

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (toYmd_(row[COLUMNS.DATE - 1]) !== target) continue;
    if (!isConfirmedRow_(row)) continue; // 確定のみ

    const name  = row[COLUMNS.NAME - 1] || '（氏名未取得）';
    const phone = row[COLUMNS.PHONE - 1] || '';
    const email = row[COLUMNS.EMAIL - 1] || '';
    const time  = normalizeSlotTime_(row[COLUMNS.TIME - 1]) || '時間未定';
    const alreadySent = row[COLUMNS.REMINDER_SENT - 1];

    let mailState = '';
    if (alreadySent) {
      mailState = '📧送信済';
    } else if (validEmail_(email)) {
      try {
        const { subject, body } = buildCustomerReminderMail_(row);
        if (mode === 'live') {
          const opts = { to: email, subject, body, name: MEETING_INFO.senderName };
          if (bccTo) opts.bcc = bccTo; // 送信控えを自分（or REMINDER_BCC）にも
          MailApp.sendEmail(opts);
        } else {
          MailApp.sendEmail({ to: testTo, subject: `[TEST→${email}] ${subject}`,
            body: `※テスト送信（本番の宛先: ${email}）\n\n${body}`, name: MEETING_INFO.senderName });
        }
        sheet.getRange(i + 1, COLUMNS.REMINDER_SENT).setValue(todayYmd_());
        mailState = mode === 'live' ? '📧送信済' : '📧テスト送信';
      } catch (e) {
        mailState = '📧送信失敗';
        Logger.log(`案内メール送信失敗 行${i + 1}: ${e.message}`);
      }
    } else {
      mailState = '📧アドレス無';
      unsent.push(`${time} ${name}（${row[COLUMNS.BOOKING_SITE - 1] || ''}）`);
    }
    (bySlot[time] = bySlot[time] || []).push({ name, people: row[COLUMNS.PEOPLE - 1] || '', phone, mailState });
  }

  // 社内まとめLINE
  const times = Object.keys(bySlot).sort();
  const lines = [`📅 明日の予約（${formatDateLabel(target)}）`, '━━━━━━━━━━━━━'];
  if (times.length === 0) {
    lines.push('明日の確定予約はありません');
  } else {
    let total = 0;
    times.forEach(t => {
      const list = bySlot[t];
      const sub = list.reduce((s, x) => s + (parseInt(x.people, 10) || 0), 0);
      total += sub;
      lines.push(`🕐 ${t}〜　計${sub}名`);
      list.forEach(x => lines.push(`・${x.name} ${x.people}名 ☎${x.phone || '―'} ${x.mailState}`));
    });
    lines.push('━━━━━━━━━━━━━', `合計 ${total}名`);
    if (unsent.length) lines.push('', `⚠️ 案内メール未送信 ${unsent.length}件（要手動フォロー）`, ...unsent.map(u => `・${u}`));
  }
  if (mode !== 'live') lines.push('', '※お客様メールはテストモード（自分宛て送信）です');
  postToLine(lines.join('\n'));
}

// 毎時：3時間以上未承認のリクエスト（仮予約）を催促
function checkPendingRequests() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const data  = sheet.getDataRange().getValues();
  const hours = parseInt(PropertiesService.getScriptProperties().getProperty('REQUEST_ALERT_HOURS') || '3', 10);
  const now   = Date.now();
  const alerts = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (String(row[COLUMNS.BOOKING_TYPE - 1] || '') !== '仮予約') continue;
    if (toYmd_(row[COLUMNS.DATE - 1]) < todayYmd_()) continue; // 過去日は除外
    const notified = String(row[COLUMNS.LINE_NOTIFIED - 1] || '');
    if (notified.includes('リクエスト催促')) continue; // 一度催促したら再送しない

    const ts = row[COLUMNS.TIMESTAMP - 1];
    const tms = ts instanceof Date ? ts.getTime() : Date.parse(ts);
    if (!tms || (now - tms) < hours * 3600000) continue; // 経過3時間未満は待つ

    alerts.push(`・${row[COLUMNS.BOOKING_SITE - 1] || ''} ${row[COLUMNS.NAME - 1] || ''} ${formatDateLabel(row[COLUMNS.DATE - 1])} ${normalizeSlotTime_(row[COLUMNS.TIME - 1])} ${row[COLUMNS.PEOPLE - 1] || ''}名`);
    sheet.getRange(i + 1, COLUMNS.LINE_NOTIFIED).setValue(notified ? `${notified},リクエスト催促` : 'リクエスト催促');
  }

  if (alerts.length) {
    postToLine(`🟡【承認漏れ注意】${hours}時間以上未承認のリクエストが${alerts.length}件あります\n━━━━━━━━━━━━━\n${alerts.join('\n')}\n\n👉 各サイト管理画面で承認/キャンセルの対応をお願いします`);
  }
}

// 毎朝7時：本日の集合リスト（社内）
function sendMorningList() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const data  = sheet.getDataRange().getValues();
  const target = todayYmd_();

  const bySlot = {};
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (toYmd_(row[COLUMNS.DATE - 1]) !== target) continue;
    if (!isConfirmedRow_(row)) continue;
    const time = normalizeSlotTime_(row[COLUMNS.TIME - 1]) || '時間未定';
    const settled = paymentSettled_(row[COLUMNS.PAYMENT - 1]);
    (bySlot[time] = bySlot[time] || []).push({
      name: row[COLUMNS.NAME - 1] || '（氏名未取得）',
      people: row[COLUMNS.PEOPLE - 1] || '',
      phone: row[COLUMNS.PHONE - 1] || '',
      settled: settled === '未精算（現地払い）' ? '💰現地払い' : (settled ? '✅精算済' : ''),
      amount: row[COLUMNS.AMOUNT - 1] || '',
    });
  }

  const times = Object.keys(bySlot).sort();
  const lines = [`☀️ 本日の予約（${formatDateLabel(target)}）`, '━━━━━━━━━━━━━'];
  if (times.length === 0) {
    lines.push('本日の確定予約はありません');
  } else {
    let total = 0;
    times.forEach(t => {
      const list = bySlot[t];
      const sub = list.reduce((s, x) => s + (parseInt(x.people, 10) || 0), 0);
      total += sub;
      lines.push(`🕐 ${t}〜　計${sub}名`);
      list.forEach(x => lines.push(`・${x.name} ${x.people}名 ☎${x.phone || '―'} ${x.settled}${x.settled === '💰現地払い' && x.amount ? `（${x.amount}）` : ''}`));
    });
    lines.push('━━━━━━━━━━━━━', `合計 ${total}名`);
  }
  postToLine(lines.join('\n'));
}

// 前回チェック以降に新しく入った予約を通知（確定/リクエスト別・残枠つき）。
// メール取込後・リコンサイル後に呼ぶ。LINE_NOTIFIED の「新規告知」で二重通知を防止。
function notifyNewBookings() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const data  = sheet.getDataRange().getValues();
  const today = todayYmd_();
  const conf = [], req = [], mark = [];

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const nt  = String(row[COLUMNS.LINE_NOTIFIED - 1] || '');
    if (nt.includes('新規告知')) continue;
    const type = String(row[COLUMNS.BOOKING_TYPE - 1] || '');
    if (type !== '確定' && type !== '仮予約') continue;
    if (String(row[COLUMNS.STATUS - 1] || '').includes('キャンセル')) continue;
    if (toYmd_(row[COLUMNS.DATE - 1]) < today) { mark.push(i + 1); continue; } // 過去日は通知せず既読化

    const info = getSlotCapacity(sheet, row[COLUMNS.DATE - 1], row[COLUMNS.TIME - 1]);
    const rem  = info ? `残${info.limit - info.total}名` : '残数不明';
    const line = `・${row[COLUMNS.BOOKING_SITE - 1] || ''} ${row[COLUMNS.NAME - 1] || '（氏名未取得）'} `
      + `${formatDateLabel(row[COLUMNS.DATE - 1])} ${normalizeSlotTime_(row[COLUMNS.TIME - 1])} ${row[COLUMNS.PEOPLE - 1] || ''}名（${rem}）`;
    (type === '確定' ? conf : req).push(line);
    mark.push(i + 1);
  }

  if (conf.length || req.length) {
    const lines = ['🆕 新規予約（前回チェック以降）', '━━━━━━━━━━━━━'];
    if (conf.length) lines.push(`✅ 確定 ${conf.length}件`, ...conf);
    if (req.length)  lines.push(conf.length ? '' : null, `🟡 リクエスト ${req.length}件（要承認）`, ...req);
    postToLine(lines.filter(l => l !== null).join('\n'));
  }
  // 通知した行・過去日行を既読化
  mark.forEach(r => {
    const cur = sheet.getRange(r, COLUMNS.LINE_NOTIFIED).getValue() || '';
    if (!String(cur).includes('新規告知')) sheet.getRange(r, COLUMNS.LINE_NOTIFIED).setValue(cur ? `${cur},新規告知` : '新規告知');
  });
}
function notifyNewSafely_() { try { notifyNewBookings(); } catch (e) { Logger.log(`新規予約通知で例外: ${e.message}`); } }

// 診断：前日リマインドで明日の予約が拾えるか、各行の判定結果をログに出す
function debugDayBefore() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const data  = sheet.getDataRange().getValues();
  const target = offsetYmd_(1);
  Logger.log(`明日(target) = ${target} / 今日 = ${todayYmd_()}`);
  let hit = 0;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const ymd = toYmd_(row[COLUMNS.DATE - 1]);
    if (ymd !== target && ymd !== todayYmd_()) continue; // 今日・明日の行だけ表示
    const type = String(row[COLUMNS.BOOKING_TYPE - 1] || '');
    const st   = String(row[COLUMNS.STATUS - 1] || '');
    const ok   = ymd === target && isConfirmedRow_(row);
    if (ok) hit++;
    Logger.log(`行${i + 1}: 日付="${row[COLUMNS.DATE - 1]}"→${ymd} / タイプ="${type}" / ステータス="${st}" / 氏名="${row[COLUMNS.NAME - 1]}" / メール="${row[COLUMNS.EMAIL - 1]}" → ${ok ? '✅対象' : '✕対象外'}`);
  }
  Logger.log(`明日の送信対象（確定）= ${hit}件`);
}

// 初回導入時に1回だけ実行：既存の全予約を「新規告知済み」にして一斉通知を防ぐ。
function markNewBookingBaseline() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const last  = sheet.getLastRow();
  let n = 0;
  for (let r = 2; r <= last; r++) {
    const cell = sheet.getRange(r, COLUMNS.LINE_NOTIFIED);
    const cur  = String(cell.getValue() || '');
    if (!cur.includes('新規告知')) { cell.setValue(cur ? `${cur},新規告知` : '新規告知'); n++; }
  }
  Logger.log(`既存 ${n} 行を「新規告知済み」に初期化しました（以後は新しい予約のみ通知）`);
}

// 日付・時刻の表示ヘルパー
function formatDateLabel(dateVal) {
  if (!dateVal) return '不明';
  if (dateVal instanceof Date) {
    const d = dateVal;
    return `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()}`;
  }
  return String(dateVal).replace(/年/g, '/').replace(/月/g, '/').replace(/日/g, '');
}

function formatTimeLabel(timeVal) {
  if (!timeVal) return '不明';
  if (timeVal instanceof Date) {
    return `${timeVal.getHours()}:${String(timeVal.getMinutes()).padStart(2, '0')}`;
  }
  return String(timeVal);
}

function getSlotLabel(timeVal) {
  let hour = 9;
  if (timeVal instanceof Date) {
    hour = timeVal.getHours();
  } else {
    const m = String(timeVal).match(/(\d{1,2}):/);
    if (m) hour = parseInt(m[1], 10);
  }
  return hour < 12 ? '午前' : '午後';
}

function detectDog(notes) {
  if (!notes) return false;
  return /犬|ペット|ドッグ|dog/i.test(String(notes));
}

// 指定日時の枠の合計人数・上限を返す
function getSlotCapacity(sheet, dateVal, timeVal) {
  const data = sheet.getDataRange().getValues();
  const targetDateStr = formatDateLabel(dateVal);
  const targetSlot    = getSlotLabel(timeVal);

  let total = 0;
  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status = row[COLUMNS.STATUS - 1];
    if (['キャンセル', '却下'].includes(status)) continue;

    const dv = row[COLUMNS.DATE - 1];
    const tv = row[COLUMNS.TIME - 1];
    if (!dv) continue;

    if (formatDateLabel(dv) !== targetDateStr) continue;
    if (getSlotLabel(tv) !== targetSlot) continue;

    const p = parseInt(row[COLUMNS.PEOPLE - 1], 10);
    if (!isNaN(p)) total += p;
  }

  // 上限は「定員マスター」を優先（該当日時の定員／既定）。
  // 読めない・未設定の場合のみ従来の固定値(MORNING/AFTERNOON_LIMIT)にフォールバック。
  let limit = targetSlot === '午前' ? CONFIG.MORNING_LIMIT : CONFIG.AFTERNOON_LIMIT;
  try {
    const master = loadCapacityMaster_(sheet.getParent());
    const cap = capacityFor_(master, normalizeSlotDate_(dateVal), normalizeSlotTime_(timeVal));
    if (cap !== null && cap !== undefined) limit = cap;
  } catch (e) {
    Logger.log(`定員マスター参照失敗（固定値を使用）: ${e.message}`);
  }
  return { total, limit };
}

// ============================================================
// 容量警告チェック（日付×午前午後ごとに集計）
// ============================================================
function checkCapacityWarnings(sheet) {
  const data     = sheet.getDataRange().getValues();
  const capacity = {}; // { '2026/07/15_AM': 人数, '2026/07/15_PM': 人数 }

  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status = row[COLUMNS.STATUS - 1];
    if (['キャンセル', '却下'].includes(status)) continue;

    const dateVal = row[COLUMNS.DATE - 1];
    const timeVal = row[COLUMNS.TIME - 1];
    const people  = parseInt(row[COLUMNS.PEOPLE - 1], 10);
    if (!dateVal || isNaN(people)) continue;

    const dateStr = dateVal instanceof Date
      ? `${dateVal.getFullYear()}/${dateVal.getMonth()+1}/${dateVal.getDate()}`
      : String(dateVal);

    let hour = 9;
    if (timeVal instanceof Date) {
      hour = timeVal.getHours();
    } else {
      const m = String(timeVal).match(/(\d{1,2}):/);
      if (m) hour = parseInt(m[1], 10);
    }

    const slot = hour < 12 ? `${dateStr}_AM` : `${dateStr}_PM`;
    capacity[slot] = (capacity[slot] || 0) + people;
  }

  const warnings = [];
  for (const [slot, total] of Object.entries(capacity)) {
    const [date, period] = slot.split('_');
    const limit = period === 'AM' ? CONFIG.MORNING_LIMIT : CONFIG.AFTERNOON_LIMIT;
    if (total >= limit) {
      warnings.push(`⚠️ ${date} ${period === 'AM' ? '午前' : '午後'}：${total}名 / 上限${limit}名`);
    }
  }

  if (warnings.length > 0) {
    Logger.log('【容量警告】\n' + warnings.join('\n'));
  }

  return warnings;
}

// 容量警告を手動確認（単体実行用）
function checkCapacityWarningsManual() {
  const ss      = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet   = getOrCreateSheet(ss);
  const warnings = checkCapacityWarnings(sheet);
  if (warnings.length === 0) Logger.log('容量に問題はありません');
}

// ============================================================
// メール解析
// ============================================================
// ============================================================
// 他OTAの在庫枠を減らすよう GitHub Actions に通知（repository_dispatch）
// ------------------------------------------------------------
// 必要なスクリプトプロパティ：
//   GITHUB_TOKEN  : repo権限のPersonal Access Token
//   GITHUB_REPO   : "PegNaoki/sup-management" のような owner/repo
//   SLOT_SYNC_ENABLED : "true" のときだけ実行（既定は無効＝安全側）
// ============================================================
// 予約サイト名 → 在庫グループの判定。
// ウラカタ＝アソビュー＝Web予約(satsuki)は在庫が共通なので同じ 'urakata' グループ。
function siteGroup_(site) {
  const s = String(site || '');
  if (s.includes('じゃらん')) return 'jalan';
  if (s.includes('アクティビティジャパン') || s.includes('アクティビティ・ジャパン')) return 'aj';
  if (s.includes('アソビュー') || s.includes('ウラカタ') || s.includes('Web予約') || s.includes('satsuki')) return 'urakata';
  return null; // 直接予約(LINE/インスタ等)は在庫連動の対象外
}

// 在庫操作を自動化できるサイト（アダプタ実装済み）と、その dispatch イベント種別
const SYNC_SITES = {
  jalan:   { event: 'reduce_slot' },
  urakata: { event: 'reduce_urakata' },
  aj:      { event: 'reduce_aj' },
};

// 予約発生時：売り元以外の全サイトの枠を減らす
function notifySlotReduction_(r) {
  notifySlotChange_(r, -1);
}
// キャンセル時：売り元以外の全サイトの枠を戻す
function restoreSlotForSites_(r) {
  notifySlotChange_(r, +1);
}

// direction: -1=減算(予約) / +1=戻し(キャンセル)
function notifySlotChange_(r, direction) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SLOT_SYNC_ENABLED') !== 'true') return; // 既定OFF

  const token = props.getProperty('GITHUB_TOKEN');
  const repo  = props.getProperty('GITHUB_REPO');
  if (!token || !repo) {
    Logger.log('在庫連携スキップ：GITHUB_TOKEN または GITHUB_REPO が未設定');
    return;
  }

  const slotDate = normalizeSlotDate_(r.date);
  const slotTime = String(r.time || '').trim();
  const people   = parseInt(r.people, 10) || 0;
  if (!slotDate || !slotTime || !people) {
    Logger.log(`在庫連携スキップ：日時/人数が不完全 (date=${r.date}, time=${r.time}, people=${r.people})`);
    return;
  }

  // 売り元グループを除いた、自動化可能な全サイトが対象
  const sourceGroup = siteGroup_(r.site);
  const targets = Object.keys(SYNC_SITES).filter(g => g !== sourceGroup);
  if (targets.length === 0) {
    Logger.log(`在庫連携：対象サイトなし (source=${r.site})`);
    return;
  }
  const dryRun = props.getProperty('SLOT_SYNC_DRY_RUN') || 'true';
  const signed = (direction < 0 ? '-' : '+') + people;

  targets.forEach(targetGroup => {
    // 二重処理防止キー（サイト・方向ごとに独立）
    const dedupKey = [targetGroup, r.site || '', r.bookingNo || '', slotDate, slotTime, signed].join('|');
    if (isSlotSynced_(dedupKey)) {
      Logger.log(`在庫連携スキップ：処理済み (${dedupKey})`);
      return;
    }
    try {
      const res = UrlFetchApp.fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        payload: JSON.stringify({
          event_type: SYNC_SITES[targetGroup].event,
          client_payload: {
            slot_date:      slotDate,
            slot_time:      slotTime,
            slot_decrement: String(people),   // 後方互換（じゃらん減算用）
            slot_delta:     signed,           // 符号付き（±両対応）
            dry_run:        dryRun,
            source_site:    r.site || '',
            target_site:    targetGroup,
            dedup_key:      dedupKey,
          },
        }),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      if (code === 204) {
        markSlotSynced_(dedupKey);
        Logger.log(`在庫連携：${targetGroup} に通知 (${slotDate} ${slotTime} ${signed})`);
      } else {
        Logger.log(`在庫連携エラー ${targetGroup} (${code}): ${res.getContentText()}`);
      }
    } catch (e) {
      Logger.log(`在庫連携エラー ${targetGroup}: ${e.message}`);
    }
  });
}

// 在庫連携の処理済みキー管理（スクリプトプロパティに直近N件を保持）
const SLOT_SYNCED_PROP = 'SLOT_SYNCED_KEYS';
const SLOT_SYNCED_MAX  = 500;

function loadSyncedKeys_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SLOT_SYNCED_PROP);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch (e) { return []; }
}
function isSlotSynced_(key) {
  return loadSyncedKeys_().indexOf(key) !== -1;
}
function markSlotSynced_(key) {
  const keys = loadSyncedKeys_();
  if (keys.indexOf(key) !== -1) return;
  keys.push(key);
  // 上限を超えたら古いものから捨てる（直近N件のみ保持）
  const trimmed = keys.slice(Math.max(0, keys.length - SLOT_SYNCED_MAX));
  PropertiesService.getScriptProperties().setProperty(SLOT_SYNCED_PROP, JSON.stringify(trimmed));
}

// 予約日を YYYY-MM-DD に変換（"2026/8/14" "2026年08月14日" などに対応）
function normalizeSlotDate_(dateVal) {
  if (!dateVal) return '';
  if (dateVal instanceof Date) {
    return Utilities.formatDate(dateVal, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  const m = String(dateVal).match(/(\d{4})[\/\-年]\s*(\d{1,2})[\/\-月]\s*(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
}

// ============================================================
// 定員マスターに基づく枠モード同期（バッチ／1日数回実行）
// ------------------------------------------------------------
// 方針：
//   ① 定員（枠数のマスター）は「定員マスター」シートで手動管理（たまに変更）
//   ② 1日数回、予約一覧の予約状況を集計し、残り枠を算出
//        残り枠 = 定員 − 予約人数合計（キャンセル/却下除く・全OTA分）
//   ③ 残り枠が1以下 → 全サイトを「リクエスト」化
//      残り枠が2以上 → 全サイトを「即予約」化（在庫=残り枠）
//   状態が前回から変わったときだけ dispatch する（無駄打ち防止）。
//
// 「定員マスター」シート（AJ管理画面ライクなグリッド。無ければ自動作成）：
//   1行目：A1=ラベル / B1="既定" / C1以降=日付（8/8 など）
//   A列 2行目以降：開始時間（HH:MM）
//   セルの値：
//     数字 → その日・その時間の総枠数（定員）
//     △    → その枠をリクエスト強制
//     ✗/×/満 → 受付停止（満席扱い・現状は手動対応のログのみ）
//     空    → 既定列の定員を使う
//   「既定」列に普段の定員（例:8）を入れておけば全日共通。特定日だけ
//   日付列を足して数字/△/✗で上書きする。
//
// 必要スクリプトプロパティ：
//   GITHUB_TOKEN / GITHUB_REPO / MODE_SYNC_ENABLED("true"で有効) / MODE_SYNC_DRY_RUN
// ============================================================

// 枠モードを自動操作できるサイトと設定。
//   event       : repository_dispatch のイベント種別
//   weekendMode : 金土日祝（通常時）の基本モード。平日の通常時は 'request'
//   stockKind   : dispatch時に渡す stock の意味（'remaining'=残数 / 'capacity'=定員）
// 残1のときは全サイト 'request'。
const MODE_SITES = {
  aj:      { event: 'mode_aj',      weekendMode: 'immediate',   stockKind: 'remaining' },
  jalan:   { event: 'mode_jalan',   weekendMode: 'combination', stockKind: 'capacity' },
  // ウラカタは即時販売在庫の数字だけで決まる（request=0 / immediate=残り枠）
  urakata: { event: 'mode_urakata', weekendMode: 'immediate',   stockKind: 'remaining' },
};

const CAPACITY_SHEET_NAME = '定員マスター';
const REQUEST_THRESHOLD   = 1; // 残りがこの数以下でリクエスト化（残1）
const SLOT_MODE_STATE_PROP = 'SLOT_MODE_STATE';

// 定員マスターシート（グリッド）を用意。無ければ雛形を作成
function initCapacityMasterSheet_(ss) {
  let sheet = ss.getSheetByName(CAPACITY_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CAPACITY_SHEET_NAME);
    sheet.getRange(1, 1, 3, 2).setValues([
      ['時間\\日付', '既定'],
      ['10:00', 8],
      ['13:30', 8],
    ]);
    sheet.setFrozenRows(1);
    sheet.setFrozenColumns(1);
    // 使い方メモ
    sheet.getRange(5, 1).setValue('数字=総枠数 / △=リクエスト強制 / ○=即予約強制 / ✗=受付停止 / 空=既定(土日祝=即予約,平日=リクエスト)');
    sheet.getRange(6, 1).setValue('C列以降に日付(例 8/8)を足すとその日だけ上書きできます');
  }
  return sheet;
}

// 横軸の日付を「今日〜11/30」で張り直す（既存の入力値は保持）。
// 手動実行して定員マスターのグリッドを整える。
function setupCapacityMasterGrid() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = initCapacityMasterSheet_(ss);

  // 既存値を退避（時間行・既定値・日付セル・強制記号）
  const before = loadCapacityMaster_(ss);
  const data   = sheet.getDataRange().getValues();
  const times = [];
  for (let r = 1; r < data.length; r++) {
    const t = normalizeSlotTime_(data[r][0]);
    if (t && times.indexOf(t) === -1) times.push(t);
  }
  if (times.length === 0) times.push('10:00', '13:30');

  // 今日〜11/30 の日付列を生成
  const now = new Date();
  const tz  = 'Asia/Tokyo';
  const start = new Date(Utilities.formatDate(now, tz, 'yyyy/MM/dd'));
  const endYear = start.getMonth() >= 11 ? start.getFullYear() + 1 : start.getFullYear();
  const end = new Date(endYear, 10, 30); // 11月=月index10, 30日
  const wd = ['日','月','火','水','木','金','土'];
  const dates = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    dates.push({
      iso:   Utilities.formatDate(d, tz, 'yyyy-MM-dd'),
      label: `${d.getMonth()+1}/${d.getDate()}(${wd[d.getDay()]})`,
    });
  }

  // 新グリッドを構築：A列=時間, B列=既定, C列以降=日付
  const header = ['時間\\日付', '既定', ...dates.map(x => x.label)];
  const rows = [header];
  times.forEach(time => {
    const row = [time, before.defaults[time] !== undefined ? before.defaults[time] : ''];
    dates.forEach(x => {
      const key = `${x.iso}|${time}`;
      if (before.forces[key] === 'request') row.push('△');
      else if (before.forces[key] === 'closed') row.push('✗');
      else if (before.overrides[key] !== undefined) row.push(before.overrides[key]);
      else row.push('');
    });
    rows.push(row);
  });

  sheet.clear();
  sheet.getRange(1, 1, rows.length, header.length).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(2);
  const memoRow = rows.length + 2;
  sheet.getRange(memoRow, 1).setValue('数字=総枠数 / △=リクエスト強制 / ○=即予約強制 / ✗=受付停止 / 空=既定(土日祝=即予約,平日=リクエスト)');
  Logger.log(`定員マスターを再構築：${times.length}時間帯 × ${dates.length}日（${dates[0].iso}〜${dates[dates.length-1].iso}）`);
  return { times: times.length, days: dates.length };
}

// グリッドを読み込む。
//   defaults[time]            … 「既定」列の定員
//   overrides['date|time']    … 日付列で上書きした定員
//   forces['date|time' or 'time'] … △=request / ✗=closed の強制指定
function loadCapacityMaster_(ss) {
  const sheet = initCapacityMasterSheet_(ss);
  const data  = sheet.getDataRange().getValues();
  const defaults = {}, overrides = {}, forces = {};
  if (data.length < 2) return { defaults, overrides, forces };

  // ヘッダ行：各列がどの日付か（B列以降）。"既定" は date='' 扱い
  const header = data[0];
  const colDate = [];
  for (let c = 1; c < header.length; c++) {
    const h = header[c];
    if (h === '' || h === null || h === undefined) { colDate[c] = null; continue; }
    if (String(h).replace(/\s/g, '') === '既定') { colDate[c] = ''; continue; }
    colDate[c] = normalizeSlotDate_(h) || normalizeMonthDay_(h);
  }

  for (let r = 1; r < data.length; r++) {
    const time = normalizeSlotTime_(data[r][0]);
    if (!time) continue; // 時間行でなければ（メモ行など）スキップ
    for (let c = 1; c < data[r].length; c++) {
      const date = colDate[c];
      if (date === null || date === undefined) continue;
      const cell = data[r][c];
      if (cell === '' || cell === null || cell === undefined) continue;
      const s = String(cell).trim();
      const fkey = date ? `${date}|${time}` : time;
      if (/^[△▲]$/.test(s))        { forces[fkey] = 'request';   continue; }
      if (/^[○◯即]$/.test(s))       { forces[fkey] = 'immediate'; continue; }
      if (/^[✗×xX満]$/.test(s))     { forces[fkey] = 'closed';    continue; }
      const cap = parseInt(s, 10);
      if (isNaN(cap)) continue;
      if (date) overrides[`${date}|${time}`] = cap;
      else      defaults[time] = cap;
    }
  }
  return { defaults, overrides, forces };
}

// 「8/8」「8月8日」等を今年基準で YYYY-MM-DD に（年跨ぎは過去なら翌年扱い）
function normalizeMonthDay_(v) {
  const m = String(v).match(/(\d{1,2})[\/月](\d{1,2})/);
  if (!m) return '';
  const now = new Date();
  let year = now.getFullYear();
  const mm = parseInt(m[1], 10), dd = parseInt(m[2], 10);
  const cand = `${year}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
  const todayStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  if (cand < todayStr) year += 1; // 既に過去なら翌年の同月日
  return `${year}-${String(mm).padStart(2,'0')}-${String(dd).padStart(2,'0')}`;
}

// 日本の祝日セットを取得（YYYY-MM-DD の Set）。範囲を1回だけ読み込む。
function loadHolidaySet_(fromStr, toStr) {
  const set = {};
  try {
    const cal = CalendarApp.getCalendarById('ja.japanese#holiday@group.v.calendar.google.com');
    if (!cal) { Logger.log('祝日カレンダー未購読：土日のみで判定'); return set; }
    const from = new Date(fromStr + 'T00:00:00+09:00');
    const to   = new Date(toStr   + 'T23:59:59+09:00');
    cal.getEvents(from, to).forEach(ev => {
      const d = ev.getAllDayStartDate ? ev.getAllDayStartDate() : ev.getStartTime();
      set[Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd')] = true;
    });
  } catch (e) { Logger.log(`祝日カレンダー取得失敗（土日のみで判定）: ${e.message}`); }
  return set;
}

// 金土日祝か？（通常時の基本モードが「週末側」になる日）
function isWeekendBase_(date, holidaySet) {
  const d = new Date(date + 'T00:00:00+09:00');
  const dow = d.getDay(); // 0=日, 5=金, 6=土
  return dow === 0 || dow === 5 || dow === 6 || !!holidaySet[date];
}

// サイト別の基本モード：金土日祝はサイト設定(weekendMode)、平日はリクエスト
function siteBaseMode_(site, weekend) {
  if (!weekend) return 'request';
  return MODE_SITES[site].weekendMode;
}

// その枠の強制指定（△/○/✗）を返す。日付指定→時間既定の順で探す
function forceFor_(master, date, time) {
  if (master.forces[`${date}|${time}`]) return master.forces[`${date}|${time}`];
  if (master.forces[time]) return master.forces[time];
  return null;
}

function capacityFor_(master, date, time) {
  const o = master.overrides[`${date}|${time}`];
  if (o !== undefined) return o;
  const d = master.defaults[time];
  return d !== undefined ? d : null;
}

// 時刻を HH:MM に正規化
function normalizeSlotTime_(timeVal) {
  if (timeVal === '' || timeVal === null || timeVal === undefined) return '';
  if (timeVal instanceof Date) {
    return `${String(timeVal.getHours()).padStart(2,'0')}:${String(timeVal.getMinutes()).padStart(2,'0')}`;
  }
  const m = String(timeVal).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2,'0')}:${m[2]}` : '';
}

// メイン：定員マスターと予約状況から各枠のモードを同期する
function syncSlotModes() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const master = loadCapacityMaster_(ss);
  const data  = sheet.getDataRange().getValues();
  const todayStr = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  // 予約一覧から (date|time) ごとに予約人数を集計（キャンセル/却下除く・今日以降）
  const booked = {}; // { 'YYYY-MM-DD|HH:MM': 合計人数 }
  for (let i = 1; i < data.length; i++) {
    const row    = data[i];
    const status = row[COLUMNS.STATUS - 1];
    if (['キャンセル', '却下'].includes(status)) continue;
    const date = normalizeSlotDate_(row[COLUMNS.DATE - 1]);
    const time = normalizeSlotTime_(row[COLUMNS.TIME - 1]);
    if (!date || !time || date < todayStr) continue;
    const p = parseInt(row[COLUMNS.PEOPLE - 1], 10);
    if (isNaN(p)) continue;
    const key = `${date}|${time}`;
    booked[key] = (booked[key] || 0) + p;
  }

  const state = loadSlotModeState_();
  const results = [];
  const changes = []; // 前回とモードが変わった枠だけ dispatch する
  // 集計対象は「予約がある枠」＋「マスターで強制指定した枠」の和集合
  const slotKeys = new Set(Object.keys(booked));
  Object.keys(master.forces).forEach(fk => { if (fk.includes('|')) slotKeys.add(fk); });

  // 祝日セット（今日〜約5.5ヶ月）を1回だけ読み込む
  const rangeEnd = Utilities.formatDate(
    new Date(Date.now() + 170 * 24 * 3600 * 1000), 'Asia/Tokyo', 'yyyy-MM-dd');
  const holidaySet = loadHolidaySet_(todayStr, rangeEnd);

  const changesBySite = {}; // { site: [{date,time,mode,stock}, ...] }
  Object.keys(MODE_SITES).forEach(s => { changesBySite[s] = []; });

  slotKeys.forEach(key => {
    const [date, time] = key.split('|');
    if (!date || date < todayStr) return;
    const force = forceFor_(master, date, time);
    const cap = capacityFor_(master, date, time);
    const bookedN = booked[key] || 0;
    const weekend = isWeekendBase_(date, holidaySet);

    if (force === 'closed') {
      // ✗ = 即予約オーバーブッキング防止のため全サイトを「リクエスト」化する。
      // （完全な受付停止ではなく、即時確定を止めて承認制にする。日程変更依頼等も可能）
      const perSite = {};
      Object.keys(MODE_SITES).forEach(site => {
        perSite[site] = 'request';
        const skey = `${site}|${key}`;
        if (state[skey] === 'request') return; // 前回もrequestなら送らない
        changesBySite[site].push({ date, time, mode: 'request', stock: 0, skey });
      });
      results.push({ date, time, cap, booked: bookedN, weekend, remaining: 0, perSite });
      return;
    }
    if (force !== 'request' && force !== 'immediate' && cap === null) return; // 定員未設定・強制なしはスキップ

    const remaining = cap === null ? 0 : Math.max(cap - bookedN, 0);
    const escalate = force !== 'request' && force !== 'immediate' && remaining <= REQUEST_THRESHOLD;

    // サイトごとに目標モードを決める（残1=リクエスト / 平日=リクエスト / 金土日祝=サイト基本）
    const perSite = {};
    Object.keys(MODE_SITES).forEach(site => {
      let mode;
      if (force === 'request')        mode = 'request';
      else if (force === 'immediate') mode = 'immediate';
      else if (escalate)              mode = 'request';
      else                            mode = siteBaseMode_(site, weekend);
      const stock = MODE_SITES[site].stockKind === 'capacity' ? (cap || 0) : remaining;
      perSite[site] = mode;

      // 前回と同じモードなら送らない（サイト別に状態管理）
      const skey = `${site}|${key}`;
      if (state[skey] === mode) return;
      changesBySite[site].push({ date, time, mode, stock, skey });
    });
    results.push({ date, time, cap, booked: bookedN, weekend, remaining, perSite });
  });

  Logger.log('【枠モード同期】\n' + results.map(r => {
    const ps = r.perSite === 'closed(手動)' ? 'closed(手動)'
      : Object.keys(MODE_SITES).map(s => `${s}:${r.perSite[s]}`).join(' ');
    return `${r.date} ${r.time} 定員${r.cap} 予約${r.booked} 残${r.remaining} ${r.weekend ? '金土日祝' : '平日'} → ${ps}`;
  }).join('\n'));

  // 有効サイトのみ dispatch する（既定は 'aj' のみ。ヘッドレス検証が済んだサイトを
  // スクリプトプロパティ MODE_SYNC_SITES にカンマ区切りで追加する。例: "aj,jalan"）
  const enabledRaw = PropertiesService.getScriptProperties().getProperty('MODE_SYNC_SITES') || 'aj';
  const enabledSites = enabledRaw.split(',').map(s => s.trim()).filter(Boolean);

  // サイトごとに、変更分を1回のdispatchでまとめて送る
  Object.keys(MODE_SITES).forEach(site => {
    if (enabledSites.indexOf(site) === -1) return; // 無効サイトは送らない
    const list = changesBySite[site];
    if (list.length === 0) return;
    const ok = notifyModeBatch_(site, list.map(c => ({ date: c.date, time: c.time, mode: c.mode, stock: c.stock })));
    if (ok) {
      list.forEach(c => { state[c.skey] = c.mode; });
      saveSlotModeState_(state);
    }
  });
  return results;
}

// 手動実行用：dispatchせず算出結果だけ確認
function syncSlotModesDryReport() {
  const before = PropertiesService.getScriptProperties().getProperty('MODE_SYNC_DRY_RUN');
  PropertiesService.getScriptProperties().setProperty('MODE_SYNC_DRY_RUN', 'true');
  const r = syncSlotModes();
  if (before === null) PropertiesService.getScriptProperties().deleteProperty('MODE_SYNC_DRY_RUN');
  else PropertiesService.getScriptProperties().setProperty('MODE_SYNC_DRY_RUN', before);
  return r;
}

// 指定サイトの複数枠の切替を1回のdispatchでまとめて通知する。
// site: 'aj' | 'jalan' ... / changes: [{date,time,mode,stock}, ...]
// 戻り値：dispatchできたら true（状態記録の可否判定に使う）
function notifyModeBatch_(site, changes) {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('MODE_SYNC_ENABLED') !== 'true') {
    Logger.log(`枠モード同期スキップ(無効): ${site} ${changes.length}件`);
    return false;
  }
  const token = props.getProperty('GITHUB_TOKEN');
  const repo  = props.getProperty('GITHUB_REPO');
  if (!token || !repo) { Logger.log('枠モード同期スキップ：GITHUB_TOKEN/GITHUB_REPO 未設定'); return false; }

  const dryRun = props.getProperty('MODE_SYNC_DRY_RUN') || 'true';
  const slots = changes.map(c => ({ date: c.date, time: c.time, mode: c.mode, stock: String(c.stock) }));
  let anyOk = false;
  {
    try {
      const res = UrlFetchApp.fetch(`https://api.github.com/repos/${repo}/dispatches`, {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
        payload: JSON.stringify({
          event_type: MODE_SITES[site].event,
          client_payload: {
            slots:       slots,
            dry_run:     dryRun,
            source_site: 'capacity-sync',
            target_site: site,
          },
        }),
        muteHttpExceptions: true,
      });
      const code = res.getResponseCode();
      if (code === 204) { anyOk = true; Logger.log(`枠モード同期：${site} に一括通知 ${slots.length}件`); }
      else Logger.log(`枠モード同期エラー ${site} (${code}): ${res.getContentText()}`);
    } catch (e) {
      Logger.log(`枠モード同期エラー ${site}: ${e.message}`);
    }
  }
  return anyOk;
}

// 枠モードの記憶状態をリセット（次回同期で全枠を再判定・再通知させる）
function resetSlotModeState() {
  PropertiesService.getScriptProperties().deleteProperty(SLOT_MODE_STATE_PROP);
  Logger.log('枠モード状態をリセットしました。次回 syncSlotModes で再通知されます。');
}

// 枠モードの前回状態（{ 'date|time': 'request'|'immediate' }）
function loadSlotModeState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(SLOT_MODE_STATE_PROP);
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (e) { return {}; }
}
function saveSlotModeState_(state) {
  PropertiesService.getScriptProperties().setProperty(SLOT_MODE_STATE_PROP, JSON.stringify(state));
}

function parseEmail(message) {
  const from    = message.getFrom();
  const body    = message.getPlainBody();
  const subject = message.getSubject();

  if (from.includes('activityboard.jp'))              return parseJalan(subject, body);
  if (from.includes('mailsender@asoview'))            return parseAsoview(subject, body);
  if (from.includes('reserve-system@activityjapan')) return parseActivityJapan(subject, body);
  if (from.includes('urkt.in'))                      return parseUrkt(subject, body);
  return null;
}

// ============================================================
// じゃらんnet
// ============================================================
function parseJalan(subject, body) {
  const dtMatch   = body.match(/利用日時[：:]\s*(\d{4})\/(\d{1,2})\/(\d{1,2})[^0-9]*(\d{1,2}:\d{2})/);
  const nameMatch = body.match(/体験者氏名[：:]\s*(.+?)(?:（|\()([^）)]+)(?:）|\))\s*様/);
  const peopleRows = [...body.matchAll(/([^：\n]+)[：:]\s*(\d+)\s*名/g)]
    .filter(m => ['大人', '小人', '子供', 'お一人'].some(k => m[1].includes(k)));
  const peopleDetail = peopleRows.map(m => `${m[1].trim()}${m[2]}名`).join('・');

  return {
    site:         'じゃらんnet',
    bookingNo:    extract(body, [/予約番号[：:]\s*([A-Z0-9]+)/]),
    name:         nameMatch ? nameMatch[1].trim() : extract(body, [/体験者氏名[：:]\s*(.+?)(?:様|\()/]),
    kana:         nameMatch ? nameMatch[2].trim() : '',
    date:         dtMatch ? `${dtMatch[1]}/${dtMatch[2]}/${dtMatch[3]}` : extract(body, [/(\d{4}\/\d{1,2}\/\d{1,2})/]),
    time:         dtMatch ? dtMatch[4] : extract(body, [/(\d{1,2}:\d{2})/]),
    people:       extract(body, [/人数[：:]\s*(\d+)\s*名/]),
    peopleDetail: peopleDetail,
    amount:       extract(body, [/合計料金[（(]税込[）)][：:]\s*([0-9,]+円)/]),
    payment:      extract(body, [/支払方法[：:]\s*(.+)/]),
    email:        extract(body, [/メールアドレス[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone:        extract(body, [/電話番号[：:]\s*([\d\-\+]+)/]),
    notes:        extract(body, [/備考[：:]\s*(.+)/]),
  };
}

// ============================================================
// アソビュー／satsuki
// ============================================================
function parseAsoview(subject, body) {
  const dateMatch    = body.match(/◆催行日\s*\|\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  const dateStr      = dateMatch ? `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}` : '';
  const peopleLines  = [...body.matchAll(/^(.+?)\s*\|\s*\d+円\s*[×x]\s*(\d+)\s*名/gm)];
  const totalPeople  = peopleLines.reduce((s, m) => s + parseInt(m[2], 10), 0);
  const peopleDetail = peopleLines.map(m => `${m[1].trim()}×${m[2]}名`).join('・');

  return {
    site:         'アソビュー/satsuki',
    bookingNo:    extract(body, [/reserveNo(\d+)/, /予約番号[：:]\s*(\d+)/]),
    name:         extract(body, [/予約代表者氏名\s*\|\s*(.+?)\s*様/]),
    kana:         extract(body, [/予約代表者氏名カナ\s*\|\s*(.+?)\s*サマ/]),
    date:         dateStr,
    time:         extract(body, [/◆コース\s*\|\s*(\d{1,2}:\d{2})/]),
    people:       totalPeople || extract(body, [/(\d+)\s*名/]),
    peopleDetail: peopleDetail,
    amount:       extract(body, [/◆提示金額\s*\|\s*([0-9,]+円)/]),
    payment:      extract(body, [/◆支払い方法\s*\|\s*(.+)/]),
    email:        extract(body, [/メールアドレス\s*\|\s*([\w.\-]+@[\w.\-]+)/]),
    phone:        extract(body, [/電話番号\s*\|\s*([\d\-\+]+)/]),
    notes:        extract(body, [/ご質問・ご要望等.*?[\r\n]+＜内容＞[\r\n]+([^\r\n]+)/s]),
  };
}

// ============================================================
// アクティビティジャパン
// ============================================================
function parseActivityJapan(subject, body) {
  const timeMatch    = body.match(/（(\d{1,2}:\d{2})\s*）/);
  const nameMatch    = body.match(/氏名[：:]\s*([^\(（\r\n]+?)(?:\s*[\(（]([^\)）]+)[\)）])?[\r\n]/);
  const peopleLines  = [...body.matchAll(/([^\n×x]+)[×x]\s*(\d+)\s*人/g)];
  const totalPeople  = peopleLines.reduce((s, m) => s + parseInt(m[2], 10), 0);
  const peopleDetail = peopleLines.map(m => `${m[1].trim()}×${m[2]}名`).join('・');

  return {
    site:         'アクティビティジャパン',
    bookingNo:    extract(body, [/予約番号[：:]\s*(\d+)/]),
    name:         nameMatch ? nameMatch[1].trim() : '',
    kana:         nameMatch && nameMatch[2] ? nameMatch[2].trim() : '',
    date:         extract(body, [/日時[：:]\s*(\d{4}年\d{1,2}月\d{1,2}日)/]),
    time:         timeMatch ? timeMatch[1] : '',
    people:       totalPeople || '',
    peopleDetail: peopleDetail,
    amount:       extract(body, [/合計料金[\s　]*[：:]\s*([0-9,]+円)/]),
    payment:      extract(body, [/支払方法[：:]\s*(.+)/]),
    email:        extract(body, [/メール[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone:        extract(body, [/電話番号[：:]\s*([\d\-\+]+)/]),
    notes:        extract(body, [/備考[：:]\s*(.+)/]),
  };
}

// ============================================================
// ウラカタ (GoRETREAT / urkt.in)
// ============================================================
function parseUrkt(subject, body) {
  // 予約日：2026年08月14日(金)
  const dateMatch = body.match(/予約日[　\s]*[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
  // 開始時間：13:30
  const timeMatch = body.match(/開始時間[　\s]*[：:]\s*(\d{1,2}:\d{2})/);
  // 合計：6
  const peopleMatch = body.match(/合計[　\s]*[：:]\s*(\d+)/);
  // 料金詳細：大人：8,500 円 × 6
  const peopleLines = [...body.matchAll(/([^\n：:]+)[：:]\s*([\d,]+)\s*円\s*[×x]\s*(\d+)/g)];
  const peopleDetail = peopleLines.map(m => `${m[1].trim()}×${m[3]}名`).join('・');
  // 合計料金：51,000 円
  const amountMatch = body.match(/合計料金[　\s]*[：:]\s*([\d,]+\s*円)/);
  // 予約ID
  const bookingNoMatch = body.match(/予約ID[　\s]*[：:]\s*(\d+)/);

  return {
    site:         'ウラカタ',
    bookingNo:    bookingNoMatch ? bookingNoMatch[1] : extract(subject, [/予約ID[：:]\s*(\d+)/]),
    name:         extract(body, [/氏名[　\s]*[：:]\s*([^\r\n]+)/]),
    kana:         extract(body, [/フリガナ[　\s]*[：:]\s*([^\r\n]+)/]),
    date:         dateMatch ? `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}` : '',
    time:         timeMatch ? timeMatch[1] : '',
    people:       peopleMatch ? peopleMatch[1] : '',
    peopleDetail: peopleDetail,
    amount:       amountMatch ? amountMatch[1].trim() : '',
    payment:      extract(body, [/支払い方法[　\s]*[：:]\s*([^\r\n]+)/]),
    email:        extract(body, [/メール[　\s]*[：:]\s*([\w.\-]+@[\w.\-]+)/]),
    phone:        extract(body, [/電話番号[　\s]*[：:]\s*([\d\-\+]+)/]),
    notes:        extract(body, [/備考[　\s]*[：:]\s*([^\r\n]+)/]),
  };
}

// ============================================================
// ユーティリティ
// ============================================================

function extract(text, patterns) {
  for (const p of patterns) {
    const m = text.match(p);
    if (m && m[1]) return m[1].trim();
  }
  return '';
}

function detectBookingType(subject) {
  for (const kw of CANCEL_KEYWORDS)    if (subject.includes(kw)) return 'キャンセル';
  for (const kw of CHANGE_KEYWORDS)    if (subject.includes(kw)) return '変更';
  for (const kw of CONFIRMED_KEYWORDS) if (subject.includes(kw)) return '確定';
  for (const kw of TENTATIVE_KEYWORDS) if (subject.includes(kw)) return '仮予約';
  return '不明';
}

function initialStatus(bookingType) {
  if (bookingType === '確定') return '承認済';
  if (bookingType === 'キャンセル') return 'キャンセル';
  return '未対応';
}

// 日付・時刻・人数が読み取れない場合は「要確認」を返す
function resolveStatus(bookingType, r) {
  if (!r.date || !r.time || !r.people) return '要確認';
  return initialStatus(bookingType);
}

function parseDateTime(dateStr, timeStr) {
  try {
    let year, month, day, hour = 9, minute = 0;

    if (dateStr instanceof Date) {
      year  = dateStr.getFullYear();
      month = dateStr.getMonth() + 1;
      day   = dateStr.getDate();
    } else {
      const normalized = String(dateStr)
        .replace(/年/, '/').replace(/月/, '/').replace(/日/, '').replace(/-/g, '/').trim();
      const parts = normalized.split('/');
      if (parts.length !== 3) return null;
      [year, month, day] = parts.map(Number);
    }

    if (timeStr instanceof Date) {
      hour   = timeStr.getHours();
      minute = timeStr.getMinutes();
    } else {
      const timeNorm = String(timeStr).replace(/時/, ':').replace(/分/, '').trim();
      if (timeNorm.includes(':')) [hour, minute] = timeNorm.split(':').map(Number);
    }

    const date = new Date(year, month - 1, day, hour, minute);
    return isNaN(date.getTime()) ? null : date;
  } catch (e) { return null; }
}

// ============================================================
// 定期リコンサイル受信（GitHub Actions → GAS Webアプリ）
// ------------------------------------------------------------
// reconcile-jalan.js が読み取った「じゃらんの今日以降の全予約」を受信し、
// スプレッドシートと突合する。
//   ・シートに無い確定/仮予約 → 取りこぼしとしてシートに追記＋LINE通知
//   ・じゃらんではキャンセル済みなのにシートでは有効 → ズレをLINE通知
//   ・シートでは有効なのにじゃらん側に存在しない → ズレをLINE通知
//
// セットアップ：
//   1. スクリプトプロパティに RECONCILE_TOKEN（任意の長い文字列）を設定
//   2. デプロイ →「ウェブアプリ」として公開（実行ユーザー:自分 / アクセス:全員）
//   3. 発行されたURLと同じトークンを GitHub Secrets に設定
// ============================================================
// ブラウザでこのWebアプリのURLを開いたときに表示される（デプロイ確認用）。
// 最新コードがデプロイされていれば下のバージョン文字列が見える。
function doGet(e) {
  return ContentService
    .createTextOutput('SUP reconcile endpoint OK / version: date-name-key-v3')
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  const out = (obj) => ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);

  let payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: 'invalid JSON' });
  }

  const expected = PropertiesService.getScriptProperties().getProperty('RECONCILE_TOKEN');
  if (!expected || payload.token !== expected) {
    return out({ ok: false, error: 'unauthorized' });
  }

  // ウラカタのログイン認証コード取得（CIの自動ログイン用）
  if (payload.action === 'urkt_auth_code') {
    return out({ ok: true, code: getLatestUrktAuthCode_(Number(payload.sinceMs) || 0) });
  }

  try {
    // payload.site で突合先を判定（既定はじゃらん・後方互換）
    const site = String(payload.site || 'じゃらん');
    // 棚卸し(auditGhostRows)用に、直近のサイト予約リストを保存しておく。
    storeLastSiteReservations_(site, payload.reservations || []);
    let result;
    if (site.includes('ウラカタ'))            result = reconcileUrakataReservations_(payload);
    else if (site.includes('アクティビティ')) result = reconcileAjReservations_(payload);
    else                                       result = reconcileJalanReservations_(payload);
    // 突合で取りこぼしを拾った後、実際の予約状況から枠モード/在庫を再同期
    // （予約メールが来ないケースの取りこぼしもここで反映される）
    syncModesSafely_();
    notifyNewSafely_(); // 突合で新たに見つかった予約も通知
    return out({ ok: true, result });
  } catch (err) {
    Logger.log('リコンサイルエラー: ' + err.message);
    try { postToLine(`🚨【至急】突合処理でエラー\n${err.message}`); } catch (_) {}
    return out({ ok: false, error: err.message });
  }
}

// ウラカタ(=アソビュー=Web予約)の予約一覧とスプレッドシートを突合する。
// ウラカタは予約番号を持たないため、キーは「参加日|時間|カナ氏名」。
function reconcileUrakataReservations_(payload) {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const data  = sheet.getDataRange().getValues();
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  // 氏名を照合しやすい形に正規化（空白除去）
  const normName = (s) => String(s || '').replace(/[\s　]/g, '');
  // ウラカタは予約番号を持たないため「参加日｜氏名」で突合する。
  // 時刻はシート側で空/別形式のことがあり不一致の原因になるためキーに使わない。
  const key = (date, kana) => `${date}|${normName(kana)}`;

  const urk = (payload.reservations || []);
  // key -> サイト側ステータス（確定/仮予約/キャンセル）。一覧に載っていれば必ず入る。
  const urkByKey = new Map();
  urk.forEach(r => urkByKey.set(key(r.date, r.name), r.status || '確定'));

  // シート側のウラカタ系（アソビュー/ウラカタ/Web予約）有効予約をマップ化
  const sheetKeys = new Map(); // key -> rowNum
  for (let i = 1; i < data.length; i++) {
    const site = String(data[i][COLUMNS.BOOKING_SITE - 1] || '');
    if (siteGroup_(site) !== 'urakata') continue;
    const status = String(data[i][COLUMNS.STATUS - 1] || '');
    if (['キャンセル', '却下'].includes(status)) continue;
    const dateStr = normalizeSlotDate_(data[i][COLUMNS.DATE - 1]);
    if (!dateStr || dateStr < today) continue;
    const kana    = data[i][COLUMNS.KANA - 1] || data[i][COLUMNS.NAME - 1];
    sheetKeys.set(key(dateStr, kana), i + 1);
  }

  const missing  = []; // ウラカタにあってシートに無い（新規取りこぼし）
  const canceled = []; // サイトで明示キャンセル → シート/カレンダー反映
  const ghost    = []; // シートにあってウラカタ一覧に無い（棚卸し対象）

  // ウラカタ → シート（新規取りこぼしの追記）
  for (const r of urk) {
    if (r.status === 'キャンセル') continue; // キャンセルは追記しない
    const k = key(r.date, r.name);
    if (!sheetKeys.has(k)) {
      // サイトのステータスを正とする。リクエスト＝仮予約（在庫連動・カレンダー登録しない）。
      const bookingType = r.status === '仮予約' ? '仮予約' : '確定';
      const rec = {
        site: r.media && r.media.includes('アソビュー') ? 'アソビュー/satsuki' : 'Web予約',
        bookingNo: '', name: r.name || '', kana: r.name || '',
        date: String(r.date || '').replace(/-/g, '/'), time: r.time || '',
        people: r.people || '', peopleDetail: '', amount: r.price || '',
        payment: '', email: '', phone: r.phone || '',
        notes: `（定期突合で自動追記：ウラカタ取りこぼし・${bookingType}）`,
      };
      appendToSheet(sheet, rec, `reconcile-urk-${k}`, `【突合検出】ウラカタ ${r.name}`, bookingType);
      if (bookingType === '確定') notifySlotReduction_(rec); // 確定のみ他サイト在庫連動
      missing.push(`${r.date} ${r.time} [${bookingType}] ${r.name} ${r.people}名`);
    }
  }

  // シート → ウラカタ（キャンセル反映＋幽霊予約棚卸し）
  const ghostRows = [];
  for (const [k, rowNum] of sheetKeys.entries()) {
    const siteStatus = urkByKey.get(k);
    if (siteStatus === 'キャンセル') {
      // サイトが明示的にキャンセル → シートも自動キャンセル（カレンダー削除込み）
      cancelSheetRow_(sheet, rowNum, '定期突合：ウラカタ側でキャンセル確認');
      canceled.push(`${k.replace(/\|/g, ' ')} → シート/カレンダーをキャンセル反映`);
    } else if (siteStatus === undefined) {
      // 一覧に一切載っていない → 棚卸し候補
      ghostRows.push({ k, rowNum });
    }
  }
  // 幽霊予約の自動キャンセル。読み取り失敗時の誤爆防止のため上限つき。
  const GHOST_LIMIT = 3;
  const autoFixGhost = urk.length > 0 && ghostRows.length <= GHOST_LIMIT;
  ghostRows.forEach(g => {
    if (autoFixGhost) {
      cancelSheetRow_(sheet, g.rowNum, '定期突合：ウラカタ一覧に存在せず（キャンセル済みと判断）');
      ghost.push(`${g.k.replace(/\|/g, ' ')} → シート/カレンダーを自動キャンセル済み`);
    } else {
      ghost.push(`${g.k.replace(/\|/g, ' ')}（要確認）`);
    }
  });
  const ghostNote = (!autoFixGhost && ghostRows.length > 0)
    ? `\n（${GHOST_LIMIT}件超のため自動修正せず通知のみ・読み取り異常の可能性）` : '';

  const lines = [];
  if (missing.length)  lines.push(`⚠️ ウラカタ取りこぼし ${missing.length}件（シートに自動追記済み）\n・` + missing.join('\n・'));
  if (canceled.length) lines.push(`🚫 ウラカタでキャンセル ${canceled.length}件（反映済み）\n・` + canceled.join('\n・'));
  if (ghost.length)    lines.push(`⚠️ ウラカタ一覧に無い予約 ${ghost.length}件${ghostNote}\n・` + ghost.join('\n・'));

  // 変更があった時だけ通知（一致のみは無通知）
  if (lines.length) {
    postToLine(`📋【ウラカタ定期突合】更新を検出\n─────────────\n${lines.join('\n─────────────\n')}`);
  }

  const summary = { checked: urk.length, missing: missing.length, canceled: canceled.length, ghost: ghost.length };
  Logger.log('ウラカタ突合完了: ' + JSON.stringify(summary));
  return summary;
}

// アクティビティジャパンの予約一覧とスプレッドシートを突合する（予約番号キー）。
function reconcileAjReservations_(payload) {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const existing = loadExistingReservations(sheet);
  const data  = sheet.getDataRange().getValues();
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');

  const list = (payload.reservations || []);
  const byNo = new Map();
  list.forEach(r => { if (r.bookingNo) byNo.set(String(r.bookingNo).trim(), r); });

  const missing = [], drift = [], promoted = [], ghost = [];

  // AJ → シート
  for (const r of list) {
    const no = String(r.bookingNo || '').trim();
    if (!no) continue;
    const rowNum = existing.byBookingNo.get(no);
    if (!rowNum) {
      if (r.status === '確定' || r.status === '仮予約') {
        const rec = {
          site: 'アクティビティジャパン', bookingNo: no, name: r.name || '', kana: '',
          date: String(r.date || '').replace(/-/g, '/'), time: r.time || '',
          people: r.people || '', peopleDetail: '', amount: '', payment: '',
          email: '', phone: '', notes: '（定期突合で自動追記：AJ取りこぼし）',
        };
        appendToSheet(sheet, rec, `reconcile-aj-${no}`, `【突合検出】AJ ${no}`, r.status === '確定' ? '確定' : '仮予約');
        if (r.status === '確定') notifySlotReduction_(rec);
        missing.push(`${r.date} ${r.time} ${no} ${r.people}名`);
      }
    } else {
      const sheetStatus = String(data[rowNum - 1][COLUMNS.STATUS - 1] || '');
      if (r.status === 'キャンセル' && !['キャンセル', '却下'].includes(sheetStatus)) {
        cancelSheetRow_(sheet, rowNum, '定期突合：AJ側でキャンセル確認');
        drift.push(`${r.date} ${r.time} ${no}（自動キャンセル済み）`);
      } else if (r.status === '確定' && ['未対応', '要確認'].includes(sheetStatus)) {
        sheet.getRange(rowNum, COLUMNS.STATUS).setValue('承認済');
        sheet.getRange(rowNum, COLUMNS.BOOKING_TYPE).setValue('確定');
        notifySlotReduction_({ site: 'アクティビティジャパン', bookingNo: no,
          date: String(r.date || '').replace(/-/g, '/'), time: r.time || '', people: r.people || '' });
        promoted.push(`${r.date} ${r.time} ${no}（確定に昇格・在庫連動）`);
      }
    }
  }

  // シート → AJ（AJ一覧に無い＝キャンセル済みと判断し、幽霊予約を棚卸し）
  const ghostRows = [];
  for (let i = 1; i < data.length; i++) {
    const site = String(data[i][COLUMNS.BOOKING_SITE - 1] || '');
    if (siteGroup_(site) !== 'aj') continue;
    const status = String(data[i][COLUMNS.STATUS - 1] || '');
    if (['キャンセル', '却下'].includes(status)) continue;
    const dateStr = normalizeSlotDate_(data[i][COLUMNS.DATE - 1]);
    if (!dateStr || dateStr < today) continue;
    const no = String(data[i][COLUMNS.BOOKING_NO - 1] || '').trim();
    if (no && !byNo.has(no)) ghostRows.push({ no, dateStr, row: i + 1 });
  }
  // 読み取り失敗時の誤キャンセルを防ぐため、上限を超えたら通知のみに切替
  const GHOST_LIMIT = 3;
  const autoFixGhost = list.length > 0 && ghostRows.length <= GHOST_LIMIT;
  ghostRows.forEach(g => {
    if (autoFixGhost) {
      cancelSheetRow_(sheet, g.row, '定期突合：AJ一覧に存在せず（キャンセル済みと判断）');
      ghost.push(`${g.dateStr} ${g.no} → シート/カレンダーを自動キャンセル済み`);
    } else {
      ghost.push(`${g.dateStr} ${g.no}（要確認）`);
    }
  });
  const ghostNote = (!autoFixGhost && ghostRows.length > 0)
    ? `\n（${GHOST_LIMIT}件超のため自動修正せず通知のみ・読み取り異常の可能性）` : '';

  const lines = [];
  if (missing.length)  lines.push(`⚠️ AJ取りこぼし ${missing.length}件（自動追記済み）\n・` + missing.join('\n・'));
  if (promoted.length) lines.push(`✅ AJ確定メール未着 ${promoted.length}件\n・` + promoted.join('\n・'));
  if (drift.length)    lines.push(`🚫 AJキャンセル反映 ${drift.length}件\n・` + drift.join('\n・'));
  if (ghost.length)    lines.push(`⚠️ AJ側に無い予約 ${ghost.length}件${ghostNote}\n・` + ghost.join('\n・'));

  // 変更があった時だけ通知（一致のみは無通知）
  if (lines.length) postToLine(`📋【AJ定期突合】更新を検出\n─────────────\n${lines.join('\n─────────────\n')}`);

  const summary = { checked: list.length, missing: missing.length, promoted: promoted.length, drift: drift.length, ghost: ghost.length };
  Logger.log('AJ突合完了: ' + JSON.stringify(summary));
  return summary;
}

function reconcileJalanReservations_(payload) {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const existing = loadExistingReservations(sheet);
  const data  = sheet.getDataRange().getValues();

  const jalanList = (payload.reservations || []);
  const jalanByNo = new Map();
  jalanList.forEach(r => { if (r.bookingNo) jalanByNo.set(String(r.bookingNo).trim(), r); });

  const missing  = [];   // シートに無い（取りこぼし）
  const drift    = [];   // じゃらん=キャンセル / シート=有効
  const ghost    = [];   // シート=有効 / じゃらんに無い
  const promoted = [];   // じゃらん=確定 / シート=未対応（確定メール未着）

  // --- じゃらん → シート方向 ---
  for (const r of jalanList) {
    const no = String(r.bookingNo || '').trim();
    if (!no) continue;
    const rowNum = existing.byBookingNo.get(no);

    if (!rowNum) {
      if (r.status === '確定' || r.status === '仮予約') {
        // 取りこぼし：シートへ追記（appendToSheetが既存のLINE通知も送る）
        const rec = {
          site: 'じゃらんnet',
          bookingNo: no,
          name: r.name || '',
          kana: '',
          date: String(r.date || '').replace(/-/g, '/'),
          time: r.time || '',
          people: r.people || '',
          peopleDetail: '',
          amount: r.price || '',
          payment: '',
          email: '', phone: '', notes: '（定期突合で自動追記：メール取りこぼし）',
        };
        appendToSheet(sheet, rec, `reconcile-${no}`, `【突合検出】じゃらん ${no}`, r.status === '確定' ? '確定' : '仮予約');
        missing.push(`${r.date} ${r.time} ${no} ${r.people}名`);
        // 取りこぼしが確定予約なら、他サイトの在庫連動も実行（dedup_keyで二重防止）
        if (r.status === '確定') notifySlotReduction_(rec);
      }
    } else {
      const sheetStatus = String(data[rowNum - 1][COLUMNS.STATUS - 1] || '');
      if (r.status === 'キャンセル' && !['キャンセル', '却下'].includes(sheetStatus)) {
        // じゃらんが明示的に「キャンセル」と言っている → シートも自動でキャンセルに
        cancelSheetRow_(sheet, rowNum, '定期突合：じゃらん側でキャンセル確認');
        drift.push(`${r.date} ${r.time} ${no}（シートを自動でキャンセルに変更済み）`);
      } else if (r.status === '確定' && ['未対応', '要確認'].includes(sheetStatus)) {
        // 承認済みなのに確定メールが来なかったケース：
        // じゃらんが「確定」と言っている → シートを承認済みに昇格＋在庫連動
        sheet.getRange(rowNum, COLUMNS.STATUS).setValue('承認済');
        sheet.getRange(rowNum, COLUMNS.BOOKING_TYPE).setValue('確定');
        const memoCell = sheet.getRange(rowNum, COLUMNS.ACTION_MEMO);
        const memo = String(memoCell.getValue() || '');
        const note = '定期突合：じゃらん側で確定を確認（確定メール未着）';
        memoCell.setValue(memo ? `${memo} / ${note}` : note);
        notifySlotReduction_({
          site: 'じゃらんnet', bookingNo: no,
          date: String(r.date || '').replace(/-/g, '/'),
          time: r.time || '', people: r.people || '',
        });
        promoted.push(`${r.date} ${r.time} ${no}（仮予約→確定に昇格・在庫連動実行）`);
      }
    }
  }

  // --- シート → じゃらん方向（じゃらん予約のみ・体験日が今日以降・有効のみ） ---
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  for (let i = 1; i < data.length; i++) {
    const site = String(data[i][COLUMNS.BOOKING_SITE - 1] || '');
    if (!site.includes('じゃらん')) continue;
    const status = String(data[i][COLUMNS.STATUS - 1] || '');
    if (['キャンセル', '却下'].includes(status)) continue;
    const dateStr = normalizeSlotDate_(data[i][COLUMNS.DATE - 1]);
    if (!dateStr || dateStr < today) continue;
    const no = String(data[i][COLUMNS.BOOKING_NO - 1] || '').trim();
    if (no && !jalanByNo.has(no)) {
      ghost.push({ no, dateStr, row: i + 1 });
    }
  }

  // 同一予約番号の重複行をまとめる（重複はシート整理が必要なサイン）
  const ghostByNo = {};
  ghost.forEach(g => {
    if (!ghostByNo[g.no]) ghostByNo[g.no] = { dateStr: g.dateStr, rows: [] };
    ghostByNo[g.no].rows.push(g.row);
  });

  // ゴースト（じゃらん一覧に無い）の自動キャンセル。
  // ただし読み取り失敗時の誤キャンセルを防ぐため、上限件数を超えたら通知のみに切替。
  const GHOST_AUTOFIX_LIMIT = 3;
  const ghostEntries = Object.entries(ghostByNo);
  const autoFixGhost = jalanList.length > 0 && ghostEntries.length <= GHOST_AUTOFIX_LIMIT;
  const ghostLines = ghostEntries.map(([no, g]) => {
    const dup = g.rows.length > 1 ? `（※シートに${g.rows.length}行重複）` : '';
    if (autoFixGhost) {
      g.rows.forEach(rowNum => cancelSheetRow_(sheet, rowNum, '定期突合：じゃらん一覧に存在せず（キャンセル済みと判断）'));
      return `${g.dateStr} ${no}${dup} → シートを自動でキャンセルに変更済み`;
    }
    return `${g.dateStr} ${no}${dup}`;
  });
  const ghostNote = (!autoFixGhost && ghostEntries.length > 0)
    ? `\n（${GHOST_AUTOFIX_LIMIT}件を超えるため自動修正せず通知のみ：読み取り異常の可能性があるため手動確認してください）`
    : '';

  // --- LINE通知 ---
  const lines = [];
  if (missing.length)    lines.push(`⚠️ 取りこぼし検出 ${missing.length}件（シートに自動追記済み）\n・` + missing.join('\n・'));
  if (promoted.length)   lines.push(`✅ 確定メール未着を検出 ${promoted.length}件\n・` + promoted.join('\n・'));
  if (drift.length)      lines.push(`⚠️ キャンセルずれ ${drift.length}件\n・` + drift.join('\n・'));
  if (ghostLines.length) lines.push(`⚠️ じゃらん側に無い予約 ${ghostLines.length}件\n・` + ghostLines.join('\n・') + ghostNote);

  // 変更（新規/キャンセル/確定昇格）があった時だけ通知する。一致のみのときは無通知。
  if (lines.length) {
    postToLine(`📋【じゃらん定期突合】更新を検出\n─────────────\n${lines.join('\n─────────────\n')}`);
  }

  const summary = { checked: jalanList.length, missing: missing.length, promoted: promoted.length, drift: drift.length, ghost: ghostLines.length };
  Logger.log('突合完了: ' + JSON.stringify(summary));
  return summary;
}

// ============================================================
// 幽霊予約 棚卸し（過去に溜まったキャンセル漏れ・重複行の一括掃除）
// ------------------------------------------------------------
// 使い方（GASエディタで順に実行）：
//   1) 定期突合(Reconcile)を1回走らせる → 各サイトの最新予約リストが保存される
//   2) auditGhostRows()    … 消さずに「サイトの有効予約に一致しない今日以降の行」を一覧表示
//   3) 内容を確認して問題なければ applyGhostCleanup() … 一覧の行を一括キャンセル（カレンダー削除込み）
// 安全策：あるサイトの保存データが空のときはそのサイトの行は対象にしない（誤爆防止）。
// ============================================================

// 突合時に受け取ったサイト予約リストを保存（棚卸しの照合元）。容量節約のため必要項目だけ。
function storeLastSiteReservations_(site, reservations) {
  try {
    const g = siteGroup_(site) ||
      (String(site).includes('アクティビティ') ? 'aj' : String(site).includes('じゃらん') ? 'jalan' : 'urakata');
    const slim = (reservations || []).map(r => ({
      bookingNo: r.bookingNo || '', name: r.name || '',
      date: String(r.date || '').replace(/\//g, '-'), status: r.status || '',
    }));
    const props = PropertiesService.getScriptProperties();
    props.setProperty('LAST_RES_' + g, JSON.stringify(slim));
    props.setProperty('LAST_RES_' + g + '_AT', new Date().toISOString());
  } catch (e) {
    Logger.log('サイト予約リスト保存に失敗: ' + e.message);
  }
}

function auditGhostRows()   { return ghostAudit_(false); }
function applyGhostCleanup() { return ghostAudit_(true); }

function ghostAudit_(apply) {
  const props = PropertiesService.getScriptProperties();
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const data  = sheet.getDataRange().getValues();
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  const norm  = (s) => String(s || '').replace(/[\s　]/g, '');

  // 各グループの「有効(キャンセル/却下でない)予約」キー集合を保存データから作る
  const groups = ['jalan', 'aj', 'urakata'];
  const activeSets = {}, at = {}, counts = {};
  groups.forEach(g => {
    let list = [];
    try { list = JSON.parse(props.getProperty('LAST_RES_' + g) || '[]'); } catch (e) { list = []; }
    at[g] = props.getProperty('LAST_RES_' + g + '_AT') || '(未取得)';
    counts[g] = list.length;
    const byNo = new Set(), byDateName = new Set();
    list.forEach(r => {
      if (r.status === 'キャンセル' || r.status === '却下') return;
      const d = String(r.date || '').replace(/\//g, '-');
      if (r.bookingNo) byNo.add(String(r.bookingNo).trim());
      byDateName.add(`${d}|${norm(r.name)}`);
    });
    activeSets[g] = { byNo, byDateName };
  });

  const candidates = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const status = String(row[COLUMNS.STATUS - 1] || '');
    if (['キャンセル', '却下'].includes(status)) continue;
    const g = siteGroup_(row[COLUMNS.BOOKING_SITE - 1]);
    if (!g) continue;                       // 直接予約(LINE/インスタ等)は対象外
    if (counts[g] === 0) continue;          // そのサイトの保存データが無い→安全のためスキップ
    const dateStr = normalizeSlotDate_(row[COLUMNS.DATE - 1]);
    if (!dateStr || dateStr < today) continue; // 今日以降のみ
    const no = String(row[COLUMNS.BOOKING_NO - 1] || '').trim();
    const dn = `${dateStr}|${norm(row[COLUMNS.KANA - 1] || row[COLUMNS.NAME - 1])}`;
    const set = activeSets[g];
    const matched = g === 'urakata'
      ? set.byDateName.has(dn)
      : ((no && set.byNo.has(no)) || set.byDateName.has(dn));
    if (!matched) {
      candidates.push({
        row: i + 1, g, date: dateStr,
        time: normalizeSlotTime_(row[COLUMNS.TIME - 1]),
        name: row[COLUMNS.NAME - 1] || row[COLUMNS.KANA - 1] || '',
        people: row[COLUMNS.PEOPLE - 1] || '', no,
      });
    }
  }

  Logger.log(`【幽霊予約 棚卸し ${apply ? '適用' : 'ドライラン'}】`);
  Logger.log(`保存済みサイトデータ件数: jalan=${counts.jalan}(${at.jalan}) / aj=${counts.aj}(${at.aj}) / urakata=${counts.urakata}(${at.urakata})`);
  if (counts.jalan === 0 && counts.aj === 0 && counts.urakata === 0) {
    Logger.log('⚠️ 保存データがありません。先に定期突合(Reconcile)を1回実行してから再度お試しください。');
    return { candidates: 0, needReconcile: true };
  }
  Logger.log(`掃除候補（サイトの有効予約に一致しない・今日以降の行）: ${candidates.length}件`);
  candidates.forEach(c => Logger.log(`  行${c.row} [${c.g}] ${c.date} ${c.time} ${c.name} ${c.people}名 ${c.no}`));

  if (apply) {
    candidates.forEach(c => cancelSheetRow_(sheet, c.row, '棚卸し：サイトの有効予約に存在せず（キャンセル/幽霊と判断）'));
    Logger.log(`→ ${candidates.length}件をキャンセル反映（カレンダー削除込み）しました`);
  } else {
    Logger.log('※まだ消していません。内容を確認して問題なければ applyGhostCleanup() を実行してください。');
  }
  return { candidates: candidates.length };
}

// 突合による自動キャンセル：ステータス変更＋カレンダーイベント削除＋対応メモ記録
function cancelSheetRow_(sheet, rowNum, reason) {
  sheet.getRange(rowNum, COLUMNS.STATUS).setValue('キャンセル');
  const memoCell = sheet.getRange(rowNum, COLUMNS.ACTION_MEMO);
  const memo = String(memoCell.getValue() || '');
  memoCell.setValue(memo ? `${memo} / ${reason}` : reason);

  const calEventId = sheet.getRange(rowNum, COLUMNS.CALENDAR_ID_COL).getValue();
  if (calEventId) {
    try {
      const calendar = CalendarApp.getCalendarById(CONFIG.CALENDAR_ID);
      const event    = calendar.getEventById(calEventId);
      if (event) event.deleteEvent();
      sheet.getRange(rowNum, COLUMNS.CALENDAR_ID_COL).setValue('');
    } catch (e) {
      Logger.log(`カレンダー削除エラー(行${rowNum}): ${e.message}`);
    }
  }
}

// 重複行の掃除（定期突合の誤作動で増えた重複を1件だけ残して削除）。
// 判定キー：予約サイト系グループ｜参加日｜時間｜氏名(カナ優先)。
// キャンセル/却下行は対象外（残す）。手動実行専用。
function cleanupDuplicateRows() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const data  = sheet.getDataRange().getValues();

  const normName = (s) => String(s || '').replace(/[\s　]/g, '');

  const seen = {};          // key -> 最初に見つけた行番号
  const toDelete = [];      // 削除する行番号（重複の2件目以降）

  for (let i = 1; i < data.length; i++) {
    const status = String(data[i][COLUMNS.STATUS - 1] || '');
    if (['キャンセル', '却下'].includes(status)) continue;
    const site = String(data[i][COLUMNS.BOOKING_SITE - 1] || '');
    const dateStr = normalizeSlotDate_(data[i][COLUMNS.DATE - 1]);
    if (!dateStr) continue;
    const kana    = normName(data[i][COLUMNS.KANA - 1] || data[i][COLUMNS.NAME - 1]);
    const bookingNo = String(data[i][COLUMNS.BOOKING_NO - 1] || '').trim();
    // 予約番号があればそれを優先キー、無ければ サイトグループ|日付|氏名
    // （時刻はシート側で空/別形式のことがあり重複判定を邪魔するため使わない）
    const key = bookingNo
      ? `NO:${bookingNo}`
      : `${siteGroup_(site) || site}|${dateStr}|${kana}`;

    if (seen[key]) toDelete.push(i + 1);
    else seen[key] = i + 1;
  }

  // 下の行から削除（行番号ズレ防止）
  toDelete.sort((a, b) => b - a).forEach(rowNum => sheet.deleteRow(rowNum));

  Logger.log(`重複削除：${toDelete.length}行を削除しました（削除行: ${toDelete.sort((a,b)=>a-b).join(', ')}）`);
  return toDelete.length;
}

function loadExistingReservations(sheet) {
  const data        = sheet.getDataRange().getValues();
  const byBookingNo = new Map();
  const byMsgId     = new Set();

  for (let i = 1; i < data.length; i++) {
    const bookingNo = String(data[i][COLUMNS.BOOKING_NO - 1]).trim();
    const msgId     = String(data[i][COLUMNS.MESSAGE_ID - 1]).trim();
    if (bookingNo) byBookingNo.set(bookingNo, i + 1);
    if (msgId)     byMsgId.add(msgId);
  }
  return { byBookingNo, byMsgId };
}

function resolveInstructor(people) {
  const count = parseInt(people, 10);
  return (!isNaN(count) && count >= INSTRUCTOR_THRESHOLD) ? '必要' : '不要';
}

function appendToSheet(sheet, r, msgId, subject, bookingType) {
  const instructorNeeded = resolveInstructor(r.people);
  const status           = resolveStatus(bookingType, r);
  sheet.appendRow([
    new Date(),                // A: 処理日時
    subject,                   // B: メール件名
    r.site         || '',      // C: 予約サイト
    bookingType,               // D: 予約タイプ
    r.bookingNo    || '',      // E: 予約番号
    r.name         || '',      // F: 予約者名
    r.kana         || '',      // G: フリガナ
    r.date         || '',      // H: 予約日
    r.time         || '',      // I: 予約時間
    r.people       || '',      // J: 人数（合計）
    r.peopleDetail || '',      // K: 人数内訳
    r.amount       || '',      // L: 金額
    r.payment      || '',      // M: 支払方法
    r.email        || '',      // N: メールアドレス
    r.phone        || '',      // O: 電話番号
    r.notes        || '',      // P: 備考
    instructorNeeded,          // Q: 追加インストラクター（必要/不要）
    '',                        // R: 追加インストラクター担当
    status,                    // S: ステータス
    '',                        // T: 対応メモ
    '',                        // U: カレンダーイベントID
    msgId,                     // V: メッセージID
    '',                        // W: LINE通知済み
  ]);

  // 書き込んだ行番号を取得してLINE通知
  const newRow     = sheet.getLastRow();
  const notifyType = resolveLineNotifyType(bookingType, r, instructorNeeded);
  if (notifyType) {
    const rWithInstructor = Object.assign({}, r, { instructorNeeded, instructorName: '' });
    const slotInfo = getSlotCapacity(sheet, r.date, r.time);
    sendLineNotification(sheet, newRow, notifyType, rWithInstructor, slotInfo);
  }
}

function updateRow(sheet, rowNum, r, msgId, subject, bookingType) {
  const currentStatus = sheet.getRange(rowNum, COLUMNS.STATUS).getValue();

  // カレンダー登録済・キャンセルはステータスを変えない
  let newStatus = currentStatus;
  if (!['カレンダー登録済', 'キャンセル'].includes(currentStatus)) {
    newStatus = resolveStatus(bookingType, r);
  }

  const updates = {
    [COLUMNS.TIMESTAMP]:    new Date(),
    [COLUMNS.SUBJECT]:      subject,
    [COLUMNS.BOOKING_TYPE]: bookingType,
    [COLUMNS.STATUS]:       newStatus,
    [COLUMNS.MESSAGE_ID]:   msgId,
  };
  const instructorNeeded = resolveInstructor(r.people);
  if (r.name)         updates[COLUMNS.NAME]              = r.name;
  if (r.kana)         updates[COLUMNS.KANA]              = r.kana;
  if (r.date)         updates[COLUMNS.DATE]              = r.date;
  if (r.time)         updates[COLUMNS.TIME]              = r.time;
  if (r.people)       updates[COLUMNS.PEOPLE]            = r.people;
  if (r.peopleDetail) updates[COLUMNS.PEOPLE_DETAIL]     = r.peopleDetail;
  if (r.amount)       updates[COLUMNS.AMOUNT]            = r.amount;
  if (r.payment)      updates[COLUMNS.PAYMENT]           = r.payment;
  if (r.email)        updates[COLUMNS.EMAIL]             = r.email;
  if (r.phone)        updates[COLUMNS.PHONE]             = r.phone;
  if (r.people)       updates[COLUMNS.INSTRUCTOR_NEEDED] = instructorNeeded;

  Object.entries(updates).forEach(([col, val]) => {
    sheet.getRange(rowNum, Number(col)).setValue(val);
  });

  // 変更通知 or 新たに要対応になった場合のみ通知（同じ理由での重複防止はsendLineNotification内で管理）
  const notifyType = resolveLineNotifyType(bookingType, r, instructorNeeded);
  if (notifyType) {
    const dateVal        = r.date || sheet.getRange(rowNum, COLUMNS.DATE).getValue();
    const timeVal        = r.time || sheet.getRange(rowNum, COLUMNS.TIME).getValue();
    const instructorName = sheet.getRange(rowNum, COLUMNS.INSTRUCTOR_NAME).getValue();
    const rWithInstructor = Object.assign({}, r, { instructorNeeded, instructorName });
    const slotInfo = getSlotCapacity(sheet, dateVal, timeVal);
    sendLineNotification(sheet, rowNum, notifyType, rWithInstructor, slotInfo);
  }
}

function getOrCreateSheet(ss) {
  let sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(CONFIG.SHEET_NAME);

  const headers = [
    '処理日時', 'メール件名', '予約サイト', '予約タイプ', '予約番号',
    '予約者名', 'フリガナ', '予約日', '予約時間', '人数',
    '人数内訳', '金額', '支払方法', 'メールアドレス', '電話番号',
    '備考', '追加インストラクター', '追加インストラクター担当',
    'ステータス', '対応メモ', 'カレンダーイベントID', 'メッセージID', 'LINE通知済み',
  ];

  if (sheet.getRange(1, 1).getValue() !== '処理日時') {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length)
      .setBackground('#4a86e8').setFontColor('#ffffff').setFontWeight('bold');

    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['未対応', '対応中', '承認済', '要確認', '却下', 'キャンセル', 'カレンダー登録済'])
      .build();
    sheet.getRange(2, COLUMNS.STATUS, 1000, 1).setDataValidation(rule);
    sheet.hideColumns(COLUMNS.CALENDAR_ID_COL);
    sheet.hideColumns(COLUMNS.MESSAGE_ID);
    sheet.hideColumns(COLUMNS.LINE_NOTIFIED);
  }
  return sheet;
}

function getOrCreateLabel(labelName) {
  const parts = labelName.split('/');
  let label = null, path = '';
  for (const part of parts) {
    path  = path ? `${path}/${part}` : part;
    label = GmailApp.getUserLabelByName(path) || GmailApp.createLabel(path);
  }
  return label;
}

// ============================================================
// セットアップ：トリガー登録
// ============================================================
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  // ★メール取込は廃止：予約の確定/リクエスト/キャンセルは各サイトの実データ（2時間ごとの
  //   定期突合＝GitHub ActionsのReconcileワークフロー）を正とする。importReservationEmails は
  //   手動の過去取込用にのみ残し、定期トリガーには登録しない。
  ScriptApp.newTrigger('registerApprovedToCalendar').timeBased().everyHours(1).create();
  // 運用支援
  ScriptApp.newTrigger('sendDayBeforeReminders').timeBased().atHour(20).everyDays(1).create(); // 毎晩20時
  ScriptApp.newTrigger('sendMorningList').timeBased().atHour(7).everyDays(1).create();          // 毎朝7時
  ScriptApp.newTrigger('checkPendingRequests').timeBased().everyHours(1).create();              // 毎時（3時間超の未承認催促）
  Logger.log('トリガーを設定しました');
}

// ============================================================
// 顧客リマインドメールの本番/テスト切替（関数を1回実行するだけ）
// ============================================================
// ・enableCustomerMailLive()  … 本番送信ON（実際のお客様アドレスへ送る）
// ・disableCustomerMailLive() … テストに戻す（自分宛てに送る）
// ・checkCustomerMailMode()   … 現在の状態を確認
function enableCustomerMailLive() {
  PropertiesService.getScriptProperties().setProperty('CUSTOMER_MAIL_MODE', 'live');
  Logger.log('✅ 顧客リマインドメールを【本番(live)】にしました。毎晩20時に翌日の確定予約のお客様へ実送信します。');
}
function disableCustomerMailLive() {
  PropertiesService.getScriptProperties().setProperty('CUSTOMER_MAIL_MODE', 'test');
  Logger.log('🧪 顧客リマインドメールを【テスト(test)】に戻しました。送信先は自分宛てのみです。');
}
function checkCustomerMailMode() {
  const mode = PropertiesService.getScriptProperties().getProperty('CUSTOMER_MAIL_MODE') || 'test';
  const testTo = PropertiesService.getScriptProperties().getProperty('REMINDER_TEST_EMAIL') || Session.getActiveUser().getEmail();
  Logger.log(`現在のモード: ${mode}（${mode === 'live' ? '本番＝お客様へ実送信' : 'テスト＝' + testTo + ' へ送信'}）`);
  return mode;
}

// 本番投入前の動作確認：明日分に限らず「直近の確定予約1件」の案内メールを
// 自分宛てにプレビュー送信する（本文の最終チェック用。REMINDER_SENTは更新しない）。
function previewCustomerReminderMail() {
  const ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  const sheet = getOrCreateSheet(ss);
  const data  = sheet.getDataRange().getValues();
  const to    = PropertiesService.getScriptProperties().getProperty('REMINDER_TEST_EMAIL') || Session.getActiveUser().getEmail();
  for (let i = 1; i < data.length; i++) {
    if (!isConfirmedRow_(data[i])) continue;
    if (toYmd_(data[i][COLUMNS.DATE - 1]) < todayYmd_()) continue; // 今日以降の確定
    const { subject, body } = buildCustomerReminderMail_(data[i]);
    MailApp.sendEmail({ to, subject: `[PREVIEW] ${subject}`, body, name: MEETING_INFO.senderName });
    Logger.log(`プレビュー送信しました → ${to}（対象行 ${i + 1}）`);
    return;
  }
  Logger.log('今日以降の確定予約が見つからずプレビューできませんでした。');
}

// ============================================================
// 手動テスト用
// ============================================================
function testParseLatestEmail() {
  const threads = GmailApp.search(CONFIG.SEARCH_QUERY, 0, 1);
  if (!threads.length) { Logger.log('対象メールが見つかりませんでした'); return; }
  const msg = threads[0].getMessages()[0];
  Logger.log('件名: '   + msg.getSubject());
  Logger.log('差出人: ' + msg.getFrom());
  Logger.log(JSON.stringify(parseEmail(msg), null, 2));
}
