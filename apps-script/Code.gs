/**
 * ============================================================
 *  MASTERSHEET 5.0  //  DASHBOARD BACKEND  (v2)
 * ============================================================
 *
 *  WHAT CHANGED FROM v1
 *    - Journal entries append to a private Google Doc, not the sheet.
 *      Only the word count reaches LOG. Auto-headed with date, time
 *      and whatever calendar event you were in at the time.
 *    - TASKS supports Priority and Recur, so one row generates today's
 *      instance instead of you hand-copying it per day.
 *    - Every goal now has a real source. In v1 half of them silently
 *      returned zero forever.
 *    - HABITS supports a weekly target (Days/Week) so rings have a
 *      denominator and rest days don't break a streak.
 *    - Writes are wrapped in LockService, since two machines can now
 *      post at the same time.
 *    - Google Form path retired. LOG is the only write path.
 *
 *  SHEET SHAPE THIS EXPECTS
 *    LOG           A Timestamp | B Metric | C Value | D Device
 *    TASKS         A Task | B Date | C Priority | D Recur | E Done
 *                  F Tag | G Goal Link
 *    HABITS        A Habit | B Active | C Days/Week
 *    GOAL_TARGETS  A Name | B Target | C Unit | D Period
 *
 *  DEPLOY
 *    Deploy > Manage deployments > pencil > Version: New version
 *    Never "New deployment" -- the /exec URL would change.
 * ============================================================
 */

var TZ        = Session.getScriptTimeZone();
var CALENDARS = ['Coaching', 'Kieran Graham', 'School', 'Training', 'Research'];

var GOALS = {
  water:    2500,   // ml
  caffeine: 200,    // mg  (a CAP, not a target)
  sleep:    8.0     // hours
};

var WEATHER_LOCATION = 'Ottawa';
var JOURNAL_DOC_NAME = 'Journal';
var JOURNAL_MIN_WORDS = 15;


/* ============================================================
 *  GET
 * ========================================================== */
function doGet(e) {
  var out = {};

  try {
    expandRecurringTasks();          // materialise today's recurring rows first

    out.ok        = true;
    out.generated = new Date().toISOString();
    out.goals     = GOALS;
    out.today     = getToday();
    out.history   = getHistory();
    out.tasks     = getTasks();
    out.habits    = getHabits();
    out.monthly   = getMonthly();
    out.agenda    = getAgenda();
    out.weather   = getWeather();
    out.quote     = getQuote();
    out.journal   = getJournalMeta();
    out.context   = getCurrentActivity();
  } catch (err) {
    out.ok    = false;
    out.error = String(err);
  }

  var json = JSON.stringify(out);

  // JSONP: /exec redirects to script.googleusercontent.com and the redirect
  // strips CORS headers, so a plain fetch() can never read the response.
  var cb = e && e.parameter && e.parameter.callback;
  if (cb) {
    return ContentService
      .createTextOutput(cb + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}


/* ============================================================
 *  POST
 *
 *  Shapes:
 *    {metric:"water",   value:250, device:"laptop"}
 *    {metric:"task",    value:"Meal Prep", done:true}
 *    {metric:"newtask", value:"Call Ahmed", priority:1, tag:"Research"}
 *    {metric:"journal", text:"...", device:"laptop"}
 * ========================================================== */
function doPost(e) {
  var res  = { ok: false };
  var lock = LockService.getScriptLock();

  // Two machines plus a phone can post simultaneously. Without this,
  // concurrent appendRow calls can land on the same row.
  try {
    lock.waitLock(20000);
  } catch (err) {
    return jsonOut({ ok: false, error: 'busy, try again' });
  }

  try {
    var body = JSON.parse(e.postData.contents);

    if (body.metric === 'task') {
      res.ok = toggleTask(body.value, body.done);

    } else if (body.metric === 'newtask') {
      addTask(body);
      res.ok = true;

    } else if (body.metric === 'journal') {
      res = appendJournal(body.text, body.device);

    } else {
      appendLog(body.metric, body.value, body.device);
      res.ok = true;
    }
  } catch (err) {
    res.error = String(err);
  } finally {
    lock.releaseLock();
  }

  return jsonOut(res);
}


/* ============================================================
 *  JOURNAL
 *
 *  The text goes to a Google Doc, never to the spreadsheet. Only a
 *  word count lands in LOG, which is all the streak and the ring need.
 *  Each entry is headed with the date, the time, and whatever calendar
 *  event was running -- so a fragment written mid-afternoon still has
 *  context when you read it back in a year.
 * ========================================================== */
function journalDoc() {
  var props = PropertiesService.getScriptProperties();
  var id    = props.getProperty('JOURNAL_DOC_ID');

  if (id) {
    try {
      return DocumentApp.openById(id);
    } catch (err) {
      // deleted or unshared: fall through and make a new one
    }
  }

  var doc = DocumentApp.create(JOURNAL_DOC_NAME);
  props.setProperty('JOURNAL_DOC_ID', doc.getId());
  doc.getBody().appendParagraph(JOURNAL_DOC_NAME)
     .setHeading(DocumentApp.ParagraphHeading.TITLE);
  doc.saveAndClose();
  return DocumentApp.openById(props.getProperty('JOURNAL_DOC_ID'));
}

function appendJournal(text, device) {
  text = String(text == null ? '' : text).trim();
  if (!text) return { ok: false, error: 'empty entry' };

  var now  = new Date();
  var ctx  = getCurrentActivity();

  var header = Utilities.formatDate(now, TZ, 'EEEE d MMMM yyyy')
             + '  \u00b7  ' + Utilities.formatDate(now, TZ, 'h:mm a');
  if (ctx && ctx.title) header += '  \u00b7  ' + ctx.title;

  var doc  = journalDoc();
  var body = doc.getBody();

  body.appendParagraph(header)
      .setHeading(DocumentApp.ParagraphHeading.HEADING3);
  body.appendParagraph(text)
      .setHeading(DocumentApp.ParagraphHeading.NORMAL);
  doc.saveAndClose();

  var words = text.split(/\s+/).filter(function(w){ return w.length; }).length;
  appendLog('journal', words, device);

  return { ok: true, words: words, doc: doc.getUrl(), context: ctx ? ctx.title : '' };
}

/** The calendar event spanning right now, if any. Used for entry headers. */
function getCurrentActivity() {
  var now = new Date();

  for (var i = 0; i < CALENDARS.length; i++) {
    var cals = CalendarApp.getCalendarsByName(CALENDARS[i]);
    if (!cals || !cals.length) continue;

    var evts = cals[0].getEvents(new Date(now.getTime() - 3600000),
                                 new Date(now.getTime() + 3600000));
    for (var j = 0; j < evts.length; j++) {
      if (evts[j].isAllDayEvent()) continue;
      if (evts[j].getStartTime() <= now && evts[j].getEndTime() >= now) {
        return { title: evts[j].getTitle(), calendar: CALENDARS[i] };
      }
    }
  }
  return null;
}

/** Word counts for the last 28 days, plus the current streak. */
function getJournalMeta() {
  var rows  = ss().getSheetByName('LOG').getDataRange().getValues();
  var byDay = {};

  for (var i = 1; i < rows.length; i++) {
    var ts = rows[i][0];
    if (!(ts instanceof Date)) continue;
    if (String(rows[i][1]).toLowerCase().trim() !== 'journal') continue;
    var k = dayKey(ts);
    byDay[k] = (byDay[k] || 0) + (Number(rows[i][2]) || 0);
  }

  var today = startOfDay(new Date());
  var days  = [];

  for (var d = 27; d >= 0; d--) {
    var day = new Date(today.getTime() - d * 86400000);
    days.push({ date: dayKey(day), words: byDay[dayKey(day)] || 0 });
  }

  // today not yet written is not a broken streak
  var streak = 0;
  for (var k2 = 0; k2 < 400; k2++) {
    var day2 = new Date(today.getTime() - k2 * 86400000);
    if ((byDay[dayKey(day2)] || 0) >= JOURNAL_MIN_WORDS) streak++;
    else if (k2 > 0) break;
  }

  var url = '';
  try { url = journalDoc().getUrl(); } catch (err) {}

  return { days: days, streak: streak, minWords: JOURNAL_MIN_WORDS, url: url };
}


/* ============================================================
 *  LOG  /  TASKS
 * ========================================================== */
function appendLog(metric, value, device) {
  ss().getSheetByName('LOG').appendRow([
    new Date(),
    String(metric).toLowerCase().trim(),
    value,
    device ? String(device) : ''
  ]);
}

function addTask(body) {
  ss().getSheetByName('TASKS').appendRow([
    String(body.value),
    body.date ? new Date(body.date) : startOfDay(new Date()),
    Number(body.priority) || 2,
    body.recur ? String(body.recur) : '',
    false,
    body.tag  ? String(body.tag)  : '',
    body.goal ? String(body.goal) : ''
  ]);
}

function toggleTask(taskName, done) {
  var sh    = ss().getSheetByName('TASKS');
  var rows  = sh.getDataRange().getValues();
  var today = startOfDay(new Date());

  // Match the row for TODAY first. A recurring task has many rows with
  // the same name; ticking one must not tick last Tuesday's.
  var fallback = -1;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]).trim() !== String(taskName).trim()) continue;

    var d = rows[i][1] instanceof Date ? startOfDay(rows[i][1]) : null;
    if (d && +d === +today) {
      sh.getRange(i + 1, 5).setValue(done === true);
      return true;
    }
    if (fallback < 0) fallback = i;
  }

  if (fallback >= 0) {
    sh.getRange(fallback + 1, 5).setValue(done === true);
    return true;
  }
  return false;
}

/**
 * Recurrence. A row with a Recur rule is a TEMPLATE. If today matches
 * the rule and no instance exists for today, one is created.
 *
 *   daily            every day
 *   weekdays         Mon-Fri
 *   weekly:mon,thu   those days
 */
function expandRecurringTasks() {
  var sh   = ss().getSheetByName('TASKS');
  var rows = sh.getDataRange().getValues();
  if (rows.length < 2) return;

  var today  = startOfDay(new Date());
  var dowNum = today.getDay();                                  // 0=Sun
  var dowStr = ['sun','mon','tue','wed','thu','fri','sat'][dowNum];

  var existsToday = {};
  var templates   = [];

  for (var i = 1; i < rows.length; i++) {
    var name = String(rows[i][0]).trim();
    if (!name) continue;

    var d = rows[i][1] instanceof Date ? startOfDay(rows[i][1]) : null;
    if (d && +d === +today) existsToday[name.toLowerCase()] = true;

    var rule = String(rows[i][3] || '').toLowerCase().trim();
    if (rule) templates.push({ row: rows[i], rule: rule, name: name });
  }

  var newRows = [];

  templates.forEach(function(t) {
    if (existsToday[t.name.toLowerCase()]) return;

    var due = false;
    if (t.rule === 'daily') {
      due = true;
    } else if (t.rule === 'weekdays') {
      due = (dowNum >= 1 && dowNum <= 5);
    } else if (t.rule.indexOf('weekly:') === 0) {
      due = t.rule.slice(7).split(',').some(function(x){
        return x.trim() === dowStr;
      });
    }
    if (!due) return;

    newRows.push([
      t.name, today,
      Number(t.row[2]) || 2,
      '',                      // instances carry no rule, or they'd recurse
      false,
      t.row[5] || '',
      t.row[6] || ''
    ]);
    existsToday[t.name.toLowerCase()] = true;
  });

  if (newRows.length) {
    sh.getRange(sh.getLastRow() + 1, 1, newRows.length, 7).setValues(newRows);
  }
}

function getTasks() {
  var rows = ss().getSheetByName('TASKS').getDataRange().getValues();
  var out  = [];

  var today = startOfDay(new Date());
  var soon  = new Date(today.getTime() + 7 * 86400000);

  for (var i = 1; i < rows.length; i++) {
    var name = rows[i][0];
    if (!name) continue;

    var rule = String(rows[i][3] || '').trim();
    if (rule) continue;                       // templates are not shown

    var date = rows[i][1] instanceof Date ? startOfDay(rows[i][1]) : null;
    var done = rows[i][4] === true;

    var bucket;
    if (date === null)         bucket = 'soon';
    else if (date < today)     bucket = done ? 'today' : 'overdue';
    else if (+date === +today) bucket = 'today';
    else if (date < soon)      bucket = 'soon';
    else                       continue;

    out.push({
      task:     String(name),
      date:     date ? date.toISOString() : null,
      due:      date ? Utilities.formatDate(date, TZ, 'EEE d MMM') : '',
      priority: Number(rows[i][2]) || 2,
      done:     done,
      bucket:   bucket,
      tag:      rows[i][5] ? String(rows[i][5]) : '',
      goal:     rows[i][6] ? String(rows[i][6]) : ''
    });
  }

  var order = { overdue: 0, today: 1, soon: 2 };
  out.sort(function(a, b) {
    if (order[a.bucket] !== order[b.bucket]) return order[a.bucket] - order[b.bucket];
    if (a.done !== b.done)                   return a.done ? 1 : -1;
    if (a.priority !== b.priority)           return a.priority - b.priority;
    return (a.date || '') < (b.date || '') ? -1 : 1;
  });

  return out;
}


/* ============================================================
 *  TODAY
 * ========================================================== */
function getToday() {
  var t = {
    water: 0, caffeine: 0,
    mood: null, moodAt: null,
    energy: null, energyAt: null,
    sleep: null, sleepDate: null, sleepManual: false, sleepStale: false,
    hrv: null, rhr: null, stress: null, weight: null,
    ctl: null, atl: null, tsb: null
  };

  var start = startOfDay(new Date());
  var end   = new Date(start.getTime() + 86400000);

  var log = ss().getSheetByName('LOG').getDataRange().getValues();
  for (var i = 1; i < log.length; i++) {
    var ts = log[i][0];
    if (!(ts instanceof Date) || ts < start || ts >= end) continue;

    var metric = String(log[i][1]).toLowerCase().trim();
    var val    = log[i][2];

    if (metric === 'water')    t.water    += Number(val) || 0;
    if (metric === 'caffeine') t.caffeine += Number(val) || 0;

    if (metric === 'mood'   && (!t.moodAt   || ts > t.moodAt))   { t.mood   = Number(val); t.moodAt   = ts; }
    if (metric === 'energy' && (!t.energyAt || ts > t.energyAt)) { t.energy = Number(val); t.energyAt = ts; }

    if (metric === 'sleep') { t.sleep = Number(val); t.sleepManual = true; }
  }

  t.moodAt   = t.moodAt   ? t.moodAt.toISOString()   : null;
  t.energyAt = t.energyAt ? t.energyAt.toISOString() : null;

  // Most recent NON-NULL per field, independently: Intervals writes ctl/atl
  // daily but sleep/hrv/rhr only when the watch actually synced, so "last
  // row" would hand back nulls for the watch fields.
  var w      = ss().getSheetByName('INTERVALS_WELLNESS').getDataRange().getValues();
  var fields = { rhr: 3, hrv: 4, weight: 5, stress: 7, ctl: 8, atl: 9 };

  for (var j = w.length - 1; j >= 1; j--) {
    var rowDate = w[j][0];
    if (!(rowDate instanceof Date)) continue;

    if (!t.sleepManual && t.sleep === null) {
      var sv = num(w[j][1]);
      if (sv !== null) { t.sleep = sv; t.sleepDate = rowDate.toISOString(); }
    }

    for (var f in fields) {
      if (t[f] === null) {
        var v = num(w[j][fields[f]]);
        if (v !== null) t[f] = v;
      }
    }
  }

  // A stale number that looks live is worse than no number at all.
  if (!t.sleepManual) {
    if (t.sleepDate === null) {
      t.sleepStale = true;
    } else {
      var sd  = startOfDay(new Date(t.sleepDate));
      var yst = new Date(start.getTime() - 86400000);
      t.sleepStale = (sd < yst);
    }
  }

  if (t.ctl !== null && t.atl !== null) t.tsb = round1(t.ctl - t.atl);

  return t;
}


/* ============================================================
 *  HISTORY
 * ========================================================== */
function getHistory() {
  var h = { ctl: [], atl: [], sleep14: [], mood14: [], energy14: [], stress14: [] };

  var w    = ss().getSheetByName('INTERVALS_WELLNESS').getDataRange().getValues();
  var rows = [];
  for (var i = 1; i < w.length; i++) {
    if (w[i][0] instanceof Date) rows.push(w[i]);
  }
  rows.sort(function(a, b){ return a[0] - b[0]; });

  rows.slice(-42).forEach(function(r){
    h.ctl.push(num(r[8]));
    h.atl.push(num(r[9]));
  });
  rows.slice(-14).forEach(function(r){
    h.sleep14.push(num(r[1]));
    h.stress14.push(num(r[7]));
  });

  var log   = ss().getSheetByName('LOG').getDataRange().getValues();
  var byDay = {};

  for (var j = 1; j < log.length; j++) {
    var ts = log[j][0];
    if (!(ts instanceof Date)) continue;
    var m = String(log[j][1]).toLowerCase().trim();
    if (m !== 'mood' && m !== 'energy') continue;

    var key = dayKey(ts);
    if (!byDay[key]) byDay[key] = { mood: [], energy: [] };
    byDay[key][m].push(Number(log[j][2]) || 0);
  }

  var today = startOfDay(new Date());
  for (var d = 13; d >= 0; d--) {
    var day = new Date(today.getTime() - d * 86400000);
    var rec = byDay[dayKey(day)];
    h.mood14.push(rec   && rec.mood.length   ? round1(mean(rec.mood))   : null);
    h.energy14.push(rec && rec.energy.length ? round1(mean(rec.energy)) : null);
  }

  return h;
}


/* ============================================================
 *  HABITS  --  weekly ring against a Days/Week target
 * ========================================================== */
function getHabits() {
  var hab = ss().getSheetByName('HABITS').getDataRange().getValues();
  var log = ss().getSheetByName('LOG').getDataRange().getValues();

  var hits = {};
  for (var i = 1; i < log.length; i++) {
    var ts = log[i][0];
    if (!(ts instanceof Date)) continue;

    var m = String(log[i][1]).toLowerCase().trim();

    // A journal entry only counts once it clears the same word threshold the
    // streak uses, or the habit ring and the streak disagree with each other.
    if (m === 'journal' && (Number(log[i][2]) || 0) < JOURNAL_MIN_WORDS) continue;

    hits[m + '|' + dayKey(ts)] = true;
  }

  var today  = startOfDay(new Date());
  var dow    = (today.getDay() + 6) % 7;                     // Mon = 0
  var wStart = new Date(today.getTime() - dow * 86400000);
  var out    = [];

  for (var j = 1; j < hab.length; j++) {
    var name = hab[j][0];
    if (!name || hab[j][1] !== true) continue;

    var key    = String(name).toLowerCase().trim().replace(/\s+/g, '_');
    var target = Number(hab[j][2]) || 7;

    // this week so far, Monday -> today
    var weekDone = 0;
    for (var d = 0; d <= dow; d++) {
      if (hits[key + '|' + dayKey(new Date(wStart.getTime() + d * 86400000))]) weekDone++;
    }

    // trailing 7 days, oldest first, for the dot strip
    var hist = [];
    for (var d2 = 6; d2 >= 0; d2--) {
      hist.push(hits[key + '|' + dayKey(new Date(today.getTime() - d2 * 86400000))] ? 1 : 0);
    }

    var streak = 0;
    for (var k = 0; k < 400; k++) {
      if (hits[key + '|' + dayKey(new Date(today.getTime() - k * 86400000))]) streak++;
      else if (k > 0) break;
    }

    out.push({
      name:      String(name).replace(/_/g, ' '),
      key:       key,
      target:    target,
      weekDone:  weekDone,
      weekPct:   Math.min(100, Math.round(100 * weekDone / target)),
      hist:      hist,
      streak:    streak,
      doneToday: hits[key + '|' + dayKey(today)] === true
    });
  }
  return out;
}


/* ============================================================
 *  GOALS
 *
 *  Every goal declares HOW it is measured. In v1 anything without an
 *  explicit branch fell through to counting LOG rows by its display
 *  name, which silently never matched -- so half the goals read zero
 *  no matter what you did.
 *
 *    days  -- distinct days with that metric   (French Practice)
 *    sum   -- add the values                   (Read -> pages)
 *    count -- number of entries                (Jobs Applied)
 *    hours -- INTERVALS_DATA moving time
 *    mean  -- INTERVALS_WELLNESS average
 * ========================================================== */
var GOAL_SOURCES = {
  'training_hours': { mode: 'hours' },
  'average_sleep':  { mode: 'mean',  col: 1 },
  'french_practice':{ mode: 'days',  metric: 'french' },
  'journal':        { mode: 'days',  metric: 'journal' },
  'read':           { mode: 'sum',   metric: 'read' },
  'books_read':     { mode: 'count', metric: 'book' },
  'jobs_applied':   { mode: 'count', metric: 'job_applied' }
};

function goalKey(name) {
  return String(name).toLowerCase().trim().replace(/\s+/g, '_');
}

function goalProgress(name, start, end) {
  var key = goalKey(name);
  var src = GOAL_SOURCES[key];

  // Unknown goal: count distinct days of a metric named after it. Predictable
  // rather than silently zero, and adding a row above makes it exact.
  if (!src) return countLogDays(key, start, end);

  if (src.mode === 'hours')
    return round1(sumRange('INTERVALS_DATA', 1, 4, start, end) / 60);

  if (src.mode === 'mean')
    return round1(meanRange('INTERVALS_WELLNESS', 0, src.col, start, end));

  if (src.mode === 'days')  return countLogDays(src.metric, start, end);
  if (src.mode === 'sum')   return round1(sumLogMetric(src.metric, start, end));
  return countLogMetric(src.metric, start, end);
}

function getMonthly() {
  var rows = ss().getSheetByName('GOAL_TARGETS').getDataRange().getValues();
  var now  = new Date();

  var mStart = new Date(now.getFullYear(), now.getMonth(), 1);
  var mEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  var dow    = (now.getDay() + 6) % 7;                       // Mon = 0
  var wStart = new Date(startOfDay(now).getTime() - dow * 86400000);
  var wEnd   = new Date(wStart.getTime() + 7 * 86400000);

  var out = { month: [], week: [] };

  for (var i = 1; i < rows.length; i++) {
    var name = rows[i][0];
    if (!name) continue;

    var target = Number(rows[i][1]) || 0;
    var unit   = rows[i][2] ? String(rows[i][2]) : '';
    var weekly = String(rows[i][3] || 'month').toLowerCase().trim().indexOf('week') === 0;

    var start = weekly ? wStart : mStart;
    var end   = weekly ? wEnd   : mEnd;
    var cur   = goalProgress(String(name), start, end);

    // Pace: where you SHOULD be by now, so the bar can say ahead or behind
    // rather than just showing a number that always looks short early on.
    var elapsed = weekly
      ? (dow + 1) / 7
      : now.getDate() / daysInMonth(now);

    // Early in a period the expected amount rounds below one whole unit, so
    // a strict comparison flags everything as behind on day one. Treat any
    // sub-unit expectation as neutral.
    var expected = target * elapsed;
    var onPace   = !target || expected < 1 || cur >= expected;

    out[weekly ? 'week' : 'month'].push({
      name:     String(name).trim(),
      cur:      cur,
      target:   target,
      unit:     unit,
      pct:      target ? Math.min(100, Math.round(100 * cur / target)) : 0,
      pace:     target ? Math.round(100 * elapsed) : 0,
      expected: round1(expected),
      onPace:   onPace
    });
  }
  return out;
}


/* ============================================================
 *  AGENDA
 * ========================================================== */
function getAgenda() {
  var days  = [];
  var today = startOfDay(new Date());

  for (var d = 0; d < 3; d++) {
    var start = new Date(today.getTime() + d * 86400000);
    var end   = new Date(start.getTime() + 86400000);
    var evts  = [];

    CALENDARS.forEach(function(calName){
      var cals = CalendarApp.getCalendarsByName(calName);
      if (!cals || !cals.length) return;             // missing calendar: skip quietly

      cals[0].getEvents(start, end).forEach(function(ev){
        evts.push({
          time:    ev.isAllDayEvent() ? 'ALL DAY'
                   : Utilities.formatDate(ev.getStartTime(), TZ, 'h:mma').toLowerCase(),
          sortKey: ev.isAllDayEvent() ? 0 : ev.getStartTime().getTime(),
          title:   ev.getTitle(),
          calendar: calName,
          allDay:  ev.isAllDayEvent()
        });
      });
    });

    evts.sort(function(a, b){ return a.sortKey - b.sortKey; });

    days.push({
      date:   start.toISOString(),
      label:  d === 0 ? 'TODAY' : Utilities.formatDate(start, TZ, 'EEE').toUpperCase(),
      events: evts
    });
  }
  return days;
}


/* ============================================================
 *  WEATHER  --  wttr.in, no key. Cached 30 min.
 * ========================================================== */
function getWeather() {
  var cache = CacheService.getScriptCache();
  var hit   = cache.get('weather2');
  if (hit) return JSON.parse(hit);

  var out = { current: null, days: [] };

  try {
    var url  = 'https://wttr.in/' + WEATHER_LOCATION + '?format=j1';
    var json = JSON.parse(UrlFetchApp.fetch(url, {muteHttpExceptions:true}).getContentText());

    var c = json.current_condition[0];
    out.current = {
      temp:     Number(c.temp_C),
      feels:    Number(c.FeelsLikeC),
      desc:     c.weatherDesc[0].value,
      humidity: Number(c.humidity),
      precip:   Number(c.precipMM)
    };

    for (var i = 0; i < 3 && i < json.weather.length; i++) {
      var d  = json.weather[i];
      var hr = [];

      d.hourly.forEach(function(h){        // 8 slots, 3-hour intervals
        hr.push({
          hour:     Math.floor(Number(h.time) / 100),
          temp:     Number(h.tempC),
          feels:    Number(h.FeelsLikeC),
          rain:     Number(h.chanceofrain),
          humidity: Number(h.humidity),
          desc:     h.weatherDesc[0].value.trim()
        });
      });

      out.days.push({
        max:      Number(d.maxtempC),
        min:      Number(d.mintempC),
        precip:   Number(d.totalSnow_cm) > 0 ? Number(d.totalSnow_cm) : null,
        desc:     d.hourly[4].weatherDesc[0].value.trim(),
        rain:     Math.max.apply(null, hr.map(function(h){ return h.rain; })),
        humidity: Math.round(hr.reduce(function(a,h){ return a + h.humidity; }, 0) / hr.length),
        hourly:   hr
      });
    }

    cache.put('weather2', JSON.stringify(out), 1800);
  } catch (err) {
    out.error = String(err);
  }

  return out;
}


/* ============================================================
 *  QUOTE
 * ========================================================== */
function getQuote() {
  var cache = CacheService.getScriptCache();
  var hit   = cache.get('quotes');
  var list;

  if (hit) {
    list = JSON.parse(hit);
  } else {
    try {
      var raw = UrlFetchApp.fetch('https://wisdom.ferrell.rocks/api/quotes',
                                  {muteHttpExceptions: true}).getContentText();
      var j = JSON.parse(raw);
      list = Array.isArray(j) ? j : (j.quotes || j.data || []);
      if (!list.length) throw new Error('empty');
      cache.put('quotes', JSON.stringify(list), 21600);
    } catch (err) {
      return { text: 'Telemetry is its own kind of wisdom.', source: 'OFFLINE' };
    }
  }

  var start = new Date(new Date().getFullYear(), 0, 0);
  var doy   = Math.floor((new Date() - start) / 86400000);
  var q     = list[doy % list.length];

  var text = q.quote || q.text || String(q);
  var src  = '';
  if (q.season && q.episode) {
    src = 'S' + pad2(q.season) + 'E' + pad2(q.episode)
        + (q.title ? ' \u2014 ' + String(q.title).toUpperCase() : '');
  }
  return { text: text, source: src };
}


/* ============================================================
 *  HELPERS
 * ========================================================== */
function ss()  { return SpreadsheetApp.getActiveSpreadsheet(); }
function pad2(n) { return ('0' + n).slice(-2); }

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function dayKey(d)     { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }

function daysInMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function num(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

function round1(v) { return v === null || isNaN(v) ? null : Math.round(v * 10) / 10; }

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce(function(a,b){ return a+b; }, 0) / arr.length;
}

function sumRange(sheetName, dateCol, col, start, end) {
  var rows = ss().getSheetByName(sheetName).getDataRange().getValues();
  var tot  = 0;
  for (var i = 1; i < rows.length; i++) {
    var d = rows[i][dateCol];
    if (!(d instanceof Date) || d < start || d >= end) continue;
    tot += Number(rows[i][col]) || 0;
  }
  return tot;
}

function meanRange(sheetName, dateCol, col, start, end) {
  var rows = ss().getSheetByName(sheetName).getDataRange().getValues();
  var vals = [];
  for (var i = 1; i < rows.length; i++) {
    var d = rows[i][dateCol];
    if (!(d instanceof Date) || d < start || d >= end) continue;
    var v = Number(rows[i][col]);
    if (!isNaN(v) && v > 0) vals.push(v);
  }
  return vals.length ? mean(vals) : 0;
}

function logRowsInRange(metric, start, end) {
  var rows = ss().getSheetByName('LOG').getDataRange().getValues();
  var out  = [];
  for (var i = 1; i < rows.length; i++) {
    var d = rows[i][0];
    if (!(d instanceof Date) || d < start || d >= end) continue;
    if (String(rows[i][1]).toLowerCase().trim() !== metric) continue;
    out.push(rows[i]);
  }
  return out;
}

function countLogMetric(metric, start, end) {
  return logRowsInRange(metric, start, end).length;
}

function sumLogMetric(metric, start, end) {
  return logRowsInRange(metric, start, end)
    .reduce(function(a, r){ return a + (Number(r[2]) || 0); }, 0);
}

/** Distinct days, so logging French twice on Tuesday still counts once. */
function countLogDays(metric, start, end) {
  var seen = {};
  logRowsInRange(metric, start, end).forEach(function(r){ seen[dayKey(r[0])] = true; });
  return Object.keys(seen).length;
}


/**
 * Diagnostic for an empty agenda. Lists every calendar this account can
 * actually see, then reports which entries in CALENDARS resolve and how
 * many events each returns over the next three days.
 *
 * A calendar's display name in the UI is not always the name the API
 * matches on, especially for subscribed or shared calendars.
 */
function testCalendars() {
  Logger.log('--- ALL CALENDARS VISIBLE TO THIS ACCOUNT ---');
  CalendarApp.getAllCalendars().forEach(function(c){
    Logger.log('  "' + c.getName() + '"   id=' + c.getId());
  });

  Logger.log('--- CALENDARS[] RESOLUTION ---');
  var start = startOfDay(new Date());
  var end   = new Date(start.getTime() + 3 * 86400000);

  CALENDARS.forEach(function(name){
    var cals = CalendarApp.getCalendarsByName(name);
    if (!cals || !cals.length) {
      Logger.log('  MISSING: "' + name + '"  <- no calendar with this exact name');
      return;
    }
    Logger.log('  ok: "' + name + '"  events next 3d = '
               + cals[0].getEvents(start, end).length);
  });
}


/* ============================================================
 *  TESTS  --  run from the editor, then View > Logs
 * ========================================================== */
function testEverything() {
  var r = JSON.parse(doGet({}).getContent());
  Logger.log('ok:      ' + r.ok);
  if (!r.ok) { Logger.log('ERROR:  ' + r.error); return; }
  Logger.log('today:   ' + JSON.stringify(r.today));
  Logger.log('tasks:   ' + r.tasks.length);
  Logger.log('habits:  ' + JSON.stringify(r.habits.map(function(h){
    return h.name + ' ' + h.weekDone + '/' + h.target;
  })));
  Logger.log('week:    ' + JSON.stringify(r.monthly.week));
  Logger.log('month:   ' + JSON.stringify(r.monthly.month));
  Logger.log('journal: streak ' + r.journal.streak + '  doc ' + r.journal.url);
  Logger.log('context: ' + JSON.stringify(r.context));
  Logger.log('agenda:  ' + JSON.stringify(r.agenda.map(function(d){
    return d.label + '=' + d.events.length;
  })));
  Logger.log('weather: ' + JSON.stringify(r.weather.current));
}

/** Creates the Journal doc and writes a test entry. Delete it afterwards. */
function testJournal() {
  Logger.log(JSON.stringify(appendJournal('Test entry from the script editor.', 'test')));
}

/** Confirms every goal resolves to a real source. */
function testGoals() {
  var rows = ss().getSheetByName('GOAL_TARGETS').getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var k = goalKey(rows[i][0]);
    Logger.log(k + ' -> ' + (GOAL_SOURCES[k]
      ? GOAL_SOURCES[k].mode
      : 'FALLBACK (counts distinct days of metric "' + k + '")'));
  }
}
