// Canteen bill OCR — reads a photo of a canteen/pantry bill (printed or handwritten) and returns
// the lines as structured data: a date (if printed on the bill) plus one row per item with its
// quantity and amount. Uses Claude vision (Anthropic Messages API). There is no QR/barcode step —
// the bill is plain item-name + qty + price text, exactly as the Canteen Register stores entries.
//
// Needs ANTHROPIC_API_KEY in the environment. Degrades LOUDLY: if the key is missing or the call
// fails, it throws a clear Error the route turns into a friendly message — it never returns junk.

const API_URL = 'https://api.anthropic.com/v1/messages';
// Vision-capable model. Overridable without a code change if you move to a newer one.
const MODEL = process.env.CANTEEN_OCR_MODEL || 'claude-3-5-sonnet-20241022';
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const configured = () => Boolean(process.env.ANTHROPIC_API_KEY);

// Split a data URL ("data:image/jpeg;base64,....") into { media_type, data }.
function splitDataUrl(dataUrl) {
  const m = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(dataUrl || ''));
  if (!m) return null;
  const media_type = m[1].toLowerCase();
  if (!ALLOWED_MEDIA.includes(media_type)) return null;
  return { media_type, data: m[2].replace(/\s+/g, '') };
}

const PROMPT = [
  'You are reading a photograph of a canteen / pantry purchase bill or register page from an Indian',
  'workplace. It lists grocery/provision items with a quantity and a rupee amount. There is NO',
  'barcode or QR — just item names and numbers.',
  '',
  'Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:',
  '{"date":"YYYY-MM-DD or null","lines":[{"name":"ITEM NAME","qty":<number>,"amount":<number>}]}',
  '',
  'Rules:',
  '- "date": the bill/register date if one is clearly printed, as YYYY-MM-DD. If none is visible, null.',
  '- One object per item row. "name": the item exactly as written (expand obvious short forms only).',
  '- "qty": the quantity as a number (packets/pieces/kg). If a row shows no quantity, use 1.',
  '- "amount": the TOTAL rupee amount for that row as a number (no ₹ sign, no commas).',
  '- Skip header rows, running totals, grand totals and signatures — only real item rows.',
  '- If a number is unreadable, make your best estimate rather than dropping the row.',
].join('\n');

// Returns { date: 'YYYY-MM-DD'|null, lines: [{name, qty, amount}] }. Throws on failure.
async function readBill(dataUrl) {
  if (!configured()) throw new Error('Photo reading is not set up yet — the ANTHROPIC_API_KEY is missing.');
  const img = splitDataUrl(dataUrl);
  if (!img) throw new Error('That image could not be read. Please upload a clear JPG or PNG photo.');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  let r;
  try {
    r = await fetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'Reading the photo timed out. Please try again.' : 'Could not reach the photo-reading service.');
  } finally { clearTimeout(timer); }

  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error('[canteen ocr]', r.status, body.slice(0, 300));
    if (r.status === 401) throw new Error('Photo reading rejected the API key. Please check ANTHROPIC_API_KEY.');
    throw new Error('The photo-reading service returned an error (' + r.status + '). Please try again.');
  }

  const out = await r.json();
  const text = (out && Array.isArray(out.content) ? out.content : [])
    .filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim();
  const parsed = parseJson(text);
  if (!parsed || !Array.isArray(parsed.lines)) throw new Error('Could not understand the bill. Please try a clearer photo.');

  const date = /^\d{4}-\d{2}-\d{2}$/.test(parsed.date || '') ? parsed.date : null;
  const lines = parsed.lines.map((l) => ({
    name: String(l && l.name != null ? l.name : '').trim(),
    qty: cleanNum(l && l.qty),
    amount: cleanNum(l && l.amount),
  })).filter((l) => l.name);
  return { date, lines };
}

// Pull a JSON object out of the model text even if it wrapped it in ```json fences or prose.
function parseJson(text) {
  if (!text) return null;
  let s = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
  try { return JSON.parse(s); } catch { return null; }
}

function cleanNum(v) {
  if (v == null) return 0;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : 0;
}

module.exports = { configured, readBill, MODEL };
