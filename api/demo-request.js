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

  // Step 2 (about you) and step 3 (the ask) fields.
  const company = clean(lead.company);
  const role = clean(lead.role);
  const size = clean(lead.size);
  const workflows = clean(lead.workflows);
  const timeline = clean(lead.timeline);

  const source = clean(lead.source) || 'book-a-demo';
  const when = formatWhen(lead.submittedAt);

  // Fallback text (notifications / no-blocks clients).
  const fallback = `New Pup — ${name} · ${email}`;

  // Step 1 + step 2 identity fields, one per line, only what was filled in.
  const details = [
    `*Name:* ${name}`,
    `*Email:* <mailto:${email}|${email}>`,
  ];
  if (company) details.push(`*Company:* ${company}`);
  if (role) details.push(`*Role:* ${role}`);
  if (size) details.push(`*Company size:* ${size}`);
  details.push(`*Trails:* ${topics}`);
  if (timeline) details.push(`*Timeline:* ${timeline}`);

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: '🐶 New Pup', emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: details.join('\n') },
    },
  ];

  // Step 3 free-text — its own block so long answers stay readable.
  if (workflows) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Hardest workflows:*\n${workflows}` },
    });
  }

  const contextParts = [`Source: \`${source}\``];
  if (when) contextParts.push(`Submitted ${when}`);
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: contextParts.join('  ·  ') }],
  });

  // username + icon_emoji override the app's default name/avatar per-message
  // (Slack honors both for incoming webhooks). :dog: renders as the 🐶 puppy face.
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
