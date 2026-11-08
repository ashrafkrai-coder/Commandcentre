/**
 * COMMAND CENTRE SMKTM — Google Apps Script (Web App)
 *
 * Terikat pada Google Sheet (Extensions > Apps Script). Tab yang digunakan:
 *   Tugasan  : tajuk | pic | unit | akhir | status | kemajuan | localId
 *   Relief   : tarikh | masa | kelas | guruTidakHadir | guruRelief | status | nota | localId
 *   PWA      : nama | pautan | kategori | aktif | urutan | status
 *   Jadual   : mula | tamat | acara | lokasi
 *   Pengumuman : teks | aktif            (lajur A = teks; "aktif" pilihan)
 *   Telegram : masa | kumpulan | pengirim | teks | id | papar
 * Nama pengepala boleh ditulis "guruTidakHadir" ATAU "Guru Tidak Hadir" (huruf besar/kecil tidak penting).
 *
 * TETAPAN SEKALI SAHAJA:
 *   Project Settings > Script properties > tambah
 *     CC_KEY    = kunci akses rahsia (PILIHAN; jika kosong/tiada, dashboard terbuka tanpa kunci)
 *     SEKOLAH   = SMK Taman Medan        (pilihan)
 *     REFRESH   = 30                      (pilihan, saat)
 *
 * DEPLOY: Deploy > Manage deployments > Edit > Version: New version > Deploy
 *   Execute as: Me   |   Who has access: Anyone
 *   (URL /exec kekal sama; tampal dalam config.js)
 *
 * API (GET, JSON, CORS dibenarkan oleh Apps Script):
 *   ?api=data&key=KUNCI
 *   ?api=save&action=append&sheet=Tugasan|Relief|Telegram&type=...&key=KUNCI&data={JSON}
 */

var SHEETS_SAVE = ['Tugasan', 'Relief', 'Telegram'];   // tab yang boleh ditulis dari dashboard
var TZ = Session.getScriptTimeZone() || 'Asia/Kuala_Lumpur';

/* ---------------- Titik masuk ---------------- */
function doGet(e) {
  var p = (e && e.parameter) || {};
  try {
    if (p.api === 'debug') return json_(debugInfo_(p.key));
    if (p.api === 'data') return json_(dataDashboard(p.key));
    if (p.api === 'save') {
      var payload = {
        sheet: p.sheet,
        type: p.type,
        action: p.action,
        key: p.key,
        row: JSON.parse(p.data || '{}')
      };
      return json_(saveDashboard(payload));
    }
    if (p.api) return json_({ error: 'api tidak dikenali' });
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
  // Tiada ?api= : papar dashboard dalam Apps Script (jika fail Index.html wujud)
  try {
    return HtmlService.createHtmlOutputFromFile('Index')
      .setTitle('Command Centre SMKTM')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    return json_({ ok: true, info: 'Command Centre API aktif. Gunakan ?api=data&key=...' });
  }
}

/* Pilihan: terima POST (cth. skrip Tampermonkey Telegram) — badan JSON {key, sheet, row} */
function doPost(e) {
  try {
    var b = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    return json_(saveDashboard(b));
  } catch (err) {
    return json_({ error: String(err && err.message || err) });
  }
}

/* ---------------- Dipanggil juga melalui google.script.run ---------------- */
function dataDashboard(key) {
  checkKey_(key);
  var props = PropertiesService.getScriptProperties();
  var tg = readSheet_('Telegram').filter(function (m) {
    var s = String(m.papar === undefined ? 'ya' : m.papar).toLowerCase();
    return s !== 'tidak' && s !== 'false' && s !== 'no' && s !== '0';
  });
  tg.sort(function (a, b) { return String(b.masa).localeCompare(String(a.masa)) || (b._row - a._row); });

  return {
    sekolah: props.getProperty('SEKOLAH') || 'SMK Taman Medan',
    refresh: Number(props.getProperty('REFRESH')) || 30,
    tugasan: readSheet_('Tugasan').filter(function (t) { return t.tajuk; }).map(function (t) {
      t.kemajuan = Number(t.kemajuan) || 0;
      return t;
    }),
    relief: readSheet_('Relief').filter(function (r) { return r.kelas; })
      .sort(function (a, b) { return String(b.tarikh + b.masa).localeCompare(String(a.tarikh + a.masa)); }),
    pwa: readSheet_('PWA')
      .filter(function (p) { return p.nama && isAktif_(p.aktif); })
      .map(function (p) { var s = String(p.status || '').toLowerCase(); p.status = (s === 'online' || s === 'semak' || s === 'luar') ? s : 'na'; return p; })
      .sort(function (a, b) { return (Number(a.urutan) || 999) - (Number(b.urutan) || 999); }),
    jadual: readSheet_('Jadual').filter(function (j) {
        // jika tab ada lajur "tarikh", papar hanya acara hari ini
        return j.acara && (!j.tarikh || j.tarikh === Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
      })
      .sort(function (a, b) { return String(a.mula).localeCompare(String(b.mula)); }),
    pengumuman: readSheet_('Pengumuman')
      .filter(function (x) { return (x.teks || x.pengumuman) && isAktif_(x.aktif); })
      .map(function (x) { return String(x.teks || x.pengumuman); }),
    telegram: tg.slice(0, 50)
  };
}

function saveDashboard(payload) {
  checkKey_(payload && payload.key);
  var name = payload.sheet;
  if (SHEETS_SAVE.indexOf(name) === -1) throw new Error('Tab tidak dibenarkan: ' + name);
  var row = payload.row || {};
  if (payload.action === 'delete') return deleteRow_(name, row);
  if (payload.action === 'update') return updateRow_(name, row);

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(name) || createSheet_(name);   // cipta tab jika belum ada
    var head = headers_(sh);
    if (!head.length) throw new Error('Tab ' + name + ' tiada pengepala (baris 1).');

    // Elak rekod berganda apabila dashboard cuba semula (localId / id)
    var idKey = row.localId ? 'localId' : (row.id ? 'id' : '');
    if (idKey) {
      var col = head.indexOf(idKey);
      if (col >= 0 && sh.getLastRow() > 1) {
        var ids = sh.getRange(2, col + 1, sh.getLastRow() - 1, 1).getValues();
        for (var i = 0; i < ids.length; i++) {
          if (String(ids[i][0]) === String(row[idKey])) return { ok: true, duplicate: true };
        }
      }
    }

    var out = head.map(function (k) {
      var v = row[k];
      if (v === undefined) { var al = ALIAS[k.toLowerCase()]; if (al) v = row[al]; }
      return v === undefined || v === null ? '' : v;
    });
    sh.appendRow(out);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

/* Cari baris: ikut localId; jika tiada, guna nombor baris (_row) tetapi hanya jika nilai semakan
 * (row._check, atau kelas+tarikh+masa) sepadan — elak ubah/padam baris salah apabila baris bergeser. */
function findRow_(head, vals, row) {
  var i, c;
  function rec(idx) {
    var o = {};
    head.forEach(function (k, ci) { if (k) o[k] = fmtCell_(k, vals[idx][ci], undefined); });
    return o;
  }
  if (row.localId) {
    c = head.indexOf('localId');
    if (c >= 0) for (i = 0; i < vals.length; i++) if (String(vals[i][c]) === String(row.localId)) return i;
  }
  if (row._row) {
    i = Number(row._row) - 2;
    if (i >= 0 && i < vals.length) {
      var chk = row._check || { kelas: row.kelas, tarikh: row.tarikh, masa: row.masa };
      var r = rec(i), ok = true;
      Object.keys(chk).forEach(function (k) { if (String(r[k]) !== String(chk[k])) ok = false; });
      if (ok) return i;
    }
  }
  return -1;
}

function withRow_(name, row, fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = getSheet_(name);
    if (!sh) throw new Error('Tab tidak dijumpai: ' + name);
    if (sh.getLastRow() < 2) return { ok: true, found: 0 };
    var head = headers_(sh);
    var vals = sh.getRange(2, 1, sh.getLastRow() - 1, head.length).getValues();
    var idx = findRow_(head, vals, row);
    if (idx < 0) return { ok: true, found: 0 };
    return fn(sh, head, idx + 2);
  } finally {
    lock.releaseLock();
  }
}

/* Padam rekod (batal relief / tugasan) */
function deleteRow_(name, row) {
  return withRow_(name, row, function (sh, head, r) {
    sh.deleteRow(r);
    return { ok: true, found: 1, deleted: 1 };
  });
}

/* Kemas kini rekod sedia ada (edit tugasan). Hanya medan yang dihantar diubah. */
function updateRow_(name, row) {
  var res = withRow_(name, row, function (sh, head, r) {
    head.forEach(function (k, ci) {
      if (!k || k === 'localId' && !row.localId) return;
      if (row[k] !== undefined && row[k] !== null) sh.getRange(r, ci + 1).setValue(row[k]);
    });
    return { ok: true, found: 1, updated: 1 };
  });
  if (!res.found) throw new Error('Rekod tidak dijumpai dalam Sheet (mungkin sudah dipadam atau diubah). Muat semula dashboard.');
  return res;
}

/* ---------------- Semakan status PWA (pilihan) ----------------
 * Jalankan setupTriggers() sekali untuk semak pautan tab "PWA" setiap 10 minit.
 * Lajur "status" diisi: online | semak | luar */
function semakPwa() {
  var sh = getSheet_('PWA');
  if (!sh || sh.getLastRow() < 2) return;
  var head = headers_(sh);
  var cUrl = head.indexOf('pautan'), cSt = head.indexOf('status');
  if (cUrl < 0 || cSt < 0) return;
  var urls = sh.getRange(2, cUrl + 1, sh.getLastRow() - 1, 1).getValues();
  var res = urls.map(function (r) {
    var u = String(r[0] || '');
    if (!/^https?:\/\//i.test(u)) return ['luar'];
    try {
      var c = UrlFetchApp.fetch(u, { muteHttpExceptions: true, followRedirects: true }).getResponseCode();
      return [c < 400 ? 'online' : (c < 500 ? 'semak' : 'luar')];
    } catch (e) { return ['luar']; }
  });
  sh.getRange(2, cSt + 1, res.length, 1).setValues(res);
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'semakPwa') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('semakPwa').timeBased().everyMinutes(10).create();
}

/* ---------------- Pembantu ---------------- */
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function checkKey_(key) {
  var real = String(PropertiesService.getScriptProperties().getProperty('CC_KEY') || '').trim();
  if (!real) return;   // CC_KEY kosong = tiada kunci diperlukan (akses terbuka)
  if (!key || String(key).trim() !== real) throw new Error('unauthorized');
}

function isAktif_(v) {
  if (v === undefined || v === '' || v === null) return true;
  var s = String(v).toLowerCase();
  return !(s === 'tidak' || s === 'false' || s === 'no' || s === '0' || s === 'x');
}

/* "Guru Tidak Hadir" / "guru_tidak_hadir" -> guruTidakHadir ; "localId" kekal */
function normHeader_(h) {
  h = String(h).trim();
  if (!/[\s_\-]/.test(h)) return h.charAt(0).toLowerCase() + h.slice(1);
  var w = h.toLowerCase().split(/[\s_\-]+/).filter(String);
  return w[0] + w.slice(1).map(function (x) { return x.charAt(0).toUpperCase() + x.slice(1); }).join('');
}

function headers_(sh) {
  if (sh.getLastColumn() < 1) return [];
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normHeader_);
}

/* Pengepala lalai untuk tab yang dicipta automatik */
var DEFAULT_HEADERS = {
  'Tugasan': ['tajuk', 'pic', 'unit', 'akhir', 'status', 'kemajuan', 'localId'],
  'Relief': ['tarikh', 'masa', 'kelas', 'guruTidakHadir', 'guruRelief', 'status', 'nota', 'localId'],
  'Telegram': ['masa', 'kumpulan', 'pengirim', 'mesej', 'chatId', 'messageId']
};

function createSheet_(name) {
  var h = DEFAULT_HEADERS[name];
  if (!h) throw new Error('Tab tidak dijumpai: ' + name);
  var sh = SpreadsheetApp.getActive().insertSheet(name);
  sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

/* Nama lajur lain yang diterima -> nama standard dashboard */
var ALIAS = {
  'mesej': 'teks', 'mesejtelegram': 'teks', 'pesanan': 'teks',
  'messageid': 'id',
  'masamula': 'mula', 'masabermula': 'mula', 'masatamat': 'tamat', 'masaakhir': 'tamat',
  'namaaplikasi': 'nama', 'aplikasi': 'nama', 'namapwa': 'nama', 'namaapp': 'nama',
  'url': 'pautan', 'link': 'pautan', 'pautanpwa': 'pautan',
  'tajuktugasan': 'tajuk', 'tugasan': 'tajuk', 'tarikhakhir': 'akhir',
  'pegawai': 'pic', 'kemajuanpct': 'kemajuan'
};

function getSheet_(name) {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(name);
  if (sh) return sh;
  var want = String(name).toLowerCase().replace(/\s+/g, '');
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    if (all[i].getName().toLowerCase().replace(/\s+/g, '') === want) return all[i];
  }
  return null;
}

/* "8:00:00 AM" / "08:00" / "20.30" -> "HH:mm" */
function parseTime_(s) {
  var m = /(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*([AaPp][Mm])?/.exec(String(s));
  if (!m) return String(s);
  var h = Number(m[1]), ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return (h < 10 ? '0' : '') + h + ':' + m[2];
}

function fmtCell_(key, v, display) {
  if (v instanceof Date) {
    // Sel masa sahaja (tahun 1899): guna teks paparan Sheet supaya minit tidak tersasar oleh zon masa
    if (v.getFullYear() < 1950) return display !== undefined ? parseTime_(display) : Utilities.formatDate(v, TZ, 'HH:mm');
    if (key === 'masa') return v.toISOString();   // cap masa Telegram
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  return v;
}

function readSheet_(name) {
  var sh = getSheet_(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var head = headers_(sh);
  var rng = sh.getRange(2, 1, sh.getLastRow() - 1, head.length);
  var vals = rng.getValues(), disp = rng.getDisplayValues();
  var out = [];
  vals.forEach(function (r, idx) {
    if (r.every(function (c) { return c === '' || c === null; })) return;
    var o = { _row: idx + 2 };
    head.forEach(function (k, i) { if (k) o[k] = fmtCell_(k, r[i], disp[idx][i]); });
    head.forEach(function (k) {                       // tambah nama standard jika belum ada
      var al = ALIAS[String(k).toLowerCase()];
      if (al && (o[al] === undefined || o[al] === '')) o[al] = o[k];
    });
    if (o.messageId !== undefined && o.messageId !== '') o.id = (o.chatId || '') + '|' + o.messageId;
    out.push(o);
  });
  return out;
}

/* Semak tab & pengepala yang dilihat oleh skrip: ?api=debug&key=... */
function debugInfo_(key) {
  checkKey_(key);
  return SpreadsheetApp.getActive().getSheets().map(function (sh) {
    return { tab: sh.getName(), baris: sh.getLastRow(), pengepala: sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [] };
  });
}
