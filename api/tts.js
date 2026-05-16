/**
 * StudyLens AI — Premium TTS API
 * Vercel Serverless Function: /api/tts
 *
 * Uses Google Cloud Text-to-Speech (Neural2 voices — premium quality)
 * Returns MP3 audio + per-word timestamps for karaoke highlighting.
 *
 * ── SETUP ─────────────────────────────────────────────────────────────────────
 * 1. Go to console.cloud.google.com
 * 2. Enable "Cloud Text-to-Speech API"
 * 3. Go to APIs & Services → Credentials → Create API Key
 * 4. In Vercel: Settings → Environment Variables → Add GOOGLE_TTS_KEY
 *
 * ── VOICES USED ───────────────────────────────────────────────────────────────
 *  en → en-IN-Neural2-A  (Indian English, female, ultra-clear)
 *  hi → hi-IN-Neural2-A  (Hindi, female, natural)
 *  bn → bn-IN-Wavenet-A  (Bengali, female, best available)
 *  as → as-IN-Standard-A (Assamese, standard — Neural2 not yet available)
 *
 * ── FREE TIER ─────────────────────────────────────────────────────────────────
 *  Standard voices : 4,000,000 chars/month free
 *  WaveNet voices  : 1,000,000 chars/month free
 *  Neural2 voices  : 1,000,000 chars/month free
 *  (Reset every calendar month)
 */

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

// ── Voice map per language ────────────────────────────────────────────────────
const VOICE_MAP = {
  en: { languageCode: 'en-IN', name: 'en-IN-Neural2-A' },
  hi: { languageCode: 'hi-IN', name: 'hi-IN-Neural2-A' },
  bn: { languageCode: 'bn-IN', name: 'bn-IN-Wavenet-A'  },
  as: { languageCode: 'as-IN', name: 'as-IN-Standard-A' },
};

// ── CORS headers ──────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Strip markdown so the voice reads clean text ──────────────────────────────
function cleanForSpeech(text) {
  return text
    .replace(/\*\*(.*?)\*\*/g, '$1')   // bold
    .replace(/\*(.*?)\*/g,     '$1')   // italic
    .replace(/#{1,6}\s/g,      '')     // headings
    .replace(/`{1,3}[^`]*`{1,3}/g,    '') // code
    .replace(/💡|🔹|🔸|•/g,   '. ')  // emoji → pause
    .replace(/\n{2,}/g,        '. ')  // paragraph breaks → pause
    .replace(/\n/g,            ' ')   // single newlines
    .replace(/\s{2,}/g,        ' ')   // double spaces
    .trim()
    .slice(0, 4500);                   // safety limit (well within free tier)
}

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { text, lang = 'en' } = req.body || {};

  if (!text?.trim()) {
    return res.status(400).json({ error: 'No text provided' });
  }

  const apiKey = process.env.GOOGLE_TTS_KEY;
  if (!apiKey) {
    // No key configured — tell frontend to use browser fallback
    return res.status(503).json({ error: 'no_key' });
  }

  const voice     = VOICE_MAP[lang] || VOICE_MAP['en'];
  const cleanText = cleanForSpeech(text);

  try {
    const r = await fetch(
      `https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enableWordTimeOffsets: true,   // ← gives us per-word timestamps 🎯
          input: { text: cleanText },
          voice,
          audioConfig: {
            audioEncoding:    'MP3',
            speakingRate:     0.90,      // slightly slower = clearer for students
            pitch:            0.0,
            volumeGainDb:     1.0,
            effectsProfileId: ['headphone-class-device'], // richer sound
          },
        }),
      }
    );

    const data = await r.json();

    if (data.error) {
      console.error('[TTS] Google API error:', data.error);
      return res.status(500).json({ error: data.error.message || 'TTS failed' });
    }

    // ── Map timepoints → [{word, time}] ──────────────────────────────────────
    // Google returns: timepoints[i] = { markName: "3", timeSeconds: 1.25 }
    // markName is the word index in the input text.
    const inputWords = cleanText.split(/\s+/).filter(Boolean);
    const timepoints = data.timepoints || [];

    const words = timepoints
      .map(tp => ({
        word: inputWords[parseInt(tp.markName, 10)] ?? '',
        time: tp.timeSeconds,
      }))
      .filter(w => w.word.length > 0);

    return res.status(200).json({
      audioBase64: data.audioContent,  // base64 MP3
      words,                           // [{word, time}] for karaoke
    });

  } catch (err) {
    console.error('[TTS] Fetch error:', err.message);
    return res.status(500).json({ error: 'TTS request failed' });
  }
}
