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
  // buffer = extra school days allowed either side of each holiday (0 = holidays only).
  function buildCalendar(terms, bankHolidays, buffer) {
    buffer = buffer || 0;
    const off = new Set((terms.extraDaysOff || []).map(toDay));
    (bankHolidays || []).forEach((b) => off.add(toDay(b.date)));
    const base = (terms.holidays || []).map((h) => ({ name: h.name, start: toDay(h.start), end: toDay(h.end) }));
    const isWeekend = (d) => { const dow = new Date(d * dayMs).getUTCDay(); return dow === 0 || dow === 6; };
    // A real school day, ignoring any buffer.
    const isTermDay = (d) => !isWeekend(d) && !off.has(d) && !base.some((w) => d >= w.start && d <= w.end);
    const windows = base.map((w) => {
      let s = w.start, e = w.end, n = 0;
      while (n < buffer) { s--; if (isTermDay(s)) n++; }
      n = 0;
      while (n < buffer) { e++; if (isTermDay(e)) n++; }
      return { name: w.name, start: s, end: e, baseStart: w.start, baseEnd: w.end };
    });
    const lastKnown = windows.length ? Math.max(...windows.map((w) => w.end)) : 0;
    return {
      windows, lastKnown, buffer, isTermDay,
      windowFor(d) { return windows.find((w) => d >= w.start && d <= w.end) || null; },
      // "School day" for filtering: a term day outside the (buffered) holiday windows.
      isSchoolDay(d) { return isTermDay(d) && !windows.some((w) => d >= w.start && d <= w.end); },
    };
  }

  // How many real school days a journey takes the children out of.
  // Leaving after school on a term day doesn't count; arriving or being away on one does.
  function schoolDaysMissed(cal, depDate, depTime, homeDate, afterSchoolTime, leavingFromHome) {
    const dep = toDay(depDate), home = toDay(homeDate);
    let n = 0;
    if (cal.isTermDay(dep) && !(leavingFromHome && minutes(depTime) >= minutes(afterSchoolTime || '16:30'))) n++;
    for (let d = dep + 1; d <= home; d++) if (cal.isTermDay(d)) n++;
    return n;
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

  /* ---------- Single legs ---------- */
  // Is this one crossing usable without missing school?
  // Out: may leave on a school day only after school; must arrive on a non-school day.
  // Back: must leave and arrive on non-school days.
  function isLegAllowed(cal, row, direction, opts) {
    if (!opts.schoolHolidaysOnly) return true;
    const dep = toDay(row[F.depDate]), arr = toDay(row[F.arrDate]);
    if (arr > cal.lastKnown) return false;
    if (cal.isSchoolDay(dep)) {
      if (direction === 'back' || !opts.leaveAfterSchool) return false;
      if (minutes(row[F.depTime]) < minutes(opts.afterSchoolTime || '16:30')) return false;
    }
    for (let d = dep + 1; d <= arr; d++) if (cal.isSchoolDay(d)) return false;
    return true;
  }

  // Cheapest `perGroup` crossings in each school holiday (or each month when the school filter is off).
  function cheapestLegs(rows, cal, opts, direction, perGroup) {
    const groups = new Map();
    const legs = [];
    for (const r of rows) {
      const c = legCost(r, opts.fareType, opts.cabinMode);
      if (!c || !isLegAllowed(cal, r, direction, opts)) continue;
      const dep = toDay(r[F.depDate]), arr = toDay(r[F.arrDate]);
      let key, start, legWindow = null;
      if (opts.schoolHolidaysOnly) {
        const w = direction === 'out' ? (cal.windowFor(dep) || cal.windowFor(arr)) : (cal.windowFor(arr) || cal.windowFor(dep));
        if (!w) continue; // ordinary weekends are left out of this view
        // The buffer is only for leaving early or coming home late:
        // no outbound after the holiday's last day, no return before its first.
        if (direction === 'out' && dep >= w.baseEnd) continue;
        if (direction === 'back' && arr <= w.baseStart) continue;
        key = w.name; start = w.start;
        legWindow = w;
      } else {
        key = new Date(dep * dayMs).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        start = toDay(r[F.depDate].slice(0, 8) + '01');
      }
      legs.push({ r, c, key, start, missed: legWindow ? legMissed(cal, r, direction, legWindow, opts.afterSchoolTime) : 0 });
    }
    legs.sort((a, b) => a.c.total - b.c.total || (a.r[F.depDate] < b.r[F.depDate] ? -1 : 1));
    for (const l of legs) {
      if (!groups.has(l.key)) groups.set(l.key, { name: l.key, start: l.start, list: [] });
      const g = groups.get(l.key);
      if (g.list.length < perGroup) g.list.push(l);
    }
    return groups;
  }

  // School days lost because of this crossing: from leaving until the holiday starts (out),
  // or from the holiday ending until getting home (back).
  function legMissed(cal, row, direction, w, afterSchoolTime) {
    const dep = toDay(row[F.depDate]), arr = toDay(row[F.arrDate]);
    const from = direction === 'out' ? dep : Math.min(dep, w.baseEnd + 1);
    const to = direction === 'out' ? Math.max(arr, w.baseStart - 1) : arr;
    let n = 0;
    for (let d = from; d <= to; d++) {
      if (!cal.isTermDay(d)) continue;
      if (direction === 'out' && d === dep && minutes(row[F.depTime]) >= minutes(afterSchoolTime || '16:30')) continue;
      n++;
    }
    return n;
  }

  const api = { F, toDay, fromDay, buildCalendar, legCost, buildTrips, groupByWindow, dailyCheapest, isTripAllowed,
    isLegAllowed, cheapestLegs, schoolDaysMissed, legMissed };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FerryLogic = api;
})(this);
