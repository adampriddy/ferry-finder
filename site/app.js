/* Holiday window finder - core logic (no DOM). Works in the browser and in Node for tests. */
(function (root) {
  const F = { id: 0, depDate: 1, depTime: 2, arrDate: 3, arrTime: 4, ship: 5,
    earlyBird: 6, standard: 7, flexi: 8, cabin: 9, cabinRequired: 10, full: 11,
    prevCheapest: 12, prevDate: 13, firstSeen: 14 };

  const dayMs = 86400000;
  const toDay = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / dayMs;
  const fromDay = (n) => new Date(n * dayMs).toISOString().slice(0, 10);
  const minutes = (t) => +t.slice(0, 2) * 60 + +t.slice(3, 5);

  /* ---------- School calendar ---------- */
  function buildCalendar(terms, bankHolidays) {
    const off = new Set((terms.extraDaysOff || []).map(toDay));
    (bankHolidays || []).forEach((b) => off.add(toDay(b.date)));
    const windows = (terms.holidays || []).map((h) => ({ name: h.name, start: toDay(h.start), end: toDay(h.end) }));
    const lastKnown = windows.length ? Math.max(...windows.map((w) => w.end)) : 0;
    return {
      windows,
      lastKnown,
      windowFor(d) { return windows.find((w) => d >= w.start && d <= w.end) || null; },
      isSchoolDay(d) {
        const dow = new Date(d * dayMs).getUTCDay();
        if (dow === 0 || dow === 6) return false;
        if (off.has(d)) return false;
        return !windows.some((w) => d >= w.start && d <= w.end);
      },
    };
  }

  /* ---------- Fares ---------- */
  // fareType: 'cheapest' | 'earlyBird' | 'standard' | 'flexi'
  // cabinMode: 'required' (add only when the sailing makes a cabin compulsory) | 'nights' (also on overnight sailings)
  function legCost(row, fareType, cabinMode) {
    if (row[F.full]) return null;
    let fare;
    if (fareType === 'cheapest') {
      const v = [row[F.earlyBird], row[F.standard], row[F.flexi]].filter((x) => x != null);
      fare = v.length ? Math.min(...v) : null;
    } else fare = row[F[fareType]];
    if (fare == null) return null;
    const overnight = row[F.arrDate] > row[F.depDate];
    let cabin = 0;
    if (row[F.cabin] != null && (row[F.cabinRequired] || (cabinMode === 'nights' && overnight))) cabin = row[F.cabin];
    return { fare, cabin, total: fare + cabin, overnight };
  }

  /* ---------- Trip building ---------- */
  // opts: { nightsMin, nightsMax, fareType, cabinMode, schoolHolidaysOnly, leaveAfterSchool, afterSchoolTime }
  function isTripAllowed(cal, out, back, opts) {
    if (!opts.schoolHolidaysOnly) return true;
    const dep = toDay(out[F.depDate]);
    const home = toDay(back[F.arrDate]);
    if (home > cal.lastKnown) return false; // no term dates published that far ahead
    if (cal.isSchoolDay(dep)) {
      if (!opts.leaveAfterSchool) return false;
      if (minutes(out[F.depTime]) < minutes(opts.afterSchoolTime || '16:30')) return false;
    }
    for (let d = dep + 1; d <= home; d++) if (cal.isSchoolDay(d)) return false;
    return true;
  }

  function buildTrips(outRows, backRows, cal, opts) {
    const outs = outRows.map((r) => ({ r, c: legCost(r, opts.fareType, opts.cabinMode), d: toDay(r[F.depDate]) }))
      .filter((x) => x.c);
    const backs = backRows.map((r) => ({ r, c: legCost(r, opts.fareType, opts.cabinMode), d: toDay(r[F.depDate]) }))
      .filter((x) => x.c);
    const byDay = new Map();
    backs.forEach((b) => { if (!byDay.has(b.d)) byDay.set(b.d, []); byDay.get(b.d).push(b); });

    const trips = [];
    for (const o of outs) {
      for (let n = opts.nightsMin; n <= opts.nightsMax; n++) {
        const list = byDay.get(o.d + n);
        if (!list) continue;
        for (const b of list) {
          // A return must leave after the outbound has arrived.
          if (b.r[F.depDate] === o.r[F.arrDate] && minutes(b.r[F.depTime]) <= minutes(o.r[F.arrTime])) continue;
          if (!isTripAllowed(cal, o.r, b.r, opts)) continue;
          const w = cal.windowFor(o.d) || cal.windowFor(toDay(b.r[F.arrDate]));
          trips.push({ out: o.r, back: b.r, outCost: o.c, backCost: b.c, nights: n,
            total: o.c.total + b.c.total, window: w ? w.name : 'Weekends and bank holidays' });
        }
      }
    }
    trips.sort((a, b) => a.total - b.total);
    return trips;
  }

  function groupByWindow(trips, cal, perWindow) {
    const order = new Map(cal.windows.map((w, i) => [w.name, w.start]));
    const groups = new Map();
    for (const t of trips) {
      if (!groups.has(t.window)) groups.set(t.window, []);
      const g = groups.get(t.window);
      if (g.length < perWindow) g.push(t);
    }
    return [...groups.entries()]
      .map(([name, list]) => ({ name, list, start: order.has(name) ? order.get(name) : Infinity }))
      .sort((a, b) => a.start - b.start);
  }

  // Cheapest single-leg price per departure day, for the season strip.
  function dailyCheapest(rows, fareType, cabinMode) {
    const m = new Map();
    for (const r of rows) {
      const c = legCost(r, fareType, cabinMode);
      if (!c) continue;
      const cur = m.get(r[F.depDate]);
      if (cur == null || c.total < cur) m.set(r[F.depDate], c.total);
    }
    return m;
  }

  const api = { F, toDay, fromDay, buildCalendar, legCost, buildTrips, groupByWindow, dailyCheapest, isTripAllowed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FerryLogic = api;
})(this);
