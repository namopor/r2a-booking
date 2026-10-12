/**
 * R2A Interview Booking — Google Apps Script web app
 *
 * Bound to the "R2A Interview Booking" sheet. Reads candidates from the
 * "R2A responses" tab of the R2A recruitment Tracker (read only).
 *
 * How rounds work (backstage and frontstage run separately):
 *   - Each side starts at the candidate's 1st choice.
 *   - Board marks the Results tab: Pass -> that side is done.
 *                                  Fail -> next choice unlocks + email to candidate.
 *   - Candidates log in with student ID (+ email), see only the role they are
 *     currently on, and book a 20-min online slot. A Google Meet event is added
 *     to the AS18 Board Calendar.
 *
 * Tabs: Slots | Bookings | Results | Settings  (created by "R2A booking > Set up")
 */

const TZ = 'Asia/Bangkok';
const TAB = { SLOTS: 'Slots', BOOKINGS: 'Bookings', RESULTS: 'Results', SETTINGS: 'Settings' };

// Source columns (0-based) in "R2A responses"
const SRC = { TS: 0, EMAIL: 1, ID: 2, PREFIX: 3, NAME: 4, NICK: 5 };
const SIDES = {
  back:  { label: 'Backstage',  th: 'เบื้องหลัง', cols: [6, 7, 8] },
  front: { label: 'Frontstage', th: 'เบื้องหน้า', cols: [9, 10, 11] }
};
const SIDE_KEYS = ['back', 'front'];

const SLOT_H = ['Slot ID', 'Side', 'Role', 'Date', 'Start', 'End', 'Capacity', 'Interviewer', 'Notes'];
const BOOK_H = ['Booked at', 'Student ID', 'Name', 'Nickname', 'Email', 'Side', 'Choice #', 'Role',
  'Slot ID', 'Start', 'End', 'Meet link', 'Calendar event ID', 'Status'];
const RES_H = ['Student ID', 'Name', 'Nickname', 'Email', 'Side', 'Choice #', 'Role', 'Result',
  'Interview time', 'Notified at'];
const B = {}; BOOK_H.forEach(function (h, i) { B[h] = i; });
const R = {}; RES_H.forEach(function (h, i) { R[h] = i; });

const DEFAULT_SETTINGS = [
  ['SOURCE_SPREADSHEET_ID', '13iVGoWnhbhWqR04kaRRwUjbA5RASlvPMnibaVqRdtt4', 'R2A recruitment Tracker (read only)'],
  ['SOURCE_TAB', 'R2A responses', 'Tab with the form responses'],
  ['SOURCE_FIRST_ROW', '3', 'First row of answers (rows 1–2 are headers)'],
  ['CALENDAR_ID', 'c_9a116c8ea86d6f4703dc11927f2d3fd6e8c3fa67fedce8e9633611aa8e72a0e2@group.calendar.google.com', 'AS18 Board Calendar'],
  ['REQUIRE_EMAIL', 'TRUE', 'TRUE = candidates must enter student ID and the email they used in the form'],
  ['SLOT_DATES', '2026-10-13, 2026-10-14, 2026-10-15, 2026-10-16', 'Dates used by "Generate slots" (yyyy-mm-dd, comma separated)'],
  ['DAY_START', '19:00', 'First slot of each day'],
  ['DAY_END', '22:00', 'Last slot must end by this time'],
  ['SLOT_MINUTES', '20', 'Length of each interview'],
  ['MIN_HOURS_BEFORE', '3', 'Slots starting sooner than this are hidden'],
  ['FALLBACK_MEET_LINK', '', 'Used only if a Meet link cannot be created automatically'],
  ['EVENT_TITLE_PREFIX', 'R2A Interview', 'Calendar event title starts with this'],
  ['SENDER_NAME', 'R2A Recruitment', 'Name shown on unlock emails'],
  ['WEB_APP_URL', '', 'Paste the /exec link after deploying (used in emails)'],
  ['SITE_TITLE_TH', 'จองเวลาสัมภาษณ์ R2A', 'Page title (Thai)'],
  ['SITE_TITLE_EN', 'R2A Interview Booking', 'Page title (English)'],
  ['CONTACT', '', 'Shown at the bottom of the page and in emails (e.g. LINE ID)']
];

/* =========================== Web app =========================== */

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action) return api_(p);   // called by the GitHub Pages site
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle(getSettings_().SITE_TITLE_EN || 'R2A Interview Booking')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * JSON/JSONP API for the booking page hosted outside Google (GitHub Pages).
 *   ?action=config
 *   ?action=lookup&id=<student id>&email=<email>
 *   ?action=book&id=...&email=...&side=back|front&slot=<slot id>
 * Add &callback=<name> for JSONP (what the GitHub page uses).
 */
function api_(p) {
  let out;
  try {
    if (p.action === 'config') out = getPublicConfig();
    else if (p.action === 'lookup') out = lookupCandidate(p.id, p.email);
    else if (p.action === 'book') out = bookSlot(p.id, p.email, p.side, p.slot);
    else out = { ok: false, code: 'server' };
  } catch (err) {
    console.error(err);
    out = { ok: false, code: 'server' };
  }
  const json = JSON.stringify(out);
  const cb = String(p.callback || '');
  if (/^[A-Za-z_$][\w$]{0,63}$/.test(cb)) {
    return ContentService.createTextOutput(cb + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

function getPublicConfig() {
  const s = getSettings_();
  return {
    titleTh: s.SITE_TITLE_TH, titleEn: s.SITE_TITLE_EN, contact: s.CONTACT,
    requireEmail: bool_(s.REQUIRE_EMAIL), sendInvites: false
  };
}

/** Login: returns both sides' status and open slots for the current role. */
function lookupCandidate(studentId, email) {
  const auth = auth_(studentId, email);
  if (!auth.ok) return auth;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return { ok: false, code: 'busy' };
  try {
    ensureResultRows_(auth.cand);
    return { ok: true, name: auth.cand.nickname || auth.cand.name, sides: sidesView_(auth.cand) };
  } finally {
    lock.releaseLock();
  }
}

/** Book a slot for one side. Re-checks everything under a lock. */
function bookSlot(studentId, email, side, slotId) {
  const auth = auth_(studentId, email);
  if (!auth.ok) return auth;
  if (!SIDES[side]) return { ok: false, code: 'server' };
  const cand = auth.cand;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { ok: false, code: 'busy' };
  try {
    const results = readResults_(), bookings = readBookings_();
    const st = sideState_(cand, side, results, bookings);
    if (st.state !== 'open') return { ok: false, code: 'not_open', sides: sidesView_(cand) };

    const slot = readSlots_().find(function (x) { return x.id === String(slotId); });
    if (!slot) return { ok: false, code: 'slot_taken', sides: sidesView_(cand) };
    if (slot.side !== side || !same_(slot.role, st.role)) return { ok: false, code: 'wrong_role', sides: sidesView_(cand) };
    if (!slotOpen_(slot, bookings)) return { ok: false, code: 'slot_taken', sides: sidesView_(cand) };

    const s = getSettings_();
    const ev = createEvent_(s, cand, side, st, slot);

    sheet_(TAB.BOOKINGS).appendRow([
      new Date(), cand.id, cand.name, cand.nickname, cand.email, SIDES[side].label, st.rank, st.role,
      slot.id, slot.start, slot.end, ev.meet, ev.id, 'Booked'
    ]);
    setInterviewTime_(cand.id, side, st.role, slot.start);
    SpreadsheetApp.flush();

    return {
      ok: true, side: side,
      booking: { role: st.role, rank: st.rank, start: slot.start.getTime(), end: slot.end.getTime(), meet: ev.meet }
    };
  } finally {
    lock.releaseLock();
  }
}

/* ===================== Round / state logic ===================== */

function auth_(studentId, email) {
  const id = normId_(studentId);
  if (!id) return { ok: false, code: 'invalid_id' };
  const cand = readCandidates_()[id];
  const s = getSettings_();
  if (!cand) return { ok: false, code: 'no_match' };
  if (bool_(s.REQUIRE_EMAIL) && normEmail_(email) !== cand.email) return { ok: false, code: 'no_match' };
  return { ok: true, cand: cand };
}

/**
 * Where a candidate stands on one side:
 *   none   – picked no roles on this side
 *   open   – can book their current role
 *   booked – has a booking for their current role
 *   done   – passed a role on this side (remaining choices dropped)
 *   closed – failed every choice on this side
 */
function sideState_(cand, side, results, bookings) {
  const choices = cand.choices[side];
  const total = choices.length;
  if (!total) return { state: 'none', total: 0 };
  for (let k = 0; k < total; k++) {
    const role = choices[k];
    const key = key_(cand.id, side, role);
    const res = results.map[key] ? results.map[key].result : '';
    if (res === 'pass') return { state: 'done', role: role, rank: k + 1, total: total };
    if (res === 'fail') continue;
    const b = bookings.active[key];
    return { state: b ? 'booked' : 'open', role: role, rank: k + 1, total: total, booking: b || null };
  }
  return { state: 'closed', total: total };
}

function sidesView_(cand) {
  const results = readResults_(), bookings = readBookings_(), slots = readSlots_();
  return SIDE_KEYS.map(function (side) {
    const st = sideState_(cand, side, results, bookings);
    const out = { side: side, state: st.state, role: st.role || '', rank: st.rank || 0, total: st.total };
    // Never reveal Pass/Fail on the page: done and closed look the same.
    if (st.state === 'done' || st.state === 'closed') { out.state = 'finished'; out.role = ''; out.rank = 0; }
    if (st.state === 'booked') out.booking = st.booking;
    if (st.state === 'open') {
      out.slots = slots
        .filter(function (x) { return x.side === side && same_(x.role, st.role) && slotOpen_(x, bookings); })
        .sort(function (a, b) { return a.start - b.start; })
        .map(function (x) {
          return { id: x.id, start: x.start.getTime(), end: x.end.getTime(), left: x.capacity - (bookings.counts[x.id] || 0), capacity: x.capacity };
        });
    }
    return out;
  });
}

/** Make sure the Results tab has a "Pending" row for each side's current role. */
function ensureResultRows_(cand, results, bookings) {
  results = results || readResults_();
  bookings = bookings || readBookings_();
  const sh = sheet_(TAB.RESULTS);
  const added = [];
  SIDE_KEYS.forEach(function (side) {
    const st = sideState_(cand, side, results, bookings);
    if ((st.state === 'open' || st.state === 'booked') && !results.map[key_(cand.id, side, st.role)]) {
      sh.appendRow([cand.id, cand.name, cand.nickname, cand.email, SIDES[side].label, st.rank, st.role, 'Pending', '', '']);
      results.map[key_(cand.id, side, st.role)] = { result: 'pending' };
      added.push({ side: side, st: st });
    }
  });
  return added;
}

/* ====================== Board-side actions ====================== */

/** Installable onEdit trigger (created by Set up). */
function handleEdit(e) {
  if (!e || !e.range) return;
  const name = e.range.getSheet().getName();
  const c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
  if (name === TAB.RESULTS && c1 <= R['Result'] + 1 && c2 >= R['Result'] + 1) processResults();
  if (name === TAB.BOOKINGS && c1 <= B['Status'] + 1 && c2 >= B['Status'] + 1) processCancellations();
}

/** For every Fail not yet handled: unlock next choice and email the candidate. */
function processResults() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const sh = sheet_(TAB.RESULTS);
    const n = sh.getLastRow() - 1;
    if (n < 1) return;
    const rows = sh.getRange(2, 1, n, RES_H.length).getValues();
    const cands = readCandidates_();
    const s = getSettings_();
    rows.forEach(function (r, i) {
      if (String(r[R['Result']]).trim().toLowerCase() !== 'fail') return;
      if (String(r[R['Notified at']]).trim()) return;
      const cand = cands[normId_(r[R['Student ID']])];
      const side = sideKey_(r[R['Side']]);
      let note = '';
      if (!cand || !side) {
        note = 'Skipped: candidate not found';
      } else {
        ensureResultRows_(cand);
        const st = sideState_(cand, side, readResults_(), readBookings_());
        if (st.state === 'open') {
          sendUnlockEmail_(s, cand, side, st);
          note = 'Emailed: next choice ' + st.role;
        } else if (st.state === 'closed') {
          note = 'No more choices on this side';
        } else {
          note = 'No email (' + st.state + ')';
        }
      }
      sh.getRange(i + 2, R['Notified at'] + 1).setValue(
        Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm') + ' – ' + note);
    });
  } finally {
    lock.releaseLock();
  }
}

/** When a booking's Status is set to Cancelled, remove its calendar event. */
function processCancellations() {
  const sh = sheet_(TAB.BOOKINGS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return;
  const s = getSettings_();
  const rows = sh.getRange(2, 1, n, BOOK_H.length).getValues();
  rows.forEach(function (r, i) {
    const status = String(r[B['Status']]).trim().toLowerCase();
    const evId = String(r[B['Calendar event ID']]).trim();
    if (status !== 'cancelled' || !evId || evId.indexOf('removed') === 0) return;
    deleteEvent_(s, evId);
    sh.getRange(i + 2, B['Calendar event ID'] + 1).setValue('removed ' + evId);
    setInterviewTime_(normId_(r[B['Student ID']]), sideKey_(r[B['Side']]), r[B['Role']], null);
  });
}

/* ========================= Setup & menu ========================= */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('R2A booking')
    .addItem('1. Set up', 'setup')
    .addItem('2. Generate slots', 'generateSlots')
    .addSeparator()
    .addItem('Send pending unlock emails', 'processResults')
    .addItem('Apply cancellations', 'processCancellations')
    .addItem('Check candidate list', 'checkCandidates')
    .addToUi();
}

function setup() {
  const ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone(TZ);

  const settings = ensureSheet_(ss, TAB.SETTINGS, ['Key', 'Value', 'What it does']);
  settings.getRange('B:B').setNumberFormat('@');
  const have = settings.getLastRow() > 1
    ? settings.getRange(2, 1, settings.getLastRow() - 1, 1).getValues().map(function (r) { return String(r[0]); })
    : [];
  DEFAULT_SETTINGS.forEach(function (row) { if (have.indexOf(row[0]) === -1) settings.appendRow(row); });
  settings.autoResizeColumns(1, 3);

  const slots = ensureSheet_(ss, TAB.SLOTS, SLOT_H);
  slots.getRange('D:D').setNumberFormat('yyyy-mm-dd');
  slots.getRange('E:F').setNumberFormat('HH:mm');

  const bookings = ensureSheet_(ss, TAB.BOOKINGS, BOOK_H);
  bookings.getRange('J:K').setNumberFormat('yyyy-mm-dd HH:mm');
  bookings.getRange(2, B['Status'] + 1, 4999, 1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Booked', 'Cancelled'], true).build());

  const results = ensureSheet_(ss, TAB.RESULTS, RES_H);
  const resCol = results.getRange(2, R['Result'] + 1, 4999, 1);
  resCol.setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['Pending', 'Pass', 'Fail'], true).build());
  const rules = [
    ['Pass', '#d9ead3'], ['Fail', '#f4cccc'], ['Pending', '#fff2cc']
  ].map(function (p) {
    return SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(p[0]).setBackground(p[1]).setRanges([resCol]).build();
  });
  results.setConditionalFormatRules(rules);

  // Trigger that reacts to Pass/Fail and cancellations
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'handleEdit'; });
  if (!exists) ScriptApp.newTrigger('handleEdit').forSpreadsheet(ss).onEdit().create();

  // Prefill Results with every candidate's 1st choice per side
  const cands = readCandidates_();
  const res = readResults_(), bk = readBookings_();
  Object.keys(cands).forEach(function (id) { ensureResultRows_(cands[id], res, bk); });

  const old = ss.getSheetByName('Sheet1') || ss.getSheetByName('ชีต1');
  if (old && old.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(old);

  SpreadsheetApp.getUi().alert('Set up done: ' + Object.keys(cands).length +
    ' candidates loaded. Next: R2A booking > 2. Generate slots.');
}

/** Creates slots for every role candidates picked, on SLOT_DATES between DAY_START and DAY_END. Safe to re-run. */
function generateSlots() {
  const s = getSettings_();
  const dates = String(s.SLOT_DATES).split(/[,\s]+/).map(function (d) { return dateParts_(null, d); }).filter(Boolean);
  const t0 = parseTime_(s.DAY_START), t1 = parseTime_(s.DAY_END);
  const len = Number(s.SLOT_MINUTES) || 20;
  if (!dates.length || !t0 || !t1) throw new Error('Check SLOT_DATES, DAY_START and DAY_END in Settings.');

  const roles = { back: [], front: [] };
  const cands = readCandidates_();
  Object.keys(cands).forEach(function (id) {
    SIDE_KEYS.forEach(function (side) {
      cands[id].choices[side].forEach(function (role) {
        if (!roles[side].some(function (r) { return same_(r, role); })) roles[side].push(role);
      });
    });
  });

  const sh = sheet_(TAB.SLOTS);
  const existing = {};
  readSlots_().forEach(function (x) { existing[slotKey_(x.side, x.role, x.start)] = true; });

  const rows = [];
  SIDE_KEYS.forEach(function (side) {
    roles[side].sort().forEach(function (role) {
      dates.forEach(function (d) {
        for (let m = t0.h * 60 + t0.min; m + len <= t1.h * 60 + t1.min; m += len) {
          const start = new Date(d.y, d.m - 1, d.d, Math.floor(m / 60), m % 60);
          if (existing[slotKey_(side, role, start)]) continue;
          rows.push(['', SIDES[side].label, role, new Date(d.y, d.m - 1, d.d), hhmm_(m), hhmm_(m + len), 1, '', '']);
        }
      });
    });
  });
  if (rows.length) sh.getRange(sh.getLastRow() + 1, 1, rows.length, SLOT_H.length).setValues(rows);
  fillSlotIds_();
  SpreadsheetApp.getUi().alert('Added ' + rows.length + ' slots for ' +
    (roles.back.length + roles.front.length) + ' roles. Delete any rows you don\'t need.');
}

/** Quick report of what the script sees in R2A responses. */
function checkCandidates() {
  const cands = readCandidates_();
  const ids = Object.keys(cands);
  const noEmail = ids.filter(function (id) { return !cands[id].email; });
  const noChoices = ids.filter(function (id) { return !cands[id].choices.back.length && !cands[id].choices.front.length; });
  SpreadsheetApp.getUi().alert(
    'Candidates (unique student IDs): ' + ids.length +
    '\nDuplicate submissions merged (latest kept): ' + readCandidates_.dupes +
    '\nMissing email: ' + (noEmail.join(', ') || 'none') +
    '\nNo roles chosen: ' + (noChoices.join(', ') || 'none'));
}

/* ============================ Readers ============================ */

function readCandidates_() {
  const s = getSettings_();
  const src = SpreadsheetApp.openById(String(s.SOURCE_SPREADSHEET_ID).trim()).getSheetByName(String(s.SOURCE_TAB).trim());
  if (!src) throw new Error('Cannot find tab "' + s.SOURCE_TAB + '" in the tracker.');
  const first = Number(s.SOURCE_FIRST_ROW) || 3;
  const n = src.getLastRow() - first + 1;
  const out = {};
  readCandidates_.dupes = 0;
  if (n < 1) return out;
  src.getRange(first, 1, n, 12).getValues().forEach(function (r, i) {
    const id = normId_(r[SRC.ID]);
    if (!id) return;
    const ts = r[SRC.TS] instanceof Date ? r[SRC.TS].getTime() : 0;
    const prev = out[id];
    if (prev) {
      readCandidates_.dupes++;
      if (ts < prev.ts || (ts === prev.ts && i < prev.i)) return;
    }
    const c = { id: id, ts: ts, i: i, email: normEmail_(r[SRC.EMAIL]),
      name: String(r[SRC.NAME]).trim(), nickname: String(r[SRC.NICK]).trim(), choices: {} };
    SIDE_KEYS.forEach(function (side) {
      c.choices[side] = cleanChoices_(SIDES[side].cols.map(function (col) { return r[col]; }));
    });
    out[id] = c;
  });
  return out;
}

function cleanChoices_(list) {
  const out = [];
  list.forEach(function (v) {
    const role = String(v || '').trim();
    if (!role || role.indexOf('ไม่สนใจ') !== -1) return;
    if (out.some(function (x) { return same_(x, role); })) return;
    out.push(role);
  });
  return out;
}

function readResults_() {
  const sh = sheet_(TAB.RESULTS);
  const map = {};
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    sh.getRange(2, 1, n, RES_H.length).getValues().forEach(function (r, i) {
      const side = sideKey_(r[R['Side']]);
      const id = normId_(r[R['Student ID']]);
      if (!side || !id || !String(r[R['Role']]).trim()) return;
      map[key_(id, side, r[R['Role']])] = { row: i + 2, result: String(r[R['Result']]).trim().toLowerCase() };
    });
  }
  return { map: map };
}

function readBookings_() {
  const sh = sheet_(TAB.BOOKINGS);
  const counts = {}, active = {};
  const n = sh.getLastRow() - 1;
  if (n > 0) {
    sh.getRange(2, 1, n, BOOK_H.length).getValues().forEach(function (r) {
      if (String(r[B['Status']]).trim().toLowerCase() === 'cancelled') return;
      const slotId = String(r[B['Slot ID']]).trim();
      const side = sideKey_(r[B['Side']]);
      const id = normId_(r[B['Student ID']]);
      if (!slotId || !side || !id) return;
      counts[slotId] = (counts[slotId] || 0) + 1;
      active[key_(id, side, r[B['Role']])] = {
        role: String(r[B['Role']]), rank: Number(r[B['Choice #']]) || 0,
        start: r[B['Start']] instanceof Date ? r[B['Start']].getTime() : null,
        end: r[B['End']] instanceof Date ? r[B['End']].getTime() : null,
        meet: String(r[B['Meet link']] || '')
      };
    });
  }
  return { counts: counts, active: active };
}

function readSlots_() {
  const sh = sheet_(TAB.SLOTS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const range = sh.getRange(2, 1, n, SLOT_H.length);
  const vals = range.getValues(), disp = range.getDisplayValues();
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = vals[i], d = disp[i];
    const id = String(v[0]).trim(), side = sideKey_(v[1]), role = String(v[2]).trim();
    if (!id || !side || !role) continue;
    const day = dateParts_(v[3], d[3]), a = parseTime_(d[4]), b = parseTime_(d[5]);
    if (!day || !a || !b) continue;
    const start = new Date(day.y, day.m - 1, day.d, a.h, a.min);
    const end = new Date(day.y, day.m - 1, day.d, b.h, b.min);
    if (end <= start) continue;
    out.push({ id: id, side: side, role: role, start: start, end: end,
      capacity: Math.max(1, Number(v[6]) || 1), interviewer: String(v[7] || '').trim(), notes: String(v[8] || '').trim() });
  }
  return out;
}

function slotOpen_(slot, bookings) {
  const hrs = Number(getSettings_().MIN_HOURS_BEFORE);
  const lead = (isNaN(hrs) ? 3 : hrs) * 3600000;
  return slot.start.getTime() > Date.now() + lead && (bookings.counts[slot.id] || 0) < slot.capacity;
}

function fillSlotIds_() {
  const sh = sheet_(TAB.SLOTS);
  const n = sh.getLastRow() - 1;
  if (n < 1) return;
  const vals = sh.getRange(2, 1, n, 3).getValues();
  let max = 0;
  vals.forEach(function (r) { const m = String(r[0]).match(/^S(\d+)$/); if (m) max = Math.max(max, +m[1]); });
  let changed = false;
  vals.forEach(function (r) {
    if (!String(r[0]).trim() && String(r[2]).trim()) { max++; r[0] = 'S' + ('0000' + max).slice(-4); changed = true; }
  });
  if (changed) sh.getRange(2, 1, n, 1).setValues(vals.map(function (r) { return [r[0]]; }));
}

function setInterviewTime_(id, side, role, start) {
  const res = readResults_().map[key_(id, side, role)];
  if (!res) return;
  sheet_(TAB.RESULTS).getRange(res.row, R['Interview time'] + 1)
    .setValue(start ? Utilities.formatDate(start, TZ, 'EEE d MMM HH:mm') : '');
}

/* ===================== Calendar & email ===================== */

function createEvent_(s, cand, side, st, slot) {
  const calId = String(s.CALENDAR_ID || 'primary').trim();
  const title = (s.EVENT_TITLE_PREFIX || 'R2A Interview') + ' – ' + st.role + ' – ' + (cand.nickname || cand.name);
  const desc = [
    'Candidate: ' + cand.name + (cand.nickname ? ' (' + cand.nickname + ')' : ''),
    'Student ID: ' + cand.id,
    'Email: ' + cand.email,
    SIDES[side].label + ' – choice ' + st.rank + ' of ' + st.total + ': ' + st.role,
    'Slot: ' + slot.id + (slot.interviewer ? ' – interviewer: ' + slot.interviewer : '')
  ].join('\n');

  // Preferred: Advanced Calendar service -> automatic Google Meet link
  if (typeof Calendar !== 'undefined') {
    try {
      const ev = Calendar.Events.insert({
        summary: title, description: desc,
        start: { dateTime: iso_(slot.start), timeZone: TZ },
        end: { dateTime: iso_(slot.end), timeZone: TZ },
        conferenceData: { createRequest: { requestId: Utilities.getUuid(), conferenceSolutionKey: { type: 'hangoutsMeet' } } }
      }, calId, { conferenceDataVersion: 1 });
      return { id: ev.id, meet: ev.hangoutLink || String(s.FALLBACK_MEET_LINK || '') };
    } catch (e) {
      console.warn('Advanced Calendar failed, falling back: ' + e);
    }
  }
  const cal = CalendarApp.getCalendarById(calId);
  if (!cal) throw new Error('Calendar not found or no edit access: ' + calId);
  const link = String(s.FALLBACK_MEET_LINK || '');
  const ev = cal.createEvent(title, slot.start, slot.end, {
    description: desc + (link ? '\nMeet: ' + link : ''), location: link
  });
  return { id: ev.getId(), meet: link };
}

function deleteEvent_(s, evId) {
  const calId = String(s.CALENDAR_ID || 'primary').trim();
  try {
    if (typeof Calendar !== 'undefined') {
      Calendar.Events.remove(calId, evId.replace(/@google\.com$/, ''));
      return;
    }
  } catch (e) { console.warn(e); }
  try {
    const ev = CalendarApp.getCalendarById(calId).getEventById(evId);
    if (ev) ev.deleteEvent();
  } catch (e) { console.warn(e); }
}

function sendUnlockEmail_(s, cand, side, st) {
  if (!cand.email) return;
  const url = String(s.WEB_APP_URL || '').trim() || ScriptApp.getService().getUrl();
  const sideTh = SIDES[side].th, sideEn = SIDES[side].label;
  const name = cand.nickname || cand.name;
  const contact = s.CONTACT ? '<p style="color:#646b73">ติดต่อ / Contact: ' + esc_(s.CONTACT) + '</p>' : '';
  const html =
    '<div style="font-family:sans-serif;font-size:15px;line-height:1.6;color:#1f2328">' +
    '<p>สวัสดี ' + esc_(name) + '</p>' +
    '<p>ขอบคุณที่มาสัมภาษณ์ R2A คุณสามารถจองเวลาสัมภาษณ์รอบถัดไปสำหรับงาน' + esc_(sideTh) +
    ' ในตำแหน่ง <b>' + esc_(st.role) + '</b> (อันดับที่ ' + st.rank + ') ได้แล้ว</p>' +
    '<p><a href="' + esc_(url) + '" style="display:inline-block;background:#1f5f4a;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">จองเวลาสัมภาษณ์ / Book your interview</a></p>' +
    '<hr style="border:0;border-top:1px solid #e3e0da">' +
    '<p>Hi ' + esc_(name) + ',</p>' +
    '<p>Thank you for interviewing with R2A. You can now book your next ' + esc_(sideEn.toLowerCase()) +
    ' interview for <b>' + esc_(st.role) + '</b> (choice ' + st.rank + '). Log in with your student ID' +
    (bool_(s.REQUIRE_EMAIL) ? ' and this email address' : '') + '.</p>' + contact + '</div>';
  MailApp.sendEmail({
    to: cand.email,
    subject: '[R2A] จองเวลาสัมภาษณ์รอบถัดไป: ' + st.role + ' / Book your next interview',
    htmlBody: html,
    name: String(s.SENDER_NAME || 'R2A Recruitment')
  });
}

/* ============================ Helpers ============================ */

let settingsCache_ = null;
function getSettings_() {
  if (settingsCache_) return settingsCache_;
  const out = {};
  DEFAULT_SETTINGS.forEach(function (r) { out[r[0]] = r[1]; });
  const sh = SpreadsheetApp.getActive().getSheetByName(TAB.SETTINGS);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(function (r) {
      const k = String(r[0]).trim();
      if (k) out[k] = String(r[1]).trim();
    });
  }
  settingsCache_ = out;
  return out;
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run R2A booking > 1. Set up.');
  return sh;
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** "u6905693", "U6905705", " 6905623 " -> "6905693" etc. */
function normId_(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  return d.length >= 5 ? d : '';
}
function normEmail_(e) { return String(e || '').trim().toLowerCase(); }
function same_(a, b) { return String(a).trim().toLowerCase() === String(b).trim().toLowerCase(); }
function key_(id, side, role) { return id + '|' + side + '|' + String(role).trim().toLowerCase(); }
function slotKey_(side, role, start) { return side + '|' + String(role).trim().toLowerCase() + '|' + start.getTime(); }
function bool_(v) { return v === true || /^(true|yes|y|1)$/i.test(String(v).trim()); }
function hhmm_(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
function iso_(d) { return Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function esc_(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function sideKey_(v) {
  const s = String(v || '').trim().toLowerCase();
  if (s === 'backstage' || s === 'back' || s === 'เบื้องหลัง') return 'back';
  if (s === 'frontstage' || s === 'front' || s === 'เบื้องหน้า') return 'front';
  return '';
}

function dateParts_(value, display) {
  if (value instanceof Date && !isNaN(value)) {
    const p = Utilities.formatDate(value, TZ, 'yyyy-M-d').split('-').map(Number);
    return { y: p[0], m: p[1], d: p[2] };
  }
  const s = String(display || value || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  return null;
}

/** Times are read as displayed text to avoid Sheets' 1899 timezone offset for time-only cells. */
function parseTime_(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(am|pm)?/i);
  if (!m) return null;
  let h = +m[1];
  const min = +m[2], ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return (h > 23 || min > 59) ? null : { h: h, min: min };
}
