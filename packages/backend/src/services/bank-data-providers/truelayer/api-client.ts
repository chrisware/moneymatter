import { t } from '@i18n/index';
import { BadRequestError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '@js/errors';
import { logger } from '@js/utils/logger';
import axios, { AxiosInstance } from 'axios';
import { createHash, randomBytes } from 'node:crypto';

import type {
  TrueLayerApiAccessTokenResponse,
  TrueLayerApiAccount,
  TrueLayerApiAccountsResponse,
  TrueLayerApiBalanceResponse,
  TrueLayerApiCreatedConnection,
  TrueLayerApiTransaction,
  TrueLayerCredentials,
  TrueLayerEnvironment,
  TrueLayerProblemDetails,
  TrueLayerTransactionsRequestCompleted,
  TrueLayerTransactionsRequestResult,
  TrueLayerV1Account,
  TrueLayerV1Balance,
  TrueLayerV1BalancesResponse,
  TrueLayerV1AccountsResponse,
  TrueLayerV1TokenResponse,
  TrueLayerV1Transaction,
  TrueLayerV1TransactionsResponse,
} from './types';

const HOSTS: Record<TrueLayerEnvironment, { auth: string; api: string }> = {
  production: {
    auth: 'https://auth.truelayer.com',
    api: 'https://api.truelayer.com',
  },
  sandbox: {
    auth: 'https://auth.truelayer-sandbox.com',
    api: 'https://api.truelayer-sandbox.com',
  },
};

/**
 * Refresh the app token this much before its actual expiry so an in-flight
 * request never races the expiry boundary.
 */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Async transactions-request polling cadence and ceiling. */
const TX_POLL_INTERVAL_MS = 1_000;
const TX_POLL_MAX_ATTEMPTS = 120;

/** Rows per transactions-request page; TrueLayer caps at 500. */
const TX_PAGE_SIZE = 200;

interface CachedToken {
  token: string;
  expiresAt: number;
  inflight?: Promise<string>;
}

/**
 * Cross-instance app-token cache, keyed by environment + clientId. Data v3
 * tokens are app-level (client_credentials, ~15 min lifetime) and every
 * connection of one TrueLayer app shares them, so several connections of the
 * same app don't multiply token round-trips. Cleared implicitly by expiry.
 */
const tokenCache = new Map<string, CachedToken>();

/**
 * Does this access token carry TrueLayer Data API v3 access? The docs are
 * explicit: v3 requests need the literal `data` scope in the token. Legacy
 * apps with granular v1 scopes (accounts/transactions/connections:create)
 * are NOT v3-provisioned and get 403 on POST /v3/data-connections. Tokens we
 * can't decode (opaque mocks) are assumed provisioned so the more common
 * redirect-URI hint wins.
 */
function tokenGrantsDataAccess(jwt: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      scope?: string | string[];
    };
    const scope = Array.isArray(payload.scope) ? payload.scope.join(' ') : (payload.scope ?? '');
    return /\bdata\b/.test(scope);
  } catch {
    return true;
  }
}

/**
 * TrueLayer API client covering both Data API generations.
 *
 * v3 (default): POST /connect/token (grant_type=client_credentials, scope `data`)
 * for a short-lived app bearer, cached per app; every data call adds
 * `Connection-Id` identifying the user's authorized data connection.
 *
 * v1 (legacy): built authorization link → authorization code exchanged at
 * POST {auth}/connect/token (form-encoded) for a per-user bearer + rotating
 * refresh token (refreshed there, with the legacy POST /token as fallback);
 * data calls are plain GETs (/data/v1/accounts, /data/v1/{id}/balance,
 * /data/v1/{id}/transactions) whose UDM payloads are mapped into the
 * v3-shaped types here, so the provider's sync/mapping code is shared.
 *
 * Docs: https://docs.truelayer.com/reference/welcome-api-reference
 */
export class TrueLayerApiClient {
  private readonly credentials: TrueLayerCredentials;
  private readonly environment: TrueLayerEnvironment;
  private readonly api: AxiosInstance;
  private readonly auth: AxiosInstance;
  private readonly cacheKey: string;

  constructor(credentials: TrueLayerCredentials) {
    this.credentials = credentials;
    this.environment = credentials.environment === 'sandbox' ? 'sandbox' : 'production';
    const hosts = HOSTS[this.environment];

    this.api = axios.create({ baseURL: hosts.api, timeout: 30_000 });
    this.auth = axios.create({ baseURL: hosts.auth, timeout: 30_000 });
    // The secret participates in the key (hashed) so connections sharing a
    // client_id but with different secrets never reuse each other's token.
    this.cacheKey = `${this.environment}:${credentials.clientId}:${createHash('sha256').update(credentials.clientSecret).digest('hex')}`;
  }

  /**
   * Cached client_credentials token. Concurrent callers share one in-flight
   * refresh; a 401 from any data endpoint should call `invalidateToken()`
   * first so the next request re-fetches.
   */
  async getAccessToken(): Promise<string> {
    const cached = tokenCache.get(this.cacheKey);

    if (cached) {
      if (cached.inflight) return cached.inflight;
      if (cached.expiresAt > Date.now()) return cached.token;
    }

    const inflight = this.fetchAccessToken().finally(() => {
      const entry = tokenCache.get(this.cacheKey);
      if (entry) entry.inflight = undefined;
    });

    tokenCache.set(this.cacheKey, {
      token: cached?.token ?? '',
      expiresAt: 0,
      inflight,
    });

    const token = await inflight;
    return token;
  }

  invalidateToken(): void {
    tokenCache.delete(this.cacheKey);
  }

  private async fetchAccessToken(): Promise<string> {
    try {
      // No scope parameter: the token carries the app's full dashboard-
      // configured scope set. Apps provisioned for Data v3 include the
      // literal `data` scope there; the 403 discriminator in
      // createDataConnection checks for it.
      const response = await this.auth.post<TrueLayerApiAccessTokenResponse>('/connect/token', {
        grant_type: 'client_credentials',
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      });

      const entry: CachedToken = {
        token: response.data.access_token,
        expiresAt: Date.now() + (response.data.expires_in ?? 900) * 1000 - TOKEN_EXPIRY_MARGIN_MS,
      };
      tokenCache.set(this.cacheKey, entry);
      return entry.token;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 400 || status === 401 || status === 403) {
          // invalid_grant / unauthenticated: the app credentials are wrong.
          throw new ForbiddenError({
            message: t({
              key: 'bankDataProviders.truelayer.invalidCredentials',
            }),
          });
        }
      }
      throw error;
    }
  }

  /** Token endpoint reachable with these credentials? */
  async testConnection(): Promise<boolean> {
    try {
      await this.getAccessToken();
      return true;
    } catch (error) {
      if (error instanceof ForbiddenError) return false;
      throw error;
    }
  }

  // ==========================================================================
  // Legacy Data API v1 (OAuth authorization-code flow)
  //
  // For TrueLayer apps provisioned before Data v3 (no `data` scope). There is
  // no Connection-Id: the user authorizes via a built authorization link on
  // the same auth host; the resulting code is exchanged on it too
  // for a per-user bearer + rotating refresh token, and data calls are plain
  // GETs against /accounts, /accounts/{id}/balance and /accounts/{id}/transactions.
  // ==========================================================================

  /**
   * Build the v1 hosted authorization link. No API call is needed: it is a
   * pure redirect with query params. `state` is a caller-generated CSRF token
   * echoed back on the redirect; the nonce is fresh per link.
   */
  buildV1AuthUrl({ redirectUri, state }: { redirectUri: string; state: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.credentials.clientId,
      scope: V1_SCOPE,
      redirect_uri: redirectUri,
      state,
      nonce: randomBytes(16).toString('base64url'),
    });
    return `${HOSTS[this.environment].auth}/?${params.toString()}`;
  }

  /**
   * POST {auth}/connect/token grant_type=authorization_code — swap the
   * authorization code for user tokens. The OAuth token endpoint is strict:
   * the body must be application/x-www-form-urlencoded (URLSearchParams does
   * that), unlike the JSON client_credentials call above.
   */
  async exchangeV1Code({
    code,
    redirectUri,
  }: {
    code: string;
    redirectUri: string;
  }): Promise<TrueLayerV1TokenResponse> {
    try {
      const response = await this.auth.post<TrueLayerV1TokenResponse>(
        '/connect/token',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
        }),
      );
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && (error.response?.status === 400 || error.response?.status === 401)) {
        // Code invalid, expired, already used, or redirect_uri mismatch.
        throw new BadRequestError({
          message: t({ key: 'bankDataProviders.truelayer.invalidCode' }),
        });
      }
      throw error;
    }
  }

  /**
   * grant_type=refresh_token. TrueLayer ROTATES the refresh token on every
   * call, so the caller must persist the returned pair. A rejected grant
   * (expired/revoked consent) maps to ForbiddenError so the shared
   * auth-failure engine flips the connection to "reconnect".
   *
   * The unified auth server (/connect/token) handles the grant; apps whose
   * token endpoint predates it get a 404/unsupported_grant_type and we fall
   * back to the legacy api/token path.
   */
  async refreshV1Token(refreshToken: string): Promise<TrueLayerV1TokenResponse> {
    const form = () =>
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      });
    const isGrantRejected = (error: unknown) => {
      if (!axios.isAxiosError(error)) return undefined;
      const status = error.response?.status;
      const code = (error.response?.data as { error?: string } | undefined)?.error;
      // Endpoint/feature missing on the auth host: try the legacy endpoint.
      if (status === 404 || code === 'unsupported_grant_type') return 'fallback';
      // The refresh token itself died (expired consent or revoked app grant).
      if (status === 400 || status === 401 || status === 403) return 'dead';
      return undefined;
    };

    try {
      const response = await this.auth.post<TrueLayerV1TokenResponse>('/connect/token', form());
      return response.data;
    } catch (error) {
      const kind = isGrantRejected(error);
      if (kind === 'dead') {
        throw new ForbiddenError({
          message: t({ key: 'bankDataProviders.truelayer.consentNotActive' }),
        });
      }
      if (kind !== 'fallback') throw error;
    }

    try {
      const response = await this.api.post<TrueLayerV1TokenResponse>('/token', form());
      return response.data;
    } catch (error) {
      if (isGrantRejected(error) === 'dead') {
        throw new ForbiddenError({
          message: t({ key: 'bankDataProviders.truelayer.consentNotActive' }),
        });
      }
      throw error;
    }
  }

  /**
   * GET /data/v1/accounts + GET /data/v1/cards — merged into the shared
   * v3-shaped list. Card-only providers (Amex) answer 501 on /accounts, and
   * account-only providers 404/501 on /cards; an endpoint failing that way is
   * ignored, but a rejected consent (403) or both endpoints failing throws.
   */
  async v1GetAccounts(userToken: string): Promise<TrueLayerApiAccount[]> {
    const [accounts, cards] = await Promise.all([
      this.v1TryGet<TrueLayerV1AccountsResponse>(userToken, '/data/v1/accounts', 'v1GetAccounts'),
      this.v1TryGet<TrueLayerV1AccountsResponse>(userToken, '/data/v1/cards', 'v1GetCards'),
    ]);

    if (!accounts.ok && !cards.ok) throw accounts.error ?? cards.error;
    if (!accounts.ok && !accounts.unsupported) throw accounts.error;
    if (!cards.ok && !cards.unsupported) throw cards.error;

    const rows: TrueLayerApiAccount[] = [];
    if (accounts.ok) rows.push(...(accounts.data.results ?? []).map((row) => v1ProductToApiAccount(row, 'accounts')));
    if (cards.ok) rows.push(...(cards.data.results ?? []).map((row) => v1ProductToApiAccount(row, 'cards')));
    return rows;
  }

  /** GET /data/v1/{kind}/{id}/balance — UDM reports DECIMAL MAJOR units; convert to minor. */
  async v1GetAccountBalance(userToken: string, accountId: string): Promise<TrueLayerApiBalanceResponse> {
    // Cards are addressed under /data/v1/cards; the id alone doesn't say which,
    // so a miss on the accounts path retries the cards path.
    let data = await this.v1TryGet<TrueLayerV1BalancesResponse>(
      userToken,
      `/data/v1/accounts/${accountId}/balance`,
      'v1GetAccountBalance',
    );
    if (!data.ok && data.unsupported) {
      data = await this.v1TryGet<TrueLayerV1BalancesResponse>(
        userToken,
        `/data/v1/cards/${accountId}/balance`,
        'v1GetCardBalance',
      );
      if (!data.ok) throw data.error;
    }
    if (!data.ok) throw data.error;

    const balance: TrueLayerV1Balance | undefined = data.data.results?.[0];
    return {
      currency: balance?.currency ?? '',
      current_balance_in_minor: majorToMinorUnits(balance?.current ?? 0, balance?.currency ?? 'GBP'),
      available_balance_in_minor:
        balance?.available === undefined ? null : majorToMinorUnits(balance.available, balance.currency),
      overdraft_in_minor:
        balance?.overdraft === undefined ? null : majorToMinorUnits(balance.overdraft, balance.currency),
    };
  }

  /**
   * GET /data/v1/{kind}/{id}/transactions — signed major-unit amounts, no
   * status field (pending rows live on a separate endpoint this policy does
   * not consume), RFC 3339 dates. Pages are followed via the `Link: <…>; rel="next"` header, with a hard
   * ceiling so a bad cursor loop can't hang a sync. Like balance, a 404/501 on
   * the accounts path re-runs the whole loop against cards.
   */
  async v1GetTransactions({
    userToken,
    accountId,
    from,
    to,
    onPage,
  }: {
    userToken: string;
    accountId: string;
    from: Date;
    to: Date;
    onPage?: (transactions: TrueLayerApiTransaction[]) => void | Promise<void>;
  }): Promise<TrueLayerApiTransaction[]> {
    const range = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
    try {
      return await this.v1GetTransactionsPaged(
        userToken,
        `/data/v1/accounts/${accountId}/transactions?${range}`,
        onPage,
      );
    } catch (error) {
      if (!isV1UnsupportedPath(error)) throw this.handleApiError(error, 'v1GetTransactions');
      try {
        return await this.v1GetTransactionsPaged(
          userToken,
          `/data/v1/cards/${accountId}/transactions?${range}`,
          onPage,
        );
      } catch (cardsError) {
        throw this.handleApiError(cardsError, 'v1GetCardTransactions');
      }
    }
  }

  private async v1GetTransactionsPaged(
    userToken: string,
    firstUrl: string,
    onPage?: (transactions: TrueLayerApiTransaction[]) => void | Promise<void>,
  ): Promise<TrueLayerApiTransaction[]> {
    const all: TrueLayerApiTransaction[] = [];
    let url: string | undefined = firstUrl;

    for (let page = 0; page < V1_TX_MAX_PAGES && url; page += 1) {
      const response = await this.api.get<TrueLayerV1TransactionsResponse>(url, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const mapped = (response.data.results ?? []).map((tx) => v1ToApiTransaction(tx));
      all.push(...mapped);
      if (onPage) await onPage(mapped);
      url = parseLinkNextUrl(response.headers?.link);
    }

    return all;
  }

  /** Request that reports endpoint-kinds instead of throwing. `unsupported`
   * means the provider simply doesn't serve this product type (404/501). */
  private async v1TryGet<T>(
    userToken: string,
    url: string,
    method: string,
  ): Promise<{ ok: true; data: T } | { ok: false; unsupported: boolean; error: Error }> {
    try {
      const response = await this.api.get<T>(url, { headers: { Authorization: `Bearer ${userToken}` } });
      return { ok: true, data: response.data };
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const unsupported = status === 400 || status === 404 || status === 501;
      return { ok: false, unsupported, error: this.handleApiError(error, method) };
    }
  }

  /**
   * POST /v3/data-connections — start an authorization journey. The response's
   * `hosted_page.uri` is where the user's browser must go; the consent is
   * captured by TrueLayer during that journey (`authorization_flow_captured`).
   */
  async createDataConnection({
    returnUri,
    user,
    tlUserId,
  }: {
    returnUri: string;
    user: { name: string; email?: string | null };
    /** Reuse TrueLayer's end-user id on reauthorize so returning users get the short journey. */
    tlUserId?: string;
  }): Promise<TrueLayerApiCreatedConnection> {
    const token = await this.getAccessToken();

    try {
      const response = await this.api.post<TrueLayerApiCreatedConnection>(
        '/v3/data-connections',
        {
          scopes: ['accounts', 'balance', 'transactions'],
          provider_selection: {
            type: 'user_selected',
            filter: { countries: ['GB'], customer_segments: ['retail'] },
          },
          user: {
            ...(tlUserId ? { id: tlUserId } : {}),
            name: user.name,
            ...(user.email ? { email: user.email } : {}),
          },
          user_consent: { type: 'authorization_flow_captured' },
          hosted_page: { type: 'authorization_flow', return_uri: returnUri },
          data_access_type: 'recurring',
        },
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      );
      return response.data;
    } catch (error) {
      // A 403 here has two distinct causes the user can act on: the app isn't
      // provisioned for Data v3 (token lacks connections access) or the
      // return URI isn't registered in Console. Decode the bearer's claims to
      // tell them apart.
      if (axios.isAxiosError(error) && error.response?.status === 403 && !tokenGrantsDataAccess(token)) {
        throw new ForbiddenError({
          message: t({
            key: 'bankDataProviders.truelayer.dataProductNotEnabled',
          }),
        });
      }
      throw this.handleApiError(error, 'createDataConnection');
    }
  }

  /**
   * GET /v3/connected-accounts. With an unauthorized/expired Connection-Id
   * TrueLayer answers 400 `invalid_state`; `tolerateInvalidState` turns that
   * specific case into `null` (the confirm-poll reads it as "not yet
   * authorized") while everything else maps to typed errors.
   */
  async getConnectedAccounts({
    connectionId,
    tolerateInvalidState = false,
  }: {
    connectionId: string;
    tolerateInvalidState?: boolean;
  }): Promise<TrueLayerApiAccountsResponse | null> {
    try {
      const data = await this.dataRequest<TrueLayerApiAccountsResponse>(
        { method: 'get', url: '/v3/connected-accounts' },
        connectionId,
        'getConnectedAccounts',
        { tolerateInvalidState },
      );
      return data;
    } catch (error) {
      if (tolerateInvalidState && error === INVALID_STATE_SENTINEL) return null;
      throw error;
    }
  }

  /** GET /v3/connected-accounts — account summaries only, no error mapping magic. */
  async getAccount({
    connectionId,
    accountId,
  }: {
    connectionId: string;
    accountId: string;
  }): Promise<TrueLayerApiAccount> {
    const res = await this.getConnectedAccounts({ connectionId });
    const found = (res?.items ?? []).find((a) => a.id === accountId);
    if (!found) {
      throw new NotFoundError({
        message: t({ key: 'bankDataProviders.truelayer.accountNotFound' }),
      });
    }
    return found;
  }

  /** GET /v3/connected-accounts/{accountId}/balance */
  async getAccountBalance({
    connectionId,
    accountId,
  }: {
    connectionId: string;
    accountId: string;
  }): Promise<TrueLayerApiBalanceResponse> {
    return this.dataRequest<TrueLayerApiBalanceResponse>(
      { method: 'get', url: `/v3/connected-accounts/${accountId}/balance` },
      connectionId,
      'getAccountBalance',
    );
  }

  /**
   * Fetch every transaction in [from, to] via TrueLayer's async transactions
   * requests: POST a request, poll until `completed`, hand each page to
   * `onPage`, then chain the next page by creating a new request with the
   * `next_cursor`. Throws on `failed` or when polling exceeds the ceiling.
   *
   * TrueLayer's date range is day-precise and inclusive on both ends.
   */
  async getTransactions({
    connectionId,
    accountId,
    from,
    to,
    onPage,
  }: {
    connectionId: string;
    accountId: string;
    from: Date;
    to: Date;
    onPage?: (transactions: TrueLayerApiTransaction[]) => void | Promise<void>;
  }): Promise<TrueLayerApiTransaction[]> {
    const all: TrueLayerApiTransaction[] = [];
    let cursor: string | null = null;

    do {
      const created = await this.createTransactionsRequest({
        connectionId,
        accountId,
        from,
        to,
        cursor,
      });
      const completed = await this.pollTransactionsRequest({
        connectionId,
        accountId,
        requestId: created.id,
      });

      all.push(...completed.result.items);
      if (onPage) await onPage(completed.result.items);
      cursor = completed.result.pagination?.next_cursor ?? null;
    } while (cursor);

    return all;
  }

  private async createTransactionsRequest({
    connectionId,
    accountId,
    from,
    to,
    cursor,
  }: {
    connectionId: string;
    accountId: string;
    from: Date;
    to: Date;
    cursor?: string | null;
  }): Promise<TrueLayerTransactionsRequestResult> {
    const body: Record<string, unknown> = {
      from: toIsoDate(from),
      to: toIsoDate(to),
      page_size: TX_PAGE_SIZE,
    };
    if (cursor) body.cursor = cursor;

    return this.dataRequest<TrueLayerTransactionsRequestResult>(
      {
        method: 'post',
        url: `/v3/connected-accounts/${accountId}/transactions/requests`,
        data: body,
      },
      connectionId,
      'createTransactionsRequest',
    );
  }

  private async pollTransactionsRequest({
    connectionId,
    accountId,
    requestId,
  }: {
    connectionId: string;
    accountId: string;
    requestId: string;
  }): Promise<TrueLayerTransactionsRequestCompleted> {
    for (let attempt = 0; attempt < TX_POLL_MAX_ATTEMPTS; attempt += 1) {
      const result = await this.dataRequest<TrueLayerTransactionsRequestResult>(
        {
          method: 'get',
          url: `/v3/connected-accounts/${accountId}/transactions/requests/${requestId}`,
        },
        connectionId,
        'getTransactionsRequest',
      );

      if (result.status === 'completed') return result;

      if (result.status === 'failed') {
        logger.info(
          `[TrueLayerApiClient] transactions request ${requestId} failed: ${result.failure_reason ?? 'unknown'}`,
        );
        throw new ServiceUnavailableError({
          message: t({
            key: 'bankDataProviders.truelayer.transactionsRequestFailed',
          }),
        });
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, TX_POLL_INTERVAL_MS);
      await promise;
    }

    throw new ServiceUnavailableError({
      message: t({
        key: 'bankDataProviders.truelayer.transactionsRequestTimeout',
      }),
    });
  }

  private async dataRequest<T>(
    config: Parameters<AxiosInstance['request']>[0],
    connectionId: string,
    method: string,
    opts: { tolerateInvalidState?: boolean } = {},
  ): Promise<T> {
    const token = await this.getAccessToken();

    try {
      const response = await this.api.request<T>({
        ...config,
        headers: {
          ...(config.headers as Record<string, string>),
          Authorization: `Bearer ${token}`,
          'Connection-Id': connectionId,
        },
      });
      return response.data;
    } catch (error) {
      throw this.handleApiError(error, method, opts.tolerateInvalidState);
    }
  }

  /**
   * Map axios errors to typed application errors. `invalid_state` (consent not
   * active: unauthorized, expired or revoked) becomes a ForbiddenError so the
   * shared auth-failure engine deactivates the connection and the UI prompts a
   * reconnect. With `tolerateInvalidState` it surfaces as the sentinel instead.
   */
  private handleApiError(error: unknown, method: string, tolerateInvalidState = false): Error {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const problem = (error.response?.data ?? {}) as TrueLayerProblemDetails;
      const detail = problem.detail || problem.title || problem.error_description;

      logger.info(`[TrueLayerApiClient] ${method} failed: status=${status}, detail=${detail}`);

      // One-shot token invalidation: a rejected bearer means the cached token
      // died early (e.g. app credentials changed in Console); the next call
      // will fetch a fresh one.
      if (status === 401) this.invalidateToken();

      if (status === 400 && isInvalidState(problem)) {
        if (tolerateInvalidState) return INVALID_STATE_SENTINEL;
        return new ForbiddenError({
          message: t({ key: 'bankDataProviders.truelayer.consentNotActive' }),
        });
      }

      // v1 data calls answer 403 `access_denied` when the bearer's consent is
      // gone — same "reconnect" treatment as v3's invalid_state.
      if (status === 403 && problem.error === 'access_denied') {
        return new ForbiddenError({
          message: t({ key: 'bankDataProviders.truelayer.consentNotActive' }),
        });
      }

      // TrueLayer refuses to start an authorization journey when this
      // instance's callback URL is not in the app's Redirect URIs list.
      if (status === 403 && method === 'createDataConnection') {
        return new ForbiddenError({
          message: t({
            key: 'bankDataProviders.truelayer.redirectUriNotRegistered',
          }),
        });
      }

      if (status === 401 || status === 403) {
        return new ForbiddenError({
          message: detail || t({ key: 'bankDataProviders.truelayer.invalidCredentials' }),
        });
      }

      if (status === 404) {
        return new NotFoundError({
          message: detail || t({ key: 'bankDataProviders.truelayer.accountNotFound' }),
        });
      }

      if (status === 429) {
        return new ServiceUnavailableError({
          message: detail || t({ key: 'bankDataProviders.truelayer.rateLimited' }),
        });
      }

      if (status && status >= 500) {
        return new ServiceUnavailableError({
          message: detail || t({ key: 'bankDataProviders.truelayer.providerError' }),
        });
      }

      if (status && status >= 400) {
        return new BadRequestError({
          message:
            detail ||
            t({
              key: 'bankDataProviders.apiError',
              variables: { provider: 'TrueLayer', message: error.message },
            }),
        });
      }
    }

    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Distinct object identity for the tolerated invalid_state case. */
const INVALID_STATE_SENTINEL = new Error('truelayer:invalid_state');

const isInvalidState = (problem: TrueLayerProblemDetails): boolean =>
  typeof problem?.type === 'string' && problem.type.includes('invalid_state');

/** TrueLayer date params are `YYYY-MM-DD`. */
export const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Convert a TrueLayer minor-unit integer (signed) to MoneyMatter cents for a
 * specific currency. GBP/EUR minor units ARE cents; zero-decimal currencies
 * (JPY…) need ×100, three-decimal ones (BHD…) ÷10.
 */
const fractionDigitsCache = new Map<string, number>();
export const centsFromMinorUnits = (minor: number, currency: string): number => {
  // cents = minor units × 10^(2 − minorDigits)
  return Math.round(minor * 10 ** (2 - fractionDigits(currency)));
};

/** Decimal fraction digits for a currency (2 for GBP/EUR, 0 for JPY…). */
const fractionDigits = (currency: string): number => {
  let digits = fractionDigitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat('en', {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits as number;
    } catch {
      digits = 2;
    }
    fractionDigitsCache.set(currency, digits);
  }
  return digits;
};

/**
 * v1 (Unified Data Model) reports amounts as DECIMAL MAJOR units where v3
 * reports minor-unit integers — convert back so one shared mapping path serves
 * both. Sign is preserved (negative = debit in both shapes).
 */
export const majorToMinorUnits = (major: number, currency: string): number =>
  Math.round(major * 10 ** fractionDigits(currency));

/** Scopes the v1 authorization link must carry for recurring sync. */
const V1_SCOPE = 'info accounts balance transactions cards offline_access';

/** Link-header page ceiling; TrueLayer v1 pages at 100 rows. */
const V1_TX_MAX_PAGES = 200;

/** UDM account types (CURRENT_ACCOUNT…) → v3 vocabulary (current…). */
const normalizeV1AccountType = (raw?: string): string => {
  if (!raw) return 'other';
  const key = raw.toLowerCase().replace(/_account$/, '');
  return ['current', 'savings', 'credit', 'charge', 'cash', 'pension', 'mortgage', 'branch', 'other'].includes(key)
    ? key
    : 'other';
};

/** TrueLayer UDM row → the shared v3-shaped account used by picker + sync. */
const v1ProductToApiAccount = (row: TrueLayerV1Account, kind: 'accounts' | 'cards'): TrueLayerApiAccount => ({
  id: (kind === 'cards' ? (row.card_id ?? row.account_id) : (row.account_id ?? row.card_id)) ?? '',
  type: kind === 'cards' ? ('card' as const) : ('account' as const),
  currency: row.currency,
  account_type: normalizeV1AccountType(
    kind === 'cards' ? (row.card_type ?? row.account_type ?? 'credit') : row.account_type,
  ),
  account_identifiers: v1ProductIdentifiers(row, kind),
  account_holder_names: row.display_name ? [row.display_name] : row.name_on_card ? [row.name_on_card] : [],
  bic: null,
  customer_segment: 'retail' as const,
});

/** A raw (unmapped) v1 data error saying the provider doesn't serve that
 * product kind — the signal to retry the sibling endpoint. TrueLayer answers
 * 501 (feature absent), 404 (unknown id) or 400 (id not an account/card of
 * this kind) depending on the endpoint. */
const isV1UnsupportedPath = (error: unknown): boolean =>
  axios.isAxiosError(error) && [400, 404, 501].includes(error.response?.status ?? -1);

const v1ProductIdentifiers = (account: TrueLayerV1Account, kind: 'accounts' | 'cards') => {
  if (kind === 'cards') {
    const lastFour = account.last_four_digits ?? account.account_number?.number?.replace(/\D/g, '').slice(-4);
    return lastFour ? [{ type: 'card_pan_last4' as const, last_four: lastFour }] : [];
  }
  const number = account.account_number?.number?.replace(/[\s-]/g, '');
  if (!number) return [];
  const sortCode = account.account_number?.sort_code?.replace(/[\s-]/g, '');
  return [
    {
      type: 'sort_code_account_number' as const,
      sort_code: sortCode ?? '',
      account_number: number,
    },
  ];
};

const v1ToApiTransaction = (tx: TrueLayerV1Transaction): TrueLayerApiTransaction => ({
  id: tx.normalised_provider_transaction_id || tx.provider_transaction_id || tx.transaction_id,
  timestamp: tx.timestamp,
  description: tx.description ?? '',
  currency: tx.currency,
  amount_in_minor: majorToMinorUnits(tx.amount, tx.currency),
  // The UDM shape serves booked rows only; no status field.
  status: 'settled',
  enrichment: {
    merchant_name: tx.merchant_name ?? null,
    transaction_category: tx.transaction_category ?? null,
  },
});

/** Extract the `rel="next"` target from a v1 Link header (absolute URL). */
const parseLinkNextUrl = (link: unknown): string | undefined => {
  if (typeof link !== 'string') return undefined;
  for (const part of link.split(',')) {
    const [href, ...params] = part.trim().split(';');
    if (!href) continue;
    if (params.some((p) => p.trim() === 'rel="next"' || p.trim() === 'rel=next')) {
      return href.trim().replace(/^<|>$/g, '');
    }
  }
  return undefined;
};
