/* ============================================================
   Command Centre SMKTM — app-engine.js
   Enjin client-side (Vanilla ES6+, tanpa library luar).
   - Tarik master-index.json (SWR dikendalikan sw.js) & render ke UI
   - Carian merta (#hud-search, Ctrl/Cmd + K) dalam memori
   - Jam & tarikh masa nyata
   Pilihan: window.CC_ENGINE = { dataUrl: "master-index.json", refreshMs: 60000 }
   ============================================================ */
(() => {
  "use strict";

  const OPT = Object.assign({ host: false, dataUrl: "master-index.json", refreshMs: 60000, cacheKey: "cc-master-index" }, window.CC_ENGINE);
  const HARI = ["Ahad", "Isnin", "Selasa", "Rabu", "Khamis", "Jumaat", "Sabtu"];
  const BULAN = ["Januari", "Februari", "Mac", "April", "Mei", "Jun", "Julai", "Ogos", "September", "Oktober", "November", "Disember"];
  const LABEL_TASK = { "st-lewat": "LEWAT", "st-hari": "HARI INI", "st-proses": "DALAM PROSES", "st-selesai": "SELESAI" };
  const LABEL_RELIEF = { "st-perlu": "Perlu Relief", "st-tugas": "Ditugaskan", "done": "Selesai" };
  const LABEL_DOT = { "d-online": "ONLINE", "d-semak": "SEMAK" };

  const $ = (s, r = document) => r.querySelector(s);
  const pad = n => String(n).padStart(2, "0");
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = v => String(v ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const safeUrl = u => (/^https?:\/\//i.test(u || "") ? u : "#");
  const initials = s => String(s || "?").split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join("").toUpperCase();

  let DATA = null;
  let query = "";

  /* ---------------- Masa ---------------- */
  const toMin = t => { const m = /(\d{1,2})[:.](\d{2})/.exec(String(t || "")); return m ? +m[1] * 60 + +m[2] : NaN; };

  function fmtDue(iso) {
    const d = new Date(iso + "T00:00:00");
    return isNaN(d) ? "—" : `${d.getDate()} ${BULAN[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
  }

  /* Status acara dikira semula dari masa jam peranti; jika masa tidak sah, guna nilai dalam JSON. */
  function scheduleState(list) {
    const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
    let nextDone = false;
    return list.map(e => {
      const parts = String(e.time || "").split(/[-–]/);
      const a = toMin(parts[0]);
      if (isNaN(a)) return { ...e, state: e.status || "" };
      let b = toMin(parts[1]); if (isNaN(b) || b <= a) b = a + 60;
      if (nm >= a && nm < b) return { ...e, state: "now", pct: Math.round((nm - a) / (b - a) * 100) };
      if (nm >= b) return { ...e, state: "past" };
      if (!nextDone) { nextDone = true; return { ...e, state: "next" }; }
      return { ...e, state: "" };
    });
  }

  /* ---------------- Carian ---------------- */
  const hay = {
    tasks: t => [t.title, t.pic, t.due, LABEL_TASK[t.status]],
    relief: r => [r.kelas, r.guru_absen, r.guru_ganti, r.masa, LABEL_RELIEF[r.status]],
    pwa_tiles: p => [p.title, p.category],
    schedule: e => [e.time, e.event, e.location]
  };
  function filtered(key) {
    const list = (DATA && DATA[key]) || [];
    const terms = norm(query).split(/\s+/).filter(Boolean);
    if (!terms.length) return list;
    return list.filter(x => { const h = norm(hay[key](x).join(" ")); return terms.every(t => h.includes(t)); });
  }

  /* ---------------- Render ---------------- */
  function renderTasks() {
    const tb = $(".tablewrap tbody"); if (!tb) return;
    const list = filtered("tasks");
    tb.innerHTML = list.length ? list.map(t => `
      <tr class="row ${esc(t.status)}">
        <td class="c-title"><div class="tt">${esc(t.title)}</div></td>
        <td class="c-pic pic">${esc(t.pic)}</td>
        <td class="c-due due">${fmtDue(t.due)}</td>
        <td class="c-prog"><div class="prog"><div class="bar"><i style="width:${Math.max(0, Math.min(100, +t.progress_percent || 0))}%"></i></div><span>${+t.progress_percent || 0}%</span></div></td>
        <td class="c-pill"><span class="pill">${LABEL_TASK[t.status] || esc(t.status)}</span></td>
      </tr>`).join("")
      : `<tr><td colspan="5" class="empty">${query ? "Tiada tugasan sepadan dengan carian." : "Tiada tugasan."}</td></tr>`;
  }

  function renderRelief() {
    const box = $(".relief-list"); if (!box) return;
    const list = filtered("relief");
    box.innerHTML = list.length ? list.map(r => `
      <article class="relief-card ${esc(r.status)} ${r.status === "done" ? "done" : ""}">
        <div class="relief-top">
          <div><div class="relief-class">${esc(r.kelas)}</div><div class="relief-meta">${esc(r.masa)} · Guru tidak hadir: ${esc(r.guru_absen)}</div></div>
          <span class="pill">${LABEL_RELIEF[r.status] || esc(r.status)}</span>
        </div>
        <div class="relief-meta">${r.guru_ganti ? "Guru relief: " + esc(r.guru_ganti) : "Guru relief belum ditugaskan"}</div>
      </article>`).join("")
      : `<div class="relief-empty">${query ? "Tiada relief sepadan." : "Tiada kelas yang memerlukan relief."}</div>`;
  }

  function renderTiles() {
    const box = $(".tiles"); if (!box) return;
    const list = filtered("pwa_tiles");
    box.innerHTML = list.map(p => `
      <div class="tw">
        <a class="tile" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener">
          <span class="dot ${esc(p.status)}">${LABEL_DOT[p.status] || ""}</span>
          <span class="ico">${esc(initials(p.title))}${p.icon_path ? `<img src="${esc(p.icon_path)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>
          <span class="nm">${esc(p.title)}</span>
          <span class="cat">${esc(p.category)}</span>
        </a>
      </div>`).join("");
  }

  function renderSchedule() {
    const ol = $(".tl"); if (!ol) return;
    const list = scheduleState(filtered("schedule"));
    ol.innerHTML = list.length ? list.map(e => `
      <li class="ev ${esc(e.state)}">
        <div class="t">${esc(e.time)}</div>
        <div class="node"><i></i></div>
        <div><div class="a">${esc(e.event)}${e.state === "now" ? '<span class="tag">SEDANG</span>' : ""}</div><div class="l">${esc(e.location)}</div></div>
        ${e.state === "now" ? `<div class="nowbar"><i style="width:${e.pct}%"></i></div>` : ""}
      </li>`).join("")
      : `<li class="empty">${query ? "Tiada acara sepadan." : "Tiada acara hari ini."}</li>`;
  }

  /* Elemen pilihan: [data-cc="telemetry-critical|warn|ok|info"] dan [data-cc="school-name|last-updated"] */
  function renderMeta() {
    if (!DATA) return;
    ["critical", "warn", "ok", "info"].forEach(k => {
      const el = $(`[data-cc="telemetry-${k}"]`), v = DATA.telemetry && DATA.telemetry[k];
      if (el && v) { el.textContent = v.count; el.title = v.label || ""; }
    });
    const n = $('[data-cc="school-name"]'); if (n) n.textContent = DATA.school_info.name;
    const u = $('[data-cc="last-updated"]');
    if (u) { const d = new Date(DATA.school_info.last_updated); u.textContent = isNaN(d) ? "" : `Dikemas kini ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  }

  const renderAll = () => { renderTasks(); renderRelief(); renderTiles(); renderSchedule(); renderMeta(); };

  /* ---------------- Data ---------------- */
  function valid(d) {
    return d && typeof d === "object" && d.school_info && ["relief", "tasks", "pwa_tiles", "schedule"].every(k => Array.isArray(d[k]));
  }
  function accept(d, persist) {
    if (!valid(d)) throw new Error("master-index.json tidak sah");
    DATA = d;
    if (persist) { try { localStorage.setItem(OPT.cacheKey, JSON.stringify(d)); } catch (_) { /* storan penuh/dilarang */ } }
    renderAll();
  }
  async function load() {
    try {
      const res = await fetch(OPT.dataUrl, { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      accept(await res.json(), true);
    } catch (err) {
      if (!DATA) {   // sandaran terakhir: salinan localStorage
        try { accept(JSON.parse(localStorage.getItem(OPT.cacheKey)), false); return; } catch (_) { /* tiada salinan */ }
      }
      console.warn("[CC] Gagal memuat data:", err.message);
    }
  }

  /* ---------------- Carian instant ---------------- */
  function initSearch() {
    const input = $("#hud-search"); if (!input) return;
    input.addEventListener("input", () => { query = input.value; renderAll(); });
    input.addEventListener("keydown", e => {
      if (e.key === "Escape") { input.value = ""; query = ""; renderAll(); input.blur(); }
    });
    document.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.focus(); input.select(); }
    });
  }

  /* ---------------- Jam ---------------- */
  function tick() {
    const n = new Date(), c = $("#clock"), d = $("#date");
    if (c) c.textContent = `${pad(n.getHours())}:${pad(n.getMinutes())}:${pad(n.getSeconds())}`;
    if (d) d.textContent = `${HARI[n.getDay()]}, ${n.getDate()} ${BULAN[n.getMonth()]} ${n.getFullYear()}`;
  }

  /* ---------------- Mod host (index.html): tapis paparan sedia ada ----------------
     index.html sudah merender data langsungnya sendiri. Dalam mod ini engine hanya
     menapis elemen yang sudah dirender (tugasan, relief, jubin, jadual) secara merta,
     dan menapis semula selepas setiap render semula (MutationObserver). */
  const HOST_ITEMS = ".tablewrap tbody tr.row, .relief-list .relief-card, .tiles .tw, .tl .ev";
  const HOST_ROOTS = [".tablewrap tbody", ".relief-list", ".tiles", ".tl"];
  let hostBusy = false;
  function hostFilter() {
    const terms = norm(query).split(/s+/).filter(Boolean);
    hostBusy = true;
    document.querySelectorAll(HOST_ITEMS).forEach(el => {
      const h = norm(el.textContent);
      el.hidden = !!terms.length && !terms.every(t => h.includes(t));
    });
    queueMicrotask(() => { hostBusy = false; });
  }
  function initHost() {
    const input = $("#hud-search"); if (!input) return;
    const obs = new MutationObserver(() => { if (!hostBusy && query) hostFilter(); });
    HOST_ROOTS.forEach(sel => { const r = $(sel); if (r) obs.observe(r, { childList: true }); });
    const apply = () => { query = input.value; hostFilter(); };
    input.addEventListener("input", apply);
    input.addEventListener("keydown", e => { if (e.key === "Escape") { input.value = ""; apply(); input.blur(); } });
    document.addEventListener("keydown", e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); input.focus(); input.select(); }
    });
  }

  function init() {
    if (OPT.host) { initHost(); return; }
    tick(); setInterval(tick, 1000);
    initSearch();
    load();
    setInterval(load, OPT.refreshMs);
    setInterval(() => { if (DATA) renderSchedule(); }, 30000);   // gerak penanda "sedang berlangsung"
    document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
    window.addEventListener("online", load);
  }

  window.CC_APP = { reload: load, get data() { return DATA; } };
  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
