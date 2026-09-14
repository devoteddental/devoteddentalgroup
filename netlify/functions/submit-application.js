// netlify/functions/submit-application.js
//
// Server-side handler for the Employment page's job application form.
// Replaces Netlify Forms entirely — the browser POSTs JSON (including
// the resume file as base64) directly to this function, which sends
// the application by email via Paubox and reports success/failure
// back to the page.
//
// REQUIRED SETUP (Netlify dashboard, not in this file):
//   Site settings → Environment variables → add ONE variable:
//     PAUBOX_API_KEY  — the API key from your Paubox dashboard
//                        (Settings → API Keys), sent as a Bearer token.
//   This is the exact same variable submit-referral.js uses — set it
//   once and both forms work. This form doesn't carry PHI (no
//   HIPAA/BAA requirement here), but it uses Paubox anyway so the
//   practice only has to manage one email provider instead of two.

const ALLOWED_ORIGIN = 'https://devoteddentalgroup.com';
const FROM_ADDRESS = 'careers@devoteddentalgroup.com';
const TO_RECIPIENTS = ['hr@devoteddentalgroup.com', 'brownp@devoteddentalgroup.com'];
const PAUBOX_SEND_URL = 'https://api.paubox.com/v1/email/messages';

// Netlify Functions have a hard ~6MB request-body limit at the platform
// level — a request larger than that never reaches this code at all, so
// this check exists purely to give a clear error *before* that happens.
// Base64 inflates file size by ~30%, and Netlify's own docs put the
// safe, effective ceiling for binary payloads at 4.5MB after that
// overhead — 4.2MB leaves headroom for the rest of the form's text
// fields. This matches the confirmed-safe value used on the Provider
// Referrals form (5MB was tested live there and failed at the
// platform level before ever reaching that function's code — see
// submit-referral.js for details). Keep this in sync with MAX_FILE_MB
// in the page's own JS, which stops an oversized resume from being
// attached at all.
const MAX_ATTACHMENT_BYTES = 4.2 * 1024 * 1024;

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method Not Allowed' });
  }
  if (!process.env.PAUBOX_API_KEY) {
    console.error('PAUBOX_API_KEY is not set in the Netlify environment.');
    return respond(500, { error: 'Server is not configured yet.' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (e) {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  // honeypot — real users never fill this in
  if (data.botField) {
    return respond(200, { ok: true });
  }

  const required = ['name', 'email', 'phone', 'role'];
  for (const field of required) {
    if (!data[field] || String(data[field]).trim() === '') {
      return respond(400, { error: `Missing required field: ${field}` });
    }
  }
  if (!data.resume || !data.resume.name || !data.resume.base64) {
    return respond(400, { error: 'Resume file is required.' });
  }

  const resumeBytes = Math.ceil((data.resume.base64.length * 3) / 4);
  if (resumeBytes > MAX_ATTACHMENT_BYTES) {
    return respond(400, { error: 'Resume is over the 4.2MB limit this email system can handle. Please use a smaller file and resubmit.' });
  }

  const subject = `New Job Application — ${data.name} (${data.role})`;
  const html = buildApplicationHtml(data);

  try {
    const res = await fetch(PAUBOX_SEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.PAUBOX_API_KEY}`,
      },
      body: JSON.stringify({
        data: {
          message: {
            recipients: TO_RECIPIENTS,
            headers: {
              subject: subject,
              from: FROM_ADDRESS,
              'reply-to': data.email,
            },
            content: {
              'text/html': html,
            },
            attachments: [{
              fileName: data.resume.name,
              contentType: guessContentType(data.resume.name),
              content: data.resume.base64,
            }],
          },
        },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      console.error('Paubox error:', res.status, errBody);
      return respond(502, { error: 'Email service rejected the request.' });
    }

    return respond(200, { ok: true });
  } catch (err) {
    console.error('submit-application error:', err);
    return respond(502, { error: 'Failed to send application email.' });
  }
};

function guessContentType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

function buildApplicationHtml(d) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `
    <h2>New Job Application</h2>
    <p>
      Name: ${esc(d.name)}<br>
      Email: ${esc(d.email)}<br>
      Phone: ${esc(d.phone)}<br>
      Role interested in: ${esc(d.role)}<br>
      Preferred location: ${esc(d.location)}
    </p>
    ${d.message ? `<h3>Message</h3><p>${esc(d.message)}</p>` : ''}
    <p>Resume attached.</p>
  `;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function respond(statusCode, bodyObj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
    body: JSON.stringify(bodyObj),
  };
}
