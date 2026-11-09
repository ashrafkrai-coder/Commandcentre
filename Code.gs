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
 *     CLASSROOM_API   = on                (pilihan; hidupkan bacaan tugasan Classroom melalui API. MATI secara lalai; perlu kebenaran pentadbir)
 *     CLASSROOM_KELAS = 838802788260      (pilihan, hanya jika CLASSROOM_API=on; ID/pautan kelas Classroom yang dipaparkan, koma untuk lebih satu)
 *
 * DEPLOY: Deploy > Manage deployments > Edit > Version: New version > Deploy
 *   Execute as: Me   |   Who has access: Anyone
 *   (URL /exec kekal sama; tampal dalam config.js)
 *
 * CLASSROOM (jika "Google Classroom API" tiada dalam senarai Services):
 *   Project Settings > tandakan "Show appsscript.json manifest file in editor" > buka appsscript.json > tambah dalam kurungan {} utama:
 *     "dependencies": { "enabledAdvancedServices": [ { "userSymbol": "Classroom", "serviceId": "classroom", "version": "v1" } ] }
 *   (pisahkan dengan koma daripada baris sebelumnya), Save, kemudian Run izinkanClassroom.
 *
 * API (GET, JSON, CORS dibenarkan oleh Apps Script):
 *   ?api=data&key=KUNCI
 *   ?api=save&action=append|update|delete&sheet=Tugasan|Relief|Telegram|PWA&type=...&key=KUNCI&data={JSON}
 */

var CC_VERSI = '2026-11-09e classroom-semua-kelas';   // tukar setiap kali kod dikemas kini; semak melalui ?api=debug
var SHEETS_SAVE =['Tugasan', 'Relief', 'Telegram', 'PWA'];   // tab yang boleh ditulis dari dashboard
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
  var cr = classroomTasks_();
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
    }).concat(cr.items),
    relief: readSheet_('Relief').filter(function (r) { return r.kelas; })
      .sort(function (a, b) { return String(b.tarikh + b.masa).localeCompare(String(a.tarikh + a.masa)); }),
    pwa: withIcons_(readSheet_('PWA')
      .filter(function (p) { return p.nama && isAktif_(p.aktif); })
      .map(function (p) { var s = String(p.status || '').toLowerCase(); p.status = (s === 'online' || s === 'semak' || s === 'luar') ? s : 'na'; return p; })
      .sort(function (a, b) { return (Number(a.urutan) || 999) - (Number(b.urutan) || 999); })),
    jadual: readSheet_('Jadual').filter(function (j) {
        // jika tab ada lajur "tarikh", papar hanya acara hari ini
        return j.acara && (!j.tarikh || j.tarikh === Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
      })
      .sort(function (a, b) { return String(a.mula).localeCompare(String(b.mula)); }),
    pengumuman: readSheet_('Pengumuman')
      .filter(function (x) {
        var tamat = x.tarikhTamat;   // "Tarikh Tamat": abaikan pengumuman yang sudah tamat
        return (x.teks || x.pengumuman) && isAktif_(x.aktif) && !(tamat && String(tamat) < Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
      })
      .map(function (x) { return String(x.teks || x.pengumuman); }),
    telegram: tg.slice(0, 50),
    classroom: cr.off ? undefined : { n: cr.items.length, error: cr.error || '' },
    kelasClassroom: kelasClassroom_()
  };
}

function saveDashboard(payload) {
  if (!payload) throw new Error('saveDashboard dipanggil tanpa data. Fungsi ini dipanggil oleh dashboard, bukan butang Run.');
  checkKey_(payload.key);
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

    writeNewRow_(sh, name, head, row);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

var KEYCOL = { 'Tugasan': 'tajuk', 'Relief': 'kelas', 'PWA': 'nama' };   // lajur penentu baris kosong

/* Tulis rekod ke baris kosong pertama (templat Sheet), atau tambah di hujung dengan menyalin formula. */
function writeNewRow_(sh, name, head, row) {
  var last = sh.getLastRow(), target = last + 1, i, c;
  var kc = KEYCOL[name] ? head.indexOf(KEYCOL[name]) : -1;
  if (kc >= 0 && last >= 2) {
    var keys = sh.getRange(2, kc + 1, last - 1, 1).getValues();
    for (i = 0; i < keys.length; i++) if (String(keys[i][0]).trim() === '') { target = i + 2; break; }
  }
  if (target > last && last >= 2) {                      // baris baharu di hujung: salin formula dari baris atas
    var f = sh.getRange(last, 1, 1, head.length).getFormulas()[0];
    for (c = 0; c < f.length; c++) if (f[c]) sh.getRange(last, c + 1).copyTo(sh.getRange(target, c + 1));
  }
  var tf = sh.getRange(target, 1, 1, head.length).getFormulas()[0];
  head.forEach(function (k, ci) {
    if (!k || tf[ci]) return;                            // jangan timpa lajur formula
    var v = row[k];
    if (v === undefined) { var al = ALIAS[String(k).toLowerCase()]; if (al) v = row[al]; }
    if (v === undefined || v === null || v === '') return;
    sh.getRange(target, ci + 1).setValue(v);
  });
  return target;
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
    var f = sh.getRange(r, 1, 1, head.length).getFormulas()[0];
    if (f.some(function (x) { return x; })) {            // baris templat berformula: kosongkan sel input sahaja
      head.forEach(function (k, ci) { if (!f[ci]) sh.getRange(r, ci + 1).clearContent(); });
    } else {
      sh.deleteRow(r);
    }
    return { ok: true, found: 1, deleted: 1 };
  });
}

/* Kemas kini rekod sedia ada (edit tugasan). Hanya medan yang dihantar diubah. */
function updateRow_(name, row) {
  var res = withRow_(name, row, function (sh, head, r) {
    var f = sh.getRange(r, 1, 1, head.length).getFormulas()[0];
    head.forEach(function (k, ci) {
      if (!k || f[ci]) return;
      if (k === 'localId' && !row.localId) return;
      var v = row[k];
      if (v === undefined || v === null) return;
      sh.getRange(r, ci + 1).setValue(v);
    });
    return { ok: true, found: 1, updated: 1 };
  });
  if (!res.found) throw new Error('Rekod tidak dijumpai dalam Sheet (mungkin sudah dipadam atau diubah). Muat semula dashboard.');
  return res;
}

/* ---------------- Ikon aplikasi PWA ----------------
 * Ikon dibaca daripada tag <link rel="icon|apple-touch-icon"> setiap laman, lalu disimpan dalam cache 6 jam.
 * Untuk memaksa ikon tertentu, isi lajur "Ikon" (URL gambar) dalam tab PWA. */
function absUrl_(base, href) {
  href = String(href).trim();
  if (/^https?:\/\//i.test(href)) return href;
  var m = /^(https?:)\/\/([^\/?#]+)(\/[^?#]*)?/i.exec(base);
  if (!m) return '';
  var origin = m[1] + '//' + m[2], path = m[3] || '/';
  if (href.indexOf('//') === 0) return m[1] + href;
  if (href.charAt(0) === '/') return origin + href;
  var parts = (path.replace(/[^\/]*$/, '') + href).split('/'), out = [];
  parts.forEach(function (p) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); });
  return origin + '/' + out.join('/');
}

function pickIcon_(html, base) {
  var links = html.match(/<link\b[^>]*>/gi) || [], best = '', bestScore = -1;
  links.forEach(function (tag) {
    var rel = (/rel\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    var href = (/href\s*=\s*["']([^"']*)["']/i.exec(tag) || [])[1];
    if (!rel || !href || !/icon/i.test(rel) || /mask-icon/i.test(rel)) return;
    var sz = (/sizes\s*=\s*["'](\d+)x/i.exec(tag) || [])[1];
    var score = (/apple-touch-icon/i.test(rel) ? 1000 : 0) + (Number(sz) || 0) + (/\.svg/i.test(href) ? 50 : 0);
    if (score > bestScore) { best = href; bestScore = score; }
  });
  return best ? absUrl_(base, best) : '';
}

function md5_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s).map(function (b) {
    return ('0' + (b & 0xff).toString(16)).slice(-2);
  }).join('');
}

function withIcons_(list) {
  try {
    var cache = CacheService.getScriptCache(), keyOf = {}, keys = [];
    list.forEach(function (p) {
      if (p.ikon || !/^https?:\/\//i.test(p.pautan || '')) return;
      var k = 'ico2:' + md5_(p.pautan);
      keyOf[p.pautan] = k; keys.push(k);
    });
    var hit = keys.length ? cache.getAll(keys) : {};
    var miss = list.filter(function (p) { return keyOf[p.pautan] && hit[keyOf[p.pautan]] === undefined; });
    if (miss.length) {
      var res = UrlFetchApp.fetchAll(miss.map(function (p) {
        return { url: p.pautan, muteHttpExceptions: true, followRedirects: true };
      }));
      var put = {};
      miss.forEach(function (p, i) {
        var ico = '';
        try { if (res[i].getResponseCode() < 400) ico = pickIcon_(res[i].getContentText().slice(0, 60000), p.pautan); } catch (e) {}
        hit[keyOf[p.pautan]] = ico || '-';
        put[keyOf[p.pautan]] = ico || '-';
      });
      cache.putAll(put, 21600);
    }
    list.forEach(function (p) {
      if (!p.ikon && keyOf[p.pautan]) { var v = hit[keyOf[p.pautan]]; p.ikon = v === '-' ? '' : v; }
    });
  } catch (e) { /* ikon gagal diselesaikan: dashboard guna ikon sandaran */ }
  return list;
}

/* Jalankan SEKALI dari editor (pilih fungsi ini > Run) untuk memberi kebenaran capaian laman luar. */
function izinkanIkon() {
  UrlFetchApp.fetch('https://www.google.com/', { muteHttpExceptions: true });
  CacheService.getScriptCache().put('izin', '1', 60);
}

/* ---------------- Senarai kelas Classroom (untuk panel pintasan) ----------------
 * Membaca SEMUA kelas aktif akaun pemilik skrip: kelas yang disertai (ahli) dan kelas yang diajar (guru).
 * Hanya memerlukan kebenaran senarai kelas (Courses.list), bukan data tugasan. Cache 30 minit. */
function kelasClassroom_() {
  if (typeof Classroom === 'undefined') return [];
  var cache = CacheService.getScriptCache();
  try {
    var hit = cache.get('crk:v1');
    if (hit) return JSON.parse(hit);
  } catch (e0) {}
  var seen = {}, out = [];
  [['studentId', 'Ahli'], ['teacherId', 'Guru']].forEach(function (q) {
    try {
      var tok = '', r, p;
      do {
        p = { courseStates: ['ACTIVE'], pageSize: 100 };
        p[q[0]] = 'me';
        if (tok) p.pageToken = tok;
        r = Classroom.Courses.list(p);
        (r.courses || []).forEach(function (c) {
          if (seen[c.id]) return;
          seen[c.id] = 1;
          out.push({ id: String(c.id), nama: c.name || '', bahagian: c.section || '', pautan: c.alternateLink || '', peranan: q[1] });
        });
        tok = r.nextPageToken || '';
      } while (tok);
    } catch (e) { /* peranan ini tidak dapat dibaca: teruskan dengan yang lain */ }
  });
  if (out.length) { try { cache.put('crk:v1', JSON.stringify(out), 1800); } catch (e2) {} }
  return out;
}

/* ---------------- Tugasan Google Classroom ----------------
 * Membaca tugasan yang DIBERI KEPADA akaun pemilik skrip (sebagai ahli/"murid" kelas Classroom),
 * lalu memaparkannya dalam Papan Tugasan (baca sahaja). Hasil disimpan dalam cache 10 minit.
 * AKTIFKAN SEKALI: Apps Script > Services (+) > "Google Classroom API" > Add, kemudian Run izinkanClassroom().
 * Jika perkhidmatan belum diaktifkan, bahagian ini dilangkau (tiada ralat). */
function crParams_(base, tok) {
  if (tok) base.pageToken = tok;
  return base;
}

/* Script property CLASSROOM_KELAS (pilihan): senarai kelas yang dipaparkan, dipisah koma.
 * Boleh ditampal sebagai ID (838802788260), token dalam pautan (ODM4ODAyNzg4MjYw), atau pautan penuh kelas.
 * Jika kosong, semua kelas aktif yang anda sertai dipaparkan. */
function kelasTapis_() {
  var raw = String(PropertiesService.getScriptProperties().getProperty('CLASSROOM_KELAS') || '');
  return raw.split(',').map(function (x) {
    x = x.trim();
    var m = /\/c\/([A-Za-z0-9_-]+)/.exec(x);
    if (m) x = m[1];
    if (x && !/^\d+$/.test(x)) {
      try { var d = Utilities.newBlob(Utilities.base64Decode(x.replace(/-/g, '+').replace(/_/g, '/'))).getDataAsString(); if (/^\d+$/.test(d)) x = d; } catch (e) {}
    }
    return x;
  }).filter(String);
}

/* Tulis senarai tugasan Classroom ke tab "Classroom" dalam Sheet (dicipta jika belum ada; ditulis semula setiap kali data segar dibaca). */
function tulisTabClassroom_(items) {
  try {
    var ss = SpreadsheetApp.getActive();
    var sh = ss.getSheetByName('Classroom') || ss.insertSheet('Classroom');
    var head = ['Kelas', 'Tajuk Tugasan', 'Tarikh Akhir', 'Status', 'Pautan', 'ID Tugasan', 'Dikemas Kini'];
    var stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
    var rows = items.map(function (t) { return [t.unit, t.tajuk, t.akhir, t.status, t.pautan, t._k, stamp]; });
    sh.clearContents();
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
    if (rows.length) sh.getRange(2, 1, rows.length, head.length).setValues(rows);
    sh.setFrozenRows(1);
  } catch (e) { /* tab gagal ditulis: tidak menjejaskan dashboard */ }
}

function classroomTasks_() {
  // Bacaan API Classroom adalah PILIHAN dan MATI secara lalai (ramai pentadbir sekolah menyekatnya).
  // Hidupkan dengan Script property CLASSROOM_API = on. Pintasan kelas pada dashboard tidak memerlukannya.
  if (String(PropertiesService.getScriptProperties().getProperty('CLASSROOM_API') || '').toLowerCase() !== 'on') return { items: [], off: true };
  if (typeof Classroom === 'undefined') {
    // Jika pengguna sudah menetapkan CLASSROOM_KELAS tetapi perkhidmatan belum ditambah, beritahu di dashboard
    return kelasTapis_().length
      ? { items: [], error: 'perkhidmatan Classroom belum diaktifkan (Apps Script > Services > Google Classroom API)' }
      : { items: [], off: true };
  }
  var cache = CacheService.getScriptCache();
  var only = kelasTapis_();
  var ckey = 'cr:v2:' + md5_(only.join(','));
  try {
    var hit = cache.get(ckey);
    if (hit) return JSON.parse(hit);

    var courses = [], tok = '', r;
    do {
      r = Classroom.Courses.list(crParams_({ studentId: 'me', courseStates: ['ACTIVE'], pageSize: 50 }, tok));
      courses = courses.concat(r.courses || []);
      tok = r.nextPageToken || '';
    } while (tok);

    if (only.length) courses = courses.filter(function (c) { return only.indexOf(String(c.id)) >= 0; });
    var cutoff = Utilities.formatDate(new Date(Date.now() - 14 * 86400000), TZ, 'yyyy-MM-dd');
    var items = [], errs = [];
    courses.forEach(function (c) {
      try {
        // 1) senarai tugasan yang diterbitkan
        var works = [], t3 = '', wr;
        do {
          wr = Classroom.Courses.CourseWork.list(c.id, crParams_({ courseWorkStates: ['PUBLISHED'], pageSize: 100 }, t3));
          works = works.concat(wr.courseWork || []);
          t3 = wr.nextPageToken || '';
        } while (t3);

        // 2) keadaan serahan saya: cara pantas (semua tugasan sekali gus), jika ditolak cuba satu demi satu
        var subs = {};
        try {
          var t2 = '', sr;
          do {
            sr = Classroom.Courses.CourseWork.StudentSubmissions.list(c.id, '-', crParams_({ userId: 'me', pageSize: 100 }, t2));
            (sr.studentSubmissions || []).forEach(function (s) { subs[s.courseWorkId] = s; });
            t2 = sr.nextPageToken || '';
          } while (t2);
        } catch (e1) {
          works.forEach(function (w) {
            try {
              var r1 = Classroom.Courses.CourseWork.StudentSubmissions.list(c.id, w.id, { userId: 'me' });
              if ((r1.studentSubmissions || [])[0]) subs[w.id] = r1.studentSubmissions[0];
            } catch (e2) { /* keadaan serahan tidak dapat dibaca untuk tugasan ini */ }
          });
        }

        works.forEach(function (w) {
          var d = w.dueDate;
          var akhir = d ? d.year + '-' + ('0' + d.month).slice(-2) + '-' + ('0' + d.day).slice(-2) : '';
          var st = subs[w.id] ? subs[w.id].state : 'NEW';
          var done = st === 'TURNED_IN' || st === 'RETURNED';
          if (done && (!akhir || akhir < cutoff)) return;      // sudah lama selesai: tidak dipaparkan
          items.push({
            _k: 'cr-' + w.id,
            tajuk: w.title || '(Tanpa tajuk)',
            unit: c.name || 'Classroom',
            pic: c.section || '',
            akhir: akhir,
            status: done ? 'Selesai' : 'Dalam Proses',
            kemajuan: done ? 100 : 0,
            sumber: 'Classroom',
            pautan: w.alternateLink || ''
          });
        });
      } catch (ec) {
        errs.push((c.name || c.id) + ': ' + String((ec && ec.message) || ec));   // kelas ini dilangkau; kelas lain diteruskan
      }
    });
    items = items.slice(0, 150);
    var out = { items: items, error: errs.join(' | ') };
    tulisTabClassroom_(items);
    if (!errs.length) { try { cache.put(ckey, JSON.stringify(out), 600); } catch (e) {} }
    return out;
  } catch (e) {
    return { items: [], error: String((e && e.message) || e) };
  }
}

/* Jalankan SEKALI dari editor untuk memberi kebenaran Classroom (selepas menambah perkhidmatan). */
function izinkanClassroom() {
  var r = Classroom.Courses.list({ studentId: 'me', courseStates: ['ACTIVE'], pageSize: 5 });
  (r.courses || []).forEach(function (c) { Logger.log('Kelas: ' + c.name + '  | ID: ' + c.id); });
  Logger.log('Jumlah kelas (maks. 5 ditunjuk): ' + (r.courses || []).length);
  CacheService.getScriptCache().remove('cr:v2:' + md5_(kelasTapis_().join(',')));
  var t = classroomTasks_();   // juga mencipta/mengisi tab "Classroom" dalam Sheet
  Logger.log('Tugasan dijumpai: ' + t.items.length + (t.error ? '  | RALAT: ' + t.error : ''));
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

/* Pengepala sebenar dalam Sheet (cth. "Tajuk Tugasan", "Kemajuan (%)", "ID") -> nama standard dashboard */
var CANON = {
  'id': 'localId', 'localid': 'localId',
  'tajuktugasan': 'tajuk', 'tarikhakhir': 'akhir', 'kemajuan': 'kemajuan',
  'chatid': 'chatId', 'messageid': 'messageId',
  'namaaplikasi': 'nama', 'pautanurl': 'pautan',
  'masamula': 'mula', 'masatamat': 'tamat',
  'ikonurl': 'ikon', 'tekspengumuman': 'teks', 'papardidashboard': 'papar'
};

/* "Guru Tidak Hadir" / "guru_tidak_hadir" -> guruTidakHadir */
function normHeader_(h) {
  h = String(h).trim();
  var base = h.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (CANON[base]) return CANON[base];
  var w = h.split(/[^A-Za-z0-9]+/).filter(String);
  if (!w.length) return '';
  if (w.length === 1) return /^[A-Z0-9]+$/.test(w[0]) ? w[0].toLowerCase() : w[0].charAt(0).toLowerCase() + w[0].slice(1);   // PIC -> pic
  return w[0].toLowerCase() + w.slice(1).map(function (x) { return x.charAt(0).toUpperCase() + x.slice(1).toLowerCase(); }).join('');
}

function headers_(sh) {
  if (sh.getLastColumn() < 1) return [];
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(normHeader_);
}

/* Pengepala lalai untuk tab yang dicipta automatik */
var DEFAULT_HEADERS = {
  'Tugasan': ['tajuk', 'pic', 'unit', 'akhir', 'status', 'kemajuan', 'localId'],
  'Relief': ['tarikh', 'masa', 'kelas', 'guruTidakHadir', 'guruRelief', 'status', 'nota', 'localId'],
  'Telegram': ['masa', 'kumpulan', 'pengirim', 'mesej', 'chatId', 'messageId'],
  'PWA': ['nama', 'pautan', 'kategori', 'aktif', 'urutan', 'catatan']
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
  var cr = classroomTasks_();
  return {
    versi: CC_VERSI,                                       // untuk mengesahkan versi deployment yang aktif
    classroomPerkhidmatan: typeof Classroom !== 'undefined',
    classroomKelasDitapis: kelasTapis_(),
    classroomSemuaKelas: kelasClassroom_().length,
    classroomTugasan: cr.items.length,
    classroomRalat: cr.error || '',
    tab: SpreadsheetApp.getActive().getSheets().map(function (sh) {
      return { tab: sh.getName(), baris: sh.getLastRow(), pengepala: sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0] : [] };
    })
  };
}
