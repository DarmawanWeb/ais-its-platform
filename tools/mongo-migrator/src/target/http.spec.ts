import { describe, expect, it, vi } from 'vitest';

import { AuthSession } from './auth-session.js';
import { HttpClient, HttpError, isHttpError } from './http.js';

type Handler = (url: URL, init: RequestInit) => Response;

function fakeFetch(handlers: Handler[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(
    (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      );
      calls.push({ url: url.pathname, init: init ?? {} });
      const handler = handlers.shift();
      if (handler === undefined)
        throw new Error(`unexpected request ${url.pathname}`);
      return Promise.resolve(handler(url, init ?? {}));
    },
  );
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type':
        status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });

describe('HttpClient', () => {
  it('retries 503 with Retry-After and returns JSON', async () => {
    const { fetchImpl, calls } = fakeFetch([
      () => json(503, { code: 'SERVICE_UNAVAILABLE' }, { 'retry-after': '0' }),
      () => json(200, { ok: true }),
    ]);
    const client = new HttpClient({
      baseUrl: 'http://fleet',
      timeoutMs: 1000,
      retries: 2,
      fetch: fetchImpl,
    });
    await expect(client.get('api/v2/vessels')).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('turns problem details into HttpError', async () => {
    const { fetchImpl } = fakeFetch([
      () =>
        json(409, {
          code: 'MMSI_ALREADY_EXISTS',
          detail: 'taken',
          errors: [{ field: 'mmsi', message: 'exists' }],
        }),
    ]);
    const client = new HttpClient({
      baseUrl: 'http://fleet',
      timeoutMs: 1000,
      retries: 0,
      fetch: fetchImpl,
    });
    const error = await client
      .request('POST', 'api/v2/vessels', { body: {} })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(isHttpError(error, 409, 'MMSI_ALREADY_EXISTS')).toBe(true);
    expect((error as Error).message).toBe(
      'POST /api/v2/vessels → 409 MMSI_ALREADY_EXISTS: taken — mmsi: exists',
    );
  });

  it('renews the token once after a 401', async () => {
    const tokens = ['old', 'new'];
    const auth = {
      token: vi.fn(() => Promise.resolve(tokens[0] ?? '')),
      renew: vi.fn(() => {
        tokens.shift();
        return Promise.resolve(true);
      }),
    };
    const { fetchImpl, calls } = fakeFetch([
      () => json(401, { code: 'UNAUTHORIZED' }),
      () => json(200, { ok: 1 }),
    ]);
    const client = new HttpClient({
      baseUrl: 'http://fleet',
      timeoutMs: 1000,
      retries: 0,
      auth,
      fetch: fetchImpl,
    });
    await expect(client.get('api/v2/fuels')).resolves.toEqual({ ok: 1 });
    expect(auth.renew).toHaveBeenCalledTimes(1);
    expect(new Headers(calls[1]?.init.headers).get('authorization')).toBe(
      'Bearer new',
    );
  });
});

describe('AuthSession', () => {
  it('signs in, refreshes with the rotated cookie before expiry and signs in again when refresh fails', async () => {
    let now = 0;
    const { fetchImpl, calls } = fakeFetch([
      () =>
        json(
          200,
          { accessToken: 't1', expiresIn: 900 },
          { 'set-cookie': 'aisits_rt=r1; Path=/api/v2/auth; HttpOnly' },
        ),
      (_url, init) => {
        expect(new Headers(init.headers).get('cookie')).toBe('aisits_rt=r1');
        return json(
          200,
          { accessToken: 't2', expiresIn: 900 },
          { 'set-cookie': 'aisits_rt=r2; Path=/api/v2/auth; HttpOnly' },
        );
      },
      () => json(401, { code: 'INVALID_REFRESH_TOKEN' }),
      () => json(200, { accessToken: 't3', expiresIn: 900 }),
    ]);
    const session = new AuthSession(
      'http://auth',
      { email: 'admin@ais-its.local', password: 'x' },
      { timeoutMs: 1000, retries: 0, fetch: fetchImpl },
      () => now,
    );
    await session.login();
    expect(await session.token()).toBe('t1');
    now = 850_000; // less than a minute left
    expect(await session.token()).toBe('t2');
    now = 1_800_000;
    expect(await session.token()).toBe('t3');
    expect(calls.map((call) => call.url)).toEqual([
      '/api/v2/auth/login',
      '/api/v2/auth/refresh',
      '/api/v2/auth/refresh',
      '/api/v2/auth/login',
    ]);
    expect(new Headers(calls[1]?.init.headers).has('origin')).toBe(false);
  });

  it('refuses an account with MFA', async () => {
    const { fetchImpl } = fakeFetch([
      () => json(200, { mfaRequired: true, mfaToken: 'm' }),
    ]);
    const session = new AuthSession(
      'http://auth',
      { email: 'a@b.c', password: 'x' },
      { timeoutMs: 1000, retries: 0, fetch: fetchImpl },
    );
    await expect(session.login()).rejects.toThrow('MFA');
  });
});
