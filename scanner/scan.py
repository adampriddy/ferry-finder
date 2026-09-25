"""
Brittany Ferries daily fare scanner.

Pulls every route Brittany Ferries sells on its UK site, the full timetable for
each direction, and the fare for every sailing for one fixed travelling party
(set in scanner/config.json). Writes compact JSON into site/data/ for the web page.

Uses the same internal API the booking site itself calls:
  GET  /api/bebop/v1/route                -> list of routes
  GET  /api/bebop/v1/crossing?...         -> timetable (both directions)
  POST /api/bebop/v1/crossing/prices      -> fares, max ~1 week per call

Be gentle: one run per day, a pause between every request.
"""

import json
import random
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CONFIG = json.loads((ROOT / "scanner" / "config.json").read_text())
DATA = ROOT / "site" / "data"
DATA.mkdir(parents=True, exist_ok=True)

BASE = "https://www.brittany-ferries.co.uk/api/bebop/v1"
BANK_HOLIDAYS_URL = "https://www.gov.uk/bank-holidays.json"

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/140.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-GB,en;q=0.9",
    "Origin": "https://www.brittany-ferries.co.uk",
    "Referer": "https://www.brittany-ferries.co.uk/booking/choose-crossing/outbound",
})

stats = {"requests": 0, "errors": 0, "sailings": 0}


def pause():
    base = CONFIG.get("delay_seconds", 2.0)
    time.sleep(base + random.uniform(0, base / 2))


def call(method, path, **kw):
    """Request with retries and backoff. Returns parsed JSON or None."""
    for attempt in range(4):
        stats["requests"] += 1
        try:
            r = session.request(method, BASE + path, timeout=45, **kw)
            if r.status_code == 200:
                return r.json()
            print(f"  {method} {path[:60]} -> HTTP {r.status_code}", flush=True)
        except requests.RequestException as e:
            print(f"  {method} {path[:60]} -> {e}", flush=True)
        stats["errors"] += 1
        time.sleep(5 * (attempt + 1) ** 2)
    return None


def title(name):
    return " ".join(w.capitalize() for w in name.replace("-", " - ").split()).replace(" - ", "-")


def get_routes():
    groups = call("GET", "/route", params={"offerCode": "undefined"}) or []
    routes = {}
    for g in groups:
        for r in g["routes"]:
            dep, arr = r["departure"], r["arrival"]
            rid = f'{dep["code"]}-{arr["code"]}'
            routes[rid] = {
                "id": rid,
                "from": title(dep["name"]), "to": title(arr["name"]),
                "fromCode": dep["code"], "toCode": arr["code"],
                "fromCountry": dep["country"], "toCountry": arr["country"],
            }
    # Occasional routes (e.g. Plymouth-St Malo) aren't always in the route list; add them both ways.
    for x in CONFIG.get("extra_routes", []):
        for a, b, an, bn, ac, bc in ((x["from"], x["to"], x["fromName"], x["toName"], "GBR", x.get("country", "FRA")),
                                     (x["to"], x["from"], x["toName"], x["fromName"], x.get("country", "FRA"), "GBR")):
            routes.setdefault(f"{a}-{b}", {"id": f"{a}-{b}", "from": an, "to": bn, "fromCode": a, "toCode": b,
                                           "fromCountry": ac, "toCountry": bc})
    return routes


def get_timetable(a, b, horizon_end):
    """Timetable for a->b and b->a in one call."""
    params = {
        "outboundDeparturePort": a, "outboundArrivalPort": b,
        "inboundDeparturePort": b, "inboundArrivalPort": a,
        "dateFrom": date.today().isoformat() + "T00:00:00",
        "dateTo": horizon_end.isoformat() + "T00:00:00",
    }
    d = call("GET", "/crossing", params=params) or {}
    return d.get("outbound", []), d.get("inbound", [])


def amount(o):
    return o["amount"] if o and o.get("amount") is not None else None


def price_leg(dep, arr, direction, sailing_dates):
    """Fares for every sailing date on one leg, walking forward in <=7-day chunks."""
    party = CONFIG["party"]
    rows, i = [], 0
    dates = sorted(set(sailing_dates))
    while i < len(dates):
        start = date.fromisoformat(dates[i])
        end = start + timedelta(days=6)
        body = {
            "bookingReference": None,
            "pets": {"smallDogs": 0, "largeDogs": 0, "cats": 0},
            "passengers": {"adults": party["adults"], "children": party["children"],
                           "infants": party["infants"]},
            "vehicle": {"type": party["vehicle"]["type"], "registrations": ["TBC"],
                        "height": party["vehicle"]["height_cm"],
                        "length": party["vehicle"]["length_cm"],
                        "extras": {"rearMountedBikeCarrier": False}},
            "departurePort": dep, "arrivalPort": arr,
            "disability": None, "direction": direction,
            "fromDate": f"{start.isoformat()}T00:00:00",
            "toDate": f"{end.isoformat()}T23:59:59",
        }
        d = call("POST", "/crossing/prices", json=body)
        returned = []
        if d:
            for day in d.get("crossings", []):
                returned.append(day["date"])
                for p in day.get("prices", []):
                    x = p["crossingPrices"]
                    rows.append([
                        x["sailingId"],
                        x["departureDateTime"]["date"], x["departureDateTime"]["time"],
                        x["arrivalDateTime"]["date"], x["arrivalDateTime"]["time"],
                        x.get("shipName"),
                        amount(x.get("economyPrice")), amount(x.get("standardPrice")),
                        amount(x.get("flexiPrice")), amount(x.get("cabinPrice")),
                        1 if x.get("isAccommodationMandatory") else 0,
                        1 if x.get("full") else 0,
                    ])
        # The API sometimes returns fewer days than asked for; resume after the last one it gave.
        last = max(returned) if returned else end.isoformat()
        resume_after = min(last, end.isoformat())
        while i < len(dates) and dates[i] <= resume_after:
            i += 1
        pause()
    return rows


def cheapest(row):
    vals = [v for v in row[6:9] if v is not None]
    return min(vals) if vals else None


def update_history(sailings, today):
    """Keep a compact price log per sailing: only store a point when the cheapest fare changes."""
    path = DATA / "history.json"
    hist = json.loads(path.read_text()) if path.exists() else {}
    cutoff = today.isoformat()
    for rid, rows in sailings.items():
        for row in rows:
            key = str(row[0])
            c = cheapest(row)
            if c is None:
                continue
            h = hist.setdefault(key, {"r": rid, "d": f"{row[1]} {row[2]}", "p": []})
            if not h["p"] or h["p"][-1][1] != c:
                h["p"].append([cutoff, c])
    # Drop sailings that have already departed.
    hist = {k: v for k, v in hist.items() if v["d"][:10] >= cutoff}
    path.write_text(json.dumps(hist, separators=(",", ":")))
    return hist


def fetch_bank_holidays():
    try:
        r = requests.get(BANK_HOLIDAYS_URL, timeout=30)
        r.raise_for_status()
        events = r.json()["england-and-wales"]["events"]
        (DATA / "bank-holidays.json").write_text(json.dumps(
            [{"date": e["date"], "title": e["title"]} for e in events], indent=0))
    except Exception as e:  # keep the old file if gov.uk is unavailable
        print(f"Bank holidays not refreshed: {e}")


def main():
    today = date.today()
    horizon_end = today + timedelta(days=CONFIG.get("horizon_days", 400))
    only = set(CONFIG.get("routes") or [])

    routes = get_routes()
    if not routes:
        print("Could not load the route list. The site may be blocking this runner.")
        sys.exit(1)
    print(f"{len(routes)} routes found", flush=True)

    sailings = {}
    done_pairs = set()
    for rid, r in routes.items():
        a, b = r["fromCode"], r["toCode"]
        pair = tuple(sorted((a, b)))
        if pair in done_pairs:
            continue
        done_pairs.add(pair)
        if only and rid not in only and f"{b}-{a}" not in only:
            continue
        # Treat the UK-departing leg as "outbound", as the booking site does.
        if r["fromCountry"] != "GBR":
            a, b = b, a
        out, back = get_timetable(a, b, horizon_end)
        pause()
        for dep, arr, direction, tt in ((a, b, "outbound", out), (b, a, "inbound", back)):
            key = f"{dep}-{arr}"
            dates = [s["departureLocalDate"] for s in tt]
            print(f"{key}: {len(dates)} sailings in timetable", flush=True)
            sailings[key] = price_leg(dep, arr, direction, dates) if dates else []
            stats["sailings"] += len(sailings[key])

    if stats["sailings"] == 0:
        print("No fares returned at all - treating this run as failed.")
        sys.exit(1)

    hist = update_history(sailings, today)
    # Attach the previous cheapest fare (if it changed) and the date each sailing first appeared,
    # so the page needn't load history.
    for rows in sailings.values():
        for row in rows:
            p = hist.get(str(row[0]), {}).get("p", [])
            row.append(p[-2][1] if len(p) > 1 else None)
            row.append(p[-2][0] if len(p) > 1 else None)
            row.append(p[0][0] if p else today.isoformat())
    baseline_path = DATA / "baseline.txt"
    if not baseline_path.exists():
        baseline_path.write_text(today.isoformat())
    baseline = baseline_path.read_text().strip()

    latest = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "party": CONFIG["party"],
        "fields": ["sailingId", "depDate", "depTime", "arrDate", "arrTime", "ship",
                   "earlyBird", "standard", "flexi", "cabin", "cabinRequired", "full",
                   "prevCheapest", "prevDate", "firstSeen"],
        "baseline": baseline,
        "routes": list(routes.values()),
        "sailings": sailings,
        "stats": stats,
    }
    (DATA / "latest.json").write_text(json.dumps(latest, separators=(",", ":")))
    fetch_bank_holidays()
    print(f"Done: {stats}", flush=True)


if __name__ == "__main__":
    main()
