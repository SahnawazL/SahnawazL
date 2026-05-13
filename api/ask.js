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

  // Detect subject type for specialized instructions
  const subj = (subject || '').toLowerCase();
  const isMath = subj.includes('math') || subj.includes('stat');
  const isPhysics = subj.includes('physics');
  const isChem = subj.includes('chem');
  const isScience = isMath || isPhysics || isChem || subj.includes('bio');

  const mathBlock = isMath ? `
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
- For multiplication: use \\times (never *) or \\cdot
- For fractions: \\frac{numerator}{denominator}
- For angles: \\angle ABC  (not /ABC or angle ABC)
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

  const diagramBlock = isScience ? `
DIAGRAM RULE — IMPORTANT:
When a geometric figure, circuit, graph, molecular diagram, or ray diagram is needed to explain the answer, output it as a real SVG using this EXACT format (no spaces before [SVG:):

[SVG:<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 240" width="300" height="240">
  <!-- dark background -->
  <rect width="300" height="240" fill="#1a1f30" rx="8"/>
  <!-- your diagram elements here -->
  <!-- Use: stroke="#4f8ef7" for shapes/lines, fill="#f7c948" for point labels, stroke="#3ecf8e" for special lines/heights -->
  <!-- Text: fill="#eef0f8" font-family="sans-serif" font-size="13" -->
  <!-- Labeled points: small circle fill="#f7c948" + text label nearby -->
</svg>]

SVG Guidelines:
- viewBox always "0 0 300 240", width="300" height="240"
- Background: <rect width="300" height="240" fill="#1a1f30" rx="8"/>
- Main shapes/lines: stroke="#4f8ef7" stroke-width="2" fill="none"
- Point markers: <circle cx="X" cy="Y" r="4" fill="#f7c948"/>
- Point labels: <text x="X" y="Y" fill="#f7c948" font-family="sans-serif" font-size="13" font-weight="bold">A</text>
- Side labels / measurements: fill="#eef0f8" font-size="12"
- Heights/special lines: stroke="#3ecf8e" stroke-dasharray="5,3"
- Angles: <path d="M ... A ... Z" fill="rgba(79,142,247,0.2)" stroke="#4f8ef7" stroke-width="1"/>
- Right angle marker: small square using <rect> or <polyline>
- For triangles: calculate coordinates so the triangle looks proportional. Place A at top, B at bottom-left, C at bottom-right as default.
- Always label ALL vertices, sides, and known measurements.
- Draw ONLY when a visual genuinely helps; skip for pure algebra questions.` : `
DIAGRAM RULE:
When a diagram, chart, or figure description is needed, use: [Diagram: your description here]`;

  return `You are StudyLens AI — a warm, brilliant, and patient tutor for Indian school students (Classes KG to 12).

CORE MISSION:
Answer every student question fully, clearly, and step by step.
If a photo is sent, read it carefully first — then answer what it shows.

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
- NEVER write raw math without LaTeX delimiters.` : ''}
${diagramBlock}

CHEMISTRY NOTATION RULE (when applicable):
Always use mhchem for all chemical formulas and equations:
- \\ce{H2SO4}, \\ce{CaCO3}, \\ce{2H2 + O2 -> 2H2O}
- Wrap \\ce{} inside $$...$$ when inside a fraction or math expression

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
          temperature:       0.25,
          max_tokens:        3072,
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
      temperature: 0.25, topK: 40, topP: 0.92,
      maxOutputTokens: 3072, candidateCount: 1,
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

// ── Quiz system prompt ─────────────────────────────────────────────────────────
const QUIZ_SYSTEM = `You are a JSON quiz generator. You output ONLY valid JSON arrays, nothing else.
No markdown, no code fences, no explanation, no preamble — just the raw JSON array starting with [ and ending with ].`;

// ── Quiz handler (Groq preferred, Gemini fallback) ─────────────────────────────
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
            temperature: 0.3, max_tokens: 1024, top_p: 0.9,
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

  // ── QUIZ mode: dedicated handler with JSON-only system prompt ─────────────
  if (mode === 'quiz') {
    if (!question?.trim()) return res.status(400).json({ error: 'No quiz prompt.' });
    const result = await askQuiz(groqKeys, geminiKeys, { question, className });
    if (result.answer) return res.status(200).json({ answer: result.answer });
    return res.status(500).json({ error: 'Quiz generation failed.' });
  }

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
