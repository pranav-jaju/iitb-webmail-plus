// IITB Webmail+: runs inside webmail.iitb.ac.in (Roundcube, Elastic skin).
// - Instant search as you type (works even where the server's own search doesn't), with filters
//   like from:, subject:, course:, is:unread, has:attachment, in:, after:, before:, newer:7d
// - Smart sidebar: My courses (you pick them), Notices, People, Unread, Attachments, Calendar
// - Calendar of quiz / assignment deadlines read from course and notice mails; you choose what shows
// - Attachments finder, mute mailing lists, mark a whole view as read, keyboard shortcuts (press ?)
// - A cleaner look for the whole webmail (theme.css), switchable off in the sidebar
// Everything uses your logged-in session and stays in your browser; nothing leaves webmail.iitb.ac.in.
(() => {
  if (!window.rcmail || rcmail.env.task !== "mail" || window.__bsLoaded) return;
  window.__bsLoaded = true;
  if (rcmail.env.framed || window.top !== window) return; // not inside the preview frame

  const PARALLEL = 6;
  const FULL_EVERY_MS = 7 * 24 * 3600 * 1000;
  const MAX_SHOWN = 300;
  const DAY = 24 * 3600 * 1000;
  const USER = rcmail.env.username || "";

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const scratch = document.createElement("div");
  const text = (html) => { scratch.innerHTML = html || ""; return scratch.textContent.trim(); };
  const norm = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const atobSafe = (s) => { try { return atob(s.replace(/[-_]/g, (c) => (c === "-" ? "+" : "/"))); } catch { return s; } };
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k + ":" + USER); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k + ":" + USER, JSON.stringify(v)); } catch (e) { console.warn("[webmail+] storage full?", e); } },
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function variants(q) {
    const joined = q.replace(/\b([A-Za-z]{2,4})[\s-]?(\d{3}[A-Za-z]?)\b/g, "$1$2");
    return [...new Set([q, joined, joined.replace(/\b([A-Za-z]{2,4})(\d{3}[A-Za-z]?)\b/g, "$1 $2"),
      joined.replace(/\b([A-Za-z]{2,4})(\d{3}[A-Za-z]?)\b/g, "$1-$2")])];
  }

  // Pull the add_message_row(...) calls out of Roundcube's response script.
  function parseRows(exec) {
    const rows = [], key = "add_message_row(";
    let i = 0;
    while ((i = exec.indexOf(key, i)) !== -1) {
      let j = i + key.length, depth = 1, inStr = false;
      for (; j < exec.length && depth; j++) {
        const c = exec[j];
        if (inStr) { if (c === "\\") j++; else if (c === '"') inStr = false; }
        else if (c === '"') inStr = true;
        else if ("([{".includes(c)) depth++;
        else if (")]}".includes(c)) depth--;
      }
      try {
        const [uid, cols, flags] = JSON.parse("[" + exec.slice(i + key.length, j - 1) + "]");
        rows.push({ uid: String(uid), cols: cols || {}, flags: flags || {} });
      } catch (e) { console.warn("[webmail+] could not read a row", e); }
      i = j;
    }
    return rows;
  }

  const rcHeaders = () => ({ "X-Roundcube-Request": rcmail.env.request_token, "X-Requested-With": "XMLHttpRequest" });
  async function rcGet(params) {
    const res = await fetch("./?" + new URLSearchParams({ _task: "mail", _remote: "1", _unlock: "0", _: Date.now(), ...params }),
      { credentials: "same-origin", headers: rcHeaders() });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return (await res.json()).exec || "";
  }
  async function rcPost(action, params) {
    const body = new URLSearchParams({ _remote: "1", _unlock: "0", _token: rcmail.env.request_token, ...params });
    const res = await fetch("./?_task=mail&_action=" + action, { method: "POST", credentials: "same-origin", headers: rcHeaders(), body });
    if (!res.ok) throw new Error("HTTP " + res.status);
  }
  async function listPage(mbox, page) {
    const exec = await rcGet({ _action: "list", _mbox: mbox, _page: String(page) });
    const m = exec.match(/["']pagecount["']\s*[:,]\s*(\d+)/);
    const c = exec.match(/["']messagecount["']\s*[:,]\s*(\d+)/) || exec.match(/\bof\s+([\d,]+)/);
    const fromCount = c ? Math.ceil(+c[1].replace(/,/g, "") / (+rcmail.env.pagesize || 50)) : 0;
    return { rows: parseRows(exec), pagecount: Math.max(m ? +m[1] : 0, fromCount, 1) };
  }

  // ---------- dates ----------
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  // Roundcube shows "Today 20:16", "Yesterday 09:00", "Wed 15:18" or a full date
  function toTs(label) {
    const hm = label.match(/(\d{1,2}):(\d{2})/);
    const at = (d) => { if (hm) d.setHours(+hm[1], +hm[2], 0, 0); else d.setHours(12, 0, 0, 0); return d.getTime(); };
    const l = label.toLowerCase();
    if (l.startsWith("today")) return at(new Date());
    if (l.startsWith("yesterday")) { const d = new Date(); d.setDate(d.getDate() - 1); return at(d); }
    const wd = WEEKDAYS.indexOf(l.slice(0, 3));
    if (wd >= 0 && !/\d{4}/.test(l)) { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() - wd + 7) % 7 || 7)); return at(d); }
    let m = label.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return at(new Date(+m[1], m[2] - 1, +m[3]));
    m = label.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (m) return at(new Date(+m[3], m[2] - 1, +m[1]));
    const t = Date.parse(label);
    return isNaN(t) ? 0 : t;
  }
  function showDate(ts) {
    if (!ts) return "";
    const d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() && { year: "numeric" }) });
  }
  function showWhen(ts, hasTime) {
    const d = new Date(ts), now = new Date();
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
    const dayLabel = days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday"
      : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
    return dayLabel + (hasTime ? ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "");
  }

  // ---------- classification ----------
  const NOT_COURSE = new Set(["AM", "PM", "NO", "LH", "LT", "LC", "SAC", "SIC", "CC", "ID", "UG", "PG", "IST", "UTC", "GMT", "AY", "SEM", "RM", "TA", "NCC", "NSS", "NSO", "COVID", "ISO", "SDG", "LA", "LCH", "NEW", "OCT", "SEP", "NOV", "DEC", "JAN"]);
  const COURSE_RE = /\b([A-Z]{2,3})\s?-?\s?([1-9]\d{2}[A-Z]?)(?![\d])/g;
  function courseOf(subj, from) {
    const moodle = subj.match(/\b([A-Z]{2,3})\s?(\d{3}[A-Z]?)-\d{4}-\d/); // "EE 229-2026-1-ALL"
    if (moodle) return moodle[1] + " " + moodle[2];
    for (const m of subj.matchAll(COURSE_RE)) if (!NOT_COURSE.has(m[1])) return m[1] + " " + m[2];
    if (/moodle/i.test(from)) { const m = subj.match(/\b([A-Z]{2,3})\s?(\d{3})/); if (m) return m[1] + " " + m[2]; }
    return "";
  }
  const listTag = (subj) => { const m = subj.match(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)*\[([^\]]{2,40})\]/i); return m ? m[1].trim() : ""; };
  const NOTICE_FROM = /notice|office|dean|secretar|gen\.?\s?sec|council|committee|club|team|no-?reply|do not reply|donotreply|placement|admin|hostel|gymkhana|iitb sso|system|registrar|library|cell|board|society|announce/i;
  // competitions, hackathons and challenges, but not seminars, defences or course mail
  const COMP_RE = /\b(competitions?|compet[ie]|hackathons?|\w*-?a-?thons?|ideathons?|datathons?|challenges?|contests?|olympiads?|case[- ]?comps?|case study competition|championships?|tournaments?|prize pool|prizes?|bounty|grand finale|qualifier|round 1|cash prize|pitch(?:ing)? fest|startup fest)\b/i;
  const NOT_COMP_RE = /\b(ph\.?\s?d|defen[cs]e|thesis|viva|seminar|colloquium|lecture|course|assignment|quiz|exam|tutorial|webinar|placement talk|alumni talk|hostel|mess)\b/i;
  const isCompetition = (m) => !m.course && COMP_RE.test(m.subj) && !NOT_COMP_RE.test(m.subj) && !/\bmarathons?\b/i.test(m.subj);
  function categoryOf(m) {
    if (m.course) return "course";
    if (m.tag || NOTICE_FROM.test(m.from) || NOTICE_FROM.test(m.email)) return "notice";
    return "people";
  }


  // ---------- settings (kept in this browser) ----------
  const DEFAULT_SETTINGS = { theme: true, hideMuted: true, myCourses: null,
    cal: { quiz: true, deadline: true, event: false, other: false, myOnly: true } };
  let settings = { ...DEFAULT_SETTINGS, ...ls.get("bs-settings", {}) };
  settings.cal = { ...DEFAULT_SETTINGS.cal, ...(settings.cal || {}) };
  function saveSettings() {
    ls.set("bs-settings", settings);
    try { localStorage.setItem("bs-theme", settings.theme ? "1" : "0"); } catch {}
    document.documentElement.classList.toggle("bs-theme", !!settings.theme);
    applyMutes();
  }
  let mutedTags = new Set(ls.get("bs-muted", []));
  const muted = () => mutedTags;
  function setMuted(tag, on) { if (on) mutedTags.add(tag); else mutedTags.delete(tag); ls.set("bs-muted", [...mutedTags]); applyMutes(); update(); }
  const myCourseSet = () => (settings.myCourses ? new Set(settings.myCourses) : null);
  const courseCode = (s) => { const m = String(s).toUpperCase().match(/([A-Z]{2,3})\s*-?\s*(\d{3}[A-Z]?)/); return m ? m[1] + " " + m[2] : ""; };

  // muted tones so courses are told apart without the page getting loud
  const COURSE_COLORS = ["#7c8db5", "#b58a7c", "#7ca8a0", "#a89a6e", "#9a84b0", "#8aa37a", "#b07c94", "#6f98b8", "#a0846a", "#88949e"];
  const colorOf = (key) => { let h = 0; for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return COURSE_COLORS[h % COURSE_COLORS.length]; };

  // ---------- local index ----------
  // rows: uid -> [subject, senderName, timestamp, seen, hasAttachment, senderEmail]
  const IDX_KEY = "bs-index-v4";
  try { ["bs-index-v1:", "bs-index-v2:", "bs-index-v3:"].forEach((k) => localStorage.removeItem(k + USER)); } catch {} // older versions
  let index = ls.get(IDX_KEY, null) || { folders: {} };
  const saveIndex = () => ls.set(IDX_KEY, index);
  const EXCLUDED = () => new Set([rcmail.env.trash_mailbox, rcmail.env.junk_mailbox, rcmail.env.sent_mailbox,
    rcmail.env.drafts_mailbox, "Sent", "Drafts", "Trash", "Junk"].filter(Boolean));
  const folders = () => { const skip = EXCLUDED(); return Object.keys(rcmail.env.mailboxes || { INBOX: 1 }).filter((f) => !skip.has(f)); };

  function rowFrom(r) {
    const fromHtml = r.cols.fromto || r.cols.from || "";
    const email = (fromHtml.match(/title="([^"@\s]+@[^"\s]+)"/) || fromHtml.match(/([\w.+-]+@[\w.-]+)/) || [])[1] || "";
    const att = /multipart\/(mixed|report|signed)/i.test(r.flags.ctype || "") || /attachment/i.test(r.cols.attachment || "") ? 1 : 0;
    return [text(r.cols.subject), text(fromHtml), toTs(text(r.cols.date || "")), r.flags.seen ? 1 : 0, att, email.toLowerCase()];
  }
  function store(f, rows) { for (const r of rows) f.rows[r.uid.split("-")[0]] = rowFrom(r); }

  let eventsDirty = true;
  let flat = [];
  let byKey = new Map();
  let detectedCourses = new Map(); // course -> {n, u, last} before your own course list is applied
  function makeMail(mbox, uid, [subj, from, ts, seen, att, email], mine) {
    let course = courseOf(subj, from);
    const m = { mbox, uid, subj, from, ts, seen, att, email: email || "", detected: course, tag: listTag(subj) };
    m.course = mine && course && !mine.has(course) ? "" : course;
    m.cat = categoryOf(m);
    m.comp = isCompetition(m);
    m.hay = norm(subj + " " + from + " " + (email || ""));
    return m;
  }
  function rebuildFlat() {
    flat = [];
    detectedCourses = new Map();
    const mine = myCourseSet();
    for (const [mbox, f] of Object.entries(index.folders)) {
      for (const [uid, row] of Object.entries(f.rows)) {
        const m = makeMail(mbox, uid, row, mine);
        if (m.detected) {
          const c = detectedCourses.get(m.detected) || { n: 0, u: 0, last: 0 };
          c.n++; if (!m.seen) c.u++; c.last = Math.max(c.last, m.ts);
          detectedCourses.set(m.detected, c);
        }
        flat.push(m);
      }
    }
    flat.sort((a, b) => b.ts - a.ts || +b.uid - +a.uid);
    byKey = new Map(flat.map((m) => [m.mbox + ":" + m.uid, m]));
    eventsDirty = true;
  }
  rebuildFlat();

  const status = { building: false, done: 0, total: 0, updated: index.updated || 0 };
  async function refreshFolder(mbox, onProgress) {
    const now = Date.now();
    let f = index.folders[mbox];
    const desc = String(rcmail.env.sort_order || "DESC").toUpperCase() !== "ASC";
    const first = await listPage(mbox, 1);
    const pages = first.pagecount;
    if (!f || !f.full || now - f.full > FULL_EVERY_MS) {
      f = { rows: index.folders[mbox] ? index.folders[mbox].rows : {}, full: 0 };
      const fresh = { rows: {} };
      store(fresh, first.rows);
      index.folders[mbox] = f;
      status.building = true; status.total += pages; status.done += 1;
      const todo = [];
      for (let pg = 2; pg <= pages; pg++) todo.push(pg);
      for (let i = 0; i < todo.length; i += PARALLEL) {
        const batch = await Promise.all(todo.slice(i, i + PARALLEL).map((pg) => listPage(mbox, pg)));
        batch.forEach((b) => store(fresh, b.rows));
        status.done += batch.length;
        Object.assign(f.rows, fresh.rows);
        rebuildFlat();
        onProgress();
      }
      for (let pg = pages + 1; pg < 1000; pg++) {
        const before = Object.keys(fresh.rows).length, b = await listPage(mbox, pg);
        store(fresh, b.rows);
        if (!b.rows.length || Object.keys(fresh.rows).length === before) break;
      }
      f.rows = fresh.rows;
      f.full = now;
    } else {
      let page = desc ? 1 : pages, rows = desc ? first.rows : (await listPage(mbox, pages)).rows;
      for (let n = 0; n < 20; n++) {
        const known = rows.filter((r) => r.uid.split("-")[0] in f.rows).length;
        store(f, rows); // also refreshes read/unread of the newest page
        if (known || !rows.length) break;
        page += desc ? 1 : -1;
        if (page < 1 || page > pages) break;
        rows = (await listPage(mbox, page)).rows;
      }
    }
    index.folders[mbox] = f;
  }
  let refreshing = null;
  function refreshIndex() {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          for (const mbox of folders()) await refreshFolder(mbox, update);
          index.updated = status.updated = Date.now();
          saveIndex();
        } catch (e) {
          console.warn("[webmail+] index refresh failed", e);
        } finally {
          status.building = false; status.done = status.total = 0;
          rebuildFlat();
          // our list requests moved the server's idea of the "current" folder; put it back
          try { await rcGet({ _action: "list", _mbox: rcmail.env.mailbox || "INBOX", _page: String(rcmail.env.current_page || 1) }); } catch {}
          refreshing = null;
          update();
          scanDeadlines();
        }
      })();
    }
    return refreshing;
  }

  // ---------- raw message reading (viewsource does not mark mail as read) ----------
  async function rawSource(m, maxBytes) {
    const res = await fetch("./?" + new URLSearchParams({ _task: "mail", _action: "viewsource", _uid: m.uid, _mbox: m.mbox }), { credentials: "same-origin" });
    if (!res.ok || !res.body) throw new Error("HTTP " + res.status);
    const reader = res.body.getReader(), chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.length;
      if (size >= maxBytes) { reader.cancel().catch(() => {}); break; }
    }
    const all = new Uint8Array(size); let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    return new TextDecoder("latin1").decode(all); // one char per byte; parts are re-decoded below
  }
  const bytesOf = (bin) => Uint8Array.from(bin, (c) => c.charCodeAt(0) & 255);
  const decodeCharset = (bin, cs) => { try { return new TextDecoder(cs || "utf-8").decode(bytesOf(bin)); } catch { return new TextDecoder("utf-8").decode(bytesOf(bin)); } };
  function decodeWords(s) {
    return s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=\s*/g, (_, cs, enc, data) => {
      try {
        const bin = enc.toUpperCase() === "B" ? atob(data) : data.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (__, h) => String.fromCharCode(parseInt(h, 16)));
        return decodeCharset(bin, cs);
      } catch { return data; }
    });
  }
  function headerParam(h, name) {
    const ext = h.match(new RegExp(name + "\\*=([^']*)'[^']*'([^;\\s]+)", "i"));
    if (ext) { try { return decodeURIComponent(ext[2]); } catch { return ext[2]; } }
    const cont = [...h.matchAll(new RegExp(name + "\\*(\\d+)\\*?=\"?([^\";]+)\"?", "gi"))];
    if (cont.length) return decodeWords(cont.sort((a, b) => a[1] - b[1]).map((c) => c[2]).join(""));
    const m = h.match(new RegExp("\\b" + name + "=\"([^\"]*)\"|\\b" + name + "=([^;\\s]+)", "i"));
    return m ? decodeWords(m[1] ?? m[2]) : "";
  }
  // Walk the MIME tree; leaves get Roundcube-style part ids ("1", "2", "1.2", ...)
  function mimeParts(raw, id = "", out = []) {
    const split = raw.search(/\r?\n\r?\n/);
    const head = (split < 0 ? raw : raw.slice(0, split)).replace(/\r?\n[ \t]+/g, " ");
    const body = split < 0 ? "" : raw.slice(split).replace(/^\r?\n\r?\n/, "");
    const hdr = (n) => (head.match(new RegExp("^" + n + ":\\s*(.*)$", "im")) || [])[1] || "";
    const ctype = hdr("content-type") || "text/plain";
    if (/^multipart\//i.test(ctype)) {
      const b = headerParam(ctype, "boundary");
      if (b) {
        const pieces = body.split("--" + b);
        pieces.slice(1).forEach((p, i) => { if (!p.startsWith("--")) mimeParts(p.replace(/^\r?\n/, ""), id ? id + "." + (i + 1) : String(i + 1), out); });
        return out;
      }
    }
    if (/^message\/rfc822/i.test(ctype)) { mimeParts(body, (id || "1") + ".1", out); }
    const disp = hdr("content-disposition");
    out.push({ id: id || "1", ctype: ctype.split(";")[0].trim().toLowerCase(), charset: headerParam(ctype, "charset"),
      enc: hdr("content-transfer-encoding").trim().toLowerCase(), name: headerParam(disp, "filename") || headerParam(ctype, "name"),
      attachment: /attachment/i.test(disp), body });
    return out;
  }
  function partText(p) {
    let bin = p.body;
    if (p.enc === "base64") { try { bin = atob(bin.replace(/[^A-Za-z0-9+/=]/g, "")); } catch { bin = ""; } }
    else if (p.enc === "quoted-printable") bin = bin.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
    let s = decodeCharset(bin, p.charset);
    if (p.ctype === "text/html") s = new DOMParser().parseFromString(s.replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)\b[^>]*>/gi, "$&\n"), "text/html").body?.textContent || "";
    // keep line breaks: they end sentences, which decides what a date belongs to
    return s.replace(/\r/g, "").replace(/[^\S\n]+/g, " ").replace(/ *\n[\s]*/g, "\n").trim();
  }
  function bodyText(raw) {
    const parts = mimeParts(raw).filter((p) => !p.attachment && /^text\/(plain|html)$/.test(p.ctype));
    const plain = parts.filter((p) => p.ctype === "text/plain");
    return (plain.length ? plain : parts).map(partText).join("\n").slice(0, 20000);
  }


  // ---------- dates in mail text -> calendar events ----------
  const MON = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
  const DATE_RES = [
    { re: new RegExp("\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?" + MON + ",?\\s*(\\d{4})?", "gi"), d: 1, m: 2, y: 3 },
    { re: new RegExp("\\b" + MON + "\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?,?\\s*(\\d{4})?", "gi"), d: 2, m: 1, y: 3 },
    { re: /\b(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})\b/g, d: 1, m: 2, y: 3, num: true },
    // "Quiz-2 on Friday (23/10)": day/month without a year, only right after "on", "by", "(" or a weekday
    { re: /(?:\bon|\bby|\(|day,?)\s*(\d{1,2})\/(\d{1,2})(?![\/\d])/gi, d: 1, m: 2, y: 3, num: true },
  ];
  const TIME_RE = /^[^.\n]{0,25}?\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|hrs|noon|midnight)?\b/i;
  const START_RE = /\b(from|starts?|starting|begins?|beginning|opens?|opening|released?|commenc\w*|available|posted|uploaded|published|sent|held on \w+ and)\b[^.]{0,30}$/i;
  const DUE_RE = /\b(due|deadline|submit\w*|submission|last date|closes?|closing|before|till|until|by|latest)\b/i;
  const QUIZ_RE = /\b(quiz\w*|exams?|examination|tests?|mid-?sems?|end-?sems?|mid-?terms?|viva|finals?)\b/i;
  const WORK_RE = /\b(assignments?|homeworks?|home work|hw\s*\d|lab\s*(report|submission|assignment)|project|report|tutorial sheet|problem set|pset)\b/i;
  // the date belongs to something around the exam, not the exam itself (a crib session, the paper review...)
  const NOT_ASSESS_RE = /\b(cribs?|cribbing|review|doubts?|doubt-clearing|discussion|revision|help session|solutions?|answer (?:sheets?|scripts?|key)|feedback|(?<!\d\s?)marks|grades?|graded|results?|re-?evaluation|seating|invigilat\w*|cancel+ed|no (?:quiz|exam|class)|practice|mock|sample paper)\b/i;
  const ACTIVITY_RE = /\b(labs?|class(?:es)?|lectures?|tutorials?|sessions?|meetings?|office hours?|talk|seminar)\b/i;
  const EVENT_WORDS = /\b(workshop|session|crib|lab|talk|seminar|event|orientation|webinar|competition|hackathon|meet|meeting|lecture|class|defen[cs]e|interview|registration|fest|screening|tryouts?)s?\b/i;
  const DEADLINE_WORDS = /\b(due|deadline|last date|submit|submission|quiz|exam|test|mid-?sem|end-?sem|viva|assignment|homework|home work|lab|tutorial|presentation|interview|register|registration|apply|application|closes|before|by)\b/i;
  const TYPES = { quiz: "Quizzes & exams", deadline: "Assignment deadlines", event: "Events & talks", other: "Other dates" };
  const TYPE_COLORS = { quiz: "#b07c7c", deadline: "#7c8db5", event: "#8aa37a", other: "#a1a1aa" };

  // What kind of date is this? Looks at the words just before it, and the subject.
  const lastAt = (re, str) => { let i = -1; for (const m of str.matchAll(new RegExp(re.source, "gi"))) i = m.index; return i; };
  function typeOf(before, after, subj, clause = before, rest = after) {
    const near = before.slice(-60), sentence = clause + " " + rest;
    if (START_RE.test(near) && !DUE_RE.test(near.slice(-25))) return "start";
    // what is this date about? The clause leading up to it decides: "a crib session for the midsem on 14/10"
    // or "quiz 2 solutions will be discussed on 20 Oct" are about the crib/solutions, not the quiz itself
    const ni = lastAt(NOT_ASSESS_RE, clause), qi = lastAt(QUIZ_RE, clause);
    if (ni >= 0 && !(qi > ni && /\b(held|conducted|scheduled)\b/i.test(clause.slice(qi)))) return EVENT_WORDS.test(sentence) ? "event" : "other";
    if (/^[^.]{0,30}\b(cancel+ed|postponed|rescheduled|called off|will not be held)\b/i.test(rest)) return "other"; // "quiz on 29 Sept is cancelled"
    if (qi < 0 && ni < 0 && NOT_ASSESS_RE.test(rest.slice(0, 50)) && !QUIZ_RE.test(rest.slice(0, 50))) return "event";
    if (DUE_RE.test(near) && (WORK_RE.test(before + " " + subj) || /\bdue\b|deadline|submi/i.test(near))) return QUIZ_RE.test(near.slice(-30)) && !WORK_RE.test(near) ? "quiz" : "deadline";
    if (QUIZ_RE.test(sentence)) return "quiz";
    // the subject says "quiz" but this sentence is about a lab, class or session: not the quiz date
    if (QUIZ_RE.test(subj) && !WORK_RE.test(subj) && !EVENT_WORDS.test(sentence) && !ACTIVITY_RE.test(sentence)) return "quiz";
    if (WORK_RE.test(near) || DUE_RE.test(near)) return "deadline";
    if (EVENT_WORDS.test(near + " " + after) || EVENT_WORDS.test(subj)) return "event";
    return "other";
  }
  const LABEL_RE = /\b(quiz|assignment|homework|home work|hw|lab|tutorial|mid-?sem|end-?sem|exam|project|viva|test|problem set)\s*(?:no\.?\s*)?#?\s*(\d{1,2})?\b/i;
  function labelOf(before, subj, type) {
    const QUIZW = /^(quiz|mid-?sem|end-?sem|exam|viva|test)$/i;
    const fits = (x) => (type === "quiz") === QUIZW.test(x[1]);
    const all = [...before.slice(-80).matchAll(new RegExp(LABEL_RE.source, "gi"))].filter(fits);
    const sm = subj.match(LABEL_RE);
    const m = all.length ? all[all.length - 1] : sm && fits(sm) ? sm : null;
    if (!m) return "";
    const word = m[1].toLowerCase().replace("home work", "homework").replace(/^hw$/, "homework");
    const nice = { "mid-sem": "Midsem", midsem: "Midsem", "end-sem": "Endsem", endsem: "Endsem", "problem set": "Problem set" }[word] || word[0].toUpperCase() + word.slice(1);
    return nice + (m[2] ? " " + m[2] : "") + (type === "deadline" && !/due/i.test(nice) ? " due" : "");
  }

  function findDates(s, refTs, subj = "") {
    const out = [], ref = new Date(refTs);
    // Moodle forum mails start with "by <name> - Tuesday, 13 October 2026, 4:08 PM": that's when it was posted
    s = s.replace(/\bby [^\n]{2,80}? - (?:mon|tues|wednes|thurs|fri|satur|sun)day, \d{1,2} \w+ \d{4}, \d{1,2}:\d{2} ?[ap]m/gi, " ");
    for (const { re, d, m, y, num } of DATE_RES) {
      for (const hit of s.matchAll(re)) {
        const day = +hit[d], mon = num ? +hit[m] - 1 : MONTHS.indexOf(hit[m].slice(0, 3).toLowerCase());
        if (mon < 0 || mon > 11 || day < 1 || day > 31) continue;
        let year = hit[y] ? +hit[y] : 0;
        if (year && year < 100) year += 2000;
        if (!year) { year = ref.getFullYear(); if (new Date(year, mon, day) < new Date(refTs - 60 * DAY)) year++; }
        if (year < ref.getFullYear() - 1 || year > ref.getFullYear() + 1) continue;
        const end = hit.index + hit[0].length;
        const t = s.slice(end, end + 40).match(TIME_RE);
        let hh = 23, mm = 59, hasTime = false;
        if (t && (t[2] || t[3])) {
          hh = +t[1]; mm = t[2] ? +t[2] : 0; hasTime = true;
          const ap = (t[3] || "").toLowerCase();
          if (ap.startsWith("p") && hh < 12) hh += 12;
          if (ap.startsWith("a") && hh === 12) hh = 0;
          if (ap === "noon") { hh = 12; mm = 0; }
          if (hh > 23 || mm > 59) { hh = 23; mm = 59; hasTime = false; }
        }
        const ts = new Date(year, mon, day, hh, mm).getTime();
        if (hasTime && Math.abs(ts - refTs) < 3 * 3600 * 1000) continue; // a timestamp of the mail itself
        const before = s.slice(Math.max(0, hit.index - 120), hit.index), after = s.slice(end, end + 60);
        const sStart = Math.max(before.search(/[^.!?\n]*$/), 0), sEnd = after.search(/[.!?\n]/);
        const sentence = before.slice(sStart) + " " + hit[0] + " " + (sEnd < 0 ? after : after.slice(0, sEnd));
        const clause = before.slice(sStart), rest = /\.\s*$/.test(hit[0]) && /^\s*[A-Z]/.test(after) ? "" : sEnd < 0 ? after : after.slice(0, sEnd);
        const type = typeOf(before, after, subj, clause, rest);
        const na = type !== "quiz" && type !== "deadline" && sentence.match(NOT_ASSESS_RE);
        const label = na ? na[1][0].toUpperCase() + na[1].slice(1).toLowerCase() + (/session/i.test(sentence) && !/session/i.test(na[1]) ? " session" : "")
          + ((sentence.match(QUIZ_RE) || [])[1] ? " (" + sentence.match(QUIZ_RE)[1].toLowerCase() + ")" : "") : labelOf(before.slice(sStart), subj, type);
        out.push({ ts, hasTime, type, label });
      }
    }
    return out;
  }

  // bump DATES_VERSION whenever the date rules change, so every mail is read again with the new rules
  const DATES_VERSION = "bs-dates-v5";
  let deadlineCache = ls.get(DATES_VERSION, {}); // "mbox:uid" -> dates found in the body
  try { ["bs-deadlines-v1:", "bs-dates-v2:", "bs-dates-v3:", "bs-dates-v4:"].forEach((k) => localStorage.removeItem(k + USER)); } catch {}
  let hiddenEvents = new Set(ls.get("bs-hidden-events", []));
  let manualEvents = ls.get("bs-manual-events", []); // [{id, ts, hasTime, type, title, course}]
  const cleanSubject = (s) => s.replace(/^\s*(?:(?:re|fwd?|fw)\s*:\s*)*/i, "").replace(/^\[[^\]]+\]\s*/, "")
    .replace(/\b([A-Z]{2,3})\s?(\d{3}[A-Z]?)-\d{4}-\d-[A-Z0-9]+\s*:?\s*/, "").trim();

  // every date found in the last ~4 months of mail, one per mail+day, newest info wins
  let allEventsCache = [];
  function allEvents() {
    if (!eventsDirty) return allEventsCache;
    const since = Date.now() - 120 * DAY, out = [];
    for (const m of flat) {
      if (m.ts < since) break;
      if (/^\s*(re|fwd?|fw)\s*:/i.test(m.subj) && m.cat === "people") continue;
      const key = m.mbox + ":" + m.uid;
      const found = findDates(m.subj, m.ts, m.subj).concat(deadlineCache[key] || []);
      const perDay = new Map();
      const moodle = /moodle/i.test(m.email + " " + m.from), isRe = /^\s*(re|fwd?|fw)\s*:/i.test(m.subj);
      for (let d of found) {
        if (d.type === "start" || d.ts < m.ts - DAY) continue; // only dates after the mail was sent, no start dates
        // quizzes and deadlines must belong to one of your courses (or be a Moodle reminder with no code);
        // a Ph.D. defence, seminar or contest that mentions a "test" or "deadline" is not your quiz
        if ((d.type === "quiz" || d.type === "deadline") && (isRe || !(m.course || (moodle && !m.detected))))
          d = { ...d, type: m.detected && !m.course ? "skip" : COMP_RE.test(m.subj) || EVENT_WORDS.test(m.subj) ? "event" : "other", label: "" };
        if (d.type === "skip") continue;
        const day = new Date(d.ts).toDateString();
        const prev = perDay.get(day);
        const rank = { quiz: 0, deadline: 1, event: 2, other: 3 };
        if (!prev || rank[d.type] < rank[prev.type] || (d.hasTime && !prev.hasTime)) perDay.set(day, d);
      }
      for (const d of perDay.values()) {
        const title = d.label || cleanSubject(m.subj) || m.subj;
        out.push({ id: key + ":" + new Date(d.ts).toDateString(), ts: d.ts, hasTime: d.hasTime, type: d.type, title,
          detail: cleanSubject(m.subj), course: m.course, m });
      }
    }
    for (const e of manualEvents) out.push({ ...e, manual: true, detail: e.title });
    // the same thing announced in several mails: keep the newest announcement
    const uniq = new Map();
    for (const e of out) {
      const k = (e.course || "") + "|" + norm(e.title).slice(0, 30) + "|" + new Date(e.ts).toDateString();
      const prev = uniq.get(k);
      if (!prev || (e.m && prev.m && e.m.ts > prev.m.ts)) uniq.set(k, e);
    }
    allEventsCache = [...uniq.values()].sort((a, b) => a.ts - b.ts);
    eventsDirty = false;
    return allEventsCache;
  }
  // the ones you chose to see
  function events() {
    const mine = myCourseSet(), c = settings.cal;
    return allEvents().filter((e) => !hiddenEvents.has(e.id) && (e.manual || (c[e.type]
      && !(e.m && mutedTags.has(e.m.tag))
      && !(c.myOnly && mine && e.m && e.m.detected && !mine.has(e.m.detected)))));
  }
  const upcoming = (days = 45) => { const now = Date.now(); return events().filter((e) => e.ts > now - 6 * 3600 * 1000 && e.ts < now + days * DAY); };
  function hideEvent(id) { hiddenEvents.add(id); ls.set("bs-hidden-events", [...hiddenEvents]); eventsDirty = true; update(); }
  function addManual(ev) { manualEvents.push(ev); ls.set("bs-manual-events", manualEvents); eventsDirty = true; update(); }
  function removeManual(id) { manualEvents = manualEvents.filter((e) => e.id !== id); ls.set("bs-manual-events", manualEvents); eventsDirty = true; update(); }

  let scanning = false;
  async function scanDeadlines() {
    if (scanning) return;
    scanning = true;
    try {
      const now = Date.now();
      // your course mails first (they hold the quiz and deadline dates), going back 60 days; then other recent mail
      const fresh = (m) => !(m.mbox + ":" + m.uid in deadlineCache) && !mutedTags.has(m.tag);
      const courseMail = (m) => m.course || (/moodle/i.test(m.email + " " + m.from) && !m.detected);
      const todo = flat.filter((m) => m.ts > now - 60 * DAY && courseMail(m) && fresh(m)).slice(0, 200)
        .concat(flat.filter((m) => m.ts > now - 30 * DAY && !courseMail(m) && fresh(m)
          && (m.cat !== "people" || DEADLINE_WORDS.test(m.subj) || EVENT_WORDS.test(m.subj))).slice(0, 80));
      for (let i = 0; i < todo.length; i += 3) {
        await Promise.all(todo.slice(i, i + 3).map(async (m) => {
          try {
            const body = bodyText(await rawSource(m, 300_000));
            deadlineCache[m.mbox + ":" + m.uid] = findDates(body, m.ts, m.subj).filter((d) => d.ts > m.ts - DAY && d.type !== "start");
          } catch (e) { deadlineCache[m.mbox + ":" + m.uid] = []; }
        }));
        if (i % 15 === 0) { eventsDirty = true; update(); }
        await sleep(150);
      }
      const cut = now - 120 * DAY;
      for (const k of Object.keys(deadlineCache)) { const m = byKey.get(k); if (!m || m.ts < cut) delete deadlineCache[k]; }
      ls.set(DATES_VERSION, deadlineCache);
      eventsDirty = true;
      update();
    } finally { scanning = false; }
  }
  function icsFor(list) {
    const f = (ts) => new Date(ts).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//webmail-plus//EN"];
    for (const e of [].concat(list)) {
      const start = e.hasTime ? e.ts - 3600 * 1000 : e.ts;
      lines.push("BEGIN:VEVENT", "UID:" + e.id.replace(/[^\w.-]/g, "_") + "@webmail-plus", "DTSTAMP:" + f(Date.now()),
        "DTSTART:" + f(start), "DTEND:" + f(e.hasTime ? e.ts : e.ts + 60000),
        "SUMMARY:" + ((e.course ? e.course + ": " : "") + e.title).replace(/[,;\n]/g, " "),
        "DESCRIPTION:" + (e.detail || "").replace(/[,;\n]/g, " ") + (e.m ? " (from " + e.m.from.replace(/[,;]/g, " ") + ")" : ""),
        "BEGIN:VALARM", "TRIGGER:-PT12H", "ACTION:DISPLAY", "DESCRIPTION:Reminder", "END:VALARM", "END:VEVENT");
    }
    lines.push("END:VCALENDAR");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([lines.join("\r\n")], { type: "text/calendar" }));
    a.download = ([].concat(list).length > 1 ? "iitb-deadlines" : ([].concat(list)[0].title.slice(0, 40).replace(/[^\w ]+/g, "") || "event")) + ".ics";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // ---------- query: words + filters ----------
  function parseQuery(q) {
    const f = { terms: [], from: [], subject: [], course: [], folder: "", unread: false, att: false, after: 0, before: 0 };
    for (const tok of q.match(/\S+:"[^"]*"|"[^"]*"|\S+/g) || []) {
      const m = tok.match(/^(\w+):(.+)$/);
      const v = m ? m[2].replace(/^"|"$/g, "") : tok.replace(/^"|"$/g, "");
      const k = m ? m[1].toLowerCase() : "";
      if (k === "from") f.from.push(norm(v));
      else if (k === "subject") f.subject.push(norm(v));
      else if (k === "course") f.course.push(norm(v));
      else if (k === "in" || k === "folder") f.folder = v.toLowerCase();
      else if (k === "is" && /^unread|new$/i.test(v)) f.unread = true;
      else if (k === "has" && /^att/i.test(v)) f.att = true;
      else if ((k === "after" || k === "since") && !isNaN(Date.parse(v))) f.after = Date.parse(v);
      else if (k === "before" && !isNaN(Date.parse(v))) f.before = Date.parse(v);
      else if (k === "newer" || k === "older") {
        const d = v.match(/^(\d+)([dwmy])$/i);
        if (d) { const ms = +d[1] * { d: 1, w: 7, m: 30, y: 365 }[d[2].toLowerCase()] * DAY; if (k === "newer") f.after = Date.now() - ms; else f.before = Date.now() - ms; }
      } else if (norm(v)) f.terms.push(norm(v));
    }
    return f;
  }
  function matches(m, f) {
    if (f.unread && m.seen) return false;
    if (f.att && !m.att) return false;
    if (f.after && m.ts < f.after) return false;
    if (f.before && m.ts >= f.before) return false;
    if (f.folder && !m.mbox.toLowerCase().includes(f.folder)) return false;
    if (f.from.length && !f.from.every((t) => norm(m.from + m.email).includes(t))) return false;
    if (f.subject.length && !f.subject.every((t) => norm(m.subj).includes(t))) return false;
    if (f.course.length && !f.course.every((t) => norm(m.course).includes(t))) return false;
    return f.terms.every((t) => m.hay.includes(t));
  }

  async function searchBodies(q) {
    const words = q.replace(/\b\w+:("[^"]*"|\S+)/g, "").trim();
    if (!words) return [];
    const out = [], skip = EXCLUDED();
    const lists = await Promise.all(variants(words).slice(0, 3).map((v) => rcGet({
      _action: "search", _q: v, _headers: "subject,from,body", _filter: "ALL", _scope: "all", _mbox: rcmail.env.mailbox || "INBOX",
    }).then(parseRows).catch(() => [])));
    for (const r of lists.flat()) {
      const i = r.uid.indexOf("-");
      const mbox = r.flags.mbox || (i > 0 ? atobSafe(r.uid.slice(i + 1)) : rcmail.env.mailbox);
      const uid = i > 0 ? r.uid.slice(0, i) : r.uid;
      if (skip.has(mbox)) continue;
      const known = byKey.get(mbox + ":" + uid);
      if (known) { out.push({ ...known, body: true }); continue; }
      const [subj, from, ts, seen, att, email] = rowFrom(r);
      const m = { mbox, uid, subj, from, ts, seen, att, email, course: courseOf(subj, from), tag: listTag(subj), body: true };
      m.cat = categoryOf(m);
      out.push(m);
    }
    return out;
  }


  // ---------- styles for Webmail+ parts (the webmail-wide look is in theme.css) ----------
  const style = document.createElement("style");
  style.textContent = `
  :root{--bs-font:"Inter",-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;
    --bs-page:#fff;--bs-soft:#f7f7f8;--bs-fg:#18181b;--bs-mut:#71717a;--bs-line:#ececef;--bs-hov:#f4f4f5;--bs-sel:#eef0fd;
    --bs-acc:#4f46e5;--bs-mark:#fef3c7;--bs-chip:#f4f4f5;--bs-warn:#b45309;--bs-shadow:0 8px 24px rgba(0,0,0,.10)}
  html.dark-mode{--bs-page:#18181b;--bs-soft:#141416;--bs-fg:#e4e4e7;--bs-mut:#a1a1aa;--bs-line:#27272a;--bs-hov:#232326;--bs-sel:#25263a;
    --bs-acc:#a5b4fc;--bs-mark:#4a3b12;--bs-chip:#27272a;--bs-warn:#fbbf24;--bs-shadow:0 8px 24px rgba(0,0,0,.4)}
  .bs-card{background:var(--bs-page);border:1px solid var(--bs-line);border-radius:10px;box-shadow:var(--bs-shadow)}
  #bs-panel,#bs-cal,#bs-modal>div,#bs-side,#bs-help>div,#bs-pop{font-family:var(--bs-font);color:var(--bs-fg);-webkit-font-smoothing:antialiased}
  #bs-panel{position:fixed;z-index:9999;display:flex;flex-direction:column;background:var(--bs-page);font-size:14px;line-height:1.45;border-right:1px solid var(--bs-line)}
  #bs-panel[hidden],#bs-help[hidden],#bs-cal[hidden],#bs-modal[hidden]{display:none}
  #bs-panel .bs-h{padding:16px 20px 12px;border-bottom:1px solid var(--bs-line)}
  #bs-panel .bs-h1{display:flex;align-items:center;gap:10px}
  #bs-panel .bs-h1 b{font-size:17px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bs-x{border:0;background:none;color:var(--bs-mut);width:28px;height:28px;border-radius:6px;font-size:18px;line-height:1;cursor:pointer;flex:none}
  .bs-x:hover{color:var(--bs-fg);background:var(--bs-hov)}
  #bs-panel .bs-meta{color:var(--bs-mut);font-size:12.5px;margin-top:2px}
  #bs-panel a,#bs-side a,#bs-cal a,#bs-modal a{color:var(--bs-acc);cursor:pointer;text-decoration:none}
  .bs-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
  .bs-chipbtn{border:1px solid var(--bs-line);background:var(--bs-page);color:var(--bs-mut);border-radius:6px;padding:3px 10px;font:500 12.5px var(--bs-font);cursor:pointer}
  .bs-chipbtn.on{background:var(--bs-fg);border-color:var(--bs-fg);color:var(--bs-page)}
  .bs-chipbtn:hover:not(.on){color:var(--bs-fg);background:var(--bs-hov)}
  .bs-btn{border:1px solid var(--bs-acc);border-radius:7px;padding:6px 12px;font:500 13px var(--bs-font);cursor:pointer;background:var(--bs-acc);color:#fff}
  html.dark-mode .bs-btn:not(.ghost){color:#18181b}
  .bs-btn.ghost{background:var(--bs-page);border-color:var(--bs-line);color:var(--bs-fg)}
  .bs-btn.ghost:hover{background:var(--bs-hov)}
  #bs-panel .bs-bar{height:2px;background:var(--bs-line);margin-top:10px;overflow:hidden}
  #bs-panel .bs-bar i{display:block;height:100%;background:var(--bs-acc);transition:width .3s}
  #bs-panel .bs-list{overflow:auto;flex:1}
  #bs-panel .bs-group{padding:14px 20px 6px;font-size:11.5px;font-weight:600;color:var(--bs-mut);text-transform:uppercase;letter-spacing:.05em}
  #bs-panel .bs-r{display:flex;gap:12px;padding:10px 20px;cursor:pointer;align-items:flex-start;border-bottom:1px solid var(--bs-line)}
  #bs-panel .bs-r:hover{background:var(--bs-hov)}
  #bs-panel .bs-r.sel{background:var(--bs-sel)}
  .bs-av{flex:none;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:var(--bs-chip);color:var(--bs-mut);font-weight:600;font-size:13px;margin-top:1px}
  #bs-panel .bs-c{flex:1;min-width:0}
  #bs-panel .bs-t{display:flex;gap:8px;font-size:12.5px;color:var(--bs-mut)}
  #bs-panel .bs-t span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  #bs-panel .bs-tags{display:flex;gap:8px;margin-top:3px}#bs-panel .bs-tags:empty{display:none}
  #bs-panel .bs-s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
  #bs-panel .bs-u .bs-s,#bs-panel .bs-u .bs-t span:first-child{font-weight:600;color:var(--bs-fg)}
  #bs-panel .bs-u .bs-s::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--bs-acc);margin:0 7px 2px 0}
  .bs-chip{display:inline-block;font-size:11px;font-weight:500;padding:0 6px;border-radius:4px;background:var(--bs-chip);color:var(--bs-mut);margin-left:6px;vertical-align:1px}
  .bs-cchip{display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:500;color:var(--bs-mut);vertical-align:1px}
  .bs-cchip::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--c)}
  #bs-panel mark{background:var(--bs-mark);color:inherit;border-radius:2px;padding:0 1px}
  .bs-empty{padding:32px 16px;color:var(--bs-mut);text-align:center}
  #bs-panel .bs-foot{padding:10px 20px;color:var(--bs-mut);font-size:12.5px;border-top:1px solid var(--bs-line);display:flex;gap:14px;flex-wrap:wrap}
  #bs-panel .bs-files{margin:6px 0 0;padding:0;list-style:none;font-size:13px}#bs-panel .bs-files li{padding:2px 0}
  #bs-panel .bs-act{font-size:12.5px;margin-top:4px;display:flex;gap:12px}
  .bs-ev{display:flex;gap:12px;align-items:center;padding:8px 10px;margin:2px 0;border-radius:8px;cursor:pointer}
  #bs-panel .bs-ev{margin:0 10px}
  .bs-ev:hover{background:var(--bs-hov)}
  .bs-ev .w{flex:none;text-align:center;width:34px;border-right:2px solid var(--c,var(--bs-line));padding-right:10px}
  .bs-ev .w b{display:block;font-size:16px;font-weight:600;line-height:1.1}.bs-ev .w span{font-size:10.5px;color:var(--bs-mut);text-transform:uppercase}
  .bs-ev .t{flex:1;min-width:0}.bs-ev .t div{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .bs-ev .t b{font-weight:500}
  .bs-ev .t .s{font-size:12px;color:var(--bs-mut)}
  .bs-ev .soon{color:var(--bs-warn)}
  /* sidebar */
  #bs-side{margin:6px 8px 18px;font-size:13.5px;line-height:1.4}
  #bs-side h4{margin:18px 10px 4px;font:600 11px var(--bs-font);color:var(--bs-mut);text-transform:uppercase;letter-spacing:.06em;display:flex;align-items:center;gap:6px}
  #bs-side h4 span{flex:1;cursor:pointer}
  #bs-side h4 a{font-weight:500;text-transform:none;letter-spacing:0;font-size:12px}
  #bs-side .bs-i{display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:8px;cursor:pointer;white-space:nowrap;margin:1px 0}
  #bs-side .bs-i:hover{background:var(--bs-hov)}
  #bs-side .bs-i.on{background:var(--bs-hov);font-weight:600}
  #bs-side .bs-i .ic{width:16px;height:16px;flex:none;fill:none;stroke:var(--bs-mut);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  #bs-side .bs-i.on .ic{stroke:var(--bs-acc)}
  #bs-side .bs-i .n{flex:1;overflow:hidden;text-overflow:ellipsis}
  #bs-side .bs-i .c{font-size:12px;color:var(--bs-mut);font-variant-numeric:tabular-nums}
  #bs-side .bs-i .c.u{color:var(--bs-acc);font-weight:600}
  #bs-side .bs-cdot{width:7px;height:7px;border-radius:50%;flex:none;margin:0 4.5px}
  #bs-side .bs-more{padding:4px 10px;font-size:12.5px;color:var(--bs-mut)}
  #bs-side .bs-ev{padding:6px 10px}
  #bs-side label{cursor:pointer;display:flex;gap:6px;align-items:center}
  /* calendar */
  #bs-cal{position:fixed;z-index:9998;display:flex;flex-direction:column;background:var(--bs-page);font-size:14px}
  #bs-cal .bs-ch{display:flex;align-items:center;gap:10px;padding:16px 24px 10px;flex-wrap:wrap}
  #bs-cal .bs-ch h2{margin:0;font:600 20px var(--bs-font);min-width:180px}
  #bs-cal .nav{display:flex;gap:4px}
  #bs-cal .nav button{border:1px solid var(--bs-line);background:var(--bs-page);color:var(--bs-fg);border-radius:7px;height:30px;min-width:30px;padding:0 10px;cursor:pointer;font:500 13px var(--bs-font)}
  #bs-cal .nav button:hover{background:var(--bs-hov)}
  #bs-cal .sp{flex:1}
  #bs-cal .filters{padding:0 24px 14px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  #bs-cal .body{flex:1;display:flex;gap:20px;padding:0 24px 20px;min-height:0}
  #bs-cal .month{flex:1;display:grid;grid-template-columns:repeat(7,1fr);grid-auto-rows:1fr;border-top:1px solid var(--bs-line);border-left:1px solid var(--bs-line);min-width:0}
  #bs-cal .dow{font:600 11px var(--bs-font);color:var(--bs-mut);text-transform:uppercase;letter-spacing:.05em;padding:8px;border-right:1px solid var(--bs-line);border-bottom:1px solid var(--bs-line)}
  #bs-cal .day{border-right:1px solid var(--bs-line);border-bottom:1px solid var(--bs-line);padding:6px;min-height:0;overflow:hidden;cursor:pointer;display:flex;flex-direction:column;gap:2px}
  #bs-cal .day:hover{background:var(--bs-soft)}
  #bs-cal .day.out .num{opacity:.4}
  #bs-cal .day .num{font:500 12.5px var(--bs-font);color:var(--bs-mut);margin-bottom:2px}
  #bs-cal .day.today .num b{background:var(--bs-acc);color:#fff;border-radius:999px;padding:1px 7px}
  html.dark-mode #bs-cal .day.today .num b{color:#18181b}
  #bs-cal .pill{font:500 11.5px/1.4 var(--bs-font);padding:1px 6px;border-radius:4px;color:var(--bs-fg);background:var(--bs-chip);border-left:3px solid var(--c);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
  #bs-cal .pill:hover{background:var(--bs-line)}
  #bs-cal .pill.past{opacity:.5}
  #bs-cal .more{font-size:11px;color:var(--bs-mut);padding-left:4px}
  #bs-cal .side{width:280px;flex:none;overflow:auto}
  #bs-cal .side h3{margin:2px 10px 6px;font:600 11px var(--bs-font);color:var(--bs-mut);text-transform:uppercase;letter-spacing:.05em}
  #bs-pop{position:fixed;z-index:10001;width:290px;padding:14px 16px}
  #bs-pop h5{margin:6px 0 4px;font:600 15px var(--bs-font)}
  #bs-pop .m{color:var(--bs-mut);font-size:12.5px;margin:2px 0}
  #bs-pop .a{display:flex;gap:6px;margin-top:12px;flex-wrap:wrap}
  /* modal */
  #bs-modal,#bs-help{position:fixed;inset:0;z-index:10002;background:rgba(0,0,0,.35);display:grid;place-items:center}
  #bs-modal>div,#bs-help>div{background:var(--bs-page);border:1px solid var(--bs-line);border-radius:12px;padding:20px 22px;width:min(500px,92vw);max-height:84vh;overflow:auto;box-shadow:var(--bs-shadow);font-size:14px;line-height:1.5}
  #bs-modal h3,#bs-help h3{margin:0 0 4px;font:600 17px var(--bs-font)}
  #bs-modal .sub{color:var(--bs-mut);font-size:13px;margin-bottom:14px}
  #bs-modal .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:6px}
  #bs-modal .opt{display:flex;gap:8px;align-items:center;padding:7px 10px;border:1px solid var(--bs-line);border-radius:8px;cursor:pointer}
  #bs-modal .opt input{accent-color:var(--bs-acc)}
  #bs-modal .opt small{color:var(--bs-mut);margin-left:auto}
  #bs-modal input[type=text],#bs-modal input[type=date],#bs-modal input[type=time],#bs-modal select{font:14px var(--bs-font);padding:6px 10px;border:1px solid var(--bs-line);border-radius:7px;background:var(--bs-page);color:var(--bs-fg)}
  #bs-modal .row{display:flex;gap:8px;margin-top:10px;align-items:center;flex-wrap:wrap}
  #bs-modal .end{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
  #bs-help kbd{display:inline-block;min-width:18px;text-align:center;border:1px solid var(--bs-line);border-bottom-width:2px;border-radius:4px;padding:0 5px;font:12px ui-monospace,monospace;margin-right:2px}
  #bs-help code{background:var(--bs-chip);padding:0 5px;border-radius:4px}
  #messagelist tr.bs-muted-row{display:none}`;
  document.head.appendChild(style);
  document.documentElement.classList.toggle("bs-theme", !!settings.theme);
  try { localStorage.setItem("bs-theme", settings.theme ? "1" : "0"); } catch {}

  const avatar = (name) => {
    const n = name.replace(/\(.*?\)|<.*?>|"/g, "").trim() || "?";
    return `<span class="bs-av">${esc(n[0].toUpperCase())}</span>`;
  };
  const courseChip = (c) => c ? `<span class="bs-cchip" style="--c:${colorOf(c)}">${esc(c)}</span>` : "";
  function highlighter(terms) {
    terms = terms.filter(Boolean);
    if (!terms.length) return esc;
    const re = new RegExp("(" + terms.map((t) => [...t].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^\\p{L}\\p{N}]*")).join("|") + ")", "giu");
    return (s) => String(s).split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join("");
  }
  const ago = (ts) => { if (!ts) return "never"; const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago"; };
  const evColor = (e) => (e.type === "quiz" || e.type === "deadline") && e.course ? colorOf(e.course) : TYPE_COLORS[e.type] || TYPE_COLORS.other;
  function evCard(e, i) {
    const d = new Date(e.ts), soon = e.ts - Date.now() < 2 * DAY;
    return `<div class="bs-ev" data-ev="${i}" style="--c:${evColor(e)}"><div class="w"><b class="${soon ? "soon" : ""}">${d.getDate()}</b><span>${d.toLocaleDateString([], { month: "short" })}</span></div>
      <div class="t"><div><b>${esc(e.title)}</b></div><div class="s">${e.course ? esc(e.course) + " · " : ""}${esc(showWhen(e.ts, e.hasTime))}${e.type === "quiz" ? " · quiz/exam" : ""}</div></div></div>`;
  }

  // ---------- results panel (over the message list) ----------
  // view: { q, cat: all|course|notice|people, unread, att, course, mode: list|attachments, title }
  let panel, view = null, shown = [], sel = -1, bodies = { q: null, rows: null };
  const searchInput = () => document.querySelector('#mailsearchlist input[name="_q"], input#mailsearchform, input[name="_q"]');
  const listRect = () => (document.querySelector("#layout-list") || document.querySelector("#messagelist-content") || document.body).getBoundingClientRect();
  function placePanel() {
    const r = listRect(), inp = searchInput();
    const top = inp && inp.offsetParent ? inp.getBoundingClientRect().bottom + 8 : r.top + 50;
    Object.assign(panel.style, { left: r.left + "px", top: top + "px", width: r.width + "px", height: Math.max(r.bottom - top, 320) + "px" });
  }
  function openView(v) {
    if (v.mode === "calendar" || v.mode === "upcoming") return openCalendar();
    closeCalendar();
    view = { cat: "all", unread: false, att: false, q: "", mode: "list", ...v };
    sel = -1;
    if (!panel) { panel = document.createElement("div"); panel.id = "bs-panel"; document.body.appendChild(panel); }
    panel.hidden = false;
    placePanel();
    renderPanel();
    renderSide();
  }
  function closePanel() { if (panel) panel.hidden = true; view = null; sel = -1; renderSide(); }
  window.addEventListener("resize", () => { if (panel && !panel.hidden) placePanel(); if (cal && !cal.hidden) placeCalendar(); });

  function currentRows() {
    const f = parseQuery(view.q || "");
    if (view.unread) f.unread = true;
    if (view.att) f.att = true;
    const hideMuted = settings.hideMuted && view.cat !== "notice" && !view.q && !view.comp;
    let rows = flat.filter((m) => (view.cat === "all" || m.cat === view.cat) && (!view.course || m.course === view.course) && (!view.comp || m.comp)
      && !(hideMuted && mutedTags.has(m.tag)) && matches(m, f));
    if (view.q && bodies.q === view.q && bodies.rows) {
      const have = new Set(rows.map((m) => m.mbox + ":" + m.uid));
      rows = rows.concat(bodies.rows.filter((m) => !have.has(m.mbox + ":" + m.uid) && (view.cat === "all" || m.cat === view.cat)))
        .sort((a, b) => b.ts - a.ts || +b.uid - +a.uid);
    }
    return { rows, f };
  }

  function rowHtml(m, i, hl) {
    return `<div class="bs-r${m.seen ? "" : " bs-u"}${i === sel ? " sel" : ""}" data-i="${i}">${avatar(m.from)}
      <div class="bs-c"><div class="bs-t"><span>${hl(m.from)}</span><span>${showDate(m.ts)}</span></div>
      <div class="bs-s">${hl(m.subj || "(no subject)")}</div>
      <div class="bs-tags">${m.course && !view.course ? courseChip(m.course) : ""}${m.att ? '<span class="bs-chip" style="margin:0">Files</span>' : ""}${m.mbox !== "INBOX" ? `<span class="bs-chip" style="margin:0">${esc(m.mbox)}</span>` : ""}${m.body ? '<span class="bs-chip" style="margin:0">in body</span>' : ""}</div>
      ${view.mode === "attachments" ? `<div class="bs-act"><a data-files="${i}">Show files</a></div><ul class="bs-files" data-fl="${i}"></ul>` : ""}
      ${view.cat === "notice" && m.tag ? `<div class="bs-act"><a data-mute="${esc(m.tag)}">${mutedTags.has(m.tag) ? "Unmute" : "Mute"} [${esc(m.tag)}]</a></div>` : ""}</div></div>`;
  }

  function renderPanel() {
    if (!panel || panel.hidden || !view) return;
    const { rows, f } = currentRows();
    shown = rows;
    const hl = highlighter(f.terms.concat(f.from, f.subject));
    const pct = status.total ? Math.round((100 * status.done) / status.total) : 0;
    const unreadN = rows.filter((m) => !m.seen).length;
    const title = view.title || (view.q ? `${rows.length.toLocaleString()} result${rows.length === 1 ? "" : "s"} for “${esc(view.q)}”` : "Mail");
    const meta = status.building
      ? `Reading your mail for the first time: ${status.done}/${status.total} pages. Results fill in as it goes.`
      : `${rows.length.toLocaleString()} mails${unreadN ? ` · ${unreadN} unread` : ""} · updated ${ago(status.updated)}`;
    const chip = (key, label, on) => `<button class="bs-chipbtn${on ? " on" : ""}" data-chip="${key}">${label}</button>`;
    let list = "";
    if (!rows.length) list = `<div class="bs-empty">${status.building ? "Nothing yet, still reading your mail…" : view.q ? "No mails match. Try fewer words." : "Nothing here."}</div>`;
    else if (view.mode === "attachments" && !view.q) {
      const groups = new Map();
      rows.slice(0, MAX_SHOWN).forEach((m, i) => { const g = m.course || "Other"; if (!groups.has(g)) groups.set(g, []); groups.get(g).push([m, i]); });
      list = [...groups.entries()].sort((a, b) => (a[0] === "Other") - (b[0] === "Other") || a[0].localeCompare(b[0]))
        .map(([g, items]) => `<div class="bs-group">${esc(g)} · ${items.length}</div>` + items.map(([m, i]) => rowHtml(m, i, hl)).join("")).join("");
    } else list = rows.slice(0, MAX_SHOWN).map((m, i) => rowHtml(m, i, hl)).join("");
    if (rows.length > MAX_SHOWN) list += `<div class="bs-empty">Showing the newest ${MAX_SHOWN}. Add a word or filter to narrow it down.</div>`;
    const courseEv = view.course ? upcoming(60).filter((e) => e.course === view.course) : [];
    const foot = [];
    if (view.q) foot.push(bodies.q === view.q ? (bodies.rows ? "Includes matches inside mail bodies." : "Also checking inside mail bodies…") : "Press Enter to also search inside mail bodies.");
    if (unreadN) foot.push(`<a data-markread>Mark ${unreadN > 1 ? "all " + unreadN : "it"} as read</a>`);
    if (view.q) foot.push('<a data-native title="the webmail\'s own search">Use webmail search</a>');
      panel.innerHTML = `<div class="bs-h"><div class="bs-h1">${view.course ? `<span class="bs-cdot" style="width:9px;height:9px;border-radius:50%;background:${colorOf(view.course)}"></span>` : ""}<b>${title}</b><button class="bs-x" title="Close (Esc)">×</button></div>
      <div class="bs-meta">${meta}</div>
      <div class="bs-chips">${view.course || view.comp ? "" : chip("all", "All", view.cat === "all") + chip("course", "Courses", view.cat === "course") + chip("notice", "Notices", view.cat === "notice") + chip("people", "People", view.cat === "people")}${chip("unread", "Unread", view.unread)}${chip("att", "Files", view.att)}</div>
      ${status.building ? `<div class="bs-bar"><i style="width:${pct}%"></i></div>` : ""}</div>
      <div class="bs-list">${courseEv.length ? `<div class="bs-group">Coming up</div>` + courseEv.map((e) => evCard(e, "c" + allEvents().indexOf(e))).join("") + '<div class="bs-group">All mails</div>' : ""}${list}</div>
      ${foot.length ? `<div class="bs-foot">${foot.join("")}</div>` : ""}`;
    wirePanel();
  }

  function wirePanel() {
    panel.querySelector(".bs-x").onclick = closePanel;
    panel.querySelectorAll("[data-chip]").forEach((b) => (b.onclick = () => {
      const k = b.dataset.chip;
      if (k === "unread") view.unread = !view.unread;
      else if (k === "att") view.att = !view.att;
      else { view.cat = k; view.course = ""; view.title = { all: "", course: "Courses", notice: "Notices", people: "People" }[k] || (view.q ? "" : view.title); }
      sel = -1; renderPanel(); renderSide();
    }));
    const nat = panel.querySelector("[data-native]");
    if (nat) nat.onclick = () => { closePanel(); rcmail.command("search"); };
    const mr = panel.querySelector("[data-markread]");
    if (mr) mr.onclick = () => markRead(shown.filter((m) => !m.seen));
    panel.querySelectorAll("[data-ev]").forEach((el) => (el.onclick = (ev) => showPop(allEvents()[+el.dataset.ev.slice(1)], el)));
    panel.querySelectorAll(".bs-r[data-i]").forEach((el) => (el.onclick = (ev) => {
      const mute = ev.target.closest("[data-mute]");
      if (mute) { ev.stopPropagation(); return setMuted(mute.dataset.mute, !mutedTags.has(mute.dataset.mute)); }
      const files = ev.target.closest("[data-files]");
      if (files) { ev.stopPropagation(); return showFiles(+files.dataset.files, files); }
      if (ev.target.closest(".bs-files")) return;
      pick(+el.dataset.i);
    }));
  }

  // ---------- calendar ----------
  let cal, calMonth = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
  function placeCalendar() {
    const r = listRect();
    Object.assign(cal.style, { left: r.left + "px", top: r.top + "px", width: window.innerWidth - r.left + "px", height: Math.max(window.innerHeight - r.top, 400) + "px" });
  }
  function openCalendar() {
    if (panel) panel.hidden = true;
    view = { mode: "calendar" };
    if (!cal) { cal = document.createElement("div"); cal.id = "bs-cal"; document.body.appendChild(cal); }
    cal.hidden = false;
    placeCalendar();
    renderCalendar();
    renderSide();
  }
  function closeCalendar() { if (cal) cal.hidden = true; closePop(); if (view && view.mode === "calendar") view = null; }
  function renderCalendar() {
    if (!cal || cal.hidden) return;
    const evs = events(), c = settings.cal, mine = myCourseSet();
    const first = new Date(calMonth), startDow = (first.getDay() + 6) % 7; // weeks start on Monday
    const gridStart = new Date(first); gridStart.setDate(1 - startDow);
    const weeks = Math.ceil((startDow + new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()) / 7);
    const byDay = new Map();
    evs.forEach((e) => { const k = new Date(e.ts).toDateString(); if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(e); });
    const today = new Date().toDateString(), now = Date.now();
    let cells = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => `<div class="dow">${d}</div>`).join("");
    for (let i = 0; i < weeks * 7; i++) {
      const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
      const list = (byDay.get(d.toDateString()) || []).sort((a, b) => a.ts - b.ts);
      cells += `<div class="day${d.getMonth() !== first.getMonth() ? " out" : ""}${d.toDateString() === today ? " today" : ""}" data-day="${d.getTime()}">
        <div class="num"><b>${d.getDate()}</b></div>
        ${list.slice(0, 3).map((e) => `<div class="pill${e.ts < now ? " past" : ""}" style="--c:${evColor(e)}" data-eid="${esc(e.id)}" title="${esc((e.course ? e.course + " · " : "") + e.title + " · " + showWhen(e.ts, e.hasTime))}">${esc((e.course ? e.course.replace(" ", "") + " " : "") + e.title)}</div>`).join("")}
        ${list.length > 3 ? `<div class="more">+${list.length - 3} more</div>` : ""}</div>`;
    }
    const next = evs.filter((e) => e.ts > now - 6 * 3600 * 1000 && e.ts < now + 14 * DAY);
    const tchip = (k) => `<button class="bs-chipbtn${c[k] ? " on" : ""}" data-type="${k}">${TYPES[k]}</button>`;
    cal.innerHTML = `<div class="bs-ch"><h2>${first.toLocaleDateString([], { month: "long", year: "numeric" })}</h2>
        <div class="nav"><button data-nav="-1" title="Previous month">‹</button><button data-nav="0">Today</button><button data-nav="1" title="Next month">›</button></div>
        <div class="sp"></div><button class="bs-btn ghost" data-export title="Download the coming deadlines for Google / Apple Calendar">Export .ics</button>
        <button class="bs-btn" data-add>+ Add</button><button class="bs-x" title="Close (Esc)">×</button></div>
      <div class="filters">${Object.keys(TYPES).map(tchip).join("")}
        ${mine ? `<button class="bs-chipbtn${c.myOnly ? " on" : ""}" data-myonly>My courses only</button>` : ""}
        ${hiddenEvents.size ? `<a data-unhide style="font-size:12.5px;margin-left:6px">Show ${hiddenEvents.size} hidden</a>` : ""}
        ${scanning ? '<span class="bs-chip">reading recent mails for dates…</span>' : ""}</div>
      <div class="body"><div class="month" style="grid-template-rows:auto repeat(${weeks},1fr)">${cells}</div>
        <div class="side"><h3>Next 2 weeks</h3>${next.length ? next.map((e) => evCard(e, "c" + allEvents().indexOf(e))).join("") : '<div class="bs-empty">Nothing coming up with these filters.</div>'}
        <div class="bs-more" style="font-size:12px;color:var(--bs-mut);margin-top:8px">Dates are read from your course and notice mails (start dates are left out). Always check the mail itself.</div></div></div>`;
    cal.querySelector(".bs-x").onclick = closeCalendar;
    cal.querySelectorAll("[data-nav]").forEach((b) => (b.onclick = () => {
      const n = +b.dataset.nav;
      calMonth = n ? new Date(calMonth.getFullYear(), calMonth.getMonth() + n, 1) : (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
      renderCalendar();
    }));
    cal.querySelectorAll("[data-type]").forEach((b) => (b.onclick = () => { c[b.dataset.type] = !c[b.dataset.type]; saveSettings(); update(); }));
    const mo = cal.querySelector("[data-myonly]"); if (mo) mo.onclick = () => { c.myOnly = !c.myOnly; saveSettings(); update(); };
    const uh = cal.querySelector("[data-unhide]"); if (uh) uh.onclick = () => { hiddenEvents.clear(); ls.set("bs-hidden-events", []); update(); };
    cal.querySelector("[data-export]").onclick = () => { const list = events().filter((e) => e.ts > Date.now() - DAY); if (list.length) icsFor(list); };
    cal.querySelector("[data-add]").onclick = () => addEventModal(Date.now());
    cal.querySelectorAll("[data-eid]").forEach((p) => (p.onclick = (ev) => { ev.stopPropagation(); showPop(allEvents().find((e) => e.id === p.dataset.eid), p); }));
    cal.querySelectorAll("[data-ev]").forEach((el) => (el.onclick = () => showPop(allEvents()[+el.dataset.ev.slice(1)], el)));
    cal.querySelectorAll(".day").forEach((d) => (d.onclick = () => addEventModal(+d.dataset.day)));
  }

  let pop;
  function closePop() { if (pop) { pop.remove(); pop = null; } }
  function showPop(e, anchor) {
    closePop();
    if (!e) return;
    pop = document.createElement("div");
    pop.id = "bs-pop"; pop.className = "bs-card";
    pop.innerHTML = `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">${courseChip(e.course)}<span class="bs-chip" style="margin:0">${esc(TYPES[e.type] || "Date")}</span></div>
      <h5>${esc(e.title)}</h5><div class="m">${esc(showWhen(e.ts, e.hasTime))}</div>
      ${e.detail && e.detail !== e.title ? `<div class="m">${esc(e.detail)}</div>` : ""}${e.m ? `<div class="m">From ${esc(e.m.from)}</div>` : ""}
      <div class="a">${e.m ? '<button class="bs-btn" data-open>Open mail</button>' : ""}<button class="bs-btn ghost" data-ics>Add to calendar</button>
      <button class="bs-btn ghost" data-hide>${e.manual ? "Delete" : "Hide"}</button></div>`;
    document.body.appendChild(pop);
    const r = anchor.getBoundingClientRect();
    const left = Math.min(r.left, window.innerWidth - 316), top = r.bottom + 6 + 220 > window.innerHeight ? Math.max(8, r.top - 226) : r.bottom + 6;
    Object.assign(pop.style, { left: Math.max(8, left) + "px", top: top + "px" });
    const o = pop.querySelector("[data-open]");
    if (o) o.onclick = () => { closePop(); closeCalendar(); openMail(e.m); };
    pop.querySelector("[data-ics]").onclick = () => icsFor(e);
    pop.querySelector("[data-hide]").onclick = () => { closePop(); e.manual ? removeManual(e.id) : hideEvent(e.id); };
    setTimeout(() => document.addEventListener("mousedown", function off(ev) { if (pop && !pop.contains(ev.target)) { closePop(); document.removeEventListener("mousedown", off); } }), 0);
  }

  // ---------- modals: add an event, pick your courses ----------
  let modal;
  function showModal(html, wire) {
    if (!modal) { modal = document.createElement("div"); modal.id = "bs-modal"; document.body.appendChild(modal); modal.onclick = (e) => { if (e.target === modal) modal.hidden = true; }; }
    modal.innerHTML = `<div>${html}</div>`;
    modal.hidden = false;
    wire(modal);
  }
  function addEventModal(ts) {
    const d = new Date(ts), iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const courses = settings.myCourses || [...detectedCourses.keys()].sort();
    showModal(`<h3>Add to calendar</h3><div class="sub">Your own entry; only you see it.</div>
      <input type="text" data-f="title" placeholder="e.g. EE 229 Assignment 2 due" style="width:100%;box-sizing:border-box">
      <div class="row"><input type="date" data-f="date" value="${iso}"><input type="time" data-f="time">
        <select data-f="type">${Object.keys(TYPES).map((k) => `<option value="${k}"${k === "deadline" ? " selected" : ""}>${TYPES[k]}</option>`).join("")}</select>
        <select data-f="course"><option value="">No course</option>${courses.map((c) => `<option>${esc(c)}</option>`).join("")}</select></div>
      <div class="end"><button class="bs-btn ghost" data-cancel>Cancel</button><button class="bs-btn" data-save>Add</button></div>`, (m) => {
      const f = (k) => m.querySelector(`[data-f="${k}"]`);
      f("title").focus();
      m.querySelector("[data-cancel]").onclick = () => (m.hidden = true);
      m.querySelector("[data-save]").onclick = () => {
        const title = f("title").value.trim(), [y, mo, da] = f("date").value.split("-").map(Number);
        if (!title || !y) return f("title").focus();
        const [hh, mm] = (f("time").value || "23:59").split(":").map(Number);
        addManual({ id: "manual:" + Date.now(), ts: new Date(y, mo - 1, da, hh, mm).getTime(), hasTime: !!f("time").value, type: f("type").value, title, course: f("course").value });
        m.hidden = true;
      };
    });
  }
  function coursesModal() {
    const mine = myCourseSet();
    const recent = Date.now() - 150 * DAY;
    const all = [...detectedCourses.entries()].filter(([, v]) => v.last > recent).sort((a, b) => b[1].last - a[1].last);
    const chosen = new Set(mine || all.map(([c]) => c));
    (settings.myCourses || []).forEach((c) => { if (!detectedCourses.has(c)) all.push([c, { n: 0, last: 0 }]); });
    const opts = () => all.map(([c, v]) => `<label class="opt${chosen.has(c) ? " on" : ""}"><input type="checkbox" data-c="${esc(c)}" ${chosen.has(c) ? "checked" : ""}>
      <span class="bs-cdot" style="width:10px;height:10px;border-radius:4px;background:${colorOf(c)}"></span><b>${esc(c)}</b><small>${v.n || ""}</small></label>`).join("");
    showModal(`<h3>My courses</h3><div class="sub">Tick the courses you're taking this semester. Only these show in the sidebar, the Courses view and the calendar. Untick wrong guesses too.</div>
      <div class="grid" data-grid>${opts()}</div>
      <div class="row"><input type="text" data-new placeholder="Add a course, e.g. MA 109" style="flex:1"><button class="bs-btn ghost" data-addc>Add</button></div>
      <div class="end"><button class="bs-btn ghost" data-reset title="Go back to showing every course found">Show all found</button><button class="bs-btn" data-save>Save</button></div>`, (m) => {
      const wireOpts = () => m.querySelectorAll("[data-c]").forEach((cb) => (cb.onchange = () => { cb.checked ? chosen.add(cb.dataset.c) : chosen.delete(cb.dataset.c); cb.closest(".opt").classList.toggle("on", cb.checked); }));
      wireOpts();
      const add = () => {
        const c = courseCode(m.querySelector("[data-new]").value);
        if (!c) return;
        if (!all.some(([x]) => x === c)) all.unshift([c, detectedCourses.get(c) || { n: 0, last: 0 }]);
        chosen.add(c);
        m.querySelector("[data-grid]").innerHTML = opts(); wireOpts();
        m.querySelector("[data-new]").value = "";
      };
      m.querySelector("[data-addc]").onclick = add;
      m.querySelector("[data-new]").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); add(); } };
      m.querySelector("[data-reset]").onclick = () => { settings.myCourses = null; saveSettings(); rebuildFlat(); m.hidden = true; update(); };
      m.querySelector("[data-save]").onclick = () => { settings.myCourses = [...chosen].sort(); saveSettings(); rebuildFlat(); m.hidden = true; update(); };
    });
  }

  // ---------- sidebar ----------
  const ICONS = {
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    trophy: '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0z"/><path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  };
  let side, sideOpen = ls.get("bs-side-open", { courses: true, upcoming: true, lists: false });
  function ensureSide() {
    if (side && document.body.contains(side)) return side;
    const anchor = document.querySelector("#mailboxlist");
    if (!anchor) return null;
    side = document.createElement("div");
    side.id = "bs-side";
    anchor.parentElement.appendChild(side);
    return side;
  }
  function renderSide() {
    if (!ensureSide()) return;
    const recent = Date.now() - 150 * DAY;
    const mine = myCourseSet();
    const courseList = mine ? [...mine].sort().map((c) => [c, detectedCourses.get(c) || { n: 0, u: 0 }])
      : [...detectedCourses.entries()].filter(([, c]) => c.n >= 2 && c.last > recent).sort((a, b) => a[0].localeCompare(b[0]));
    const count = (pred) => flat.reduce((n, m) => n + (pred(m) ? 1 : 0), 0);
    const unread = (cat) => count((m) => !m.seen && (!cat || m.cat === cat) && !(settings.hideMuted && cat !== "notice" && mutedTags.has(m.tag)));
    const isOn = (k, course) => !!view && ((k === "calendar" && view.mode === "calendar") || (k === "attachments" && view.mode === "attachments")
      || (k === "comp" && view.comp) || (k === "unread" && view.unread && !view.q && view.cat === "all")
      || (course ? view.course === course : view.mode === "list" && !view.q && !view.course && !view.unread && !view.comp && view.cat === k));
    const item = (key, icon, bg, label, n, u, course = "") => `<div class="bs-i${isOn(key, course) ? " on" : ""}" data-v="${key}" ${course ? `data-course="${esc(course)}"` : ""}>
      ${icon ? `<svg class="ic" viewBox="0 0 24 24">${ICONS[icon]}</svg>` : bg ? `<span class="bs-cdot" style="background:${bg}"></span>` : ""}<span class="n">${esc(label)}</span>${u ? `<span class="c u">${u}</span>` : n ? `<span class="c">${n}</span>` : ""}</div>`;
    const soon = upcoming(21);
    const tags = new Map();
    for (const m of flat) if (m.tag && m.cat === "notice" && m.ts > recent) tags.set(m.tag, (tags.get(m.tag) || 0) + 1);
    const tagList = [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    side.innerHTML = `
      <h4><span>Smart views</span><a data-help title="Shortcuts and search tips">?</a></h4>
      ${item("course", "book", null, "Courses", 0, unread("course"))}
      ${item("notice", "bell", null, "Notices", 0, unread("notice"))}
      ${item("people", "user", null, "People", 0, unread("people"))}
      ${item("comp", "trophy", null, "Competitions", 0, count((m) => m.comp && !m.seen))}
      ${item("unread", "inbox", null, "All unread", 0, unread())}
      ${item("attachments", "clip", null, "Files", 0, 0)}
      ${item("calendar", "cal", null, "Calendar", soon.length, 0)}
      <h4><span data-toggle="courses">${sideOpen.courses ? "▾" : "▸"} My courses</span><a data-editcourses title="Choose your courses">Edit</a></h4>
      ${sideOpen.courses ? (courseList.length ? courseList.map(([c, v]) => item("courseX", "", colorOf(c), c, v.n, v.u, c)).join("")
        : `<div class="bs-more">${status.building ? "Reading your mail…" : "No courses yet. <a data-editcourses>Add yours</a>"}</div>`) : ""}
      ${sideOpen.courses && !mine && courseList.length ? '<div class="bs-more">Auto-detected. <a data-editcourses>Pick yours</a></div>' : ""}
      <h4><span data-toggle="upcoming">${sideOpen.upcoming ? "▾" : "▸"} Coming up</span></h4>
      ${sideOpen.upcoming ? (soon.length ? soon.slice(0, 5).map((e) => evCard(e, "c" + allEvents().indexOf(e))).join("") + (soon.length > 5 ? `<div class="bs-more"><a data-v="calendar">See all ${soon.length}</a></div>` : "")
        : `<div class="bs-more">${status.building || scanning ? "Looking for dates…" : "Nothing due in the next 3 weeks"}</div>`) : ""}
      <h4><span data-toggle="lists">${sideOpen.lists ? "▾" : "▸"} Mailing lists</span></h4>
      ${sideOpen.lists ? tagList.map(([t, n]) => `<div class="bs-i" data-tag="${esc(t)}" title="Click to ${mutedTags.has(t) ? "unmute" : "mute"}">
        <span class="n" style="${mutedTags.has(t) ? "opacity:.5;text-decoration:line-through" : ""}">${esc(t)}</span><span class="c">${n}</span></div>`).join("")
        + `<div class="bs-more"><label><input type="checkbox" data-set="hideMuted" ${settings.hideMuted ? "checked" : ""}> Hide muted lists from Inbox</label></div>` : ""}
      <div class="bs-more" style="margin-top:12px"><label><input type="checkbox" data-set="theme" ${settings.theme ? "checked" : ""}> Webmail+ look</label></div>`;
    side.querySelectorAll("[data-v]").forEach((el) => (el.onclick = () => {
      const v = el.dataset.v;
      if (v === "calendar") openCalendar();
      else if (v === "attachments") openView({ mode: "attachments", att: true, title: "Files" });
      else if (v === "unread") openView({ unread: true, title: "All unread" });
      else if (v === "comp") openView({ comp: true, title: "Competitions" });
      else if (v === "courseX") openView({ cat: "course", course: el.dataset.course, title: el.dataset.course });
      else openView({ cat: v, title: { course: "Courses", notice: "Notices", people: "People" }[v] });
    }));
    side.querySelectorAll("[data-ev]").forEach((el) => (el.onclick = () => showPop(allEvents()[+el.dataset.ev.slice(1)], el)));
    side.querySelectorAll("[data-toggle]").forEach((el) => (el.onclick = () => { sideOpen[el.dataset.toggle] = !sideOpen[el.dataset.toggle]; ls.set("bs-side-open", sideOpen); renderSide(); }));
    side.querySelectorAll("[data-editcourses]").forEach((el) => (el.onclick = coursesModal));
    side.querySelectorAll("[data-tag]").forEach((el) => (el.onclick = () => setMuted(el.dataset.tag, !mutedTags.has(el.dataset.tag))));
    side.querySelectorAll("[data-set]").forEach((el) => (el.onchange = () => { settings[el.dataset.set] = el.checked; saveSettings(); update(); }));
    const help = side.querySelector("[data-help]");
    if (help) help.onclick = showHelp;
  }
  function openMail(m) {
    const frame = document.querySelector("#messagecontframe");
    const qs = new URLSearchParams({ _task: "mail", _uid: m.uid, _mbox: m.mbox });
    if (frame && frame.offsetParent !== null) {
      qs.set("_action", "preview"); qs.set("_framed", "1"); frame.src = "./?" + qs;
      document.querySelector("#layout-content")?.classList.remove("hidden"); // small screens
    } else { qs.set("_action", "show"); window.open("./?" + qs, "_blank"); }
    m.seen = 1;
    const row = index.folders[m.mbox]?.rows[m.uid]; if (row) row[3] = 1;
  }
  function pick(i) {
    const m = shown[i];
    if (!m) return;
    sel = i;
    panel.querySelectorAll(".bs-r[data-i]").forEach((el) => el.classList.toggle("sel", +el.dataset.i === i));
    const el = panel.querySelector(`.bs-r[data-i="${i}"]`);
    if (el) { el.classList.remove("bs-u"); el.scrollIntoView?.({ block: "nearest" }); }
    openMail(m);
    renderSide();
  }

  async function showFiles(i, link) {
    const m = shown[i], ul = panel.querySelector(`[data-fl="${i}"]`);
    if (!m || !ul) return;
    link.textContent = "Loading…";
    try {
      const parts = mimeParts(await rawSource(m, 25_000_000)).filter((p) => p.name || (p.attachment && !/^text\//.test(p.ctype)));
      ul.innerHTML = parts.length ? parts.map((p) => {
        const href = "./?" + new URLSearchParams({ _task: "mail", _action: "get", _uid: m.uid, _mbox: m.mbox, _part: p.id, _download: "1" });
        return `<li><a href="${href}" target="_blank">${esc(p.name || "attachment " + p.id)}</a></li>`;
      }).join("") : "<li>No files found in this mail.</li>";
      link.remove();
    } catch (e) { link.textContent = "Couldn't load files"; }
  }

  async function markRead(list) {
    if (!list.length) return;
    if (list.length > 20 && !confirm(`Mark ${list.length} mails as read?`)) return;
    const byBox = new Map();
    for (const m of list) { if (!byBox.has(m.mbox)) byBox.set(m.mbox, []); byBox.get(m.mbox).push(m); }
    try {
      for (const [mbox, ms] of byBox) {
        for (let i = 0; i < ms.length; i += 300) {
          await rcPost("mark", { _uid: ms.slice(i, i + 300).map((m) => m.uid).join(","), _flag: "read", _mbox: mbox });
        }
        ms.forEach((m) => { m.seen = 1; const r = index.folders[mbox]?.rows[m.uid]; if (r) r[3] = 1; });
      }
      saveIndex();
      rcmail.command("checkmail"); // let the webmail refresh its own unread counts
    } catch (e) { alert("Couldn't mark them as read: " + e.message); }
    update();
  }

  // hide muted lists in the webmail's own message list
  function applyMutes() {
    const rows = document.querySelectorAll("#messagelist tbody tr");
    const on = settings.hideMuted && mutedTags.size;
    const box = rcmail.env.mailbox;
    for (const tr of rows) {
      let hide = false;
      if (on && box === "INBOX") {
        const subj = (tr.querySelector("span.subject a") || tr.querySelector("span.subject") || tr.querySelector("td.subject a") || tr).textContent || "";
        hide = mutedTags.has(listTag(subj.trim()));
      }
      tr.classList.toggle("bs-muted-row", hide);
    }
  }
  const listObserver = new MutationObserver(() => applyMutes());
  const watchList = () => { const tb = document.querySelector("#messagelist tbody"); if (tb) listObserver.observe(tb, { childList: true }); applyMutes(); };

  // ---------- help + keyboard ----------
  let help;
  function showHelp() {
    if (!help) {
      help = document.createElement("div");
      help.id = "bs-help";
      help.innerHTML = `<div><h3>Webmail+ shortcuts</h3>
        <p><kbd>/</kbd> search · <kbd>Esc</kbd> close · <kbd>j</kbd><kbd>k</kbd> or <kbd>↓</kbd><kbd>↑</kbd> move through results · <kbd>Enter</kbd> open<br>
        <kbd>g</kbd> then <kbd>u</kbd> unread · <kbd>c</kbd> courses · <kbd>n</kbd> notices · <kbd>p</kbd> people · <kbd>x</kbd> competitions · <kbd>d</kbd> calendar · <kbd>a</kbd> files<br>
        <kbd>?</kbd> this help</p>
        <b>Search tips</b><p>Words match subject and sender, ignoring spaces and dashes (EE229 = EE 229).<br>
        <code>from:mulleti</code> <code>subject:quiz</code> <code>course:EE229</code> <code>is:unread</code> <code>has:attachment</code><br>
        <code>newer:7d</code> <code>older:1m</code> <code>after:2026-09-01</code> <code>before:2026-10-01</code> <code>in:inbox</code><br>
        Press <kbd>Enter</kbd> to also search inside mail bodies; <kbd>Shift</kbd>+<kbd>Enter</kbd> for the webmail's own search.</p>
        <p style="color:var(--bs-mut);font-size:12.5px">Your mail list stays in this browser. Calendar dates are read from mail text, so always check the mail itself. Edit your courses from <b>My courses → Edit</b>.</p>
        <div style="text-align:right"><button class="bs-btn" data-close>Close</button></div></div>`;
      document.body.appendChild(help);
      help.onclick = (e) => { if (e.target === help || e.target.closest("[data-close]")) help.hidden = true; };
    }
    help.hidden = false;
  }

  const isSearchBox = (el) => el instanceof HTMLInputElement && (el.name === "_q" || !!el.closest("#mailsearchlist, #mailsearchform, .searchbar"))
    && !el.closest("#addressbook-search, #quicksearchbar-addressbook");
  const typingIn = (el) => el && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName));

  let typingTimer;
  document.addEventListener("input", (e) => {
    if (!isSearchBox(e.target)) return;
    clearTimeout(typingTimer);
    const input = e.target;
    typingTimer = setTimeout(() => {
      const q = input.value.trim();
      if (q.length < 2) { if (view && view.q) closePanel(); return; }
      if (view && view.mode === "list" && view.q) { view.q = q; sel = -1; renderPanel(); }
      else openView({ q });
      if (!flat.length) refreshIndex();
    }, 120);
  }, true);

  let gPending = 0;
  document.addEventListener("keydown", (e) => {
    if (help && !help.hidden && e.key === "Escape") { help.hidden = true; return; }
    if (e.key === "Escape" && modal && !modal.hidden) { modal.hidden = true; return; }
    if (e.key === "Escape" && pop) { closePop(); return; }
    if (e.key === "Escape" && cal && !cal.hidden) { closeCalendar(); renderSide(); return; }
    if (e.key === "Escape" && panel && !panel.hidden) { closePanel(); return; }
    if (modal && !modal.hidden) return;
    const open = panel && !panel.hidden;
    const inSearch = isSearchBox(e.target);
    const move = (d) => { e.preventDefault(); pick(Math.max(0, Math.min(shown.length - 1, sel + d))); };
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp") && (inSearch || !typingIn(e.target))) return move(e.key === "ArrowDown" ? 1 : -1);
    if (inSearch) {
      if (e.key !== "Enter" || e.shiftKey) return;
      const q = e.target.value.trim();
      e.preventDefault(); e.stopImmediatePropagation();
      if (!q) return closePanel();
      if (open && sel >= 0 && view.q === q) return pick(sel);
      if (!(view && view.mode === "list" && view.q)) openView({ q }); else { view.q = q; renderPanel(); }
      bodies = { q, rows: null };
      renderPanel();
      refreshIndex();
      searchBodies(q).then((rows) => { if (bodies.q === q) { bodies.rows = rows; renderPanel(); } });
      return;
    }
    if (typingIn(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (open && (e.key === "j" || e.key === "k")) return move(e.key === "j" ? 1 : -1);
    if (open && e.key === "Enter" && sel >= 0) { e.preventDefault(); return pick(sel); }
    if (e.key === "/") { const inp = searchInput(); if (inp) { e.preventDefault(); inp.focus(); inp.select(); } return; }
    if (e.key === "?") { e.preventDefault(); return showHelp(); }
    if (e.key === "g") { gPending = Date.now(); return; }
    if (Date.now() - gPending < 1200) {
      gPending = 0;
      const go = { u: () => openView({ unread: true, title: "All unread" }), c: () => openView({ cat: "course", title: "Courses" }),
        n: () => openView({ cat: "notice", title: "Notices" }), x: () => openView({ comp: true, title: "Competitions" }), p: () => openView({ cat: "people", title: "People" }),
        d: () => openCalendar(), a: () => openView({ mode: "attachments", att: true, title: "Files" }) }[e.key];
      if (go) { e.preventDefault(); go(); }
    }
  }, true);

  // ---------- start ----------
  let updateQueued = false;
  function update() {
    if (updateQueued) return;
    updateQueued = true;
    requestAnimationFrame(() => { updateQueued = false; renderSide(); renderPanel(); renderCalendar(); });
  }
  if (rcmail.addEventListener) {
    rcmail.addEventListener("listupdate", () => applyMutes());
    rcmail.addEventListener("init", watchList);
  }
  // clicking a folder or Mail in the menu goes straight back to the normal list
  document.addEventListener("click", (e) => {
    if (!e.target.closest || !e.target.closest("#mailboxlist a, #layout-menu a.mail, #layout-menu a[href*='_task=mail']")) return;
    if ((panel && !panel.hidden) || (cal && !cal.hidden)) { closeCalendar(); closePanel(); }
  }, true);
  watchList();
  renderSide();
  setTimeout(() => refreshIndex(), 2500);
  setInterval(() => refreshIndex(), 10 * 60 * 1000);
  console.log("[webmail+] ready,", flat.length, "mails indexed");
})();
