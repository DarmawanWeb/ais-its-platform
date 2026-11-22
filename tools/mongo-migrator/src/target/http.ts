import { setTimeout as sleep } from 'node:timers/promises';

/** An RFC 9457 problem answered by a v2 service. */
export class HttpError extends Error {
  constructor(
    readonly method: string,
    readonly url: string,
    readonly status: number,
    readonly code: string | undefined,
    readonly problem: unknown,
  ) {
    super(
      `${method} ${url} → ${status}${code === undefined ? '' : ` ${code}`}${HttpError.detail(problem)}`,
    );
    this.name = 'HttpError';
  }

  private static detail(problem: unknown): string {
    if (typeof problem !== 'object' || problem === null) return '';
    const { detail, errors } = problem as {
      detail?: unknown;
      errors?: unknown;
    };
    const parts: string[] = [];
    if (typeof detail === 'string') parts.push(detail);
    if (Array.isArray(errors))
      parts.push(
        errors
          .map((error: unknown) => {
            const { field, message } = (error ?? {}) as {
              field?: unknown;
              message?: unknown;
            };
            return `${String(field)}: ${String(message)}`;
          })
          .join('; '),
      );
    return parts.length === 0 ? '' : `: ${parts.join(' — ')}`;
  }
}

/** Supplies (and renews) the bearer token of requests. */
export interface TokenProvider {
  token(): Promise<string>;
  /** Called after a 401: renews the token; `false` when it cannot. */
  renew(): Promise<boolean>;
}

export interface HttpClientOptions {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly retries: number;
  readonly auth?: TokenProvider | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export interface RequestOptions {
  readonly body?: unknown;
  readonly query?:
    Readonly<Record<string, string | number | undefined>> | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Send the bearer token (default true). */
  readonly authenticated?: boolean | undefined;
}

export interface HttpResponse<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

const RETRIABLE = new Set([408, 429, 502, 503, 504]);

/**
 * JSON client of a v2 service: timeouts, retries with exponential backoff
 * for network errors, 408/429/502/503/504 (honouring `Retry-After`), one
 * token renewal after a 401, and problem details turned into
 * {@link HttpError}. Retried writes are safe: every write of the migration
 * is keyed by a natural key (code, MMSI, year), so a replay answers
 * 409/200 instead of creating a duplicate.
 */
export class HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<HttpResponse<T>> {
    const url = new URL(path, `${this.options.baseUrl}/`);
    for (const [key, value] of Object.entries(options.query ?? {}))
      if (value !== undefined) url.searchParams.set(key, String(value));
    let renewed = false;
    for (let attempt = 0; ; attempt += 1) {
      const headers: Record<string, string> = {
        accept: 'application/json, application/problem+json',
        'user-agent': 'ais-its-mongo-migrator',
        ...options.headers,
      };
      if (options.body !== undefined)
        headers['content-type'] = 'application/json';
      if (options.authenticated !== false && this.options.auth !== undefined)
        headers.authorization = `Bearer ${await this.options.auth.token()}`;
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body:
            options.body === undefined ? null : JSON.stringify(options.body),
          signal: AbortSignal.timeout(this.options.timeoutMs),
          redirect: 'error',
        });
      } catch (error) {
        if (attempt >= this.options.retries) throw error;
        await sleep(this.backoff(attempt));
        continue;
      }
      if (
        response.status === 401 &&
        options.authenticated !== false &&
        this.options.auth !== undefined &&
        !renewed
      ) {
        await response.body?.cancel();
        renewed = true;
        if (await this.options.auth.renew()) continue;
      }
      if (RETRIABLE.has(response.status) && attempt < this.options.retries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 60_000)
            : this.backoff(attempt),
        );
        continue;
      }
      const text = await response.text();
      let body: unknown = undefined;
      if (text !== '') {
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      if (!response.ok) {
        const code =
          typeof body === 'object' && body !== null
            ? (body as { code?: unknown }).code
            : undefined;
        throw new HttpError(
          method,
          url.pathname,
          response.status,
          typeof code === 'string' ? code : undefined,
          body,
        );
      }
      return {
        status: response.status,
        body: body as T,
        headers: response.headers,
      };
    }
  }

  get<T>(path: string, query?: RequestOptions['query']): Promise<T> {
    return this.request<T>('GET', path, { query }).then(
      (response) => response.body,
    );
  }

  private backoff(attempt: number): number {
    return (
      Math.min(500 * 2 ** attempt, 10_000) + Math.floor(Math.random() * 250)
    );
  }
}

/** `true` for an {@link HttpError} with this status (and code). */
export function isHttpError(
  error: unknown,
  status: number,
  code?: string,
): error is HttpError {
  return (
    error instanceof HttpError &&
    error.status === status &&
    (code === undefined || error.code === code)
  );
}
