/**
 * TrueLayer-specific types for the provider implementation (Data API v3).
 *
 * Data v3 model: an app-level `client_credentials` bearer token (scope `data`,
 * short-lived, silently refreshed) plus a per-user `Connection-Id` obtained by
 * creating a data connection and having the user complete TrueLayer's hosted
 * authorization journey. All monetary values are integers in the currency's
 * MINOR unit (pence for GBP) — unlike Akahu's signed decimals.
 *
 * Docs: https://docs.truelayer.com/docs/enable-your-users-to-connect-their-bank-account
 */
import type { DeactivationReason } from '@bt/shared/types';

export type TrueLayerEnvironment = 'sandbox' | 'production';

/**
 * TrueLayer app credentials from Console (console.truelayer.com). The client
 * credentials are per-connection so each MoneyMatter user brings their own
 * TrueLayer application (same stance as Enable Banking's appId/privateKey).
 */
export interface TrueLayerCredentials {
  clientId: string;
  clientSecret: string;
  /** Defaults to 'production'. */
  environment?: TrueLayerEnvironment;
}

/**
 * Connection metadata. `tlPendingConnectionId` + `authUrl` hold the
 * not-yet-authorized data connection (fresh connect or reauthorize); once the
 * user finishes the hosted journey and the callback confirms it, the pending
 * id is promoted to `tlConnectionId` and the consent window is stamped.
 */
export interface TrueLayerMetadata {
  /** TrueLayer data-connection id with active consent (Connection-Id header). */
  tlConnectionId?: string;
  /** Data-connection id awaiting user authorization. */
  tlPendingConnectionId?: string;
  /** TrueLayer's end-user id — reused on reauthorize to keep returning-user journeys. */
  tlUserId?: string;
  /** Hosted authorization-page URI for the pending connection. */
  authUrl?: string;
  accountCount?: number;
  /** Account summaries captured at authorization-confirm time. */
  accounts?: TrueLayerApiAccount[];
  consentValidFrom?: string | null;
  consentValidUntil?: string | null;
  consecutiveAuthFailures?: number;
  deactivationReason?: DeactivationReason | null;
}

// ============================================================================
// API payload types
// ============================================================================

export interface TrueLayerApiAccessTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface TrueLayerApiCreatedConnection {
  id: string;
  user: { id: string };
  status: 'authorization_required' | 'authorizing' | (string & {});
  hosted_page?: { uri: string };
}

export type TrueLayerAccountIdentifier =
  | { type: 'sort_code_account_number'; sort_code: string; account_number: string }
  | { type: 'iban'; iban: string };

/** `account` and `card` share one shape today; cards lack currency in the schema. */
export interface TrueLayerApiAccount {
  id: string;
  type: 'account' | 'card' | (string & {});
  currency?: string;
  account_type?:
    | 'current'
    | 'savings'
    | 'credit'
    | 'cash'
    | 'pension'
    | 'branch'
    | 'mortgage'
    | 'other'
    | (string & {});
  customer_segment?: 'retail' | 'business' | 'corporate' | (string & {});
  account_identifiers?: TrueLayerAccountIdentifier[];
  bic?: string | null;
  account_holder_names?: string[];
}

export interface TrueLayerApiAccountsResponse {
  items: TrueLayerApiAccount[];
  pagination?: { next_cursor?: string | null };
}

export interface TrueLayerApiBalanceResponse {
  currency: string;
  current_balance_in_minor: number;
  available_balance_in_minor?: number | null;
  overdraft_in_minor?: number | null;
}

/** 202 response of POST …/transactions/requests and the pending GET variant. */
export interface TrueLayerTransactionsRequestPending {
  id: string;
  status: 'pending';
}

export interface TrueLayerApiTransaction {
  id: string;
  timestamp: string;
  description: string;
  currency: string;
  /** Minor units, signed: negative for debits. */
  amount_in_minor: number;
  status: 'pending' | 'settled' | (string & {});
  enrichment?: {
    merchant_name?: string | null;
    transaction_category?: string | null;
  } | null;
}

export interface TrueLayerTransactionsRequestCompleted {
  id: string;
  status: 'completed';
  completed_at?: string;
  result: {
    items: TrueLayerApiTransaction[];
    pagination?: { next_cursor?: string | null };
  };
}

export interface TrueLayerTransactionsRequestFailed {
  id: string;
  status: 'failed';
  failure_reason?: string;
}

export type TrueLayerTransactionsRequestResult =
  | TrueLayerTransactionsRequestPending
  | TrueLayerTransactionsRequestCompleted
  | TrueLayerTransactionsRequestFailed;

/** RFC 7807 problem+json error body returned by all v3 endpoints. */
export interface TrueLayerProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  trace_id?: string;
  detail?: string;
  errors?: Record<string, string[]>;
}
