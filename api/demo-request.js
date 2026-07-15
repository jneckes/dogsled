// POST /api/demo-request — receives a demo-request payload from /demo and posts
// a formatted lead card to Slack via an Incoming Webhook.
//
// Runtime: Vercel Node serverless function (Node 18+, global fetch available).
//
// Required env var:
//   SLACK_WEBHOOK_URL — a Slack Incoming Webhook URL (https://hooks.slack.com/services/...)
//                       The webhook is bound to a channel when you create it, so the
//                       destination channel is chosen in Slack, not here.
//
// The Notion CRM write is a separate concern and can be added alongside the Slack
// post later; this function is intentionally scoped to the Slack notification.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  // Vercel parses JSON bodies automatically; fall back to manual parse just in case.
  let lead = req.body;
  if (typeof lead === 'string') {
    try { lead = JSON.parse(lead); } catch { lead = null; }
  }
  if (!lead || typeof lead !== 'object') {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }

  // Email is the one field the form always requires.
  if (!lead.email || typeof lead.email !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing_email' });
  }

  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    // Don't lose the lead in logs if the webhook isn't configured yet.
    console.error('[lead] SLACK_WEBHOOK_URL is not set. Lead payload:', JSON.stringify(lead));
    return res.status(500).json({ ok: false, error: 'slack_not_configured' });
  }

  try {
    const slackRes = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSlackMessage(lead)),
    });
    if (!slackRes.ok) {
      const detail = await slackRes.text().catch(() => '');
      console.error('[lead] Slack webhook rejected:', slackRes.status, detail, 'payload:', JSON.stringify(lead));
      return res.status(502).json({ ok: false, error: 'slack_post_failed' });
    }
  } catch (err) {
    console.error('[lead] Slack webhook error:', err, 'payload:', JSON.stringify(lead));
    return res.status(502).json({ ok: false, error: 'slack_post_error' });
  }

  return res.status(200).json({ ok: true });
}

// ---------------------------------------------------------------------------
// Slack Block Kit message
// ---------------------------------------------------------------------------

function buildSlackMessage(lead) {
  const name = clean(lead.name) || '(no name)';
  const email = clean(lead.email);
  // The form sends a single `trail` string; tolerate the older `focus` array too.
  const trails = (lead.trail != null ? [lead.trail] : (Array.isArray(lead.focus) ? lead.focus : []))
    .map(clean).filter(Boolean);
  const topics = trails.length ? trails.map((t) => `\`${t}\``).join('  ') : '—';
  const source = clean(lead.source) || 'book-a-demo';
  const when = formatWhen(lead.submittedAt);

  // Fallback text (notifications / no-blocks clients).
  const fallback = `New pup — ${name} · ${email}`;

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🐶 New pup', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Name:* ${name}\n*Email:* <mailto:${email}|${email}>\n*Trails:* ${topics}`,
      },
    },
  ];

  const contextParts = [`Source: \`${source}\``];
  if (when) contextParts.push(`Submitted ${when}`);
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: contextParts.join('  ·  ') }],
  });

  // icon_emoji overrides the app's default avatar per-message (Slack honors this
  // for incoming webhooks). :dog: renders as the 🐶 puppy face.
  return { text: fallback, icon_emoji: ':dog:', blocks };
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
