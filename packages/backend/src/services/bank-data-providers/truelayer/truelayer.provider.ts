import type { Cents, RecordId } from '@bt/shared/types';
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  ACCOUNT_TYPES,
  BANK_PROVIDER_TYPE,
  DEACTIVATION_REASON,
  TRANSACTION_TRANSFER_NATURE,
  TRANSACTION_TYPES,
  asCents,
} from '@bt/shared/types';
import { Money } from '@common/types/money';
import { t } from '@i18n/index';
import { BadRequestError, ForbiddenError, ServiceUnavailableError, ValidationError } from '@js/errors';
import { logger } from '@js/utils';
import Accounts from '@models/accounts.model';
import BankDataProviderConnections from '@models/bank-data-provider-connections.model';
import { findOneTransaction } from '@models/transactions-query';
import Users, { getUserDefaultCategory } from '@models/users.model';
import { FRONTEND_BASE_URL } from '@root/config';
import {
  BaseBankDataProvider,
  type DateRange,
  type LoadTransactionsForPeriodResult,
  type ProviderAccount,
  type ProviderBalance,
  type ProviderMetadata,
  type ProviderTransaction,
} from '@services/bank-data-providers';
import { getEmailForUser } from '@services/sharing/find-user-by-email.service';
import { createTransaction } from '@services/transactions';
import { accountHasPlannedRows } from '@services/transactions/planned-matching';
import { Op, Sequelize } from 'sequelize';

import { clampSyncStartToLink } from '../utils/clamp-sync-start-to-link';
import { encryptCredentials } from '../utils/credential-encryption';
import { notifyPlannedConfirmations } from '../utils/notify-planned-confirmations';
import { writeBankBalanceWithHistory } from '../utils/write-bank-balance-with-history';
import { centsFromMinorUnits, TrueLayerApiClient } from './api-client';
import type { TrueLayerApiAccount, TrueLayerApiTransaction, TrueLayerCredentials, TrueLayerMetadata } from './types';

/** The callback page the TrueLayer hosted journey returns the user to. */
const getRedirectUrl = () => process.env.TRUELAYER_REDIRECT_URL || `${FRONTEND_BASE_URL}/bank-callback`;

/**
 * UK Open Banking recurring consents are granted for 180 days (TrueLayer's
 * reconfirmation endpoint is still in development, so an expired consent is
 * resolved by creating a fresh data connection via `reauthorize`).
 */
const CONSENT_WINDOW_DAYS = 180;

/**
 * Incremental fetches start this far before the newest stored transaction.
 * TrueLayer date ranges are day-precise and inclusive on both ends, and the
 * same-day re-fetch cost is absorbed by `originalId` dedup — the overlap
 * matters because a pending transaction settles under a DIFFERENT id after we
 * last synced, so the settled row must be picked up even when it sits behind
 * the newest stored one.
 */
const INCREMENTAL_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

/** Initial backfill depth: UK providers expose at least 180 days, most 365. */
const INITIAL_HISTORY_DAYS = 365;

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  current: 'Current account',
  savings: 'Savings account',
  credit: 'Credit account',
  cash: 'Cash account',
  pension: 'Pension',
  mortgage: 'Mortgage',
  branch: 'Branch account',
  other: 'Account',
};

interface PersisterCounters {
  createdTransactionIds: string[];
  mergedIntoPlannedCount: number;
  skippedPreLinkCount: number;
  skippedPendingCount: number;
}

/**
 * TrueLayer provider implementation (Data API v3).
 * Syncs UK bank accounts (HSBC, Barclays, Monzo, …) through the user's own
 * TrueLayer application: app client-credentials are stored per connection and
 * each bank link is a Data v3 `Connection-Id` established via TrueLayer's
 * hosted authorization page.
 *
 * Docs: https://docs.truelayer.com/docs/enable-your-users-to-connect-their-bank-account
 */
export class TrueLayerProvider extends BaseBankDataProvider {
  readonly metadata: ProviderMetadata = {
    get redirectUrl() {
      return getRedirectUrl();
    },
    type: BANK_PROVIDER_TYPE.TRUELAYER,
    name: 'TrueLayer',
    description: 'Sync UK bank accounts (HSBC, Barclays, Monzo and more) through your TrueLayer application',
    documentationUrl: 'https://docs.truelayer.com/docs/enable-your-users-to-connect-their-bank-account',
    features: {
      supportsWebhooks: false, // webhooks need a Console-registered URI; polling covers auto-sync
      supportsRealtime: false,
      requiresReauth: true, // recurring consent lapses after ~180 days
      supportsManualSync: true,
      supportsAutoSync: true,
      defaultSyncInterval: 12 * 60 * 60 * 1000, // 12 hours
      minSyncInterval: 5 * 60 * 1000, // 5 minutes
    },
  };

  // ============================================================================
  // Connection Management
  // ============================================================================

  async connect(userId: number, credentials: unknown): Promise<string> {
    if (!this.isValidCredentials(credentials)) {
      throw new ValidationError({ message: t({ key: 'bankDataProviders.truelayer.invalidCredentialsFormat' }) });
    }

    const apiClient = new TrueLayerApiClient(credentials);

    // Credentials failure must not be swallowed: 401/403 → ForbiddenError with
    // a clear message; network/5xx propagate so callers can tell "bad keys"
    // from "TrueLayer is down".
    const isValid = await apiClient.testConnection();
    if (!isValid) {
      throw new ForbiddenError({ message: t({ key: 'bankDataProviders.truelayer.invalidCredentials' }) });
    }

    const endUser = await this.getEndUser(userId);
    const created = await apiClient.createDataConnection({ returnUri: getRedirectUrl(), user: endUser });
    if (!created.hosted_page?.uri) {
      throw new BadRequestError({ message: t({ key: 'bankDataProviders.truelayer.noAuthUrl' }) });
    }

    const existingConnections = await BankDataProviderConnections.count({
      where: { userId, providerType: this.metadata.type },
    });
    const providerName = existingConnections > 0 ? `TrueLayer (${existingConnections + 1})` : 'TrueLayer';

    const connection = await BankDataProviderConnections.create({
      userId,
      providerType: this.metadata.type,
      providerName,
      // Stays inactive until the user finishes the hosted journey and the
      // callback confirms the Connection-Id serves data.
      isActive: false,
      credentials: encryptCredentials({
        clientId: credentials.clientId,
        clientSecret: credentials.clientSecret,
        environment: credentials.environment ?? 'production',
      }),
      metadata: {
        tlPendingConnectionId: created.id,
        tlUserId: created.user?.id ?? null,
        authUrl: created.hosted_page.uri,
        accountCount: 0,
        consecutiveAuthFailures: 0,
        deactivationReason: null,
      } satisfies TrueLayerMetadata,
    } as any);

    return connection.id;
  }

  /**
   * Hosted authorization-page URI for a pending connection — used by the
   * frontend (and by connect-provider) to redirect the user to TrueLayer.
   */
  async getAuthorizationUrl(connectionId: string): Promise<string> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);

    const metadata = connection.metadata as TrueLayerMetadata;
    if (!metadata.authUrl) {
      throw new BadRequestError({ message: t({ key: 'bankDataProviders.truelayer.authUrlNotFound' }) });
    }
    return metadata.authUrl;
  }

  /**
   * Complete the authorization journey after the hosted page returned the
   * user to the callback URL. There is no code/state to exchange in Data v3:
   * confirmation is "does this Connection-Id serve data yet?" — TrueLayer
   * answers `invalid_state` until the user's consent is active at the bank.
   */
  async handleAuthorizationCallback(connectionId: string): Promise<void> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);

    const credentials = await this.getValidatedCredentials(connectionId);
    const metadata = connection.metadata as TrueLayerMetadata;
    const pendingId = metadata.tlPendingConnectionId;

    if (!pendingId) {
      // Already confirmed (double-submit / refreshed page) — idempotent success.
      if (metadata.tlConnectionId) return;
      throw new BadRequestError({ message: t({ key: 'bankDataProviders.truelayer.noPendingAuthorization' }) });
    }

    const apiClient = new TrueLayerApiClient(credentials);
    const accountsResponse = await apiClient.getConnectedAccounts({
      connectionId: pendingId,
      tolerateInvalidState: true,
    });

    if (!accountsResponse) {
      // 503: consent not active YET — the user may still be finishing the bank
      // side of the journey; the callback page retries on this code.
      throw new ServiceUnavailableError({ message: t({ key: 'bankDataProviders.truelayer.authorizationPending' }) });
    }

    const now = new Date();
    const accounts = (accountsResponse.items ?? []).filter((a) => a.type === 'account');

    const newMetadata: TrueLayerMetadata = {
      ...metadata,
      tlConnectionId: pendingId,
      tlPendingConnectionId: undefined,
      authUrl: undefined,
      accounts,
      accountCount: accounts.length,
      consentValidFrom: now.toISOString(),
      consentValidUntil: new Date(now.getTime() + CONSENT_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      consecutiveAuthFailures: 0,
      deactivationReason: null,
    };

    connection.metadata = newMetadata as any;
    connection.isActive = true;
    await connection.save();

    // A reauthorize produced a NEW Connection-Id, and account ids are scoped to
    // a connection — re-match existing system accounts by their stable bank
    // identifier so their synced history keeps flowing.
    await this.updateExistingAccountExternalIds({ connectionId, newAccounts: accounts });
  }

  /**
   * Start a fresh consent journey when the current one expired/was revoked.
   * Returns the hosted-page URL the frontend should redirect to; the callback
   * completes the swap (`handleAuthorizationCallback`).
   */
  async reauthorize(connectionId: string): Promise<string> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);

    const credentials = await this.getValidatedCredentials(connectionId);
    const metadata = connection.metadata as TrueLayerMetadata;

    const apiClient = new TrueLayerApiClient(credentials);
    const endUser = await this.getEndUser(connection.userId);
    const created = await apiClient.createDataConnection({
      returnUri: getRedirectUrl(),
      user: endUser,
      tlUserId: metadata.tlUserId,
    });
    if (!created.hosted_page?.uri) {
      throw new BadRequestError({ message: t({ key: 'bankDataProviders.truelayer.noAuthUrl' }) });
    }

    // Mark inactive + expired up-front: every surfacing (badge, banner) shows
    // "needs reconnect" until the journey completes. The stale consent's
    // transactions keep their account links via externalId re-matching above.
    connection.isActive = false;
    connection.metadata = {
      ...metadata,
      tlPendingConnectionId: created.id,
      tlUserId: created.user?.id ?? metadata.tlUserId,
      authUrl: created.hosted_page.uri,
      consentValidUntil: new Date().toISOString(),
    } as TrueLayerMetadata;
    await connection.save();

    return created.hosted_page.uri;
  }

  async disconnect(connectionId: string): Promise<void> {
    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);

    // Data v3 exposes no revoke endpoint; dropping the row stops all access
    // (the consent itself lapses at the bank after its window).
    await connection.destroy();
  }

  async validateCredentials(credentials: unknown): Promise<boolean> {
    if (!this.isValidCredentials(credentials)) {
      return false;
    }
    const apiClient = new TrueLayerApiClient(credentials);
    return await apiClient.testConnection();
  }

  async refreshCredentials(connectionId: string, newCredentials: unknown): Promise<void> {
    if (!this.isValidCredentials(newCredentials)) {
      throw new ValidationError({ message: t({ key: 'bankDataProviders.truelayer.invalidCredentialsFormat' }) });
    }

    const connection = await this.getConnection(connectionId);
    this.validateProviderType(connection);

    const apiClient = new TrueLayerApiClient(newCredentials);
    const isValid = await apiClient.testConnection();
    if (!isValid) {
      throw new ForbiddenError({ message: t({ key: 'bankDataProviders.truelayer.invalidCredentials' }) });
    }

    connection.setEncryptedCredentials({
      clientId: newCredentials.clientId,
      clientSecret: newCredentials.clientSecret,
      environment: newCredentials.environment ?? 'production',
    });

    // New object reference so Sequelize persists the JSONB reset.
    const metadata: TrueLayerMetadata = { ...(connection.metadata as TrueLayerMetadata) };
    metadata.consecutiveAuthFailures = 0;
    metadata.deactivationReason = null;
    connection.metadata = metadata;
    connection.isActive = true;

    await connection.save();
  }

  // ============================================================================
  // Account Operations
  // ============================================================================

  async fetchAccounts(connectionId: string): Promise<ProviderAccount[]> {
    const { credentials, tlConnectionId } = await this.getAuthorizedState(connectionId);
    const apiClient = new TrueLayerApiClient(credentials);

    let accountsResponse;
    try {
      accountsResponse = await apiClient.getConnectedAccounts({ connectionId: tlConnectionId });
      await this.resetAuthFailures(connectionId);
    } catch (error) {
      await this.handleProviderError({ connectionId, error });
      throw error;
    }

    const providerAccounts: ProviderAccount[] = [];
    for (const account of accountsResponse?.items ?? []) {
      // v3 cards share the listing but carry no currency/balance semantics yet.
      if (account.type !== 'account') continue;

      let balance: Cents = asCents(0);
      try {
        const balanceResponse = await apiClient.getAccountBalance({
          connectionId: tlConnectionId,
          accountId: account.id,
        });
        balance = asCents(
          centsFromMinorUnits(
            balanceResponse.current_balance_in_minor ?? 0,
            account.currency ?? balanceResponse.currency,
          ),
        );
      } catch (error) {
        if (error instanceof ForbiddenError) throw error;
        logger.info(`[TrueLayer] Balance unavailable for account ${account.id}: ${String((error as Error).message)}`);
      }

      providerAccounts.push(this.toProviderAccount(account, balance));
    }
    return providerAccounts;
  }

  private toProviderAccount(account: TrueLayerApiAccount, balance: Cents): ProviderAccount {
    const currency = (account.currency || '').toUpperCase();
    const accountKey = this.accountIdentifierKey(account);

    return {
      externalId: account.id,
      name: this.deriveAccountName(account),
      type: 'bank' as const,
      balance,
      currency,
      metadata: {
        institutionName: 'TrueLayer',
        tlAccountType: account.account_type ?? null,
        tlCustomerSegment: account.customer_segment ?? null,
        holderNames: account.account_holder_names ?? [],
        identifiers: account.account_identifiers ?? [],
        accountKey,
        bic: account.bic ?? null,
      },
    };
  }

  /** Stable cross-connection identity: IBAN or sort-code+account-number. */
  private accountIdentifierKey(account: TrueLayerApiAccount): string | null {
    for (const identifier of account.account_identifiers ?? []) {
      if (identifier.type === 'iban') return `iban:${identifier.iban.toUpperCase().replace(/\s+/g, '')}`;
      if (identifier.type === 'sort_code_account_number') {
        return `scan:${identifier.sort_code.replace(/\s+/g, '')}:${identifier.account_number.replace(/\s+/g, '')}`;
      }
    }
    return null;
  }

  private deriveAccountName(account: TrueLayerApiAccount): string {
    const typeLabel = ACCOUNT_TYPE_LABELS[account.account_type ?? ''] ?? 'Account';
    const last4 =
      account.account_identifiers?.find((i) => i.type === 'sort_code_account_number')?.account_number.slice(-4) ??
      account.account_identifiers?.find((i) => i.type === 'iban')?.iban.slice(-4);
    return last4 ? `${typeLabel} ••${last4}` : typeLabel;
  }

  /**
   * After a reauthorize, account ids under the new Connection-Id may differ.
   * System accounts already on this connection get their externalId migrated
   * when their stored `accountKey` matches a new account's identifier.
   */
  private async updateExistingAccountExternalIds({
    connectionId,
    newAccounts,
  }: {
    connectionId: string;
    newAccounts: TrueLayerApiAccount[];
  }): Promise<void> {
    const existing = await Accounts.findAll({ where: { bankDataProviderConnectionId: connectionId } });
    const newIds = new Set(newAccounts.map((a) => a.id));
    const byKey = new Map<string, TrueLayerApiAccount>();
    for (const account of newAccounts) {
      const key = this.accountIdentifierKey(account);
      if (key) byKey.set(key, account);
    }

    for (const account of existing) {
      if (account.externalId && newIds.has(account.externalId)) continue;

      const storedKey = (account.externalData as { accountKey?: string } | null)?.accountKey;
      const match = storedKey ? byKey.get(storedKey) : undefined;
      if (!match) continue;

      await account.update({
        externalId: match.id,
        externalData: { ...(account.externalData as object), rawAccountData: match },
      });
      logger.info(
        `[TrueLayer] Re-linked account ${account.id} to connection account ${match.id} after reauthorization`,
      );
    }
  }

  // ============================================================================
  // Transaction Operations
  // ============================================================================

  async fetchTransactions(
    connectionId: string,
    accountExternalId: string,
    dateRange?: DateRange,
  ): Promise<ProviderTransaction[]> {
    const { credentials, tlConnectionId } = await this.getAuthorizedState(connectionId);
    const apiClient = new TrueLayerApiClient(credentials);

    const { from, to } = this.resolveRange(dateRange);
    const transactions = await apiClient.getTransactions({
      connectionId: tlConnectionId,
      accountId: accountExternalId,
      from,
      to,
    });

    return transactions.filter((tx) => tx.status === 'settled').map((tx) => this.toProviderTransaction(tx));
  }

  private toProviderTransaction(tx: TrueLayerApiTransaction): ProviderTransaction {
    return {
      externalId: tx.id,
      amount: asCents(centsFromMinorUnits(tx.amount_in_minor, tx.currency)),
      currency: (tx.currency || '').toUpperCase(),
      date: new Date(tx.timestamp),
      description: tx.description || tx.enrichment?.merchant_name || '',
      merchantName: tx.enrichment?.merchant_name ?? undefined,
      metadata: this.transactionMetadata(tx),
    };
  }

  async syncTransactions({
    connectionId,
    systemAccountId,
    userId,
  }: {
    connectionId: string;
    systemAccountId: RecordId;
    userId: number;
  }): Promise<void> {
    await this.runSyncWithStatus({
      systemAccountId,
      userId,
      connectionId,
      errorLogMessage: '[TrueLayer] Sync error:',
      work: async () => {
        const account = await this.getSystemAccount(systemAccountId);
        const connection = await this.getConnection(connectionId);
        this.validateProviderType(connection);

        if (!account.externalId) {
          throw new BadRequestError({ message: t({ key: 'bankDataProviders.truelayer.accountNoExternalId' }) });
        }

        const { credentials, tlConnectionId } = await this.getAuthorizedState(connectionId);
        const apiClient = new TrueLayerApiClient(credentials);

        const anyStoredTransaction = await findOneTransaction({
          planned: 'exclude',
          access: 'unscoped-internal',
          balanceAdjustments: 'include',
          where: { accountId: account.id, time: { [Op.lte]: new Date() } },
        });

        const from = anyStoredTransaction
          ? new Date(new Date(anyStoredTransaction.time).getTime() - INCREMENTAL_OVERLAP_MS)
          : new Date(Date.now() - INITIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000);
        const to = new Date();

        const matchPlanned = Boolean(anyStoredTransaction) && (await accountHasPlannedRows({ accountId: account.id }));
        // Initial import takes the full served window; incremental sync must not
        // recreate rows already absorbed into the account's opening balance.
        const createFromDate = anyStoredTransaction
          ? clampSyncStartToLink({ account, from: new Date(0) })
          : new Date(0);

        const persister = await this.createPersister({ connection, account, matchPlanned, createFromDate });

        let fetched: TrueLayerApiTransaction[];
        try {
          fetched = await apiClient.getTransactions({
            connectionId: tlConnectionId,
            accountId: account.externalId,
            from,
            to,
            onPage: persister.persist,
          });
          await this.resetAuthFailures(connectionId);
        } catch (error) {
          await this.handleProviderError({ connectionId, error });
          throw error;
        }

        const counters = persister.counters();
        if (
          counters.createdTransactionIds.length + counters.mergedIntoPlannedCount + counters.skippedPreLinkCount >
          0
        ) {
          logger.info(
            `[TrueLayer] Sync: ${counters.createdTransactionIds.length} created, ${counters.mergedIntoPlannedCount} planned confirmed, ${counters.skippedPreLinkCount} pre-link skipped, ${counters.skippedPendingCount} pending deferred for account ${account.id}`,
          );
          await notifyPlannedConfirmations({
            userId: connection.userId,
            accountId: account.id,
            mergedCount: counters.mergedIntoPlannedCount,
          });
        }

        // Authoritative end-of-sync balance from the dedicated endpoint.
        try {
          const balanceResponse = await apiClient.getAccountBalance({
            connectionId: tlConnectionId,
            accountId: account.externalId,
          });
          await writeBankBalanceWithHistory({
            account,
            balance: Money.fromCents(
              centsFromMinorUnits(balanceResponse.current_balance_in_minor ?? 0, balanceResponse.currency),
            ),
          });
        } catch (error) {
          if (error instanceof ForbiddenError) throw error;
          logger.info(
            `[TrueLayer] Balance refresh failed for account ${account.id}: ${String((error as Error).message)}`,
          );
        }

        return { transactionIds: counters.createdTransactionIds, fetchedCount: fetched.length };
      },
    });
  }

  async loadTransactionsForPeriod({
    connectionId,
    systemAccountId,
    userId,
    from,
    to,
  }: {
    connectionId: string;
    systemAccountId: RecordId;
    userId: number;
    from: Date;
    to: Date;
  }): Promise<LoadTransactionsForPeriodResult> {
    const result = await this.runSyncWithStatus({
      systemAccountId,
      userId,
      connectionId,
      errorLogMessage: '[TrueLayer] Period load error:',
      work: async () => {
        const account = await this.getSystemAccount(systemAccountId);
        const connection = await this.getConnection(connectionId);
        this.validateProviderType(connection);

        if (!account.externalId) {
          throw new BadRequestError({ message: t({ key: 'bankDataProviders.truelayer.accountNoExternalId' }) });
        }

        const { credentials, tlConnectionId } = await this.getAuthorizedState(connectionId);
        const apiClient = new TrueLayerApiClient(credentials);

        // No `matchPlanned`: a charge from an arbitrary past window must not
        // consume a plan the user made for something else.
        const persister = await this.createPersister({
          connection,
          account,
          matchPlanned: false,
          createFromDate: clampSyncStartToLink({ account, from }),
        });

        let fetched: TrueLayerApiTransaction[];
        try {
          fetched = await apiClient.getTransactions({
            connectionId: tlConnectionId,
            accountId: account.externalId,
            from,
            to,
            onPage: persister.persist,
          });
          await this.resetAuthFailures(connectionId);
        } catch (error) {
          await this.handleProviderError({ connectionId, error });
          throw error;
        }
        const counters = persister.counters();

        return { transactionIds: counters.createdTransactionIds, fetchedCount: fetched.length };
      },
    });

    return {
      jobGroupId: null,
      totalBatches: 1,
      estimatedMinutes: 0,
      createdCount: result.transactionIds.length,
      fetchedCount: result.fetchedCount,
    };
  }

  // ============================================================================
  // Balance Operations
  // ============================================================================

  async fetchBalance(connectionId: string, accountExternalId: string): Promise<ProviderBalance> {
    const { credentials, tlConnectionId } = await this.getAuthorizedState(connectionId);
    const apiClient = new TrueLayerApiClient(credentials);
    const balance = await apiClient.getAccountBalance({ connectionId: tlConnectionId, accountId: accountExternalId });

    return {
      amount: asCents(centsFromMinorUnits(balance.current_balance_in_minor ?? 0, balance.currency)),
      currency: (balance.currency || '').toUpperCase(),
      asOf: new Date(),
    };
  }

  async refreshBalance(connectionId: string, systemAccountId: string): Promise<void> {
    const account = await this.getSystemAccount(systemAccountId);

    if (!account.externalId) {
      throw new BadRequestError({ message: t({ key: 'bankDataProviders.truelayer.accountNoExternalId' }) });
    }

    const balance = await this.fetchBalance(connectionId, account.externalId);
    await writeBankBalanceWithHistory({ account, balance: Money.fromCents(balance.amount) });
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Shared row-persistence loop for sync and period load; mirrors the Akahu
   * persister (two-tier dedup by `originalId` then `externalData.originalSource`)
   * with TrueLayer's quirk: PENDING rows are never persisted — settled rows
   * arrive under a different id, so persisting both would duplicate. The
   * incremental overlap window guarantees the settled twin is picked up.
   */
  private async createPersister({
    connection,
    account,
    matchPlanned,
    createFromDate,
  }: {
    connection: BankDataProviderConnections;
    account: Accounts;
    matchPlanned: boolean;
    createFromDate: Date;
  }): Promise<{
    persist: (transactions: TrueLayerApiTransaction[]) => Promise<void>;
    counters: () => PersisterCounters;
  }> {
    const defaultCategoryId = await getUserDefaultCategory({ id: connection.userId });
    const createdTransactionIds: string[] = [];
    let mergedIntoPlannedCount = 0;
    let skippedPreLinkCount = 0;
    let skippedPendingCount = 0;
    const checkpoint = this.createBaseCurrencyLockCheckpoint({ userId: connection.userId });

    const persist = async (transactions: TrueLayerApiTransaction[]): Promise<void> => {
      // Persist in ledger order so planned-merge sees transactions ascending.
      const ascending = [...transactions].toSorted(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );

      for (const tx of ascending) {
        await checkpoint();

        if (tx.status !== 'settled') {
          skippedPendingCount += 1;
          continue;
        }

        const existingTx = await findOneTransaction({
          planned: 'exclude',
          access: 'unscoped-internal',
          balanceAdjustments: 'include',
          where: { accountId: account.id, originalId: tx.id },
          paranoid: false,
        });

        if (existingTx) {
          continue;
        }

        const existingByOriginalSource = await findOneTransaction({
          planned: 'exclude',
          access: 'unscoped-internal',
          balanceAdjustments: 'include',
          where: Sequelize.and(
            { accountId: account.id, originalId: null },
            Sequelize.where(Sequelize.literal(`"externalData"#>>'{originalSource,originalId}'`), tx.id),
          ),
          paranoid: false,
        });

        if (existingByOriginalSource) {
          await existingByOriginalSource.update({ originalId: tx.id });
          continue;
        }

        // Never create rows before the link date: that history is already absorbed into the opening balance.
        if (new Date(tx.timestamp) < createFromDate) {
          skippedPreLinkCount += 1;
          continue;
        }

        const currency = (tx.currency || '').toUpperCase();
        const amountCents = centsFromMinorUnits(Math.abs(tx.amount_in_minor), currency);
        const isExpense = tx.amount_in_minor < 0;

        const createResult = await createTransaction({
          originalId: tx.id,
          note: tx.description || tx.enrichment?.merchant_name || '',
          amount: Money.fromCents(amountCents),
          time: new Date(tx.timestamp),
          externalData: this.transactionMetadata(tx),
          commissionRate: Money.fromCents(0),
          cashbackAmount: Money.fromCents(0),
          accountId: account.id,
          userId: connection.userId,
          transactionType: isExpense ? TRANSACTION_TYPES.expense : TRANSACTION_TYPES.income,
          categoryId: defaultCategoryId,
          transferNature: TRANSACTION_TRANSFER_NATURE.not_transfer,
          accountType: ACCOUNT_TYPES.truelayer,
          rawMerchantName: tx.enrichment?.merchant_name?.trim() || null,
          matchPlanned,
        });

        if (createResult.mergedIntoPlanned) {
          mergedIntoPlannedCount += 1;
        } else {
          createdTransactionIds.push(createResult[0].id);
        }
      }
    };

    return {
      persist,
      counters: () => ({ createdTransactionIds, mergedIntoPlannedCount, skippedPreLinkCount, skippedPendingCount }),
    };
  }

  private transactionMetadata(tx: TrueLayerApiTransaction): Record<string, unknown> {
    return {
      tlStatus: tx.status,
      amountInMinor: tx.amount_in_minor,
      merchantName: tx.enrichment?.merchant_name ?? null,
      transactionCategory: tx.enrichment?.transaction_category ?? null,
    };
  }

  /**
   * Auth failure handling with the TrueLayer twist: a dead consent (invalid_state
   * → ForbiddenError) should surface as "reconnect" immediately, not after the
   * generic 2-failure threshold, so stamp the consent window expired too.
   */
  private async handleProviderError({ connectionId, error }: { connectionId: string; error: unknown }): Promise<void> {
    await this.handleAuthError({ connectionId, error });

    if (error instanceof ForbiddenError) {
      // A data-plane Forbidden on an ACTIVE connection means TrueLayer no
      // longer recognizes the authorization (expired/revoked consent). Surface
      // it as "reconnect now" instead of waiting for the generic 2-failure
      // threshold: deactivate + stamp the expired consent window. Detached +
      // tx-bypassed so it commits even as the sync rolls back and can never
      // strand behind a queued AccessExclusive lock (see base class).
      try {
        const connection = await this.getConnection(connectionId);
        connection.isActive = false;
        connection.metadata = {
          ...(connection.metadata as TrueLayerMetadata),
          consentValidUntil: new Date().toISOString(),
          deactivationReason: DEACTIVATION_REASON.AUTH_FAILURE,
          consecutiveAuthFailures: 0,
        };
        await this.saveConnectionDetached(connection);
      } catch (metaError) {
        logger.error({
          message: '[TrueLayer] Failed to stamp expired consent metadata:',
          error: metaError as Error,
        });
      }
    }
  }

  /** Credentials + authorized Connection-Id, or a clear error if consent is missing. */
  private async getAuthorizedState(
    connectionId: string,
  ): Promise<{ credentials: TrueLayerCredentials; tlConnectionId: string }> {
    const credentials = await this.getValidatedCredentials(connectionId);
    const connection = await this.getConnection(connectionId);
    const metadata = connection.metadata as TrueLayerMetadata;

    if (!metadata.tlConnectionId) {
      throw new BadRequestError({ message: t({ key: 'bankDataProviders.truelayer.noActiveConnection' }) });
    }

    return { credentials, tlConnectionId: metadata.tlConnectionId };
  }

  /** End-user identity TrueLayer requires for consent capture: name + email. */
  private async getEndUser(userId: number): Promise<{ name: string; email: string | null }> {
    const user = await Users.findByPk(userId, { attributes: ['username'] });
    const name = (user?.username ?? '').replace(/[()]/g, '').trim() || 'MoneyMatter user';
    const email = await getEmailForUser({ userId });
    return { name, email };
  }

  /**
   * Default transaction window when a caller doesn't give one: TrueLayer
   * requires explicit from/to dates on async requests.
   */
  private resolveRange(dateRange?: DateRange): { from: Date; to: Date } {
    if (dateRange) return dateRange;
    return { from: new Date(Date.now() - INITIAL_HISTORY_DAYS * 24 * 60 * 60 * 1000), to: new Date() };
  }

  private isValidCredentials(credentials: unknown): credentials is TrueLayerCredentials {
    if (typeof credentials !== 'object' || credentials === null) {
      return false;
    }
    const { clientId, clientSecret } = credentials as Record<string, unknown>;
    return (
      typeof clientId === 'string' && clientId.length > 0 && typeof clientSecret === 'string' && clientSecret.length > 0
    );
  }

  private async getValidatedCredentials(connectionId: string): Promise<TrueLayerCredentials> {
    const credentials = await this.getDecryptedCredentials(connectionId);
    if (!this.isValidCredentials(credentials)) {
      throw new ValidationError({ message: t({ key: 'bankDataProviders.truelayer.invalidCredentialsFormat' }) });
    }
    return credentials;
  }
}
