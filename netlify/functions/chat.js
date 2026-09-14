// netlify/functions/chat.js
//
// Server-side proxy for the site's AI chat widget.
// The browser never sees the real Anthropic API key — it lives only in
// this function's environment (set in Netlify: Site settings > Environment
// variables > ANTHROPIC_API_KEY). This function receives the widget's
// request, attaches the real key, forwards it to Anthropic, and passes
// the response straight back.

const ALLOWED_ORIGIN = 'https://devoteddentalgroup.com';
const MAX_TOKENS_CAP = 500;          // hard ceiling regardless of what the client sends
const MAX_MESSAGE_COUNT = 20;        // basic abuse guard on conversation length

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method Not Allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is not set in the Netlify environment.');
    return respond(500, { error: 'Server is not configured yet.' });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { system, messages } = payload;

  if (!Array.isArray(messages) || messages.length === 0) {
    return respond(400, { error: 'messages array is required.' });
  }
  if (messages.length > MAX_MESSAGE_COUNT) {
    return respond(400, { error: 'Conversation too long.' });
  }

  const model = typeof payload.model === 'string' ? payload.model : 'claude-sonnet-4-6';
  const maxTokens = Math.min(
    Number.isFinite(payload.max_tokens) ? payload.max_tokens : 300,
    MAX_TOKENS_CAP
  );

  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: maxTokens,
        system: system,
        messages: messages,
      }),
    });

    const data = await anthropicRes.json();
    return respond(anthropicRes.status, data);
  } catch (err) {
    console.error('Anthropic proxy error:', err);
    return respond(502, { error: 'Upstream request failed.' });
  }
};

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
