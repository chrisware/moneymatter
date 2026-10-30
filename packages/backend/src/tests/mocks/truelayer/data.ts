/**
 * Deterministic fixtures for TrueLayer Data API v3. Monetary values are
 * integers in minor units (pence for GBP) exactly as the API returns them,
 * so tests assert the cents conversion the api-client performs
 * (152345 minor = £1,523.45 = 152345 cents).
 */

export const TRUELAYER_CONNECTION_ID = '01949b8a-0000-7000-8000-000000000001';
export const TRUELAYER_ACCOUNT_1_ID = 'ca_gbp_main';
export const TRUELAYER_ACCOUNT_2_ID = 'ca_gbp_savings';
export const TRUELAYER_ACCOUNT_NO_TX_ID = 'ca_gbp_no_tx';
export const TRUELAYER_CARD_ID = 'ca_gbp_card';

/** Base64url JWT with the given claims (signature is a placeholder). */
const mockJwt = (claims: Record<string, unknown>) =>
  ['eyJhbGciOiJSUzI1NiJ9', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'mock-sig'].join('.');

export const getMockedTrueLayerTokenResponse = ({ expiresIn = 900 }: { expiresIn?: number } = {}) => ({
  // A properly provisioned Data v3 app: decodable claims incl. `data`.
  access_token: mockJwt({
    scope: ['data', 'accounts', 'balance', 'transactions', 'connections:create'],
    aud: 'connections_api',
  }),
  token_type: 'Bearer',
  expires_in: expiresIn,
  scope: 'accounts balance transactions',
});

/** Token from an app WITHOUT the Data product (payments scopes only). */
export const getMockedTrueLayerPaymentsOnlyTokenResponse = () => ({
  access_token: mockJwt({
    scope: ['payments', 'payments:read'],
    aud: 'payments_api',
  }),
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'payments',
});

export const getMockedTrueLayerCreateConnectionResponse = ({
  id = TRUELAYER_CONNECTION_ID,
  userId = 'tl-user-1',
}: { id?: string; userId?: string } = {}) => ({
  id,
  user: { id: userId },
  status: 'authorization_required',
  hosted_page: {
    uri: `https://truelayer.com/connect/data/?connection-id=${id}`,
  },
});

export const getMockedTrueLayerAccount = ({
  accountId,
  accountType = 'current',
  holderName = 'JOHN SMITH',
  iban,
  accountNumber = '26207729',
}: {
  accountId: string;
  accountType?: 'current' | 'savings' | 'credit' | (string & {});
  holderName?: string;
  iban?: string;
  accountNumber?: string;
}) => ({
  id: accountId,
  type: 'account' as const,
  currency: 'GBP',
  account_type: accountType,
  customer_segment: 'retail',
  account_identifiers: [
    {
      type: 'sort_code_account_number' as const,
      sort_code: '560029',
      account_number: accountNumber,
    },
    { type: 'iban' as const, iban: iban ?? `GB29HSBC601613${accountNumber}` },
  ],
  bic: 'HBUKGB4B',
  account_holder_names: [holderName],
});

const getMockedTrueLayerCard = () => ({
  id: TRUELAYER_CARD_ID,
  type: 'card' as const,
  account_type: 'credit',
  customer_segment: 'retail',
  account_holder_names: ['JOHN SMITH'],
});

/** Cards must be filtered out by the provider; accounts kept. */
export const getMockedTrueLayerAccountsResponse = () => ({
  items: [
    getMockedTrueLayerAccount({ accountId: TRUELAYER_ACCOUNT_1_ID }),
    getMockedTrueLayerAccount({
      accountId: TRUELAYER_ACCOUNT_2_ID,
      accountType: 'savings',
      accountNumber: '26207730',
    }),
    getMockedTrueLayerAccount({
      accountId: TRUELAYER_ACCOUNT_NO_TX_ID,
      accountNumber: '26207731',
    }),
    getMockedTrueLayerCard(),
  ],
  pagination: { next_cursor: null },
});

/** RFC 7807 body answering a not-yet-authorized/expired Connection-Id. */
export const getMockedTrueLayerInvalidStateProblem = () => ({
  type: 'https://truelayer.com/errors/invalid_state',
  title: 'invalid_state',
  status: 400,
  trace_id: '01949b8a0000700080000000000000e1',
  detail: 'the connection must be authorized for this request',
});

/** Balance per account in minor units; unknown ids 404 via the mock handler. */
export const TRUELAYER_BALANCES_MINOR: Record<string, number> = {
  [TRUELAYER_ACCOUNT_1_ID]: 152345,
  [TRUELAYER_ACCOUNT_2_ID]: 5000000,
  [TRUELAYER_ACCOUNT_NO_TX_ID]: 0,
};

export const getMockedTrueLayerBalanceResponse = (accountId: string) => {
  const balanceMinor = TRUELAYER_BALANCES_MINOR[accountId] ?? 0;
  return {
    currency: 'GBP',
    current_balance_in_minor: balanceMinor,
    available_balance_in_minor: balanceMinor,
    overdraft_in_minor: 0,
  };
};

export const getMockedTrueLayerTransactionsRequestResponse = ({ id = 'tl-req-1' }: { id?: string } = {}) => ({
  id,
  status: 'pending',
});

export const getMockedTrueLayerTransaction = ({
  transactionId,
  accountId = TRUELAYER_ACCOUNT_1_ID,
  amountMinor,
  description = 'TESCO STORES',
  status = 'settled',
  timestamp = '2026-10-02T09:30:00Z',
}: {
  transactionId: string;
  accountId?: string;
  amountMinor: number;
  description?: string;
  status?: 'pending' | 'settled';
  timestamp?: string;
}) => ({
  id: transactionId,
  account_id: accountId,
  timestamp,
  description,
  currency: 'GBP',
  amount_in_minor: amountMinor,
  status,
  enrichment: {
    merchant_name: description.split(' ')[0],
    transaction_category: 'GROCERIES',
  },
});

/** Completed transactions-request result; `next_cursor: null` = last page. */
export const getMockedTrueLayerTransactionsResultResponse = (count = 5, accountId = TRUELAYER_ACCOUNT_1_ID) => {
  const items = Array.from({ length: count }, (_, i) =>
    getMockedTrueLayerTransaction({
      transactionId: `tx-${accountId}-${i + 1}`,
      accountId,
      // Odd indexes are credits (+), even are debits (-), so the fee engine's
      // income/expense mapping gets both directions exercised.
      amountMinor: i % 2 === 0 ? -(1000 + i * 100) : 25000 + i * 100,
      description: i % 2 === 0 ? `STORE ${i + 1}` : `SALARY ${i + 1}`,
    }),
  );
  return {
    id: 'tl-req-1',
    status: 'completed',
    completed_at: '2026-10-01T10:00:05.000Z',
    result: {
      items,
      pagination: { next_cursor: null },
    },
  };
};

export const getMockedTrueLayerFailedTransactionsResultResponse = () => ({
  id: 'tl-req-1',
  status: 'failed',
  failure_reason: 'provider_unavailable',
});

// ============================================================================
// Legacy Data API v1 (Unified Data Model) fixtures
// ============================================================================

/** v1 amounts are DECIMAL MAJOR units — the mirror-image of the v3 fixtures. */
export const TRUELAYER_V1_ACCOUNT_1_ID = 'tlv1_main';
export const TRUELAYER_V1_ACCOUNT_2_ID = 'tlv1_savings';

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

/** Balance per account in major units (decimal pounds). */
export const TRUELAYER_V1_BALANCES_MAJOR: Record<string, number> = {
  [TRUELAYER_V1_ACCOUNT_1_ID]: 1523.45,
  [TRUELAYER_V1_ACCOUNT_2_ID]: 50000,
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
      // Odd indexes are credits (+), even are debits (-), mirroring v3.
      amount: i % 2 === 0 ? -(10 + i) : 250 + i,
      description: i % 2 === 0 ? `STORE ${i + 1}` : `SALARY ${i + 1}`,
      timestamp: `2026-10-0${(i % 9) + 1}T09:30:00Z`,
    }),
  ),
});
