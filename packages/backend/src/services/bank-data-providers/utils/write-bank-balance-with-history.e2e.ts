import { describe, expect, it } from '@jest/globals';
import Balances from '@models/balances.model';
import { connection } from '@models/connection';
import * as helpers from '@tests/helpers';
import { getMonobankTransactionsMock } from '@tests/mocks/monobank/mock-api';

/**
 * Regression coverage for the `writeBankBalanceWithHistory` helper.
 *
 * Before extraction, LunchFlow and Walutomat only updated `Accounts.currentBalance`
 * after a sync — they never recomputed `refCurrentBalance` and never wrote a
 * `Balances` row, leaving the analytics chart flat for those providers.
 * Monobank's `refreshBalance` had the same gap (TODO comment from day one).
 *
 * Each test below exercises a sync through its provider's normal mocked flow
 * and asserts that (a) a `Balances` row exists for today and (b)
 * `refCurrentBalance` is set on the account — the two things the prior code
 * silently skipped.
 */
const todayIso = (): string => new Date().toISOString().slice(0, 10);

const expectBalanceHistoryWrittenForToday = async (accountId: string): Promise<void> => {
  const balances = await Balances.findAll({ where: { accountId } });
  expect(balances.some((b) => new Date(b.date).toISOString().slice(0, 10) === todayIso())).toBe(true);
};

describe('writeBankBalanceWithHistory (bank-provider balance writer)', () => {
  it('LunchFlow sync writes a Balance row for today and a non-zero refCurrentBalance', async () => {
    const { account } = await helpers.lunchflow.mockTransactions();

    const refreshed = await helpers.getAccount({ id: account.id, raw: true });
    // Pre-fix: refCurrentBalance was left at 0; the chart row was missing.
    expect(Number(refreshed.refCurrentBalance)).toBeGreaterThan(0);
    await expectBalanceHistoryWrittenForToday(account.id);
  });

  it('Walutomat sync writes a Balance row for today and a non-zero refCurrentBalance', async () => {
    const { account } = await helpers.walutomat.mockTransactions();

    const refreshed = await helpers.getAccount({ id: account.id, raw: true });
    expect(Number(refreshed.refCurrentBalance)).toBeGreaterThan(0);
    await expectBalanceHistoryWrittenForToday(account.id);
  });

  it('Monobank sync writes a Balance row for today and a non-zero refCurrentBalance', async () => {
    const { account } = await helpers.monobank.mockTransactions();

    const refreshed = await helpers.getAccount({ id: account.id, raw: true });
    expect(Number(refreshed.refCurrentBalance)).toBeGreaterThan(0);
    await expectBalanceHistoryWrittenForToday(account.id);
  });

  it('Monobank sync re-measures refCreditLimit at the same rate as refCurrentBalance', async () => {
    const { connectionId } = await helpers.monobank.pair();
    const { accounts: externalAccounts } = await helpers.bankDataProviders.listExternalAccounts({
      connectionId,
      raw: true,
    });
    // The mocked UAH account carries a 2000 UAH credit limit; the test base currency is AED.
    const uahExternal = externalAccounts.find((a: { currency: string }) => a.currency === 'UAH')!;

    global.mswMockServer.use(getMonobankTransactionsMock({ response: [] }));
    const { syncedAccounts } = await helpers.bankDataProviders.connectSelectedAccounts({
      connectionId,
      accountExternalIds: [uahExternal.externalId],
      raw: true,
    });
    const accountId = syncedAccounts[0]!.id;
    await helpers.sleep(1000);

    const connected = await helpers.getAccount({ id: accountId, raw: true });
    expect(Number(connected.refCreditLimit)).toBeGreaterThan(0);

    // A limit still measured at an earlier day's rate, as the previous rate-sync remeasure left it.
    await connection.sequelize.query(`UPDATE "Accounts" SET "refCreditLimit" = 1 WHERE "id" = :id`, {
      replacements: { id: accountId },
    });

    await helpers.monobank.mockTransactions({ transactions: [{ amount: -1000, balance: 150000 }] });

    const synced = await helpers.getAccount({ id: accountId, raw: true });
    expect(Number(synced.currentBalance)).toBe(1500);
    expect(Number(synced.refCreditLimit)).toBe(Number(connected.refCreditLimit));
  });
});
