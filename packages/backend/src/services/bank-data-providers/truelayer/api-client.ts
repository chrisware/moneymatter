import { t } from '@i18n/index';
import { BadRequestError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '@js/errors';
import { logger } from '@js/utils/logger';
import axios, { AxiosInstance } from 'axios';
import { createHash } from 'node:crypto';

import type {
  TrueLayerApiAccessTokenResponse,
  TrueLayerApiAccount,
  TrueLayerApiAccountsResponse,
  TrueLayerApiBalanceResponse,
  TrueLayerApiCreatedConnection,
  TrueLayerCredentials,
  TrueLayerEnvironment,
  TrueLayerProblemDetails,
  TrueLayerTransactionsRequestCompleted,
  TrueLayerTransactionsRequestResult,
  TrueLayerApiTransaction,
} from './types';

const HOSTS: Record<TrueLayerEnvironment, { auth: string; api: string }> = {
  production: { auth: 'https://auth.truelayer.com', api: 'https://api.truelayer.com' },
  sandbox: { auth: 'https://auth.truelayer-sandbox.com', api: 'https://api.truelayer-sandbox.com' },
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
 * Does this access token carry TrueLayer Data v3 access? Provisioned apps get
 * `connections:create` in scope / `connections_api` in the audience (and v3
 * apps the literal `data` scope). Tokens we can't decode (opaque mocks) are
 * assumed provisioned so the more common redirect-URI hint wins.
 */
function tokenGrantsDataAccess(jwt: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as {
      scope?: string | string[];
      aud?: string | string[];
    };
    const scope = Array.isArray(payload.scope) ? payload.scope.join(' ') : (payload.scope ?? '');
    const aud = Array.isArray(payload.aud) ? payload.aud.join(' ') : (payload.aud ?? '');
    return scope.includes('data') || scope.includes('connections:create') || aud.includes('connections_api');
  } catch {
    return true;
  }
}

/**
 * TrueLayer Data API v3 client.
 *
 * Auth model: POST /connect/token (grant_type=client_credentials, scope `data`)
 * for a short-lived bearer, cached per app; every data call adds
 * `Connection-Id` identifying the user's authorized data connection.
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

    tokenCache.set(this.cacheKey, { token: cached?.token ?? '', expiresAt: 0, inflight });

    const token = await inflight;
    return token;
  }

  invalidateToken(): void {
    tokenCache.delete(this.cacheKey);
  }

  private async fetchAccessToken(): Promise<string> {
    try {
      // No scope parameter: the token carries the app's full dashboard-
      // configured scope set (v3-capable apps include connections:create /
      // connections_api there; the literal `data` scope name doesn't exist
      // on the auth server for every app).
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
          throw new ForbiddenError({ message: t({ key: 'bankDataProviders.truelayer.invalidCredentials' }) });
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
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } },
      );
      return response.data;
    } catch (error) {
      // A 403 here has two distinct causes the user can act on: the app isn't
      // provisioned for Data v3 (token lacks connections access) or the
      // return URI isn't registered in Console. Decode the bearer's claims to
      // tell them apart.
      if (axios.isAxiosError(error) && error.response?.status === 403 && !tokenGrantsDataAccess(token)) {
        throw new ForbiddenError({ message: t({ key: 'bankDataProviders.truelayer.dataProductNotEnabled' }) });
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
      throw new NotFoundError({ message: t({ key: 'bankDataProviders.truelayer.accountNotFound' }) });
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
      const created = await this.createTransactionsRequest({ connectionId, accountId, from, to, cursor });
      const completed = await this.pollTransactionsRequest({ connectionId, accountId, requestId: created.id });

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
      { method: 'post', url: `/v3/connected-accounts/${accountId}/transactions/requests`, data: body },
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
        { method: 'get', url: `/v3/connected-accounts/${accountId}/transactions/requests/${requestId}` },
        connectionId,
        'getTransactionsRequest',
      );

      if (result.status === 'completed') return result;

      if (result.status === 'failed') {
        logger.info(
          `[TrueLayerApiClient] transactions request ${requestId} failed: ${result.failure_reason ?? 'unknown'}`,
        );
        throw new ServiceUnavailableError({
          message: t({ key: 'bankDataProviders.truelayer.transactionsRequestFailed' }),
        });
      }

      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, TX_POLL_INTERVAL_MS);
      await promise;
    }

    throw new ServiceUnavailableError({
      message: t({ key: 'bankDataProviders.truelayer.transactionsRequestTimeout' }),
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
      const detail = problem.detail || problem.title;

      logger.info(`[TrueLayerApiClient] ${method} failed: status=${status}, detail=${detail}`);

      // One-shot token invalidation: a rejected bearer means the cached token
      // died early (e.g. app credentials changed in Console); the next call
      // will fetch a fresh one.
      if (status === 401) this.invalidateToken();

      if (status === 400 && isInvalidState(problem)) {
        if (tolerateInvalidState) return INVALID_STATE_SENTINEL;
        return new ForbiddenError({ message: t({ key: 'bankDataProviders.truelayer.consentNotActive' }) });
      }

      // TrueLayer refuses to start an authorization journey when this
      // instance's callback URL is not in the app's Redirect URIs list.
      if (status === 403 && method === 'createDataConnection') {
        return new ForbiddenError({ message: t({ key: 'bankDataProviders.truelayer.redirectUriNotRegistered' }) });
      }

      if (status === 401 || status === 403) {
        return new ForbiddenError({ message: detail || t({ key: 'bankDataProviders.truelayer.invalidCredentials' }) });
      }

      if (status === 404) {
        return new NotFoundError({ message: detail || t({ key: 'bankDataProviders.truelayer.accountNotFound' }) });
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
            t({ key: 'bankDataProviders.apiError', variables: { provider: 'TrueLayer', message: error.message } }),
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
  let digits = fractionDigitsCache.get(currency);
  if (digits === undefined) {
    try {
      digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
        .maximumFractionDigits as number;
    } catch {
      digits = 2;
    }
    fractionDigitsCache.set(currency, digits);
  }
  // cents = minor units × 10^(2 − minorDigits)
  return Math.round(minor * 10 ** (2 - digits));
};
