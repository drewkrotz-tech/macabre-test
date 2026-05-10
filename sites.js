// sites.js — Sinister Sites endpoints (public list, user submission, admin moderation)
//
// v3 changes from v2:
//   - Reverse-geocoding actually works now. v2 looked at the wrong field
//     in the Census Geocoder response (it expected a "States" array but the
//     geocoder actually returns "Counties" with a FIPS state code). v3
//     reads Counties[0].STATE and maps the FIPS code to the full state
//     name via a fixed lookup table.
//
// v4 changes from v3:
//   - Final 6-category taxonomy locked in: haunting, truecrime, serialkiller,
//     cult, gravesite, film. (Old: haunting, crime, film, historical, cult,
//     disaster, cemetery.) No existing sites used the removed categories so
//     no data migration was needed.
//   - Adds POST /sites/admin/bulk-import for importing batches of sites from
//     curated sources (Wikipedia, Atlas Obscura, etc.). Sites land directly
//     in sites.json (skipping the submissions queue) but are flagged with
//     `imported: true` and `importBatchId` so they can be reviewed, edited,
//     or rolled back via the admin UI.
//   - Imports do NOT require photos. Sites without photos save with
//     photoUrl=null; the app uses a category-default placeholder client-side.
//   - Adds POST /sites/admin/bulk-rollback/:batchId to remove all sites from
//     a single import batch in one shot, used if a source turns out bad.
//   - Adds GET /sites/admin/import-batches that lists all known batch IDs
//     and their site counts, so the admin UI can show batch history.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const multer = require('multer');
const sharp = require('sharp');
const {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');

const {
  R2_ENDPOINT,
  R2_BUCKET,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_PUBLIC_URL,
  ADMIN_TOKEN,
} = process.env;

function assertEnv() {
  const missing = [];
  if (!R2_ENDPOINT) missing.push('R2_ENDPOINT');
  if (!R2_BUCKET) missing.push('R2_BUCKET');
  if (!R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  if (!R2_PUBLIC_URL) missing.push('R2_PUBLIC_URL');
  if (!ADMIN_TOKEN) missing.push('ADMIN_TOKEN');
  if (missing.length) {
    console.error('[sites] Missing required env vars:', missing.join(', '));
    console.error('[sites] Sites endpoints will return 500 until these are set in .env');
  }
}

const r2 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// Data files live next to server.js by default. On Railway, the
// environment sets DREAD_DATA_DIR=/data so the JSON files persist
// across deploys via the mounted volume. Falls back to __dirname for
// local development on the PC where no env var is set.
const DATA_DIR = process.env.DREAD_DATA_DIR || __dirname;
const SITES_PATH = path.join(DATA_DIR, 'sites.json');
const SUBMISSIONS_PATH = path.join(DATA_DIR, 'submissions.json');

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[sites] Failed to parse ${filePath}:`, err.message);
    return fallback;
  }
}

function writeJsonAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function makeId(prefix) {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString('hex');
  return `${prefix}_${ts}_${rand}`;
}

const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const submissionLog = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const recent = (submissionLog.get(ip) || []).filter(t => t > cutoff);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  submissionLog.set(ip, recent);
  return true;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed'));
    }
    cb(null, true);
  },
});

// ---- Categories ----
// Final taxonomy. Order is significant for nothing; alphabetical within
// "type" groups for readability. Server, admin UI, and App.tsx pin renderer
// must all agree on these strings.
const ALLOWED_CATEGORIES = ['haunting', 'truecrime', 'serialkiller', 'cult', 'gravesite', 'film'];

function validateSubmission(meta) {
  const errors = [];
  if (!meta.title || typeof meta.title !== 'string' || meta.title.length < 3 || meta.title.length > 120) {
    errors.push('title must be 3-120 chars');
  }
  if (!meta.shortDescription || typeof meta.shortDescription !== 'string' || meta.shortDescription.length < 10 || meta.shortDescription.length > 200) {
    errors.push('shortDescription must be 10-200 chars');
  }
  if (!meta.fullDescription || typeof meta.fullDescription !== 'string' || meta.fullDescription.length < 20 || meta.fullDescription.length > 5000) {
    errors.push('fullDescription must be 20-5000 chars');
  }
  if (!ALLOWED_CATEGORIES.includes(meta.category)) {
    errors.push(`category must be one of: ${ALLOWED_CATEGORIES.join(', ')}`);
  }
  const lat = Number(meta.lat), lng = Number(meta.lng);
  if (!isFinite(lat) || lat < -90 || lat > 90) errors.push('lat must be a valid latitude');
  if (!isFinite(lng) || lng < -180 || lng > 180) errors.push('lng must be a valid longitude');
  if (!meta.submitter || typeof meta.submitter !== 'string' || meta.submitter.length < 2 || meta.submitter.length > 30) {
    errors.push('submitter (handle) must be 2-30 chars');
  }
  if (meta.captureLat !== undefined || meta.captureLng !== undefined) {
    const cLat = Number(meta.captureLat), cLng = Number(meta.captureLng);
    if (!isFinite(cLat) || cLat < -90 || cLat > 90) errors.push('captureLat invalid');
    if (!isFinite(cLng) || cLng < -180 || cLng > 180) errors.push('captureLng invalid');
  }
  return errors;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const VERIFY_RADIUS_M = 200;

// Dedupe radius for bulk imports. If an incoming site is within this many
// meters of an existing site AND has a similar title, we skip it. 250m is
// loose enough to catch the same building geocoded slightly differently
// from two sources, tight enough not to merge two genuinely different
// haunted houses on the same block.
const IMPORT_DEDUPE_RADIUS_M = 250;

// FIPS state code -> full state name. The Census Geocoder returns county data
// with a 2-digit FIPS state code; we map that to the human-readable name.
const FIPS_STATE_NAMES = {
  '01': 'Alabama', '02': 'Alaska', '04': 'Arizona',
  '05': 'Arkansas', '06': 'California', '08': 'Colorado',
  '09': 'Connecticut', '10': 'Delaware', '11': 'District of Columbia',
  '12': 'Florida', '13': 'Georgia', '15': 'Hawaii',
  '16': 'Idaho', '17': 'Illinois', '18': 'Indiana',
  '19': 'Iowa', '20': 'Kansas', '21': 'Kentucky',
  '22': 'Louisiana', '23': 'Maine', '24': 'Maryland',
  '25': 'Massachusetts', '26': 'Michigan', '27': 'Minnesota',
  '28': 'Mississippi', '29': 'Missouri', '30': 'Montana',
  '31': 'Nebraska', '32': 'Nevada', '33': 'New Hampshire',
  '34': 'New Jersey', '35': 'New Mexico', '36': 'New York',
  '37': 'North Carolina', '38': 'North Dakota', '39': 'Ohio',
  '40': 'Oklahoma', '41': 'Oregon', '42': 'Pennsylvania',
  '44': 'Rhode Island', '45': 'South Carolina', '46': 'South Dakota',
  '47': 'Tennessee', '48': 'Texas', '49': 'Utah',
  '50': 'Vermont', '51': 'Virginia', '53': 'Washington',
  '54': 'West Virginia', '55': 'Wisconsin', '56': 'Wyoming',
  '60': 'American Samoa', '66': 'Guam', '69': 'Northern Mariana Islands',
  '72': 'Puerto Rico', '78': 'US Virgin Islands',
};

// Reverse geocode lat/lng to a US state name. Uses Census Geocoder layer 82
// (counties) which returns Counties[0].STATE as a 2-digit FIPS code. We map
// to the full name via FIPS_STATE_NAMES. Returns null on any failure.
function reverseGeocodeState(lat, lng) {
  return new Promise((resolve) => {
    const url =
      'https://geocoding.geo.census.gov/geocoder/geographies/coordinates' +
      `?x=${encodeURIComponent(lng)}&y=${encodeURIComponent(lat)}` +
      '&benchmark=Public_AR_Current&vintage=Current_Current&layers=82&format=json';

    const req = https.get(url, { timeout: 6000 }, (res) => {
      if (res.statusCode !== 200) {
        console.warn(`[sites] geocoder returned status ${res.statusCode} for (${lat}, ${lng})`);
        res.resume();
        return resolve(null);
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const counties = parsed && parsed.result && parsed.result.geographies && parsed.result.geographies.Counties;
          if (Array.isArray(counties) && counties.length > 0) {
            const fips = counties[0].STATE;
            const name = FIPS_STATE_NAMES[fips];
            if (name) return resolve(name);
            console.warn(`[sites] unknown FIPS code "${fips}" for (${lat}, ${lng})`);
          }
          resolve(null);
        } catch (err) {
          console.warn('[sites] geocoder response parse failed:', err.message);
          resolve(null);
        }
      });
    });

    req.on('error', (err) => {
      console.warn('[sites] geocoder request failed:', err.message);
      resolve(null);
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function processPhoto(buffer) {
  return sharp(buffer)
    .rotate()
    .resize({ width: 1200, withoutEnlargement: true })
    .jpeg({ quality: 80, mozjpeg: true })
    .withMetadata({ exif: {}, icc: undefined })
    .toBuffer();
}

async function r2Put(key, buffer, contentType) {
  await r2.send(new PutObjectCommand({
    Bucket: R2_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000, immutable',
  }));
}

async function r2Copy(fromKey, toKey) {
  await r2.send(new CopyObjectCommand({
    Bucket: R2_BUCKET,
    CopySource: `${R2_BUCKET}/${fromKey}`,
    Key: toKey,
    CacheControl: 'public, max-age=31536000, immutable',
    MetadataDirective: 'REPLACE',
  }));
}

async function r2Delete(key) {
  await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
}

function requireAdmin(req, res, next) {
  const auth = req.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !ADMIN_TOKEN || token.length !== ADMIN_TOKEN.length ||
      !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(ADMIN_TOKEN))) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ---------- Bulk import helpers ----------
//
// Normalize Levenshtein-style fuzzy matching for dedupe. Both strings are
// lowercased, stripped of punctuation, and collapsed whitespace before
// comparison. Returns true if titles look "the same enough" to be the same
// place. Used together with proximity check (within IMPORT_DEDUPE_RADIUS_M)
// to flag duplicates during bulk import.
function normalizeTitleForCompare(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeSameTitle(a, b) {
  const na = normalizeTitleForCompare(a);
  const nb = normalizeTitleForCompare(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // One is a prefix/substring of the other (covers "Cavalier Hotel" vs
  // "The Cavalier Hotel" or "Cavalier Hotel — Virginia Beach").
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

// Validate a single record from a bulk import payload. Returns array of
// error strings; empty array means valid. Stricter than validateSubmission
// in some places (no captureLat/Lng, no IP rate limiting) and looser in
// others (description length minimums relaxed since some Wikipedia stubs
// are short, no submitter required because we set it server-side).
function validateImportRecord(rec) {
  const errors = [];
  if (!rec.title || typeof rec.title !== 'string' || rec.title.length < 3 || rec.title.length > 120) {
    errors.push('title must be 3-120 chars');
  }
  // Allow shorter descriptions on import; some sources have terse stubs.
  if (rec.shortDescription !== undefined && rec.shortDescription !== null) {
    if (typeof rec.shortDescription !== 'string' || rec.shortDescription.length > 200) {
      errors.push('shortDescription must be a string up to 200 chars');
    }
  }
  if (rec.fullDescription !== undefined && rec.fullDescription !== null) {
    if (typeof rec.fullDescription !== 'string' || rec.fullDescription.length > 5000) {
      errors.push('fullDescription must be a string up to 5000 chars');
    }
  }
  if (!ALLOWED_CATEGORIES.includes(rec.category)) {
    errors.push(`category must be one of: ${ALLOWED_CATEGORIES.join(', ')}`);
  }
  // Coords required. Geocoding from address happens upstream (in the
  // scraper script), not here — the server is intentionally simple.
  const lat = rec.coords && Number(rec.coords.lat);
  const lng = rec.coords && Number(rec.coords.lng);
  if (!isFinite(lat) || lat < -90 || lat > 90) errors.push('coords.lat must be a valid latitude');
  if (!isFinite(lng) || lng < -180 || lng > 180) errors.push('coords.lng must be a valid longitude');
  if (rec.sourceUrl !== undefined && rec.sourceUrl !== null) {
    if (typeof rec.sourceUrl !== 'string' || rec.sourceUrl.length > 500) {
      errors.push('sourceUrl must be a string up to 500 chars');
    }
  }
  return errors;
}

// Auto-generate shortDescription from fullDescription when missing. Takes
// roughly the first 60 words and trims to under 200 chars (matches existing
// validation). Returns the full description verbatim if it's already short.
function autoShortDescription(full) {
  if (!full) return '';
  const trimmed = full.trim();
  if (trimmed.length <= 200) return trimmed;
  const words = trimmed.split(/\s+/).slice(0, 60).join(' ');
  if (words.length <= 200) return words;
  return words.slice(0, 197).trimEnd() + '…';
}

function attach(app) {
  assertEnv();

  // Need JSON body parsing for the bulk import endpoint (and the future
  // edit endpoints already use multipart so this doesn't conflict). Mount
  // it inline rather than globally so we don't accidentally affect the
  // multer-handled multipart routes.
  const jsonParser = require('express').json({ limit: '20mb' });

  app.get('/sites', (req, res) => {
    try {
      const store = readJsonSafe(SITES_PATH, { sites: [], updatedAt: null });
      res.json({
        count: store.sites.length,
        updatedAt: store.updatedAt,
        sites: store.sites,
      });
    } catch (err) {
      console.error('[sites] GET /sites failed:', err.message);
      res.status(500).json({ error: 'Failed to load sites' });
    }
  });

  app.post('/sites/submit', upload.single('photo'), async (req, res) => {
    try {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      if (!checkRateLimit(ip)) {
        return res.status(429).json({ error: 'Rate limit exceeded — try again tomorrow' });
      }

      if (!req.file) return res.status(400).json({ error: 'photo file is required' });

      const meta = {
        title: req.body.title,
        shortDescription: req.body.shortDescription,
        fullDescription: req.body.fullDescription,
        category: req.body.category,
        lat: req.body.lat,
        lng: req.body.lng,
        submitter: req.body.submitter,
        captureLat: req.body.captureLat,
        captureLng: req.body.captureLng,
      };
      const errors = validateSubmission(meta);
      if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

      let verified = false;
      if (meta.captureLat !== undefined && meta.captureLng !== undefined) {
        const d = distanceMeters(
          Number(meta.captureLat), Number(meta.captureLng),
          Number(meta.lat), Number(meta.lng)
        );
        verified = d <= VERIFY_RADIUS_M;
      }

      const state = (await reverseGeocodeState(Number(meta.lat), Number(meta.lng))) || 'Unknown';
      console.log(`[sites] reverse-geocoded (${meta.lat}, ${meta.lng}) -> ${state}`);

      const submissionId = makeId('sub');
      const r2Key = `pending/${submissionId}.jpg`;
      const processed = await processPhoto(req.file.buffer);
      await r2Put(r2Key, processed, 'image/jpeg');

      const submission = {
        id: submissionId,
        status: 'pending',
        title: meta.title.trim(),
        shortDescription: meta.shortDescription.trim(),
        fullDescription: meta.fullDescription.trim(),
        category: meta.category,
        state,
        coords: { lat: Number(meta.lat), lng: Number(meta.lng) },
        captureCoords: meta.captureLat !== undefined
          ? { lat: Number(meta.captureLat), lng: Number(meta.captureLng) }
          : null,
        verified,
        submitter: meta.submitter.trim(),
        submitterIp: ip,
        photoR2Key: r2Key,
        submittedAt: new Date().toISOString(),
        approvedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        siteId: null,
      };

      const store = readJsonSafe(SUBMISSIONS_PATH, { submissions: [] });
      store.submissions.push(submission);
      writeJsonAtomic(SUBMISSIONS_PATH, store);

      res.json({
        ok: true,
        submissionId,
        verified,
        state,
        message: 'Submission received and queued for review',
      });
    } catch (err) {
      console.error('[sites] POST /sites/submit failed:', err.message);
      res.status(500).json({ error: 'Submission failed' });
    }
  });

  app.get('/sites/admin/queue', requireAdmin, (req, res) => {
    const store = readJsonSafe(SUBMISSIONS_PATH, { submissions: [] });
    const pending = store.submissions
      .filter(s => s.status === 'pending')
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))
      .map(s => ({
        ...s,
        photoUrl: `${R2_PUBLIC_URL}/${s.photoR2Key}`,
      }));
    res.json({ count: pending.length, pending });
  });

  app.post('/sites/admin/approve/:id', requireAdmin, async (req, res) => {
    try {
      const submissions = readJsonSafe(SUBMISSIONS_PATH, { submissions: [] });
      const sub = submissions.submissions.find(s => s.id === req.params.id);
      if (!sub) return res.status(404).json({ error: 'Submission not found' });
      if (sub.status !== 'pending') {
        return res.status(409).json({ error: `Submission is already ${sub.status}` });
      }

      const overrideState = req.body && typeof req.body.state === 'string' ? req.body.state.trim() : null;
      const finalState = overrideState || sub.state || 'Unknown';

      const siteId = makeId('site');
      const sitesKey = `sites/${siteId}.jpg`;

      await r2Copy(sub.photoR2Key, sitesKey);

      const siteRecord = {
        id: siteId,
        title: sub.title,
        shortDescription: sub.shortDescription,
        fullDescription: sub.fullDescription,
        category: sub.category,
        state: finalState,
        coords: sub.coords,
        photoUrl: `${R2_PUBLIC_URL}/${sitesKey}`,
        submitter: sub.submitter,
        verified: sub.verified,
        approvedAt: new Date().toISOString(),
      };

      const sitesStore = readJsonSafe(SITES_PATH, { sites: [], updatedAt: null });
      sitesStore.sites.push(siteRecord);
      sitesStore.updatedAt = new Date().toISOString();
      writeJsonAtomic(SITES_PATH, sitesStore);

      sub.status = 'approved';
      sub.approvedAt = siteRecord.approvedAt;
      sub.siteId = siteId;
      sub.state = finalState;
      writeJsonAtomic(SUBMISSIONS_PATH, submissions);

      try {
        await r2Delete(sub.photoR2Key);
      } catch (cleanupErr) {
        console.error(`[sites] Failed to delete ${sub.photoR2Key} after approval:`, cleanupErr.message);
      }

      res.json({ ok: true, siteId, site: siteRecord });
    } catch (err) {
      console.error('[sites] approve failed:', err.message);
      res.status(500).json({ error: 'Approval failed' });
    }
  });

  app.post('/sites/admin/reject/:id', requireAdmin, async (req, res) => {
    try {
      const submissions = readJsonSafe(SUBMISSIONS_PATH, { submissions: [] });
      const sub = submissions.submissions.find(s => s.id === req.params.id);
      if (!sub) return res.status(404).json({ error: 'Submission not found' });
      if (sub.status !== 'pending') {
        return res.status(409).json({ error: `Submission is already ${sub.status}` });
      }

      const reason = (req.body && req.body.reason) || null;

      try {
        await r2Delete(sub.photoR2Key);
      } catch (delErr) {
        console.error(`[sites] R2 delete during reject failed for ${sub.photoR2Key}:`, delErr.message);
      }

      sub.status = 'rejected';
      sub.rejectedAt = new Date().toISOString();
      sub.rejectionReason = reason;
      writeJsonAtomic(SUBMISSIONS_PATH, submissions);

      res.json({ ok: true, submissionId: sub.id });
    } catch (err) {
      console.error('[sites] reject failed:', err.message);
      res.status(500).json({ error: 'Rejection failed' });
    }
  });

  // Permanently remove an already-approved site from the public catalog.
  // Different from /reject (which acts on pending submissions): this hits
  // sites.json directly. Used to clean up test entries, take down sites
  // that turn out to be wrong/closed/duplicated, etc.
  // The R2 photo at sites/{id}.jpg is best-effort deleted; if R2 fails the
  // site record is still removed so the catalog stays consistent.
  app.post('/sites/admin/delete/:id', requireAdmin, async (req, res) => {
    try {
      const sitesStore = readJsonSafe(SITES_PATH, { sites: [], updatedAt: null });
      const idx = sitesStore.sites.findIndex(s => s.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Site not found' });

      const removed = sitesStore.sites[idx];
      sitesStore.sites.splice(idx, 1);
      sitesStore.updatedAt = new Date().toISOString();
      writeJsonAtomic(SITES_PATH, sitesStore);

      // Best-effort R2 cleanup. Approved sites live at sites/{id}.jpg per the
      // approve handler; trust that convention rather than re-parsing photoUrl.
      // For imported sites without photos, this delete will 404 silently — fine.
      const r2Key = `sites/${removed.id}.jpg`;
      try {
        await r2Delete(r2Key);
      } catch (delErr) {
        console.error(`[sites] R2 delete during admin delete failed for ${r2Key}:`, delErr.message);
      }

      res.json({ ok: true, siteId: removed.id });
    } catch (err) {
      console.error('[sites] delete failed:', err.message);
      res.status(500).json({ error: 'Delete failed' });
    }
  });

  // Shared validator for the editable text fields. Mirrors the rules in
  // validateSubmission but only checks fields the admin is allowed to change
  // via these edit endpoints. coords/state/submitter intentionally excluded.
  function validateEditFields(meta) {
    const errors = [];
    if (meta.title !== undefined) {
      if (typeof meta.title !== 'string' || meta.title.length < 3 || meta.title.length > 120) {
        errors.push('title must be 3-120 chars');
      }
    }
    if (meta.shortDescription !== undefined) {
      if (typeof meta.shortDescription !== 'string' || meta.shortDescription.length < 10 || meta.shortDescription.length > 200) {
        errors.push('shortDescription must be 10-200 chars');
      }
    }
    if (meta.fullDescription !== undefined) {
      if (typeof meta.fullDescription !== 'string' || meta.fullDescription.length < 20 || meta.fullDescription.length > 5000) {
        errors.push('fullDescription must be 20-5000 chars');
      }
    }
    if (meta.category !== undefined && !ALLOWED_CATEGORIES.includes(meta.category)) {
      errors.push(`category must be one of: ${ALLOWED_CATEGORIES.join(', ')}`);
    }
    return errors;
  }

  // Edit a pending submission. Admin-only. Multipart so a fresh photo can be
  // uploaded along with text fields (photo field is optional). Replaces the
  // existing R2 object at pending/{subId}.jpg in place when a photo is sent.
  app.post('/sites/admin/edit-submission/:id', requireAdmin, upload.single('photo'), async (req, res) => {
    try {
      const submissions = readJsonSafe(SUBMISSIONS_PATH, { submissions: [] });
      const sub = submissions.submissions.find(s => s.id === req.params.id);
      if (!sub) return res.status(404).json({ error: 'Submission not found' });
      if (sub.status !== 'pending') {
        return res.status(409).json({ error: `Submission is already ${sub.status}` });
      }

      const meta = {
        title: req.body.title,
        shortDescription: req.body.shortDescription,
        fullDescription: req.body.fullDescription,
        category: req.body.category,
      };
      const errors = validateEditFields(meta);
      if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

      if (meta.title !== undefined) sub.title = meta.title.trim();
      if (meta.shortDescription !== undefined) sub.shortDescription = meta.shortDescription.trim();
      if (meta.fullDescription !== undefined) sub.fullDescription = meta.fullDescription.trim();
      if (meta.category !== undefined) sub.category = meta.category;

      if (req.file) {
        // Same R2 key — overwrite in place. processPhoto strips EXIF and
        // re-encodes as JPEG, so anything the admin uploads gets normalized.
        const processed = await processPhoto(req.file.buffer);
        await r2Put(sub.photoR2Key, processed, 'image/jpeg');
      }

      sub.editedAt = new Date().toISOString();
      writeJsonAtomic(SUBMISSIONS_PATH, submissions);

      res.json({ ok: true, submissionId: sub.id, photoReplaced: !!req.file });
    } catch (err) {
      console.error('[sites] edit-submission failed:', err.message);
      res.status(500).json({ error: 'Edit failed' });
    }
  });

  // Edit an already-approved site in the live catalog. Admin-only. Same shape
  // as edit-submission but writes to sites.json. When a new photo is uploaded
  // we replace the R2 object at sites/{siteId}.jpg in place AND update the
  // photoUrl with a cache-busting ?v=timestamp so phones/CDN see the new
  // image immediately instead of holding on to the old cached version.
  app.post('/sites/admin/edit-site/:id', requireAdmin, upload.single('photo'), async (req, res) => {
    try {
      const sitesStore = readJsonSafe(SITES_PATH, { sites: [], updatedAt: null });
      const site = sitesStore.sites.find(s => s.id === req.params.id);
      if (!site) return res.status(404).json({ error: 'Site not found' });

      const meta = {
        title: req.body.title,
        shortDescription: req.body.shortDescription,
        fullDescription: req.body.fullDescription,
        category: req.body.category,
      };
      const errors = validateEditFields(meta);
      if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });

      if (meta.title !== undefined) site.title = meta.title.trim();
      if (meta.shortDescription !== undefined) site.shortDescription = meta.shortDescription.trim();
      if (meta.fullDescription !== undefined) site.fullDescription = meta.fullDescription.trim();
      if (meta.category !== undefined) site.category = meta.category;

      if (req.file) {
        const r2Key = `sites/${site.id}.jpg`;
        const processed = await processPhoto(req.file.buffer);
        await r2Put(r2Key, processed, 'image/jpeg');
        // Bust the cache by parameterizing the URL. Strip any prior ?v= first
        // so we don't accumulate query-string crud.
        const baseUrl = `${R2_PUBLIC_URL}/${r2Key}`;
        site.photoUrl = `${baseUrl}?v=${Date.now()}`;
      }

      site.editedAt = new Date().toISOString();
      sitesStore.updatedAt = new Date().toISOString();
      writeJsonAtomic(SITES_PATH, sitesStore);

      res.json({ ok: true, siteId: site.id, photoReplaced: !!req.file });
    } catch (err) {
      console.error('[sites] edit-site failed:', err.message);
      res.status(500).json({ error: 'Edit failed' });
    }
  });

  // ---------- Bulk import ----------
  //
  // POST /sites/admin/bulk-import
  // Body: {
  //   batchId: "wikipedia_haunted_va_2026_05_10",   // required, used for rollback
  //   source: "wikipedia",                          // required, freeform label
  //   sites: [
  //     {
  //       title: "...",                             // required
  //       fullDescription: "...",                   // required-ish (defaults to title)
  //       shortDescription: "...",                  // optional, auto-generated if missing
  //       category: "haunting",                     // required, must be in ALLOWED_CATEGORIES
  //       coords: { lat: ..., lng: ... },           // required
  //       state: "Virginia",                        // optional, reverse-geocoded if missing
  //       sourceUrl: "https://en.wikipedia.org/...", // optional but recommended
  //       photoUrl: null                            // optional; null -> client uses category fallback
  //     },
  //     ...
  //   ]
  // }
  //
  // Sites land directly in sites.json with imported=true and importBatchId set.
  // This bypasses the submissions queue entirely — the assumption is that
  // batches are pre-curated by you and reviewed in the admin UI's Approved
  // tab after the fact. Use bulk-rollback if a whole batch turns out bad.
  //
  // Returns: per-site results (imported / skipped reasons) so the admin UI
  // can display a clear summary.
  app.post('/sites/admin/bulk-import', requireAdmin, jsonParser, async (req, res) => {
    try {
      const body = req.body || {};
      const batchId = typeof body.batchId === 'string' ? body.batchId.trim() : '';
      const source = typeof body.source === 'string' ? body.source.trim() : '';
      const incoming = Array.isArray(body.sites) ? body.sites : null;

      if (!batchId || batchId.length < 3 || batchId.length > 80) {
        return res.status(400).json({ error: 'batchId is required (3-80 chars)' });
      }
      if (!source || source.length > 80) {
        return res.status(400).json({ error: 'source is required (up to 80 chars)' });
      }
      if (!incoming) {
        return res.status(400).json({ error: 'sites must be an array' });
      }
      if (incoming.length === 0) {
        return res.status(400).json({ error: 'sites array is empty' });
      }
      if (incoming.length > 1000) {
        return res.status(400).json({ error: 'batches are limited to 1000 sites; split into multiple imports' });
      }

      const sitesStore = readJsonSafe(SITES_PATH, { sites: [], updatedAt: null });

      // Reject re-using a batch ID that already exists. Different batches
      // should have different IDs so rollback is unambiguous.
      const existingBatch = sitesStore.sites.some(s => s.importBatchId === batchId);
      if (existingBatch) {
        return res.status(409).json({
          error: `batchId "${batchId}" already exists. Use a unique batchId or roll back the previous batch first.`,
        });
      }

      const results = {
        batchId,
        source,
        imported: [],
        skipped: [],
      };

      // Track in-batch dedupe too so the same site appearing twice in one
      // payload doesn't get imported twice.
      const inBatchSeen = [];

      for (let i = 0; i < incoming.length; i++) {
        const rec = incoming[i] || {};
        const idx = i;

        // Coerce/default the description fields before validation so partial
        // data from scrapers is acceptable.
        const fullDescription = (rec.fullDescription && String(rec.fullDescription).trim()) || (rec.shortDescription && String(rec.shortDescription).trim()) || (rec.title && `${String(rec.title).trim()} — pending lore.`) || '';
        const shortDescription = (rec.shortDescription && String(rec.shortDescription).trim()) || autoShortDescription(fullDescription);

        const candidate = {
          title: rec.title && String(rec.title).trim(),
          shortDescription,
          fullDescription,
          category: rec.category,
          coords: rec.coords && {
            lat: Number(rec.coords.lat),
            lng: Number(rec.coords.lng),
          },
          state: rec.state && String(rec.state).trim(),
          sourceUrl: rec.sourceUrl && String(rec.sourceUrl).trim(),
          photoUrl: typeof rec.photoUrl === 'string' && rec.photoUrl.trim() ? rec.photoUrl.trim() : null,
        };

        const errors = validateImportRecord(candidate);
        if (errors.length) {
          results.skipped.push({ index: idx, title: candidate.title || '(untitled)', reason: 'validation', details: errors });
          continue;
        }

        // Dedupe vs already-stored sites.
        let dup = null;
        for (const existing of sitesStore.sites) {
          if (!existing.coords) continue;
          const d = distanceMeters(
            candidate.coords.lat, candidate.coords.lng,
            existing.coords.lat, existing.coords.lng
          );
          if (d <= IMPORT_DEDUPE_RADIUS_M && looksLikeSameTitle(candidate.title, existing.title)) {
            dup = { id: existing.id, title: existing.title, distance: Math.round(d) };
            break;
          }
        }
        if (dup) {
          results.skipped.push({ index: idx, title: candidate.title, reason: 'duplicate', existing: dup });
          continue;
        }

        // Dedupe vs others in the same batch.
        let inBatchDup = null;
        for (const prev of inBatchSeen) {
          const d = distanceMeters(
            candidate.coords.lat, candidate.coords.lng,
            prev.coords.lat, prev.coords.lng
          );
          if (d <= IMPORT_DEDUPE_RADIUS_M && looksLikeSameTitle(candidate.title, prev.title)) {
            inBatchDup = { title: prev.title };
            break;
          }
        }
        if (inBatchDup) {
          results.skipped.push({ index: idx, title: candidate.title, reason: 'duplicate-in-batch', existing: inBatchDup });
          continue;
        }

        // Resolve state. If the payload provided one, trust it (the scraper
        // already did the work). Otherwise call the Census Geocoder.
        let finalState = candidate.state;
        if (!finalState) {
          finalState = await reverseGeocodeState(candidate.coords.lat, candidate.coords.lng);
          if (!finalState) finalState = 'Unknown';
        }

        const siteId = makeId('site');
        const siteRecord = {
          id: siteId,
          title: candidate.title,
          shortDescription: candidate.shortDescription,
          fullDescription: candidate.fullDescription,
          category: candidate.category,
          state: finalState,
          coords: candidate.coords,
          photoUrl: candidate.photoUrl, // null when no photo provided
          submitter: 'import',
          verified: false,
          approvedAt: new Date().toISOString(),
          imported: true,
          importBatchId: batchId,
          source,
          sourceUrl: candidate.sourceUrl || null,
        };

        sitesStore.sites.push(siteRecord);
        inBatchSeen.push({
          title: candidate.title,
          coords: candidate.coords,
        });
        results.imported.push({ index: idx, id: siteId, title: candidate.title, state: finalState });
      }

      sitesStore.updatedAt = new Date().toISOString();
      writeJsonAtomic(SITES_PATH, sitesStore);

      console.log(`[sites] bulk-import batch="${batchId}" source="${source}" imported=${results.imported.length} skipped=${results.skipped.length}`);

      res.json({
        ok: true,
        batchId,
        source,
        importedCount: results.imported.length,
        skippedCount: results.skipped.length,
        imported: results.imported,
        skipped: results.skipped,
      });
    } catch (err) {
      console.error('[sites] bulk-import failed:', err.message);
      res.status(500).json({ error: 'Bulk import failed', detail: err.message });
    }
  });

  // List all known import batches with counts. Used by the admin UI to show
  // batch history and offer rollback. Returns batches sorted newest-first by
  // most recent site approvedAt within each batch.
  app.get('/sites/admin/import-batches', requireAdmin, (req, res) => {
    try {
      const sitesStore = readJsonSafe(SITES_PATH, { sites: [], updatedAt: null });
      const batchMap = new Map();
      for (const s of sitesStore.sites) {
        if (!s.importBatchId) continue;
        const entry = batchMap.get(s.importBatchId) || {
          batchId: s.importBatchId,
          source: s.source || null,
          count: 0,
          firstApprovedAt: null,
          lastApprovedAt: null,
        };
        entry.count += 1;
        if (!entry.firstApprovedAt || (s.approvedAt && s.approvedAt < entry.firstApprovedAt)) {
          entry.firstApprovedAt = s.approvedAt || entry.firstApprovedAt;
        }
        if (!entry.lastApprovedAt || (s.approvedAt && s.approvedAt > entry.lastApprovedAt)) {
          entry.lastApprovedAt = s.approvedAt || entry.lastApprovedAt;
        }
        batchMap.set(s.importBatchId, entry);
      }
      const batches = Array.from(batchMap.values()).sort((a, b) => {
        const at = a.lastApprovedAt || '';
        const bt = b.lastApprovedAt || '';
        return bt.localeCompare(at);
      });
      res.json({ count: batches.length, batches });
    } catch (err) {
      console.error('[sites] import-batches failed:', err.message);
      res.status(500).json({ error: 'Failed to list batches' });
    }
  });

  // Roll back an entire import batch. Removes every site with the given
  // importBatchId from sites.json. R2 photo deletes are skipped because
  // bulk imports don't upload photos in the first place. Returns the
  // count of removed sites.
  app.post('/sites/admin/bulk-rollback/:batchId', requireAdmin, async (req, res) => {
    try {
      const batchId = req.params.batchId;
      if (!batchId || batchId.length > 80) {
        return res.status(400).json({ error: 'invalid batchId' });
      }
      const sitesStore = readJsonSafe(SITES_PATH, { sites: [], updatedAt: null });
      const before = sitesStore.sites.length;
      const removed = [];
      sitesStore.sites = sitesStore.sites.filter(s => {
        if (s.importBatchId === batchId) {
          removed.push({ id: s.id, title: s.title });
          return false;
        }
        return true;
      });
      const after = sitesStore.sites.length;
      sitesStore.updatedAt = new Date().toISOString();
      writeJsonAtomic(SITES_PATH, sitesStore);
      console.log(`[sites] bulk-rollback batch="${batchId}" removed=${before - after}`);
      res.json({ ok: true, batchId, removedCount: before - after, removed });
    } catch (err) {
      console.error('[sites] bulk-rollback failed:', err.message);
      res.status(500).json({ error: 'Rollback failed' });
    }
  });

  console.log('[sites] Sinister Sites endpoints attached (v4 — 6-category taxonomy + bulk import)');
}

module.exports = { attach };
