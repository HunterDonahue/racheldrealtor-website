export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  RESEND_API_KEY: string;
}

const ALLOWED_FORM_TYPES = new Set(['contact', 'valuation']);
const NOTIFY_TO = 'rachdonahue@gmail.com';
const NOTIFY_FROM = 'Rachel Donahue Website <leads@racheldrealtor.com>';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildEmail(payload: Record<string, string>): { subject: string; html: string } {
  const isValuation = payload.formType === 'valuation';
  const subject = isValuation
    ? `New home valuation request — ${payload.address ?? 'no address given'}`
    : `New contact form message from ${payload.name ?? 'website visitor'}`;

  const rows: [string, string | undefined][] = isValuation
    ? [
        ['Name', payload.name],
        ['Email', payload.email],
        ['Phone', payload.phone],
        ['Property Address', payload.address],
        ['Timeline', payload.timeline],
      ]
    : [
        ['Name', payload.name],
        ['Email', payload.email],
        ['Phone', payload.phone],
        ['Message', payload.message],
      ];

  const rowsHtml = rows
    .filter(([, value]) => !!value)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#6b6258;font-family:sans-serif;font-size:13px;vertical-align:top;white-space:nowrap;">${label}</td><td style="padding:6px 0;color:#1f2933;font-family:sans-serif;font-size:14px;">${escapeHtml(
          String(value)
        ).replace(/\n/g, '<br/>')}</td></tr>`
    )
    .join('');

  const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
    <h2 style="color:#1f2933;font-family:Georgia,serif;">${isValuation ? 'New Home Valuation Request' : 'New Contact Message'}</h2>
    <p style="color:#6b6258;font-size:13px;">Submitted from racheldrealtor.com</p>
    <table style="border-collapse:collapse;width:100%;margin-top:12px;">${rowsHtml}</table>
  </div>`;

  return { subject, html };
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let payload: Record<string, string>;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'Invalid request body.' }, 400);
  }

  const formType = String(payload.formType ?? '');
  if (!ALLOWED_FORM_TYPES.has(formType)) {
    return json({ error: 'Unknown form type.' }, 400);
  }

  // Honeypot: a hidden field real visitors never see or fill. If it's populated,
  // silently pretend success so bots don't learn to look elsewhere — nothing is saved or emailed.
  if (String(payload.hp_company ?? '').trim() !== '') {
    return json({ ok: true });
  }

  const name = String(payload.name ?? '').trim();
  const email = String(payload.email ?? '').trim();
  if (!email || !email.includes('@')) {
    return json({ error: 'A valid email is required.' }, 400);
  }
  if (formType === 'contact' && !String(payload.message ?? '').trim()) {
    return json({ error: 'A message is required.' }, 400);
  }
  if (formType === 'valuation' && !String(payload.address ?? '').trim()) {
    return json({ error: 'A property address is required.' }, 400);
  }

  const phone = String(payload.phone ?? '').trim();
  const address = String(payload.address ?? '').trim();
  const timeline = String(payload.timeline ?? '').trim();
  const message = String(payload.message ?? '').trim();

  try {
    await env.DB.prepare(
      `INSERT INTO leads (form_type, name, email, phone, address, timeline, message) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(formType, name, email, phone, address, timeline, message)
      .run();
  } catch (err) {
    console.error('D1 insert failed', err);
    return json({ error: 'Could not save your request. Please call or text instead.' }, 500);
  }

  // Email notification is best-effort — a lead is already saved in D1 even if this fails
  // (e.g. before the racheldrealtor.com domain finishes DNS verification in Resend).
  try {
    const { subject, html } = buildEmail({ formType, name, email, phone, address, timeline, message });
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: NOTIFY_FROM,
        to: [NOTIFY_TO],
        reply_to: email,
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.error('Resend send failed', res.status, await res.text());
    }
  } catch (err) {
    console.error('Resend send threw', err);
  }

  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/submit') {
      if (request.method !== 'POST') {
        return json({ error: 'Method not allowed.' }, 405);
      }
      return handleSubmit(request, env);
    }

    return env.ASSETS.fetch(request);
  },
};
