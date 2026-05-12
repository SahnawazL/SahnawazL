/**
 * StudyLens AI — Secure Backend API
 * Vercel Serverless Function: /api/ask
 *
 * Strategy: Multi-key rotation across SEPARATE Google projects
 * Each Google account = 1 project = its own quota pool
 *
 * Model: gemini-2.5-flash (Google's recommended stable free model 2026)
 *   FREE limits per key/project:
 *   → 10 requests/min  (RPM)
 *   → 500 requests/day (RPD) ← resets midnight Pacific Time
 *   → 250,000 tokens/min (TPM)
 *
 * With 3 keys:  1,500 questions/day
 * With 5 keys:  2,500 questions/day  (enough for 200+ active students)
 *
 * HOW TO ADD KEYS in Vercel → Settings → Environment Variables:
 *   GEMINI_KEY_1 = AIza...  (from Google Account 1 → aistudio.google.com)
 *   GEMINI_KEY_2 = AIza...  (from Google Account 2)
 *   GEMINI_KEY_3 = AIza...  (from Google Account 3)
 *   GEMINI_KEY_4 = AIza...  (optional)
 *   GEMINI_KEY_5 = AIza...  (optional)
 *
 * Image capability: Reads printed text, handwriting, diagrams,
 *   math equations, Bengali/Hindi/English question papers, worksheets.
 */

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '20mb',
    },
  },
};

// ── Model ─────────────────────────────────────────────────────────────────
const MODEL    = 'gemini-2.5-flash';
const API_URL  = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// ── Load all API keys from environment variables ──────────────────────────
function getKeys() {
  const keys = [];
  for (let i = 1; i <= 9; i++) {
    const k = process.env[`GEMINI_KEY_${i}`];
    if (k && k.trim().length > 10) keys.push(k.trim());
  }
  // Fallback: support old single-key variable name
  if (keys.length === 0 && process.env.GEMINI_API_KEY) {
    keys.push(process.env.GEMINI_API_KEY.trim());
  }
  return keys;
}

// ── Key rotation state ────────────────────────────────────────────────────
const rotation = {
  index: 0,
  exhausted: new Set(),
  day: new Date().toDateString(),
};

function resetIfNewDay() {
  const today = new Date().toDateString();
  if (rotation.day !== today) {
    rotation.exhausted.clear();
    rotation.day = today;
    rotation.index = 0;
  }
}

function pickKey(keys) {
  resetIfNewDay();
  const live = keys.filter(k => !rotation.exhausted.has(k));
  if (live.length === 0) return null;
  const key = live[rotation.index % live.length];
  rotation.index = (rotation.index + 1) % live.length;
  return key;
}

// ── Per-IP rate limiter (protects against single-user spam) ───────────────
const ipTracker = new Map();

function isSpamming(ip) {
  const now   = Date.now();
  const limit = 8;          // max 8 questions per minute per user
  const win   = 60_000;

  const rec = ipTracker.get(ip) || { n: 0, t: now };
  if (now - rec.t > win) { ipTracker.set(ip, { n: 1, t: now }); return false; }
  if (rec.n >= limit) return true;
  rec.n++;
  ipTracker.set(ip, rec);
  return false;
}

// ── CORS ──────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Smart system prompt — subject & class aware ───────────────────────────
function systemPrompt(className, subject, lang) {
  const langMap = {
    en: 'English',
    bn: 'Bengali (Bangla)',
    hi: 'Hindi',
  };
  const replyLang = langMap[lang] || 'English';

  return `You are StudyLens AI — a warm, brilliant, and patient tutor for Indian school students (Classes KG to 12).

CORE MISSION:
Answer every student question fully, clearly, and step by step.
If a photo is sent, read it carefully first — then answer what it shows.

LANGUAGE RULE (MOST IMPORTANT — STRICTLY FOLLOW):
The student has selected: ${replyLang}
You MUST reply ONLY in ${replyLang}. This is mandatory.
Even if the photo contains text in another language (Hindi, Bengali, English), your ANSWER must be in ${replyLang}.
Never switch languages. Never mix languages. Reply 100% in ${replyLang}.

ANSWERING STYLE:
- Use simple words a school student understands.
- For math/science: show ALL working steps. Never skip a step.
- For definitions: give meaning + a clear example.
- For diagrams: describe what you see, then explain it.
- For grammar questions: explain the rule and show examples.
- Bold key terms like **this**.
- Number your steps: 1. 2. 3.
- End every answer with: 💡 Key Takeaway: [one clear sentence]

READING PHOTOS (VERY IMPORTANT):
- Read ALL text, numbers, symbols, and diagrams in the image carefully.
- Even if handwriting is messy or photo is slightly blurry — try your absolute best.
- Identify the exact question being asked, then answer it completely.
- For question papers: identify the question number and answer it fully.
- For textbook pages: read the relevant section and explain it.
- NEVER say "I cannot read this image." Always try. Read what you can.

STUDENT CONTEXT:
${className ? `Class: ${className}` : 'Class: Not specified (assume middle school)'}
${subject   ? `Subject: ${subject}` : ''}
Adjust explanation depth and vocabulary for this level.`;
}

// ── Default photo instruction per language ────────────────────────────────
function photoInstruction(lang) {
  return {
    en: 'Look at this image carefully. Read all the text, numbers, and diagrams. Identify the exact question or topic, then explain it completely step by step in simple English.',
    bn: 'এই ছবিটি মনোযোগ দিয়ে দেখো। সব লেখা, সংখ্যা ও চিত্র পড়ো। প্রশ্নটি চিহ্নিত করো এবং সহজ বাংলায় ধাপে ধাপে সম্পূর্ণ উত্তর দাও।',
    hi: 'इस फोटो को ध्यान से देखो। सभी लेखन, संख्या और चित्र पढ़ो। सवाल पहचानो और सरल हिंदी में कदम-दर-कदम पूरा जवाब दो।',
  }[lang] || 'Look at this image carefully. Read all text and diagrams, identify the question, then explain it step by step in simple language.';
}

// ── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  // Load keys
  const keys = getKeys();
  if (keys.length === 0) {
    return res.status(500).json({
      error: 'No API keys found. Please add GEMINI_KEY_1 in Vercel Environment Variables.'
    });
  }

  // Spam check
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (isSpamming(ip)) {
    return res.status(429).json({
      error: '⏳ Slow down! You are asking too many questions at once. Please wait a moment.'
    });
  }

  // Parse request
  const { mode, question, imageBase64, imageMime, className, subject, lang = 'en' } = req.body || {};

  // Validate
  if (mode === 'text' && !question?.trim()) {
    return res.status(400).json({ error: '❌ Please type your question.' });
  }
  if (mode === 'photo' && !imageBase64) {
    return res.status(400).json({ error: '❌ No image received. Please try adding the photo again.' });
  }

  // Build message parts
  const parts = [];

  if (mode === 'photo') {
    // Image FIRST → better OCR and understanding by Gemini
    const validMimes = ['image/jpeg','image/png','image/webp','image/heic','image/heif'];
    const mime = validMimes.includes(imageMime) ? imageMime : 'image/jpeg';
    parts.push({ inline_data: { mime_type: mime, data: imageBase64 } });

    // Text after image
    const textPart = question?.trim()
      ? `${question.trim()}\n\nPlease read this image carefully and answer the question completely, step by step.`
      : photoInstruction(lang);
    parts.push({ text: textPart });

  } else {
    parts.push({ text: question.trim() });
  }

  // Gemini request body
  const body = {
    system_instruction: { parts: [{ text: systemPrompt(className, subject, lang) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: {
      temperature:     0.35,
      topK:            40,
      topP:            0.92,
      maxOutputTokens: 2048,
      candidateCount:  1,
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH'        },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
  };

  // ── Rotate through keys until one works ──────────────────────────────
  let lastErr = null;

  for (let attempt = 0; attempt < keys.length; attempt++) {
    const key = pickKey(keys);
    if (!key) break; // all keys exhausted today

    try {
      const r    = await fetch(`${API_URL}?key=${key}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await r.json();

      // Handle errors from Gemini
      if (data.error) {
        const msg    = data.error.message || '';
        const status = data.error.status  || '';
        const code   = data.error.code    || r.status;

        const isQuota = status === 'RESOURCE_EXHAUSTED'
          || code === 429
          || msg.toLowerCase().includes('quota')
          || msg.toLowerCase().includes('exhausted');

        const isBadKey = msg.toLowerCase().includes('api key')
          || code === 400
          || status === 'INVALID_ARGUMENT';

        if (isQuota || isBadKey) {
          rotation.exhausted.add(key); // skip this key next time
          lastErr = isQuota ? 'quota' : 'badkey';
          continue; // try next key
        }

        // Overload — try next key
        if (code === 503 || msg.toLowerCase().includes('overload')) {
          lastErr = 'overload';
          continue;
        }

        return res.status(500).json({ error: `AI error: ${msg}` });
      }

      // Extract answer text
      const answer = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!answer) {
        return res.status(500).json({
          error: '🤔 No answer received. Please rephrase your question and try again.'
        });
      }

      // Safety blocked
      if (data.candidates?.[0]?.finishReason === 'SAFETY') {
        return res.status(200).json({
          answer: '⚠️ This question was flagged by safety filters. Please rephrase it and try again.'
        });
      }

      // ✅ Great success
      return res.status(200).json({ answer });

    } catch (e) {
      lastErr = 'network';
      continue; // network error, try next key
    }
  }

  // All keys tried and failed
  if (lastErr === 'quota') {
    return res.status(429).json({
      error: '📚 StudyLens has reached its daily question limit. Please try again tomorrow, or ask your teacher to add more API keys to increase the capacity.'
    });
  }

  return res.status(500).json({
    error: '❌ Connection error. Please check your internet and try again.'
  });
}
