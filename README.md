# Holiday crossings

Checks every Brittany Ferries crossing once a day and shows the cheapest return trips that fit inside Plymouth school holidays, for a trip length you choose.

## What's here

| Path | What it does |
|---|---|
| `scanner/scan.py` | Daily job. Pulls every route, the full timetable and the fare for every sailing, for the party in `config.json`. |
| `scanner/config.json` | Who's travelling, the car size, how far ahead to look, the pause between requests, and optionally which routes to scan. |
| `.github/workflows/scan.yml` | Runs the scanner every morning and commits the new data. |
| `site/` | The web page. Deploy this folder to Netlify. |
| `site/data/terms.json` | School holiday dates. Edit if your school's dates differ from the council's. |
| `site/data/latest.json` | Today's fares (written by the scanner). |
| `site/data/history.json` | Each sailing's cheapest fare over time, recorded only when it changes. |
| `site/data/baseline.txt` | Date of the first scan, so the first day's sailings aren't all marked as new. |
| `scanner/alerts.js` + `alerts.json` | After each scan, compares the cheapest trip in each school holiday with the day before and sends a push or email if it's dropped. |
| `scanner/run-on-vps.sh` | Same daily job for your VPS, if Brittany Ferries blocks GitHub's servers. |

## Setup

1. Create a **private** GitHub repo and push this folder to it.
2. In the repo, go to **Settings → Actions → General → Workflow permissions** and choose **Read and write permissions**.
3. Go to **Actions → Scan ferry fares → Run workflow** to do the first scan. A full scan of all routes takes 30 to 45 minutes because it pauses between requests.
4. In Netlify, choose **Add new site → Import an existing project**, pick the repo, and set the publish directory to `site` with no build command. Netlify redeploys automatically whenever the scanner commits.
5. Optional: GitHub's own scheduler can run late. To make the run time reliable, point a cron-job.org job at the `workflow_dispatch` endpoint, the same way as the stock watchlist.

## Alerts

Add these under **Settings → Secrets and variables → Actions**. Set whichever you want; anything missing is skipped.

- `NTFY_TOPIC` (secret): a hard-to-guess topic name. Subscribe to the same topic in the ntfy app.
- `RESEND_API_KEY`, `ALERT_EMAIL` and optionally `ALERT_FROM` (secrets): email through Resend, as with the stock watchlist.
- `SITE_URL` (variable): your Netlify address, so tapping the alert opens the page.

Edit `scanner/alerts.json` to choose what's watched. Each entry in `watches` is a crossing pair, a range of nights, a fare type, and an optional `target` price that alerts you when a holiday's cheapest trip falls below it. `minDrop` is the smallest drop, in pounds, worth telling you about. You'll also get a message whenever Brittany Ferries releases new sailings on any route. It gives how many were added, the date range, how many fall in school holidays, and the cheapest one-way fare among them. To limit this to certain routes, list them in `newSailings.routes`, for example `["GBPLY-FRROS", "FRROS-GBPLY"]`. To turn it off, set `"enabled": false`.

On the page, trips that use a sailing released in the last 7 days get a "Newly released" tag.

The first run only records a baseline, so alerts start from the second day.

## If the scan is blocked

If the workflow fails with HTTP 403 or 503 errors on every request, Brittany Ferries is refusing GitHub's servers. Clone the repo onto your VPS, then:

1. Run `pip install requests`.
2. Put your alert settings in `scanner/.env`.
3. Add the cron line from the top of `scanner/run-on-vps.sh`.

It runs the same scan and pushes the data to the repo, so Netlify still updates.

## Changing things

- **Different party or car:** edit `scanner/config.json`. Prices on the page only apply to the party the scanner used.
- **Fewer routes, quicker scans:** list route IDs in `"routes"`, for example `["GBPLY-FRROS", "GBPME-FRSML"]`. Each route covers both directions. Leave it empty to scan everything.
- **Trip length, fare type, cabins and the school-holiday filter** are set on the page and remembered on each device.

## Good to know

- Plymouth to Roscoff doesn't sail from early November to March, so winter trips need a Portsmouth route.
- Cabin prices are only added automatically when a sailing makes one compulsory. Tick "Add a cabin on night sailings" to include them on overnight crossings too.
- If a scan returns no fares at all, the workflow fails on purpose, so GitHub emails you.
