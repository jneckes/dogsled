// POST /api/booking — receives Cal.com booking webhooks (BOOKING_CREATED /
// BOOKING_RESCHEDULED / BOOKING_CANCELLED) and posts a card to Slack so the team
// sees *confirmed* sessions land on Josh's calendar, not just captured leads.
//
// Runtime: Vercel Node serverless function (Node 18+, global fetch + node:crypto).
//
// Env vars:
//   SLACK_WEBHOOK_URL   — reused from the lead flow (same #trailhead webhook).
//   CAL_WEBHOOK_SECRET  — optional but recommended. When set, the incoming
//                         X-Cal-Signature-256 header is verified as an HMAC-SHA256
//                         of the raw body. Set the SAME secret in Cal.com under
//                         Settings → Developer → Webhooks.
//
// Wire it up: in Cal.com add a webhook pointing at
//   https://www.dogsledai.com/api/booking
// subscribed to Booking Created / Rescheduled / Cancelled.

import crypto from 'node:crypto';

// We need the raw request body to verify the HMAC, so turn off Vercel's JSON parser.
export const config = { api: { bodyParser: false } };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const raw = await readRawBody(req);

  // Verify the signature only when a secret is configured (lets you deploy first,
  // secure second). Cal signs the raw body with HMAC-SHA256, hex-encoded.
  const secret = process.env.CAL_WEBHOOK_SECRET;
  if (secret) {
    const sig = req.headers['x-cal-signature-256'];
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!sig || !timingSafeEqual(sig, expected)) {
      console.error('[booking] bad or missing Cal signature');
      return res.status(401).json({ ok: false, error: 'bad_signature' });
    }
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); } catch { event = null; }
  if (!event || typeof event !== 'object') {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }

  const trigger = event.triggerEvent || 'BOOKING';
  const payload = event.payload || {};

  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    console.error('[booking] SLACK_WEBHOOK_URL is not set. Event:', JSON.stringify(event).slice(0, 2000));
    return res.status(500).json({ ok: false, error: 'slack_not_configured' });
  }

  try {
    const slackRes = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSlackMessage(trigger, payload)),
    });
    if (!slackRes.ok) {
      const detail = await slackRes.text().catch(() => '');
      console.error('[booking] Slack webhook rejected:', slackRes.status, detail);
      return res.status(502).json({ ok: false, error: 'slack_post_failed' });
    }
  } catch (err) {
    console.error('[booking] Slack webhook error:', err);
    return res.status(502).json({ ok: false, error: 'slack_post_error' });
  }

  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Slack Block Kit message — matches the "New Pup" lead card so bookings read as
// the same family of alerts in #trailhead.
// ---------------------------------------------------------------------------

function buildSlackMessage(trigger, p) {
  const attendee = (Array.isArray(p.attendees) && p.attendees[0]) || {};
  const name = clean(attendee.name) || '(no name)';
  const email = clean(attendee.email);
  const title = clean(p.title) || clean(p.eventTitle) || 'Session';
  const when = formatWhen(p.startTime);
  const tz = clean(attendee.timeZone);
  const uid = clean(p.uid);

  const label = {
    BOOKING_CREATED: '📅 Session booked',
    BOOKING_RESCHEDULED: '🔄 Session rescheduled',
    BOOKING_CANCELLED: '❌ Session cancelled',
  }[trigger] || '📅 Booking update';

  const fallback = `${label} — ${name} · ${title}`;

  const details = [`*Who:* ${name}`];
  if (email) details.push(`*Email:* <mailto:${email}|${email}>`);
  details.push(`*Session:* ${title}`);
  if (when) details.push(`*When:* ${when}${tz ? `  _(their tz: ${tz})_` : ''}`);

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: label, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: details.join('\n') } },
  ];

  const ctx = [];
  const src = p.metadata && clean(p.metadata.source);
  if (src) ctx.push(`Source: \`${src}\``);
  if (uid) ctx.push(`Cal ref: \`${uid}\``);
  if (ctx.length) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: ctx.join('  ·  ') }] });
  }

  return { text: fallback, username: 'New Pup', icon_emoji: ':dog:', blocks };
}

function clean(v) {
  if (v == null) return '';
  return String(v).trim().slice(0, 1000);
}

function formatWhen(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  // Slack renders <!date> tokens in each viewer's local timezone.
  const epoch = Math.floor(t / 1000);
  return `<!date^${epoch}^{date_short_pretty} {time}|${iso}>`;
}
