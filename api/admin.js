/**
 * StudyLens AI — Admin API
 * Vercel Serverless Function: /api/admin
 *
 * Endpoints (POST with { action, secret }):
 *   action: 'stats'      → overall usage stats
 *   action: 'users'      → list of all users + activity counts
 *   action: 'history'    → recent questions (paginated)
 *   action: 'images'     → list stored images from Firebase Storage
 *   action: 'kv'         → Upstash KV key rotation state
 *
 * Security: requests must include { secret: process.env.ADMIN_SECRET }
 *
 * Setup:
 *   1. Add ADMIN_SECRET=your_password to Vercel Environment Variables
 *   2. Add FIREBASE_SERVICE_ACCOUNT=<json string> to Vercel Env Vars
 *      (Download from Firebase Console → Project Settings → Service Accounts → Generate new private key)
 *   3. Deploy
 */

export const config = {
  api: { bodyParser: { sizeLimit: '1mb' } },
};

// ── CORS ──────────────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Firestore via REST API (no SDK needed — avoids cold-start size issues) ───
async function firestoreRequest(path, method = 'GET', body = null) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!serviceAccount.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');

  // Get access token via Google OAuth2
  const token = await getFirebaseToken(serviceAccount);
  const projectId = serviceAccount.project_id;
  const baseUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;

  const res = await fetch(`${baseUrl}/${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Firestore error ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Get Firebase access token using service account JWT ──────────────────────
async function getFirebaseToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: sa.client_email,
    sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase',
  };

  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const toSign = `${encode(header)}.${encode(payload)}`;

  // Sign with RS256 using the private key
  const keyData = sa.private_key.replace(/\\n/g, '\n');
  const pemBody = keyData.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const binaryKey = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(toSign)
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

  const jwt = `${toSign}.${sigB64}`;

  // Exchange JWT for access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Could not get Firebase token: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── Parse Firestore document fields into plain JS object ─────────────────────
function parseDoc(doc) {
  if (!doc || !doc.fields) return {};
  const result = {};
  for (const [key, val] of Object.entries(doc.fields)) {
    if (val.stringValue !== undefined)  result[key] = val.stringValue;
    else if (val.integerValue !== undefined) result[key] = parseInt(val.integerValue);
    else if (val.doubleValue !== undefined)  result[key] = val.doubleValue;
    else if (val.booleanValue !== undefined) result[key] = val.booleanValue;
    else if (val.timestampValue !== undefined) result[key] = val.timestampValue;
    else if (val.mapValue !== undefined)   result[key] = parseDoc(val.mapValue);
    else if (val.arrayValue !== undefined) result[key] = (val.arrayValue.values || []).map(v => parseDoc({ fields: { _: v } })._);
    else result[key] = null;
  }
  return result;
}

// ── Get Upstash KV state ──────────────────────────────────────────────────────
async function getKVState() {
  const url   = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  try {
    const res = await fetch(`${url}/get/studylens:rotations`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch (e) {
    return null;
  }
}

// ── Firebase Storage list images ──────────────────────────────────────────────
async function listStorageImages(serviceAccount, maxResults = 50) {
  const token = await getFirebaseToken(serviceAccount);
  const projectId = serviceAccount.project_id;
  // Default bucket name convention for Firebase
  const bucket = `${projectId}.appspot.com`;
  const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o?prefix=question-images/&maxResults=${maxResults}&fields=items(name,timeCreated,size,metadata)`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.items || []).map(item => ({
    name: item.name,
    created: item.timeCreated,
    size: parseInt(item.size),
    uid: item.metadata?.uid || 'unknown',
    subject: item.metadata?.subject || '',
    className: item.metadata?.className || '',
    url: `https://storage.googleapis.com/${bucket}/${item.name}`,
  }));
}

// ── Main Handler ──────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, secret, limit = 50, offset = 0 } = req.body || {};

  // ── Auth check ──
  const adminSecret = process.env.ADMIN_SECRET;
  if (!adminSecret) return res.status(500).json({ error: 'ADMIN_SECRET not set in environment variables.' });
  if (secret !== adminSecret) return res.status(401).json({ error: 'Unauthorized: wrong secret.' });

  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

    switch (action) {

      // ── LIST ALL USERS ─────────────────────────────────────────────────────
      case 'users': {
        const data = await firestoreRequest('users?pageSize=200');
        const users = [];
        for (const doc of (data.documents || [])) {
          const uid = doc.name.split('/').pop();
          // Get history count
          const histData = await firestoreRequest(`users/${uid}/history?pageSize=1`);
          const histCount = histData.documents?.length ?? 0;
          users.push({
            uid,
            historyCount: histCount,
            lastSeen: doc.updateTime,
          });
        }
        return res.status(200).json({ users });
      }

      // ── RECENT HISTORY ACROSS ALL USERS ──────────────────────────────────
      case 'history': {
        // Fetch top-level users collection
        const usersData = await firestoreRequest('users?pageSize=100');
        const allEntries = [];

        for (const userDoc of (usersData.documents || [])) {
          const uid = userDoc.name.split('/').pop();
          try {
            const histData = await firestoreRequest(
              `users/${uid}/history?pageSize=${Math.min(limit, 20)}&orderBy=ts desc`
            );
            for (const doc of (histData.documents || [])) {
              const entry = parseDoc(doc);
              allEntries.push({
                uid,
                id: entry.id,
                ts: entry.ts,
                mode: entry.mode,
                question: (entry.question || '').slice(0, 120),
                subject: entry.subject || '',
                className: entry.className || '',
                answer: (entry.answer || '').slice(0, 200),
                hasImage: entry.imageStorageUrl ? true : false,
                imageUrl: entry.imageStorageUrl || null,
              });
            }
          } catch (_) { /* skip users with no history */ }
        }

        // Sort by timestamp descending
        allEntries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const paginated = allEntries.slice(offset, offset + limit);

        return res.status(200).json({
          total: allEntries.length,
          entries: paginated,
        });
      }

      // ── OVERALL STATS ──────────────────────────────────────────────────────
      case 'stats': {
        const usersData = await firestoreRequest('users?pageSize=200');
        const userDocs = usersData.documents || [];

        let totalQuestions = 0;
        let totalPhotoQ = 0;
        let totalTextQ = 0;
        const subjectCounts = {};
        const classCounts = {};
        const langCounts = {};
        const dailyCounts = {};

        for (const userDoc of userDocs) {
          const uid = userDoc.name.split('/').pop();
          try {
            const histData = await firestoreRequest(`users/${uid}/history?pageSize=500`);
            for (const doc of (histData.documents || [])) {
              const e = parseDoc(doc);
              totalQuestions++;
              if (e.mode === 'photo') totalPhotoQ++;
              else totalTextQ++;

              if (e.subject) subjectCounts[e.subject] = (subjectCounts[e.subject] || 0) + 1;
              if (e.className) classCounts[e.className] = (classCounts[e.className] || 0) + 1;

              // Daily counts by date
              if (e.ts) {
                const day = new Date(e.ts).toISOString().slice(0, 10);
                dailyCounts[day] = (dailyCounts[day] || 0) + 1;
              }
            }
          } catch (_) {}
        }

        // Sort top subjects / classes
        const topSubjects = Object.entries(subjectCounts).sort((a,b)=>b[1]-a[1]).slice(0, 10);
        const topClasses  = Object.entries(classCounts).sort((a,b)=>b[1]-a[1]).slice(0, 10);
        const recentDays  = Object.entries(dailyCounts).sort((a,b)=>a[0]>b[0]?-1:1).slice(0, 14);

        // KV state (API key usage)
        const kvState = await getKVState();

        return res.status(200).json({
          totalUsers: userDocs.length,
          totalQuestions,
          totalPhotoQ,
          totalTextQ,
          topSubjects,
          topClasses,
          recentDays,
          kvState,
        });
      }

      // ── IMAGES IN FIREBASE STORAGE ─────────────────────────────────────────
      case 'images': {
        const images = await listStorageImages(serviceAccount, limit);
        return res.status(200).json({ images });
      }

      // ── KV STATE ──────────────────────────────────────────────────────────
      case 'kv': {
        const kvState = await getKVState();
        return res.status(200).json({ kvState });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }
  } catch (e) {
    console.error('[Admin API Error]', e);
    return res.status(500).json({ error: e.message });
  }
}
