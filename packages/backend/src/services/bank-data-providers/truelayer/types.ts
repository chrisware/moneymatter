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
  /**
   * When true the journey returns the user to TrueLayer's built-in console
   * redirect page instead of this instance's /bank-callback URL — self-hosters
   * on plain http (which TrueLayer won't accept as a Redirect URI) authorize
   * there and confirm manually from MoneyMatter. Not persisted with the
   * encrypted credentials; mirrored into metadata instead.
   */
  manualReturn?: boolean;
  /**
   * Data API generation. 'v3' (default) is the Connection-Id based Data API;
   * 'v1' is the legacy OAuth authorization-code + refresh-token flow, for
   * TrueLayer apps that were provisioned before Data v3 and lack the `data`
   * scope. Mirrored into metadata; never read back from the encrypted blob
   * except to carry the rotating per-user tokens below.
   */
  apiVersion?: TrueLayerApiVersion;
  /** Legacy v1 per-user bearer tokens — lives in the ENCRYPTED credentials column. */
  v1Token?: TrueLayerV1StoredToken;
}

export type TrueLayerApiVersion = 'v3' | 'v1';

/**
 * Rotating OAuth tokens for a v1 connection. TrueLayer rotates the refresh
 * token on every renewal, so this must be persisted after each refresh; the
 * credentials column is the only encrypted-at-rest store on a connection.
 */
export interface TrueLayerV1StoredToken {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when the bearer access token dies (incl. safety margin). */
  accessExpiresAt: string;
}

/**
 * Connection metadata. `tlPendingConnectionId` + `authUrl` hold the
 * not-yet-authorized data connection (fresh connect or reauthorize); once the
 * user finishes the hosted journey and the callback confirms it, the pending
 * id is promoted to `tlConnectionId` and the consent window is stamped.
 */
export interface TrueLayerMetadata {
  /** Data API generation for this connection; absent means 'v3'. */
  apiVersion?: TrueLayerApiVersion;
  /** TrueLayer data-connection id with active consent (Connection-Id header). */
  tlConnectionId?: string;
  /** Data-connection id awaiting user authorization. */
  tlPendingConnectionId?: string;
  /** v1: CSRF/OAuth state embedded in the pending authorization link. */
  tlPendingState?: string;
  /** v1: redirect_uri baked into the pending authorization link (must match at exchange). */
  tlV1RedirectUri?: string;
  /** TrueLayer's end-user id — reused on reauthorize to keep returning-user journeys. */
  tlUserId?: string;
  /** Hosted authorization-page URI for the pending connection. */
  authUrl?: string;
  /** Journey completes on TrueLayer's console redirect page; user confirms manually. */
  manualReturn?: boolean;
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
  | {
      type: 'sort_code_account_number';
      sort_code: string;
      account_number: string;
    }
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

/** RFC 7807 problem+json error body (v3) and OAuth error body (v1 endpoints). */
export interface TrueLayerProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  trace_id?: string;
  detail?: string;
  errors?: Record<string, string[]>;
  /** v1 token-endpoint OAuth shape: { error, error_description }. */
  error?: string;
  error_description?: string;
}

// ============================================================================
// Legacy Data API v1 payload types (Unified Data Model)
// ============================================================================

/**
 * Response of POST /exchange-oauth and /token (refresh_token grant). TrueLayer
 * rotates the refresh_token on renewal, hence `refresh_token` is consumed on
 * every response that carries one.
 */
export interface TrueLayerV1TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_expires_in?: number;
  token_type: string;
  scope?: string;
  signer?: string;
  provider?: string;
  currency?: string;
}

/** OAuth-style error body from the v1 token endpoints (not problem+json). */
export interface TrueLayerV1OAuthError {
  error?: string;
  error_description?: string;
}

/** `GET /accounts` row. GB banks report account_number; IBANs surface via meta. */
export interface TrueLayerV1Account {
  account_id: string;
  display_name?: string;
  account_type?: string;
  currency: string;
  account_number?: {
    /** GB sort code, six digits, may contain spaces/hyphens. */
    sort_code?: string | null;
    number: string;
  } | null;
  provider?: {
    provider_name?: string;
    provider_id?: string;
  } | null;
  update_timestamp?: string;
}

export interface TrueLayerV1AccountsResponse {
  results: TrueLayerV1Account[];
}

/** `GET /accounts/{id}/balance` row — amounts are DECIMAL MAJOR units. */
export interface TrueLayerV1Balance {
  currency: string;
  current: number;
  available?: number;
  overdraft?: number;
  credit_limit?: number;
}

export interface TrueLayerV1BalancesResponse {
  results: TrueLayerV1Balance[];
}

/** `GET /accounts/{id}/transactions` row — `amount` is signed major units, negative = debit. */
export interface TrueLayerV1Transaction {
  transaction_id: string;
  /** Stable cross-request identifier when the provider supplies one. */
  normalised_provider_transaction_id?: string | null;
  provider_transaction_id?: string | null;
  timestamp: string;
  description: string;
  currency: string;
  amount: number;
  transaction_type?: 'DEBIT' | 'CREDIT' | (string & {});
  transaction_category?: string | null;
  merchant_name?: string | null;
  meta?: {
    bank_transaction_id?: string | null;
  } | null;
}

export interface TrueLayerV1TransactionsResponse {
  results: TrueLayerV1Transaction[];
}
