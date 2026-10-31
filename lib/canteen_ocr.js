// Canteen bill OCR — reads a photo of a canteen/pantry bill (printed or handwritten) and returns
// the lines as structured data: a date (if printed on the bill) plus one row per item with its
// quantity and amount. Uses Claude vision (Anthropic Messages API). There is no QR/barcode step —
// the bill is plain item-name + qty + price text, exactly as the Canteen Register stores entries.
//
// Needs ANTHROPIC_API_KEY in the environment. Degrades LOUDLY: if the key is missing or the call
// fails, it throws a clear Error the route turns into a friendly message — it never returns junk.

const API_URL = 'https://api.anthropic.com/v1/messages';
// Vision-capable model. Overridable without a code change if you move to a newer one.
const MODEL = process.env.CANTEEN_OCR_MODEL || 'claude-sonnet-5-5';
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

const PROMPT_BASE = [
  'You are reading a photograph that may contain ONE OR SEVERAL purchase bills',
  '(printed receipts or handwritten register pages) from an Indian workplace — they may be laid out',
  'side by side or stacked in the same photo. Each bill is a SEPARATE receipt with its OWN header,',
  'date and total. There is NO barcode or QR — just item names and numbers.',
  '',
  'Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:',
  '{"bills":[{"date":"YYYY-MM-DD or null","total":<number or null>,"lines":[{"name":"ITEM NAME","qty":<number>,"amount":<number>}]}]}',
  '',
  'Rules:',
  '- Treat EACH separate receipt visible in the photo as its own object in "bills". If the photo has',
  '  five receipts, return five bills; if it has one, return one.',
  '- "total": that bill\'s printed/written GRAND TOTAL (e.g. "1480") as a number, or null if not',
  '  visible. Do NOT add it as a line item. Read the AMOUNT column (the line total), not Rate or MRP.',
  '  A trailing dash after an amount (e.g. "150 —") is just a currency stroke; ignore it.',
  '- "date": that bill\'s purchase date. Indian bills write it DAY first — DD/MM/YY or DD/MM/YYYY —',
  '  usually near the top or bottom (e.g. "03/10/2026" = 3 October 2026).',
  '  Convert it to YYYY-MM-DD, reading a 2-digit year YY as 20YY. Use null only if that bill has no date.',
  '- One object per item row.',
  '- "qty": the quantity as a number (pieces/kg/bundles). Quantities may be written as fractions:',
  '  "½" or "V2" or "1/2" = 0.5, "¼" or "V4" or "1/4" = 0.25, "3½" = 3.5, "1½" = 1.5. Convert to a',
  '  decimal. If a row shows no quantity, use 1.',
  '- "amount": the TOTAL rupee amount for that row as a number (no ₹ sign, no commas).',
  '- Skip header rows, shop names, running totals, grand totals and signatures — only real item rows.',
  '- If a number is unreadable, make your best estimate rather than dropping the row.',
];
const NAME_PLAIN = '- "name": the item exactly as written, in UPPERCASE (expand obvious short forms only).';
const NAME_VEG = [
  '- These are VEGETABLE bills, usually HANDWRITTEN in Tamil or Malayalam. For "name", read the',
  '  vegetable and give its COMMON ENGLISH name in UPPERCASE (not a transliteration). Examples:',
  '  தக்காளி→TOMATO, வெங்காயம்→ONION, வெங்காயம் சிறிய→SMALL ONION, உருளைக்கிழங்கு→POTATO,',
  '  பீன்ஸ்→BEANS, கேரட்→CARROT, முட்டைகோஸ்→CABBAGE, காலிஃப்ளவர்→CAULIFLOWER, கத்தரிக்காய்→BRINJAL,',
  '  வெண்டைக்காய்→LADIES FINGER, முருங்கைக்காய்→DRUMSTICK, பச்சை மிளகாய்→GREEN CHILLI,',
  '  கொத்தமல்லி→CORIANDER LEAVES, கறிவேப்பிலை→CURRY LEAVES, புதினா→MINT, இஞ்சி→GINGER,',
  '  பூண்டு→GARLIC, பீட்ரூட்→BEETROOT, பூசணிக்காய்→PUMPKIN, சுரைக்காய்→BOTTLE GOURD,',
  '  புடலங்காய்→SNAKE GOURD, பீர்க்கங்காய்→RIDGE GOURD, அவரைக்காய்→FLAT BEANS, கீரை→GREENS,',
  '  எலுமிச்சை→LEMON, வாழைக்காய்→RAW BANANA, சேனைக்கிழங்கு→YAM. If a vegetable is unclear, give your',
  '  best standard English vegetable name rather than leaving it blank.',
].join('\n');
const buildPrompt = (store) => PROMPT_BASE.concat([store === 'vegetable' ? NAME_VEG : NAME_PLAIN]).join('\n');

// Returns { bills: [{ date: 'YYYY-MM-DD'|null, lines: [{name, qty, amount}] }] } — a photo can hold
// several receipts, each its own bill with its own date. Throws on failure.
async function readBill(dataUrl, store = 'perumal') {
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
        // The 5.5 models "think" before answering, so the budget must cover the thinking PLUS the
        // JSON output — and one photo may hold several bills, so give it generous room.
        max_tokens: 16000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } },
            { type: 'text', text: buildPrompt(store) },
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
  if (!parsed) throw new Error('Could not understand the bill. Please try a clearer photo.');
  // Accept the new multi-bill shape, and fall back to the old single-bill shape if a model returns it.
  let rawBills = Array.isArray(parsed.bills) ? parsed.bills
    : (Array.isArray(parsed.lines) ? [{ date: parsed.date, lines: parsed.lines }] : null);
  if (!rawBills) throw new Error('Could not understand the bill. Please try a clearer photo.');

  const bills = rawBills.map((bill) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test((bill && bill.date) || '') ? bill.date : null;
    const t = cleanNum(bill && bill.total);
    const total = t > 0 ? t : null;                       // the bill's printed grand total, for a cross-check
    const lines = (Array.isArray(bill && bill.lines) ? bill.lines : []).map((l) => ({
      name: String(l && l.name != null ? l.name : '').trim(),
      qty: cleanNum(l && l.qty),
      amount: cleanNum(l && l.amount),
    })).filter((l) => l.name);
    return { date, total, lines };
  }).filter((b) => b.lines.length);
  return { bills };
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
