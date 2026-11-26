/**
 * Cash Book API (Google Apps Script). The phone screen is hosted separately (GitHub Pages)
 * and calls this web app with POST requests.
 *
 * Bound to a Google Sheet with two tabs (both created by setup()):
 *   Users : Name | PIN | Active (TRUE/FALSE) | Admin (TRUE for admins)
 *   Cash  : Entered At | Date | Type (In/Out) | Amount | Category | Comment | Entered By | ID | Status
 * Balance = sum of In minus sum of Out, ignoring rows whose Status is "Void".
 * Entries are never deleted from the sheet: "removing" one marks it Void, so there is always an audit trail.
 */

var USERS_SHEET = 'Users';
var LOG_SHEET = 'Cash';
var MAX_FAILS = 5;           // wrong PINs allowed per phone before locking it out...
var MAX_FAILS_GLOBAL = 30;   // ...and across all phones together
var LOCKOUT_SECONDS = 600;
var RECENT_COUNT = 15;       // entries shown on the landing page

// Categories offered for each type. Edit freely; the app reads them from here.
var CATEGORIES = {
  In:  ['Catering', 'In-store', 'Other'],
  Out: ['Cash out', 'Pay salary', 'Catering', 'Other']
};

// Cash column numbers
var C = { AT: 1, DATE: 2, TYPE: 3, AMOUNT: 4, CATEGORY: 5, COMMENT: 6, BY: 7, ID: 8, STATUS: 9 };
var HEADERS = ['Entered At', 'Date', 'Type', 'Amount', 'Category', 'Comment', 'Entered By', 'ID', 'Status'];
var USER_HEADERS = ['Name', 'PIN', 'Active', 'Admin'];

/**
 * Run once from the Apps Script editor (select "setup" > Run) on a blank Sheet.
 * Safe to run again. To add people, type a row in the Users tab: Name | PIN | TRUE | (TRUE for admin).
 * PINs must be unique, 4 to 8 digits.
 */
function setup() {
  var ss = SpreadsheetApp.getActive();

  var users = ss.getSheetByName(USERS_SHEET) || ss.insertSheet(USERS_SHEET);
  if (users.getLastRow() === 0) {
    users.appendRow(USER_HEADERS);
    users.setFrozenRows(1);
  }
  users.getRange(1, 1, 1, USER_HEADERS.length).setValues([USER_HEADERS]);
  users.getRange('B:B').setNumberFormat('@'); // keep leading zeros in PINs
  styleHeader_(users.getRange(1, 1, 1, USER_HEADERS.length));

  var log = logSheet_();
  log.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);

  var blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0) ss.deleteSheet(blank);
}

function styleHeader_(range) {
  range.setBackground('#0f6b4f').setFontColor('#ffffff').setFontWeight('bold');
}

function doGet() {
  return ContentService.createTextOutput('Cash Book API is running.');
}

/**
 * Body (JSON sent as text/plain): { action, pin, deviceId, ... }
 *   login : pin                                   -> { name, admin, categories, summary, recent }
 *   save  : date, type, amount, category, comment -> { summary, recent }
 *   void  : id                                    -> { summary, recent }
 */
function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    var user = authenticate_(req.pin, String(req.deviceId || '').slice(0, 64));

    if (req.action === 'login') {
      var data = state_();
      data.name = user.name;
      data.admin = user.admin;
      data.categories = CATEGORIES;
      return json_({ ok: true, data: data });
    } else if (req.action === 'save') {
      save_(user, req);
      return json_({ ok: true, data: state_() });
    } else if (req.action === 'void') {
      void_(user, req);
      return json_({ ok: true, data: state_() });
    }
    throw new Error('Unknown action.');
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Appends one entry. Amount must be a positive number; category must belong to the chosen type. */
function save_(user, req) {
  var date = checkDate_(req.date);
  var type = req.type === 'In' ? 'In' : req.type === 'Out' ? 'Out' : '';
  if (!type) throw new Error('Choose Cash In or Cash Out.');

  var amount = Number(req.amount);
  if (!isFinite(amount) || amount <= 0) throw new Error('Enter an amount greater than zero.');
  if (amount > 10000000) throw new Error('That amount looks too large.');
  amount = Math.round(amount * 100) / 100;

  var category = String(req.category || '');
  if (CATEGORIES[type].indexOf(category) < 0) throw new Error('Choose a category.');

  var comment = String(req.comment || '').replace(/\s+/g, ' ').trim().slice(0, 300);

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = logSheet_();
    sheet.appendRow([new Date(), date, type, amount, category, comment, user.name, Utilities.getUuid(), '']);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

/** Marks an entry Void. The person who entered it, or any admin, may do this. */
function void_(user, req) {
  var id = String(req.id || '');
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = logSheet_();
    var rows = sheet.getDataRange().getDisplayValues();
    for (var i = rows.length - 1; i >= 1; i--) {
      if (rows[i][C.ID - 1] !== id) continue;
      if (rows[i][C.STATUS - 1] === 'Void') throw new Error('That entry is already removed.');
      if (!user.admin && rows[i][C.BY - 1] !== user.name) throw new Error('Only the person who entered it, or an admin, can remove it.');
      sheet.getRange(i + 1, C.STATUS).setValue('Void');
      SpreadsheetApp.flush();
      return;
    }
    throw new Error('Entry not found.');
  } finally {
    lock.releaseLock();
  }
}

/** Balance, this month's totals and the latest entries (newest first). */
function state_() {
  var rows = logSheet_().getDataRange().getValues();
  var tz = Session.getScriptTimeZone();
  var month = Utilities.formatDate(new Date(), tz, 'yyyy-MM');
  var s = { balance: 0, monthIn: 0, monthOut: 0 };
  var recent = [];

  for (var i = rows.length - 1; i >= 1; i--) {
    var r = rows[i];
    if (!r[C.ID - 1]) continue;
    var voided = r[C.STATUS - 1] === 'Void';
    var amt = Number(r[C.AMOUNT - 1]) || 0;
    var isIn = r[C.TYPE - 1] === 'In';
    var date = dateText_(r[C.DATE - 1], tz);

    if (!voided) {
      s.balance += isIn ? amt : -amt;
      if (date.slice(0, 7) === month) { if (isIn) s.monthIn += amt; else s.monthOut += amt; }
    }
    if (recent.length < RECENT_COUNT) {
      recent.push({
        id: r[C.ID - 1], date: date, type: isIn ? 'In' : 'Out', amount: amt, category: r[C.CATEGORY - 1],
        comment: String(r[C.COMMENT - 1]), by: r[C.BY - 1], voided: voided
      });
    }
  }
  s.balance = round2_(s.balance); s.monthIn = round2_(s.monthIn); s.monthOut = round2_(s.monthOut);
  return { summary: s, recent: recent };
}

// ---------- helpers ----------

/** Checks the PIN against active users. Wrong PINs are counted per phone and overall. */
function authenticate_(pin, deviceId) {
  pin = String(pin || '').trim();
  var keys = [['fails_d_' + deviceId, MAX_FAILS], ['fails_all', MAX_FAILS_GLOBAL]];
  checkLockout_(keys);

  var rows = SpreadsheetApp.getActive().getSheetByName(USERS_SHEET).getDataRange().getDisplayValues();
  for (var i = 1; i < rows.length; i++) {
    var active = String(rows[i][2]).toUpperCase() !== 'FALSE';
    var rowPin = String(rows[i][1]).trim();
    if (pin && active && rowPin && rowPin === pin) {
      clearFails_([keys[0]]);
      return { name: String(rows[i][0]).trim(), admin: String(rows[i][3]).trim().toUpperCase() === 'TRUE' };
    }
  }
  recordFail_(keys);
  throw new Error('Incorrect PIN.');
}

// Lockout counters live in the script cache. keys is a list of [cacheKey, maxFails].
function checkLockout_(keys) {
  var cache = CacheService.getScriptCache();
  keys.forEach(function (k) {
    if (Number(cache.get(k[0]) || 0) >= k[1]) throw new Error('Too many wrong attempts. Try again in a few minutes.');
  });
}

function recordFail_(keys) {
  var cache = CacheService.getScriptCache();
  keys.forEach(function (k) {
    cache.put(k[0], String(Number(cache.get(k[0]) || 0) + 1), LOCKOUT_SECONDS);
  });
}

function clearFails_(keys) {
  CacheService.getScriptCache().removeAll(keys.map(function (k) { return k[0]; }));
}

function logSheet_() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(LOG_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
    sheet.getRange('A:A').setNumberFormat('yyyy-mm-dd hh:mm');
    sheet.getRange('B:C').setNumberFormat('@'); // date and type stay plain text
    sheet.getRange('D:D').setNumberFormat('#,##0.00');
    sheet.getRange('E:F').setNumberFormat('@'); // plain text, so a comment like "=1+1" is never a formula
    styleHeader_(sheet.getRange(1, 1, 1, HEADERS.length));
  }
  return sheet;
}

/** Returns the date if it is a real yyyy-MM-dd date; otherwise throws. */
function checkDate_(date) {
  date = String(date || '');
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error('Pick a valid date.');
  var d = new Date(+m[1], +m[2] - 1, +m[3], 12);
  if (d.getMonth() !== +m[2] - 1) throw new Error('Pick a valid date.');
  return date;
}

// Sheets may turn a typed date into a Date object; always hand the app yyyy-MM-dd.
function dateText_(v, tz) {
  return v instanceof Date ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : String(v);
}

function round2_(n) { return Math.round(n * 100) / 100; }
