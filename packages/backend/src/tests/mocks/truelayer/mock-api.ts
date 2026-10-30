import { HttpResponse, http } from 'msw';

import {
  TRUELAYER_V1_BALANCES_MAJOR,
  TRUELAYER_V1_CARD_ID,
  getMockedTrueLayerTokenResponse,
  getMockedTrueLayerV1BalanceResponse,
  getMockedTrueLayerV1AccountsResponse,
  getMockedTrueLayerV1CardsResponse,
  getMockedTrueLayerV1TokenResponse,
  getMockedTrueLayerV1TransactionsResponse,
} from './data';

export const VALID_TL_CLIENT_ID = 'valid-truelayer-client-id';
export const VALID_TL_CLIENT_SECRET = 'valid-truelayer-client-secret';
export const INVALID_TL_CLIENT_SECRET = 'invalid-truelayer-client-secret';

/** Authorization codes the mock exchange accepts / rejects. */
export const VALID_TL_V1_CODE = 'valid-v1-auth-code';
export const VALID_TL_V1_REFRESH_TOKEN = 'tl-v1-refresh-token';
export const ROTATED_TL_V1_REFRESH_TOKEN = 'tl-v1-refresh-token-rotated';
export const EXPIRED_TL_V1_REFRESH_TOKEN = 'expired-v1-refresh-token';

export const TL_AUTH_BASE_URL = 'https://auth.truelayer.com';
export const TL_API_BASE_URL = 'https://api.truelayer.com';

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

/** User bearers from the fixture token responses (initial + rotated). */
const isAuthorizedBearer = (request: Request): boolean =>
  (request.headers.get('authorization') ?? '').startsWith('Bearer tl-v1-access-token');

/** The live API answers 400 "Invalid date range provided." when `from` is
 * more than ~1 year in the past — banks never serve that much history. One
 * day of slack so the provider's own 365-day default window passes. */
const rangeTooWide = (request: Request): boolean => {
  const from = new URL(request.url).searchParams.get('from');
  return !!from && Date.now() - new Date(from).getTime() > 366 * 24 * 60 * 60 * 1000;
};

/**
 * Explicit one-off overrides for tests (registration order: these run before the defaults).
 */

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

/** Consent expired/revoked — data endpoints answer 403 access_denied. */
export const getTrueLayerV1ConsentDeadMock = () => [
  http.get(`${TL_API_BASE_URL}/data/v1/accounts`, () => HttpResponse.json({ error: 'access_denied' }, { status: 403 })),
  http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/balance`, () =>
    HttpResponse.json({ error: 'access_denied' }, { status: 403 }),
  ),
  http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/transactions`, () =>
    HttpResponse.json({ error: 'access_denied' }, { status: 403 }),
  ),
];

/** Override the transaction rows served for any account. */
export const getTrueLayerV1TransactionsResultMock = ({
  response,
}: {
  response: ReturnType<typeof getMockedTrueLayerV1TransactionsResponse>;
}) => http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/transactions`, () => HttpResponse.json(response));

/** Two Link-header pages; first row on page 1 is `dupTx`, repeated on page 2. */
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

/** Token endpoints accept JSON (client_credentials) or form-encoded (OAuth grants). */
const readTokenBody = async (request: { text: () => Promise<string> }): Promise<Record<string, string>> => {
  const raw = await request.text();
  if (raw.trim().startsWith('{')) {
    return (JSON.parse(raw) ?? {}) as Record<string, string>;
  }
  return Object.fromEntries(new URLSearchParams(raw));
};

/** Shared refresh response: fixture tokens, rotation semantics. */
const refreshResponse = (refreshToken?: string) => {
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
  // client_credentials (app token probe) and form-encoded authorization_code /
  // refresh_token, mirroring the real endpoint.
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
    if (grant_type === 'refresh_token') return refreshResponse(body.refresh_token);
    return HttpResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
  }),

  // POST /token — legacy refresh endpoint kept as the api-client's fallback
  // when the auth server's /connect/token rejects the refresh grant.
  http.post(`${TL_API_BASE_URL}/token`, async ({ request }) => {
    const body = await readTokenBody(request);
    if (body.grant_type !== 'refresh_token') {
      return HttpResponse.json({ error: 'unsupported_grant_type' }, { status: 400 });
    }
    return refreshResponse(body.refresh_token);
  }),

  http.get(`${TL_API_BASE_URL}/data/v1/accounts`, ({ request }) => {
    if (!isAuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    return HttpResponse.json(getMockedTrueLayerV1AccountsResponse());
  }),

  http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/balance`, ({ request, params }) => {
    if (!isAuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    const accountId = String(params.accountId ?? '');
    // Live API: a card id on the accounts resource path is a 400 (not 404).
    if (accountId === TRUELAYER_V1_CARD_ID) return problem(400, 'invalid_request', 'not an account id');
    if (!(accountId in TRUELAYER_V1_BALANCES_MAJOR)) return problem(404, 'not_found', 'unknown account id');
    return HttpResponse.json(getMockedTrueLayerV1BalanceResponse(accountId));
  }),

  http.get(`${TL_API_BASE_URL}/data/v1/accounts/:accountId/transactions`, ({ request, params }) => {
    if (!isAuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    if (rangeTooWide(request)) return problem(400, 'invalid_request', 'Invalid date range provided.');
    const accountId = String(params.accountId ?? '');
    if (accountId === TRUELAYER_V1_CARD_ID) return problem(400, 'invalid_request', 'not an account id');
    if (!(accountId in TRUELAYER_V1_BALANCES_MAJOR)) return problem(404, 'not_found', 'unknown account id');
    return HttpResponse.json(getMockedTrueLayerV1TransactionsResponse(5, accountId));
  }),

  // Card-only providers answer 501 on /data/v1/accounts; the default mirrors a
  // current-account bank (HSBC-like) where cards are simply not served.
  http.get(`${TL_API_BASE_URL}/data/v1/cards`, () =>
    HttpResponse.json({ error: 'not_supported', message: 'Feature not supported by the provider' }, { status: 501 }),
  ),

  http.get(`${TL_API_BASE_URL}/data/v1/cards/:accountId/balance`, ({ request, params }) => {
    if (!isAuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    const accountId = String(params.accountId ?? '');
    if (accountId !== TRUELAYER_V1_CARD_ID) return problem(404, 'not_found', 'unknown card id');
    return HttpResponse.json(getMockedTrueLayerV1BalanceResponse(accountId));
  }),

  http.get(`${TL_API_BASE_URL}/data/v1/cards/:accountId/transactions`, ({ request, params }) => {
    if (!isAuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    if (rangeTooWide(request)) return problem(400, 'invalid_request', 'Invalid date range provided.');
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
    if (!isAuthorizedBearer(request)) return HttpResponse.json({ error: 'access_denied' }, { status: 403 });
    return HttpResponse.json(getMockedTrueLayerV1CardsResponse());
  }),
];
