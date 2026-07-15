# Lead capture → Slack + Notion CRM

When someone submits the `/demo` form, the browser POSTs the lead payload to **two
independent routes in parallel** — one notifies Slack, one records the CRM. Either
can fail without affecting the other or the visitor's confirmation.

```
                        ┌─ POST /api/demo-request ─▶ api/demo-request.js ─▶ Incoming Webhook ─▶ #trailhead
/demo (static form) ────┤
                        └─ POST /api/crm-sync ──────▶ api/crm-sync.js ─────▶ Notion CRM (Event + Contact + Company)
```

- **Host:** Vercel project `dogsled` (team `bobsled-gtm`) → https://www.dogsledai.com
- **Functions:** `api/demo-request.js` (Slack), `api/crm-sync.js` (Notion) — auto-detected
  from the `/api` folder, no `vercel.json` needed
- **Slack workspace:** Dogsled Labs (`dogsledlabs.slack.com`) · **Channel:** `#trailhead`
- **Notion CRM:** Companies / Contacts / Events / Deals databases (IDs in `.context/crm/ids.json`)

---

## The Slack side

### App
A Slack app named **Website Leads** owns the webhook. It's reproducible from
[`slack-app-manifest.yaml`](./slack-app-manifest.yaml) — create the app at
https://api.slack.com/apps → **Create New App → From an app manifest**, pick the
**Dogsled Labs** workspace, paste the YAML.

- App avatar: set under **Basic Information → Display Information → App icon**
  (upload a 512×512 image; the puppy).
- Message avatar per-post: `api/demo-request.js` also sends `icon_emoji: ':dog:'` so each
  card shows the 🐶 face regardless of the app icon.

### Webhook
After the app exists: **Features → Incoming Webhooks → Add New Webhook to
Workspace → #trailhead → Allow**, then copy the `https://hooks.slack.com/services/…`
URL. The channel is baked into the webhook, so it isn't specified in code.

---

## The Vercel side

The webhook URL is stored as the `SLACK_WEBHOOK_URL` env var (Production +
Preview), never committed. It was set via the CLI:

```bash
vercel link --scope bobsled-gtm --project dogsled --yes
printf '%s' '<webhook-url>' | vercel env add SLACK_WEBHOOK_URL production
printf '%s' '<webhook-url>' | vercel env add SLACK_WEBHOOK_URL preview
vercel env ls          # verify
```

Env changes only take effect on the **next deployment** — redeploy after editing.
For local testing, copy `.env.example` → `.env` and run `vercel dev`.

---

## The Notion CRM route (`/api/crm-sync`)

`api/crm-sync.js` writes each lead into the CRM the other agent stood up
(`.context/crm/`). On every submit it:

1. **Upserts a Company** (if `company` given) — deduped by exact Name. New companies
   get `Status: Prospect`, `Size` mapped from the form, and `Website` inferred from
   the email domain (skipped for personal mailboxes like gmail).
2. **Upserts a Contact** — deduped by Email. New contacts get `Status: Lead`,
   `Title` from the form's role, and a relation to the Company. Existing contacts are
   left as-is (the Event below records the new touch).
3. **Creates an Event** — always. `Type: Demo Request`, `Source: Website`, `Date`,
   a human-readable `Message` (trail / timeline / workflows / page src / referrer),
   the full JSON in `Raw Payload`, and relations to the Contact + Company.

### Field mapping (form → Notion)
| Form field | Notion |
|---|---|
| `company` | Companies **Name** (deduped) |
| `size` | Companies **Size** — `1–50`→`11-50`, `51–200`→`51-200`, `201–1,000`→`201-1000`, `1,001–5,000`/`5,000+`→`1000+` |
| email domain | Companies **Website** (business domains only) |
| `name` | Contacts **Name** (falls back to email) |
| `email` | Contacts **Email** (dedupe key) |
| `role` | Contacts **Title** |
| `name`/`company` | Event **Name** → `Demo Request — {name}, {company}` |
| `trail`,`timeline`,`workflows`,`source`,`page` | Event **Message** (multi-line) |
| whole payload | Event **Raw Payload** (JSON) |

### Setup — Notion integration
The function authenticates with a **Notion internal-integration token** in the
`NOTION_TOKEN` env var (Production + Preview). The local `ntn` CLI's token is *not*
used at runtime — create a dedicated integration:

1. https://www.notion.so/my-integrations → **New integration** → name it
   "Dogsled Website", pick the workspace → copy the **Internal Integration Secret**
   (`ntn_…`).
2. **Share the CRM with it:** open the CRM hub page (and the Companies / Contacts /
   Events databases) in Notion → **⋯ → Connections → Add connections → Dogsled
   Website**. The integration can only see databases explicitly shared with it.
3. Add it to Vercel: `printf '%s' '<token>' | vercel env add NOTION_TOKEN production`
   (repeat for `preview`), then redeploy.

Uses the Notion API version `2025-09-03` (data-source model). Data-source IDs are
hard-coded in `api/crm-sync.js` from `.context/crm/ids.json`.

---

## Message format

```
🐶 New pup
Name:  <name>
Email: <email>            (clickable mailto)
Trails: `chip` `chip`     (the form's "where agents pull first" selections; — if none)
Source: `<src>` · Submitted <time>
```

Built by `buildSlackMessage()` in `api/demo-request.js` as Slack Block Kit (header +
section + context). The form captures more than is shown (company, role, size,
timeline, workflows) — those stay in the payload for the future Notion CRM.

## Payload shape (from `demo/index.html`)

```json
{
  "email": "jane@acme.com",
  "name": "Jane Doe",
  "company": "Acme",
  "role": "VP Data",
  "size": "201–1000",
  "focus": ["Manual workflows", "Data mapping"],
  "workflows": "Reconciling vendor feeds by hand every week",
  "timeline": "This quarter",
  "source": "home",
  "page": "https://dogsledlabs.com/",
  "submittedAt": "2026-07-15T21:00:00.000Z"
}
```

`api/demo-request.js` responses: `200 {ok:true}` on success · `400` bad body / missing
email · `405` non-POST · `500` webhook not configured · `502` Slack rejected.

---

## Testing

Fire a card without deploying (uses the real webhook + the production message
builder):

```bash
SLACK_WEBHOOK_URL='<webhook-url>' node --input-type=module -e '
process.env.SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
import("./api/demo-request.js").then(async ({default: handler}) => {
  const res = {setHeader(){}, status(c){this._s=c;return this}, json(o){console.log(this._s,o)}};
  await handler({method:"POST", body:{email:"test@acme.com", name:"Test", focus:["Data mapping"], source:"test", submittedAt:new Date().toISOString()}}, res);
});'
```

Or submit the real `/demo` form once deployed to production.

---

## Operational notes / gotchas

- **Rotating the webhook:** regenerate it on the app's Incoming Webhooks page,
  then update the Vercel env var (`vercel env rm` + `vercel env add`) and redeploy.
- **Deleting bot messages needs an owner.** Incoming webhooks are send-only and
  can't delete. Members can only delete messages they authored, so the app's
  cards can only be removed by a Dogsled Labs **workspace owner/admin** (or by
  giving the app `chat:write` and calling `chat.delete`). Keep test volume low.
- **Preview deploys are SSO-protected** — hitting a preview URL's `/api/demo-request`
  returns 401. Test against production (public) or via the script above.
- **Not on Vercel later?** The handler is `(req, res)`-style; Netlify/Cloudflare
  use `(request) → Response` — a thin adapter is all it'd take.

## Not done yet
- **Set `NOTION_TOKEN`** in Vercel (create the integration + share the CRM DBs, above).
  Until then `/api/crm-sync` returns `500 notion_not_configured` and the lead still
  reaches Slack.
- **Deploy** — both functions must ship to production before `/api/demo-request` and
  `/api/crm-sync` exist on `www.dogsledai.com` (commit + push, or `vercel deploy --prod`).
- **Live end-to-end check** — after `NOTION_TOKEN` is set and deployed, submit the
  `/demo` form once and confirm a Slack card in `#trailhead` + an Event/Contact/Company
  in Notion. (Every underlying Notion call is already verified against the live CRM.)
