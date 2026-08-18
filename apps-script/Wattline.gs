/**
 * ============================================================
 *  WATTLINE  //  DAILY ENERGY BRIEF  (dashboard module)
 * ============================================================
 *
 *  PIPE
 *    Claude (6am cloud task) --writes .html--> Drive folder
 *      --> this module --> MASTERSHEET dashboard
 *
 *  No desktop, no sync client, no git. Apps Script reads Drive
 *  natively, so nothing between the cloud and the dashboard has
 *  to be awake at 6am.
 *
 *  WHY THE FILENAME CARRIES THE HEADLINE
 *    Drive gives you the file list for free but charges a full
 *    read for file CONTENT. Parsing <meta> tags out of every
 *    issue would mean N reads per dashboard load, growing without
 *    bound. So the index is built from filenames alone -- zero
 *    content reads -- and only the newest issue is opened, once,
 *    to pull its section list for the card. That read is cached.
 *
 *    Filenames look like:
 *      wattline-2026-08-18-001 - Churchill Falls is being rewritten.html
 *
 *    The <meta name="wattline-*"> tags still live inside each file
 *    as the authoritative source; the filename is just a fast index.
 *
 *  WIRING  (three edits to the existing project -- see bottom)
 *    1. doGet: serve the HTML view before the JSON path
 *    2. doGet: add  out.wattline = getWattline();
 *    3. frontend: render the card from data.wattline
 * ============================================================
 */

var WATTLINE_FOLDER_ID = '1yXK7JioGBjTR6WaVR-xo7S7J_R9dffPb';
var WATTLINE_CACHE_SEC = 1800;   // 30 min, same as weather


/* ============================================================
 *  INDEX  --  built from filenames, no content reads
 * ========================================================== */

/**
 * Every issue in the folder, newest first:
 *   [{id, issue, date, headline}, ...]
 *
 * Cached 30 min. A cache miss costs one folder listing, not N file reads.
 */
function wattlineIndex() {
  var cache = CacheService.getScriptCache();
  var hit   = cache.get('wattline_index');
  if (hit) return JSON.parse(hit);

  var out = [];

  try {
    var files = DriveApp.getFolderById(WATTLINE_FOLDER_ID).getFiles();

    while (files.hasNext()) {
      var f    = files.next();
      var name = f.getName();

      // wattline-YYYY-MM-DD-NNN [separator] Headline .html
      // Separator is tolerated as em dash, en dash, or hyphen, with or
      // without surrounding spaces, so a hand-renamed file still parses.
      var m = name.match(/^wattline-(\d{4}-\d{2}-\d{2})-(\d+)\s*[—–-]?\s*(.*)\.html$/i);
      if (!m) continue;

      out.push({
        id:       f.getId(),
        date:     m[1],
        issue:    m[2],
        headline: (m[3] || '').trim() || ('Issue ' + m[2])
      });
    }

    // Numeric compare on issue: a string compare puts "1000" before "999".
    out.sort(function(a, b){
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return (parseInt(b.issue, 10) || 0) - (parseInt(a.issue, 10) || 0);
    });

    cache.put('wattline_index', JSON.stringify(out), WATTLINE_CACHE_SEC);
  } catch (err) {
    // Never let a Drive hiccup take the dashboard down with it.
    return [];
  }

  return out;
}

/** Full HTML of one issue. */
function wattlineHtml(fileId) {
  return DriveApp.getFileById(fileId).getBlob().getDataAsString('UTF-8');
}

/**
 * The <meta name="wattline-*"> values from one issue.
 * One content read, cached separately so the archive index never pays for it.
 */
function wattlineMeta(fileId) {
  var cache = CacheService.getScriptCache();
  var key   = 'wattline_meta_' + fileId;
  var hit   = cache.get(key);
  if (hit) return JSON.parse(hit);

  var meta = { sections: '', readtime: '', headline: '' };

  try {
    var html = wattlineHtml(fileId);

    // Capture the opening quote and match the SAME character to close. The
    // old pattern stopped at either quote type, so a headline containing an
    // apostrophe was truncated at the apostrophe.
    ['sections', 'readtime', 'headline'].forEach(function(k){
      var re = new RegExp(
        '<meta\\s+name=[\'"]wattline-' + k + '[\'"]\\s+content=([\'"])([\\s\\S]*?)\\1',
        'i');
      var m = html.match(re);
      if (m) meta[k] = wattlineDecode_(m[2]);
    });

    cache.put(key, JSON.stringify(meta), 21600);   // 6h, issues are immutable
  } catch (err) { /* fall through with blanks */ }

  return meta;
}

function wattlineDecode_(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function wattlineEscape_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Clears both caches. Run from the editor after fixing a filename by hand. */
function wattlineRefresh() {
  var cache = CacheService.getScriptCache();
  cache.remove('wattline_index');
  var list = wattlineIndex();
  list.forEach(function(it){ cache.remove('wattline_meta_' + it.id); });
  Logger.log('wattline: %s issue(s) indexed', list.length);
  return list.length;
}


/* ============================================================
 *  JSON  --  goes into the dashboard payload
 * ========================================================== */

/**
 * Shaped like getWeather/getQuote: never throws, returns an
 * error field instead so out.ok stays true.
 *
 *   { count, unreadHint, latest: {...}, recent: [...], archiveUrl }
 */
function getWattline() {
  var out = { count: 0, latest: null, recent: [], archiveUrl: '' };

  try {
    var list = wattlineIndex();
    out.count = list.length;

    // getUrl() hands back the /dev URL when run from the editor, which
    // 403s for anyone not signed into the script. Force /exec so the link
    // works from the dashboard and the phone.
    var base = '';
    try { base = String(ScriptApp.getService().getUrl() || '').replace(/\/dev$/, '/exec'); }
    catch (err) {}
    out.base       = base;
    out.archiveUrl = base ? base + '?view=wattline' : '';

    if (!list.length) return out;

    var top  = list[0];
    var meta = wattlineMeta(top.id);

    out.latest = {
      id:       top.id,
      issue:    top.issue,
      date:     top.date,
      headline: meta.headline || top.headline,
      sections: meta.sections,
      readtime: meta.readtime,
      url:      base ? base + '?view=wattline&id=' + encodeURIComponent(top.id) : '',
      isToday:  top.date === dayKey(new Date())
    };

    // Enough for a small "previous issues" strip without another read.
    out.recent = list.slice(1, 8).map(function(it){
      return {
        id:       it.id,
        issue:    it.issue,
        date:     it.date,
        headline: it.headline,
        url:      base ? base + '?view=wattline&id=' + encodeURIComponent(it.id) : ''
      };
    });
  } catch (err) {
    out.error = String(err);
  }

  return out;
}


/* ============================================================
 *  HTML  --  serves an issue, or the archive index
 * ========================================================== */

/**
 * Returns an HtmlOutput, or null if this request is not for Wattline.
 * Call this at the very top of doGet, before expandRecurringTasks(),
 * so reading the brief never triggers a sheet write.
 *
 *   ?view=wattline              archive index
 *   ?view=wattline&latest=1     newest issue (bookmark this one)
 *   ?view=wattline&id=<fileId>  a specific issue
 */
function wattlineServe(e) {
  var p = (e && e.parameter) || {};
  if (p.view !== 'wattline') return null;

  var html;

  try {
    if (p.id) {
      html = wattlineHtml(p.id);
    } else if (p.latest === '1') {
      var list = wattlineIndex();
      html = list.length
        ? wattlineHtml(list[0].id)
        : wattlineArchiveHtml();
    } else {
      html = wattlineArchiveHtml();
    }
  } catch (err) {
    html = '<!DOCTYPE html><meta charset="utf-8">' +
           '<body style="font:16px system-ui;padding:40px;max-width:600px">' +
           '<h2>Wattline could not load that issue</h2><pre>' +
           wattlineEscape_(String(err)) + '</pre></body>';
  }

  return HtmlService.createHtmlOutput(html)
    .setTitle('Wattline')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}


function wattlineArchiveHtml() {
  var list = wattlineIndex();
  var base = '';
  try { base = ScriptApp.getService().getUrl(); } catch (err) {}

  function link(id) { return base + '?view=wattline&id=' + encodeURIComponent(id); }

  var body = '';

  if (!list.length) {
    body = '<p class="empty">No issues yet. The first one lands at 6:00 AM.</p>';
  } else {
    var top  = list[0];
    var meta = wattlineMeta(top.id);

    body += '<a class="feature" href="' + link(top.id) + '">' +
              '<span class="flag">Latest &middot; No. ' + wattlineEscape_(top.issue) + '</span>' +
              '<span class="fdate">' + wattlineEscape_(wattlineLongDate_(top.date)) +
                (meta.readtime ? ' &nbsp;&middot;&nbsp; ' + wattlineEscape_(meta.readtime) + ' min read' : '') +
              '</span>' +
              '<span class="fhead">' + wattlineEscape_(meta.headline || top.headline) + '</span>' +
              (meta.sections ? '<span class="fsec">' + wattlineEscape_(meta.sections) + '</span>' : '') +
            '</a>';

    if (list.length > 1) {
      body += '<h2 class="archh">Archive</h2><ul class="arch">';
      for (var i = 1; i < list.length; i++) {
        var it = list[i];
        body += '<li><a href="' + link(it.id) + '">' +
                  '<span class="no">' + wattlineEscape_(it.issue) + '</span>' +
                  '<span class="hd">' + wattlineEscape_(it.headline) + '</span>' +
                  '<span class="dt">' + wattlineEscape_(wattlineShortDate_(it.date)) + '</span>' +
                '</a></li>';
      }
      body += '</ul>';
    }
  }

  return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Wattline — Archive</title><style>' + WATTLINE_CSS + '</style></head>' +
    '<body><div class="wrap"><header class="mast"><h1>Wattline</h1><div class="sub">' +
      '<span>Archive &middot; ' + list.length + ' issue' + (list.length === 1 ? '' : 's') + '</span>' +
      '<span>New issue daily at 6:00 AM</span></div></header>' + body +
    '</div></body></html>';
}

function wattlineLongDate_(d) {
  var p = String(d).split('-');
  if (p.length !== 3) return d;
  var M = ['January','February','March','April','May','June',
           'July','August','September','October','November','December'];
  return (M[parseInt(p[1], 10) - 1] || p[1]) + ' ' + parseInt(p[2], 10) + ', ' + p[0];
}

function wattlineShortDate_(d) {
  var p = String(d).split('-');
  if (p.length !== 3) return d;
  var M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return (M[parseInt(p[1], 10) - 1] || p[1]) + ' ' + parseInt(p[2], 10);
}

var WATTLINE_CSS = [
  ':root{color-scheme:light dark;--surface:#fcfcfb;--plane:#f4f4f1;--ink1:#0b0b0b;',
  '--ink2:#52514e;--ink3:#898781;--rule:#e1e0d9;--blue:#2a78d6;',
  '--ring:rgba(11,11,11,.10);--hl:rgba(42,120,214,.08)}',
  '@media(prefers-color-scheme:dark){:root{--surface:#1a1a19;--plane:#0d0d0d;--ink1:#fff;',
  '--ink2:#c3c2b7;--ink3:#898781;--rule:#2c2c2a;--blue:#3987e5;',
  '--ring:rgba(255,255,255,.10);--hl:rgba(57,135,229,.12)}}',
  '*{box-sizing:border-box}',
  'body{margin:0;background:var(--plane);color:var(--ink1);',
  'font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}',
  '.wrap{max-width:760px;margin:0 auto;padding:0 20px 60px}',
  '.mast{padding:40px 0 16px;border-bottom:2px solid var(--ink1);margin-bottom:26px}',
  '.mast h1{margin:0;font-size:36px;line-height:1;letter-spacing:.14em;font-weight:800;text-transform:uppercase}',
  '.sub{display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between;margin-top:11px;',
  'font-size:12px;letter-spacing:.09em;text-transform:uppercase;color:var(--ink2);font-weight:600}',
  '.empty{color:var(--ink3);font-style:italic;padding:30px 0}',
  '.feature{display:block;text-decoration:none;color:inherit;background:var(--surface);',
  'border:1px solid var(--ring);border-left:3px solid var(--blue);border-radius:0 10px 10px 0;',
  'padding:20px 22px;margin-bottom:34px}',
  '.feature:hover{background:var(--hl)}',
  '.flag{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.11em;',
  'text-transform:uppercase;color:var(--blue);margin-bottom:8px}',
  '.fdate{display:block;font-size:12px;color:var(--ink3);margin-bottom:6px;font-variant-numeric:tabular-nums}',
  '.fhead{display:block;font-size:21px;font-weight:730;line-height:1.28;letter-spacing:-.01em;margin-bottom:9px}',
  '.fsec{display:block;font-size:13px;color:var(--ink2);line-height:1.5}',
  '.archh{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink3);',
  'font-weight:800;margin:0 0 4px;padding-bottom:8px;border-bottom:1px solid var(--rule)}',
  '.arch{list-style:none;padding:0;margin:0}',
  '.arch li{border-bottom:1px solid var(--rule)}',
  '.arch a{display:grid;grid-template-columns:44px 1fr 62px;gap:14px;align-items:baseline;',
  'padding:14px 4px;text-decoration:none;color:inherit}',
  '.arch a:hover{background:var(--hl)}',
  '.no{font-size:12px;font-weight:800;color:var(--blue);font-variant-numeric:tabular-nums;letter-spacing:.04em}',
  '.hd{font-size:15.5px;font-weight:650;line-height:1.35}',
  '.dt{font-size:12px;color:var(--ink3);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}',
  '@media(max-width:520px){.mast h1{font-size:26px;letter-spacing:.1em}',
  '.arch a{grid-template-columns:34px 1fr;gap:10px}.dt{display:none}.fhead{font-size:18px}}'
].join('');


/* ============================================================
 *  TEST  --  run from the editor, then View > Logs
 * ========================================================== */
function testWattline() {
  var list = wattlineIndex();
  Logger.log('indexed: %s issue(s)', list.length);
  list.forEach(function(it){
    Logger.log('  No.%s  %s  %s', it.issue, it.date, it.headline);
  });

  if (!list.length) {
    Logger.log('EMPTY -- check WATTLINE_FOLDER_ID and that filenames match');
    Logger.log('        wattline-YYYY-MM-DD-NNN - Headline.html');
    return;
  }

  Logger.log('payload: ' + JSON.stringify(getWattline(), null, 2));
}


/* ============================================================
 *  WIRING  --  three edits to the existing project
 * ============================================================
 *
 *  1. TOP OF doGet, before expandRecurringTasks(). Reading the brief
 *     should not trigger a sheet write.
 *
 *       function doGet(e) {
 *         var wl = wattlineServe(e);
 *         if (wl) return wl;              // <-- add these two lines
 *
 *         var out = {};
 *         try {
 *           expandRecurringTasks();
 *           ...
 *
 *  2. IN THE SAME try BLOCK, alongside the other payload fields:
 *
 *           out.quote    = getQuote();
 *           out.journal  = getJournalMeta();
 *           out.context  = getCurrentActivity();
 *           out.wattline = getWattline();   // <-- add this line
 *
 *  3. FRONTEND. data.wattline looks like:
 *
 *       {
 *         count: 1,
 *         archiveUrl: "https://script.google.com/.../exec?view=wattline",
 *         latest: {
 *           id, issue: "001", date: "2026-08-18",
 *           headline: "Churchill Falls is being rewritten...",
 *           sections: "Churchill Falls / Gull Island · IESO 2026 APO · ...",
 *           readtime: "28",
 *           url: ".../exec?view=wattline&id=...",
 *           isToday: true
 *         },
 *         recent: [ {id, issue, date, headline, url}, ... ]
 *       }
 *
 *     A minimal renderer, in the same shape as the rest of your cards:
 *
 *       function renderWattline(w) {
 *         if (!w || !w.latest) return '';
 *         var L = w.latest;
 *         return '' +
 *           '<div class="card wattline' + (L.isToday ? ' is-new' : '') + '">' +
 *             '<div class="card-head">' +
 *               '<span class="k">Wattline</span>' +
 *               '<span class="no">No. ' + L.issue + '</span>' +
 *             '</div>' +
 *             '<a class="wl-head" href="' + L.url + '" target="_blank" rel="noopener">' +
 *               L.headline + '</a>' +
 *             (L.sections ? '<div class="wl-sec">' + L.sections + '</div>' : '') +
 *             '<div class="wl-foot">' +
 *               '<span>' + L.date + (L.readtime ? ' · ' + L.readtime + ' min' : '') + '</span>' +
 *               '<a href="' + w.archiveUrl + '" target="_blank" rel="noopener">Archive →</a>' +
 *             '</div>' +
 *           '</div>';
 *       }
 *
 *  FIRST RUN
 *    Open the editor, select testWattline, Run. It will prompt for Drive
 *    authorization (new scope -- the existing deployment does not have it)
 *    and should log 1 issue. Then Deploy > Manage deployments > pencil >
 *    Version: New version, so the /exec URL stays the same.
 *
 *  BOOKMARK
 *    <your /exec URL>?view=wattline&latest=1
 *    Add to your phone home screen for a one-tap daily read.
 * ========================================================== */
