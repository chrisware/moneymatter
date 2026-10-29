import { asDecimal } from '@bt/shared/types';
import { HttpResponse, http } from 'msw';

import { getMockedAkahuAccount, getMockedAkahuAccounts, getMockedAkahuMe, getMockedAkahuTransactions } from './data';

export const VALID_AKAHU_USER_TOKEN = 'valid-akahu-user-token-12345';
export const VALID_AKAHU_APP_TOKEN = 'valid-akahu-app-token-67890';
export const INVALID_AKAHU_USER_TOKEN = 'invalid-akahu-user-token';

export const AKAHU_BASE_URL = 'https://api.akahu.io/v1';

const isAuthed = (request: Request): boolean =>
  request.headers.get('authorization') === `Bearer ${VALID_AKAHU_USER_TOKEN}` &&
  request.headers.get('x-akahu-id') === VALID_AKAHU_APP_TOKEN;

const unauthorized = () =>
  new HttpResponse(JSON.stringify({ success: false, message: 'Permission Denied' }), {
    status: 401,
    statusText: 'Unauthorized',
  });

/**
 * Explicit one-off overrides for tests (registration order: these run before the defaults).
 */
export const getAkahuMeMock = ({ response }: { response: ReturnType<typeof getMockedAkahuMe> }) =>
  http.get(`${AKAHU_BASE_URL}/me`, () => HttpResponse.json(response));

export const getAkahuAccountsMock = ({ response }: { response: ReturnType<typeof getMockedAkahuAccounts> }) =>
  http.get(`${AKAHU_BASE_URL}/accounts`, () => HttpResponse.json(response));

export const getAkahuAccountMock = ({ accountId, current }: { accountId: string; current: number }) =>
  http.get(`${AKAHU_BASE_URL}/accounts/${accountId}`, () =>
    HttpResponse.json({
      success: true,
      item: {
        ...getMockedAkahuAccount({ accountId }),
        balance: { ...getMockedAkahuAccount({ accountId }).balance, current: asDecimal(current) },
      },
    }),
  );

export const getAkahuTransactionsMock = ({
  response,
  accountId,
}: {
  response?: ReturnType<typeof getMockedAkahuTransactions>;
  accountId?: string;
}) =>
  http.get(
    accountId
      ? `${AKAHU_BASE_URL}/accounts/${accountId}/transactions`
      : new RegExp(`${AKAHU_BASE_URL}/accounts/acc_[a-z0-9]+/transactions`),
    () => HttpResponse.json(response || getMockedAkahuTransactions()),
  );

export const akahuHandlers = [
  // GET /me — token-pair validation
  http.get(`${AKAHU_BASE_URL}/me`, ({ request }) => {
    if (!isAuthed(request)) return unauthorized();
    return HttpResponse.json(getMockedAkahuMe());
  }),

  // GET /accounts
  http.get(`${AKAHU_BASE_URL}/accounts`, ({ request }) => {
    if (!isAuthed(request)) return unauthorized();
    return HttpResponse.json(getMockedAkahuAccounts());
  }),

  // POST /refresh — manual refresh trigger (default: accepted)
  http.post(`${AKAHU_BASE_URL}/refresh`, ({ request }) => {
    if (!isAuthed(request)) return unauthorized();
    return HttpResponse.json({ success: true });
  }),

  // GET /accounts/:accountId — single account with balance
  http.get(new RegExp(`${AKAHU_BASE_URL}/accounts/acc_[a-z0-9]+$`), ({ request }) => {
    if (!isAuthed(request)) return unauthorized();
    const path = new URL(request.url).pathname;
    const accountId = path.slice(path.lastIndexOf('/') + 1);
    return HttpResponse.json({ success: true, item: getMockedAkahuAccount({ accountId }) });
  }),

  // GET /accounts/:accountId/transactions
  http.get(new RegExp(`${AKAHU_BASE_URL}/accounts/acc_[a-z0-9]+/transactions`), ({ request }) => {
    if (!isAuthed(request)) return unauthorized();
    const path = new URL(request.url).pathname;
    const accountId = path.split('/')[3];
    return HttpResponse.json(getMockedAkahuTransactions(5, accountId ?? undefined));
  }),
];
