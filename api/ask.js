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
function systemPrompt(className, subject, lang, board = '', stream = '', mode = 'text') {
  const langMap = { en: 'English', bn: 'Bengali (Bangla)', hi: 'Hindi', as: 'Assamese' };
  const replyLang = langMap[lang] || 'English';

  // Detect subject type for specialized instructions
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
- NEVER wrap a standalone number in $...$. This applies everywhere: prose, bullet points, lists, conclusions. Write "I represents 1" NOT "I represents $1$". Write "The answer is 0.5" NOT "The answer is $0.5$". Only use $...$ when the number has variables, operators, fractions, or symbols alongside it (e.g. $x = 5$, $\\frac{1}{2}$).
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

  // Biology-specific diagram guidance — schematic/labeled diagrams
  const bioSvgGuide = isBio ? `
Biology SVG Guidelines (use these for organ/cell/process diagrams):
- For organ diagrams (heart, kidney, reproductive system, etc.): draw anatomically positioned schematic shapes using <ellipse>, <path>, <rect> with rounded corners. Label every part with short leader lines and text.
- NEVER draw organ diagrams as left-to-right flowcharts (no chain of boxes with arrows between them). Organs must be positioned spatially as they appear in the body.
- Define an arrowhead marker at the top of the SVG:
  <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#4f8ef7"/></marker></defs>
- Organ fill colors (semi-transparent): organs #4f8ef7 at opacity 0.25, special parts #3ecf8e at opacity 0.3, ducts/tubes #f7c948 at opacity 0.3
- All organ outlines: stroke="#4f8ef7" stroke-width="2"
- Label lines: stroke="#eef0f8" stroke-width="1" opacity="0.6"
- Label text: fill="#eef0f8" font-size="10" font-family="sans-serif"
- Part highlight: fill="#3ecf8e" opacity="0.35" for the most important structure
- For reproductive system: draw male and female as TWO SEPARATE vertical sections, stacked top and bottom, with a horizontal dividing line and section title. Use curved <path> elements for tubes and ducts.
- For process diagrams (e.g. fertilization, cell division): vertical flow with labeled stages is fine.
- For plant/cell diagrams: draw cell wall as outer rect, organelles as labeled ellipses inside.
- Keep it clean and school-textbook style — not overly detailed, just key structures labeled.
- Double-check that every label text is within the viewBox bounds before finalizing.` : '';

  // In photo mode, never generate SVG diagrams — the image IS the visual context
  const isPhotoMode = mode === 'photo';

  // Subject categories that benefit from SVG diagrams
  const isArt      = subj.includes('art') || subj.includes('craft') || subj.includes('drawing') || subj.includes('paint') || subj.includes('sketch');
  const isGeo      = subj.includes('geograph') || subj.includes('map') || subj.includes('evs') || subj.includes('environment');
  const isSocial   = subj.includes('social') || subj.includes('history') || subj.includes('civics') || subj.includes('political') || subj.includes('economics');
  const isComputer = subj.includes('computer') || subj.includes('ict') || subj.includes('it ') || subj === 'it';
  const needsDiagram = isScience || isArt || isGeo || isSocial || isComputer;

  // Subject-specific SVG guide additions
  const statSvgGuide = isStat ? `
Statistics SVG Guidelines:
- Bar chart: draw vertical bars using <rect> with equal spacing. X-axis line at bottom, Y-axis on left. Label each bar below. Add value on top of each bar.
- Pie chart: use <path> arcs with different fill colors per segment. Add % label inside or with leader lines.
- Histogram: like bar chart but bars touch each other (no gap). Label class intervals on x-axis.
- Frequency polygon: plot points then connect with <polyline>. Mark each point with a small circle.
- Ogive (cumulative): smooth S-curve using <path> with bezier curves.
- Line graph: <polyline> through data points, axes with tick marks and labels.
- Always draw both axes with arrows at the ends. Label axes with their variable names.
- Grid lines: stroke="#2a3050" stroke-width="0.5" opacity="0.5" (light background grid)
- Bars/fills: use #4f8ef7 fill at opacity 0.7. Alternate colors for multiple data sets.
- Canvas: W=320 H=280 for most charts. W=320 H=320 for pie charts.` : '';

  const artSvgGuide = isArt ? `
Art & Drawing SVG Guidelines:
- Draw the ACTUAL object being asked about — not a flowchart or process diagram.
- Use smooth curved <path> elements for organic shapes (fruits, animals, flowers, leaves).
- Mango: large teardrop/oval shape with a small stem at top, slight curve to one side. Color: fill="#f7c948" opacity="0.8".
- Flower: central circle + petal ellipses radiating around it. Color: petals #f7c948, center #e07b39.
- Leaf: pointed oval with a center vein line and small branching veins.
- House: rectangle body + triangle roof + small rectangle door + square windows.
- Tree: brown rectangle trunk + large green ellipse canopy.
- Sun: circle center + radiating lines around it.
- Fish: body ellipse + triangle tail + small circle eye.
- For step-by-step drawing guides: show 3-4 stages in a grid layout (2 columns), each stage labeled "Step 1", "Step 2" etc.
- Keep lines clean and clear. Use stroke="#4f8ef7" for outlines, fill colors with opacity 0.6-0.8.
- Canvas: W=300 H=280 for single object. W=320 H=400 for step-by-step grid.` : '';

  const geoSvgGuide = (isGeo || isSocial) ? `
Geography/Social Studies SVG Guidelines:
- For map diagrams: draw simplified outlines using <path>. Label regions, rivers, mountains.
- For timeline diagrams: horizontal line with labeled points (events) above/below alternating.
- For process diagrams (water cycle, food chain, etc.): use labeled shapes with arrows showing flow.
- For comparison/classification charts: use a tree structure flowing top-down.
- Arrow marker: <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#4f8ef7"/></marker></defs>
- Canvas: W=320 H=260 for timelines/maps. W=300 H=380 for flow diagrams.` : '';

  const computerSvgGuide = isComputer ? `
Computer Science SVG Guidelines:
- Flowcharts: use standard shapes — rectangle (process), diamond (decision), oval (start/end), parallelogram (input/output).
- For flowcharts: draw top-to-bottom flow with connecting arrows. Label every shape clearly.
- Network diagrams: circles/squares for nodes, lines for connections, labels for device names.
- For data structures (arrays, stacks, trees): draw boxes in correct formation with values inside.
- Arrow marker: <defs><marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="#4f8ef7"/></marker></defs>
- Canvas: W=300 H=380 for flowcharts. W=320 H=260 for simple diagrams.` : '';

  const diagramBlock = (!isPhotoMode && needsDiagram) ? `
DIAGRAM RULE — DRAW AN SVG WHENEVER RELEVANT:
For any concept that has a visual form — shape, chart, graph, object, map, diagram, process, structure — you MUST draw a real SVG. Never just describe it in text.

Output using this EXACT format (no space after [SVG:):
[SVG:<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 W H" width="W" height="H">
  <rect width="W" height="H" fill="#1a1f30" rx="8"/>
  <!-- diagram content here -->
</svg>]

CANVAS SIZE — choose based on content:
- Simple object / fruit / animal drawing: W=300 H=280
- Step-by-step drawing (4 stages): W=320 H=400
- Single organ (heart, kidney, eye): W=320 H=300
- Multi-part body system: W=320 H=480
- Cell / cross-section diagram: W=320 H=380
- Process flow (cycle, stages): W=320 H=420
- Bar/line/histogram chart: W=320 H=280
- Pie chart: W=320 H=320
- Timeline / map diagram: W=320 H=260
- Flowchart (computer): W=300 H=380
Replace W and H in BOTH viewBox AND width/height attributes.

GENERAL SVG RULES (apply to all diagrams):
- Background: <rect width="W" height="H" fill="#1a1f30" rx="8"/>
- Outlines/lines: stroke="#4f8ef7" stroke-width="2" fill="none"
- Fills (shapes): fill="#4f8ef7" opacity="0.25" (or subject-specific colors below)
- Point markers: <circle cx="X" cy="Y" r="4" fill="#f7c948"/>
- Bold labels: <text fill="#f7c948" font-family="sans-serif" font-size="12" font-weight="bold">
- Small labels: fill="#eef0f8" font-size="10" font-family="sans-serif"
- Highlight color: #3ecf8e (special parts, correct answers, key structures)
- Dashed lines: stroke-dasharray="5,3"
- All text must stay INSIDE the viewBox. Max x = W-15, max y = H-10.
- Split long labels into two lines using <tspan dy="13">
- ALWAYS label every key part of the diagram
${bioSvgGuide}
${statSvgGuide}
${artSvgGuide}
${geoSvgGuide}
${computerSvgGuide}` : `
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
- NEVER wrap a standalone number in $...$, anywhere — prose, bullet points, lists, or conclusions. Write "I = 1", "V = 5" NOT "$1$", "$5$". Only use $...$ when the value appears with variables, operators, or fractions (e.g. $x = 5$, $\\frac{1}{2}$).
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
async function askGroq(keys, { question, className, subject, lang, board, stream, mode }) {
  const sysPrompt = systemPrompt(className, subject, lang, board, stream, mode);
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
          max_tokens:        8192,
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
