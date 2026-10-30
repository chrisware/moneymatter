import { t } from '@i18n/index';
import { BadRequestError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '@js/errors';
import { logger } from '@js/utils/logger';
import axios, { AxiosInstance } from 'axios';
import { createHash, randomBytes } from 'node:crypto';

import type {
  TrueLayerAccount,
  TrueLayerAccountIdentifier,
  TrueLayerAppTokenResponse,
  TrueLayerBalanceResponse,
  TrueLayerCredentials,
  TrueLayerEnvironment,
  TrueLayerProblemDetails,
  TrueLayerTokenResponse,
  TrueLayerTransaction,
  TrueLayerUdmAccount,
  TrueLayerUdmAccountsResponse,
  TrueLayerUdmBalance,
  TrueLayerUdmBalancesResponse,
  TrueLayerUdmTransaction,
  TrueLayerUdmTransactionsResponse,
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

/** Scopes the authorization link must carry for recurring sync. */
const AUTH_SCOPE = 'info accounts balance transactions cards offline_access';

/** Link-header page ceiling; TrueLayer pages at 100 rows. */
const TX_MAX_PAGES = 200;

interface CachedToken {
  token: string;
  expiresAt: number;
  inflight?: Promise<string>;
}

/**
 * Cross-instance app-token cache, keyed by environment + clientId. The
 * client_credentials token is app-level (~15 min lifetime) and every
 * connection of one TrueLayer app shares it, so probing several connections
 * of the same app doesn't multiply token round-trips. Cleared by expiry.
 */
const tokenCache = new Map<string, CachedToken>();

/**
 * Classify a refresh-grant failure: 'fallback' = the auth host doesn't serve
 * the grant (endpoint missing, legacy app); 'dead' = the refresh token itself
 * died (expired consent or revoked app grant); undefined = pass through.
 */
const classifyRefreshError = (error: unknown): 'fallback' | 'dead' | undefined => {
  if (!axios.isAxiosError(error)) return undefined;
  const status = error.response?.status;
  const code = (error.response?.data as { error?: string } | undefined)?.error;
  // Endpoint/feature missing on the auth host: try the legacy endpoint.
  if (status === 404 || code === 'unsupported_grant_type') return 'fallback';
  // The refresh token itself died (expired consent or revoked app grant).
  if (status === 400 || status === 401 || status === 403) return 'dead';
  return undefined;
};

/**
 * TrueLayer Legacy Data API v1 client (OAuth authorization-code flow).
 *
 * The user authorizes via a built authorization link on the auth host; the
 * resulting code is exchanged there for a per-user bearer + rotating refresh
 * token (refreshed at the same endpoint, with the legacy POST /token as
 * fallback). Data calls are plain GETs against /data/v1/accounts,
 * /data/v1/cards and /data/v1/{kind}/{id}/{balance|transactions}; their UDM
 * payloads (decimal MAJOR units) are mapped into the minor-unit types here so
 * the provider works purely in integer cents.
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
   * refresh; a 401 from any endpoint should call `invalidateToken()` first so
   * the next request re-fetches.
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
      // configured scope set.
      const response = await this.auth.post<TrueLayerAppTokenResponse>('/connect/token', {
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
  // Authorization journey
  // ==========================================================================

  /**
   * Build the hosted authorization link. No API call is needed: it is a pure
   * redirect with query params. `state` is a caller-generated CSRF token
   * echoed back on the redirect; the nonce is fresh per link.
   */
  buildAuthUrl({ redirectUri, state }: { redirectUri: string; state: string }): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.credentials.clientId,
      scope: AUTH_SCOPE,
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
  async exchangeCode({ code, redirectUri }: { code: string; redirectUri: string }): Promise<TrueLayerTokenResponse> {
    try {
      const response = await this.auth.post<TrueLayerTokenResponse>(
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
  async refreshToken(refreshToken: string): Promise<TrueLayerTokenResponse> {
    const form = () =>
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      });

    try {
      const response = await this.auth.post<TrueLayerTokenResponse>('/connect/token', form());
      return response.data;
    } catch (error) {
      const kind = classifyRefreshError(error);
      if (kind === 'dead') {
        throw new ForbiddenError({
          message: t({ key: 'bankDataProviders.truelayer.consentNotActive' }),
        });
      }
      if (kind !== 'fallback') throw error;
    }

    try {
      const response = await this.api.post<TrueLayerTokenResponse>('/token', form());
      return response.data;
    } catch (error) {
      if (classifyRefreshError(error) === 'dead') {
        throw new ForbiddenError({
          message: t({ key: 'bankDataProviders.truelayer.consentNotActive' }),
        });
      }
      throw error;
    }
  }

  // ==========================================================================
  // Data endpoints
  // ==========================================================================

  /**
   * GET /data/v1/accounts + GET /data/v1/cards — merged into one normalized
   * list. Card-only providers (Amex) answer 501 on /accounts, and
   * account-only providers 404/501 on /cards; an endpoint failing that way is
   * ignored, but a rejected consent (403) or both endpoints failing throws.
   */
  async getAccounts(userToken: string): Promise<TrueLayerAccount[]> {
    const [accounts, cards] = await Promise.all([
      this.tryGet<TrueLayerUdmAccountsResponse>(userToken, '/data/v1/accounts', 'getAccounts'),
      this.tryGet<TrueLayerUdmAccountsResponse>(userToken, '/data/v1/cards', 'getCards'),
    ]);

    if (!accounts.ok && !cards.ok) throw accounts.error ?? cards.error;
    if (!accounts.ok && !accounts.unsupported) throw accounts.error;
    if (!cards.ok && !cards.unsupported) throw cards.error;

    const rows: TrueLayerAccount[] = [];
    if (accounts.ok) rows.push(...(accounts.data.results ?? []).map((row) => udmProductToAccount(row, 'accounts')));
    if (cards.ok) rows.push(...(cards.data.results ?? []).map((row) => udmProductToAccount(row, 'cards')));
    return rows;
  }

  /** GET /data/v1/{kind}/{id}/balance — UDM reports DECIMAL MAJOR units; convert to minor. */
  async getAccountBalance(userToken: string, accountId: string): Promise<TrueLayerBalanceResponse> {
    // Cards are addressed under /data/v1/cards; the id alone doesn't say which,
    // so a miss on the accounts path retries the cards path.
    let data = await this.tryGet<TrueLayerUdmBalancesResponse>(
      userToken,
      `/data/v1/accounts/${accountId}/balance`,
      'getAccountBalance',
    );
    if (!data.ok && data.unsupported) {
      data = await this.tryGet<TrueLayerUdmBalancesResponse>(
        userToken,
        `/data/v1/cards/${accountId}/balance`,
        'getCardBalance',
      );
      if (!data.ok) throw data.error;
    }
    if (!data.ok) throw data.error;

    const balance: TrueLayerUdmBalance | undefined = data.data.results?.[0];
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
  async getTransactions({
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
    onPage?: (transactions: TrueLayerTransaction[]) => void | Promise<void>;
  }): Promise<TrueLayerTransaction[]> {
    const range = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
    try {
      return await this.getTransactionsPaged(userToken, `/data/v1/accounts/${accountId}/transactions?${range}`, onPage);
    } catch (error) {
      if (!isUnsupportedPath(error)) throw this.handleApiError(error, 'getTransactions');
      try {
        return await this.getTransactionsPaged(userToken, `/data/v1/cards/${accountId}/transactions?${range}`, onPage);
      } catch (cardsError) {
        throw this.handleApiError(cardsError, 'getCardTransactions');
      }
    }
  }

  private async getTransactionsPaged(
    userToken: string,
    firstUrl: string,
    onPage?: (transactions: TrueLayerTransaction[]) => void | Promise<void>,
  ): Promise<TrueLayerTransaction[]> {
    const all: TrueLayerTransaction[] = [];
    let url: string | undefined = firstUrl;

    for (let page = 0; page < TX_MAX_PAGES && url; page += 1) {
      const response = await this.api.get<TrueLayerUdmTransactionsResponse>(url, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      const mapped = (response.data.results ?? []).map((tx) => udmToTransaction(tx));
      all.push(...mapped);
      if (onPage) await onPage(mapped);
      url = parseLinkNextUrl(response.headers?.link);
    }

    return all;
  }

  /** Request that reports endpoint-kinds instead of throwing. `unsupported`
   * means the provider simply doesn't serve this product type (404/501). */
  private async tryGet<T>(
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
   * Map axios errors to typed application errors. A 403 `access_denied` means
   * the bearer's consent is gone — it becomes a ForbiddenError so the shared
   * auth-failure engine deactivates the connection and the UI prompts a
   * reconnect.
   */
  private handleApiError(error: unknown, method: string): Error {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const problem = (error.response?.data ?? {}) as TrueLayerProblemDetails;
      const detail = problem.detail || problem.title || problem.error_description;

      logger.info(`[TrueLayerApiClient] ${method} failed: status=${status}, detail=${detail}`);

      // One-shot token invalidation: a rejected bearer means the cached token
      // died early (e.g. app credentials changed in Console); the next call
      // will fetch a fresh one.
      if (status === 401) this.invalidateToken();

      // Data calls answer 403 `access_denied` when the bearer's consent is
      // gone — surface as "reconnect".
      if (status === 403 && problem.error === 'access_denied') {
        return new ForbiddenError({
          message: t({ key: 'bankDataProviders.truelayer.consentNotActive' }),
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
 * The UDM reports amounts as DECIMAL MAJOR units — convert to minor units so
 * the provider's persistence math stays integer-based. Sign is preserved
 * (negative = debit in both shapes).
 */
export const majorToMinorUnits = (major: number, currency: string): number =>
  Math.round(major * 10 ** fractionDigits(currency));

/** UDM account types (CURRENT_ACCOUNT…) → the internal vocabulary (current…). */
const normalizeAccountType = (raw?: string): string => {
  if (!raw) return 'other';
  const key = raw.toLowerCase().replace(/_account$/, '');
  return ['current', 'savings', 'credit', 'charge', 'cash', 'pension', 'mortgage', 'branch', 'other'].includes(key)
    ? key
    : 'other';
};

/** TrueLayer UDM product row → the normalized account used by picker + sync. */
const udmProductToAccount = (row: TrueLayerUdmAccount, kind: 'accounts' | 'cards'): TrueLayerAccount => ({
  id: (kind === 'cards' ? (row.card_id ?? row.account_id) : (row.account_id ?? row.card_id)) ?? '',
  type: kind === 'cards' ? ('card' as const) : ('account' as const),
  currency: row.currency,
  account_type: normalizeAccountType(
    kind === 'cards' ? (row.card_type ?? row.account_type ?? 'credit') : row.account_type,
  ),
  account_identifiers: udmProductIdentifiers(row, kind),
  account_holder_names: row.display_name ? [row.display_name] : row.name_on_card ? [row.name_on_card] : [],
  bic: null,
  customer_segment: 'retail' as const,
});

/** A raw (unmapped) data error saying the provider doesn't serve that
 * product kind — the signal to retry the sibling endpoint. TrueLayer answers
 * 501 (feature absent), 404 (unknown id) or 400 (id not an account/card of
 * this kind) depending on the endpoint. */
const isUnsupportedPath = (error: unknown): boolean =>
  axios.isAxiosError(error) && [400, 404, 501].includes(error.response?.status ?? -1);

const udmProductIdentifiers = (
  account: TrueLayerUdmAccount,
  kind: 'accounts' | 'cards',
): TrueLayerAccountIdentifier[] => {
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

const udmToTransaction = (tx: TrueLayerUdmTransaction): TrueLayerTransaction => ({
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

/** Extract the `rel="next"` target from a Link header (absolute URL). */
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
