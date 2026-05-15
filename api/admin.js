/**
 * StudyLens AI — Admin API
 * Vercel Serverless Function: /api/admin
 *
 * Endpoints (POST with { action, secret }):
 *   action: 'stats'      → overall usage stats
 *   action: 'users'      → list of all users + activity counts
 *   action: 'history'    → recent questions (paginated)
 *   action: 'images'     → list stored images from Firebase Storage (with signed URLs)
 *   action: 'kv'         → Upstash KV key rotation state
 *
 * Security: requests must include { secret: process.env.ADMIN_SECRET }
 *
 * FIX: images are stored in Firebase Storage with `allow read: if false`.
 *      This backend now generates V4 signed URLs (15-minute expiry) so the
 *      admin browser can load the images without public read access.
 *
 * Setup:
 *   1. Add ADMIN_SECRET=your_password to Vercel Environment Variables
 *   2. Add FIREBASE_SERVICE_ACCOUNT=<json string> to Vercel Env Vars
 *      (Firebase Console → Project Settings → Service Accounts → Generate new private key)
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

// ── Firestore via REST API ────────────────────────────────────────────────────
async function firestoreRequest(path, method = 'GET', body = null) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
  if (!serviceAccount.project_id) throw new Error('FIREBASE_SERVICE_ACCOUNT not configured');

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

// ── Firestore with pagination support ────────────────────────────────────────
// Fetches ALL documents from a collection, following nextPageToken automatically.
async function firestoreRequestAll(basePath, pageSize = 200) {
  const allDocs = [];
  let pageToken = null;

  do {
    const sep = basePath.includes('?') ? '&' : '?';
    const url = basePath + sep + `pageSize=${pageSize}` + (pageToken ? `&pageToken=${pageToken}` : '');
    const data = await firestoreRequest(url);
    const docs = data.documents || [];
    allDocs.push(...docs);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return allDocs;
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
    scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/devstorage.read_only https://www.googleapis.com/auth/firebase',
  };

  const encode = obj => btoa(JSON.stringify(obj)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const toSign = `${encode(header)}.${encode(payload)}`;

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
    if (val.stringValue !== undefined)    result[key] = val.stringValue;
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

// ── Generate a V4 Signed URL for a private Firebase Storage object ─────────────
async function generateSignedUrl(sa, objectName, expiresInSeconds = 900) {
  const bucket       = `${sa.project_id}.appspot.com`;
  const serviceEmail = sa.client_email;
  const privateKey   = sa.private_key.replace(/\\n/g, '\n');

  const now          = new Date();
  const dateStamp    = now.toISOString().replace(/[-:]/g, '').slice(0, 8);
  const dateTimeStamp = now.toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';

  const credentialScope = `${dateStamp}/auto/storage/goog4_request`;
  const credential      = `${serviceEmail}/${credentialScope}`;
  const host            = 'storage.googleapis.com';
  const encodedObject   = objectName.split('/').map(encodeURIComponent).join('/');
  const resourcePath    = `/${bucket}/${encodedObject}`;

  const queryParams = new URLSearchParams({
    'X-Goog-Algorithm':     'GOOG4-RSA-SHA256',
    'X-Goog-Credential':    credential,
    'X-Goog-Date':          dateTimeStamp,
    'X-Goog-Expires':       String(expiresInSeconds),
    'X-Goog-SignedHeaders': 'host',
  });
  const canonicalQueryString = queryParams.toString();

  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders    = 'host';

  const canonicalRequest = [
    'GET',
    resourcePath,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const encoder    = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(canonicalRequest));
  const hashHex    = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  const stringToSign = [
    'GOOG4-RSA-SHA256',
    dateTimeStamp,
    credentialScope,
    hashHex,
  ].join('\n');

  const pemBody   = privateKey.replace(/-----BEGIN PRIVATE KEY-----/, '').replace(/-----END PRIVATE KEY-----/, '').replace(/\s/g, '');
  const binaryKey = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', binaryKey.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    encoder.encode(stringToSign)
  );
  const sigHex = Array.from(new Uint8Array(signature)).map(b => b.toString(16).padStart(2, '0')).join('');

  return `https://${host}${resourcePath}?${canonicalQueryString}&X-Goog-Signature=${sigHex}`;
}

// ── List images from Firebase Storage ────────────────────────────────────────
async function listStorageImages(serviceAccount, maxResults = 60) {
  if (!serviceAccount.project_id) return [];

  const token     = await getFirebaseToken(serviceAccount);
  const projectId = serviceAccount.project_id;
  const bucket    = `${projectId}.appspot.com`;
  const listUrl   = `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o?prefix=question-images/&maxResults=${maxResults}&fields=items(name,timeCreated,size,metadata)`;

  const res = await fetch(listUrl, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];

  const data  = await res.json();
  const items = data.items || [];

  const signedItems = await Promise.all(
    items.map(async item => {
      let signedUrl = null;
      try {
        signedUrl = await generateSignedUrl(serviceAccount, item.name, 900);
      } catch (e) {
        console.warn('[Admin] Could not sign URL for', item.name, e.message);
        signedUrl = `https://storage.googleapis.com/${bucket}/${item.name}`;
      }
      return {
        name:      item.name,
        created:   item.timeCreated,
        size:      parseInt(item.size),
        uid:       item.metadata?.uid       || 'unknown',
        subject:   item.metadata?.subject   || '',
        className: item.metadata?.className || '',
        url:       signedUrl,
      };
    })
  );

  return signedItems;
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
        // Use firestoreRequestAll to paginate through all user documents
        const userDocs = await firestoreRequestAll('users');
        const users = [];
        for (const doc of userDocs) {
          const uid = doc.name.split('/').pop();
          // FIX BUG #4: Use pageSize=200 per user (was 1, so count was always 0 or 1).
          // We intentionally avoid full pagination here to prevent cascading OAuth
          // token calls (one per page x all users) which would time out the function.
          // pageSize=200 gives accurate counts for the vast majority of users.
          let histCount = 0;
          try {
            const histData = await firestoreRequest(`users/${uid}/history?pageSize=200`);
            histCount = histData.documents?.length ?? 0;
          } catch (_) {}
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
        // FIX: use firestoreRequestAll so users beyond the first 200 are included
        const userDocs = await firestoreRequestAll('users');
        const allEntries = [];

        for (const userDoc of userDocs) {
          const uid = userDoc.name.split('/').pop();
          try {
            // FIX: raised per-user cap from 20 → 100 so prolific users don't get
            // silently truncated when building the full activity log
            const histData = await firestoreRequest(
              `users/${uid}/history?pageSize=${Math.min(limit, 100)}&orderBy=ts%20desc`
            );
            for (const doc of (histData.documents || [])) {
              const entry = parseDoc(doc);

              let imageUrl = entry.imageStorageUrl || null;
              if (imageUrl && serviceAccount.project_id) {
                try {
                  const bucket = `${serviceAccount.project_id}.appspot.com`;
                  const prefix = `https://storage.googleapis.com/${bucket}/`;
                  if (imageUrl.startsWith(prefix)) {
                    const objectName = decodeURIComponent(imageUrl.slice(prefix.length));
                    imageUrl = await generateSignedUrl(serviceAccount, objectName, 900);
                  }
                } catch (e) {
                  // Keep original URL as fallback
                }
              }

              allEntries.push({
                uid,
                id:        entry.id,
                ts:        entry.ts,
                mode:      entry.mode,
                question:  (entry.question || '').slice(0, 120),
                subject:   entry.subject   || '',
                className: entry.className || '',
                answer:    (entry.answer   || '').slice(0, 200),
                hasImage:  entry.imageStorageUrl ? true : false,
                imageUrl,
              });
            }
          } catch (_) { /* skip users with no history */ }
        }

        allEntries.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        const paginated = allEntries.slice(offset, offset + limit);

        return res.status(200).json({
          total:   allEntries.length,
          entries: paginated,
        });
      }

      // ── OVERALL STATS ──────────────────────────────────────────────────────
      case 'stats': {
        // FIX: use firestoreRequestAll so stats include every user, not just the first 200
        const userDocs = await firestoreRequestAll('users');

        let totalQuestions = 0;
        let totalPhotoQ    = 0;
        let totalTextQ     = 0;
        const subjectCounts = {};
        const classCounts   = {};
        const dailyCounts   = {};

        for (const userDoc of userDocs) {
          const uid = userDoc.name.split('/').pop();
          try {
            // pageSize=300 is Firestore's hard maximum — anything above is silently capped
            const histData = await firestoreRequest(`users/${uid}/history?pageSize=300`);
            for (const doc of (histData.documents || [])) {
              const e = parseDoc(doc);
              totalQuestions++;
              if (e.mode === 'photo') totalPhotoQ++;
              else totalTextQ++;

              if (e.subject) subjectCounts[e.subject] = (subjectCounts[e.subject] || 0) + 1;
              if (e.className) classCounts[e.className] = (classCounts[e.className] || 0) + 1;

              if (e.ts) {
                const day = new Date(e.ts).toISOString().slice(0, 10);
                dailyCounts[day] = (dailyCounts[day] || 0) + 1;
              }
            }
          } catch (_) {}
        }

        const topSubjects = Object.entries(subjectCounts).sort((a,b)=>b[1]-a[1]).slice(0, 10);
        const topClasses  = Object.entries(classCounts).sort((a,b)=>b[1]-a[1]).slice(0, 10);
        const recentDays  = Object.entries(dailyCounts).sort((a,b)=>a[0]>b[0]?-1:1).slice(0, 14);

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

      // ── IMAGES IN FIREBASE STORAGE (with signed URLs) ─────────────────────
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
