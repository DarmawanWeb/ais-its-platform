import type { LoginResponseDto, OrganizationDto } from './dto.js';
import { HttpClient, type TokenProvider } from './http.js';

const REFRESH_COOKIE = 'aisits_rt';

/**
 * Platform-admin session of the migration: `POST /api/v2/auth/login` with
 * the credentials of the environment, the access token renewed through
 * `POST /api/v2/auth/refresh` (refresh cookie `aisits_rt`, sent without an
 * `Origin` header like any server-side client) a minute before it expires
 * or after a 401, and a fresh login when the refresh token is gone.
 */
export class AuthSession implements TokenProvider {
  private accessToken: string | undefined;
  private expiresAt = 0;
  private refreshCookie: string | undefined;
  private pending: Promise<void> | undefined;
  private readonly http: HttpClient;

  constructor(
    baseUrl: string,
    private readonly credentials: {
      readonly email: string;
      readonly password: string;
    },
    options: {
      readonly timeoutMs: number;
      readonly retries: number;
      readonly fetch?: typeof fetch | undefined;
    },
    private readonly clock: () => number = Date.now,
  ) {
    this.http = new HttpClient({
      baseUrl,
      timeoutMs: options.timeoutMs,
      retries: options.retries,
      fetch: options.fetch,
    });
  }

  /** Signs in (throws on wrong credentials or an MFA-enabled account). */
  async login(): Promise<void> {
    const response = await this.http.request<LoginResponseDto>(
      'POST',
      'api/v2/auth/login',
      {
        body: {
          email: this.credentials.email,
          password: this.credentials.password,
        },
        authenticated: false,
      },
    );
    if (response.body.mfaRequired === true)
      throw new Error(
        'The migration account has MFA enabled; use a platform admin without MFA for the migration window',
      );
    this.accept(response.body, response.headers);
  }

  async token(): Promise<string> {
    if (
      this.accessToken === undefined ||
      this.clock() > this.expiresAt - 60_000
    )
      await this.renewOnce();
    if (this.accessToken === undefined) throw new Error('Not signed in');
    return this.accessToken;
  }

  async renew(): Promise<boolean> {
    this.expiresAt = 0;
    await this.renewOnce();
    return this.accessToken !== undefined;
  }

  /** The organization `id` (requires `org:manage`). */
  async organization(id: string): Promise<OrganizationDto> {
    const client = new HttpClient({
      baseUrl: this.http.baseUrl,
      timeoutMs: 30_000,
      retries: 2,
      auth: this,
    });
    return client.get<OrganizationDto>(
      `api/v2/organizations/${encodeURIComponent(id)}`,
    );
  }

  private renewOnce(): Promise<void> {
    this.pending ??= this.refreshOrLogin().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async refreshOrLogin(): Promise<void> {
    if (this.refreshCookie !== undefined) {
      try {
        const response = await this.http.request<LoginResponseDto>(
          'POST',
          'api/v2/auth/refresh',
          {
            headers: { cookie: `${REFRESH_COOKIE}=${this.refreshCookie}` },
            authenticated: false,
          },
        );
        this.accept(response.body, response.headers);
        return;
      } catch {
        this.refreshCookie = undefined; // expired or revoked: sign in again
      }
    }
    await this.login();
  }

  private accept(body: LoginResponseDto, headers: Headers): void {
    if (typeof body.accessToken !== 'string')
      throw new Error('The auth service answered without an access token');
    this.accessToken = body.accessToken;
    this.expiresAt = this.clock() + (body.expiresIn ?? 900) * 1000;
    for (const cookie of headers.getSetCookie()) {
      const match = new RegExp(`^${REFRESH_COOKIE}=([^;]*)`).exec(cookie);
      if (match?.[1] !== undefined && match[1] !== '')
        this.refreshCookie = match[1];
    }
  }
}
