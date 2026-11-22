// =============================================================================
// AIS Maritime Intelligence — gateway routing test, echo + client side
// =============================================================================
// Started by infra/scripts/routes-test.sh in node:24-alpine, on a private
// network next to a throwaway gateway running infra/traefik in stack mode.
// This one process is every upstream of routes.yml at once — the container
// carries all their §3 hostnames as network aliases and listens on all their
// ports — and also the client: each request goes through the gateway, and the
// port that answers (= the backend) and the path it received are compared
// with docs/PLATFORM_SPEC.md §12. Exit code = number of failed checks.
import http from 'node:http';

const GATEWAY = 'http://gateway:8000';
const GATEWAY_API = 'http://gateway:8090';
const { SECRET = 'reset-token', MARKER = 'marker' } = process.env;

// Upstreams of routes.yml in stack mode (spec §3); observability receives the
// gateway's OTLP spans.
const BACKENDS = {
  3001: 'auth', 3002: 'fleet', 3003: 'ais-ingestor', 3004: 'ais-processor', 3005: 'telemetry',
  3006: 'emission', 3007: 'surveillance', 3008: 'notification', 3009: 'geo', 3010: 'martin',
  3011: 'safety', 3020: 'legacy-be', 8080: 'web', 4318: 'observability',
};
// Access tokens the fake auth accepts on GET /api/v2/auth/verify (spec §13.1).
const IDENTITIES = {
  'Bearer user-token': { 'x-user-id': 'user-1', 'x-org-id': 'org-1', 'x-roles': 'viewer' },
  'Bearer no-org-token': { 'x-user-id': 'user-2', 'x-roles': 'super_admin' },
};

const received = [];          // { backend, url, headers } of every request a backend got
const forwardAuthCalls = [];  // headers of the gateway's forwardAuth requests

for (const [port, backend] of Object.entries(BACKENDS)) {
  http
    .createServer((req, res) => {
      const isVerify = backend === 'auth' && req.url.startsWith('/api/v2/auth/verify');
      if (isVerify && req.headers['x-forwarded-uri'] !== undefined) forwardAuthCalls.push(req.headers);
      else received.push({ backend, url: req.url, headers: req.headers });
      const identity = isVerify ? IDENTITIES[req.headers.authorization] : undefined;
      const status = isVerify && !identity ? 401 : 200;
      const pad = Number(new URL(req.url, 'http://x').searchParams.get('pad') ?? 0);
      const body = JSON.stringify({ backend, url: req.url, headers: req.headers, pad: 'x'.repeat(pad) });
      res.writeHead(status, {
        'content-type': 'application/json',
        server: 'echo-backend',          // must be stripped by security-headers
        'x-powered-by': 'echo',
        ...identity,
      });
      res.end(body);
    })
    .listen(Number(port), '0.0.0.0');
}

let failures = 0;
const check = (name, ok, detail = '') => {
  if (ok) console.log(`  PASS ${name}`);
  else { failures += 1; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
};
const request = async (path, { method = 'GET', headers = {} } = {}) => {
  const res = await fetch(GATEWAY + path, { method, headers, redirect: 'manual' });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not an echo answer (gateway error page) */ }
  return { status: res.status, headers: res.headers, body };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
setTimeout(() => { console.log('  FAIL routing test timed out'); process.exit(99); }, 120_000).unref();

// --- the gateway is up and has loaded routes.yml (stack mode) ----------------
let overview;
for (let i = 0; i < 60 && !(overview?.http?.routers?.total >= 22); i += 1) {
  overview = await fetch(`${GATEWAY_API}/api/overview`).then((r) => r.json()).catch(() => undefined);
  await sleep(500);
}
console.log('Gateway configuration (traefik.yml + dynamic/routes.yml, stack mode)');
const { routers, services, middlewares } = overview?.http ?? {};
check(`18 routers loaded without errors (${routers?.total} incl. 4 internal)`,
  routers?.total === 22 && routers.errors === 0 && routers.warnings === 0);
check('services and middlewares without errors', services?.errors === 0 && middlewares?.errors === 0);
const upstreams = await fetch(`${GATEWAY_API}/api/http/services?per_page=100`).then((r) => r.json());
for (const [port, backend] of Object.entries(BACKENDS)) {
  if (backend === 'observability') continue;
  const url = upstreams.find((s) => s.name === `${backend}@file`)?.loadBalancer?.servers?.[0]?.url;
  check(`${backend} upstream is http://${backend}:${port}`, url === `http://${backend}:${port}`, url);
}

// --- every row of spec §12 -------------------------------------------------------
console.log('Routes of spec §12 (path → backend that answered, path it received)');
const ROUTES = [
  ['/api/v2/auth/login', 'auth'], ['/api/v2/auth/password/forgot', 'auth'], ['/api/v2/auth/mfa/verify', 'auth'],
  ['/api/v2/auth/refresh', 'auth'], ['/api/v2/auth/logout', 'auth'], ['/api/v2/auth/sessions', 'auth'],
  ['/api/v2/me', 'auth'], ['/api/v2/users?page=1', 'auth'], ['/api/v2/organizations/o-1/members', 'auth'],
  ['/api/v2/api-keys', 'auth'], ['/api/v2/audit-logs?limit=5', 'auth'], ['/.well-known/jwks.json', 'auth'],
  ['/api/v2/vessels/by-mmsi/525005223', 'fleet'], ['/api/v2/vessel-types', 'fleet'], ['/api/v2/fuels', 'fleet'],
  ['/api/v2/engines?kind=main', 'fleet'], ['/api/v2/fuel-formulas', 'fleet'], ['/api/v2/ports', 'fleet'],
  ['/api/v2/registry/search?q=x', 'fleet'], ['/api/v2/fleet/methodology', 'fleet'],
  ['/api/v2/ingest/ais', 'ais-ingestor'], ['/api/v2/ingest/socket/?EIO=4&transport=polling', 'ais-ingestor'],
  ['/api/v2/ais/latest?bbox=104,1,105,2', 'ais-processor'],
  ['/api/v2/telemetry/vessels/525005223/readings', 'telemetry'],
  ['/api/v2/cii/fleet/summary', 'emission'], ['/api/v2/seemp/measures', 'emission'],
  ['/api/v2/emission/methodology', 'emission'], ['/api/v2/reduction-factors', 'emission'],
  ['/api/v2/surveillance/events?type=dark', 'surveillance'],
  ['/api/v2/alerts/summary', 'notification'], ['/api/v2/alert-rules', 'notification'],
  ['/api/v2/notifications/test', 'notification'], ['/ws/?EIO=4&transport=polling', 'notification'],
  ['/api/v2/zones/geojson?kind=pipeline', 'geo'],
  ['/api/v2/safety/vessels?bbox=104,1,105,2', 'safety'],
  ['/', 'web'], ['/reset-password', 'web'], ['/.well-known/openid-configuration', 'web'],
  ['/api/v2/detections', 'web'],   // spec 1.0 route, replaced by /api/v2/surveillance in 1.1
];
for (const [path, backend] of ROUTES) {
  const res = await request(path);
  check(`${path} → ${backend}`, res.status === 200 && res.body?.backend === backend && res.body.url === path,
    `HTTP ${res.status}, ${res.body?.backend ?? 'no backend'} got ${res.body?.url}`);
}

console.log('Never exposed (spec §5, §12): 403 from the gateway, no backend reached');
for (const path of ['/internal/api-keys/introspect', '/metrics', '/docs', '/docs/json', '/openapi.json']) {
  const before = received.length;
  const res = await request(path);
  check(`${path} → 403`, res.status === 403 && received.length === before, `HTTP ${res.status}`);
}

console.log('forwardAuth: /tiles (Martin, prefix stripped) and /api/v1 (MVP API)');
const user = { authorization: 'Bearer user-token' };
for (const path of ['/tiles/catalog', '/api/v1/ais', '/api/v2/auth/verify']) {
  const res = await request(path);
  check(`${path} without a token → 401`, res.status === 401 && res.body?.backend !== 'martin', `HTTP ${res.status}`);
}
let res = await request('/tiles/catalog', { headers: user });
check('/tiles/catalog with a token → martin /catalog', res.status === 200 && res.body?.backend === 'martin' && res.body.url === '/catalog',
  `HTTP ${res.status} ${res.body?.backend} ${res.body?.url}`);
res = await request('/tiles/zones_tiles/8/201/127', { headers: user });
check('/tiles/zones_tiles/8/201/127 → martin /zones_tiles/8/201/127', res.body?.url === '/zones_tiles/8/201/127', res.body?.url);
res = await request('/api/v1/port', { method: 'POST', headers: { 'x-user-id': 'attacker', 'x-roles': 'super_admin' } });
check('/api/v1 with spoofed X-User-Id and no token → 401', res.status === 401 && res.body?.backend !== 'legacy-be', `HTTP ${res.status}`);
res = await request('/api/v1/port', {
  method: 'POST',
  headers: { ...user, 'x-user-id': 'attacker', 'x-org-id': 'evil', 'x-roles': 'super_admin', cookie: 'sid=secret' },
});
const seen = res.body?.headers ?? {};
check('/api/v1 with a token → legacy-be with the identity from auth only',
  res.body?.backend === 'legacy-be' && seen['x-user-id'] === 'user-1' && seen['x-org-id'] === 'org-1' && seen['x-roles'] === 'viewer',
  JSON.stringify({ user: seen['x-user-id'], org: seen['x-org-id'], roles: seen['x-roles'] }));
const verify = forwardAuthCalls.at(-1) ?? {};
check('auth receives only Authorization and X-Request-Id of the client', verify.authorization === 'Bearer user-token' && !verify.cookie);
res = await request('/api/v1/port', { headers: { authorization: 'Bearer no-org-token', 'x-org-id': 'evil' } });
check('a spoofed X-Org-Id is dropped when auth sends none', res.body?.backend === 'legacy-be' && res.body.headers['x-org-id'] === undefined,
  res.body?.headers?.['x-org-id']);

console.log('Response headers');
res = await request('/api/v2/vessels?pad=4096');
const h = res.headers;
check('nosniff, X-Frame-Options DENY, referrer and permissions policy',
  h.get('x-content-type-options') === 'nosniff' && h.get('x-frame-options') === 'DENY'
  && h.get('referrer-policy') === 'strict-origin-when-cross-origin' && h.has('permissions-policy'));
check('Server and X-Powered-By of the backend are removed', !h.has('server') && !h.has('x-powered-by'));
check(`API bodies ≥ 1 KiB are compressed (${h.get('content-encoding')})`, ['gzip', 'br', 'zstd'].includes(h.get('content-encoding')));
res = await request('/ws/?EIO=4&transport=polling&pad=4096');
check('socket.io routes are not compressed', !res.headers.has('content-encoding'));

console.log('Rate limits of the anonymous auth endpoints (spec §5), not fooled by X-Forwarded-For');
const burst = async (path, n) => {
  const counts = {};
  for (let i = 0; i < n; i += 1) {
    const { status } = await request(path, { method: 'POST', headers: { 'x-forwarded-for': `10.9.${i}.1` } });
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
};
let counts = await burst('/api/v2/auth/login', 40);
check(`40 × POST /auth/login → ${JSON.stringify(counts)} (burst 30)`, counts[429] >= 5 && counts[200] >= 20);
counts = await burst('/api/v2/auth/refresh', 80);
check(`80 × POST /auth/refresh → ${JSON.stringify(counts)} (burst 60)`, counts[429] >= 5 && counts[200] >= 50);

console.log('Access log hygiene (checked in the gateway log by routes-test.sh)');
res = await request(`/reset-password?token=${SECRET}`);
check('e-mailed reset link reaches the SPA', res.body?.backend === 'web');
res = await request(`/api/v2/vessels?marker=${MARKER}`);
check('API request with a marker reaches fleet', res.body?.backend === 'fleet');

process.exit(failures);
