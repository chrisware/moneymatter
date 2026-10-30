/**
 * Deterministic fixtures for the TrueLayer Legacy Data API v1 (Unified Data
 * Model). v1 amounts are DECIMAL MAJOR units exactly as the API returns them,
 * so tests assert the cents conversion the api-client performs
 * (£1,523.45 = 152345 cents).
 */

export const VALID_TL_APP_TOKEN = 'mock-app-token';

/** App-level client_credentials token (credential probe). */
export const getMockedTrueLayerTokenResponse = ({ expiresIn = 900 }: { expiresIn?: number } = {}) => ({
  access_token: VALID_TL_APP_TOKEN,
  token_type: 'Bearer',
  expires_in: expiresIn,
  scope: 'info accounts balance transactions cards offline_access',
});

/** v1 amounts are DECIMAL MAJOR units. */
export const TRUELAYER_V1_ACCOUNT_1_ID = 'tlv1_main';
export const TRUELAYER_V1_ACCOUNT_2_ID = 'tlv1_savings';
/** Card-only providers (Amex): products surface on /data/v1/cards only. */
export const TRUELAYER_V1_CARD_ID = 'tlv1_card_amex';

export const getMockedTrueLayerV1TokenResponse = ({
  expiresIn = 3600,
  accessToken = 'tl-v1-access-token',
  refreshToken = 'tl-v1-refresh-token',
}: {
  expiresIn?: number;
  accessToken?: string;
  refreshToken?: string;
} = {}) => ({
  access_token: accessToken,
  token_type: 'Bearer',
  expires_in: expiresIn,
  refresh_token: refreshToken,
  refresh_expires_in: 7776000,
  scope: 'info accounts balance transactions offline_access',
  signer: 'tl-v1-signer',
  provider: 'hsbc',
  currency: 'GBP',
});

export const getMockedTrueLayerV1Account = ({
  accountId,
  accountType = 'CURRENT_ACCOUNT',
  number = '26207729',
  displayName = 'Personal Current Account',
}: {
  accountId: string;
  accountType?: string;
  number?: string;
  displayName?: string;
}) => ({
  account_id: accountId,
  display_name: displayName,
  account_type: accountType,
  currency: 'GBP',
  account_number: { sort_code: '560029', number },
  provider: { provider_name: 'HSBC UK', provider_id: 'HSBC' },
  update_timestamp: '2026-10-20T08:00:00Z',
});

export const getMockedTrueLayerV1AccountsResponse = () => ({
  results: [
    getMockedTrueLayerV1Account({ accountId: TRUELAYER_V1_ACCOUNT_1_ID }),
    getMockedTrueLayerV1Account({
      accountId: TRUELAYER_V1_ACCOUNT_2_ID,
      accountType: 'SAVINGS_ACCOUNT',
      number: '26207730',
      displayName: 'Savings Account',
    }),
  ],
});

/** `GET /data/v1/cards` row — UDM cards carry a masked PAN tail, no sort code. */
export const getMockedTrueLayerV1Card = ({
  cardId = TRUELAYER_V1_CARD_ID,
  cardType = 'charge',
  lastFour = '3001',
  displayName = 'American Express',
}: {
  cardId?: string;
  cardType?: string;
  lastFour?: string;
  displayName?: string;
} = {}) => ({
  card_id: cardId,
  display_name: displayName,
  card_type: cardType,
  last_four_digits: lastFour,
  name_on_card: 'C WARE',
  expiry_date: '2029-04',
  currency: 'GBP',
  provider: { provider_name: 'American Express', provider_id: 'AMEX' },
  update_timestamp: '2026-10-20T08:00:00Z',
});

export const getMockedTrueLayerV1CardsResponse = () => ({
  results: [getMockedTrueLayerV1Card()],
});

/** Balance per account in major units (decimal pounds). */
export const TRUELAYER_V1_BALANCES_MAJOR: Record<string, number> = {
  [TRUELAYER_V1_ACCOUNT_1_ID]: 1523.45,
  [TRUELAYER_V1_ACCOUNT_2_ID]: 50000,
  [TRUELAYER_V1_CARD_ID]: 342.1,
};

export const getMockedTrueLayerV1BalanceResponse = (accountId: string) => {
  const balance = TRUELAYER_V1_BALANCES_MAJOR[accountId] ?? 0;
  return {
    results: [{ currency: 'GBP', current: balance, available: balance }],
  };
};

export const getMockedTrueLayerV1Transaction = ({
  transactionId,
  accountId = TRUELAYER_V1_ACCOUNT_1_ID,
  amount,
  description = 'TESCO STORES',
  timestamp = '2026-10-02T09:30:00Z',
}: {
  transactionId: string;
  accountId?: string;
  /** Signed major units: negative = debit. */
  amount: number;
  description?: string;
  timestamp?: string;
}) => ({
  transaction_id: transactionId,
  normalised_provider_transaction_id: `np-${transactionId}`,
  provider_transaction_id: transactionId,
  meta: { bank_transaction_id: `bank-${transactionId}`, account_id: accountId },
  timestamp,
  description,
  currency: 'GBP',
  amount,
  transaction_type: amount < 0 ? 'DEBIT' : 'CREDIT',
  merchant_name: description.split(' ')[0],
});

export const getMockedTrueLayerV1TransactionsResponse = (count = 5, accountId = TRUELAYER_V1_ACCOUNT_1_ID) => ({
  results: Array.from({ length: count }, (_, i) =>
    getMockedTrueLayerV1Transaction({
      transactionId: `v1tx-${accountId}-${i + 1}`,
      accountId,
      // Even indexes are debits (-), odd are credits (+), so the fee engine's
      // income/expense mapping gets both directions exercised.
      amount: i % 2 === 0 ? -(10 + i) : 250 + i,
      description: i % 2 === 0 ? `STORE ${i + 1}` : `SALARY ${i + 1}`,
      timestamp: `2026-10-0${(i % 9) + 1}T09:30:00Z`,
    }),
  ),
});
