import { BANK_PROVIDER_TYPE, DEACTIVATION_REASON, TRANSACTION_TYPES } from '@bt/shared/types';
import { describe, expect, it } from '@jest/globals';
import { ERROR_CODES } from '@js/errors';
import Accounts from '@models/accounts.model';
import BankDataProviderConnections from '@models/bank-data-provider-connections.model';
import Transactions from '@models/transactions.model';
import { bankProviderRegistry } from '@root/services/bank-data-providers';
import type { TrueLayerProvider } from '@services/bank-data-providers/truelayer';
import type { TrueLayerCredentials } from '@services/bank-data-providers/truelayer/types';
import * as helpers from '@tests/helpers';
import {
  TRUELAYER_V1_ACCOUNT_1_ID,
  TRUELAYER_V1_ACCOUNT_2_ID,
  TRUELAYER_V1_CARD_ID,
  getMockedTrueLayerV1Account,
  getMockedTrueLayerV1TransactionsResponse,
} from '@tests/mocks/truelayer/data';
import {
  EXPIRED_TL_V1_REFRESH_TOKEN,
  INVALID_TL_CLIENT_SECRET,
  ROTATED_TL_V1_REFRESH_TOKEN,
  TL_API_BASE_URL,
  TL_AUTH_BASE_URL,
  VALID_TL_CLIENT_ID,
  VALID_TL_CLIENT_SECRET,
  VALID_TL_V1_CODE,
  getTrueLayerV1CardsOnlyMock,
  getTrueLayerV1ConsentDeadMock,
  getTrueLayerV1PagedTransactionsMock,
  getTrueLayerV1RefreshUnsupportedMock,
} from '@tests/mocks/truelayer/mock-api';
import { HttpResponse, http } from 'msw';

/** Force the stored bearer token to look expired (optionally swap in a dead refresh token). */
const expireStoredAccessToken = async (connectionId: string, refreshToken?: string) => {
  const connection = await BankDataProviderConnections.findByPk(connectionId);
  const creds = connection!.getDecryptedCredentials() as unknown as TrueLayerCredentials;
  creds.v1Token = {
    ...creds.v1Token!,
    accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    ...(refreshToken ? { refreshToken } : {}),
  };
  connection!.setEncryptedCredentials(creds as unknown as Record<string, unknown>);
  await connection!.save();
};

/**
 * E2E tests for the TrueLayer (UK open banking) provider. Covers the hosted
 * authorization-code journey (connect → pending → confirm), major-unit sync
 * math, card products, token rotation + fallback, reauthorize (including
 * external-id re-linking), period load, credential updates, disconnect.
 */
describe('TrueLayer Data Provider E2E', () => {
  describe('Connection management', () => {
    it('is listed as a supported provider', async () => {
      const { providers } = await helpers.bankDataProviders.getSupportedBankProviders({
        raw: true,
      });

      const provider = providers.find((p: { type: string }) => p.type === BANK_PROVIDER_TYPE.TRUELAYER);
      expect(provider).toBeDefined();
      expect(provider!.name).toBe('TrueLayer');
      expect(provider!.features.supportsAutoSync).toBe(true);
      expect(provider!.features.supportsWebhooks).toBe(false);
      expect(provider!.features.requiresReauth).toBe(true);
    });

    it('creates a pending inactive connection whose authUrl is the authorization link', async () => {
      const { connectionId, authUrl } = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
        credentials: {
          clientId: VALID_TL_CLIENT_ID,
          clientSecret: VALID_TL_CLIENT_SECRET,
        },
        raw: true,
      });

      const url = new URL(authUrl!);
      expect(url.origin).toBe(TL_AUTH_BASE_URL);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe(VALID_TL_CLIENT_ID);
      expect(url.searchParams.get('scope')).toContain('offline_access');
      expect(url.searchParams.get('scope')).toContain('cards');
      expect(url.searchParams.get('state')).toBeTruthy();
      expect(url.searchParams.get('nonce')).toBeTruthy();
      expect(url.searchParams.get('redirect_uri')).toContain('bank-callback');

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({
        connectionId,
        raw: true,
      });
      expect(connection.isActive).toBe(false);
    });

    it('rejects invalid app credentials with Forbidden and creates no connection', async () => {
      const { connections: before } = await helpers.bankDataProviders.listUserConnections({ raw: true });

      const result = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/connect`,
        payload: {
          credentials: {
            clientId: VALID_TL_CLIENT_ID,
            clientSecret: INVALID_TL_CLIENT_SECRET,
          },
        },
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

    it('rejects callbacks with a missing code or mismatched state', async () => {
      const { connectionId, authUrl } = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
        credentials: {
          clientId: VALID_TL_CLIENT_ID,
          clientSecret: VALID_TL_CLIENT_SECRET,
        },
        raw: true,
      });
      const state = new URL(authUrl!).searchParams.get('state')!;

      const noCode = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
        payload: { connectionId, state },
      });
      expect(noCode.status).toEqual(ERROR_CODES.BadRequest);

      const badState = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
        payload: {
          connectionId,
          code: VALID_TL_V1_CODE,
          state: 'someone-elses-state',
        },
      });
      expect(badState.status).toEqual(ERROR_CODES.BadRequest);

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({
        connectionId,
        raw: true,
      });
      expect(connection.isActive).toBe(false);
    });

    it('activates on code exchange with a ~90-day consent window', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({
        connectionId,
        raw: true,
      });
      expect(connection.isActive).toBe(true);
      expect(connection.consent?.validUntil).toBeTruthy();
      const daysRemaining = connection.consent!.daysRemaining!;
      expect(daysRemaining).toBeGreaterThan(85);
      expect(daysRemaining).toBeLessThanOrEqual(90);
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

    it('confirms manual-return journeys from a pasted redirect URL and keeps the mode on reconnect', async () => {
      const { connectionId, authUrl } = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
        credentials: {
          clientId: VALID_TL_CLIENT_ID,
          clientSecret: VALID_TL_CLIENT_SECRET,
          manualReturn: true,
        },
        raw: true,
      });
      expect(new URL(authUrl!).searchParams.get('redirect_uri')).toBe('https://console.truelayer.com/redirect-page');

      const state = new URL(authUrl!).searchParams.get('state')!;
      const pasted = `https://console.truelayer.com/redirect-page?code=${VALID_TL_V1_CODE}&state=${state}&provider=hsbc&currency=GBP`;
      const result = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
        payload: { connectionId, redirectUrl: pasted },
      });
      expect(result.status).toEqual(200);

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({
        connectionId,
        raw: true,
      });
      expect(connection.isActive).toBe(true);
      expect(connection.manualReturn).toBe(true);

      // A later reconnect keeps the manual return mode.
      const reauthResult = (await helpers.extractResponse(
        await helpers.makeRequest({
          method: 'post',
          url: `/bank-data-providers/connections/${connectionId}/reauthorize`,
        }),
      )) as { authUrl: string };
      expect(new URL(reauthResult.authUrl).searchParams.get('redirect_uri')).toBe(
        'https://console.truelayer.com/redirect-page',
      );
    });

    it('confirms a bare pasted code, verifying state from the stored auth link', async () => {
      const { connectionId, authUrl } = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
        credentials: {
          clientId: VALID_TL_CLIENT_ID,
          clientSecret: VALID_TL_CLIENT_SECRET,
          manualReturn: true,
        },
        raw: true,
      });
      const state = new URL(authUrl!).searchParams.get('state')!;

      const result = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
        payload: { connectionId, code: VALID_TL_V1_CODE, state },
      });
      expect(result.status).toEqual(200);

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({
        connectionId,
        raw: true,
      });
      expect(connection.isActive).toBe(true);
    });

    it('bakes the frontend-reported origin into the redirect_uri', async () => {
      const { authUrl } = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
        credentials: {
          clientId: VALID_TL_CLIENT_ID,
          clientSecret: VALID_TL_CLIENT_SECRET,
          redirectOrigin: 'http://127.0.0.1:8080',
        },
        raw: true,
      });
      expect(new URL(authUrl!).searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080/bank-callback');

      // A malformed origin must not become an open redirect target — the
      // configured default is used instead.
      const fallback = await helpers.bankDataProviders.connectProvider({
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
        credentials: {
          clientId: VALID_TL_CLIENT_ID,
          clientSecret: VALID_TL_CLIENT_SECRET,
          redirectOrigin: 'javascript:alert(1)',
        },
        raw: true,
      });
      expect(new URL(fallback.authUrl!).searchParams.get('redirect_uri')).toContain('bank-callback');
      expect(new URL(fallback.authUrl!).searchParams.get('redirect_uri')).not.toContain('javascript');
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
    it('lists accounts with major-unit balances and stable account keys', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      const { accounts } = await helpers.bankDataProviders.listExternalAccounts({ connectionId, raw: true });
      const ids = accounts.map((a: { externalId: string }) => a.externalId);
      expect(ids).toEqual(expect.arrayContaining([TRUELAYER_V1_ACCOUNT_1_ID, TRUELAYER_V1_ACCOUNT_2_ID]));

      const first = accounts.find((a: { externalId: string }) => a.externalId === TRUELAYER_V1_ACCOUNT_1_ID);
      // UDM reports 1523.45 pounds — no minor-unit conversion mistakes.
      expect(first!.balance).toBeCloseTo(1523.45);
      expect(first!.currency).toBe('GBP');
      expect(first!.metadata!.accountKey).toBe('scan:560029:26207729');
    });

    it('serves card products when the provider has no accounts API (Amex-like)', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      global.mswMockServer.use(...getTrueLayerV1CardsOnlyMock());

      const { accounts } = await helpers.bankDataProviders.listExternalAccounts({ connectionId, raw: true });
      expect(accounts.map((a: { externalId: string }) => a.externalId)).toEqual([TRUELAYER_V1_CARD_ID]);
      const card = accounts[0]!;
      expect(card.name).toBe('American Express ••3001');
      expect(card.balance).toBeCloseTo(342.1);
      expect(card.metadata!.accountKey).toBe('card:3001');

      const { account, transactions } = await helpers.truelayer.connectAccountsAndSync({
        connectionId,
        accountId: TRUELAYER_V1_CARD_ID,
      });
      // Balance + transactions resolve via the /data/v1/cards fallback: the
      // accounts path answers 400 for a card id, matching the live API.
      expect(transactions.length).toBe(3);
      expect(transactions.every((t: { originalId: string }) => t.originalId.startsWith('np-v1tx-tlv1_card_amex'))).toBe(
        true,
      );
      expect(account.currentBalance.toNumber()).toBeCloseTo(342.1);
    });

    it('ignores a 501 on the cards endpoint for account-only providers', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      const { accounts } = await helpers.bankDataProviders.listExternalAccounts({ connectionId, raw: true });
      expect(accounts.map((a: { externalId: string }) => a.externalId)).toEqual([
        TRUELAYER_V1_ACCOUNT_1_ID,
        TRUELAYER_V1_ACCOUNT_2_ID,
      ]);
    });

    it('links a card product to an existing account with years of manual history', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      global.mswMockServer.use(...getTrueLayerV1CardsOnlyMock());
      await helpers.addUserCurrencies({ currencyCodes: ['GBP'], raw: true });

      const existing = await helpers.createAccount({
        payload: helpers.buildAccountPayload({ name: 'Deep history GBP', currencyCode: 'GBP' }),
        raw: true,
      });
      await helpers.createTransaction({
        payload: helpers.buildTransactionPayload({
          accountId: existing.id,
          amount: 25,
          transactionType: TRANSACTION_TYPES.expense,
          time: '2020-02-08T23:00:00.000Z',
        }),
        raw: true,
      });

      // Regression: the pre-clamp fetch anchored at the oldest stored row
      // (2020 − 7d overlap), a window the live API rejects with 400 "Invalid
      // date range provided." Now the linkedAt clamp keeps the fetch
      // forward-only (pre-link rows belong to the residual absorb, not the
      // statement import), so the link succeeds and imports nothing dated
      // before the link.
      await helpers.makeRequest({
        method: 'post',
        url: `/accounts/${existing.id}/link`,
        payload: { connectionId, externalAccountId: TRUELAYER_V1_CARD_ID },
        raw: true,
      });

      const linked = await Accounts.findByPk(existing.id);
      expect(linked!.externalId).toBe(TRUELAYER_V1_CARD_ID);
      const rows = await Transactions.findAll({ where: { accountId: existing.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.amount.toNumber()).toBe(25);
    });
  });

  describe('Transaction sync', () => {
    it('imports signed major-unit amounts mapped to income/expense', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      const { account, transactions } = await helpers.truelayer.connectAccountsAndSync({
        connectionId,
        mockedTransactions: getMockedTrueLayerV1TransactionsResponse(5),
      });

      expect(transactions.length).toBe(5);
      for (const tx of transactions) {
        // Amounts are stored unsigned; direction lives in transactionType.
        expect(Number(tx.amount)).toBeGreaterThan(0);
        expect(tx.originalId).toMatch(/^np-v1tx-/);
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
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      const { account } = await helpers.truelayer.connectAccountsAndSync({ connectionId });

      await helpers.bankDataProviders.syncTransactionsForAccount({
        connectionId,
        accountId: account.id,
        raw: true,
      });

      const rows = await Transactions.findAll({
        where: { accountId: account.id },
        raw: true,
      });
      expect(rows.length).toBe(5);
    });

    it('follows Link-header pages and dedups repeated rows', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      global.mswMockServer.use(
        getTrueLayerV1PagedTransactionsMock({
          accountId: TRUELAYER_V1_ACCOUNT_1_ID,
          dupTxId: 'tx-dup',
        }),
      );

      const { transactions } = await helpers.truelayer.connectAccountsAndSync({ connectionId });
      const ids = transactions.filter((t) => t.originalId?.startsWith('tx-dup')).map((t) => t.originalId);
      expect(ids.toSorted()).toEqual(['tx-dup', 'tx-dup-page2']);
    });

    it('maps provider outages during sync to ServiceUnavailable', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      global.mswMockServer.use(
        http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/transactions`, () =>
          HttpResponse.json(
            { type: 'https://truelayer.com/errors/provider_error', title: 'provider_error', status: 503 },
            { status: 503 },
          ),
        ),
      );

      const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.TRUELAYER) as TrueLayerProvider;
      await expect(
        provider.fetchTransactions(connectionId, TRUELAYER_V1_ACCOUNT_1_ID, {
          from: new Date(Date.now() - 30 * 24 * 3600 * 1000),
          to: new Date(),
        }),
      ).rejects.toMatchObject({ httpCode: ERROR_CODES.ServiceUnavailable });
    });
  });

  describe('Reauthorize', () => {
    it('mints a fresh authorization link with a new state and completes like the first journey', async () => {
      const { connectionId, state } = await helpers.truelayer.pairTrueLayerUser();

      const reauthorizeResult = (await helpers.extractResponse(
        await helpers.makeRequest({
          method: 'post',
          url: `/bank-data-providers/connections/${connectionId}/reauthorize`,
        }),
      )) as { authUrl: string };

      const reauthUrl = new URL(reauthorizeResult.authUrl);
      expect(reauthUrl.origin).toBe(TL_AUTH_BASE_URL);
      expect(reauthUrl.searchParams.get('response_type')).toBe('code');
      expect(reauthUrl.searchParams.get('state')).toBeTruthy();
      expect(reauthUrl.searchParams.get('state')).not.toBe(state);

      const confirmed = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
        payload: {
          connectionId,
          code: VALID_TL_V1_CODE,
          state: reauthUrl.searchParams.get('state'),
        },
      });
      expect(confirmed.status).toEqual(200);

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({
        connectionId,
        raw: true,
      });
      expect(connection.isActive).toBe(true);
    });

    it('re-links system account externalIds onto new ids by bank identifier', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      const { account } = await helpers.truelayer.connectAccountsAndSync({ connectionId });
      expect(account.externalId).toBe(TRUELAYER_V1_ACCOUNT_1_ID);

      // The fresh journey's consent answers with different account ids; the
      // same sort-code/account-number must re-anchor the existing account.
      const RELINKED_ACCOUNT_ID = 'tlv1_relinked';
      global.mswMockServer.use(
        http.get(`${TL_API_BASE_URL}/data/v1/accounts`, () =>
          HttpResponse.json({ results: [getMockedTrueLayerV1Account({ accountId: RELINKED_ACCOUNT_ID })] }),
        ),
      );

      const reauthorizeResult = (await helpers.extractResponse(
        await helpers.makeRequest({
          method: 'post',
          url: `/bank-data-providers/connections/${connectionId}/reauthorize`,
        }),
      )) as { authUrl: string };

      const confirmed = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
        payload: {
          connectionId,
          code: VALID_TL_V1_CODE,
          state: new URL(reauthorizeResult.authUrl).searchParams.get('state'),
        },
      });
      expect(confirmed.status).toEqual(200);

      await account.reload();
      expect(account.externalId).toBe(RELINKED_ACCOUNT_ID);

      // Transaction history survived the id swap.
      const rows = await Transactions.findAll({
        where: { accountId: account.id },
        raw: true,
      });
      expect(rows.length).toBe(5);
    });
  });

  describe('Period load', () => {
    it('sends ISO date bounds and never recreates rows already synced', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      const { account } = await helpers.truelayer.connectAccountsAndSync({
        connectionId,
        mockedTransactions: getMockedTrueLayerV1TransactionsResponse(1),
      });
      const before = await Transactions.count({ where: { accountId: account.id } });

      let sawIsoBounds = false;
      global.mswMockServer.use(
        http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/transactions`, ({ request }) => {
          const from = new URL(request.url).searchParams.get('from');
          sawIsoBounds = !!from && !Number.isNaN(Date.parse(from));
          return HttpResponse.json(getMockedTrueLayerV1TransactionsResponse(3));
        }),
      );

      const result = await helpers.makeRequest({
        method: 'post',
        url: `/bank-data-providers/connections/${connectionId}/load-transactions-for-period`,
        payload: {
          accountId: account.id,
          from: new Date('2026-09-20T00:00:00Z').toISOString(),
          to: new Date().toISOString(),
        },
        raw: true,
      });

      expect(sawIsoBounds).toBe(true);
      expect(result.jobGroupId).toBeNull();
      expect(result.fetchedCount).toBe(3);
      // Row 1 is the already-synced originalId; rows 2 + 3 land fresh.
      expect(result.createdCount).toBe(2);
      const rows = await Transactions.findAll({ where: { accountId: account.id }, raw: true });
      expect(rows.length).toBe(before + 2);
      expect(new Set(rows.map((r) => r.originalId)).size).toBe(rows.length);
    });
  });

  describe('Credential updates', () => {
    it('accepts valid replacement credentials', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();

      await helpers.makeRequest({
        method: 'patch',
        url: `/bank-data-providers/connections/${connectionId}`,
        payload: {
          credentials: {
            clientId: VALID_TL_CLIENT_ID,
            clientSecret: VALID_TL_CLIENT_SECRET,
          },
        },
        raw: true,
      });

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({
        connectionId,
        raw: true,
      });
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
        payload: {
          credentials: {
            clientId: 'rotated-client-id',
            clientSecret: VALID_TL_CLIENT_SECRET,
          },
        },
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

  describe('Token refresh + auth-failure engine', () => {
    it('refreshes the expired bearer and persists the rotated refresh token', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      await expireStoredAccessToken(connectionId);

      const { account, transactions } = await helpers.truelayer.connectAccountsAndSync({ connectionId });
      expect(transactions.length).toBeGreaterThan(0);

      const creds = (await BankDataProviderConnections.findByPk(
        connectionId,
      ))!.getDecryptedCredentials() as unknown as TrueLayerCredentials;
      expect(creds.v1Token?.refreshToken).toBe(ROTATED_TL_V1_REFRESH_TOKEN);
      expect(creds.v1Token?.accessToken).toBe('tl-v1-access-token-rotated');
      expect(new Date(creds.v1Token!.accessExpiresAt).getTime()).toBeGreaterThan(Date.now());
      expect(account.id).toBeTruthy();
    });

    it('falls back to the legacy /token endpoint when the auth server lacks the refresh grant', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      await expireStoredAccessToken(connectionId);
      global.mswMockServer.use(getTrueLayerV1RefreshUnsupportedMock());

      const { transactions } = await helpers.truelayer.connectAccountsAndSync({ connectionId });
      expect(transactions.length).toBeGreaterThan(0);

      const creds = (await BankDataProviderConnections.findByPk(
        connectionId,
      ))!.getDecryptedCredentials() as unknown as TrueLayerCredentials;
      expect(creds.v1Token?.refreshToken).toBe(ROTATED_TL_V1_REFRESH_TOKEN);
    });

    it('deactivates the connection when the refresh token is dead', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      await expireStoredAccessToken(connectionId, EXPIRED_TL_V1_REFRESH_TOKEN);

      const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.TRUELAYER) as TrueLayerProvider;
      await expect(provider.fetchAccounts(connectionId)).rejects.toThrow();

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({
        connectionId,
        raw: true,
      });
      expect(connection.isActive).toBe(false);
      expect(connection.deactivationReason).toBe(DEACTIVATION_REASON.AUTH_FAILURE);
    });

    it('deactivates data calls answered 403 access_denied (revoked consent)', async () => {
      const { connectionId } = await helpers.truelayer.pairTrueLayerUser();
      global.mswMockServer.use(...getTrueLayerV1ConsentDeadMock());

      const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.TRUELAYER) as TrueLayerProvider;
      await expect(provider.fetchAccounts(connectionId)).rejects.toThrow();

      const { connection } = await helpers.bankDataProviders.getConnectionDetails({
        connectionId,
        raw: true,
      });
      expect(connection.isActive).toBe(false);
    });
  });
});
