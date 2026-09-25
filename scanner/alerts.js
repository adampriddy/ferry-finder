/*
 * Price-drop alerts. Runs after the scanner.
 * Compares the cheapest trip in each school holiday today against the previous scan,
 * using exactly the same trip rules as the web page (site/app.js).
 *
 * Env (all optional - whatever is set gets used):
 *   NTFY_TOPIC      e.g. adam-ferries-x7k2   (push via https://ntfy.sh)
 *   RESEND_API_KEY  + ALERT_EMAIL + ALERT_FROM   (email via Resend)
 *   SITE_URL        link included in the alert
 * Usage: node scanner/alerts.js <previous latest.json> <new latest.json>
 */
const fs = require('fs');
const path = require('path');
const L = require('../site/app.js');

const root = path.resolve(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'scanner/alerts.json'), 'utf8'));
const terms = JSON.parse(fs.readFileSync(path.join(root, 'site/data/terms.json'), 'utf8'));
const bhPath = path.join(root, 'site/data/bank-holidays.json');
const banks = fs.existsSync(bhPath) ? JSON.parse(fs.readFileSync(bhPath, 'utf8')) : [];
const cal = L.buildCalendar(terms, banks, cfg.bufferDays || 0);

const [prevPath, newPath] = process.argv.slice(2);
const load = (p) => (p && fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
const prev = load(prevPath), now = load(newPath);
if (!now) { console.log('No new data - nothing to alert.'); process.exit(0); }

const gbp = (n) => '£' + Math.round(n).toLocaleString('en-GB');
const day = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const today = new Date().toISOString().slice(0, 10);

function bestPerWindow(data, watch) {
  if (!data) return new Map();
  const out = data.sailings[watch.out] || [], back = data.sailings[watch.back] || [];
  const trips = L.buildTrips(out, back, cal, {
    nightsMin: watch.nightsMin, nightsMax: watch.nightsMax, fareType: watch.fareType || 'cheapest',
    cabinMode: watch.cabins ? 'nights' : 'required', schoolHolidaysOnly: true,
    leaveAfterSchool: watch.leaveAfterSchool !== false, afterSchoolTime: '16:30',
  }).filter((t) => t.out[L.F.depDate] > today);
  const best = new Map();
  for (const t of trips) if (!best.has(t.window)) best.set(t.window, t); // trips arrive sorted cheapest first
  return best;
}

const lines = [];
for (const watch of cfg.watches) {
  const before = bestPerWindow(prev, watch), after = bestPerWindow(now, watch);
  for (const [win, t] of after) {
    const was = before.get(win);
    const label = `${win}: ${gbp(t.total)} return, ${t.nights} nights. Out ${day(t.out[L.F.depDate])} ${t.out[L.F.depTime]}, back ${day(t.back[L.F.depDate])} ${t.back[L.F.depTime]}`;
    if (was && was.total - t.total >= (cfg.minDrop || 1)) {
      lines.push(`${label} (was ${gbp(was.total)}, down ${gbp(was.total - t.total)})`);
    } else if (!was && prev) {
      lines.push(`${label} (new: sailings just released)`);
    } else if (watch.target && t.total <= watch.target && (!was || was.total > watch.target)) {
      lines.push(`${label} (now under your ${gbp(watch.target)} target)`);
    }
  }
}

// ---- Newly released sailings, on every route (or those listed in alerts.json) ----
const ns = cfg.newSailings || { enabled: true, routes: [] };
if (prev && ns.enabled !== false) {
  const routeName = new Map(now.routes.map((r) => [r.id, `${r.from} to ${r.to}`]));
  const short = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  for (const [rid, rows] of Object.entries(now.sailings)) {
    if (ns.routes && ns.routes.length && !ns.routes.includes(rid)) continue;
    const seen = new Set((prev.sailings[rid] || []).map((r) => r[L.F.id]));
    const added = rows.filter((r) => !seen.has(r[L.F.id]) && r[L.F.depDate] > today);
    if (!added.length) continue;
    const dates = added.map((r) => r[L.F.depDate]).sort();
    const inHols = added.filter((r) => cal.windowFor(L.toDay(r[L.F.depDate])));
    const cheapest = added.map((r) => ({ r, c: L.legCost(r, 'cheapest', 'required') })).filter((x) => x.c)
      .sort((a, b) => a.c.total - b.c.total)[0];
    let line = `New sailings, ${routeName.get(rid) || rid}: ${added.length} added, ${short(dates[0])}` +
      (dates.length > 1 ? ` to ${short(dates[dates.length - 1])}` : '');
    if (inHols.length) line += `, ${inHols.length} in school holidays`;
    if (cheapest) line += `. Cheapest ${gbp(cheapest.c.total)} one way on ${day(cheapest.r[L.F.depDate])}`;
    lines.push(line);
  }
}

if (!prev) { console.log('First run - saved a baseline, no alerts sent.'); process.exit(0); }
if (!lines.length) { console.log('No price drops or new sailings today.'); process.exit(0); }

const drops = lines.filter((l) => l.includes('(was ') || l.includes(' target)')).length;
const releases = lines.length - drops;
const title = [drops && (drops === 1 ? '1 price drop' : `${drops} price drops`),
  releases && 'new sailings released'].filter(Boolean).join(', ')
  .replace(/^./, (c) => c.toUpperCase());
const body = lines.join('\n') + (process.env.SITE_URL ? `\n\n${process.env.SITE_URL}` : '');
console.log(title + '\n' + body);

(async () => {
  if (process.env.NTFY_TOPIC) {
    const r = await fetch(`https://ntfy.sh/${process.env.NTFY_TOPIC}`, {
      method: 'POST', body,
      headers: { Title: title, Tags: 'ferry', ...(process.env.SITE_URL ? { Click: process.env.SITE_URL } : {}) },
    });
    console.log('ntfy:', r.status);
  }
  if (process.env.RESEND_API_KEY && process.env.ALERT_EMAIL) {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.ALERT_FROM || 'Ferry alerts <onboarding@resend.dev>',
        to: [process.env.ALERT_EMAIL], subject: title, text: body,
      }),
    });
    console.log('resend:', r.status);
  }
})();
