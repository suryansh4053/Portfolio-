/**
 * LeetCode stats API — Cloudflare Worker
 *
 *   GET /                    service description
 *   GET /health              liveness probe
 *   GET /leetcode            stats for LC_USER
 *   GET /leetcode/:username  stats for any public LeetCode user
 *
 * Two layers of caching sit in front of leetcode.com:
 *   1. an isolate-local memo, which works everywhere including *.workers.dev
 *   2. the Cloudflare Cache API, which only takes effect on a custom domain
 *      (cache operations are no-ops on workers.dev — by design, not a bug)
 *
 * If LeetCode is unreachable the last good response is served with X-Cache: STALE
 * rather than failing the request, so the portfolio never renders an empty card.
 */

const LEETCODE_GRAPHQL = 'https://leetcode.com/graphql';

const QUERY = `query userStats($u: String!) {
  matchedUser(username: $u) {
    submitStatsGlobal { acSubmissionNum { difficulty count } }
    userCalendar { streak totalActiveDays submissionCalendar }
  }
}`;

const MEMO_TTL   = 60;      // seconds — isolate-local
const FRESH_TTL  = 900;     // seconds — edge copy considered current
const STALE_TTL  = 86400;   // seconds — fallback copy kept for outages
const BROWSER_TTL = 300;    // seconds — Cache-Control sent to the browser

/** isolate-local memo: username -> { at, data } */
const memo = new Map();

/* ---------- helpers ---------- */

function allowOrigin(origin, allowed) {
  const list = (allowed || '*').split(',').map(s => s.trim()).filter(Boolean);
  if (list.includes('*')) return '*';
  return origin && list.includes(origin) ? origin : null;
}

function jsonResponse(body, { status = 200, origin = null, cache = 'MISS', maxAge = BROWSER_TTL } = {}) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=${maxAge}`,
    'X-Cache': cache,
    'Vary': 'Origin',
  };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

function normalise(user) {
  const counts = {};
  for (const row of user.submitStatsGlobal.acSubmissionNum) counts[row.difficulty] = row.count;

  let calendar = null;
  const rawCalendar = user.userCalendar?.submissionCalendar;
  if (rawCalendar) {
    try { calendar = JSON.parse(rawCalendar); } catch { /* leave null */ }
  }

  return {
    total:      counts.All    ?? 0,
    easy:       counts.Easy   ?? 0,
    medium:     counts.Medium ?? 0,
    hard:       counts.Hard   ?? 0,
    streak:     user.userCalendar?.streak ?? null,
    activeDays: user.userCalendar?.totalActiveDays ?? null,
    calendar,
    syncedAt:   new Date().toISOString(),
  };
}

async function queryLeetCode(username) {
  const res = await fetch(LEETCODE_GRAPHQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Referer': 'https://leetcode.com',
      'User-Agent': 'Mozilla/5.0 (compatible; portfolio-leetcode-worker)',
    },
    body: JSON.stringify({ query: QUERY, variables: { u: username } }),
  });

  if (!res.ok) throw new Error(`leetcode responded ${res.status}`);

  const payload = await res.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message || 'graphql error');

  const user = payload.data?.matchedUser;
  if (!user) throw new Error(`no such user: ${username}`);

  return normalise(user);
}

const keyFor = (url, kind, username) =>
  new Request(`${new URL(url).origin}/__cache/${kind}/${encodeURIComponent(username)}`);

/* ---------- stats route ---------- */

async function getStats(username, requestUrl, ctx) {
  const hit = memo.get(username);
  if (hit && (Date.now() - hit.at) / 1000 < MEMO_TTL) {
    return { data: hit.data, cache: 'HIT' };
  }

  const cache = caches.default;
  const freshKey = keyFor(requestUrl, 'fresh', username);

  const cached = await cache.match(freshKey);
  if (cached) {
    const data = await cached.json();
    memo.set(username, { at: Date.now(), data });
    return { data, cache: 'HIT' };
  }

  try {
    const data = await queryLeetCode(username);
    memo.set(username, { at: Date.now(), data });

    const store = (key, ttl) => cache.put(
      key,
      new Response(JSON.stringify(data), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttl}` },
      }),
    );
    ctx.waitUntil(Promise.all([
      store(freshKey, FRESH_TTL),
      store(keyFor(requestUrl, 'stale', username), STALE_TTL),
    ]));

    return { data, cache: 'MISS' };
  } catch (err) {
    const stale = await cache.match(keyFor(requestUrl, 'stale', username));
    if (stale) return { data: await stale.json(), cache: 'STALE' };
    if (hit)   return { data: hit.data, cache: 'STALE' };
    throw err;
  }
}

/* ---------- entrypoint ---------- */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = allowOrigin(request.headers.get('Origin'), env.ALLOWED_ORIGINS);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin || 'null',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          'Vary': 'Origin',
        },
      });
    }

    if (request.method !== 'GET') {
      return jsonResponse({ error: 'method not allowed' }, { status: 405, origin, maxAge: 0 });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/health') {
      return jsonResponse({ ok: true, at: new Date().toISOString() }, { origin, maxAge: 0 });
    }

    if (path === '/') {
      return jsonResponse({
        service: 'leetcode-stats-api',
        endpoints: ['/leetcode', '/leetcode/:username', '/health'],
        source: 'https://github.com/suryansh4053/Portfolio-',
      }, { origin, maxAge: 3600 });
    }

    if (path === '/leetcode' || path.startsWith('/leetcode/')) {
      const username = decodeURIComponent(path.slice('/leetcode/'.length)) || env.LC_USER;
      if (!username) {
        return jsonResponse({ error: 'no username configured' }, { status: 400, origin, maxAge: 0 });
      }

      try {
        const { data, cache } = await getStats(username, request.url, ctx);
        return jsonResponse(data, { origin, cache });
      } catch (err) {
        return jsonResponse({ error: String(err.message || err) }, { status: 502, origin, maxAge: 0 });
      }
    }

    return jsonResponse({ error: 'not found' }, { status: 404, origin, maxAge: 0 });
  },
};
