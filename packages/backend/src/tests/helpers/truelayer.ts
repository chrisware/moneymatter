import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { expect } from '@jest/globals';
import Accounts from '@models/accounts.model';
import Transactions from '@models/transactions.model';
import type { TrueLayerTransactionsRequestResult } from '@services/bank-data-providers/truelayer/types';
import * as helpers from '@tests/helpers';
import {
  TRUELAYER_ACCOUNT_1_ID,
  TRUELAYER_V1_ACCOUNT_1_ID,
  getMockedTrueLayerTransactionsResultResponse,
  getMockedTrueLayerV1TransactionsResponse,
} from '@tests/mocks/truelayer/data';
import {
  VALID_TL_CLIENT_ID,
  VALID_TL_CLIENT_SECRET,
  VALID_TL_V1_CODE,
  getTrueLayerTransactionsResultMock,
  getTrueLayerV1TransactionsResultMock,
} from '@tests/mocks/truelayer/mock-api';

/**
 * Creates a fully-authorized TrueLayer connection: app credentials → data
 * connection → hosted-journey confirmation (oauth-callback). Default mocks
 * treat the fixture Connection-Id as already authorized, so the confirmation
 * succeeds without overrides. Tests that need a pending consent override the
 * accounts handler BEFORE calling this.
 */
const pairTrueLayerUser = async ({
  clientId = VALID_TL_CLIENT_ID,
  clientSecret = VALID_TL_CLIENT_SECRET,
}: { clientId?: string; clientSecret?: string } = {}) => {
  const { connectionId } = await helpers.bankDataProviders.connectProvider({
    providerType: BANK_PROVIDER_TYPE.TRUELAYER,
    credentials: { clientId, clientSecret },
    raw: true,
  });

  const result = await helpers.makeRequest({
    method: 'post',
    url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
    payload: { connectionId },
  });
  expect(result.status).toEqual(200);

  return { connectionId };
};

const getTransactions = async () => {
  return helpers.extractResponse(
    await helpers.makeRequest({
      method: 'get',
      url: '/transactions',
    }),
  );
};

/**
 * Set up transaction mocks (optional override), link ALL external accounts,
 * and return the first linked account with its synced transactions.
 */
async function connectAccountsAndSync({
  connectionId,
  mockedTransactions,
  accountId = TRUELAYER_ACCOUNT_1_ID,
}: {
  connectionId: string;
  mockedTransactions?: ReturnType<typeof getMockedTrueLayerTransactionsResultResponse>;
  accountId?: string;
}): Promise<{ account: Accounts; transactions: Transactions[] }> {
  if (mockedTransactions) {
    global.mswMockServer.use(getTrueLayerTransactionsResultMock({ response: mockedTransactions }));
  }

  const { accounts: externalAccounts } = await helpers.bankDataProviders.listExternalAccounts({
    connectionId,
    raw: true,
  });
  const selected = externalAccounts.filter((acc) => acc.externalId === accountId);
  const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
    connectionId,
    accountExternalIds: selected.map((acc) => acc.externalId),
    raw: true,
  });

  const account = await Accounts.findByPk(syncedAccounts[0]!.id);
  const transactions = await getTransactions();

  return { account: account!, transactions };
}

/**
 * Creates a fully-authorized LEGACY v1 TrueLayer connection: app credentials
 * with `apiVersion: 'v1'` → built authorization link → oauth-callback code
 * exchange. The default mocks redeem the fixture code once per exchange call.
 */
const pairTrueLayerUserV1 = async ({
  clientId = VALID_TL_CLIENT_ID,
  clientSecret = VALID_TL_CLIENT_SECRET,
  manualReturn = false,
}: {
  clientId?: string;
  clientSecret?: string;
  manualReturn?: boolean;
} = {}) => {
  const { connectionId, authUrl } = await helpers.bankDataProviders.connectProvider({
    providerType: BANK_PROVIDER_TYPE.TRUELAYER,
    credentials: { clientId, clientSecret, apiVersion: 'v1', manualReturn },
    raw: true,
  });

  const state = new URL(authUrl!).searchParams.get('state') ?? '';

  const result = await helpers.makeRequest({
    method: 'post',
    url: `/bank-data-providers/${BANK_PROVIDER_TYPE.TRUELAYER}/oauth-callback`,
    payload: { connectionId, code: VALID_TL_V1_CODE, state },
  });
  expect(result.status).toEqual(200);

  return { connectionId, authUrl, state };
};

/** v1 twin of connectAccountsAndSync: UDM fixtures instead of async requests. */
async function connectV1AccountsAndSync({
  connectionId,
  mockedTransactions,
  accountId = TRUELAYER_V1_ACCOUNT_1_ID,
}: {
  connectionId: string;
  mockedTransactions?: ReturnType<typeof getMockedTrueLayerV1TransactionsResponse>;
  accountId?: string;
}): Promise<{ account: Accounts; transactions: Transactions[] }> {
  if (mockedTransactions) {
    global.mswMockServer.use(getTrueLayerV1TransactionsResultMock({ response: mockedTransactions }));
  }

  const { accounts: externalAccounts } = await helpers.bankDataProviders.listExternalAccounts({
    connectionId,
    raw: true,
  });
  const selected = externalAccounts.filter((acc) => acc.externalId === accountId);
  const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
    connectionId,
    accountExternalIds: selected.map((acc) => acc.externalId),
    raw: true,
  });

  const account = await Accounts.findByPk(syncedAccounts[0]!.id);
  const transactions = await getTransactions();

  return { account: account!, transactions };
}

/** Raw async-request result override (failed/pending) for negative tests. */
const mockTransactionsResult = (response: TrueLayerTransactionsRequestResult) => {
  global.mswMockServer.use(getTrueLayerTransactionsResultMock({ response }));
};

export default {
  pairTrueLayerUser,
  pairTrueLayerUserV1,
  connectAccountsAndSync,
  connectV1AccountsAndSync,
  mockTransactionsResult,
};
