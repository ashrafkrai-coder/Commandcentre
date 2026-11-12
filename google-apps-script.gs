/**
 * COMMAND CENTRE SMKTM — Penerbit master-index.json (Google Apps Script)
 *
 * Membaca helaian "Relief" dan "Tugasan Guru" (juga "PWA" & "Jadual" jika ada),
 * menukar kepada skema master-index.json, dan menghantar ke GitHub (REST API)
 * dan/atau Webhook apabila helaian dikemaskini.
 *
 * Fail ini BOLEH diletak bersama Code.gs dalam projek yang sama: semua nama
 * global berawalan "ccx_" / "CCX_" dan tiada doGet/doPost/onEdit.
 *
 * TETAPAN (Project Settings > Script properties):
 *   GH_TOKEN   = token GitHub (fine-grained, kebenaran Contents: Read & write pada repo ini sahaja)
 *   GH_REPO    = pemilik/nama-repo          (cth. ashrafkrai-coder/Commandcentre)
 *   GH_BRANCH  = main                        (pilihan, lalai main)
 *   GH_PATH    = master-index.json           (pilihan)
 *   WEBHOOK_URL    = https://...             (pilihan; menerima POST JSON)
 *   WEBHOOK_SECRET = rahsia                  (pilihan; dihantar sebagai header X-CC-Secret)
 *   SEKOLAH    = SMK Taman Medan             (pilihan)
 *
 * PASANG SEKALI: jalankan ccx_pasangTrigger() (luluskan kebenaran).
 * UJI:           jalankan ccx_terbitSekarang() atau ccx_pratonton() (lihat Log).
 *
 * Aliran: suntingan helaian -> tanda "kotor" -> setiap minit, jika kotor -> terbit.
 * (Mengelakkan satu commit GitHub bagi setiap ketukan kekunci. Kandungan tidak berubah = tiada commit.)
 */

var CCX_TZ = 'Asia/Kuala_Lumpur';
var CCX_ENGINE_VERSION = '2.0.0';
var CCX_SHEETS = { relief: ['Relief'], tasks: ['Tugasan Guru', 'Tugasan'], pwa: ['PWA'], jadual: ['Jadual'] };

/* ---------------- Trigger ---------------- */

function ccx_pasangTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'ccx_onEdit' || f === 'ccx_onChange' || f === 'ccx_semakDanTerbit') ScriptApp.deleteTrigger(t);
  });
  var ss = SpreadsheetApp.getActive();
  ScriptApp.newTrigger('ccx_onEdit').forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger('ccx_onChange').forSpreadsheet(ss).onChange().create();   // baris dipadam/ditambah, borang Google
  ScriptApp.newTrigger('ccx_semakDanTerbit').timeBased().everyMinutes(1).create();
  PropertiesService.getScriptProperties().setProperty('CCX_KOTOR', '1');
  Logger.log('Trigger dipasang. Terbitan pertama dalam masa seminit.');
}

function ccx_onEdit(e) { ccx_tandaKotor_(e && e.range && e.range.getSheet().getName()); }
function ccx_onChange(e) { ccx_tandaKotor_(); }

function ccx_tandaKotor_(sheetName) {
  if (sheetName && !ccx_dikenali_(sheetName)) return;   // abaikan helaian lain
  PropertiesService.getScriptProperties().setProperty('CCX_KOTOR', '1');
}

function ccx_dikenali_(name) {
  var n = ccx_kunci_(name);
  return Object.keys(CCX_SHEETS).some(function (k) {
    return CCX_SHEETS[k].some(function (x) { return ccx_kunci_(x) === n; });
  });
}

function ccx_semakDanTerbit() {
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('CCX_KOTOR') !== '1') return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    p.deleteProperty('CCX_KOTOR');            // padam dahulu: suntingan semasa terbitan akan menanda semula
    ccx_terbitSekarang();
  } catch (err) {
    p.setProperty('CCX_KOTOR', '1');          // cuba lagi pada minit berikutnya
    console.error('Terbitan gagal: ' + err.message);
  } finally {
    lock.releaseLock();
  }
}

/* ---------------- Terbit ---------------- */

function ccx_pratonton() { Logger.log(JSON.stringify(ccx_bina_(), null, 2)); }

function ccx_terbitSekarang() {
  var master = ccx_bina_();
  var hasil = [];
  var p = PropertiesService.getScriptProperties();
  if (p.getProperty('GH_TOKEN') && p.getProperty('GH_REPO')) hasil.push('GitHub: ' + ccx_hantarGitHub_(master));
  if (p.getProperty('WEBHOOK_URL')) hasil.push('Webhook: ' + ccx_hantarWebhook_(master));
  if (!hasil.length) throw new Error('Tiada destinasi: tetapkan GH_TOKEN + GH_REPO dan/atau WEBHOOK_URL dalam Script properties.');
  Logger.log(hasil.join(' | '));
  return hasil;
}

/* ---------------- GitHub REST API ---------------- */

function ccx_hantarGitHub_(master) {
  var p = PropertiesService.getScriptProperties();
  var repo = p.getProperty('GH_REPO'), branch = p.getProperty('GH_BRANCH') || 'main', path = p.getProperty('GH_PATH') || 'master-index.json';
  var url = 'https://api.github.com/repos/' + repo + '/contents/' + path.split('/').map(encodeURIComponent).join('/');
  var head = {
    Authorization: 'Bearer ' + p.getProperty('GH_TOKEN'),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  // 1) Dapatkan sha + kandungan semasa
  var cur = UrlFetchApp.fetch(url + '?ref=' + encodeURIComponent(branch), { headers: head, muteHttpExceptions: true });
  var sha = null;
  if (cur.getResponseCode() === 200) {
    var info = JSON.parse(cur.getContentText());
    sha = info.sha;
    try {   // abaikan last_updated: tiada perubahan sebenar = tiada commit
      var lama = JSON.parse(Utilities.newBlob(Utilities.base64Decode(info.content.replace(/\n/g, ''))).getDataAsString());
      if (ccx_sig_(lama) === ccx_sig_(master)) return 'tiada perubahan';
    } catch (e) { /* fail lama rosak: tulis ganti */ }
  } else if (cur.getResponseCode() !== 404) {
    throw new Error('GitHub GET ' + cur.getResponseCode() + ': ' + cur.getContentText().slice(0, 200));
  }

  // 2) Commit
  var body = {
    message: 'Kemas kini master-index.json (Google Sheets) ' + master.school_info.last_updated,
    content: Utilities.base64Encode(Utilities.newBlob(JSON.stringify(master, null, 2) + '\n').getBytes()),
    branch: branch
  };
  if (sha) body.sha = sha;
  var res = UrlFetchApp.fetch(url, { method: 'put', contentType: 'application/json', headers: head, payload: JSON.stringify(body), muteHttpExceptions: true });
  var code = res.getResponseCode();
  if (code !== 200 && code !== 201) throw new Error('GitHub PUT ' + code + ': ' + res.getContentText().slice(0, 300));
  return 'commit ' + JSON.parse(res.getContentText()).commit.sha.slice(0, 7);
}

function ccx_sig_(m) {
  var c = JSON.parse(JSON.stringify(m));
  if (c.school_info) delete c.school_info.last_updated;
  return JSON.stringify(c);
}

/* ---------------- Webhook ---------------- */

function ccx_hantarWebhook_(master) {
  var p = PropertiesService.getScriptProperties();
  var headers = {};
  if (p.getProperty('WEBHOOK_SECRET')) headers['X-CC-Secret'] = p.getProperty('WEBHOOK_SECRET');
  var res = UrlFetchApp.fetch(p.getProperty('WEBHOOK_URL'), {
    method: 'post', contentType: 'application/json', headers: headers, payload: JSON.stringify(master), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) throw new Error('Webhook ' + code + ': ' + res.getContentText().slice(0, 200));
  return 'HTTP ' + code;
}

/* ---------------- Binaan skema master-index.json ---------------- */

function ccx_bina_() {
  var now = new Date();
  var relief = ccx_baca_(CCX_SHEETS.relief).map(ccx_mapRelief_).filter(Boolean);
  var tasks = ccx_baca_(CCX_SHEETS.tasks).map(ccx_mapTask_).filter(Boolean);
  var tiles = ccx_baca_(CCX_SHEETS.pwa).map(ccx_mapTile_).filter(Boolean);
  var sched = ccx_susunJadual_(ccx_baca_(CCX_SHEETS.jadual).map(ccx_mapEvent_).filter(Boolean));
  var cnt = function (arr, s) { return arr.filter(function (x) { return x.status === s; }).length; };

  return {
    school_info: {
      name: PropertiesService.getScriptProperties().getProperty('SEKOLAH') || 'SMK Taman Medan',
      short_name: 'SMKTM',
      engine_version: CCX_ENGINE_VERSION,
      schema_version: '1.0',
      timezone: CCX_TZ,
      last_updated: Utilities.formatDate(now, CCX_TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      source: 'google-sheets'
    },
    relief: relief,
    tasks: tasks,
    pwa_tiles: tiles,
    schedule: sched,
    telemetry: {
      critical: { count: cnt(tasks, 'st-lewat'), label: 'Tugasan lewat' },
      warn: { count: cnt(tasks, 'st-hari'), label: 'Tugasan tamat hari ini' },
      ok: { count: cnt(tasks, 'st-selesai'), label: 'Tugasan selesai' },
      info: { count: cnt(relief, 'st-perlu'), label: 'Relief belum ditugaskan' }
    }
  };
}

function ccx_mapRelief_(r, i) {
  var kelas = ccx_ambil_(r, 'kelas'), absen = ccx_ambil_(r, 'guruTidakHadir', 'guruAbsen', 'guruTiadaHadir');
  if (!kelas && !absen) return null;
  var ganti = ccx_ambil_(r, 'guruRelief', 'guruGanti', 'guruRelief');
  var st = ccx_kunci_(ccx_ambil_(r, 'status'));
  var status = /selesai|done|siap/.test(st) ? 'done' : (ganti ? 'st-tugas' : 'st-perlu');
  return {
    id: ccx_ambil_(r, 'localId', 'id') || 'rl-' + ('000' + (i + 1)).slice(-3),
    kelas: kelas, guru_absen: absen, guru_ganti: ganti,
    masa: ccx_masa_(ccx_ambil_(r, 'masa')), status: status
  };
}

function ccx_mapTask_(r, i) {
  var title = ccx_ambil_(r, 'tajuk', 'tajukTugasan', 'tugasan');
  if (!title) return null;
  var pct = parseFloat(String(ccx_ambil_(r, 'kemajuan', 'kemajuanPct')).replace('%', ''));
  pct = isNaN(pct) ? 0 : (pct > 0 && pct <= 1 ? pct * 100 : pct);   // sel berformat peratus = 0..1
  pct = Math.max(0, Math.min(100, Math.round(pct)));
  var due = ccx_tarikh_(ccx_ambil_(r, 'akhir', 'tarikhAkhir', 'tarikh'));
  var st = ccx_kunci_(ccx_ambil_(r, 'status'));
  var hari = Utilities.formatDate(new Date(), CCX_TZ, 'yyyy-MM-dd');
  var status = 'st-proses';
  if (pct >= 100 || /selesai|done|siap/.test(st)) status = 'st-selesai';
  else if (due && due < hari) status = 'st-lewat';
  else if (due && due === hari) status = 'st-hari';
  return {
    id: ccx_ambil_(r, 'localId', 'id') || 'tk-' + ('000' + (i + 1)).slice(-3),
    title: title, pic: ccx_ambil_(r, 'pic', 'pegawai'), due: due,
    progress_percent: pct, status: status
  };
}

function ccx_mapTile_(r, i) {
  var title = ccx_ambil_(r, 'nama', 'namaAplikasi');
  if (!title) return null;
  var aktif = ccx_ambil_(r, 'aktif');
  if (aktif !== '' && /^(tidak|no|false|0|x)$/i.test(String(aktif).trim())) return null;
  var st = ccx_kunci_(ccx_ambil_(r, 'status'));
  return {
    id: 'pw-' + ('000' + (i + 1)).slice(-3), title: title,
    category: ccx_ambil_(r, 'kategori') || 'Umum',
    status: /semak|check|warn/.test(st) ? 'd-semak' : 'd-online',
    icon_path: ccx_ambil_(r, 'ikon') || 'icons/icon-192.png',
    url: ccx_ambil_(r, 'pautan', 'url')
  };
}

function ccx_mapEvent_(r, i) {
  var a = ccx_masa_(ccx_ambil_(r, 'mula', 'masaMula')), b = ccx_masa_(ccx_ambil_(r, 'tamat', 'masaTamat'));
  var event = ccx_ambil_(r, 'acara');
  if (!a || !event) return null;
  return { id: 'sc-' + ('000' + (i + 1)).slice(-3), time: b ? a + '-' + b : a, event: event, location: ccx_ambil_(r, 'lokasi'), status: '' };
}

function ccx_susunJadual_(list) {
  list.sort(function (x, y) { return x.time < y.time ? -1 : 1; });
  var nm = Number(Utilities.formatDate(new Date(), CCX_TZ, 'H')) * 60 + Number(Utilities.formatDate(new Date(), CCX_TZ, 'm'));
  var next = false;
  list.forEach(function (e) {
    var p = e.time.split('-'), a = ccx_minit_(p[0]), b = p[1] ? ccx_minit_(p[1]) : a + 60;
    if (nm >= a && nm < b) e.status = 'now';
    else if (nm >= b) e.status = 'past';
    else if (!next) { e.status = 'next'; next = true; }
  });
  return list;   // klien mengira semula status mengikut jam peranti
}

/* ---------------- Pembantu helaian ---------------- */

function ccx_kunci_(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, ''); }

function ccx_cariHelaian_(names) {
  var all = SpreadsheetApp.getActive().getSheets();
  for (var n = 0; n < names.length; n++) {
    for (var i = 0; i < all.length; i++) if (ccx_kunci_(all[i].getName()) === ccx_kunci_(names[n])) return all[i];
  }
  return null;
}

/* Baris -> objek { kunciPengepalaTernormal: nilai } */
function ccx_baca_(names) {
  var sh = ccx_cariHelaian_(names);
  if (!sh || sh.getLastRow() < 2 || sh.getLastColumn() < 1) return [];
  var rng = sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn());
  var vals = rng.getValues(), disp = rng.getDisplayValues();
  var head = vals[0].map(ccx_kunci_), out = [];
  for (var r = 1; r < vals.length; r++) {
    if (vals[r].every(function (c) { return c === '' || c === null; })) continue;
    var o = {};
    head.forEach(function (k, c) {
      if (!k) return;
      var v = vals[r][c];
      if (v instanceof Date) o[k] = (v.getFullYear() < 1950) ? ccx_masa_(disp[r][c]) : Utilities.formatDate(v, CCX_TZ, 'yyyy-MM-dd');
      else o[k] = (typeof v === 'string') ? v.trim() : v;
    });
    out.push(o);
  }
  return out;
}

/* Ambil nilai pertama yang wujud antara beberapa nama lajur */
function ccx_ambil_(row) {
  for (var i = 1; i < arguments.length; i++) {
    var v = row[ccx_kunci_(arguments[i])];
    if (v !== undefined && v !== '') return v;
  }
  return '';
}

/* "8:00:00 AM" / "08:00" / "20.30" / Date -> "HH:mm" */
function ccx_masa_(s) {
  var m = /(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*([AaPp][Mm])?/.exec(String(s));
  if (!m) return String(s || '');
  var h = Number(m[1]), ap = (m[3] || '').toLowerCase();
  if (ap === 'pm' && h < 12) h += 12;
  if (ap === 'am' && h === 12) h = 0;
  return (h < 10 ? '0' : '') + h + ':' + m[2];
}

function ccx_minit_(t) { var m = /(\d{1,2}):(\d{2})/.exec(t); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; }

/* yyyy-MM-dd, dd/MM/yyyy, dd-MM-yyyy -> yyyy-MM-dd */
function ccx_tarikh_(s) {
  s = String(s || '').trim();
  if (!s) return '';
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})$/.exec(s);
  if (m) return m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2);
  return '';
}
