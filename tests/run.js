const fs = require("fs");
// offline test of the calendar's date reader: node tests/run.js
const all = fs.readFileSync(require("path").join(__dirname, "../content.js"), "utf8");
const src = all.slice(all.indexOf("  // ---------- dates in mail text"), all.indexOf("  // bump DATES_VERSION"));
const f = new Function(`const DAY=864e5; const WEEKDAYS=["sun","mon","tue","wed","thu","fri","sat"]; const MONTHS=["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];\n${src}\n return { findDates };`)();
const T = (y, mo, d, h = 9, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const cases = require(require("path").join(__dirname, "cases.js"));
let ok = 0;
for (const c of cases) {
  const body = c.body.replace(/<\/p>/g, "\n").replace(/<[^>]+>/g, ""); const got = f.findDates(c.subj + "\n" + body, c.sent, c.subj).filter((d) => d.type !== "start" && d.ts > c.sent - 864e5)
    .map((d) => { const x = new Date(d.ts); return `${x.getDate()}/${x.getMonth() + 1} ${d.type}${d.label ? " " + d.label : ""}`; });
  const pass = c.want.every((w) => got.some((g) => g.startsWith(w))) && (c.not || []).every((n) => !got.some((g) => g.startsWith(n)));
  if (pass) ok++; else console.log("FAIL", c.subj, "\n  want", c.want, "not", c.not || [], "\n  got ", got);
}
console.log(ok + "/" + cases.length + " pass");
