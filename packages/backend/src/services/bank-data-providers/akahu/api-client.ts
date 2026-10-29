import { t } from '@i18n/index';
import { BadRequestError, ForbiddenError, NotFoundError, ServiceUnavailableError } from '@js/errors';
import { logger } from '@js/utils/logger';
import axios, { AxiosInstance } from 'axios';

import type {
  AkahuApiAccountResponse,
  AkahuApiAccountsResponse,
  AkahuApiMe,
  AkahuApiSimpleResponse,
  AkahuApiTransaction,
  AkahuApiTransactionsResponse,
  AkahuCredentials,
} from './types';

/**
 * Akahu API client
 * Handles all HTTP communication with Akahu's Enduring API.
 *
 * Auth model (personal apps): two static tokens per request —
 * `Authorization: Bearer <userToken>` and `X-Akahu-Id: <appToken>`.
 *
 * API Documentation: https://developers.akahu.nz/
 */
export class AkahuApiClient {
  private readonly baseURL = 'https://api.akahu.io/v1';
  private client: AxiosInstance;

  constructor(credentials: AkahuCredentials) {
    this.client = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authorization: `Bearer ${credentials.userToken}`,
        'X-Akahu-Id': credentials.appToken,
      },
      timeout: 30000,
    });
  }

  /**
   * Test if the token pair is valid via the /me endpoint.
   * Returns false only for 401/403; network/5xx errors propagate so callers
   * can distinguish "invalid tokens" from "provider is down".
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.getMe();
      return true;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
          return false;
        }
      }
      throw error;
    }
  }

  /**
   * GET /me — authenticated user, incl. `access_granted_at` (history bound).
   */
  async getMe(): Promise<AkahuApiMe> {
    try {
      const response = await this.client.get<AkahuApiMe>('/me');
      return response.data;
    } catch (error) {
      this.handleApiError(error, 'getMe');
    }
  }

  /**
   * GET /accounts — list all connected accounts (each carries its balance).
   */
  async getAccounts(): Promise<AkahuApiAccountsResponse> {
    try {
      const response = await this.client.get<AkahuApiAccountsResponse>('/accounts');
      return response.data;
    } catch (error) {
      this.handleApiError(error, 'getAccounts');
    }
  }

  /**
   * GET /accounts/:accountId — single account (balance + refresh timestamps).
   */
  async getAccount({ accountId }: { accountId: string }): Promise<AkahuApiAccountResponse> {
    try {
      const response = await this.client.get<AkahuApiAccountResponse>(`/accounts/${accountId}`);
      return response.data;
    } catch (error) {
      this.handleApiError(error, 'getAccount');
    }
  }

  /**
   * GET /accounts/:accountId/transactions — settled transactions for one
   * account, following `cursor.next` pagination until exhausted (Akahu pages
   * ~100 rows and does not allow changing the page size).
   *
   * `start` is EXCLUSIVE and `end` INCLUSIVE on the transaction `date`.
   * When `start` is provided, requests are clamped to no earlier than
   * `historyFloor` — Akahu personal apps can only see 730 days back from the
   * consent date, and an out-of-window start silently truncates results.
   */
  async getTransactions({
    accountId,
    start,
    end,
    onBatch,
  }: {
    accountId: string;
    start?: Date;
    end?: Date;
    onBatch?: (transactions: AkahuApiTransaction[]) => void | Promise<void>;
  }): Promise<AkahuApiTransaction[]> {
    const all: AkahuApiTransaction[] = [];
    let cursor: string | null = null;

    do {
      const params: Record<string, string> = {};
      if (start) params.start = start.toISOString();
      if (end) params.end = end.toISOString();
      if (cursor) params.cursor = cursor;

      let response: AkahuApiTransactionsResponse;
      try {
        const res = await this.client.get<AkahuApiTransactionsResponse>(`/accounts/${accountId}/transactions`, {
          params,
        });
        response = res.data;
      } catch (error) {
        this.handleApiError(error, 'getTransactions');
      }

      all.push(...response.items);
      if (onBatch) await onBatch(response.items);
      cursor = response.cursor?.next ?? null;
    } while (cursor);

    return all;
  }

  /**
   * POST /refresh — request an on-demand refresh of all the user's connected
   * accounts. Personal apps have a manual-refresh rest period (up to 1h);
   * Akahu answers 429 when a refresh ran recently, which is a benign no-op
   * for us — the scheduled daily refresh keeps data fresh regardless.
   *
   * @returns true when the refresh was accepted, false when it was throttled
   * or otherwise refused.
   */
  async requestRefresh(): Promise<boolean> {
    try {
      const response = await this.client.post<AkahuApiSimpleResponse>('/refresh');
      return response.data.success === true;
    } catch (error) {
      if (axios.isAxiosError(error) && (error.response?.status === 429 || error.response?.status === 400)) {
        logger.info(
          `[AkahuApiClient] requestRefresh throttled: ${error.response?.data?.message ?? error.response?.status}`,
        );
        return false;
      }
      // Any other failure (network, 5xx) must not fail the sync — the caller
      // degrades to reading cached data.
      logger.info(`[AkahuApiClient] requestRefresh failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /**
   * Map raw axios errors to typed application errors.
   * Callers decide whether to log/report — this method does not log to avoid
   * duplicate Sentry events when callers gracefully handle the error
   * (e.g., Promise.allSettled fallback paths).
   */
  private handleApiError(error: unknown, method: string): never {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      const errorMessage = error.response?.data?.message;

      logger.info(`[AkahuApiClient] ${method} failed: status=${status}, errorMessage=${errorMessage}`);

      if (status === 401 || status === 403) {
        // 403 usually means the required X-Akahu-Id header was rejected.
        throw new ForbiddenError({
          message: errorMessage || t({ key: 'bankDataProviders.akahu.invalidTokens' }),
        });
      } else if (status === 404) {
        throw new NotFoundError({
          message: errorMessage || t({ key: 'bankDataProviders.akahu.accountNotFound' }),
        });
      } else if (status === 429) {
        throw new ServiceUnavailableError({
          message: errorMessage || t({ key: 'bankDataProviders.akahu.rateLimited' }),
        });
      } else if (status && status >= 400) {
        throw new BadRequestError({
          message:
            errorMessage ||
            t({
              key: 'bankDataProviders.apiError',
              variables: { provider: 'Akahu', message: error.message },
            }),
        });
      }
    }

    throw error;
  }
}
