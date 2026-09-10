/**
 * CCloud Enricher — self-hosted enrichment proxy (Render edition)
 * ===============================================================
 * Zero-dependency Node service that:
 *   1. Transparently proxies the original 30nama API (GET /api/*)
 *   2. Injects Rotten Tomatoes scores (🍅 Tomatometer + 🍿 Popcornmeter)
 *      into movie/serie JSON responses via whatson-api
 *
 * Why this exists: Cloudflare Workers egress IPs are blocked by Render,
 * so the enrichment runs HERE (Render → Render is allowed).
 *
 * Contract with the Android app (MovieRepository.parseMovie):
 *   Injects `tomatometer` / `popcornmeter` (0-100 ints) into each item.
 *   Absent fields = no data; the app hides them (no fake data, ever).
 *
 * Cache: in-memory Map with TTL, PERSISTED to a JSON file (survives Render
 *   restarts/deploys so the limited whatson quota is not re-spent). Positive
 *   7 days, definitive misses 24h, transient failures never cached.
 */

const UPSTREAM_HOST = process.env.UPSTREAM_HOST || "https://server-hi-speed-iran.info";
const WHATSON_BASE = process.env.WHATSON_BASE || "https://whatson-api.onrender.com/";
const WHATSON_API_KEY = process.env.WHATSON_API_KEY || "";
const PORT = parseInt(process.env.PORT, 10) || 8081;
const ENRICH_TIMEOUT_MS = parseInt(process.env.ENRICH_TIMEOUT_MS || "15000", 10);
const ENRICH_CONCURRENCY = parseInt(process.env.ENRICH_CONCURRENCY || "8", 10);
const WHATSON_ATTEMPT_TIMEOUT_MS = parseInt(process.env.WHATSON_ATTEMPT_TIMEOUT_MS || "20000", 10);
const SELF_URL = process.env.SELF_URL || "https://ccloud-enricher.onrender.com";
const TMDB_API_BASE = process.env.TMDB_API_BASE || "https://api.themoviedb.org";
const TMDB_IMAGE_BASE = process.env.TMDB_IMAGE_BASE || "https://image.tmdb.org";
const TMDB_TIMEOUT_MS = parseInt(process.env.TMDB_TIMEOUT_MS || "20000", 10);
const SCORE_TTL_MS = 7 * 24 * 3600 * 1000;   // 7 days
const NEGATIVE_TTL_MS = 24 * 3600 * 1000;    // 24 hours
const CACHE_MAX_ENTRIES = 20000;

const ENRICHABLE_PREFIXES = ["/api/movie/", "/api/serie/", "/api/search/", "/api/poster/"];
const LATIN_TITLE_RE = /^[\x20-\x7E]+$/;

/* ─────────────────────────── cache (persistent) ─────────────────────────── */
// In-memory Map persisted to a JSON file, so refreshes/deploys on Render do not
// re-spend the limited whatson quota. Scores remain the single source of truth.

const fs = require("fs");
const path = require("path");
const os = require("os");

const cache = new Map(); // key -> { value: string, expires: number }
const CACHE_FILE =
  process.env.CACHE_FILE || path.join(os.tmpdir(), "ccloud-rt-cache.json");

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function cachePut(key, value, ttlMs) {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop expired entries first; if still full, drop the oldest
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expires) cache.delete(k);
    }
    if (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  cache.set(key, { value, expires: Date.now() + ttlMs });
  scheduleCacheSave();
}

let saveTimer = null;
function scheduleCacheSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCache();
  }, 3000);
}

function saveCache() {
  try {
    const now = Date.now();
    const out = {};
    for (const [k, v] of cache) {
      if (now <= v.expires) out[k] = v;
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(out));
  } catch (e) {
    // Best-effort persistence; never break a request path.
  }
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return;
    const obj = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    const now = Date.now();
    for (const [k, v] of Object.entries(obj)) {
      if (v && v.expires && now <= v.expires) cache.set(k, v);
    }
  } catch (e) {
    // Corrupt cache → start fresh; enrichment will refill it.
  }
}
loadCache();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now > v.expires) cache.delete(k);
  }
}, 10 * 60 * 1000).unref();

/* ─────────────────── whatson quota circuit breaker ─────────────────── */
// On a 429 the keyed quota is exhausted; stop hammering whatson for a cooldown
// window instead of firing one request per remaining catalog item.
const WHATSON_COOLDOWN_MS = parseInt(process.env.WHATSON_COOLDOWN_MS || "600000", 10); // 10 min
let whatsonCooldownUntil = 0;
function whatsonCooling() {
  return Date.now() < whatsonCooldownUntil;
}

/**
 * Keep-alive: Render free services spin down after ~15 min without inbound
 * traffic. Ping ONLY ourselves — the old whatson ping burned keyed quota
 * (~6/h) for no benefit now that the RT cache is persisted.
 */
const KEEPALIVE_MS = 10 * 60 * 1000;
setInterval(() => {
  fetch(`${SELF_URL}/health`).catch(() => {});
}, KEEPALIVE_MS).unref();

/* ─────────────────────────── helpers ─────────────────────────── */

function normTitle(t) {
  return (t || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function passthrough(bodyText) {
  return new Response(bodyText, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/* ─────────────────────────── whatson lookup ─────────────────────────── */

/**
 * Progressive query strategy. whatson's title search is strict (e.g.
 * "dune part two" 404s while "dune: part two" works), so on miss we retry
 * with shorter prefixes and match by normalized title + year.
 *
 * Returns { scores, definitive } — definitive=false (429/5xx/timeout)
 * must NOT be negative-cached by the caller.
 */
/**
 * Builds a whatson URL with the API key passed as the `api_key` query param.
 *
 * IMPORTANT: whatson expects the key as `api_key` (query). The previous
 * implementation sent it as an `X-Api-Key` header, which whatson silently
 * ignores — every request then fell back to the anonymous, per-IP limit
 * (50/h) on Render's shared egress IP, which is almost always exhausted,
 * so /debug/rt returned 429 and NO title ever got RT scores.
 */
function whatsonUrl(params) {
  const qs = params.toString();
  return WHATSON_API_KEY
    ? `${WHATSON_BASE}?${qs}&api_key=${encodeURIComponent(WHATSON_API_KEY)}`
    : `${WHATSON_BASE}?${qs}`;
}

async function fetchRT(title, year, deadline) {
  if (whatsonCooling()) return { scores: null, definitive: false };

  const words = title.trim().split(/\s+/).filter(Boolean);
  const attempts = [title];
  if (words.length > 1) attempts.push(words.slice(0, 2).join(" "));
  if (words.length > 2) attempts.push(words[0]);

  for (let i = 0; i < attempts.length; i++) {
    if (Date.now() >= deadline) return { scores: null, definitive: false };
    if (whatsonCooling()) return { scores: null, definitive: false };

    const query = attempts[i];
    const requireTitleMatch = i > 0; // prefix queries: title must match

    const params = new URLSearchParams({
      title: query,
      ratings_filters: "rottentomatoes_critics,rottentomatoes_users",
    });
    const headers = { Accept: "application/json" };

    let resp;
    try {
      resp = await fetch(whatsonUrl(params), {
        headers,
        signal: AbortSignal.timeout(WHATSON_ATTEMPT_TIMEOUT_MS),
      });
    } catch (e) {
      return { scores: null, definitive: false }; // network/timeout → transient
    }

    if (resp.status === 429 || resp.status >= 500) {
      if (resp.status === 429) {
        // Quota exhausted → stop hammering whatson for a cooldown window.
        whatsonCooldownUntil = Date.now() + WHATSON_COOLDOWN_MS;
      }
      return { scores: null, definitive: false }; // transient → retry later
    }
    if (!resp.ok) continue; // 404 etc. → this variant truly has nothing

    let data;
    try {
      data = await resp.json();
    } catch {
      return { scores: null, definitive: false };
    }

    const results = (data && data.results) || [];
    const match = pickMatch(results, title, year, requireTitleMatch);
    if (match) return { scores: match, definitive: true };

    // The query returned rows but none is a usable RT match → a shorter/broader
    // query is even less likely to be the right title; stop here to save quota.
    if (results.length > 0) return { scores: null, definitive: true };
    // results empty → try the next (shorter) variant
  }

  return { scores: null, definitive: true };
}

function pickMatch(results, title, year, requireTitleMatch) {
  const target = normTitle(title);
  let best = null;
  let bestScore = -1;

  for (const r of results) {
    const rt = r && r.rotten_tomatoes;
    if (!rt) continue;
    if (rt.critics_rating == null && rt.users_rating == null) continue;

    const sameTitle = normTitle(r.title) === target && target.length > 0;
    let rYear = null;
    if (r.release_date) rYear = parseInt(String(r.release_date).substring(0, 4), 10);
    const sameYear = year && rYear === year;

    let score = 0;
    if (sameTitle) score += 2;
    if (sameYear) score += 1;
    if (requireTitleMatch && !sameTitle) continue;

    if (score > bestScore) {
      best = rt;
      bestScore = score;
    }
  }

  if (!best || bestScore < 1) return null;
  return {
    tomatometer: best.critics_rating != null ? best.critics_rating : null,
    popcornmeter: best.users_rating != null ? best.users_rating : null,
  };
}

function inject(item, scores) {
  if (scores.tomatometer != null) item.tomatometer = scores.tomatometer;
  if (scores.popcornmeter != null) item.popcornmeter = scores.popcornmeter;
}

/* ─────────────────────────── enrichment ─────────────────────────── */

async function enrichItem(item, deadline) {
  if (!item || typeof item !== "object") return;
  if (!item.id || !item.title) return;
  if (!LATIN_TITLE_RE.test(item.title)) return; // Persian titles: skip honestly

  const cacheKey = `rt:${item.type || "movie"}:${item.id}`;
  const cached = cacheGet(cacheKey);
  if (cached !== undefined) {
    if (cached !== "null") inject(item, JSON.parse(cached));
    return;
  }

  const outcome = await fetchRT(item.title, item.year, deadline);

  if (outcome.scores) {
    cachePut(cacheKey, JSON.stringify(outcome.scores), SCORE_TTL_MS);
    inject(item, outcome.scores);
    return;
  }

  if (outcome.definitive) {
    cachePut(cacheKey, "null", NEGATIVE_TTL_MS);
  }
  // Transient: nothing cached → next request retries
}

async function enrichAll(items, deadline) {
  const queue = items.slice();

  const worker = async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        await enrichItem(item, deadline);
      } catch (e) {
        // Never break the response because of enrichment failures
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(ENRICH_CONCURRENCY, queue.length) }, worker)
  );
}

/* ─────────────────────────── TMDb proxy (censorship bypass) ─────────────────────────── */

// TMDb is DNS-sinkholed in Iran (api/image.tmdb.org → 10.10.34.x) and the old
// *.workers.dev proxy is SNI-filtered at the TLS layer. This Render endpoint is
// reachable from Iran (verified), so the Android app points its TMDb base URL
// here:  /tmdb/3/*   → api.themoviedb.org/3/*
//        /tmdb/t/p/* → image.tmdb.org/t/p/*   (posters/backdrops)

async function proxyTmdbApi(upstreamUrl) {
  try {
    const resp = await fetch(upstreamUrl, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
    });
    const body = await resp.text();
    return new Response(body, {
      status: resp.status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=21600",
        "access-control-allow-origin": "*",
      },
    });
  } catch (e) {
    return json({ error: "TMDb unreachable", detail: String(e) }, 502);
  }
}

async function proxyTmdbImage(upstreamUrl) {
  try {
    const resp = await fetch(upstreamUrl, {
      signal: AbortSignal.timeout(TMDB_TIMEOUT_MS),
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    return new Response(buf, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") || "image/jpeg",
        "cache-control": "public, max-age=2592000, immutable",
        "access-control-allow-origin": "*",
      },
    });
  } catch (e) {
    return json({ error: "TMDb image unreachable", detail: String(e) }, 502);
  }
}

/* ─────────────────────────── server ─────────────────────────── */

async function handle(request) {
  const url = new URL(request.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    return json({
      ok: true,
      service: "ccloud-enricher",
      upstream: UPSTREAM_HOST,
      whatson: WHATSON_BASE,
      whatsonKeyConfigured: WHATSON_API_KEY.length > 0, // never leak the key itself
      whatsonCooling: whatsonCooling(), // true = 429 cooldown active (quota exhausted)
      cacheEntries: cache.size,
      cacheFile: CACHE_FILE,
      tmdbApi: TMDB_API_BASE,
      tmdbImage: TMDB_IMAGE_BASE,
    });
  }

  // Live diagnosis: runs the full fetchRT pipeline and reports details
  if (url.pathname === "/debug/rt") {
    const title = url.searchParams.get("title") || "";
    const year = parseInt(url.searchParams.get("year") || "0", 10) || null;
    if (whatsonCooling()) {
      return json({
        title, year, cooling: true,
        hint: "whatson 429 cooldown active (quota exhausted) — raw probe skipped to save quota",
      });
    }
    const words = title.trim().split(/\s+/).filter(Boolean);
    const attempts = [title];
    if (words.length > 1) attempts.push(words.slice(0, 2).join(" "));
    if (words.length > 2) attempts.push(words[0]);

    const t0 = Date.now();
    const outcome = await fetchRT(title, year, Date.now() + 15000);
    const ms = Date.now() - t0;

    // Also capture the raw first-attempt results for inspection
    const params = new URLSearchParams({
      title: attempts[0],
      ratings_filters: "rottentomatoes_critics,rottentomatoes_users",
    });
    const headers = { Accept: "application/json" };
    let rawResults = [];
    let rawStatus = null;
    let keyUsed = WHATSON_API_KEY.length > 0;
    try {
      const resp = await fetch(whatsonUrl(params), {
        headers,
        signal: AbortSignal.timeout(WHATSON_ATTEMPT_TIMEOUT_MS),
      });
      rawStatus = resp.status;
      // 429 with the API key attached vs anonymous are different problems:
      //   keyUsed=false + 429 -> anonymous quota (100/h), set the env var
      //   keyUsed=true  + 429 -> keyed quota exhausted or key invalid
      if (resp.status === 429) {
        return json({
          title, year, attempts,
          outcome, ms: Date.now() - t0,
          rawStatus, keyUsed,
          hint: keyUsed
            ? "keyed quota exhausted or invalid key (key is sent as ?api_key=)"
            : "ANONYMOUS quota — WHATSON_API_KEY env var not set on this deploy",
          rawResults,
        });
      }
      const data = await resp.json();
      rawResults = (data.results || []).slice(0, 6).map((r) => ({
        title: r.title,
        year: r.release_date ? String(r.release_date).substring(0, 4) : null,
        critics: r.rotten_tomatoes ? r.rotten_tomatoes.critics_rating : null,
        audience: r.rotten_tomatoes ? r.rotten_tomatoes.users_rating : null,
        normTitle: normTitle(r.title),
      }));
    } catch (e) {
      rawStatus = String(e);
    }

    return json({ title, year, attempts, outcome, ms, rawStatus, rawResults });
  }

  // ── TMDb proxy: /tmdb/3/* (API) and /tmdb/t/p/* (posters/backdrops) ──
  if (url.pathname === "/tmdb" || url.pathname.startsWith("/tmdb/")) {
    const rest = url.pathname.slice("/tmdb".length);
    if (rest.startsWith("/3/")) {
      return proxyTmdbApi(TMDB_API_BASE + rest + url.search);
    }
    if (rest.startsWith("/t/")) {
      return proxyTmdbImage(TMDB_IMAGE_BASE + rest);
    }
    return json({ error: "Not found" }, 404);
  }

  if (!url.pathname.startsWith("/api/")) {
    return json({ error: "Not found" }, 404);
  }

  // 1) Fetch from the original API
  let upstreamResp;
  try {
    upstreamResp = await fetch(UPSTREAM_HOST + url.pathname + url.search, {
      headers: { Accept: "application/json", "User-Agent": "ccloud-enricher/1.0" },
      signal: AbortSignal.timeout(25000),
    });
  } catch (e) {
    return json({ error: "Upstream unreachable", detail: String(e) }, 502);
  }

  if (!upstreamResp.ok) {
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: { "content-type": upstreamResp.headers.get("content-type") || "text/plain" },
    });
  }

  const bodyText = await upstreamResp.text();

  // 2) Enrichable? Arrays, or objects wrapping a `posters` array (/api/search)
  const enrichable = ENRICHABLE_PREFIXES.some((p) => url.pathname.startsWith(p));
  if (!enrichable) return passthrough(bodyText);

  let container = null;
  let items = null;
  try {
    const parsed = JSON.parse(bodyText);
    if (Array.isArray(parsed)) {
      items = parsed;
    } else if (parsed && Array.isArray(parsed.posters)) {
      container = parsed;
      items = parsed.posters;
    }
  } catch {
    return passthrough(bodyText);
  }
  if (!items || items.length === 0) return passthrough(bodyText);

  // 3) Enrich
  const deadline = Date.now() + ENRICH_TIMEOUT_MS;
  await enrichAll(items, deadline);

  return new Response(JSON.stringify(container !== null ? container : items), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-ccloud-enriched": "1",
    },
  });
}

const server = require("http").createServer((req, res) => {
  // Node's req.url is path-only ("/health") — Request needs an absolute URL
  handle(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers: req.headers }))
    .then(async (resp) => {
      res.writeHead(resp.status, Object.fromEntries(resp.headers));
      // arrayBuffer (not text) so binary image proxying stays byte-exact
      const body = Buffer.from(await resp.arrayBuffer());
      res.end(body);
    })
    .catch((e) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: String(e) }));
    });
});

server.listen(PORT, () => {
  console.log(`ccloud-enricher listening on :${PORT}`);
  console.log(`  upstream: ${UPSTREAM_HOST}`);
  console.log(`  whatson:  ${WHATSON_BASE}`);
});
