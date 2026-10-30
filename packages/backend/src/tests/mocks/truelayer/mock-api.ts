import { HttpResponse, http } from 'msw';

import {
  TRUELAYER_ACCOUNT_NO_TX_ID,
  TRUELAYER_BALANCES_MINOR,
  TRUELAYER_CONNECTION_ID,
  TRUELAYER_V1_BALANCES_MAJOR,
  TRUELAYER_V1_CARD_ID,
  getMockedTrueLayerAccountsResponse,
  getMockedTrueLayerBalanceResponse,
  getMockedTrueLayerCreateConnectionResponse,
  getMockedTrueLayerPaymentsOnlyTokenResponse,
  getMockedTrueLayerTokenResponse,
  getMockedTrueLayerTransactionsRequestResponse,
  getMockedTrueLayerTransactionsResultResponse,
  getMockedTrueLayerV1BalanceResponse,
  getMockedTrueLayerV1AccountsResponse,
  getMockedTrueLayerV1CardsResponse,
  getMockedTrueLayerV1TokenResponse,
  getMockedTrueLayerV1TransactionsResponse,
} from './data';

export const VALID_TL_CLIENT_ID = 'valid-truelayer-client-id';
export const VALID_TL_CLIENT_SECRET = 'valid-truelayer-client-secret';
export const INVALID_TL_CLIENT_SECRET = 'invalid-truelayer-client-secret';

/** v1 authorization codes the mock exchange accepts / rejects. */
export const VALID_TL_V1_CODE = 'valid-v1-auth-code';
export const VALID_TL_V1_REFRESH_TOKEN = 'tl-v1-refresh-token';
export const ROTATED_TL_V1_REFRESH_TOKEN = 'tl-v1-refresh-token-rotated';
export const EXPIRED_TL_V1_REFRESH_TOKEN = 'expired-v1-refresh-token';

export const TL_AUTH_BASE_URL = 'https://auth.truelayer.com';
export const TL_API_BASE_URL = 'https://api.truelayer.com';

const ACCOUNTS_URL = `${TL_API_BASE_URL}/v3/connected-accounts`;

const problem = (status: number, title: string, description?: string) =>
  HttpResponse.json(
    {
      type: `https://truelayer.com/errors/${title}`,
      title,
      status,
      trace_id: '01949b8a0000700080000000000000e1',
      detail: description ?? title,
    },
    { status },
  );

const isAuthorizedBearer = (request: Request): boolean =>
  (request.headers.get('authorization') ?? '').startsWith('Bearer ey');

/** v1 user bearers from the fixture token responses (mock JWTs and rotated). */
const isV1AuthorizedBearer = (request: Request): boolean =>
  (request.headers.get('authorization') ?? '').startsWith('Bearer tl-v1-access-token');

/**
 * Explicit one-off overrides for tests (registration order: these run before the defaults).
 */
export const getTrueLayerAccountsMock = ({
  response,
}: {
  response: ReturnType<typeof getMockedTrueLayerAccountsResponse>;
}) => http.get(ACCOUNTS_URL, () => HttpResponse.json(response));

/** Connection-Id whose bank-side authorization hasn't completed (or expired). */
export const getTrueLayerPendingAccountsMock = () =>
  http.get(ACCOUNTS_URL, () => problem(400, 'invalid_state', 'the connection must be authorized for this request'));

/** Simulate a Console app without the Data product: token lacks connections access. */
export const getTrueLayerPaymentsOnlyTokenMock = () =>
  http.post(`${TL_AUTH_BASE_URL}/connect/token`, () =>
    HttpResponse.json(getMockedTrueLayerPaymentsOnlyTokenResponse()),
  );

/** Apps predating the unified auth server: refresh on /connect/token 404s and
 * must fall back to the legacy api/token endpoint (still served here). */
export const getTrueLayerV1RefreshUnsupportedMock = () =>
  http.post(`${TL_AUTH_BASE_URL}/connect/token`, async ({ request }) => {
    const body = await readTokenBody(request);
    if (body.grant_type === 'refresh_token') {
      return HttpResponse.json({ error: 'not_found', message: 'unknown grant' }, { status: 404 });
    }
    return HttpResponse.json(getMockedTrueLayerTokenResponse());
  });

/** Override the poll result of a transactions request (completed/failed/pending shape). */
export const getTrueLayerTransactionsResultMock = ({
  response,
}: {
  response:
    | ReturnType<typeof getMockedTrueLayerTransactionsResultResponse>
    | ReturnType<typeof getMockedTrueLayerTransactionsRequestResponse>;
}) => http.get(`${ACCOUNTS_URL}/:accountId/transactions/requests/:requestId`, () => HttpResponse.json(response));

/** Make the transactions request POST itself fail (provider outage mid-sync). */
export const getTrueLayerTransactionsRequestErrorMock = ({ status = 503 }: { status?: number } = {}) =>
  http.post(`${ACCOUNTS_URL}/:accountId/transactions/requests`, () =>
    problem(status, status === 503 ? 'provider_error' : 'bad_request', 'provider temporarily unavailable'),
  );

/** v1: consent expired/revoked — data endpoints answer 403 access_denied. */
export const getTrueLayerV1ConsentDeadMock = () => [
  http.get(`${TL_API_BASE_URL}/data/v1/accounts`, () => HttpResponse.json({ error: 'access_denied' }, { status: 403 })),
  http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/balance`, () =>
    HttpResponse.json({ error: 'access_denied' }, { status: 403 }),
  ),
  http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/transactions`, () =>
    HttpResponse.json({ error: 'access_denied' }, { status: 403 }),
  ),
];

/** v1: override the transaction rows served for any account. */
export const getTrueLayerV1TransactionsResultMock = ({
  response,
}: {
  response: ReturnType<typeof getMockedTrueLayerV1TransactionsResponse>;
}) => http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/transactions`, () => HttpResponse.json(response));

/** v1: two Link-header pages; first row on page 1 is `dupTx`, repeated on page 2. */
export const getTrueLayerV1PagedTransactionsMock = ({ accountId, dupTxId }: { accountId: string; dupTxId: string }) => {
  const page1 = {
    results: [
      {
        transaction_id: dupTxId,
        timestamp: '2026-10-05T09:30:00Z',
        description: 'PAGE ONE',
        currency: 'GBP',
        amount: -11.11,
        transaction_type: 'DEBIT',
      },
    ],
  };
  const page2 = {
    results: [
      {
        transaction_id: dupTxId,
        timestamp: '2026-10-05T09:30:00Z',
        description: 'PAGE ONE REPEATED',
        currency: 'GBP',
        amount: -11.11,
        transaction_type: 'DEBIT',
      },
      {
        transaction_id: `${dupTxId}-page2`,
        timestamp: '2026-10-04T09:30:00Z',
        description: 'PAGE TWO',
        currency: 'GBP',
        amount: 5,
        transaction_type: 'CREDIT',
      },
    ],
  };
  const nextUrl = `${TL_API_BASE_URL}/data/v1/accounts/${accountId}/transactions?page=2`;
  let servedFirst = false;
  return http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/transactions`, () => {
    if (!servedFirst) {
      servedFirst = true;
      return HttpResponse.json(page1, {
        headers: { Link: `<${nextUrl}>; rel="next"` },
      });
    }
    return HttpResponse.json(page2);
  });
};

/** Token endpoints accept JSON (client_credentials) or form-encoded (v1 grants). */
const readTokenBody = async (request: { text: () => Promise<string> }): Promise<Record<string, string>> => {
  const raw = await request.text();
  if (raw.trim().startsWith('{')) {
    return (JSON.parse(raw) ?? {}) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(raw));
};

/** Shared v1 refresh response: fixture tokens, rotation semantics. */
const v1RefreshResponse = (refreshToken?: string) => {
  if (refreshToken === EXPIRED_TL_V1_REFRESH_TOKEN) {
    return HttpResponse.json({ error: 'invalid_grant', error_description: 'refresh token expired' }, { status: 400 });
  }
  if (refreshToken !== VALID_TL_V1_REFRESH_TOKEN && refreshToken !== ROTATED_TL_V1_REFRESH_TOKEN) {
    return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
  }
  return HttpResponse.json(
    getMockedTrueLayerV1TokenResponse({
      accessToken: 'tl-v1-access-token-rotated',
      refreshToken: ROTATED_TL_V1_REFRESH_TOKEN,
    }),
  );
};

export const trueLayerHandlers = [
  // POST /connect/token — the auth server handling all grants: JSON
  // client_credentials (app token, v3) and form-encoded authorization_code /
  // refresh_token (legacy v1), mirroring the real endpoint.
  http.post(`${TL_AUTH_BASE_URL}/connect/token`, async ({ request }) => {
    const body = await readTokenBody(request);
    const { client_id, client_secret, grant_type } = body;
    if (client_id !== VALID_TL_CLIENT_ID || client_secret !== VALID_TL_CLIENT_SECRET) {
      return grant_type === 'client_credentials'
        ? problem(401, 'unauthenticated', 'invalid client')
        : HttpResponse.json({ error: 'invalid_client' }, { status: 401 });
    }
    if (grant_type === 'client_credentials') return HttpResponse.json(getMockedTrueLayerTokenResponse());
    if (grant_type === 'authorization_code') {
      if (!body.redirect_uri) return HttpResponse.json({ error: 'invalid_grant' }, { status: 400 });
      if (body.code !== VALID_TL_V1_CODE) {
        return HttpResponse.json(
          { error: 'invalid_grant', error_description: 'authorization code expired' },
          { status: 400 },
        );
      }
      return HttpResponse.json(getMockedTrueLayerV1TokenResponse());
    }
    if (grant_type === 'refresh_token') return v1RefreshResponse(body.refresh_token);
    return HttpResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }),

  // POST /v3/data-connections — start an authorization journey.
  http.post(`${TL_API_BASE_URL}/v3/data-connections`, ({ request }) => {
    if (!isAuthorizedBearer(request)) return problem(401, 'unauthenticated');
    return HttpResponse.json(getMockedTrueLayerCreateConnectionResponse(), {
      status: 201,
    });
  }),

  // GET /v3/connected-accounts — the default treats the fixture Connection-Id
  // as authorized; tests override for pending/failed journeys.
  http.get(ACCOUNTS_URL, ({ request }) => {
    if (!isAuthorizedBearer(request)) return problem(401, 'unauthenticated');
    if (request.headers.get('connection-id') !== TRUELAYER_CONNECTION_ID) return problem(400, 'invalid_state');
    return HttpResponse.json(getMockedTrueLayerAccountsResponse());
  }),

  // GET /v3/connected-accounts/:id/balance
  http.get(new RegExp(`${ACCOUNTS_URL}/[^/]+/balance$`), ({ request }) => {
    if (!isAuthorizedBearer(request)) return problem(401, 'unauthenticated');
    if (request.headers.get('connection-id') !== TRUELAYER_CONNECTION_ID) return problem(400, 'invalid_state');
    const path = new URL(request.url).pathname;
    const accountId = path.split('/')[3] ?? '';
    if (!(accountId in TRUELAYER_BALANCES_MINOR)) return problem(404, 'not_found', 'unknown account id');
    return HttpResponse.json(getMockedTrueLayerBalanceResponse(accountId));
  }),

  // POST /v3/connected-accounts/:id/transactions/requests — async request kickoff.
  http.post(new RegExp(`${ACCOUNTS_URL}/[^/]+/transactions/requests$`), ({ request }) => {
    if (!isAuthorizedBearer(request)) return problem(401, 'unauthenticated');
    if (request.headers.get('connection-id') !== TRUELAYER_CONNECTION_ID) return problem(400, 'invalid_state');
    return HttpResponse.json(getMockedTrueLayerTransactionsRequestResponse(), { status: 202 });
  }),

  // GET /v3/connected-accounts/:id/transactions/requests/:requestId — the
  // default answers `completed` immediately (async model), with the account's
  // 5 fixture rows.
  http.get(`${ACCOUNTS_URL}/:accountId/transactions/requests/:requestId`, ({ request, params }) => {
    if (!isAuthorizedBearer(request)) return problem(401, 'unauthenticated');
    if (request.headers.get('connection-id') !== TRUELAYER_CONNECTION_ID) return problem(400, 'invalid_state');
    const accountId = String(params.accountId ?? '');
    const balanceMinor = TRUELAYER_BALANCES_MINOR[accountId];
    if (balanceMinor === undefined) return problem(404, 'not_found', 'unknown account id');
    if (accountId === TRUELAYER_ACCOUNT_NO_TX_ID)
      return HttpResponse.json(getMockedTrueLayerTransactionsResultResponse(0, accountId));
    return HttpResponse.json(getMockedTrueLayerTransactionsResultResponse(5, accountId));
  }),

  // ---- Legacy Data API v1 (Unified Data Model) ----------------------------

  // POST /token — legacy refresh endpoint kept as the api-client's fallback
  // when the auth server's /connect/token rejects the refresh grant.
  http.post(`${TL_API_BASE_URL}/token`, async ({ request }) => {
    const body = await readTokenBody(request);
    if (body.grant_type !== 'refresh_token') {
      return HttpResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }
    return v1RefreshResponse(body.refresh_token);
  }),

  http.get(`${TL_API_BASE_URL}/data/v1/accounts`, ({ request }) => {
    if (!isV1AuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    return HttpResponse.json(getMockedTrueLayerV1AccountsResponse());
  }),

  http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/balance`, ({ request, params }) => {
    if (!isV1AuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    const accountId = String(params.accountId ?? '');
    // Card products are served under /data/v1/cards only.
    if (!(accountId in TRUELAYER_V1_BALANCES_MAJOR) || accountId === TRUELAYER_V1_CARD_ID) {
      return problem(404, 'not_found', 'unknown account id');
    }
    return HttpResponse.json(getMockedTrueLayerV1BalanceResponse(accountId));
  }),

  http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/transactions`, ({ request, params }) => {
    if (!isV1AuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    const accountId = String(params.accountId ?? '');
    if (!(accountId in TRUELAYER_V1_BALANCES_MAJOR) || accountId === TRUELAYER_V1_CARD_ID) {
      return problem(404, 'not_found', 'unknown account id');
    }
    return HttpResponse.json(getMockedTrueLayerV1TransactionsResponse(5, accountId));
  }),

  // Card-only providers answer 501 on /data/v1/accounts; the default mirrors a
  // current-account bank (HSBC-like) where cards are simply not served.
  http.get(`${TL_API_BASE_URL}/data/v1/cards`, () =>
    HttpResponse.json({ error: 'not_supported', message: 'Feature not supported by the provider' }, { status: 501 }),
  ),

  http.get(`${TL_API_BASE_URL}/data/v1/cards/:accountId/balance`, ({ request, params }) => {
    if (!isV1AuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    const accountId = String(params.accountId ?? '');
    if (accountId !== TRUELAYER_V1_CARD_ID) return problem(404, 'not_found', 'unknown card id');
    return HttpResponse.json(getMockedTrueLayerV1BalanceResponse(accountId));
  }),

  http.get(`${TL_API_BASE_URL}/data/v1/cards/:accountId/transactions`, ({ request, params }) => {
    if (!isV1AuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    const accountId = String(params.accountId ?? '');
    if (accountId !== TRUELAYER_V1_CARD_ID) return problem(404, 'not_found', 'unknown card id');
    return HttpResponse.json(getMockedTrueLayerV1TransactionsResponse(3, accountId));
  }),
];

/** Amex-like provider: no accounts API, everything on /data/v1/cards. */
export const getTrueLayerV1CardsOnlyMock = () => [
  http.get(`${TL_API_BASE_URL}/data/v1/accounts`, () =>
    HttpResponse.json({ error: 'not_supported', message: 'Feature not supported by the provider' }, { status: 501 }),
  ),
  http.get(`${TL_API_BASE_URL}/data/v1/cards`, ({ request }) => {
    if (!isV1AuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    return HttpResponse.json(getMockedTrueLayerV1CardsResponse());
  }),
];
