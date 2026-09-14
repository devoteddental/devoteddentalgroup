// netlify/functions/submit-referral.js
//
// Server-side handler for the Provider Referrals form. Replaces Netlify
// Forms entirely — the browser POSTs JSON (including any X-ray/CBCT
// files as base64) directly to this function, which sends the referral
// by email via Paubox (a HIPAA-compliant email API — see below) and
// reports success/failure back to the page.
//
// REQUIRED SETUP (Netlify dashboard, not in this file):
//   Site settings → Environment variables → add ONE variable:
//     PAUBOX_API_KEY  — the API key from your Paubox dashboard
//                        (Settings → API Keys), sent as a Bearer token.
//   The "from" address below (referrals@devoteddentalgroup.com) must
//   match a domain verified in Paubox, or sends will be rejected.
//
//   CONFIRMED WORKING (Aug 2026): this endpoint format — API key only,
//   no separate username — was verified with a real, successful send
//   through this exact form. Paubox's older SDKs (and some of their
//   own docs) describe a different URL requiring a separate "Endpoint
//   Username" (https://api.paubox.net/v1/YOUR_USERNAME/messages) —
//   that pattern turned out to be obsolete for this account; neither
//   Paubox's own support team nor an exhaustive dashboard search could
//   locate that value, which the working send below now explains.
//
// ⚠ COMPLIANCE STATUS: this form collects patient health information
// (X-rays/CBCT, date of birth, referral reason). Paubox provides a
// signed BAA with every plan (including free), which is why it was
// chosen here over a non-HIPAA-eligible provider — but the BAA still
// needs to actually be in place/accepted on the account before this
// carries real patient traffic. Until confirmed, treat submissions
// through this form as test data only.

const ALLOWED_ORIGIN = 'https://devoteddentalgroup.com';
const FROM_ADDRESS = 'referrals@devoteddentalgroup.com';
const BACKUP_RECIPIENT = 'brownp@devoteddentalgroup.com';
const PAUBOX_SEND_URL = 'https://api.paubox.com/v1/email/messages';

// Netlify Functions have a hard ~6MB request-body limit at the platform
// level — a request larger than that never reaches this code at all, so
// this check exists purely to give a clear error *before* that happens.
// (Paubox itself allows up to 50MB of attachments per message, but the
// Netlify Function receiving the browser's POST is the tighter limit
// here.) Base64 inflates file size by ~30%, and Netlify's own docs put
// the safe, effective ceiling for binary payloads at 4.5MB after that
// overhead — 4.2MB leaves headroom for the rest of the form's text
// fields. This was tested live at 5MB and confirmed to fail: real
// submissions at that size were rejected by Netlify's infrastructure
// before ever reaching this code (the browser saw only the page's
// generic "Something went wrong" fallback, never this function's own
// error message below). 4.2MB is the confirmed-safe ceiling; do not
// raise this without testing a real submission first. Keep this in
// sync with MAX_TOTAL_MB in the page's own JS, which checks the same
// total up front so a submission that passes there never gets
// rejected here.
const MAX_TOTAL_ATTACHMENT_BYTES = 4.2 * 1024 * 1024;

const OFFICE_EMAILS = {
  'Chesterfield': 'contactcf@devoteddentalgroup.com',
  'Highland':     'contact@devoteddentalgroup.com',
  'Livonia':      'contactliv@devoteddentalgroup.com',
  'Warren':       'contactwar@devoteddentalgroup.com',
  'Wyandotte':    'contactw@devoteddentalgroup.com',
};

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

  const required = ['refName', 'refOffice', 'refPhone', 'refEmail', 'refAddr1', 'patName', 'patDob', 'refReason', 'office'];
  for (const field of required) {
    if (!data[field] || String(data[field]).trim() === '') {
      return respond(400, { error: `Missing required field: ${field}` });
    }
  }

  const officeEmail = OFFICE_EMAILS[data.office];
  if (!officeEmail) {
    return respond(400, { error: 'Unrecognized office selection.' });
  }

  const attachments = [];
  let totalBytes = 0;
  for (const group of [data.xrayFiles, data.extraFiles]) {
    if (!Array.isArray(group)) continue;
    for (const f of group) {
      if (!f || !f.name || !f.base64) continue;
      const bytes = Math.ceil((f.base64.length * 3) / 4);
      totalBytes += bytes;
      if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
        return respond(400, { error: 'Attachments total over 4.2MB, the limit this email system can handle. Please remove or compress a file and resubmit.' });
      }
      attachments.push({
        fileName: f.name,
        contentType: guessContentType(f.name),
        content: f.base64,
      });
    }
  }

  const subject = `New Patient Referral — ${data.patName} (${data.office})`;
  const html = buildReferralHtml(data);

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
            recipients: [officeEmail, BACKUP_RECIPIENT],
            headers: {
              subject: subject,
              from: FROM_ADDRESS,
              'reply-to': data.refEmail,
            },
            content: {
              'text/html': html,
            },
            attachments: attachments.length ? attachments : undefined,
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
    console.error('submit-referral error:', err);
    return respond(502, { error: 'Failed to send referral email.' });
  }
};

function guessContentType(filename) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const map = {
    pdf: 'application/pdf',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
  return map[ext] || 'application/octet-stream';
}

function buildReferralHtml(d) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  return `
    <h2>New Patient Referral — ${esc(d.office)}</h2>
    <h3>Referring Dentist</h3>
    <p>
      ${esc(d.refPrefix)} ${esc(d.refName)}<br>
      Office: ${esc(d.refOffice)}<br>
      Phone: ${esc(d.refPhone)}<br>
      Email: ${esc(d.refEmail)}<br>
      Address: ${esc(d.refAddr1)}, ${esc(d.refCity)}, ${esc(d.refState)} ${esc(d.refZip)}
    </p>
    <h3>Patient</h3>
    <p>
      ${esc(d.patPrefix)} ${esc(d.patName)}<br>
      Date of birth: ${esc(d.patDob)}<br>
      Phone: ${esc(d.patPhone)}<br>
      Email: ${esc(d.patEmail)}<br>
      Insurance: ${esc(d.patInsurance)}
    </p>
    <h3>Referral Details</h3>
    <p>
      Reason: ${esc(d.refReason)}<br>
      Tooth #/area: ${esc(d.refTooth)}<br>
      Notes: ${esc(d.refNotes)}
    </p>
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
