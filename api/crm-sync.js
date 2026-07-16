// POST /api/crm-sync — routes the demo-form lead into the Notion CRM.
//
// Upserts a Company and a Contact (deduped, so repeat submitters don't pile up)
// and always creates an Event ("Demo Request") in the Notion CRM, linking the
// Event to the Contact + Company. The team's Slack lead alert now comes from the
// Cal.com booking webhook (/api/booking) once the visitor books a slot.
//
// Runtime: Vercel Node serverless function (Node 18+, global fetch).
//
// Required env var:
//   NOTION_TOKEN — a Notion internal-integration token (ntn_… / secret_…).
//                  The integration must be shared with the CRM databases
//                  (Companies, Contacts, Events). See api/README.md.

const NOTION_VERSION = '2025-09-03';

// Data-source IDs from the CRM the other agent stood up (.context/crm/ids.json).
const DS = {
  companies: '5d737105-8042-4e0a-831a-d2578cc5c131',
  contacts: '0e7a9def-80ba-4b3d-b81c-e11f3c12f7ab',
  events: 'de729a5e-35c4-44fe-8aa7-79cc1cf94a46',
};

// Form "Company size" option -> Companies.Size select option.
const SIZE_MAP = {
  '1–50': '11-50', '1-50': '11-50',
  '51–200': '51-200', '51-200': '51-200',
  '201–1,000': '201-1000', '201-1000': '201-1000', '201–1000': '201-1000',
  '1,001–5,000': '1000+', '1001-5000': '1000+',
  '5,000+': '1000+', '5000+': '1000+',
};

// Don't guess a company website from a personal mailbox domain.
const FREE_EMAIL = new Set([
  'gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'aol.com',
  'proton.me', 'protonmail.com', 'gmx.com', 'live.com', 'msn.com', 'me.com',
]);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  let lead = req.body;
  if (typeof lead === 'string') {
    try { lead = JSON.parse(lead); } catch { lead = null; }
  }
  if (!lead || typeof lead !== 'object') {
    return res.status(400).json({ ok: false, error: 'invalid_body' });
  }

  const email = clean(lead.email);
  if (!email) return res.status(400).json({ ok: false, error: 'missing_email' });

  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error('[crm-sync] NOTION_TOKEN is not set. Lead:', JSON.stringify(lead));
    return res.status(500).json({ ok: false, error: 'notion_not_configured' });
  }

  try {
    const companyName = clean(lead.company);
    const companyId = companyName ? await upsertCompany(token, companyName, lead, email) : null;
    const contactId = await upsertContact(token, email, lead, companyId);
    const eventId = await createEvent(token, lead, email, contactId, companyId);
    return res.status(200).json({ ok: true, event: eventId, contact: contactId, company: companyId });
  } catch (err) {
    console.error('[crm-sync] failed:', err && err.message, 'lead:', JSON.stringify(lead));
    return res.status(502).json({ ok: false, error: 'notion_write_failed' });
  }
}

// ---------------------------------------------------------------------------
// CRM operations
// ---------------------------------------------------------------------------

async function upsertCompany(token, name, lead, email) {
  const existing = await findFirst(token, DS.companies, { property: 'Name', title: { equals: name } });
  if (existing) return existing;

  const props = {
    Name: title(name),
    Status: { select: { name: 'Prospect' } },
  };
  const size = SIZE_MAP[clean(lead.size)];
  if (size) props.Size = { select: { name: size } };
  const domain = companyDomain(email);
  if (domain) props.Website = { url: 'https://' + domain };

  return createPage(token, DS.companies, props);
}

async function upsertContact(token, email, lead, companyId) {
  const existing = await findFirst(token, DS.contacts, { property: 'Email', email: { equals: email } });
  if (existing) return existing; // keep the existing contact as-is; the Event records this touch

  const props = {
    Name: title(clean(lead.name) || email),
    Email: { email },
    Status: { select: { name: 'Lead' } },
  };
  const role = clean(lead.role);
  if (role) props.Title = richText(role);
  if (companyId) props.Company = { relation: [{ id: companyId }] };

  return createPage(token, DS.contacts, props);
}

async function createEvent(token, lead, email, contactId, companyId) {
  const name = clean(lead.name);
  const company = clean(lead.company);
  const heading = `Demo Request — ${name || email}${company ? ', ' + company : ''}`;

  const lines = [];
  if (clean(lead.trail)) lines.push('Trail: ' + clean(lead.trail));
  if (clean(lead.timeline)) lines.push('Timeline: ' + clean(lead.timeline));
  if (clean(lead.workflows)) lines.push('Workflows: ' + clean(lead.workflows));
  if (clean(lead.source)) lines.push('Page src: ' + clean(lead.source));
  if (clean(lead.page)) lines.push('Referrer: ' + clean(lead.page));

  const props = {
    Name: title(heading),
    Type: { select: { name: 'Demo Request' } },
    Email: { email },
    Source: { select: { name: 'Website' } },
    Message: richText(lines.join('\n') || '—'),
    'Raw Payload': richText(JSON.stringify(lead)),
  };
  const date = isoOrEmpty(lead.submittedAt);
  if (date) props.Date = { date: { start: date } };
  if (contactId) props.Contact = { relation: [{ id: contactId }] };
  if (companyId) props.Company = { relation: [{ id: companyId }] };

  return createPage(token, DS.events, props);
}

// ---------------------------------------------------------------------------
// Notion REST helpers
// ---------------------------------------------------------------------------

async function notion(token, path, method, body) {
  const r = await fetch('https://api.notion.com/' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`notion ${method} ${path} -> ${r.status} ${data.code || ''} ${data.message || ''}`);
  }
  return data;
}

async function findFirst(token, ds, filter) {
  const data = await notion(token, `v1/data_sources/${ds}/query`, 'POST', { filter, page_size: 1 });
  return data.results && data.results[0] ? data.results[0].id : null;
}

async function createPage(token, ds, properties) {
  const page = await notion(token, 'v1/pages', 'POST', {
    parent: { type: 'data_source_id', data_source_id: ds },
    properties,
  });
  return page.id;
}

// ---------------------------------------------------------------------------
// Value helpers — Notion caps title/rich_text text objects at 2000 chars.
// ---------------------------------------------------------------------------

function title(s) { return { title: [{ text: { content: String(s).slice(0, 2000) } }] }; }
function richText(s) { return { rich_text: [{ text: { content: String(s).slice(0, 2000) } }] }; }
function clean(v) { return v == null ? '' : String(v).trim(); }

function companyDomain(email) {
  const m = /@([^@\s]+)$/.exec(email);
  if (!m) return '';
  const d = m[1].toLowerCase();
  return FREE_EMAIL.has(d) ? '' : d;
}

function isoOrEmpty(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toISOString();
}
