import { HttpResponse, http } from 'msw';

import {
  TRUELAYER_ACCOUNT_NO_TX_ID,
  TRUELAYER_BALANCES_MINOR,
  TRUELAYER_CONNECTION_ID,
  getMockedTrueLayerAccountsResponse,
  getMockedTrueLayerBalanceResponse,
  getMockedTrueLayerCreateConnectionResponse,
  getMockedTrueLayerTokenResponse,
  getMockedTrueLayerTransactionsRequestResponse,
  getMockedTrueLayerTransactionsResultResponse,
} from './data';

export const VALID_TL_CLIENT_ID = 'valid-truelayer-client-id';
export const VALID_TL_CLIENT_SECRET = 'valid-truelayer-client-secret';
export const INVALID_TL_CLIENT_SECRET = 'invalid-truelayer-client-secret';
export const MOCK_TL_ACCESS_TOKEN = 'mock-tl-app-access-token';

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
  request.headers.get('authorization') === `Bearer ${MOCK_TL_ACCESS_TOKEN}`;

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

export const trueLayerHandlers = [
  // POST /connect/token — client_credentials app token.
  http.post(`${TL_AUTH_BASE_URL}/connect/token`, async ({ request }) => {
    const body = await request.json().catch(() => null);
    const { client_id, client_secret, grant_type } = (body ?? {}) as Record<string, string>;
    if (
      grant_type !== 'client_credentials' ||
      client_id !== VALID_TL_CLIENT_ID ||
      client_secret !== VALID_TL_CLIENT_SECRET
    ) {
      return problem(401, 'unauthenticated', 'invalid client');
    }
    return HttpResponse.json(getMockedTrueLayerTokenResponse());
  }),

  // POST /v3/data-connections — start an authorization journey.
  http.post(`${TL_API_BASE_URL}/v3/data-connections`, ({ request }) => {
    if (!isAuthorizedBearer(request)) return problem(401, 'unauthenticated');
    return HttpResponse.json(getMockedTrueLayerCreateConnectionResponse(), { status: 201 });
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
];
