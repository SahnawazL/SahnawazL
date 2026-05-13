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
 */

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

// ── Models ────────────────────────────────────────────────────────────────────
// Class 11-12 gets the smarter 70B (1,000 req/day) — complex physics/chemistry/maths
// Class 1-10 gets the fast 8B (14,400 req/day) — more than enough for school level
const GROQ_MODEL_SENIOR = 'llama-3.3-70b-versatile'; // Class 11-12
const GROQ_MODEL_JUNIOR = 'llama-3.1-8b-instant';    // Class 1-10
const GROQ_URL          = 'https://api.groq.com/openai/v1/chat/completions';

// Detect if class is 11 or 12 from className string e.g. "11 (Science)"
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
  // legacy single-key fallback
  if (keys.length === 0) {
    const legacy = process.env[`${prefix}_API_KEY`] || process.env[`${prefix}_KEY`];
    if (legacy && legacy.trim().length > 10) keys.push(legacy.trim());
  }
  return keys;
}

// ── Key rotation (separate state per provider) ────────────────────────────────
function makeRotation() {
  return { index: 0, exhausted: new Set(), day: new Date().toDateString() };
}

const rotations = {
  groqSenior: makeRotation(), // llama-3.3-70b — Class 11-12
  groqJunior: makeRotation(), // llama-3.1-8b  — Class 1-10
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

// ── Per-IP spam guard ─────────────────────────────────────────────────────────
const ipTracker = new Map();

function isSpamming(ip) {
  const now = Date.now(), limit = 8, win = 60_000;
  const rec = ipTracker.get(ip) || { n: 0, t: now };
  if (now - rec.t > win) { ipTracker.set(ip, { n: 1, t: now }); return false; }
  if (rec.n >= limit) return true;
  rec.n++;
  ipTracker.set(ip, rec);
  return false;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── System prompt ─────────────────────────────────────────────────────────────
function systemPrompt(className, subject, lang, board = '', stream = '') {
  const langMap = { en: 'English', bn: 'Bengali (Bangla)', hi: 'Hindi', as: 'Assamese' };
  const replyLang = langMap[lang] || 'English';

  return `You are StudyLens AI — a warm, brilliant, and patient tutor for Indian school students (Classes KG to 12).

CORE MISSION:
Answer every student question fully, clearly, and step by step.
If a photo is sent, read it carefully first — then answer what it shows.

LANGUAGE RULE (STRICTLY FOLLOW):
The student has selected: ${replyLang}
You MUST reply ONLY in ${replyLang}. This is mandatory.
Even if the question is in another language, your ANSWER must be in ${replyLang}.
Never switch languages. Never mix languages. Reply 100% in ${replyLang}.

MATH & FORMULA RULE (STRICTLY FOLLOW):
Always write ALL mathematical expressions, equations, and formulas using LaTeX notation:
- Inline math: $expression$ — e.g. $2x + 5 = 11$, $E = mc^2$, $\\sin^2\\theta + \\cos^2\\theta = 1$
- Display math (standalone): $$expression$$ — e.g. $$x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$$
- Use LaTeX for: fractions (\\frac{}{}), square roots (\\sqrt{}), powers (^), subscripts (_), Greek letters (\\alpha, \\theta, \\pi), integrals (\\int), summations (\\sum), vectors (\\vec{})
- Never write formulas as plain text like "x^2" or "sqrt(x)" — always use LaTeX

CHEMISTRY NOTATION RULE (STRICTLY FOLLOW):
Always write ALL chemical equations and formulas using mhchem notation:
- Chemical equations: \\ce{2H2 + O2 -> 2H2O}
- Ionic equations: \\ce{H+ + OH- -> H2O}
- Reversible reactions: \\ce{N2 + 3H2 <=> 2NH3}
- Compounds with subscripts: \\ce{H2SO4}, \\ce{CaCO3}, \\ce{Fe2O3}
- Oxidation states: \\ce{MnO4^-}, \\ce{Fe^{2+}}
- Every single chemical formula or equation MUST use \\ce{} — never write H2O or CO2 as plain text

DIAGRAM RULE:
When describing a diagram, label it like this: [Diagram: your description here]

ANSWERING STYLE:
- Use simple words a school student understands.
- For math/science: show ALL working steps. Never skip a step.
- For definitions: give meaning + a clear example.
- For diagrams: describe what you see, then explain it.
- For grammar questions: explain the rule and show examples.
- Bold key terms like **this**.
- Number your steps: 1. 2. 3.
- End every answer with: 💡 Key Takeaway: [one clear sentence]

STUDENT CONTEXT:
${board     ? `Board: ${board}`       : ''}
${className ? `Class: ${className}`   : 'Class: Not specified (assume middle school)'}
${stream    ? `Stream: ${stream}`     : ''}
${subject   ? `Subject: ${subject}`   : ''}
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
async function askGroq(keys, { question, className, subject, lang, board, stream }) {
  const sysPrompt = systemPrompt(className, subject, lang, board, stream);
  let lastErr = null;

  // Smart model selection: 70B for Class 11-12, 8B for Class 1-10
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
          temperature:       0.35,
          max_tokens:        2048,
          top_p:             0.92,
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

  // Build parts
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
    system_instruction: { parts: [{ text: systemPrompt(className, subject, lang, board, stream) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature: 0.35, topK: 40, topP: 0.92,
      maxOutputTokens: 2048, candidateCount: 1,
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

      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!answer) { lastErr = 'empty'; continue; }

      if (data.candidates?.[0]?.finishReason === 'SAFETY') {
        return { answer: '⚠️ This question was flagged by safety filters. Please rephrase it and try again.' };
      }

      return { answer, provider: 'gemini' };

    } catch (e) {
      lastErr = 'network';
      continue;
    }
  }

  return { error: lastErr };
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Load keys
  const groqKeys   = loadKeys('GROQ');
  const geminiKeys = loadKeys('GEMINI');

  if (groqKeys.length === 0 && geminiKeys.length === 0) {
    return res.status(500).json({
      error: 'No API keys configured. Add GROQ_KEY_1 and/or GEMINI_KEY_1 in Vercel Environment Variables.'
    });
  }

  // Spam check
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isSpamming(ip)) {
    return res.status(429).json({
      error: '⏳ Slow down! You are asking too many questions at once. Please wait a moment.'
    });
  }

  // Parse body
  const { mode, question, imageBase64, imageMime, className, subject, lang = 'en', board = '', stream = '' } = req.body || {};

  // Validate
  if (mode === 'text' && !question?.trim()) {
    return res.status(400).json({ error: '❌ Please type your question.' });
  }
  if (mode === 'photo' && !imageBase64) {
    return res.status(400).json({ error: '❌ No image received. Please try adding the photo again.' });
  }

  const ctx = { question, imageBase64, imageMime, className, subject, lang, board, stream, mode };

  // ── ROUTING LOGIC ──────────────────────────────────────────────────────────
  //
  //  PHOTO  → always Gemini (vision required)
  //  TEXT   → try Groq first → fallback to Gemini if Groq fails/exhausted
  //
  // ──────────────────────────────────────────────────────────────────────────

  if (mode === 'photo') {
    // Photo: Gemini only
    if (geminiKeys.length === 0) {
      return res.status(500).json({
        error: '📷 Photo questions need Gemini API keys. Please add GEMINI_KEY_1 in Vercel Environment Variables.'
      });
    }

    const result = await askGemini(geminiKeys, ctx);
    if (result.answer) return res.status(200).json({ answer: result.answer });

    if (result.error === 'quota') {
      return res.status(429).json({
        error: '📸 Photo question limit reached for today. Try typing your question instead, or try again tomorrow.'
      });
    }
    return res.status(500).json({ error: '❌ Could not read the photo. Please try again or type your question.' });
  }

  // Text: try Groq first
  if (groqKeys.length > 0) {
    const groqResult = await askGroq(groqKeys, ctx);
    if (groqResult.answer) return res.status(200).json({ answer: groqResult.answer });
    // Groq failed — fall through to Gemini
  }

  // Fallback: Gemini for text
  if (geminiKeys.length > 0) {
    const geminiResult = await askGemini(geminiKeys, ctx);
    if (geminiResult.answer) return res.status(200).json({ answer: geminiResult.answer });

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
