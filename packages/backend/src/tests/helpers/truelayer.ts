import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { expect } from '@jest/globals';
import Accounts from '@models/accounts.model';
import Transactions from '@models/transactions.model';
import * as helpers from '@tests/helpers';
import { TRUELAYER_V1_ACCOUNT_1_ID, getMockedTrueLayerV1TransactionsResponse } from '@tests/mocks/truelayer/data';
import {
  VALID_TL_CLIENT_ID,
  VALID_TL_CLIENT_SECRET,
  VALID_TL_V1_CODE,
  getTrueLayerV1TransactionsResultMock,
} from '@tests/mocks/truelayer/mock-api';

/**
 * Creates a fully-authorized TrueLayer connection: app credentials → built
 * authorization link → oauth-callback code exchange. The default mocks redeem
 * the fixture code once per exchange call.
 */
const pairTrueLayerUser = async ({
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
    credentials: { clientId, clientSecret, manualReturn },
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

export default {
  pairTrueLayerUser,
  connectAccountsAndSync,
};
