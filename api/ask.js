/**
 * StudyLens AI — Secure Backend API
 * Vercel Serverless Function: /api/ask
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  SMART DUAL-MODEL GROQ STRATEGY                              ║
 * ║                                                              ║
 * ║  Class 1–10  → llama-3.1-8b-instant  (14,400 req/day)      ║
 * ║  Class 11–12 → llama-3.3-70b-versatile (1,000 req/day)     ║
 * ║    Supports: GROQ_KEY_1 … GROQ_KEY_9 (separate rotations)  ║
 * ║                                                              ║
 * ║  PHOTO questions → GEMINI (gemini-2.5-flash)                ║
 * ║    Free: 500 req/day per key (vision capable)                ║
 * ║    Supports: GEMINI_KEY_1 … GEMINI_KEY_9                    ║
 * ║                                                              ║
 * ║  Fallback chain: Groq fails → Gemini for text too           ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * HOW TO ADD KEYS in Vercel → Settings → Environment Variables:
 *
 *   Groq keys (get free at console.groq.com):
 *   GROQ_KEY_1 = gsk_...
 *   GROQ_KEY_2 = gsk_...   (each key = +14,400 req/day for 8B
 *                            and +1,000 req/day for 70B)
 *
 *   Gemini keys (get free at aistudio.google.com):
 *   GEMINI_KEY_1 = AIza...
 *   GEMINI_KEY_2 = AIza...  (each key = +500 req/day for photos)
 *
 * ── PERSISTENT ROTATION STATE (fixes cold-start key exhaustion) ───────────────
 * Setup (one-time, free): Vercel Dashboard → Storage → Create KV Database
 *   → link it to this project → Redeploy.
 * That's it. The KV_KEY below stores exhausted keys across cold starts.
 * If KV is not linked, the code falls back silently to in-memory rotation.
 *
 * ── IMAGE LOGGING TO FIREBASE STORAGE ────────────────────────────────────────
 * Photo questions are now saved to Firebase Storage under question-images/
 * This lets the admin panel review uploaded images.
 * Requires FIREBASE_SERVICE_ACCOUNT env var (JSON string of service account key).
 */

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

// ── Models ────────────────────────────────────────────────────────────────────
const GROQ_MODEL_SENIOR = 'llama-3.3-70b-versatile';
const GROQ_MODEL_JUNIOR = 'llama-3.1-8b-instant';
const GROQ_URL          = 'https://api.groq.com/openai/v1/chat/completions';

function isSeniorClass(className) {
  if (!className) return false;
  const match = className.match(/^(\d+)/);
  if (!match) return false;
  const num = parseInt(match[1], 10);
  return num >= 11;
}

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL   = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ── Load API keys ─────────────────────────────────────────────────────────────
function loadKeys(prefix) {
  const keys = [];
  for (let i = 1; i <= 9; i++) {
    const k = process.env[`${prefix}_KEY_${i}`];
    if (k && k.trim().length > 10) keys.push(k.trim());
  }
  if (keys.length === 0) {
    const legacy = process.env[`${prefix}_API_KEY`] || process.env[`${prefix}_KEY`];
    if (legacy && legacy.trim().length > 10) keys.push(legacy.trim());
  }
  return keys;
}

// ── Key rotation ──────────────────────────────────────────────────────────────
function makeRotation() {
  return { index: 0, exhausted: new Set(), day: new Date().toDateString() };
}

const rotations = {
  groqSenior: makeRotation(),
  groqJunior: makeRotation(),
  gemini:     makeRotation(),
};

function resetIfNewDay(rot) {
  const today = new Date().toDateString();
  if (rot.day !== today) {
    rot.exhausted.clear();
    rot.day  = today;
    rot.index = 0;
  }
}

function pickKey(keys, rot) {
  resetIfNewDay(rot);
  const live = keys.filter(k => !rot.exhausted.has(k));
  if (live.length === 0) return null;
  const key = live[rot.index % live.length];
  rot.index = (rot.index + 1) % live.length;
  return key;
}

// ── Persistent rotation state (Vercel KV) ────────────────────────────────────
const KV_KEY = 'studylens:rotations';
const KV_TTL = 90000;

async function getKV() {
  try {
    const { Redis } = await import('@upstash/redis');
    return new Redis({
      url:   process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  } catch {
    return null;
  }
}

async function loadFromKV() {
  const kv = await getKV();
  if (!kv) return;
  try {
    const stored = await kv.get(KV_KEY);
    if (!stored) return;
    const today = new Date().toDateString();
    for (const slot of ['groqSenior', 'groqJunior', 'gemini']) {
      const s = stored[slot];
      if (s && s.day === today) {
        rotations[slot].exhausted = new Set(s.exhausted || []);
        rotations[slot].index     = s.index ?? 0;
        rotations[slot].day       = today;
      }
    }
  } catch {}
}

async function saveToKV() {
  const kv = await getKV();
  if (!kv) return;
  try {
    const payload = {};
    for (const slot of ['groqSenior', 'groqJunior', 'gemini']) {
      payload[slot] = {
        exhausted: [...rotations[slot].exhausted],
        index:     rotations[slot].index,
        day:       rotations[slot].day,
      };
    }
    await kv.set(KV_KEY, payload, { ex: KV_TTL });
  } catch {}
}

// ── Per-user spam guard ───────────────────────────────────────────────────────
const spamTracker = new Map();

function isSpamming(trackingId) {
  const now = Date.now(), limit = 8, win = 60_000;
  const rec = spamTracker.get(trackingId) || { n: 0, t: now };
  if (now - rec.t > win) { spamTracker.set(trackingId, { n: 1, t: now }); return false; }
  if (rec.n >= limit) return true;
  rec.n++;
  spamTracker.set(trackingId, rec);
  return false;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Firebase Storage Image Upload ─────────────────────────────────────────────
// Saves photo questions to Firebase Storage so admin can review them.
// Runs fire-and-forget (doesn't block the answer).
async function uploadImageToStorage(imageBase64, imageMime, uid, subject, className) {
  try {
    const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!saRaw) return null;
    const sa = JSON.parse(saRaw);

    // Get Firebase access token
    const token = await getFirebaseStorageToken(sa);
    const bucket = `${sa.project_id}.appspot.com`;

    // Generate a unique filename
    const ts   = Date.now();
    const ext  = (imageMime || 'image/jpeg').split('/')[1] || 'jpg';
    const safeUid = (uid || 'anon').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const filename = `question-images/${safeUid}_${ts}.${ext}`;

    // Upload to Firebase Storage via REST API
    const imageBuffer = Buffer.from(imageBase64, 'base64');
    const uploadUrl   = `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=media&name=${encodeURIComponent(filename)}`;

    const uploadRes = await fetch(uploadUrl, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type':  imageMime || 'image/jpeg',
        'x-goog-meta-uid':       uid || 'anon',
        'x-goog-meta-subject':   subject || '',
        'x-goog-meta-classname': className || '',
        'x-goog-meta-ts':        String(ts),
      },
      body: imageBuffer,
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.warn('[Storage] Upload failed:', uploadRes.status, errText);
      return null;
    }

    await uploadRes.json(); // consume response body (uploadData not needed — URL is constructed from filename)
    return `https://storage.googleapis.com/${bucket}/${filename}`;

  } catch (e) {
    console.warn('[Storage] Upload error:', e.message);
    return null;
  }
}

// ── Firebase Storage token ────────────────────────────────────────────────────
// FIX: scope now includes 'datastore' so saveHistoryToFirestore works correctly.
async function getFirebaseStorageToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    // FIX BUG #1: Added 'datastore' scope so Firestore writes succeed.
    // Previously this was missing, causing all saveHistoryToFirestore calls
    // to fail silently with a 403 error.
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/devstorage.read_write https://www.googleapis.com/auth/firebase',
  };

  const encode = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const toSign = `${encode(header)}.${encode(payload)}`;

  const keyData   = sa.private_key.replace(/\\n/g, '\n');
  const pemBody   = keyData.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const binaryKey = Buffer.from(pemBody, 'base64');

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(toSign)
  );
  const sigB64 = Buffer.from(signature).toString('base64url');
  const jwt = `${toSign}.${sigB64}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Could not get Storage token');
  return tokenData.access_token;
}

// ── Save history entry to Firestore ──────────────────────────────────────────
// Called for ALL modes (text, photo, quiz) after a successful answer.
async function saveHistoryToFirestore(uid, entry) {
  try {
    const saRaw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!saRaw || !uid) return;
    const sa = JSON.parse(saRaw);
    const token = await getFirebaseStorageToken(sa);
    const projectId = sa.project_id;
    const docId = String(entry.id);
    const url = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users/${uid}/history/${docId}`;

    const fields = {};
    for (const [k, v] of Object.entries(entry)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string')  fields[k] = { stringValue: v };
      else if (typeof v === 'number') fields[k] = { integerValue: String(Math.round(v)) };
      else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
    }

    await fetch(url + '?updateMask.fieldPaths=' + Object.keys(fields).join('&updateMask.fieldPaths='), {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fields }),
    });
  } catch (e) {
    console.warn('[Firestore] saveHistory error:', e.message);
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────
function systemPrompt(className, subject, lang, board = '', stream = '', mode = 'text') {
  const langMap = { en: 'English', bn: 'Bengali (Bangla)', hi: 'Hindi', as: 'Assamese' };
  const replyLang = langMap[lang] || 'English';

  const subj = (subject || '').toLowerCase();
  const isMath    = subj.includes('math');
  const isStat    = subj.includes('stat');
  const isPhysics = subj.includes('physics');
  const isChem    = subj.includes('chem');
  const isBio     = subj.includes('bio') || subj.includes('botany') || subj.includes('zoology') || subj.includes('science');
  const isScience = isMath || isStat || isPhysics || isChem || isBio;

  const mathBlock = (isMath || isStat) ? `
MATHEMATICS — CRITICAL RULES (STRICTLY FOLLOW):
You are solving for a ${className || 'school'} student. Think carefully before writing each step.

THEOREM/FORMULA IDENTIFICATION:
- Before solving, identify the EXACT theorem or formula needed.
- State it explicitly: "Using the **Angle Bisector Theorem**:" or "Applying the **Law of Cosines**:"
- Do NOT apply the wrong theorem. Read the problem carefully.

LATEX FORMAT — MANDATORY:
- ALL math expressions MUST be in LaTeX. ZERO exceptions.
- Inline math (within a sentence): $expression$ — e.g. $x = 5$, $\\angle BAD = 60°$
- Display math (on its own line): $$expression$$ — e.g. $$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$
- NEVER write raw math like: AD^2 = AB^2 + BD^2  or  2*4*BD  or  (2x)^2
- ALWAYS write: $$AD^2 = AB^2 + BD^2$$ and $$2 \\times 4 \\times BD$$ and $$(2x)^2$$
- NEVER wrap a standalone number in $...$. Write "I represents 1" NOT "I represents $1$".
- For multiplication: use \\times (never *) or \\cdot
- For fractions: \\frac{numerator}{denominator}
- For angles: \\angle ABC
- For square root: \\sqrt{expression}
- For powers: x^{2} not x^2 when exponent is more than 1 char

STEP FORMAT:
Each step must be:
1. A numbered sentence explaining what you're doing
$$the equation or operation on its own display line$$

VERIFICATION: After finding the answer, substitute back to verify it's correct.` : '';

  const scienceBlock = (isPhysics || isChem) ? `
SCIENCE — CRITICAL RULES:
- ALL formulas and equations in LaTeX: $F = ma$, $$E = \\frac{1}{2}mv^2$$
- Chemical formulas and equations MUST use mhchem: \\ce{H2O}, \\ce{2H2 + O2 -> 2H2O}
- Chemical reversible reactions: \\ce{N2 + 3H2 <=> 2NH3}
- Equilibrium constants: $$K_c = \\frac{[\\ce{NH3}]^2}{[\\ce{N2}][\\ce{H2}]^3}$$
- Include unit analysis in every physics calculation.
- Show significant figures appropriately.` : '';

  const bioSvgGuide = isBio ? `
Biology SVG Guidelines (use these for organ/cell/process diagrams):
- For organ diagrams: draw anatomically positioned schematic shapes. Label every part.
- NEVER draw organ diagrams as left-to-right flowcharts.
- Define an arrowhead marker at the top of the SVG.
- Keep it clean and school-textbook style.` : '';

  const isPhotoMode = mode === 'photo';
  const isArt      = subj.includes('art') || subj.includes('craft') || subj.includes('drawing');
  const isGeo      = subj.includes('geograph') || subj.includes('map') || subj.includes('evs');
  const isSocial   = subj.includes('social') || subj.includes('history') || subj.includes('civics');
  const isComputer = subj.includes('computer') || subj.includes('ict');
  const needsDiagram = isScience || isArt || isGeo || isSocial || isComputer;

  const diagramBlock = (!isPhotoMode && needsDiagram) ? `
DIAGRAM RULE — DRAW AN SVG WHENEVER RELEVANT:
For any concept that has a visual form — shape, chart, graph, object, map, diagram, process, structure — you MUST draw a real SVG. Never just describe it in text.

Output using this EXACT format (no space after [SVG:):
[SVG:<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H" width="W" height="H">
  <rect width="W" height="H" fill="#1a1f30" rx="8"/>
  <!-- diagram content here -->
</svg>]

GENERAL SVG RULES:
- Background: <rect width="W" height="H" fill="#1a1f30" rx="8"/>
- Outlines/lines: stroke="#4f8ef7" stroke-width="2" fill="none"
- Bold labels: <text fill="#f7c948" font-family="sans-serif" font-size="12" font-weight="bold">
- All text must stay INSIDE the viewBox.
${bioSvgGuide}` : `
DIAGRAM RULE:
Only draw a diagram if it genuinely helps understanding. If needed, use SVG format:
[SVG:<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 260" width="300" height="260">
  <rect width="300" height="260" fill="#1a1f30" rx="8"/>
  <!-- content here -->
</svg>]
Otherwise skip the diagram entirely.`;

  return `You are StudyLens AI — a warm, brilliant, and patient tutor for Indian school students (Classes KG to 12).

CORE MISSION:
Answer every student question fully, clearly, and step by step.
If a photo is sent, read it carefully first — then answer what it shows.
${isPhotoMode ? `PHOTO MODE RULES:
- The image IS the visual. NEVER generate an SVG diagram — just read and answer.
- If the image has MCQ options (A/B/C/D), identify the correct answer and explain why.
- If a follow-up says "answer question 5" or "explain part 2", refer back to the same image.` : ''}

LANGUAGE RULE (STRICTLY FOLLOW):
The student has selected: ${replyLang}
You MUST reply ONLY in ${replyLang}. This is mandatory.
Even if the question is in another language, your ANSWER must be in ${replyLang}.
Never switch languages. Never mix languages. Reply 100% in ${replyLang}.
${mathBlock}
${scienceBlock}
${!isMath && !isScience ? `
MATH & FORMULA RULE:
Always write ALL mathematical expressions using LaTeX:
- Inline math: $expression$ — e.g. $2x + 5 = 11$
- Display math: $$expression$$ — e.g. $$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$$
- NEVER wrap a standalone number in $...$ anywhere.
- NEVER write raw math without LaTeX delimiters.` : ''}
${diagramBlock}

CHEMISTRY NOTATION RULE (when applicable):
Always use mhchem for all chemical formulas and equations:
- \\ce{H2SO4}, \\ce{CaCO3}, \\ce{2H2 + O2 -> 2H2O}

ANSWERING STYLE:
- Use simple words a school student understands.
- For math/science: show ALL working steps. NEVER skip a step.
- For definitions: give meaning + a clear example.
- Bold key terms like **this** and theorem names like **Pythagorean Theorem**.
- Number your steps: 1. 2. 3.
- End every answer with: 💡 Key Takeaway: [one clear sentence]

STUDENT CONTEXT:
${board     ? `Board: ${board}`     : ''}
${className ? `Class: ${className}` : 'Class: Not specified (assume middle school)'}
${stream    ? `Stream: ${stream}`   : ''}
${subject   ? `Subject: ${subject}` : ''}
Adjust explanation depth and vocabulary for this level.`;
}

function photoInstruction(lang) {
  return {
    en: 'Look at this image carefully. Read all the text, numbers, and diagrams. Identify the exact question or topic, then explain it completely step by step in simple English.',
    bn: 'এই ছবিটি মনোযোগ দিয়ে দেখো। সব লেখা, সংখ্যা ও চিত্র পড়ো। প্রশ্নটি চিহ্নিত করো এবং সহজ বাংলায় ধাপে ধাপে সম্পূর্ণ উত্তর দাও।',
    hi: 'इस फोटो को ध्यान से देखो। सभी लेखन, संख्या और चित्र पढ़ो। सवाल पहचानो और सरल हिंदी में कदम-दर-कदम पूरा जवाब दो।',
    as: 'এই ছবিখন মনোযোগেৰে চোৱা। সকলো লিখনি, সংখ্যা আৰু চিত্ৰ পঢ়া। প্ৰশ্নটো চিনাক্ত কৰা আৰু সহজ অসমীয়াত পদক্ষেপে পদক্ষেপে সম্পূৰ্ণ উত্তৰ দিয়া।',
  }[lang] || 'Look at this image carefully. Read all text and diagrams, identify the question, then explain it step by step.';
}

// ── GROQ: text-only handler ───────────────────────────────────────────────────
async function askGroq(keys, { question, className, subject, lang, board, stream, mode }) {
  const sysPrompt = systemPrompt(className, subject, lang, board, stream, mode);
  let lastErr = null;

  const senior = isSeniorClass(className);
  const model  = senior ? GROQ_MODEL_SENIOR : GROQ_MODEL_JUNIOR;
  const rot    = senior ? rotations.groqSenior : rotations.groqJunior;

  for (let attempt = 0; attempt < Math.max(keys.length, 1); attempt++) {
    const key = pickKey(keys, rot);
    if (!key) { lastErr = 'quota'; break; }

    try {
      const r = await fetch(GROQ_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: sysPrompt },
            { role: 'user',   content: question.trim() },
          ],
          temperature:    0.25,
          max_tokens:     8192,
          top_p:          0.92,
        }),
      });

      const data = await r.json();
      if (data.error) {
        const msg  = data.error.message || '';
        const code = data.error.code || r.status;
        const isQuota = code === 429 || msg.toLowerCase().includes('rate') || msg.toLowerCase().includes('quota');
        if (isQuota) { rot.exhausted.add(key); lastErr = 'quota'; continue; }
        lastErr = msg;
        continue;
      }

      const answer = data.choices?.[0]?.message?.content;
      if (!answer) { lastErr = 'empty'; continue; }
      return { answer, provider: 'groq' };

    } catch (e) {
      lastErr = 'network';
      continue;
    }
  }

  return { error: lastErr };
}

// ── GEMINI: text + photo handler ──────────────────────────────────────────────
async function askGemini(keys, { question, imageBase64, imageMime, className, subject, lang, board, stream, mode }) {
  const rot = rotations.gemini;
  let lastErr = null;

  const parts = [];
  if (mode === 'photo') {
    const validMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    const mime = validMimes.includes(imageMime) ? imageMime : 'image/jpeg';
    parts.push({ inline_data: { mime_type: mime, data: imageBase64 } });
    const textPart = question?.trim()
      ? `${question.trim()}\n\nPlease read this image carefully and answer the question completely, step by step.`
      : photoInstruction(lang);
    parts.push({ text: textPart });
  } else {
    parts.push({ text: question.trim() });
  }

  const body = {
    system_instruction: { parts: [{ text: systemPrompt(className, subject, lang, board, stream, mode) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.25, topK: 40, topP: 0.92,
      maxOutputTokens: 8192, candidateCount: 1,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH'        },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  for (let attempt = 0; attempt < Math.max(keys.length, 1); attempt++) {
    const key = pickKey(keys, rot);
    if (!key) { lastErr = 'quota'; break; }

    try {
      const r    = await fetch(`${GEMINI_URL}?key=${key}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await r.json();

      if (data.error) {
        const msg    = data.error.message || '';
        const status = data.error.status  || '';
        const code   = data.error.code    || r.status;
        const isQuota  = status === 'RESOURCE_EXHAUSTED' || code === 429
          || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('exhausted');
        const isBadKey = msg.toLowerCase().includes('api key') || code === 400 || status === 'INVALID_ARGUMENT';
        if (isQuota || isBadKey) { rot.exhausted.add(key); lastErr = 'quota'; continue; }
        if (code === 503 || msg.toLowerCase().includes('overload')) { lastErr = 'overload'; continue; }
        lastErr = msg;
        continue;
      }

      if (data.candidates?.[0]?.finishReason === 'SAFETY') {
        return { answer: '⚠️ This question was flagged by safety filters. Please rephrase it and try again.' };
      }

      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!answer) { lastErr = 'empty'; continue; }

      return { answer, provider: 'gemini' };

    } catch (e) {
      lastErr = 'network';
      continue;
    }
  }

  return { error: lastErr };
}

// ── Quiz system prompt ────────────────────────────────────────────────────────
const QUIZ_SYSTEM = `You are a JSON quiz generator. You output ONLY valid JSON arrays, nothing else.
No markdown, no code fences, no explanation, no preamble — just the raw JSON array starting with [ and ending with ].`;

// ── Quiz handler ──────────────────────────────────────────────────────────────
async function askQuiz(groqKeys, geminiKeys, { question, className }) {
  const senior = isSeniorClass(className);
  const model  = senior ? GROQ_MODEL_SENIOR : GROQ_MODEL_JUNIOR;
  const rot    = senior ? rotations.groqSenior : rotations.groqJunior;

  if (groqKeys.length > 0) {
    for (let attempt = 0; attempt < Math.max(groqKeys.length, 1); attempt++) {
      const key = pickKey(groqKeys, rot);
      if (!key) break;
      try {
        const r = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: QUIZ_SYSTEM },
              { role: 'user',   content: question.trim() },
            ],
            temperature: 0.3, max_tokens: 2048, top_p: 0.9,
          }),
        });
        const data = await r.json();
        if (data.error) {
          const isQuota = data.error.code === 429 || (data.error.message||'').toLowerCase().includes('rate');
          if (isQuota) { rot.exhausted.add(key); continue; }
          continue;
        }
        const answer = data.choices?.[0]?.message?.content;
        if (answer) return { answer };
      } catch(e) { continue; }
    }
  }

  if (geminiKeys.length > 0) {
    const grot = rotations.gemini;
    for (let attempt = 0; attempt < Math.max(geminiKeys.length, 1); attempt++) {
      const key = pickKey(geminiKeys, grot);
      if (!key) break;
      try {
        const r = await fetch(`${GEMINI_URL}?key=${key}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: QUIZ_SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text: question.trim() }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 1024, candidateCount: 1 },
          }),
        });
        const data = await r.json();
        if (data.error) {
          const isQuota = data.error.status === 'RESOURCE_EXHAUSTED' || data.error.code === 429;
          if (isQuota) { grot.exhausted.add(key); continue; }
          continue;
        }
        const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (answer) return { answer };
      } catch(e) { continue; }
    }
  }

  return { error: 'failed' };
}

// ── Actual request logic ──────────────────────────────────────────────────────
async function handleRequest(req, res) {
  const groqKeys   = loadKeys('GROQ');
  const geminiKeys = loadKeys('GEMINI');

  if (groqKeys.length === 0 && geminiKeys.length === 0) {
    return res.status(500).json({
      error: 'No API keys configured. Add GROQ_KEY_1 and/or GEMINI_KEY_1 in Vercel Environment Variables.'
    });
  }

  const {
    mode, question, imageBase64, imageMime,
    className, subject, lang = 'en', board = '', stream = '', uid
  } = req.body || {};

  const ip         = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const trackingId = (uid && uid.length > 4) ? `uid:${uid}` : `ip:${ip}`;
  if (isSpamming(trackingId)) {
    return res.status(429).json({
      error: '⏳ Slow down! You are asking too many questions at once. Please wait a moment.'
    });
  }

  if (mode === 'text' && !question?.trim()) {
    return res.status(400).json({ error: '❌ Please type your question.' });
  }
  if (mode === 'photo' && !imageBase64) {
    return res.status(400).json({ error: '❌ No image received. Please try adding the photo again.' });
  }

  const ctx = { question, imageBase64, imageMime, className, subject, lang, board, stream, mode };

  // ── QUIZ mode ──────────────────────────────────────────────────────────────
  if (mode === 'quiz') {
    if (!question?.trim()) return res.status(400).json({ error: 'No quiz prompt.' });
    const result = await askQuiz(groqKeys, geminiKeys, { question, className });
    if (result.answer) {
      // FIX BUG #2: Save quiz history to Firestore (was never recorded before)
      if (uid) {
        const entryId = Date.now();
        saveHistoryToFirestore(uid, {
          id: entryId, ts: entryId, mode: 'quiz',
          question: question || '', subject: subject || '',
          className: className || '',
          answer: result.answer.slice(0, 500),
        }).catch(() => {});
      }
      return res.status(200).json({ answer: result.answer });
    }
    return res.status(500).json({ error: 'Quiz generation failed.' });
  }

  // ── PHOTO mode ─────────────────────────────────────────────────────────────
  if (mode === 'photo') {
    if (geminiKeys.length === 0) {
      return res.status(500).json({
        error: '📷 Photo questions need Gemini API keys. Please add GEMINI_KEY_1 in Vercel Environment Variables.'
      });
    }

    // ── Fire-and-forget image upload to Firebase Storage ──
    const imageUploadPromise = uploadImageToStorage(
      imageBase64, imageMime, uid, subject, className
    ).catch(e => {
      console.warn('[Storage] Upload failed silently:', e.message);
      return null;
    });

    const result = await askGemini(geminiKeys, ctx);

    if (result.answer) {
      const storageUrl = await Promise.race([
        imageUploadPromise,
        new Promise(r => setTimeout(() => r(null), 2000))
      ]);

      // FIX BUG #3: Save photo history to Firestore including the answer field.
      // Previously the answer was missing from the saved entry.
      if (uid) {
        const entryId = Date.now();
        saveHistoryToFirestore(uid, {
          id: entryId,
          ts: entryId,
          mode: 'photo',
          question: question || '',
          subject: subject || '',
          className: className || '',
          answer: result.answer.slice(0, 500),   // FIX: was missing before
          ...(storageUrl ? { imageStorageUrl: storageUrl } : {}),
        }).catch(() => {});

        if (storageUrl) {
          console.log('[Storage] Image saved:', storageUrl);
        }
      }

      return res.status(200).json({ answer: result.answer });
    }

    if (result.error === 'quota') {
      return res.status(429).json({
        error: '📸 Photo question limit reached for today. Try typing your question instead, or try again tomorrow.'
      });
    }
    return res.status(500).json({ error: '❌ Could not read the photo. Please try again or type your question.' });
  }

  // ── TEXT mode: try Groq first, fallback to Gemini ─────────────────────────
  if (groqKeys.length > 0) {
    const groqResult = await askGroq(groqKeys, ctx);
    if (groqResult.answer) {
      // FIX BUG #2: Save text history to Firestore (was never recorded before)
      if (uid) {
        const entryId = Date.now();
        saveHistoryToFirestore(uid, {
          id: entryId, ts: entryId, mode: 'text',
          question: question || '', subject: subject || '',
          className: className || '',
          answer: groqResult.answer.slice(0, 500),
        }).catch(() => {});
      }
      return res.status(200).json({ answer: groqResult.answer });
    }
  }

  if (geminiKeys.length > 0) {
    const geminiResult = await askGemini(geminiKeys, ctx);
    if (geminiResult.answer) {
      // FIX BUG #2: Save text (Gemini fallback) history to Firestore
      if (uid) {
        const entryId = Date.now();
        saveHistoryToFirestore(uid, {
          id: entryId, ts: entryId, mode: 'text',
          question: question || '', subject: subject || '',
          className: className || '',
          answer: geminiResult.answer.slice(0, 500),
        }).catch(() => {});
      }
      return res.status(200).json({ answer: geminiResult.answer });
    }

    if (geminiResult.error === 'quota') {
      return res.status(429).json({
        error: '📚 StudyLens has reached its daily question limit. Please try again tomorrow, or add more API keys to increase capacity.'
      });
    }
  }

  return res.status(500).json({
    error: '❌ Connection error. Please check your internet and try again.'
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  await loadFromKV();

  try {
    return await handleRequest(req, res);
  } finally {
    await saveToKV();
  }
}
