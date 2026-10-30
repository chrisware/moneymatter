import { BANK_PROVIDER_TYPE, TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import Transactions from '@models/transactions.model';
import { bankProviderRegistry } from '@root/services/bank-data-providers';
import type { TrueLayerProvider } from '@services/bank-data-providers/truelayer';
import * as helpers from '@tests/helpers';
import {
  TRUELAYER_ACCOUNT_1_ID,
  TRUELAYER_ACCOUNT_2_ID,
  TRUELAYER_CARD_ID,
  TRUELAYER_CONNECTION_ID,
  getMockedTrueLayerAccount,
  getMockedTrueLayerCreateConnectionResponse,
  getMockedTrueLayerFailedTransactionsResultResponse,
  getMockedTrueLayerTransaction,
  getMockedTrueLayerTransactionsResultResponse,
} from '@tests/mocks/truelayer/data';
import {
  INVALID_TL_CLIENT_SECRET,
  TL_API_BASE_URL,
  TL_AUTH_BASE_URL,
  VALID_TL_CLIENT_ID,
  VALID_TL_CLIENT_SECRET,
  getTrueLayerAccountsMock,
  getTrueLayerPaymentsOnlyTokenMock,
  getTrueLayerPendingAccountsMock,
  getTrueLayerTransactionsRequestErrorMock,
  getTrueLayerTransactionsResultMock,
} from '@tests/mocks/truelayer/mock-api';
import { HttpResponse, http } from 'msw';

/**
 * E2E tests for the TrueLayer (UK open banking, Data API v3) provider.
 * Covers the hosted authorization journey (connect → pending → confirm),
 * minor-unit sync math, async transactions-request polling, reauthorize
 * external-id re-linking, period load, credential updates, disconnect.
 */
describe('TrueLayer Data Provider E2E', () => {
  describe('Connection management', () => {
    it('is listed as a supported provider', async () => {
      const { providers } = await helpers.bankDataProviders.getSupportedBankProviders({ raw: true });

      const provider = providers.find((p: { type: string }) => p.type === BANK_PROVIDER_TYPE.TRUELAYER);
      expect(provider).toBeDefined();
      expect(provider!.name).toBe('TrueLayer');
      expect(provider!.features.supportsAutoSync).toBe(true);
      expect(provider!.features.supportsWebhooks).toBe(false);
      expect(provider!.features.requiresReauth).toBe(true);
    });

    it('creates a pending inactive connection and returns the hosted-page authUrl', async () => {
      const { connectionId, authUrl } = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
        credentials: { clientId: VALID_TL_CLIENT_ID, clientSecret: VALID_TL_CLIENT_SECRET },
        raw: true,
      });

      expect(connectionId).toBeDefined();
      expect(authUrl).toContain(`connection-id=${TRUELAYER_CONNECTION_ID}`);

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({ connectionId, raw: true });
      expect(connection.isActive).toBe(false);
    });

    it('routes manual-return journeys to the TrueLayer console redirect page', async () => {
      const returnUris: string[] = [];
      global.mswMockServer.use(
        http.post(`${TL_API_BASE_URL}/v3/data-connections`, async ({ request }) => {
          // msw hands back unknown JSON; only the return URI matters here.
          const body = (await request.json().catch(() => null)) as {
            hosted_page?: { return_uri?: string };
          } | null;
          returnUris.push(body?.hosted_page?.return_uri ?? '');
          return HttpResponse.json(getMockedTrueLayerCreateConnectionResponse(), { status: 201 });
        }),
      );

      const { connectionId } = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
        credentials: { clientId: VALID_TL_CLIENT_ID, clientSecret: VALID_TL_CLIENT_SECRET, manualReturn: true },
        raw: true,
      });

      expect(returnUris[0]).toBe('https://console.truelayer.com/redirect-page');

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({ connectionId, raw: true });
      expect(connection?.manualReturn).toBe(true);
      expect(typeof connection?.authUrl).toBe('string');

      // A later reconnect keeps the manual return mode.
      const reauthResult = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/connections/${connectionId}/reauthorize`,
      });
      expect(reauthResult.status).toEqual(200);
      expect(returnUris[1]).toBe('https://console.truelayer.com/redirect-page');
    });

    it('rejects invalid app credentials with Forbidden and creates no connection', async () => {
      const { connections: before } = await helpers.bankDataProviders.listUserConnections({ raw: true });

      const result = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/connect`,
        payload: { credentials: { clientId: VALID_TL_CLIENT_ID, clientSecret: INVALID_TL_CLIENT_SECRET } },
      });
      expect(result.status).toEqual(ERROR_CODES.Forbidden);

      const { connections: after } = await helpers.bankDataProviders.listUserConnections({ raw: true });
      expect(after.length).toBe(before.length);
    });

    it('rejects missing credential fields with ValidationError', async () => {
      const result = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/connect`,
        payload: { credentials: { clientId: VALID_TL_CLIENT_ID } },
      });
      expect(result.status).toEqual(ERROR_CODES.ValidationError);
    });

    it('surfaces an unregistered redirect URI with the console hint', async () => {
      // TrueLayer answers 403 when this instance's callback URL is missing
      // from the app's Redirect URIs; the user must get the actionable hint.
      global.mswMockServer.use(
        http.post(`${TL_API_BASE_URL}/v3/data-connections`, () =>
          HttpResponse.json(
            { type: 'https://docs.truelayer.com/#connection-api-errors', title: 'Forbidden', status: 403 },
            { status: 403 },
          ),
        ),
      );

      const result = await helpers.makeRequest<{ message?: string }>({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/connect`,
        payload: { credentials: { clientId: VALID_TL_CLIENT_ID, clientSecret: VALID_TL_CLIENT_SECRET } },
      });

      expect(result.status).toEqual(ERROR_CODES.Forbidden);
      expect(result.body?.response?.message).toContain('Redirect URIs');
    });

    it('surfaces an app without the Data product distinctly', async () => {
      // Payments-only token + 403 on the connection POST: the client must
      // blame the missing Data product, not the redirect URI.
      global.mswMockServer.use(
        getTrueLayerPaymentsOnlyTokenMock(),
        http.post(`${TL_API_BASE_URL}/v3/data-connections`, () =>
          HttpResponse.json({ type: 'forbidden', title: 'Forbidden', status: 403 }, { status: 403 }),
        ),
      );

      const result = await helpers.makeRequest<{ message?: string }>({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/connect`,
        payload: { credentials: { clientId: 'payments-only-app-id', clientSecret: VALID_TL_CLIENT_SECRET } },
      });

      expect(result.status).toEqual(ERROR_CODES.Forbidden);
      expect(result.body?.response?.message).toContain('Data product');
    });

    it('returns 503 from the callback while the bank-side consent is still pending', async () => {
      global.mswMockServer.use(getTrueLayerPendingAccountsMock());

      const { connectionId } = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
        credentials: { clientId: VALID_TL_CLIENT_ID, clientSecret: VALID_TL_CLIENT_SECRET },
        raw: true,
      });

      const result = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
        payload: { connectionId },
      });
      expect(result.status).toEqual(ERROR_CODES.ServiceUnavailable);

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({ connectionId, raw: true });
      expect(connection.isActive).toBe(false);
    });

    it('activates the connection on confirmation with a recurring consent window', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({ connectionId, raw: true });
      expect(connection.isActive).toBe(true);
      expect(connection.consent?.validUntil).toBeTruthy();
      expect(new Date(connection.consent!.validUntil!).getTime()).toBeGreaterThan(Date.now());
    });

    it('confirms idempotently when the callback is submitted twice', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      const result = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
        payload: { connectionId },
      });
      expect(result.status).toEqual(200);
    });

    it('names a second connection with a counter', async () => {
      await helpers.truelayer.pairTrueLayerUser();
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      const { connections } = await helpers.bankDataProviders.listUserConnections({ raw: true });
      const connection = connections.find((c: { id: string }) => c.id === connectionId);
      expect(connection?.providerName).toBe('TrueLayer (2)');
    });
  });

  describe('Account listing', () => {
    it('excludes cards and converts minor-unit balances to major units', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      const { accounts } = await helpers.bankDataProviders.listExternalAccounts({ connectionId, raw: true });
      const ids = accounts.map((a: { externalId: string }) => a.externalId);

      expect(ids).toEqual(expect.arrayContaining([TRUELAYER_ACCOUNT_1_ID, TRUELAYER_ACCOUNT_2_ID]));
      expect(ids).not.toContain(TRUELAYER_CARD_ID);

      const first = accounts.find((a: { externalId: string }) => a.externalId === TRUELAYER_ACCOUNT_1_ID);
      // 152345 pence = £1,523.45
      expect(first!.balance).toBeCloseTo(1523.45);
      expect(first!.currency).toBe('GBP');
      expect(first!.metadata!.accountKey).toBe('scan:560029:26207729');
    });
  });

  describe('Transaction sync', () => {
    const MOCK_AMOUNT = 5;

    const connectAndSync = async (transactions?: ReturnType<typeof getMockedTrueLayerTransactionsResultResponse>) => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      return {
        connectionId,
        ...(await helpers.truelayer.connectAccountsAndSync({
          connectionId,
          mockedTransactions: transactions ?? getMockedTrueLayerTransactionsResultResponse(MOCK_AMOUNT),
        })),
      };
    };

    it('imports signed minor-unit amounts mapped to income/expense', async () => {
      const { account, transactions } = await connectAndSync();

      expect(transactions.length).toBe(MOCK_AMOUNT);
      for (const tx of transactions) {
        // Amounts are stored unsigned; direction lives in transactionType.
        expect(Number(tx.amount)).toBeGreaterThan(0);
        expect(tx.originalId).toMatch(/^tx-/);
        expect(tx.accountType).toBe('truelayer');
        expect(tx.currencyCode).toBe('GBP');
      }

      const types = transactions.map((t) => t.transactionType);
      // Fixture alternates: even indexes debits (3), odd credits (2).
      expect(types.filter((t) => t === TRANSACTION_TYPES.income).length).toBe(2);
      expect(types.filter((t) => t === TRANSACTION_TYPES.expense).length).toBe(3);
      expect(account.currentBalance.toNumber()).toBeCloseTo(1523.45);
    });

    it('does not duplicate transactions on re-sync', async () => {
      const { connectionId, account } = await connectAndSync();

      await helpers.bankDataProviders.syncTransactionsForAccount({
        connectionId,
        accountId: account.id,
        raw: true,
      });

      const rows = await Transactions.findAll({ where: { accountId: account.id }, raw: true });
      expect(rows.length).toBe(MOCK_AMOUNT);
    });

    it('defers pending transactions until they settle', async () => {
      const mixed = {
        id: 'tl-req-1',
        status: 'completed' as const,
        completed_at: '2026-10-01T10:00:05.000Z',
        result: {
          items: [
            getMockedTrueLayerTransaction({ transactionId: 'tx-settled-1', amountMinor: -1500 }),
            getMockedTrueLayerTransaction({ transactionId: 'tx-pending-1', amountMinor: -2500, status: 'pending' }),
            getMockedTrueLayerTransaction({ transactionId: 'tx-settled-2', amountMinor: 3000 }),
          ],
          pagination: { next_cursor: null },
        },
      };
      const { transactions } = await connectAndSync(mixed);

      const imported = transactions.filter((t) => t.originalId?.startsWith('tx-'));
      expect(imported.map((t) => t.originalId).toSorted()).toEqual(['tx-settled-1', 'tx-settled-2']);
      expect(imported.find((t) => t.originalId === 'tx-pending-1')).toBeUndefined();
    });

    it('surfaces failed transactions requests as a retryable 503', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      global.mswMockServer.use(
        getTrueLayerTransactionsResultMock({ response: getMockedTrueLayerFailedTransactionsResultResponse() }),
      );

      const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.TRUELAYER) as TrueLayerProvider;
      await expect(
        provider.fetchTransactions(connectionId, TRUELAYER_ACCOUNT_1_ID, {
          from: new Date(Date.now() - 30 * 24 * 3600 * 1000),
          to: new Date(),
        }),
      ).rejects.toMatchObject({ httpCode: ERROR_CODES.ServiceUnavailable });
    });

    it('maps provider outages during sync to ServiceUnavailable', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      global.mswMockServer.use(getTrueLayerTransactionsRequestErrorMock({ status: 503 }));

      const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.TRUELAYER) as TrueLayerProvider;
      await expect(
        provider.fetchTransactions(connectionId, TRUELAYER_ACCOUNT_1_ID, {
          from: new Date(Date.now() - 30 * 24 * 3600 * 1000),
          to: new Date(),
        }),
      ).rejects.toMatchObject({ httpCode: ERROR_CODES.ServiceUnavailable });
    });
  });

  describe('Reauthorize re-links account ids', () => {
    it('migrates system account externalIds onto the new connection ids by bank identifier', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      const { account } = await helpers.truelayer.connectAccountsAndSync({ connectionId });
      expect(account.externalId).toBe(TRUELAYER_ACCOUNT_1_ID);

      // A fresh journey returns a NEW Connection-Id whose account ids differ;
      // the same IBAN/sort-code must re-anchor the existing system account.
      const REAUTH_CONNECTION_ID = '01949b8a-0000-7000-8000-0000000000aa';
      const REAUTH_ACCOUNT_ID = 'ca_v3_relinked';
      global.mswMockServer.use(
        http.post(`${TL_API_BASE_URL}/v3/data-connections`, () =>
          HttpResponse.json(getMockedTrueLayerCreateConnectionResponse({ id: REAUTH_CONNECTION_ID }), { status: 201 }),
        ),
        getTrueLayerAccountsMock({
          response: {
            items: [getMockedTrueLayerAccount({ accountId: REAUTH_ACCOUNT_ID })],
            pagination: { next_cursor: null },
          },
        }),
      );

      const reauthResult = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/connections/${connectionId}/reauthorize`,
      });
      expect(reauthResult.status).toEqual(200);

      const confirmResult = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
        payload: { connectionId },
      });
      expect(confirmResult.status).toEqual(200);

      await account.reload();
      expect(account.externalId).toBe(REAUTH_ACCOUNT_ID);

      // Transaction history survived the id swap.
      const rows = await Transactions.findAll({ where: { accountId: account.id }, raw: true });
      expect(rows.length).toBe(5);
    });
  });

  describe('Period load', () => {
    it('sends day-precise date bounds and dedups rows already synced', async () => {
      const { connectionId, account } = await (async () => {
        const conn = await helpers.truelayer.pairTrueLayerUser();
        return {
          connectionId: conn.connectionId,
          ...(await helpers.truelayer.connectAccountsAndSync({
            connectionId: conn.connectionId,
            mockedTransactions: getMockedTrueLayerTransactionsResultResponse(1),
          })),
        };
      })();

      const before = await Transactions.count({ where: { accountId: account.id } });

      // The async transactions request must receive YYYY-MM-DD from/to.
      let sawDateBounds = false;
      global.mswMockServer.use(
        http.post(
          new RegExp(`${TL_API_BASE_URL}/v3/connected-accounts/[^/]+/transactions/requests$`),
          async ({ request }) => {
            const body = (await request.json().catch(() => null)) as { from?: unknown; to?: unknown } | null;
            const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
            sawDateBounds = dateOnly.test(String(body?.from ?? '')) && dateOnly.test(String(body?.to ?? ''));
            return HttpResponse.json({ id: 'tl-req-period', status: 'pending' }, { status: 202 });
          },
        ),
        getTrueLayerTransactionsResultMock({
          response: getMockedTrueLayerTransactionsResultResponse(3),
        }),
      );

      const result = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/connections/${connectionId}/load-transactions-for-period`,
        payload: {
          accountId: account.id,
          from: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
          to: new Date().toISOString(),
        },
        raw: true,
      });

      expect(sawDateBounds).toBe(true);
      expect(result.jobGroupId).toBeNull();
      const after = await Transactions.count({ where: { accountId: account.id } });
      expect(after).toBe(before);
    });
  });

  describe('Credential updates', () => {
    it('accepts valid replacement credentials', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      await helpers.makeRequest({
        method: 'patch',
        url: `/bank-data-providers/connections/${connectionId}`,
        payload: { credentials: { clientId: VALID_TL_CLIENT_ID, clientSecret: VALID_TL_CLIENT_SECRET } },
        raw: true,
      });

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({ connectionId, raw: true });
      expect(connection.isActive).toBe(true);
    });

    it('rejects replacement credentials the token endpoint refuses', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      // A different clientId misses the app-token cache, forcing a real token
      // fetch against the rejecting handler.
      global.mswMockServer.use(
        http.post(`${TL_AUTH_BASE_URL}/connect/token`, () =>
          HttpResponse.json({ type: 'unauthenticated', title: 'unauthenticated', status: 401 }, { status: 401 }),
        ),
      );

      const result = await helpers.makeRequest({
        method: 'patch',
        url: `/bank-data-providers/connections/${connectionId}`,
        payload: { credentials: { clientId: 'rotated-client-id', clientSecret: VALID_TL_CLIENT_SECRET } },
      });
      expect(result.status).toEqual(ERROR_CODES.Forbidden);
    });
  });

  describe('Disconnect', () => {
    it('removes the connection row', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      await helpers.makeRequest({
        method: 'delete',
        url: `/bank-data-providers/connections/${connectionId}`,
        raw: true,
      });

      const { connections } = await helpers.bankDataProviders.listUserConnections({ raw: true });
      expect(connections.find((c: { id: string }) => c.id === connectionId)).toBeUndefined();
    });
  });

  describe('Auth-failure engine', () => {
    it('deactivates the connection when consent lapses (invalid_state)', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      global.mswMockServer.use(getTrueLayerPendingAccountsMock());

      const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.TRUELAYER) as TrueLayerProvider;
      await expect(provider.fetchAccounts(connectionId)).rejects.toThrow();

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({ connectionId, raw: true });
      expect(connection.isActive).toBe(false);
    });
  });
});
