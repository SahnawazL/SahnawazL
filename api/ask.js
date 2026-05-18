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
 * ║                                                              ║
 * ║  ── UPGRADE #1: GEMINI THINKING MODE ──────────────────────║
 * ║  Class 11–12 Math / Physics / Chemistry questions routed    ║
 * ║  through Gemini with thinkingConfig enabled (budget: 8192). ║
 * ║  The model reasons through the problem silently before       ║
 * ║  writing its answer — dramatically cuts arithmetic errors    ║
 * ║  on derivations, integrations, and equation solving.        ║
 * ║  Requires temp=1.0 (Gemini API rule). Not used for photos   ║
 * ║  or follow-up turns (saves quota).                          ║
 * ║                                                              ║
 * ║  ── UPGRADE #2: GOOGLE SEARCH GROUNDING ───────────────────║
 * ║  GK / Humanities / Geography / EVS / General questions      ║
 * ║  answered with live Google Search results baked in.         ║
 * ║  Prevents outdated answers for current-affairs questions     ║
 * ║  (Chief Ministers, recent events, COP summits, etc.).       ║
 * ║  Automatically disabled for hard science (they need          ║
 * ║  precision, not web lookup) and for photo mode.             ║
 * ║                                                              ║
 * ║  ── UPGRADE #3: BACKEND subjectType AUTO-DETECTION ────────║
 * ║  Frontend may send subjectType='general' for unknown or     ║
 * ║  new subjects. detectSubjectType() inspects the actual      ║
 * ║  subject name string and returns the correct type so that   ║
 * ║  Thinking Mode (math/physics/chem) and Search Grounding     ║
 * ║  (humanities/gk/geo) always activate correctly regardless   ║
 * ║  of what the frontend sends.                                ║
 * ║                                                              ║
 * ║  ── UPGRADE #4: SMART QUIZ PROMPT BUILDER ─────────────────║
 * ║  buildQuizSystem() generates a subject-aware, class-aware,  ║
 * ║  board-aware system prompt for quiz generation. Produces    ║
 * ║  exam-quality MCQs with correct difficulty distribution,    ║
 * ║  believable wrong options, and enforces strict JSON format  ║
 * ║  matching what the frontend parser expects.                 ║
 * ║                                                              ║
 * ║  ── UPGRADE #5: EXPANDED TEMPERATURE MAP ───────────────────║
 * ║  getTemperature() now covers 14 subject types (was 10).     ║
 * ║  accountancy (0.12) and economics (0.28) are now separate   ║
 * ║  from commerce for precise tuning. Added: psychology,       ║
 * ║  sanskrit, and pe. detectSubjectType() updated to route     ║
 * ║  all new types correctly so every subject gets the right    ║
 * ║  temperature automatically.                                 ║
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

const GEMINI_MODEL      = 'gemini-2.5-flash';
const GEMINI_URL        = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const GEMINI_STREAM_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent`;

// ── [UPGRADE #1] Subjects that benefit from Gemini Thinking Mode ──────────────
// Only exact sciences where chain-of-thought reasoning prevents calculation
// errors and wrong theorem application. Language/humanities don't benefit.
const THINKING_SUBJECTS = ['math', 'physics', 'chemistry'];

// ── [UPGRADE #2] Subjects that benefit from Google Search Grounding ───────────
// GK, humanities, geography, and general queries can go stale in training data.
// Hard sciences are intentionally EXCLUDED — they need precision, not web search.
const GROUNDING_SUBJECTS = ['humanities', 'general', 'environment'];
const GROUNDING_SUBJECT_KEYWORDS = ['gk', 'general knowledge', 'current', 'affairs',
  'geography', 'geograph', 'map', 'evs', 'civics', 'history', 'polsci',
  'social', 'sociology', 'political'];

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

// ── Answer Cache (two-layer: in-memory + KV) ─────────────────────────────────
//
// WHAT THIS FIXES: "Same question hits API every time"
// If 100 students ask "What is photosynthesis?", we now answer from cache
// after the first hit — zero extra API calls, instant response.
//
// Layer 1 — in-memory Map (instant, lives until Vercel cold-starts)
// Layer 2 — KV (Upstash Redis, survives cold starts, shared across instances)
//   Requires KV linked to your project (same setup as rotation state).
//   If KV is not linked, Layer 2 is silently skipped.
//
// Cache key: normalized question + subject + className + lang
//   (subject/class/lang are included because the SAME question should get
//    a different answer for a Class 5 student vs a Class 12 student)
// TTL: 24 hours. Quiz and photo modes are NOT cached (answers vary).
// In-memory cap: 500 entries (LRU-style — oldest dropped when full).

const CACHE_TTL_SEC = 86_400; // 24 hours in KV
const CACHE_MAX_MEM = 500;    // max in-memory entries before eviction

// Simple in-memory LRU: Map preserves insertion order, so oldest = first key.
const answerCache = new Map();

function makeCacheKey(question, subject, className, lang, board) {
  const q = (question  || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const s = (subject   || '').toLowerCase().trim();
  const c = (className || '').toLowerCase().trim();
  const l = (lang      || 'en').trim();
  const b = (board     || '').toLowerCase().trim();
  // board included so ASSEB/CBSE/ICSE never share a cached answer even for the same question
  return `cache:${b}|${c}|${s}|${l}|${q}`;
}

function memCacheGet(key) {
  const entry = answerCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.exp) { answerCache.delete(key); return null; }
  return entry.answer;
}

function memCacheSet(key, answer) {
  // Evict oldest entry if at capacity
  if (answerCache.size >= CACHE_MAX_MEM) {
    const oldestKey = answerCache.keys().next().value;
    answerCache.delete(oldestKey);
  }
  answerCache.set(key, { answer, exp: Date.now() + CACHE_TTL_SEC * 1000 });
}

async function kvCacheGet(kv, key) {
  if (!kv) return null;
  try {
    const val = await kv.get(key);
    return val ? String(val) : null;
  } catch { return null; }
}

async function kvCacheSet(kv, key, answer) {
  if (!kv) return;
  try {
    // KV values must be strings; slice to 8000 chars to stay well under limits
    await kv.set(key, answer.slice(0, 8000), { ex: CACHE_TTL_SEC });
  } catch {}
}

// Main cache read: check memory first (fast), then KV (persistent)
async function cacheGet(kv, key) {
  const mem = memCacheGet(key);
  if (mem) return mem;
  const kval = await kvCacheGet(kv, key);
  if (kval) { memCacheSet(key, kval); return kval; } // warm memory from KV
  return null;
}

// Main cache write: write to both layers
async function cacheSet(kv, key, answer) {
  memCacheSet(key, answer);
  await kvCacheSet(kv, key, answer); // fire-and-forget on failure
}

// ── Subject type auto-detection ───────────────────────────────────────────────
// The frontend sends subjectType but can default to 'general' for unknown
// subjects. This function detects the correct type from the subject string
// so Thinking Mode and Search Grounding always activate correctly.
// Frontend value is trusted if it's specific; this is a fallback safety net.
function detectSubjectType(subject, frontendType) {
  // Trust the frontend if it already sent a specific type (not 'general')
  if (frontendType && frontendType !== 'general') return frontendType;

  const s = (subject || '').toLowerCase();

  // Exact science — must match first (highest priority)
  if (s.includes('math') || s.includes('algebra') || s.includes('geometry') ||
      s.includes('trigonometry') || s.includes('calculus') || s.includes('statistic') ||
      s.includes('arithmetic') || s.includes('mensuration') || s.includes('number'))
    return 'math';

  if (s.includes('physics') || s.includes('mechanics') || s.includes('optics') ||
      s.includes('thermodynamics') || s.includes('electro'))
    return 'physics';

  if (s.includes('chem') || s.includes('organic') || s.includes('inorganic') ||
      s.includes('periodic') || s.includes('reaction') || s.includes('acid') ||
      s.includes('base') || s.includes('salt'))
    return 'chemistry';

  if (s.includes('bio') || s.includes('botany') || s.includes('zoology') ||
      s.includes('genetics') || s.includes('ecology') || s.includes('cell') ||
      s.includes('anatomy') || s.includes('physiology'))
    return 'biology';

  // Accountancy — very precise, separate from general commerce
  if (s.includes('account') || s.includes('journal') || s.includes('ledger') ||
      s.includes('balance sheet') || s.includes('trial balance') || s.includes('debit') ||
      s.includes('credit') || s.includes('depreciation') || s.includes('cash flow'))
    return 'accountancy';

  // Economics — theory + numericals, needs more creative latitude than accountancy
  if (s.includes('econom') || s.includes('micro') || s.includes('macro') ||
      s.includes('demand') || s.includes('supply') || s.includes('gdp') ||
      s.includes('inflation') || s.includes('market') || s.includes('consumer'))
    return 'economics';

  // Commerce / Business Studies
  if (s.includes('commerce') || s.includes('bst') || s.includes('business') ||
      s.includes('management') || s.includes('marketing') || s.includes('finance'))
    return 'commerce';

  // Computer
  if (s.includes('computer') || s.includes('ict') || s.includes('programming') ||
      s.includes('coding') || s.includes('software') || s.includes('hardware') ||
      s.includes('algorithm') || s.includes('data structure') || s.includes('python') ||
      s.includes('java') || s.includes('c++'))
    return 'computer';

  // Language / Literature
  if (s.includes('english') || s.includes('hindi') || s.includes('bengali') ||
      s.includes('assamese') || s.includes('telugu') || s.includes('tamil') ||
      s.includes('kannada') || s.includes('marathi') || s.includes('gujarati') ||
      s.includes('sanskrit') || s.includes('urdu') || s.includes('grammar') ||
      s.includes('essay') || s.includes('poem') || s.includes('prose') ||
      s.includes('literature') || s.includes('letter') || s.includes('story'))
    return 'language';

  // Psychology — own type so it gets correct temperature
  if (s.includes('psycholog') || s.includes('mental') || s.includes('behaviour') ||
      s.includes('behavior') || s.includes('freud') || s.includes('cognit'))
    return 'psychology';

  // Physical Education
  if (s.includes('physical education') || s.includes(' pe ') || s.includes('sport') ||
      s.includes('fitness') || s.includes('yoga') || s.includes('olympic') ||
      s.includes('health and physical'))
    return 'pe';

  // Sanskrit
  if (s.includes('sanskrit') || s.includes('shlokas') || s.includes('vedic') ||
      s.includes('devanagari'))
    return 'sanskrit';

  // Humanities / Social
  if (s.includes('history') || s.includes('civics') || s.includes('political') ||
      s.includes('polity') || s.includes('social') || s.includes('sociology') ||
      s.includes('philosophy'))
    return 'humanities';

  // Geography / Environment
  if (s.includes('geo') || s.includes('map') || s.includes('evs') ||
      s.includes('environment') || s.includes('climate') || s.includes('weather') ||
      s.includes('soil') || s.includes('river') || s.includes('mountain'))
    return 'environment';

  // GK / General Knowledge
  if (s.includes('gk') || s.includes('general knowledge') || s.includes('current') ||
      s.includes('affairs') || s.includes('quiz') || s.includes('gk'))
    return 'general';

  // Default — still 'general' but now only reached if nothing matched
  return 'general';
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

// ── SSE Streaming Helpers ─────────────────────────────────────────────────────
// Used by streamTextResponse() to push tokens to the client as they arrive.
// Format: standard Server-Sent Events — each line is "data: <json>\n\n".
function sseStart(res) {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');   // disable nginx/proxy buffering
  res.setHeader('Connection',        'keep-alive');
  res.status(200);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sseChunk(res, text) {
  try { res.write(`data: ${JSON.stringify({ chunk: text })}\n\n`); } catch (_) {}
}

function sseDone(res) {
  try { res.write('data: [DONE]\n\n'); res.end(); } catch (_) {}
}

function sseError(res, msg) {
  try {
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (_) {}
}

// ── Groq SSE streaming ────────────────────────────────────────────────────────
// Mirrors askGroq() but pipes tokens to onChunk() as they arrive.
// Returns { success: true, fullText } or { success: false }.
async function streamGroq(keys, ctx, onChunk) {
  const {
    question, className, subject, lang, board,
    stream: streamVal, mode, simplify,
    history = [], subjectType = 'general', chapter = '',
  } = ctx;

  const sysPrompt  = systemPrompt(className, subject, lang, board, streamVal, mode, !!simplify, chapter);
  const senior     = isSeniorClass(className);
  const model      = senior ? GROQ_MODEL_SENIOR : GROQ_MODEL_JUNIOR;
  const rot        = senior ? rotations.groqSenior : rotations.groqJunior;
  const temp       = getTemperature(subjectType);

  const hasHistory   = Array.isArray(history) && history.length > 1;
  let recentHistory  = hasHistory ? history.slice(-6) : null;
  if (recentHistory && recentHistory[0]?.role !== 'user') recentHistory = recentHistory.slice(1);

  const messages = recentHistory
    ? [{ role: 'system', content: sysPrompt }, ...recentHistory]
    : [{ role: 'system', content: sysPrompt }, { role: 'user', content: question.trim() }];

  for (let attempt = 0; attempt < Math.max(keys.length, 1); attempt++) {
    const key = pickKey(keys, rot);
    if (!key) break;

    try {
      const r = await fetch(GROQ_URL, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body:    JSON.stringify({
          model, messages,
          temperature: temp, max_tokens: 8192, top_p: 0.92,
          stream: true,
        }),
      });

      if (!r.ok) {
        let errData = {};
        try { errData = await r.json(); } catch (_) {}
        if (r.status === 429 || (errData.error?.message || '').toLowerCase().includes('rate')) {
          const msg = (errData.error?.message || '').toLowerCase();
          const isDailyLimit = msg.includes('per day') || msg.includes('rpd') || msg.includes('daily');
          if (isDailyLimit) rot.exhausted.add(key);
        }
        continue;
      }

      const reader  = r.body.getReader();
      const decoder = new TextDecoder();
      let fullText  = '';
      let buf       = '';

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') break outer;
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              if (parsed.error.code === 429 || (parsed.error.message || '').toLowerCase().includes('rate')) {
                const msg = (parsed.error.message || '').toLowerCase();
                const isDailyLimit = msg.includes('per day') || msg.includes('rpd') || msg.includes('daily');
                if (isDailyLimit) rot.exhausted.add(key);
              }
              break outer;
            }
            const text = parsed.choices?.[0]?.delta?.content || '';
            if (text) { fullText += text; onChunk(text); }
          } catch (_) {}
        }
      }

      if (fullText) return { success: true, fullText };

    } catch (_) { /* network error — try next key */ }
  }

  return { success: false };
}

// ── Gemini SSE streaming ──────────────────────────────────────────────────────
// Uses the streamGenerateContent endpoint (alt=sse).
// Preserves Thinking Mode and Search Grounding logic from askGemini().
// Photo mode is NOT passed here — images use the standard (non-stream) endpoint.
async function streamGemini(keys, ctx, onChunk) {
  const {
    question, className, subject, lang, board,
    stream: streamVal, mode, simplify,
    history = [], subjectType = 'general', chapter = '',
  } = ctx;
  const rot        = rotations.gemini;
  const hasHistory = Array.isArray(history) && history.length > 1;
  const senior     = isSeniorClass(className);

  const useThinking  = senior && THINKING_SUBJECTS.includes(subjectType) && !hasHistory;
  const useGrounding = !useThinking && needsSearchGrounding(subjectType, subject);
  const temp         = useThinking ? 1.0 : getTemperature(subjectType);

  let contents;
  if (hasHistory) {
    let recentHistory = history.slice(-6);
    if (recentHistory[0]?.role !== 'user') recentHistory = recentHistory.slice(1);
    contents = recentHistory.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }],
    }));
  } else {
    contents = [{ role: 'user', parts: [{ text: question.trim() }] }];
  }

  const body = {
    system_instruction: { parts: [{ text: systemPrompt(className, subject, lang, board, streamVal, mode, !!simplify, chapter) }] },
    generationConfig: {
      temperature:     temp,
      topK:            useThinking ? undefined : 40,
      topP:            0.92,
      maxOutputTokens: useThinking ? 16384 : 8192,
      candidateCount:  1,
      ...(useThinking ? { thinkingConfig: { thinkingBudget: 8192 } } : {}),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH'        },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
    ...(useGrounding ? { tools: [{ googleSearch: {} }] } : {}),
  };

  for (let attempt = 0; attempt < Math.max(keys.length, 1); attempt++) {
    const key = pickKey(keys, rot);
    if (!key) break;

    try {
      const r = await fetch(`${GEMINI_STREAM_URL}?key=${key}&alt=sse`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (!r.ok) {
        let errData = {};
        try { errData = await r.json(); } catch (_) {}
        const isQuota = r.status === 429 || errData.error?.status === 'RESOURCE_EXHAUSTED';
        if (isQuota) rot.exhausted.add(key);
        continue;
      }

      const reader  = r.body.getReader();
      const decoder = new TextDecoder();
      let fullText  = '';
      let buf       = '';

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') break outer;
          try {
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              const isQuota = parsed.error.status === 'RESOURCE_EXHAUSTED' || parsed.error.code === 429;
              if (isQuota) rot.exhausted.add(key);
              break outer;
            }
            // Skip internal thought parts (Thinking Mode) — emit answer only
            const parts = parsed.candidates?.[0]?.content?.parts || [];
            for (const part of parts) {
              if (part.text && !part.thought) { fullText += part.text; onChunk(part.text); }
            }
          } catch (_) {}
        }
      }

      if (fullText) return { success: true, fullText };

    } catch (_) { /* network error — try next key */ }
  }

  return { success: false };
}

// ── Main SSE handler for text mode ────────────────────────────────────────────
// Called when the frontend sends ?stream=1 with mode=text.
// Sets SSE headers, handles cache, routes to Groq/Gemini (same logic as the
// non-streaming text path), streams tokens, then finalises cache + Firestore.
async function streamTextResponse(groqKeys, geminiKeys, ctx, req, res) {
  const {
    question, subject, lang, board, simplify = false,
    history = [], subjectType = 'general', uid, className,
  } = ctx;

  sseStart(res);

  // ── Cache check ─────────────────────────────────────────────────────────────
  const isFollowUpQ = Array.isArray(history) && history.length > 0;
  const isCacheable = !isFollowUpQ && !simplify && question?.trim();
  const kv          = await getKV();
  const cacheKey    = isCacheable ? makeCacheKey(question, subject, className, lang, board) : null;

  if (isCacheable && cacheKey) {
    const cached = await cacheGet(kv, cacheKey);
    if (cached) {
      console.log('[Cache/SSE] HIT:', cacheKey.slice(0, 80));
      sseChunk(res, cached);   // single chunk = instant for the student
      sseDone(res);
      return;
    }
  }

  // ── Smart routing (identical to non-streaming text path) ────────────────────
  const senior         = isSeniorClass(className);
  const wantsThinking  = senior && THINKING_SUBJECTS.includes(subjectType) && !isFollowUpQ;
  const wantsGrounding = needsSearchGrounding(subjectType, subject);
  const geminiFirst    = geminiKeys.length > 0 && (wantsThinking || wantsGrounding);

  let fullText = '';
  let success  = false;
  const onChunk = (text) => sseChunk(res, text);

  if (geminiFirst) {
    const result = await streamGemini(geminiKeys, ctx, onChunk);
    if (result.success) { fullText = result.fullText; success = true; }
    else console.warn('[Gemini/SSE] Smart-route failed, falling back to Groq.');
  }

  if (!success && groqKeys.length > 0) {
    const result = await streamGroq(groqKeys, ctx, onChunk);
    if (result.success) { fullText = result.fullText; success = true; }
  }

  if (!success && geminiKeys.length > 0 && !geminiFirst) {
    const result = await streamGemini(geminiKeys, ctx, onChunk);
    if (result.success) { fullText = result.fullText; success = true; }
  }

  if (!success) {
    sseError(res, '❌ Connection error. Please check your internet and try again.');
    return;
  }

  // ── Post-stream bookkeeping ──────────────────────────────────────────────────
  if (isCacheable && cacheKey && fullText) {
    cacheSet(kv, cacheKey, fullText).catch(() => {});
  }
  if (uid && fullText) {
    const entryId = Date.now();
    saveHistoryToFirestore(uid, {
      id: entryId, ts: entryId, mode: 'text',
      question: question || '', subject: subject || '',
      className: className || '',
      answer: fullText.slice(0, 500),
    }).catch(() => {});
  }

  sseDone(res);
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

    await uploadRes.json();
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
// Only scalar fields stored here (no HTML blobs, no base64, no nested objects).
// The client-side saveHistoryEntryToFirestore has the same constraint.
// Firestore limit is 1 MB per document — keeping entries lean avoids silent
// write failures that cause history to disappear on refresh.
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

// ── Per-subject temperature ───────────────────────────────────────────────────
// Precise subjects (maths/physics) need low temperature for accuracy.
// Creative/language subjects benefit from slightly higher temperature.
// NOTE: When Gemini Thinking Mode is active, temperature is forced to 1.0
// regardless of this map (that is a hard Gemini API requirement).
// ── [UPGRADE #5] Per-subject temperature map ─────────────────────────────────
// Temperature controls how creative/varied the AI's answer is.
// Low (0.10) = strict, precise, formulaic. High (0.55) = expressive, creative.
// New subjects added: accountancy, economics, sanskrit, psychology, pe.
// accountancy and economics are now separate from 'commerce' for better tuning.
function getTemperature(subjectType) {
  const map = {
    // ── Exact sciences (must be precise — no creative variation allowed) ──
    math:         0.10,  // every step must be exactly right
    physics:      0.10,  // formulas, unit analysis, derivations
    chemistry:    0.15,  // mostly formulaic, slight room for explanation style

    // ── Life & applied sciences ───────────────────────────────────────────
    biology:      0.20,  // factual but explanatory; diagrams help
    computer:     0.20,  // code needs consistency; logic must be exact

    // ── Commerce stream ───────────────────────────────────────────────────
    accountancy:  0.12,  // journal entries, ledger, rules — very precise
    commerce:     0.22,  // business studies — some theory, some rules
    economics:    0.28,  // theory + graphs + numericals — needs more latitude

    // ── Social sciences & humanities ──────────────────────────────────────
    humanities:   0.30,  // history, civics, political science — explanatory
    environment:  0.30,  // geography, EVS — factual with some description
    psychology:   0.32,  // concepts + case studies — slightly more expressive

    // ── Languages ─────────────────────────────────────────────────────────
    sanskrit:     0.22,  // grammar rules are strict; translation needs slight creativity
    language:     0.55,  // essays, letters, creative writing — expressiveness needed

    // ── General / GK ──────────────────────────────────────────────────────
    general:      0.30,  // mixed content — balanced middle ground

    // ── Physical education ────────────────────────────────────────────────
    pe:           0.30,  // rules, techniques, theory — descriptive
  };
  return map[subjectType] ?? 0.25;  // safe default for any unmapped type
}

// ── [UPGRADE #2] Should this request use Google Search Grounding? ─────────────
// Grounding fetches live Google results and injects them before generation.
// Only makes sense for knowledge that changes over time (GK, current affairs,
// geography facts, historical events). Hard science never uses grounding —
// the model must apply precise formulas, not search the web.
//
// IMPORTANT: Grounding and Thinking Mode are mutually exclusive features
// (Gemini API restriction). Since THINKING_SUBJECTS and GROUNDING_SUBJECTS
// are designed to be disjoint sets, there is no conflict in practice.
function needsSearchGrounding(subjectType, subject) {
  if (!subjectType && !subject) return false;
  // Hard science subjects are explicitly excluded from grounding
  if (THINKING_SUBJECTS.includes(subjectType)) return false;
  // Grounding is valuable for these subject types
  if (GROUNDING_SUBJECTS.includes(subjectType)) return true;
  // Also check raw subject string for keyword matches
  const s = (subject || '').toLowerCase();
  return GROUNDING_SUBJECT_KEYWORDS.some(kw => s.includes(kw));
}

// ── System prompt ─────────────────────────────────────────────────────────────
function systemPrompt(className, subject, lang, board = '', stream = '', mode = 'text', simplify = false, chapter = '') {
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
Biology SVG Guidelines — draw these whenever the topic matches:
- Genetics / Hardy-Weinberg: draw a Punnett square (2×2 grid with alleles on top and side, genotypes inside each cell) OR a bar chart showing genotype frequencies (AA, Aa, aa) as filled rectangles with labeled heights (p², 2pq, q²). NEVER just type the formula as SVG text — draw the visual.
- Cell diagrams: draw an oval cell outline, then internal organelles as labeled shapes (nucleus = large circle, mitochondria = oval with inner folds, chloroplast = oval with stacked lines, etc.).
- Organ diagrams: draw anatomically positioned schematic shapes (heart = asymmetric oval with chambers, kidney = bean shape, etc.). Label every part with leader lines.
- Photosynthesis / Respiration: draw a process flow with labeled boxes connected by arrows (reactants → energy → products), NOT a left-to-right text list.
- DNA / RNA: draw a double helix (two wavy parallel lines with rungs), label bases (A-T, G-C), direction arrows.
- Mitosis / Meiosis: draw cells at each phase as circles with chromosomes shown as lines or X shapes inside.
- Nervous system: draw a neuron with labeled parts (dendrites, cell body, axon, myelin sheath, synapse).
- Ecosystem / Food chain: draw labeled boxes for producers → primary consumers → secondary consumers with arrows.
CRITICAL: SVGs MUST contain actual shapes (rect, circle, path, line, ellipse, polygon) — not just <text> elements. A diagram made only of text labels is NOT a diagram.
- Define an arrowhead marker at the top of every SVG that uses arrows.
- Keep it clean and school-textbook style.` : '';

  const isPhotoMode = mode === 'photo';
  const isArt      = subj.includes('art') || subj.includes('craft') || subj.includes('drawing');
  const isGeo      = subj.includes('geograph') || subj.includes('map') || subj.includes('evs');
  const isSocial   = subj.includes('social') || subj.includes('history') || subj.includes('civics');
  const isComputer = subj.includes('computer') || subj.includes('ict');
  const needsDiagram = isScience || isArt || isGeo || isSocial || isComputer;

  const physicsSvgGuide = isPhysics ? `
Physics SVG Examples — draw these whenever the topic matches:
- Projectile motion: draw a parabolic arc with labeled axes (x=Range, y=Height), angle θ at origin, velocity vector v₀, peak point h_max, and landing point R. Use <path d="M ...Q... "/> for the curve.
- Electric field lines: draw field line arrows around + and - charges, or parallel plate capacitor with uniform field lines between plates.
- Wave diagram: draw a sine wave with labeled wavelength λ, amplitude A, and direction of propagation arrow.
- Circuit diagram: draw resistors (zigzag), capacitors (parallel lines), batteries (short/long lines), with connecting wires.
- Ray optics: draw a lens or mirror with incident ray, refracted/reflected ray, focal point F, and image formation.
- Force diagrams: draw an object with labeled arrows for weight (↓), normal force (↑), friction (←), and applied force (→).
- Simple pendulum: draw a pivot point, string, and bob, with arc showing oscillation and labels L (length), θ (angle).
- Orbital motion / escape velocity: draw a planet circle in center, curved arrow showing orbit, straight escape arrow outward.
ALWAYS draw the actual physics concept visually — never list data points as text.` : '';

  const chemSvgGuide = isChem ? `
Chemistry SVG Examples — draw these whenever the topic matches:
- Atomic structure: draw concentric circles for electron shells, dots for electrons, labeled nucleus with protons/neutrons.
- Molecular geometry: draw bond lines between element symbols (e.g., H-O-H for water with correct bond angle).
- Reaction process: draw reactant shapes → arrow → product shapes with labels.
- pH scale: draw a horizontal bar from 0–14 with color zones (red=acid, green=neutral, blue=base) and labeled examples.
- Electrolysis cell: draw a beaker with electrodes, ions, and direction arrows.
ALWAYS draw the concept visually — never list chemical data as text.` : '';

  const diagramBlock = (!isPhotoMode && needsDiagram) ? `
DIAGRAM RULE — MANDATORY SVG DRAWING:
For any concept that has a visual form — shape, chart, graph, trajectory, field, wave, structure, process — you MUST draw a real SVG diagram. This is NOT optional.

⛔ ABSOLUTELY FORBIDDEN:
- [Diagram: Projectile Motion\nTime of Flight: 2.04 s\n...] ← THIS IS WRONG. NEVER do this.
- [Diagram: Escape Velocity\nEarth: 11.2 km/s\n...] ← THIS IS WRONG. NEVER do this.
- The [Diagram:...] text format is BANNED for Physics, Chemistry, Biology, Geography, and Computer Science.
- NEVER list numbers or facts inside a [Diagram:...] block. That renders as a useless text card.
- If you cannot draw an SVG, skip the diagram entirely. But NEVER use [Diagram:...] with data inside it.

✅ CORRECT FORMAT — always use this exact structure (no space after [SVG:):
[SVG:<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H" width="W" height="H">
  <rect width="W" height="H" fill="#1a1f30" rx="8"/>
  <!-- actual drawn diagram here — shapes, lines, arrows, labels -->
</svg>]

GENERAL SVG RULES:
- viewBox width: 360–500, height: 260–400 depending on complexity
- Background: <rect width="W" height="H" fill="#1a1f30" rx="8"/>
- Lines/shapes: stroke="#4f8ef7" stroke-width="2" fill="none"
- Axis lines: stroke="#6b7fa3" stroke-width="1.5"
- Arrows: use <defs><marker id="arr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto"><polygon points="0 0,8 3,0 6" fill="#4f8ef7"/></marker></defs> then stroke with marker-end="url(#arr)"
- Title label: <text x="W/2" y="22" fill="#f7c948" font-family="sans-serif" font-size="13" font-weight="bold" text-anchor="middle">Title Here</text>
- Regular labels: <text fill="#e0e8ff" font-family="sans-serif" font-size="11">Label</text>
- Value labels: <text fill="#f7c948" font-family="sans-serif" font-size="11" font-weight="bold">value</text>
- All text must stay INSIDE the viewBox boundaries.
- Minimum content: at least 5 meaningful SVG elements (shapes, lines, text labels).
- ⛔ CRITICAL: An SVG made ONLY of <text> elements is NOT a diagram — it is just text in a box. Every diagram MUST include real visual shapes: <rect>, <circle>, <path>, <line>, <ellipse>, <polygon>, or <polyline>.
${physicsSvgGuide}
${chemSvgGuide}
${bioSvgGuide}` : `
DIAGRAM RULE:
Only draw a diagram if it genuinely helps understanding. If needed, use SVG format:
[SVG:<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 260" width="360" height="260">
  <rect width="360" height="260" fill="#1a1f30" rx="8"/>
  <!-- content here -->
</svg>]
⛔ NEVER use [Diagram: text...] format — it is not supported and will display incorrectly.
If no diagram is needed, skip it entirely.`;

  const simplifyBlock = simplify ? `

⚠️ SIMPLIFY MODE — ACTIVE:
The student could not understand the previous explanation. Teach the SAME concept again but completely differently:
- Use the SIMPLEST everyday words — as if explaining to a younger sibling
- Break into MORE steps — each step is ONE short sentence only, then pause
- Give a real-life example or fun analogy that makes the idea click instantly
- If any word is difficult, define it right away in simple words
- NEVER use: "Furthermore", "Moreover", "Thus", "Hence", "Consequently"
- Tone: warm, friendly, encouraging — like a helpful older student, not a textbook
- End with: 💡 Simple Summary: [one sentence a 10-year-old would understand]` : '';

  // ── [UPGRADE #4] Board-specific curriculum alignment ───────────────────────
  // Normalise the board string so loose user input still matches
  // (e.g. "cbse", "CBSE ", "Cbse" all resolve to the same rule block).
  // Unknown / missing boards produce an empty string — zero risk of breakage.
  const boardNorm = (board || '').toLowerCase().replace(/\s+/g, '');
  const boardRules = {
    // ── Central boards ──────────────────────────────────────────────────────
    cbse: `
BOARD — CBSE (NCERT):
- Follow NCERT textbook definitions, theorems, and examples EXACTLY.
- Prefer the exact wording, notation, and method used in NCERT books for this class.
- When a formula or proof has an NCERT derivation, show that derivation — do not substitute an alternative.
- For definitions, quote the NCERT definition first, then explain it simply.
- Reference relevant NCERT chapter/exercise numbers when helpful (e.g. "NCERT Class 10 Ch 3, Ex 3.2").
- Answers should match the style expected in CBSE board exams: clear headings, numbered points, diagrams where prescribed.`,

    icse: `
BOARD — ICSE / ISC (CISCE):
- ICSE expects detailed, elaborated answers — do NOT give one-line responses for theory questions.
- Use formal academic vocabulary appropriate for ICSE exam answers.
- For science: follow Selina / Frank textbook methods where they differ from NCERT.
- Structure answers with proper headings: Definition → Explanation → Example → Diagram (if needed).
- For essays and long-answer questions, use organised paragraphs with topic sentences.
- Always show full working for mathematics; partial marks are awarded step-by-step in ICSE.
- Where ISC (Class 11–12) is implied, answers must match ISC marking-scheme depth.`,

    isc: `
BOARD — ISC (CISCE Class 11–12):
- ISC expects rigorous, detailed answers — do NOT give one-line responses for theory questions.
- Use formal academic vocabulary appropriate for ISC exam answers.
- Structure answers with proper headings: Definition → Explanation → Example → Diagram (if needed).
- Always show full working for mathematics; partial marks are awarded step-by-step in ISC.
- Answers must match ISC marking-scheme depth and use ISC-prescribed methods.`,

    // ── Assam state boards ───────────────────────────────────────────────────
    seba: `
BOARD — SEBA (Assam Secondary Education Board, Classes 9–10):
- Follow the SEBA syllabus and SCERT Assam textbooks for this class.
- Use examples, names, and contexts that are familiar to students in Assam (local rivers, geography, cultural references).
- For Assamese-medium students answering in Bengali or Assamese, use the script and vocabulary taught in SEBA textbooks.
- Exam answers should follow the pattern and depth expected in the HSLC (Class 10 board) examination.`,

    ahsec: `
BOARD — AHSEC (Assam Higher Secondary Education Council, Classes 11–12):
- Follow the AHSEC syllabus and prescribed textbooks for Classes 11–12.
- Use examples and contexts relevant to Assam where appropriate.
- Answers should match the depth and style expected in the HS (Class 12 board) examination.
- For science streams, align with AHSEC-prescribed methods, not solely NCERT where they differ.`,

    asseb: `
BOARD — ASSEB / Assam Board:
- Follow the Assam Board (SEBA/AHSEC) syllabus and SCERT Assam textbooks.
- Use examples and contexts familiar to students in Assam.
- Match the answer depth and style expected in Assam board examinations.`,

    // ── Other national boards ────────────────────────────────────────────────
    nios: `
BOARD — NIOS (National Institute of Open Schooling):
- Follow NIOS study material and prescribed modules.
- Answers should be clear and self-contained — NIOS students often study independently.
- Structure answers to match NIOS examination style: direct, to-the-point, with clear subheadings.`,

    igcse: `
BOARD — IGCSE / Cambridge:
- Follow Cambridge IGCSE syllabus and mark-scheme conventions.
- Use British English spellings (e.g. "colour", "analyse", "centre").
- For science, use SI units exclusively and state formulae in the Cambridge-approved form.
- Exam answers must match Cambridge mark-scheme style: concise, keyword-driven, no padding.
- For extended-response questions, structure as: Point → Evidence → Explanation (PEE).`,
  };

  // Look up the rule block; fall back to empty string for unknown boards.
  const boardBlock = boardRules[boardNorm] || '';

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
Adjust explanation depth and vocabulary for this level.
${chapter ? `
CURRENT CHAPTER — STRICTLY FOLLOW:
The student is studying: **${chapter}**
- Scope your answer to concepts covered in or before this chapter.
- Do NOT introduce formulas, theorems, or topics from later chapters.
- Mention the chapter name naturally where relevant (e.g. "In ${chapter}, we learn that…").
- If a prerequisite concept from an earlier chapter is needed, briefly recall it.` : ''}
${boardBlock}${simplifyBlock}`;
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
// FIX: Added `history` parameter. When a conversation history is provided
// (follow-up questions), we build a proper multi-turn messages array instead
// of a single user message. This gives the AI full context of the conversation.
async function askGroq(keys, { question, className, subject, lang, board, stream, mode, simplify, history = [], subjectType = 'general', chapter = '' }) {
  const sysPrompt = systemPrompt(className, subject, lang, board, stream, mode, !!simplify, chapter);
  let lastErr = null;

  const senior = isSeniorClass(className);
  const model  = senior ? GROQ_MODEL_SENIOR : GROQ_MODEL_JUNIOR;
  const rot    = senior ? rotations.groqSenior : rotations.groqJunior;
  const temp   = getTemperature(subjectType);

  // ── Build messages array ──────────────────────────────────────────────────
  // If we have a conversation history (follow-up flow), use it as the full
  // messages array. Cap at the last 6 messages (3 rounds) to avoid token overflow.
  // Otherwise fall back to a single user message (original question flow).
  const hasHistory = Array.isArray(history) && history.length > 1;
  // FIX: Ensure recentHistory always starts with a 'user' turn.
  // slice(-6) on a long history can cut mid-conversation and leave an
  // 'assistant' turn first — both Groq and Gemini reject that ordering.
  let recentHistory = hasHistory ? history.slice(-6) : null;
  if (recentHistory && recentHistory[0]?.role !== 'user') recentHistory = recentHistory.slice(1);

  const messages = recentHistory
    ? [{ role: 'system', content: sysPrompt }, ...recentHistory]
    : [{ role: 'system', content: sysPrompt }, { role: 'user', content: question.trim() }];

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
          messages,
          temperature:    temp,
          max_tokens:     8192,
          top_p:          0.92,
        }),
      });

      const data = await r.json();
      if (data.error) {
        const msg  = (data.error.message || '').toLowerCase();
        const code = data.error.code || r.status;
        if (code === 429 || msg.includes('rate') || msg.includes('quota')) {
          // Per-minute limit: key is still valid, just busy right now → try next key but don't exhaust.
          // Per-day limit: key is truly exhausted → mark it and skip for the rest of the day.
          const isDailyLimit = msg.includes('per day') || msg.includes('rpd') || msg.includes('daily');
          if (isDailyLimit) rot.exhausted.add(key);
          lastErr = 'quota';
          continue;
        }
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
// [UPGRADE #1] Thinking Mode: enabled for Class 11–12 Math/Physics/Chemistry
//   on fresh (non-follow-up) text questions. Gemini reasons through the problem
//   silently using up to 8192 thinking tokens before writing the answer.
//   This is the single largest accuracy improvement for board exam questions.
//   Requires temperature=1.0 (hard Gemini API requirement for thinking).
//
// [UPGRADE #2] Search Grounding: enabled for GK/Humanities/Geography/General
//   subjects. Injects live Google Search results so answers about current events,
//   office-holders, recent news, and facts-that-change stay accurate.
//   Automatically skipped for hard science (they need formula precision, not web).
//   Also skipped when Thinking Mode is active (both can't be used together).
//
// FIX: Added `history` parameter. When a conversation history is provided,
// we build a proper multi-turn `contents` array in Gemini's format.
// For photo follow-ups, the original image is re-attached to the first turn
// so the AI can still reference it throughout the conversation.
async function askGemini(keys, { question, imageBase64, imageMime, className, subject, lang, board, stream, mode, simplify, history = [], subjectType = 'general', chapter = '' }) {
  const rot = rotations.gemini;
  let lastErr = null;

  const validMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
  const mime = validMimes.includes(imageMime) ? imageMime : 'image/jpeg';

  // ── [UPGRADE #1] Thinking Mode decision ──────────────────────────────────
  // Conditions for activating Gemini extended thinking:
  //   1. Senior class (11 or 12) — where board exam precision matters most
  //   2. Hard science subject (math / physics / chemistry)
  //   3. Not photo mode — vision + thinking is not supported by Gemini
  //   4. Not a follow-up turn — conserve quota for fresh questions
  const hasHistory  = Array.isArray(history) && history.length > 1;
  const senior      = isSeniorClass(className);
  const useThinking = senior
    && THINKING_SUBJECTS.includes(subjectType)
    && mode !== 'photo'
    && !hasHistory;  // follow-ups don't get thinking (quota conservation)

  // ── [UPGRADE #2] Search Grounding decision ────────────────────────────────
  // Grounding and Thinking are mutually exclusive (Gemini API restriction).
  // In practice, THINKING_SUBJECTS ∩ GROUNDING_SUBJECTS = ∅, so this
  // guard is a safety net rather than something that should ever trigger.
  const useGrounding = !useThinking
    && mode !== 'photo'         // grounding doesn't work with inline image uploads
    && needsSearchGrounding(subjectType, subject);

  // Temperature: thinking mode requires exactly 1.0; otherwise use subject map.
  const temp = useThinking ? 1.0 : getTemperature(subjectType);

  if (useThinking) {
    console.log(`[Gemini] Thinking mode ON — ${subjectType} / Class ${className}`);
  }
  if (useGrounding) {
    console.log(`[Gemini] Search grounding ON — ${subjectType} / ${subject}`);
  }

  // ── Build contents array ──────────────────────────────────────────────────
  // Gemini uses 'model' for the assistant role (not 'assistant').
  // When history is present: map the full conversation into Gemini's format.
  // For photo mode with history: inject the image into the FIRST user turn so
  // the AI still has visual context when answering follow-up questions.
  let contents;

  if (hasHistory) {
    // FIX: Ensure recentHistory always starts with a 'user' turn (same as askGroq).
    let recentHistory = history.slice(-6); // cap at 3 rounds
    if (recentHistory[0]?.role !== 'user') recentHistory = recentHistory.slice(1);

    if (mode === 'photo') {
      // Photo follow-up: first user turn carries the image + original question text.
      // Subsequent turns are plain text.
      const [firstMsg, ...restMsgs] = recentHistory;
      contents = [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: mime, data: imageBase64 } },
            { text: firstMsg.content || photoInstruction(lang) },
          ],
        },
        ...restMsgs.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content || '' }],
        })),
      ];
    } else {
      // Text follow-up: straightforward role mapping.
      contents = recentHistory.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content || '' }],
      }));
    }
  } else {
    // Single-turn (original question, no history yet).
    const parts = [];
    if (mode === 'photo') {
      parts.push({ inline_data: { mime_type: mime, data: imageBase64 } });
      const textPart = question?.trim()
        ? `${question.trim()}\n\nPlease read this image carefully and answer the question completely, step by step.`
        : photoInstruction(lang);
      parts.push({ text: textPart });
    } else {
      parts.push({ text: question.trim() });
    }
    contents = [{ role: 'user', parts }];
  }

  // ── Build the Gemini request body ─────────────────────────────────────────
  const body = {
    system_instruction: { parts: [{ text: systemPrompt(className, subject, lang, board, stream, mode, !!simplify, chapter) }] },
    generationConfig: {
      // Standard requests use the subject-tuned temperature from getTemperature().
      temperature:      temp,
      topK:             useThinking ? undefined : 40,  // thinking ignores topK
      topP:             0.92,
      maxOutputTokens:  useThinking ? 16384 : 8192,    // thinking needs more output budget
      candidateCount:   1,
      ...(useThinking ? {
        thinkingConfig: {
          // Budget of 8192 thinking tokens — enough for complex derivations
          // and multi-step proofs without being extravagant on quota.
          thinkingBudget: 8192,
        },
      } : {}),
    },
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH'        },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
    ],
    // [UPGRADE #2] Attach the Google Search tool when grounding is needed.
    // This causes Gemini to pull live web results before generating the answer,
    // keeping GK / current-affairs / geography answers factually up to date.
    ...(useGrounding ? { tools: [{ googleSearch: {} }] } : {}),
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

        // [UPGRADE #1] If thinking mode caused an error, retry without it.
        // This guards against the rare case where the model version doesn't
        // support thinkingConfig on a particular key/region.
        if (useThinking && (isBadKey || msg.toLowerCase().includes('thinking'))) {
          console.warn('[Gemini] Thinking mode rejected, retrying without it:', msg);
          // Rebuild body without thinking and retry the same key once
          const fallbackBody = {
            ...body,
            generationConfig: {
              temperature: getTemperature(subjectType),
              topK: 40, topP: 0.92,
              maxOutputTokens: 8192, candidateCount: 1,
            },
          };
          delete fallbackBody.generationConfig.thinkingConfig;
          try {
            const r2   = await fetch(`${GEMINI_URL}?key=${key}`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(fallbackBody),
            });
            const d2 = await r2.json();
            const fallbackAnswer = extractGeminiText(d2);
            if (fallbackAnswer) return { answer: fallbackAnswer, provider: 'gemini' };
          } catch {}
        }

        if (isQuota || isBadKey) { rot.exhausted.add(key); lastErr = 'quota'; continue; }
        if (code === 503 || msg.toLowerCase().includes('overload')) { lastErr = 'overload'; continue; }
        lastErr = msg;
        continue;
      }

      if (data.candidates?.[0]?.finishReason === 'SAFETY') {
        return { answer: '⚠️ This question was flagged by safety filters. Please rephrase it and try again.' };
      }

      // ── Extract answer text ───────────────────────────────────────────────
      // [UPGRADE #1] Thinking responses: Gemini returns thought parts (role=
      //   'thought') before the actual answer parts. We skip those and only
      //   collect parts where thought !== true.
      // [UPGRADE #2] Grounded responses: Gemini may return multiple text parts
      //   (answer text + citation snippets). We join all non-thought text parts.
      const answer = extractGeminiText(data);
      if (!answer) { lastErr = 'empty'; continue; }

      return { answer, provider: 'gemini' };

    } catch (e) {
      lastErr = 'network';
      continue;
    }
  }

  return { error: lastErr };
}

// ── Extract answer text from a Gemini API response ───────────────────────────
// Handles three response shapes:
//   1. Standard:  parts = [{ text: '...' }]
//   2. Thinking:  parts = [{ thought: true, text: '<internal reasoning>' },
//                           { text: '<actual answer>' }]
//                 → skip thought parts, join the rest
//   3. Grounded:  parts = [{ text: '...' }, { text: '...' }]  (answer + snippets)
//                 → join all non-thought text parts
function extractGeminiText(data) {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts || parts.length === 0) return null;

  // Collect all text parts that are NOT internal thought blocks
  const textParts = parts
    .filter(p => p.text && !p.thought)
    .map(p => p.text.trim())
    .filter(Boolean);

  return textParts.length > 0 ? textParts.join('\n\n') : null;
}

// ── Quiz system prompt ────────────────────────────────────────────────────────
// [UPGRADE #4] Dynamic quiz prompt builder — subject-aware, class-aware, board-aware.
// Produces exam-quality MCQs with believable wrong options and difficulty distribution.
function buildQuizSystem(className, subject, subjectType, board) {
  const senior  = isSeniorClass(className);
  const isMath  = ['math','physics','chemistry'].includes(subjectType);
  const isLang  = subjectType === 'language';
  const boardHint = board ? ` following the ${board} syllabus and exam style` : '';
  const classHint = className ? ` for Class ${className} students` : ' for school students';

  const subjectRules = isMath
    ? `- For calculation questions: show the numerical answer as the correct option (not a formula)
- Include at least 1 question that requires a calculation or formula application
- Wrong options must be plausible wrong calculations (off-by-one, wrong formula, unit error)`
    : isLang
    ? `- Questions may test grammar rules, word meanings, comprehension, or author intent
- Wrong options must be believable alternative interpretations or near-synonyms
- Avoid trivially obvious wrong options`
    : `- Wrong options must be believable — use real but incorrect facts, not nonsense
- At least 1 question should test a commonly confused concept in this subject
- Include specific names, dates, or terms students are expected to recall`;

  const difficultyGuide = senior
    ? `DIFFICULTY MIX (strictly follow):
- Q1: Medium — tests core concept understanding
- Q2: Hard — requires applying knowledge or multi-step thinking
- Q3: Medium-Hard — tests a commonly confused or tricky aspect`
    : `DIFFICULTY MIX (strictly follow):
- Q1: Easy — tests basic recall or definition
- Q2: Medium — tests understanding and application
- Q3: Tricky — a concept students commonly get wrong`;

  return `You are an expert quiz generator for Indian school students${classHint}${boardHint}.
Output ONLY a valid JSON array. No markdown, no code fences, no extra text. Start with [ and end with ].

STRICT JSON FORMAT — every object must have exactly these keys:
{
  "q": "Question text (clear, exam-style, ends with ?)",
  "options": ["Option A text", "Option B text", "Option C text", "Option D text"],
  "correct": 0,
  "explanation": "One sentence explaining why the correct answer is right."
}

CRITICAL FORMAT RULES:
- correct must be a NUMBER (0=A, 1=B, 2=C, 3=D) — never a letter
- Vary which position is correct across all 3 questions (not always 0)
- Questions must be based ONLY on the answer content provided — never invent facts
- Each question must test a genuinely different idea — no rephrasing the same concept
- Options must be parallel in structure (all noun phrases OR all full sentences)
- Explanation must name the correct answer and briefly state the reason

${difficultyGuide}

WRONG OPTIONS QUALITY:
${subjectRules}

OUTPUT: Exactly 3 question objects in a valid JSON array. Nothing else.`;
}

// ── Suggestions system prompt ─────────────────────────────────────────────────
const SUGGESTIONS_SYSTEM = `You are a helpful study assistant. You output ONLY valid JSON arrays of strings, nothing else.
No markdown, no code fences, no explanation, no preamble — just the raw JSON array starting with [ and ending with ].`;

// ── Quiz handler ──────────────────────────────────────────────────────────────
// [UPGRADE #4] Now accepts subject, subjectType, board so buildQuizSystem()
// can tailor difficulty rules, wrong-option quality, and exam style per subject.
async function askQuiz(groqKeys, geminiKeys, { question, className, subject = '', subjectType = 'general', board = '' }) {
  const senior    = isSeniorClass(className);
  const model     = senior ? GROQ_MODEL_SENIOR : GROQ_MODEL_JUNIOR;
  const rot       = senior ? rotations.groqSenior : rotations.groqJunior;
  const quizSys   = buildQuizSystem(className, subject, subjectType, board);

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
              { role: 'system', content: quizSys },
              { role: 'user',   content: question.trim() },
            ],
            temperature: 0.4, max_tokens: 2048, top_p: 0.9,
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
            system_instruction: { parts: [{ text: quizSys }] },
            contents: [{ role: 'user', parts: [{ text: question.trim() }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 2048, candidateCount: 1 },
          }),
        });
        const data = await r.json();
        if (data.error) {
          const isQuota = data.error.status === 'RESOURCE_EXHAUSTED' || data.error.code === 429;
          if (isQuota) { grot.exhausted.add(key); continue; }
          continue;
        }
        const answer = extractGeminiText(data);
        if (answer) return { answer };
      } catch(e) { continue; }
    }
  }

  return { error: 'failed' };
}

// ── Suggestions handler ───────────────────────────────────────────────────────
// Generates 3 short follow-up question chips shown below every answer.
// Uses the same Groq/Gemini rotation as quiz — light-weight JSON output only.
async function askSuggestions(groqKeys, geminiKeys, { question, answer, className, subject, lang, subjectType }) {
  const langMap    = { en: 'English', bn: 'Bengali (Bangla)', hi: 'Hindi', as: 'Assamese' };
  const replyLang  = langMap[lang] || 'English';
  const senior     = isSeniorClass(className);
  const model      = senior ? GROQ_MODEL_SENIOR : GROQ_MODEL_JUNIOR;
  const rot        = senior ? rotations.groqSenior : rotations.groqJunior;

  const prompt = `A student just asked about "${subject || 'General'}" (${className || 'school level'}):
Question: "${question || '(photo/image question)'}"

Based on this topic, generate exactly 3 short follow-up questions the student would naturally want to ask next.

Rules:
- All questions MUST be in ${replyLang}
- Each question must be under 12 words
- Make them genuinely useful: one deepens the concept, one asks for a real-life example, one is exam-oriented
- Do NOT repeat or rephrase the original question
- Questions should work as standalone follow-ups

Respond ONLY with a JSON array of exactly 3 strings (no other text):
["Question 1?", "Question 2?", "Question 3?"]`;

  // Try Groq first
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
              { role: 'system', content: SUGGESTIONS_SYSTEM },
              { role: 'user',   content: prompt },
            ],
            temperature: 0.55, max_tokens: 256, top_p: 0.9,
          }),
        });
        const data = await r.json();
        if (data.error) {
          const isQuota = data.error.code === 429 || (data.error.message || '').toLowerCase().includes('rate');
          if (isQuota) { rot.exhausted.add(key); continue; }
          continue;
        }
        const ans = data.choices?.[0]?.message?.content;
        if (ans) return { answer: ans };
      } catch (_) { continue; }
    }
  }

  // Gemini fallback
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
            system_instruction: { parts: [{ text: SUGGESTIONS_SYSTEM }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.55, maxOutputTokens: 256, candidateCount: 1 },
          }),
        });
        const data = await r.json();
        if (data.error) {
          const isQuota = data.error.status === 'RESOURCE_EXHAUSTED' || data.error.code === 429;
          if (isQuota) { grot.exhausted.add(key); continue; }
          continue;
        }
        const ans = extractGeminiText(data);
        if (ans) return { answer: ans };
      } catch (_) { continue; }
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
    className, subject, lang = 'en', board = '', stream = '', uid, simplify = false,
    subjectType: rawSubjectType = 'general',
    chapter = '',
    // FIX: Accept conversation history from the frontend.
    // This is an array of { role: 'user'|'assistant', content: string } objects
    // built up over the course of a follow-up conversation.
    history = [],
  } = req.body || {};

  // ── [UPGRADE #3] Auto-detect subjectType from subject string ─────────────────
  // The frontend may send subjectType='general' for unknown or new subjects.
  // detectSubjectType() inspects the actual subject name and returns the correct
  // type — ensuring Thinking Mode (math/physics/chem) and Search Grounding
  // (humanities/gk/geography) always activate for the right subjects.
  const subjectType = detectSubjectType(subject, rawSubjectType);

  const ip         = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  const trackingId = (uid && uid.length > 4) ? `uid:${uid}` : `ip:${ip}`;
  // Suggestions are auto-fired after every answer (fire-and-forget).
  // Exempting them ensures they don't consume the user's 8/min question quota.
  if (mode !== 'suggestions' && isSpamming(trackingId)) {
    return res.status(429).json({
      error: '⏳ Slow down! You are asking too many questions at once. Please wait a moment.'
    });
  }

  if (mode === 'text' && !question?.trim() && (!Array.isArray(history) || history.length === 0)) {
    return res.status(400).json({ error: '❌ Please type your question.' });
  }
  if (mode === 'photo' && !imageBase64) {
    return res.status(400).json({ error: '❌ No image received. Please try adding the photo again.' });
  }

  // FIX: Pass history through to askGroq and askGemini via ctx.
  const ctx = { question, imageBase64, imageMime, className, subject, lang, board, stream, mode, simplify, history, subjectType, chapter };

  // ── STREAMING TEXT MODE ──────────────────────────────────────────────────────
  // When the client sends ?stream=1 and mode is text, bypass the normal JSON
  // response path and push tokens via SSE as they arrive from Groq / Gemini.
  // Photo, quiz, suggestions, and simplify modes keep their existing paths.
  if (req.query?.stream === '1' && mode === 'text') {
    return streamTextResponse(groqKeys, geminiKeys, ctx, req, res);
  }

  // ── Cache lookup (text-only, non-follow-up, non-simplify questions) ─────────
  // We only cache clean first questions — not follow-ups (history has context),
  // not simplify (personalised retry), not photo (image varies), not quiz (random).
  const isFollowUpQ  = Array.isArray(history) && history.length > 0;
  const isCacheable  = mode === 'text' && !isFollowUpQ && !simplify && question?.trim();
  const kv           = await getKV(); // shared KV client for this request
  const cacheKey     = isCacheable ? makeCacheKey(question, subject, className, lang, board) : null;

  if (isCacheable && cacheKey) {
    const cached = await cacheGet(kv, cacheKey);
    if (cached) {
      console.log('[Cache] HIT:', cacheKey.slice(0, 80));
      return res.status(200).json({ answer: cached, cached: true });
    }
    console.log('[Cache] MISS:', cacheKey.slice(0, 80));
  }

  // ── SUGGESTIONS mode ─────────────────────────────────────────────────────────
  // Lightweight endpoint: generates 3 follow-up question chips for the frontend.
  // Called fire-and-forget after every answer — failures are silently ignored by
  // the client so they never block the user.
  if (mode === 'suggestions') {
    if (!question?.trim() && !req.body?.answer) {
      return res.status(400).json({ error: 'No content for suggestions.' });
    }
    const result = await askSuggestions(groqKeys, geminiKeys, {
      question:    req.body.question    || '',
      answer:      req.body.answer      || '',
      className,
      subject,
      lang,
      subjectType, // already resolved via detectSubjectType above
    });
    if (result.answer) return res.status(200).json({ answer: result.answer });
    return res.status(500).json({ error: 'Suggestions generation failed.' });
  }

  // ── QUIZ mode ──────────────────────────────────────────────────────────────
  if (mode === 'quiz') {
    if (!question?.trim()) return res.status(400).json({ error: 'No quiz prompt.' });
    const result = await askQuiz(groqKeys, geminiKeys, { question, className, subject, subjectType, board });
    if (result.answer) {
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

    // Fire-and-forget image upload (only on first question, not follow-ups)
    const isFollowUp = Array.isArray(history) && history.length > 1;
    const imageUploadPromise = isFollowUp
      ? Promise.resolve(null)
      : uploadImageToStorage(imageBase64, imageMime, uid, subject, className).catch(e => {
          console.warn('[Storage] Upload failed silently:', e.message);
          return null;
        });

    const result = await askGemini(geminiKeys, ctx);

    if (result.answer) {
      const storageUrl = await Promise.race([
        imageUploadPromise,
        new Promise(r => setTimeout(() => r(null), 2000))
      ]);

      if (uid) {
        const entryId = Date.now();
        saveHistoryToFirestore(uid, {
          id: entryId, ts: entryId, mode: 'photo',
          question: question || '', subject: subject || '',
          className: className || '',
          answer: result.answer.slice(0, 500),
          ...(storageUrl ? { imageStorageUrl: storageUrl } : {}),
        }).catch(() => {});

        if (storageUrl) console.log('[Storage] Image saved:', storageUrl);
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

  // ── TEXT mode ──────────────────────────────────────────────────────────────
  // Routing logic with Upgrades #1 and #2 in mind:
  //
  // • Class 11–12 Math/Physics/Chemistry (fresh question, not follow-up):
  //     → Gemini FIRST (Thinking Mode active) for maximum accuracy
  //     → Groq as fallback if Gemini quota is exhausted
  //
  // • GK / Humanities / Geography / General (any class):
  //     → Gemini FIRST (Search Grounding active) for live/current answers
  //     → Groq as fallback
  //
  // • Everything else (standard questions, follow-ups, junior classes):
  //     → Groq FIRST (fast and free), Gemini as fallback
  //
  const senior = isSeniorClass(className);
  const wantsThinking  = senior && THINKING_SUBJECTS.includes(subjectType) && !isFollowUpQ;
  const wantsGrounding = needsSearchGrounding(subjectType, subject) && mode !== 'photo';
  const geminiFirst    = geminiKeys.length > 0 && (wantsThinking || wantsGrounding);

  if (geminiFirst) {
    // Gemini leads for smart-routing cases (thinking or grounding)
    const geminiResult = await askGemini(geminiKeys, ctx);
    if (geminiResult.answer) {
      if (isCacheable && cacheKey) cacheSet(kv, cacheKey, geminiResult.answer).catch(() => {});
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
    // Gemini failed/quota — fall through to Groq below
    console.warn('[Gemini] Smart-route failed, falling back to Groq. Error:', geminiResult.error);
  }

  // Groq path (primary for standard questions, fallback for smart-routed ones)
  if (groqKeys.length > 0) {
    const groqResult = await askGroq(groqKeys, ctx);
    if (groqResult.answer) {
      if (isCacheable && cacheKey) cacheSet(kv, cacheKey, groqResult.answer).catch(() => {});
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

  // Final Gemini fallback (for standard questions where Groq failed)
  if (geminiKeys.length > 0 && !geminiFirst) {
    const geminiResult = await askGemini(geminiKeys, ctx);
    if (geminiResult.answer) {
      if (isCacheable && cacheKey) cacheSet(kv, cacheKey, geminiResult.answer).catch(() => {});
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
