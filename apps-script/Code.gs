/**
 * Venya diabetes log — API over a Google Spreadsheet.
 *
 * One file, bound to the spreadsheet (Extensions -> Apps Script). Each
 * environment (dev / prod) is a separate copy of the spreadsheet with its own
 * copy of this script, so no spreadsheet id is ever configured: getActive().
 *
 * Entry points:
 *   setupSheets()   build / normalise sheets, formats, validation, colours
 *   renameSheets()  migrate old sheet names to the current ones
 *   migrate()       parse the "(Архів)" sheets into the new structure
 *   showKeys()      print (and create) the access keys
 *   doGet / doPost  the API itself
 *
 * UI strings (sheet names, headers, menu, validation help) are Ukrainian
 * because they are what the user sees. Everything else — comments, errors,
 * logs — is English.
 */

/* ───────────────────────────── Config ───────────────────────────── */

var TZ_NAME = 'Europe/Kyiv';

var S = {
  journal:  'Журнал',
  urine:    'Сеча (лоток)',
  day:      'Сеча і стул за добу',
  meds:     'Прийоми ліків',
  regimens: 'Курси ліків'
};

/* Old name -> current name. Used by renameSheets(). */
var RENAMES = {
  'Сеча':          S.urine,
  'Доба':          S.day,
  'Ліки':          S.meds,
  'Призначення':   S.regimens
};

var ARCHIVE = {
  journal: 'Журнал глюкози (Архів)',
  urine:   'Сеча і стул (Архів)'
};

/* Column with a coloured bullet standing in for the glucose band. */
var DOT_HEAD = '●';
var DOT_CHAR = '●';

/* Header order matters only when a sheet or column is first created; from then
   on columns are located by header name, so they can be moved or added to. */
var HEAD = {
  journal:  ['Дата','Час',DOT_HEAD,'Глюкоза','Інсулін, ОД','Корм','Нотатка','Коментар лікаря','id'],
  urine:    ['Дата','Час','Мл','Нотатка','id'],
  day:      ['Дата','Стул','Бал','Нотатка','Сеча за добу, мл','Змін лотка','id'],
  meds:     ['Дата','Час','Препарат','Кількість','Нотатка','Призначення id','id'],
  /* Ані кількості за раз, ані «разів на день»: доза коригується по ходу, а
     тривалість курсу не фіксована. Що реально дали — видно з прийомів, схема
     й уточнення — вільним текстом у нотатці. */
  regimens: ['id','Препарат','З дати','По дату','Нотатка']
};

/* Columns the script never writes: formulas, and what belongs to people. */
var READONLY_COLS = ['Сеча за добу, мл','Змін лотка','Коментар лікаря',DOT_HEAD];

/* Stool categories for the dropdown. The Purina score lives in its own column. */
var STOOL = ['не какав','сухий','нормальний',"м'який",'рідкий'];

/* Glucose bands — same convention as the app (BANDS in the prototype).
   First matching rule wins, hence the "less than" thresholds. */
var BANDS = [
  {lt: 3,  color: '#B3252F', name: 'дуже низько'},
  {lt: 5,  color: '#E0504F', name: 'низько'},
  {lt: 15, color: '#A3C585', name: 'ціль'},
  {lt: 20, color: '#E8C05A', name: 'високо'}
];
var BAND_HIGH = {color: '#E0873C', name: 'дуже високо'};

var FONT = 'Roboto';
var FONT_SIZE = 10;
var DOT_SIZE = 12;

var TAB_WORK    = '#A3C585';
var TAB_TALK    = '#5AA9E6';
var TAB_ARCHIVE = '#9A9EA6';

var ROW_TINT = '#F7F9F6';   /* alternating day banding */
var DATE_DIM = '#C8CCD0';   /* repeated date, dimmed */

/* Кеш на боці скрипта. Будь-який запис піднімає DATA_VERSION і робить старий
   ключ недосяжним, тому довгий строк безпечний, а повторні відкриття (зокрема
   лікаркою) обходяться без повного читання аркушів. */
/**
 * Посилання для розділу «Ще». Живуть тут, а не в config.js: репозиторій
 * публічний, а таблиця відкрита на редагування за посиланням — тож її адресу
 * має бачити лише той, хто пред'явив ключ.
 *
 * sheet лишаємо порожнім навмисно: адреса береться з тієї таблиці, до якої
 * прив'язаний цей скрипт. Тому в DEV вона вказує на копію, а в PROD — на
 * робочу таблицю, і при переїзді міняти тут нічого не треба.
 */
var LINKS = {
  sheet:  '',
  notion: 'https://venya-vet-info.notion.site/3c50f408258280aaaa26f2be539dbf0d'
};

/** Адреса таблиці для перегляду. getUrl() дає .../edit, а форма /preview
 *  відкриває лише для читання і не просить входити в акаунт. */
function sheetLink_() {
  if (LINKS.sheet) return LINKS.sheet;
  return ss_().getUrl().split('/edit')[0] + '/preview';
}

var CACHE_SEC = 300;

/**
 * Bump this whenever the shape of a doGet response changes.
 *
 * The response cache is keyed by the data version, which only moves when the
 * sheet is written to — so pasting new code into the editor did not invalidate
 * anything. For five minutes after every redeploy the old code's payloads kept
 * being served, and the app behaved exactly as it had before the fix. That is
 * the worst possible way to lose faith in a fix: it looks like it did not work.
 */
var CODE_VERSION = 4;

/**
 * Weight used to turn millilitres per day into ml/kg/h.
 *
 * A script property, not a sheet column, on purpose. It is not a measurement:
 * the cat is weighed now and then on kitchen scales nobody trusts, and a column
 * per day would turn one rough number into a trail of data that has to be kept
 * up and, if it ever turns out wrong, corrected backwards. This is a multiplier
 * in a formula — one value, changed in two taps from the app, the same on every
 * device and for the vet.
 */
var WEIGHT_PROP = 'WEIGHT', WEIGHT_DEFAULT = 5;

function weight_() {
  var v = parseFloat(PropertiesService.getScriptProperties().getProperty(WEIGHT_PROP));
  return (v > 0 && v < 30) ? v : WEIGHT_DEFAULT;
}

function setWeight_(v) {
  var n = parseFloat(v);
  if (!(n > 0 && n < 30)) throw new Error('weight out of range: ' + v);
  PropertiesService.getScriptProperties().setProperty(WEIGHT_PROP, String(n));
  return n;
}
var DEFAULT_DAYS = 14;
/* Aggregation is opt-in via &agg=1. It used to switch on by itself past a
   threshold, which silently emptied the journal: the views cannot render
   daily summaries, so a long period looked like "no data". */

/* ──────────────────────────── Small helpers ──────────────────────────── */

/**
 * Spreadsheet handle and time zone, both remembered for the length of one
 * execution.
 *
 * This is where a read used to spend most of its time. tz_() is called from
 * iso_() and hhmm_(), i.e. once per date cell and once per time cell — well
 * over a thousand times on a 30-day window — and every one of them was a real
 * property read on the spreadsheet, a few milliseconds each across the
 * JavaScript-to-Java bridge. Seconds of a request went into asking the same
 * spreadsheet what time zone it is in.
 *
 * Each execution gets a fresh global scope, so caching here cannot go stale
 * between requests. setupSheets() clears it after changing the zone.
 */
var SS_CACHE = null, TZ_CACHE = '';
function ss_() { return SS_CACHE || (SS_CACHE = SpreadsheetApp.getActive()); }
function tz_()  { return TZ_CACHE || (TZ_CACHE = ss_().getSpreadsheetTimeZone() || TZ_NAME); }

/**
 * Date -> 'yyyy-MM-dd', remembered by timestamp.
 *
 * Utilities.formatDate is a service call too, and a day holds ten or more
 * rows, so the same handful of dates was being formatted hundreds of times.
 */
var DAY_CACHE = {}, MIN_CACHE = {};
function isoOf_(d) {
  var k = d.getTime();
  return DAY_CACHE[k] || (DAY_CACHE[k] = Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'));
}
function hhmmOf_(d) {
  var k = d.getTime();
  return MIN_CACHE[k] || (MIN_CACHE[k] = Utilities.formatDate(d, tz_(), 'HH:mm'));
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

function uid_(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
}

/**
 * Argument separator for formulas. Apps Script is documented to take commas,
 * but on some locales that lands in the cell as #ERROR!, so we probe once and
 * remember the answer.
 */
function argSep_() {
  var props = PropertiesService.getScriptProperties();
  var known = props.getProperty('ARG_SEP');
  if (known) return known;

  var sh = ss_().getSheets()[0];
  var probe = sh.getRange(sh.getMaxRows(), sh.getMaxColumns());
  var sep = ',';
  try {
    probe.setFormula('=SUM(1,2)');
    SpreadsheetApp.flush();
    if (String(probe.getDisplayValue()).indexOf('3') !== 0) sep = ';';
  } catch (err) {
    sep = ';';
  }
  probe.clearContent();
  props.setProperty('ARG_SEP', sep);
  return sep;
}

/** Build a formula written with commas using the locale's separator. */
function f_(formulaWithCommas) {
  var sep = argSep_();
  return sep === ',' ? formulaWithCommas : formulaWithCommas.split(',').join(sep);
}

/** Sheet plus a "header name -> column number" map. */
function table_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Run setupSheets() first.');
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  return withHead_(sh, name, head, lastCol, null);
}

/**
 * Same table, but header and body fetched in a single getDataRange() call.
 *
 * What costs on this platform is the number of round-trips to the spreadsheet,
 * not the number of rows: each one is roughly half a second regardless. The
 * read path used to spend four per sheet — getLastColumn, the header row,
 * getLastRow, the body — times five sheets. getDataRange() is one call that
 * brings back everything, so the same read costs five round-trips instead of
 * twenty. Writes keep using table_(): there a full read would be waste.
 */
function readTable_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" is missing. Run setupSheets() first.');
  var all = sh.getDataRange().getValues();
  var head = all.length ? all[0] : [];
  return withHead_(sh, name, head, Math.max(head.length, 1), all.slice(1));
}

function withHead_(sh, name, head, lastCol, rows) {
  var col = {};
  for (var i = 0; i < head.length; i++) {
    var h = String(head[i]).trim();
    if (h) col[h] = i + 1;
  }
  return {sh: sh, name: name, head: head, col: col, lastCol: lastCol, rows: rows};
}

/**
 * Earliest date of a row that actually carries something, ISO, or ''.
 *
 * This is what tells the app whether "show 30 more days" still has anything to
 * show. Guessing it on the client — "the oldest row we got sits exactly on the
 * window edge, so there is probably more" — cannot distinguish "more data" from
 * "the data happens to start here", and left the button hanging forever.
 *
 * "Carries something" has to be checked, not assumed: the day sheet holds a row
 * per calendar date with formulas in it, so by date alone it reaches back
 * further than any stool entry does — and the button promised records that
 * would never appear. A row counts only when one of `cols` is filled.
 */
function firstDate_(t, cols) {
  var c = t.col['Дата'];
  if (!c || !t.rows) return '';
  var want = [];
  for (var k = 0; k < (cols || []).length; k++) {
    if (t.col[cols[k]]) want.push(t.col[cols[k]] - 1);
  }
  /* Дати порівнюємо як числа і форматуємо одну-єдину, а не кожну: тут
     проходить увесь аркуш, і форматування рядок за рядком коштувало б більше,
     ніж саме читання. */
  var best = '', bestT = null;
  for (var i = 0; i < t.rows.length; i++) {
    var row = t.rows[i], filled = !want.length;
    for (var j = 0; j < want.length && !filled; j++) {
      var cell = row[want[j]];
      if (cell !== '' && cell !== null && cell !== undefined) filled = true;
    }
    if (!filled) continue;
    var v = row[c - 1];
    if (v instanceof Date && !isNaN(v)) {
      var ms = v.getTime();
      if (bestT === null || ms < bestT) bestT = ms;
    } else if (v !== '' && v !== null && v !== undefined) {
      var d0 = iso_(v, v);
      if (d0 && (!best || d0 < best)) best = d0;
    }
  }
  if (bestT !== null) {
    var iso = isoOf_(new Date(bestT));
    if (!best || iso < best) best = iso;
  }
  return best;
}

/** Values and display values in one pass, header row excluded. */
function body_(t) {
  return bodyFrom_(t, null);
}

/**
 * Same, but dropping everything before fromIso.
 *
 * The window is cut in memory, not by reading a narrower range. Reading the
 * date column first to locate the tail sounds cheaper but is not: what costs
 * here is the number of round-trips to the sheet, not the number of rows, and
 * that approach added two extra reads per sheet to save one. Measured on real
 * data it made a 30-day request almost twice as slow.
 */
function bodyFrom_(t, fromIso) {
  var last = t.rows ? t.rows.length + 1 : t.sh.getLastRow();
  if (last < 2) return {values: [], display: [], first: 2};

  /* One read, not two. getValues() already gives everything we need: dates as
     Date objects, times as strings (the column is plain-text formatted), "Hi"
     as a string, numbers as numbers. getDisplayValues() was a second
     round-trip per sheet for nothing — and round-trips are what costs here. */
  var vals = t.rows || t.sh.getRange(2, 1, last - 1, t.lastCol).getValues();
  var disp = vals;
  if (!fromIso || !t.col['Дата']) return {values: vals, display: disp, first: 2};

  var c = t.col['Дата'] - 1, seen = '', start = vals.length;
  for (var i = 0; i < vals.length; i++) {
    var d = iso_(vals[i][c], disp[i][c]);
    if (d) seen = d;
    if (seen && seen >= fromIso) { start = i; break; }
  }
  return {values: vals.slice(start), display: disp.slice(start), first: 2 + start};
}

/** Cell date -> ISO yyyy-MM-dd, empty string when blank. */
function iso_(value, shown, fallbackYear) {
  if (value instanceof Date && !isNaN(value)) return isoOf_(value);
  var s = String(shown == null ? value : shown).trim();
  if (!s) return '';
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  m = s.match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?$/);
  if (m) {
    var d = +m[1], mo = +m[2];
    var y = m[3] ? +m[3] : (fallbackYear || new Date().getFullYear());
    if (y < 100) y += 2000;
    return y + '-' + pad2_(mo) + '-' + pad2_(d);
  }
  return '';
}

/**
 * ISO -> Date for writing into a cell. Exactly midnight: anything else and
 * SUMIF by date stops matching rows that were typed in by hand.
 */
function dateOf_(isoStr) {
  if (!isoStr) return '';
  var p = String(isoStr).split('-');
  return new Date(+p[0], +p[1] - 1, +p[2]);
}

/** Cell time -> 'HH:mm'. Sheets hands back times as dates in 1899. */
function hhmm_(value, shown) {
  if (value instanceof Date && !isNaN(value)) return hhmmOf_(value);
  var s = String(shown == null ? value : shown).trim();
  var m = s.match(/^(\d{1,2})[:.](\d{2})/);
  return m ? pad2_(+m[1]) + ':' + m[2] : '';
}

/** Cell number. Blank -> null, never 0: blank is not zero. */
function num_(value, shown) {
  if (typeof value === 'number') return value;
  var s = String(shown == null ? value : shown).trim().replace(',', '.');
  if (!s) return null;
  var n = parseFloat(s);
  return isNaN(n) ? null : n;
}

/** Glucose: a number, or Hi (text "Hi", ">33" and friends). */
function glu_(value, shown) {
  var s = String(shown == null ? value : shown).trim();
  if (!s) return {glucose: null, hi: false};
  if (/^hi$/i.test(s) || /^>\s*\d/.test(s)) return {glucose: null, hi: true};
  return {glucose: num_(value, shown), hi: false};
}

function today_() {
  return Utilities.formatDate(new Date(), tz_(), 'yyyy-MM-dd');
}

function shiftDays_(isoStr, delta) {
  var d = dateOf_(isoStr);
  d.setDate(d.getDate() + delta);
  return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd');
}

function colLetter_(n) {
  var s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - 1 - r) / 26; }
  return s;
}

/* ──────────────────────────── Access keys ──────────────────────────── */

/**
 * Prints the access keys, creating them on first call.
 * Run once from the editor and read the execution log.
 */
function showKeys() {
  var props = PropertiesService.getScriptProperties();
  var edit = props.getProperty('KEY_EDIT');
  var view = props.getProperty('KEY_VIEW');
  if (!edit) { edit = 'e' + Utilities.getUuid().replace(/-/g, '').slice(0, 22); props.setProperty('KEY_EDIT', edit); }
  if (!view) { view = 'v' + Utilities.getUuid().replace(/-/g, '').slice(0, 22); props.setProperty('KEY_VIEW', view); }
  Logger.log('KEY_EDIT (write) : ' + edit);
  Logger.log('KEY_VIEW (read)  : ' + view);
  return {edit: edit, view: view};
}

/** 'edit' | 'view' | null */
function roleOf_(key) {
  if (!key) return null;
  var props = PropertiesService.getScriptProperties();
  if (key === props.getProperty('KEY_EDIT')) return 'edit';
  if (key === props.getProperty('KEY_VIEW')) return 'view';
  return null;
}

/* ─────────────────────────── Building sheets ─────────────────────────── */

/** Applies RENAMES so an already-populated spreadsheet keeps its data. */
function renameSheets() {
  var ss = ss_(), done = [];
  Object.keys(RENAMES).forEach(function (from) {
    var to = RENAMES[from];
    var sh = ss.getSheetByName(from);
    if (sh && !ss.getSheetByName(to)) { sh.setName(to); done.push(from + ' -> ' + to); }
  });
  Logger.log(done.length ? done.join('\n') : 'nothing to rename');
  return done;
}

/**
 * Idempotent: creates missing sheets, inserts missing columns in their proper
 * place, applies formats, validation and colours. Never touches existing data.
 */
function setupSheets() {
  var ss = ss_();
  if (ss.getSpreadsheetTimeZone() !== TZ_NAME) {
    ss.setSpreadsheetTimeZone(TZ_NAME);
    TZ_CACHE = ''; DAY_CACHE = {}; MIN_CACHE = {};
  }
  checkTimeZone_();
  renameSheets();

  Object.keys(S).forEach(function (k) { ensureSheet_(S[k], HEAD[k]); });

  checkHeaders_();
  formatJournal_();
  formatUrine_();
  formatDay_();
  formatMeds_();
  formatRegimens_();
  paintTabs_();

  SpreadsheetApp.flush();
  return 'Аркуші готові.';
}

/**
 * The spreadsheet timezone and the script project timezone must match or dates
 * drift by a day. The project one lives in Project Settings -> Time zone.
 */
function checkTimeZone_() {
  var script = Session.getScriptTimeZone();
  var sheet = ss_().getSpreadsheetTimeZone();
  if (script !== sheet) {
    Logger.log('WARNING: script timezone (' + script + ') differs from spreadsheet timezone (' +
               sheet + '). Fix it in Project Settings -> Time zone.');
  }
}

function ensureSheet_(name, headers) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
  } else {
    /* Insert any missing header next to the one that precedes it in HEAD,
       so a column added later still lands where it belongs. */
    for (var i = 0; i < headers.length; i++) {
      var have = headerMap_(sh);
      if (have[headers[i]]) continue;
      var at = 1;
      for (var j = i - 1; j >= 0; j--) {
        if (have[headers[j]]) { at = have[headers[j]] + 1; break; }
      }
      if (at > sh.getLastColumn()) {
        sh.getRange(1, at).setValue(headers[i]);
      } else {
        sh.insertColumnBefore(at);
        sh.getRange(1, at).setValue(headers[i]);
      }
    }
  }
  sh.setFrozenRows(1);
  var wide = Math.max(sh.getLastColumn(), 1);
  sh.getRange(1, 1, sh.getMaxRows(), wide).setFontFamily(FONT).setFontSize(FONT_SIZE);
  sh.getRange(1, 1, 1, wide)
    .setFontWeight('bold').setBackground('#F1F3F4').setVerticalAlignment('middle');
  return sh;
}

/**
 * Renaming a header silently detaches its column: lookups are by name, so the
 * data stays in the sheet but stops being seen, and the next setupSheets adds
 * a fresh empty column beside it. Cheap to warn about, expensive to debug.
 */
function checkHeaders_() {
  Object.keys(S).forEach(function (k) {
    var sh = ss_().getSheetByName(S[k]);
    if (!sh) return;
    var have = headerMap_(sh);
    var want = HEAD[k];
    var missing = want.filter(function (h) { return !have[h]; });
    var extra = Object.keys(have).filter(function (h) { return want.indexOf(h) === -1; });
    if (missing.length) Logger.log('WARNING: "' + S[k] + '" is missing columns: ' + missing.join(', '));
    if (extra.length)   Logger.log('note: "' + S[k] + '" has extra columns: ' + extra.join(', '));
  });
}

function headerMap_(sh) {
  var lastCol = Math.max(sh.getLastColumn(), 1);
  var head = sh.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var map = {};
  for (var i = 0; i < head.length; i++) {
    var h = String(head[i]).trim();
    if (h) map[h] = i + 1;
  }
  return map;
}

/** Date as a real date shown as dd.MM; time as plain text; id hidden. */
function baseColumnFormats_(t) {
  var maxRows = t.sh.getMaxRows() - 1;
  if (maxRows < 1) return;
  if (t.col['Дата']) t.sh.getRange(2, t.col['Дата'], maxRows, 1).setNumberFormat('dd.MM');
  if (t.col['Час'])  t.sh.getRange(2, t.col['Час'],  maxRows, 1).setNumberFormat('@');
  if (t.col['id']) {
    t.sh.getRange(2, t.col['id'], maxRows, 1).setNumberFormat('@');
    t.sh.hideColumns(t.col['id']);
  }
}

/** Dimmed repeated dates plus a light band on every other calendar day. */
function dateStripeRules_(t, rules) {
  if (!t.col['Дата']) return;
  var a = colLetter_(t.col['Дата']);
  var maxRows = t.sh.getMaxRows() - 1;

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(f_('=AND($' + a + '2<>"",$' + a + '2=$' + a + '1)'))
    .setFontColor(DATE_DIM)
    .setRanges([t.sh.getRange(2, t.col['Дата'], maxRows, 1)]).build());

  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied(f_('=AND($' + a + '2<>"",ISEVEN(DAY($' + a + '2)))'))
    .setBackground(ROW_TINT)
    .setRanges([t.sh.getRange(2, 1, maxRows, t.lastCol)]).build());
}

/** The bullet is a formula so hand-added rows light up too. */
function dotFormula_(gluLetter, row) {
  return f_('=IF(' + gluLetter + row + '="","","' + DOT_CHAR + '")');
}

function formatJournal_() {
  var t = table_(S.journal);
  baseColumnFormats_(t);
  var maxRows = t.sh.getMaxRows() - 1;
  var rules = [];

  if (t.col[DOT_HEAD] && t.col['Глюкоза']) {
    var g = colLetter_(t.col['Глюкоза']);
    var dot = t.sh.getRange(2, t.col[DOT_HEAD], maxRows, 1);
    dot.setHorizontalAlignment('center').setFontSize(DOT_SIZE);
    t.sh.setColumnWidth(t.col[DOT_HEAD], 30);

    var lastRow = t.sh.getLastRow();
    if (lastRow > 1) {
      var formulas = [];
      for (var r = 2; r <= lastRow; r++) formulas.push([dotFormula_(g, r)]);
      t.sh.getRange(2, t.col[DOT_HEAD], formulas.length, 1).setFormulas(formulas);
    }

    BANDS.forEach(function (b) {
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenFormulaSatisfied(f_('=AND(ISNUMBER($' + g + '2),$' + g + '2<' + b.lt + ')'))
        .setFontColor(b.color).setRanges([dot]).build());
    });
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(f_('=AND(ISNUMBER($' + g + '2),$' + g + '2>=' + BANDS[BANDS.length - 1].lt + ')'))
      .setFontColor(BAND_HIGH.color).setRanges([dot]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(f_('=REGEXMATCH(UPPER(TO_TEXT($' + g + '2)),"^(HI|>)")'))
      .setFontColor(BAND_HIGH.color).setRanges([dot]).build());
  }

  if (t.col['Глюкоза']) {
    t.sh.getRange(2, t.col['Глюкоза'], maxRows, 1)
      .setHorizontalAlignment('center').setFontWeight('bold');
  }
  if (t.col['Інсулін, ОД']) {
    t.sh.getRange(2, t.col['Інсулін, ОД'], maxRows, 1)
      .setNumberFormat('0.##" ОД"').setHorizontalAlignment('center').setFontColor('#1B6FA8');
  }
  dateStripeRules_(t, rules);
  t.sh.setConditionalFormatRules(rules);

  setWidths_(t, {'Дата': 62, 'Час': 56, 'Глюкоза': 74, 'Інсулін, ОД': 84,
                 'Корм': 260, 'Нотатка': 420, 'Коментар лікаря': 300});
}

function formatUrine_() {
  var t = table_(S.urine);
  baseColumnFormats_(t);
  var maxRows = t.sh.getMaxRows() - 1;
  var rules = [];
  if (t.col['Мл']) t.sh.getRange(2, t.col['Мл'], maxRows, 1)
    .setNumberFormat('0" мл"').setHorizontalAlignment('center');
  dateStripeRules_(t, rules);
  t.sh.setConditionalFormatRules(rules);
  setWidths_(t, {'Дата': 62, 'Час': 56, 'Мл': 64, 'Нотатка': 420});
}

function formatDay_() {
  var t = table_(S.day);
  baseColumnFormats_(t);
  var maxRows = t.sh.getMaxRows() - 1;

  if (t.col['Стул']) {
    t.sh.getRange(2, t.col['Стул'], maxRows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInList(STOOL, true)
        .setAllowInvalid(true)
        .setHelpText('Категорія для чіпа. Деталі — в «Нотатку», бал Purina — в «Бал».')
        .build());
  }
  if (t.col['Бал']) {
    t.sh.getRange(2, t.col['Бал'], maxRows, 1)
      .setNumberFormat('0').setHorizontalAlignment('center')
      .setDataValidation(SpreadsheetApp.newDataValidation()
        .requireNumberBetween(1, 7).setAllowInvalid(true)
        .setHelpText('Шкала Purina 1–7. Можна не заповнювати.').build());
  }
  if (t.col['Сеча за добу, мл']) t.sh.getRange(2, t.col['Сеча за добу, мл'], maxRows, 1)
    .setNumberFormat('0" мл"').setHorizontalAlignment('center').setFontColor('#6B7078');
  if (t.col['Змін лотка']) t.sh.getRange(2, t.col['Змін лотка'], maxRows, 1)
    .setNumberFormat('0').setHorizontalAlignment('center').setFontColor('#6B7078');

  var rules = [];
  dateStripeRules_(t, rules);
  t.sh.setConditionalFormatRules(rules);
  setWidths_(t, {'Дата': 74, 'Стул': 112, 'Бал': 48, 'Нотатка': 420,
                 'Сеча за добу, мл': 104, 'Змін лотка': 84});
}

function formatMeds_() {
  var t = table_(S.meds);
  baseColumnFormats_(t);
  var maxRows = t.sh.getMaxRows() - 1;

  if (t.col['Препарат']) {
    var regSh = ss_().getSheetByName(S.regimens);
    var regT = table_(S.regimens);
    var src = regSh.getRange(2, regT.col['Препарат'] || 2, Math.max(regSh.getMaxRows() - 1, 1), 1);
    t.sh.getRange(2, t.col['Препарат'], maxRows, 1).setDataValidation(
      SpreadsheetApp.newDataValidation().requireValueInRange(src, true)
        .setAllowInvalid(true)
        .setHelpText('Назви беруться з аркуша «' + S.regimens + '».').build());
  }
  if (t.col['Призначення id']) {
    t.sh.getRange(2, t.col['Призначення id'], maxRows, 1).setNumberFormat('0');
    t.sh.hideColumns(t.col['Призначення id']);
  }
  var rules = [];
  dateStripeRules_(t, rules);
  t.sh.setConditionalFormatRules(rules);
  setWidths_(t, {'Дата': 62, 'Час': 56, 'Препарат': 170, 'Кількість': 112, 'Нотатка': 380});
}

function formatRegimens_() {
  var t = table_(S.regimens);
  var maxRows = t.sh.getMaxRows() - 1;
  ['З дати', 'По дату'].forEach(function (h) {
    if (t.col[h]) t.sh.getRange(2, t.col[h], maxRows, 1).setNumberFormat('dd.MM.yyyy');
  });
  if (t.col['id']) t.sh.getRange(2, t.col['id'], maxRows, 1).setNumberFormat('0');

  var rules = [];
  if (t.col['По дату'] && t.col['Препарат']) {
    var c = colLetter_(t.col['По дату']);
    var n = colLetter_(t.col['Препарат']);
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied(f_('=AND($' + n + '2<>"",$' + c + '2="")'))
      .setBackground('#EEF5E7')
      .setRanges([t.sh.getRange(2, 1, maxRows, t.lastCol)]).build());
  }
  t.sh.setConditionalFormatRules(rules);
  setWidths_(t, {'id': 50, 'Препарат': 190, 'З дати': 92, 'По дату': 92,
                 'Нотатка': 420});
}

function setWidths_(t, map) {
  Object.keys(map).forEach(function (h) {
    if (t.col[h]) t.sh.setColumnWidth(t.col[h], map[h]);
  });
}

function paintTabs_() {
  var ss = ss_();
  Object.keys(S).forEach(function (k) {
    var sh = ss.getSheetByName(S[k]);
    if (sh) sh.setTabColor(TAB_WORK);
  });
  var talk = ss.getSheetByName('Діалог');
  if (talk) talk.setTabColor(TAB_TALK);
  ss.getSheets().forEach(function (sh) {
    if (/\(Архів\)\s*$/.test(sh.getName())) sh.setTabColor(TAB_ARCHIVE);
  });
}

/* ─────────────────────────────── Reading ─────────────────────────────── */

function cell_(t, b, i, head) {
  var c = t.col[head];
  if (!c) return {v: '', d: ''};
  return {v: b.values[i][c - 1], d: b.display[i][c - 1]};
}

function str_(t, b, i, head) {
  return String(cell_(t, b, i, head).d || '').trim();
}

/**
 * Gives an id to rows that have none, so the app can edit them later.
 * One setValues over the affected span instead of a write per cell: on a read
 * that touches many fresh rows the per-cell version cost seconds.
 */
function ensureIds_(t, pending) {
  if (!pending.length || !t.col['id']) return;
  var lo = pending[0].row, hi = pending[pending.length - 1].row;
  var rng = t.sh.getRange(lo, t.col['id'], hi - lo + 1, 1);
  var cur = rng.getValues();
  pending.forEach(function (p) { cur[p.row - lo][0] = p.id; });
  rng.setValues(cur);
}

function readJournal_(t, from) {
  var b = bodyFrom_(t, from), out = [], pending = [], lastDate = '';
  for (var i = 0; i < b.values.length; i++) {
    var dc = cell_(t, b, i, 'Дата');
    var date = iso_(dc.v, dc.d);
    if (date) lastDate = date; else date = lastDate;

    var tc = cell_(t, b, i, 'Час');
    var time = hhmm_(tc.v, tc.d);
    var gc = cell_(t, b, i, 'Глюкоза');
    var g = glu_(gc.v, gc.d);
    var ic = cell_(t, b, i, 'Інсулін, ОД');
    var insulin = num_(ic.v, ic.d);
    var food = str_(t, b, i, 'Корм');
    var note = str_(t, b, i, 'Нотатка');
    var vet  = str_(t, b, i, 'Коментар лікаря');

    if (!time && g.glucose == null && !g.hi && insulin == null && !food && !note && !vet) continue;

    var id = str_(t, b, i, 'id');
    if (!id) { id = uid_('j'); pending.push({row: b.first + i, id: id}); }

    out.push({id: id, date: date, time: time, glucose: g.glucose, hi: g.hi,
              insulin: insulin, food: food, note: note, vet: vet});
  }
  ensureIds_(t, pending);
  return out;
}

function readUrine_(t, from) {
  var b = bodyFrom_(t, from), out = [], pending = [], lastDate = '';
  for (var i = 0; i < b.values.length; i++) {
    var dc = cell_(t, b, i, 'Дата');
    var date = iso_(dc.v, dc.d);
    if (date) lastDate = date; else date = lastDate;

    var tc = cell_(t, b, i, 'Час');
    var time = hhmm_(tc.v, tc.d);
    var mc = cell_(t, b, i, 'Мл');
    var ml = num_(mc.v, mc.d);
    var note = str_(t, b, i, 'Нотатка');
    if (!time && ml == null && !note) continue;

    var id = str_(t, b, i, 'id');
    if (!id) { id = uid_('u'); pending.push({row: b.first + i, id: id}); }
    out.push({id: id, date: date, time: time, ml: ml, note: note});
  }
  ensureIds_(t, pending);
  return out;
}

function readDay_(t, from) {
  var b = bodyFrom_(t, from), out = [], pending = [];
  for (var i = 0; i < b.values.length; i++) {
    var dc = cell_(t, b, i, 'Дата');
    var date = iso_(dc.v, dc.d);
    if (!date) continue;
    var sc = cell_(t, b, i, 'Бал');
    var uc = cell_(t, b, i, 'Сеча за добу, мл');
    var lc = cell_(t, b, i, 'Змін лотка');

    var id = str_(t, b, i, 'id');
    if (!id) { id = uid_('d'); pending.push({row: b.first + i, id: id}); }

    out.push({id: id, date: date,
              stool: str_(t, b, i, 'Стул'),
              score: num_(sc.v, sc.d),
              note: str_(t, b, i, 'Нотатка'),
              urineMl: num_(uc.v, uc.d),
              litter: num_(lc.v, lc.d)});
  }
  ensureIds_(t, pending);
  return out;
}

function readMeds_(t, from) {
  var b = bodyFrom_(t, from), out = [], pending = [], lastDate = '';
  for (var i = 0; i < b.values.length; i++) {
    var dc = cell_(t, b, i, 'Дата');
    var date = iso_(dc.v, dc.d);
    if (date) lastDate = date; else date = lastDate;

    var name = str_(t, b, i, 'Препарат');
    var qty  = str_(t, b, i, 'Кількість');
    var note = str_(t, b, i, 'Нотатка');
    if (!name && !qty && !note) continue;

    var tc = cell_(t, b, i, 'Час');
    var rc = cell_(t, b, i, 'Призначення id');
    var id = str_(t, b, i, 'id');
    if (!id) { id = uid_('m'); pending.push({row: b.first + i, id: id}); }

    out.push({id: id, date: date, time: hhmm_(tc.v, tc.d), name: name,
              qty: qty, note: note, regimenId: num_(rc.v, rc.d), _row: b.first + i});
  }
  ensureIds_(t, pending);
  return out;
}

function readRegimens_(t) {
  var b = body_(t), out = [];
  for (var i = 0; i < b.values.length; i++) {
    var name = str_(t, b, i, 'Препарат');
    if (!name) continue;
    var ic = cell_(t, b, i, 'id');
    var fc = cell_(t, b, i, 'З дати');
    var tc = cell_(t, b, i, 'По дату');
    var pc = cell_(t, b, i, 'Разів на день');
    out.push({id: num_(ic.v, ic.d), name: name,
              qty: str_(t, b, i, 'Кількість за раз'),   /* якщо колонка ще є */
              perDay: num_(pc.v, pc.d),
              from: iso_(fc.v, fc.d), to: iso_(tc.v, tc.d),
              note: str_(t, b, i, 'Нотатка')});
  }
  return out;
}

/**
 * A dose typed in by hand only knows the drug name. Resolve the course by name
 * plus a date inside its range. The resolved id is cached back into the hidden
 * column in one write, not one per row.
 */
function linkMeds_(meds, regimens, t) {
  var fill = [];
  meds.forEach(function (m) {
    var row = m._row;
    delete m._row;
    if (m.regimenId) return;
    var hit = null;
    for (var i = 0; i < regimens.length; i++) {
      var r = regimens[i];
      if (!r.id || r.name !== m.name) continue;
      if (r.from && m.date && m.date < r.from) continue;
      if (r.to && m.date && m.date > r.to) continue;
      hit = r; break;
    }
    if (!hit) return;
    m.regimenId = hit.id;
    if (row && t.col['Призначення id']) fill.push({row: row, id: hit.id});
  });
  if (!fill.length || !t.col['Призначення id']) return;
  var lo = fill[0].row, hi = fill[fill.length - 1].row;
  var rng = t.sh.getRange(lo, t.col['Призначення id'], hi - lo + 1, 1);
  var cur = rng.getValues();
  fill.forEach(function (f) { cur[f.row - lo][0] = f.id; });
  rng.setValues(cur);
}

function readAll_(from) {
  var jt = readTable_(S.journal), ut = readTable_(S.urine),
      dt = readTable_(S.day),     mt = readTable_(S.meds);
  var res = {
    journal:  readJournal_(jt, from),
    urine:    readUrine_(ut, from),
    days:     readDay_(dt, from),
    meds:     readMeds_(mt, from),
    regimens: readRegimens_(readTable_(S.regimens)),  /* few rows, always all */
    /* Колонки, за якими рядок вважається непорожнім, — ті самі, що вирішують,
       чи потрапить він у відповідь взагалі. */
    first: {
      journal: firstDate_(jt, ['Час', 'Глюкоза', 'Інсулін, ОД', 'Корм',
                               'Нотатка', 'Коментар лікаря']),
      urine:   firstDate_(ut, ['Час', 'Мл', 'Нотатка']),
      day:     firstDate_(dt, ['Стул', 'Нотатка']),
      med:     firstDate_(mt, ['Препарат', 'Кількість', 'Нотатка'])
    }
  };
  linkMeds_(res.meds, res.regimens, mt);
  return res;
}

/* ──────────────────────────────── doGet ──────────────────────────────── */

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function dataVersion_() {
  return PropertiesService.getScriptProperties().getProperty('DATA_VERSION') || '0';
}

function bumpVersion_() {
  var p = PropertiesService.getScriptProperties();
  p.setProperty('DATA_VERSION', String(Number(dataVersion_()) + 1));
}

function inRange_(d, from, to) {
  if (!d) return false;
  return d >= from && d <= to;
}

/** Daily min/max instead of thousands of points on a phone. */
function aggregate_(journal) {
  var by = {};
  journal.forEach(function (r) {
    if (!r.date) return;
    var a = by[r.date] || (by[r.date] =
      {date: r.date, min: null, max: null, n: 0, hi: false, insulin: 0, shots: 0});
    if (r.glucose != null) {
      a.n++;
      if (a.min == null || r.glucose < a.min) a.min = r.glucose;
      if (a.max == null || r.glucose > a.max) a.max = r.glucose;
    }
    if (r.hi) a.hi = true;
    if (r.insulin != null) { a.insulin += r.insulin; a.shots++; }
  });
  return Object.keys(by).sort().map(function (k) { return by[k]; });
}

function doGet(e) {
  e = e || {};
  var p = e.parameter || {};
  var tStart = Date.now();
  try {
    var role = roleOf_(p.k);
    if (!role) return json_({ok: false, error: 'forbidden'});

    var to   = p.to || today_();
    var days = p.days ? Math.max(1, parseInt(p.days, 10)) : DEFAULT_DAYS;
    var from = p.from || shiftDays_(to, -(days - 1));
    var agg  = String(p.agg || '') === '1';

    var cache = CacheService.getScriptCache();
    var ckey  = ['c' + CODE_VERSION, 'v' + dataVersion_(),
                 from, to, agg ? 'a' : 'f'].join('|');
    var hit   = cache.get(ckey);
    if (hit) {
      var cached = JSON.parse(hit);
      cached.role = role;
      cached.cached = true;
      return json_(cached);
    }

    var tRead = Date.now();
    var all = readAll_(from);
    tRead = Date.now() - tRead;
    var window = all.journal.filter(function (r) { return inRange_(r.date, from, to); });
    var out = {
      ok: true, role: role, tz: tz_(), today: today_(),
      from: from, to: to, aggregated: agg,
      journal:  agg ? [] : window,
      agg:      agg ? aggregate_(window) : [],
      urine:    all.urine.filter(function (r) { return inRange_(r.date, from, to); }),
      days:     all.days.filter(function (r) { return inRange_(r.date, from, to); }),
      meds:     all.meds.filter(function (r) { return inRange_(r.date, from, to); }),
      regimens: all.regimens,
      /* Найраніша дата в кожному аркуші: за нею застосунок точно знає, чи
         лишилось що вантажити, замість того щоб здогадуватись по краю вікна. */
      first:    all.first,
      weight:   weight_(),
      stool:    STOOL,
      /* Адреси їдуть разом з даними, а не лежать у config.js: репозиторій
         публічний, а таблиця відкрита на редагування за посиланням. */
      sheetUrl: sheetLink_(),
      notionUrl: LINKS.notion || '',
      ms:       {read: tRead, total: Date.now() - tStart}
    };

    var payload = JSON.stringify(out);
    if (payload.length < 90000) cache.put(ckey, payload, CACHE_SEC);
    return json_(out);

  } catch (err) {
    return json_({ok: false, error: String(err && err.message || err)});
  }
}

/* ─────────────────────────────── Writing ─────────────────────────────── */

/* What maps to what. "Коментар лікаря", the bullet and the two formula columns
   are deliberately absent: the app never touches them. */
var WRITE = {
  journal: {sheet: S.journal, prefix: 'j', sorted: 'datetime', fields: {
    date: 'Дата', time: 'Час', glucose: 'Глюкоза',
    insulin: 'Інсулін, ОД', food: 'Корм', note: 'Нотатка'}},
  urine:   {sheet: S.urine, prefix: 'u', sorted: 'datetime', fields: {
    date: 'Дата', time: 'Час', ml: 'Мл', note: 'Нотатка'}},
  day:     {sheet: S.day, prefix: 'd', sorted: 'date', fields: {
    date: 'Дата', stool: 'Стул', score: 'Бал', note: 'Нотатка'}},
  med:     {sheet: S.meds, prefix: 'm', sorted: 'datetime', fields: {
    date: 'Дата', time: 'Час', name: 'Препарат', qty: 'Кількість',
    note: 'Нотатка', regimenId: 'Призначення id'}},
  regimen: {sheet: S.regimens, prefix: 'r', sorted: 'none', numericId: true, fields: {
    name: 'Препарат', from: 'З дати', to: 'По дату', note: 'Нотатка'}}
};

var DATE_HEADS = {'Дата': 1, 'З дати': 1, 'По дату': 1};

function coerce_(head, v) {
  if (v === null || v === undefined || v === '') return '';
  if (DATE_HEADS[head]) return (v instanceof Date) ? v : dateOf_(String(v));
  return v;
}

function putRow_(t, row, spec, data) {
  Object.keys(spec.fields).forEach(function (key) {
    if (!(key in data)) return;
    var head = spec.fields[key];
    if (READONLY_COLS.indexOf(head) !== -1) return;
    var c = t.col[head];
    if (!c) return;
    t.sh.getRange(row, c).setValue(coerce_(head, data[key]));
  });
}

function findRowById_(t, id) {
  if (!t.col['id']) return 0;
  var last = t.sh.getLastRow();
  if (last < 2) return 0;
  var vals = t.sh.getRange(2, t.col['id'], last - 1, 1).getDisplayValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]).trim() === String(id).trim()) return i + 2;
  }
  return 0;
}

/** Sort key for a row: 'YYYY-MM-DD HH:mm'. No time sorts to end of day. */
function sortKey_(date, time, mode) {
  if (mode === 'date') return String(date || '');
  return String(date || '') + ' ' + (time || '99:99');
}

/** Row number to insert before so the sheet stays in chronological order. */
function findInsertRow_(t, spec, key) {
  var b = body_(t), lastDate = '';
  for (var i = 0; i < b.values.length; i++) {
    var dc = cell_(t, b, i, 'Дата');
    var d = iso_(dc.v, dc.d);
    if (d) lastDate = d; else d = lastDate;
    if (!d) continue;
    var tm = '';
    if (t.col['Час']) { var tc = cell_(t, b, i, 'Час'); tm = hhmm_(tc.v, tc.d); }
    if (sortKey_(d, tm, spec.sorted) > key) return b.first + i;
  }
  return t.sh.getLastRow() + 1;
}

/** Opens a blank row in the right place and returns its number. */
function openRow_(t, spec, key) {
  var last = t.sh.getLastRow();
  var at = (spec.sorted === 'none') ? last + 1 : findInsertRow_(t, spec, key);
  if (at <= last) {
    t.sh.insertRowBefore(at);
  } else {
    if (last >= t.sh.getMaxRows()) t.sh.insertRowsAfter(t.sh.getMaxRows(), 10);
    at = last + 1;
  }
  return at;
}

/** Per-row formulas of a daily row. Written once, never touched again. */
function setDayFormulas_(t, row) {
  var ut = table_(S.urine);
  if (!ut.col['Дата'] || !ut.col['Мл']) return;
  var q = "'" + S.urine + "'!";
  var dr = q + '$' + colLetter_(ut.col['Дата']) + ':$' + colLetter_(ut.col['Дата']);
  var mr = q + '$' + colLetter_(ut.col['Мл'])   + ':$' + colLetter_(ut.col['Мл']);
  var d  = '$' + colLetter_(t.col['Дата']) + row;

  if (t.col['Сеча за добу, мл']) {
    t.sh.getRange(row, t.col['Сеча за добу, мл'])
      .setFormula(f_('=IF(' + d + '="","",SUMIF(' + dr + ',' + d + ',' + mr + '))'));
  }
  if (t.col['Змін лотка']) {
    t.sh.getRange(row, t.col['Змін лотка'])
      .setFormula(f_('=IF(' + d + '="","",COUNTIF(' + dr + ',' + d + '))'));
  }
}

function setDotFormula_(t, row) {
  if (!t.col[DOT_HEAD] || !t.col['Глюкоза']) return;
  t.sh.getRange(row, t.col[DOT_HEAD])
    .setFormula(dotFormula_(colLetter_(t.col['Глюкоза']), row));
}

/** A daily row always exists once there is any data for that date. */
function ensureDayRow_(iso) {
  if (!iso) return 0;
  var t = table_(S.day);
  var b = body_(t);
  for (var i = 0; i < b.values.length; i++) {
    var dc = cell_(t, b, i, 'Дата');
    if (iso_(dc.v, dc.d) === iso) return b.first + i;
  }
  var row = openRow_(t, WRITE.day, sortKey_(iso, '', 'date'));
  t.sh.getRange(row, t.col['Дата']).setValue(dateOf_(iso));
  if (t.col['id']) t.sh.getRange(row, t.col['id']).setValue(uid_('d'));
  setDayFormulas_(t, row);
  return row;
}

function nextRegimenId_() {
  var t = table_(S.regimens), b = body_(t), max = 300;
  for (var i = 0; i < b.values.length; i++) {
    var c = cell_(t, b, i, 'id');
    var n = num_(c.v, c.d);
    if (n && n > max) max = n;
  }
  return max + 1;
}

/* ─────────────────────────────── Actions ─────────────────────────────── */

function actCreate_(kind, id, data, extraMeds) {
  var spec = WRITE[kind];
  var t = table_(spec.sheet);

  if (spec.numericId) {
    var rid = data.id || nextRegimenId_();
    var exists = findRowById_(t, rid);
    if (exists) { putRow_(t, exists, spec, data); return {id: rid, row: exists, created: false}; }
    var rrow = openRow_(t, spec, '');
    t.sh.getRange(rrow, t.col['id']).setValue(rid);
    putRow_(t, rrow, spec, data);
    return {id: rid, row: rrow, created: true};
  }

  if (!id) id = uid_(spec.prefix);
  var was = findRowById_(t, id);
  if (was) return {id: id, row: was, created: false, duplicate: true};

  if (kind === 'day' && data.date) {
    var dayRow = ensureDayRow_(data.date);
    putRow_(t, dayRow, spec, data);
    var have = '';
    if (t.col['id']) {
      have = String(t.sh.getRange(dayRow, t.col['id']).getDisplayValue()).trim();
      if (!have) { t.sh.getRange(dayRow, t.col['id']).setValue(id); have = id; }
    }
    return {id: have || id, row: dayRow, created: true};
  }

  var row = openRow_(t, spec, sortKey_(data.date, data.time, spec.sorted));
  putRow_(t, row, spec, data);
  if (t.col['id']) t.sh.getRange(row, t.col['id']).setValue(id);
  if (kind === 'journal') setDotFormula_(t, row);

  if (kind === 'journal' || kind === 'urine') ensureDayRow_(data.date);

  var made = [];
  if (kind === 'journal' && extraMeds && extraMeds.length) {
    var regs = readRegimens_(table_(S.regimens));
    extraMeds.forEach(function (m) {
      var reg = null;
      for (var i = 0; i < regs.length; i++) if (regs[i].id === m.regimenId) reg = regs[i];
      var res = actCreate_('med', m.id || null, {
        date: data.date, time: m.time || data.time,
        name: m.name || (reg ? reg.name : ''),
        qty: m.qty || (reg ? reg.qty : ''),
        note: m.note || '', regimenId: m.regimenId || ''
      });
      made.push(res.id);
    });
  }
  return {id: id, row: row, created: true, meds: made};
}

function actUpdate_(kind, id, data) {
  var spec = WRITE[kind];
  var t = table_(spec.sheet);
  var row = findRowById_(t, id);
  if (!row) throw new Error('row ' + id + ' not found; it may have been deleted in the sheet');

  var moved = false;
  if (spec.sorted !== 'none' && ('date' in data || 'time' in data)) {
    var b = body_(t), i = row - b.first;
    var curDate = iso_(cell_(t, b, i, 'Дата').v, cell_(t, b, i, 'Дата').d);
    var curTime = t.col['Час'] ? hhmm_(cell_(t, b, i, 'Час').v, cell_(t, b, i, 'Час').d) : '';
    var newKey = sortKey_('date' in data ? data.date : curDate,
                          'time' in data ? data.time : curTime, spec.sorted);
    if (newKey !== sortKey_(curDate, curTime, spec.sorted)) moved = true;
  }

  if (!moved) {
    putRow_(t, row, spec, data);
    if (kind === 'journal') setDotFormula_(t, row);
    return {id: id, row: row};
  }

  var keep = {};
  var b2 = body_(t), i2 = row - b2.first;
  Object.keys(spec.fields).forEach(function (k) {
    var head = spec.fields[k];
    if (!t.col[head]) return;
    if (k in data) { keep[k] = data[k]; return; }
    var c = cell_(t, b2, i2, head);
    if (DATE_HEADS[head])    keep[k] = iso_(c.v, c.d);
    else if (head === 'Час') keep[k] = hhmm_(c.v, c.d);
    else                     keep[k] = c.v;
  });
  t.sh.deleteRow(row);
  var at = openRow_(t, spec, sortKey_(keep.date, keep.time, spec.sorted));
  putRow_(t, at, spec, keep);
  if (t.col['id']) t.sh.getRange(at, t.col['id']).setValue(id);
  if (kind === 'day') setDayFormulas_(t, at);
  if (kind === 'journal') setDotFormula_(t, at);
  return {id: id, row: at, moved: true};
}

function actDelete_(kind, id) {
  var spec = WRITE[kind];
  var t = table_(spec.sheet);
  var row = findRowById_(t, id);
  if (!row) throw new Error('row ' + id + ' not found');
  t.sh.deleteRow(row);
  return {id: id, deleted: true};
}

/* ──────────────────────────────── doPost ──────────────────────────────── */

function doPost(e) {
  var body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ok: false, error: 'body is not JSON'});
  }

  if (roleOf_(body.k) !== 'edit') return json_({ok: false, error: 'forbidden'});

  /* Налаштування не живуть в аркуші, тому й блокування таблиці їм не треба. */
  if (body.action === 'weight') {
    try {
      return json_({ok: true, result: setWeight_(body.value)});
    } catch (err) {
      return json_({ok: false, error: String(err && err.message || err)});
    }
  }

  var kind = body.sheet;
  if (!WRITE[kind]) return json_({ok: false, error: 'unknown sheet: ' + kind});

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    return json_({ok: false, error: 'spreadsheet busy'});
  }

  try {
    var res;
    if (body.action === 'create')      res = actCreate_(kind, body.id, body.data || {}, body.meds);
    else if (body.action === 'update') res = actUpdate_(kind, body.id, body.data || {});
    else if (body.action === 'delete') res = actDelete_(kind, body.id);
    else return json_({ok: false, error: 'unknown action: ' + body.action});

    SpreadsheetApp.flush();
    bumpVersion_();
    return json_({ok: true, result: res});
  } catch (err) {
    return json_({ok: false, error: String(err && err.message || err)});
  } finally {
    lock.releaseLock();
  }
}

/* ────────────────────────── Migrating old data ────────────────────────── */

var MIG_TAG = '_mig_';

var MEDS_KNOWN = [
  {re: /клавасептин/i,                            name: 'Клавасептин',              qty: '1 табл.'},
  {re: /псил[іи]ум/i,                             name: 'Псиліум',                  qty: '1/10 ч.л.'},
  {re: /метформ|гл[іи]бенклам|(^|\s)табл\.?($|\s)/i, name: 'Метформін + Глібенкламід', qty: '1 табл.'},
  {re: /ципрофлоксацин/i,                         name: 'Ципрофлоксацин',           qty: ''}
];

var RE_INSULIN = /(\d+(?:[.,]\d+)?)\s*ОД/i;
var RE_QTY = /\d+(?:[.,]\d+)?(?:\s*\/\s*\d+)?\s*(?:ч\.?\s*л\.?|табл\.?|таб\.?|мг|мл|крап)/i;
var RE_FOOD_START = /^(корм|їжа|їсть|поїв|поїла|вологий|сухий|сухого|догодувала|погодувала|гранул|\d+([.,]\d+)?\s*г\b|\d+([.,]\d+)?\s*ч\.?\s*л)/i;
var RE_FOOD_ANY = /(корм|вологий|сухого|ласощ|ч\.\s*л)/i;

var DEC_MARK = String.fromCharCode(1);

function medOf_(fragment) {
  for (var i = 0; i < MEDS_KNOWN.length; i++) {
    if (MEDS_KNOWN[i].re.test(fragment)) return MEDS_KNOWN[i];
  }
  return null;
}

/**
 * Splits a note into fragments: on commas and newlines, and on "+" only when it
 * really separates different things rather than "3 ч.л. + 8 г сухого".
 * A comma between digits is a decimal point ("0,75 ОД"), not a boundary, so it
 * is hidden for the duration of the split.
 */
function fragments_(text) {
  var out = [];
  var guarded = String(text || '').replace(/(\d)\s*,\s*(\d)/g, '$1' + DEC_MARK + '$2');
  guarded.split(/\r?\n|,|;/).forEach(function (raw) {
    var chunk = raw.split(DEC_MARK).join(',').trim();
    if (!chunk) return;
    var parts = chunk.split(/\s+\+\s+/);
    if (parts.length > 1) {
      var mixed = false;
      parts.forEach(function (p) { if (RE_INSULIN.test(p) || medOf_(p)) mixed = true; });
      if (mixed) { parts.forEach(function (p) { if (p.trim()) out.push(p.trim()); }); return; }
    }
    out.push(chunk);
  });
  return out;
}

function tidy_(s) {
  return String(s || '').replace(/^[\s\-–—:.,]+/, '').replace(/[\s\-–—:.,]+$/, '').trim();
}

/** One note -> {insulin, food, note, meds:[{name,qty}]} */
function parseNote_(text) {
  var res = {insulin: null, food: [], note: [], meds: []};
  fragments_(text).forEach(function (f) {
    var m = f.match(RE_INSULIN);
    if (m) {
      res.insulin = parseFloat(m[1].replace(',', '.'));
      var rest = tidy_(f.replace(m[0], '').replace(/лантус/ig, ''));
      if (rest.length > 2) res.note.push(rest);
      return;
    }
    var med = medOf_(f);
    if (med) {
      var q = f.match(RE_QTY);
      res.meds.push({name: med.name, qty: q ? tidy_(q[0]) : med.qty});
      return;
    }
    if (RE_FOOD_START.test(f) || RE_FOOD_ANY.test(f)) { res.food.push(f); return; }
    res.note.push(f);
  });
  return {
    insulin: res.insulin,
    food: res.food.join(' + '),
    note: res.note.join(', '),
    meds: res.meds
  };
}

/** Stool description from the archive -> {cat, score}. Text is always kept. */
function parseStool_(text) {
  var t = String(text || '').toLowerCase();
  var score = null;
  var m = t.match(/\((\d)\s*\/\s*7\)/);
  if (m) score = +m[1];
  var cat = '';
  if (/не какав/.test(t))                                    cat = 'не какав';
  else if (/р[іи]дк/.test(t))                                cat = 'рідкий';
  else if (/м['ʼ’]?як/.test(t))                              cat = "м'який";
  else if (/не\s+(такий\s+)?сух|нормальн|сформован/.test(t)) cat = 'нормальний';
  else if (/сух/.test(t))                                    cat = 'сухий';
  return {cat: cat, score: score};
}

function archiveSheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('sheet "' + name + '" is missing; rename the old sheet by adding " (Архів)"');
  if (sh.getLastRow() < 2) throw new Error('sheet "' + name + '" is empty');
  return sh;
}

/** Year for dates like "01.08" that carry no year of their own. */
function guessYear_(values, dateCol) {
  for (var i = 0; i < values.length; i++) {
    var v = values[i][dateCol];
    if (v instanceof Date && !isNaN(v)) return v.getFullYear();
  }
  return new Date().getFullYear();
}

function migrationGuard_(force) {
  if (force) return;
  var dirty = [];
  [S.journal, S.urine, S.day, S.meds].forEach(function (name) {
    var t = table_(name);
    if (!t.col['id']) return;
    var last = t.sh.getLastRow();
    if (last < 2) return;
    var ids = t.sh.getRange(2, t.col['id'], last - 1, 1).getDisplayValues();
    for (var i = 0; i < ids.length; i++) {
      var v = String(ids[i][0]).trim();
      if (v && v.indexOf(MIG_TAG) === -1) { dirty.push(name); return; }
    }
  });
  if (dirty.length) {
    throw new Error('Sheets ' + dirty.join(', ') + ' already hold rows that did not come from ' +
      'the migration. migrate() overwrites sheets completely. Run migrateForce() if that is intended.');
  }
}

/** Fills a sheet from scratch; rows are objects keyed by header name. */
function writeSheet_(name, rows) {
  var t = table_(name);
  var last = t.sh.getLastRow();
  if (last > 1) t.sh.getRange(2, 1, last - 1, t.sh.getMaxColumns()).clear({contentsOnly: true});
  if (!rows.length) return t;

  var need = rows.length + 1;
  if (t.sh.getMaxRows() < need) t.sh.insertRowsAfter(t.sh.getMaxRows(), need - t.sh.getMaxRows() + 20);

  var out = [];
  for (var i = 0; i < rows.length; i++) {
    var line = [];
    for (var c = 0; c < t.lastCol; c++) line.push('');
    Object.keys(rows[i]).forEach(function (head) {
      var col = t.col[head];
      if (!col) return;
      var v = rows[i][head];
      line[col - 1] = (v === null || v === undefined) ? '' : coerce_(head, v);
    });
    out.push(line);
  }
  t.sh.getRange(2, 1, out.length, t.lastCol).setValues(out);
  return t;
}

/**
 * Parses the archive sheets into the new structure.
 * Idempotent: the target sheets are rebuilt from scratch on every run.
 */
function migrate(force) {
  migrationGuard_(force);

  var jsh = archiveSheet_(ARCHIVE.journal);
  var ush = archiveSheet_(ARCHIVE.urine);

  /* ── journal ── */
  var jRows = jsh.getLastRow() - 1;
  var jv = jsh.getRange(2, 1, jRows, 4).getValues();
  var jd = jsh.getRange(2, 1, jRows, 4).getDisplayValues();
  var jYear = guessYear_(jv, 0);

  var journal = [], medEvents = [], lastDate = '', n = 0;
  for (var i = 0; i < jv.length; i++) {
    var date = iso_(jv[i][0], jd[i][0], jYear);
    if (date) lastDate = date; else date = lastDate;
    var time = hhmm_(jv[i][1], jd[i][1]);
    var g = glu_(jv[i][2], jd[i][2]);
    var raw = String(jd[i][3] || '').trim();
    if (!date || (!time && g.glucose == null && !g.hi && !raw)) continue;

    var p = parseNote_(raw);
    journal.push({
      'Дата': date, 'Час': time,
      'Глюкоза': g.hi ? 'Hi' : (g.glucose == null ? '' : g.glucose),
      'Інсулін, ОД': p.insulin == null ? '' : p.insulin,
      'Корм': p.food, 'Нотатка': p.note,
      'id': 'j' + MIG_TAG + (++n)
    });
    p.meds.forEach(function (md) {
      medEvents.push({date: date, time: time, name: md.name, qty: md.qty});
    });
  }

  /* ── litter events and daily rows ── */
  var uRows = ush.getLastRow() - 1;
  var uv = ush.getRange(2, 1, uRows, 4).getValues();
  var ud = ush.getRange(2, 1, uRows, 4).getDisplayValues();
  var uYear = guessYear_(uv, 0);

  var urine = [], stoolByDate = {}, uN = 0;
  lastDate = '';
  for (var k = 0; k < uv.length; k++) {
    var d2 = iso_(uv[k][0], ud[k][0], uYear);
    if (d2) lastDate = d2; else d2 = lastDate;
    var rawTime = String(ud[k][1] || '').trim();
    var note = String(ud[k][3] || '').trim();

    if (/за добу/i.test(rawTime)) continue;                 /* now a formula */
    if (!d2) continue;

    if (/^\*+$/.test(rawTime) || (!rawTime && note)) {      /* daily row */
      stoolByDate[d2] = note;
      continue;
    }
    var t2 = hhmm_(uv[k][1], ud[k][1]);
    if (!t2) continue;

    var mlRaw = String(ud[k][2] || '').trim();
    var ml = num_(uv[k][2], ud[k][2]);
    var uNote = note;
    if (ml == null && mlRaw) uNote = tidy_(mlRaw + (uNote ? ', ' + uNote : ''));

    urine.push({'Дата': d2, 'Час': t2, 'Мл': ml == null ? '' : ml,
                'Нотатка': uNote, 'id': 'u' + MIG_TAG + (++uN)});
  }

  /* ── daily sheet: union of every date seen ── */
  var dates = {};
  journal.forEach(function (r) { dates[r['Дата']] = 1; });
  urine.forEach(function (r) { dates[r['Дата']] = 1; });
  Object.keys(stoolByDate).forEach(function (d) { dates[d] = 1; });

  var days = Object.keys(dates).sort().map(function (d, idx) {
    var st = parseStool_(stoolByDate[d] || '');
    return {'Дата': d, 'Стул': st.cat, 'Бал': st.score == null ? '' : st.score,
            'Нотатка': stoolByDate[d] || '', 'id': 'd' + MIG_TAG + (idx + 1)};
  });

  /* ── courses inferred from the doses actually given ── */
  var lastDataDate = journal.length ? journal[journal.length - 1]['Дата'] : today_();
  var byName = {};
  medEvents.forEach(function (m) {
    var b = byName[m.name] || (byName[m.name] = {from: m.date, to: m.date, qty: m.qty, count: 0});
    if (m.date < b.from) b.from = m.date;
    if (m.date > b.to) b.to = m.date;
    b.count++;
    if (m.qty) b.qty = m.qty;
  });

  var regimens = [], rid = 300;
  Object.keys(byName).sort(function (a, b) { return byName[a].from < byName[b].from ? -1 : 1; })
    .forEach(function (name) {
      var b = byName[name];
      var ongoing = b.to >= shiftDays_(lastDataDate, -1);
      regimens.push({'id': ++rid, 'Препарат': name, 'З дати': b.from,
                     'По дату': ongoing ? '' : b.to,
                     'Нотатка': 'з міграції: за фактом ' + b.qty + ', перевірити'});
    });

  var regIdOf = {};
  regimens.forEach(function (r) { regIdOf[r['Препарат']] = r['id']; });

  var meds = medEvents.map(function (m, idx) {
    return {'Дата': m.date, 'Час': m.time, 'Препарат': m.name, 'Кількість': m.qty,
            'Призначення id': regIdOf[m.name] || '', 'id': 'm' + MIG_TAG + (idx + 1)};
  });

  /* ── write ── */
  writeSheet_(S.regimens, regimens);
  var jt = writeSheet_(S.journal, journal);
  writeSheet_(S.urine, urine);
  writeSheet_(S.meds, meds);
  var dt = writeSheet_(S.day, days);

  if (journal.length && jt.col[DOT_HEAD] && jt.col['Глюкоза']) {
    var gl = colLetter_(jt.col['Глюкоза']);
    var dots = [];
    for (var r1 = 0; r1 < journal.length; r1++) dots.push([dotFormula_(gl, r1 + 2)]);
    jt.sh.getRange(2, jt.col[DOT_HEAD], dots.length, 1).setFormulas(dots);
  }

  if (days.length) {
    var ut = table_(S.urine);
    var q = "'" + S.urine + "'!";
    var dr = q + '$' + colLetter_(ut.col['Дата']) + ':$' + colLetter_(ut.col['Дата']);
    var mr = q + '$' + colLetter_(ut.col['Мл']) + ':$' + colLetter_(ut.col['Мл']);
    var dcl = colLetter_(dt.col['Дата']);
    var fSum = [], fCnt = [];
    for (var r2 = 0; r2 < days.length; r2++) {
      var ref = '$' + dcl + (r2 + 2);
      fSum.push([f_('=IF(' + ref + '="","",SUMIF(' + dr + ',' + ref + ',' + mr + '))')]);
      fCnt.push([f_('=IF(' + ref + '="","",COUNTIF(' + dr + ',' + ref + '))')]);
    }
    if (dt.col['Сеча за добу, мл']) dt.sh.getRange(2, dt.col['Сеча за добу, мл'], days.length, 1).setFormulas(fSum);
    if (dt.col['Змін лотка'])       dt.sh.getRange(2, dt.col['Змін лотка'], days.length, 1).setFormulas(fCnt);
  }

  bumpVersion_();
  SpreadsheetApp.flush();

  var msg = 'journal: ' + journal.length + ' | urine: ' + urine.length +
            ' | days: ' + days.length + ' | meds: ' + meds.length +
            ' | regimens: ' + regimens.length;
  Logger.log(msg);
  return msg;
}

/** Same as migrate(), without the guard: also overwrites app-written rows. */
function migrateForce() {
  return migrate(true);
}

/* ─────────────────────────────── Menu ─────────────────────────────── */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Веня')
    .addItem('Налаштувати аркуші', 'setupSheets')
    .addItem('Перенести дані з архіву', 'migrate')
    .addSeparator()
    .addItem('Показати ключі доступу', 'showKeysDialog')
    .addToUi();
}

function showKeysDialog() {
  var k = showKeys();
  SpreadsheetApp.getUi().alert(
    'Ключі доступу\n\n' +
    'Вам (запис):       ' + k.edit + '\n' +
    'Лікарці (читання): ' + k.view + '\n\n' +
    'Додайте до адреси застосунку як #k=…');
}
