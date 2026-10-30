/**
 * TrueLayer-specific types for the provider implementation (Legacy Data API v1).
 *
 * v1 model: each MoneyMatter connection carries its own TrueLayer app
 * credentials; the user authorizes one bank through TrueLayer's hosted
 * authorization page (OAuth authorization-code + rotating refresh token).
 * The bank data endpoints speak TrueLayer's Unified Data Model (UDM), which
 * reports DECIMAL MAJOR units; the client maps those into the minor-unit
 * shapes below so the provider's sync/persistence math stays integer-based
 * (pence for GBP) — unlike Akahu's signed decimals.
 *
 * One authorization grant covers one bank; connecting a second bank means a
 * second connection.
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
   * Origin the frontend is served from (window.location.origin), sent with the
   * connect request so the OAuth redirect lands on the same origin that stored
   * the pending-connection id — localhost and 127.0.0.1 are distinct origins.
   * Transient: mirrored into metadata (`tlRedirectOrigin`), not persisted with
   * the encrypted credentials.
   */
  redirectOrigin?: string;
  /**
   * Per-user bearer tokens from the authorization-code exchange — lives in the
   * ENCRYPTED credentials column. Key name kept stable across the v3 removal
   * so already-paired connections keep working without a data migration.
   */
  v1Token?: TrueLayerStoredToken;
}

/**
 * Rotating OAuth tokens for the connection. TrueLayer rotates the refresh
 * token on every renewal, so this must be persisted after each refresh; the
 * credentials column is the only encrypted-at-rest store on a connection.
 */
export interface TrueLayerStoredToken {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp when the bearer access token dies (incl. safety margin). */
  accessExpiresAt: string;
}

/**
 * Connection metadata. `tlPendingState` + `authUrl` hold the not-yet-completed
 * authorization journey (fresh connect or reauthorize); once the callback
 * exchanges the code, the journey fields clear and the consent window is
 * stamped (~90 days, refreshed by reauthorize).
 */
export interface TrueLayerMetadata {
  /** CSRF/OAuth state embedded in the pending authorization link. */
  tlPendingState?: string;
  /** redirect_uri baked into the pending authorization link (must match at exchange). */
  tlV1RedirectUri?: string;
  /** Hosted authorization-page URI for the pending connection. */
  authUrl?: string;
  /** Journey completes on TrueLayer's console redirect page; user confirms manually. */
  manualReturn?: boolean;
  /** App origin reported by the frontend at connect — reauthorize rebuilds the same redirect_uri. */
  tlRedirectOrigin?: string;
  accountCount?: number;
  /** Account summaries captured at authorization-confirm time. */
  accounts?: TrueLayerAccount[];
  consentValidFrom?: string | null;
  consentValidUntil?: string | null;
  consecutiveAuthFailures?: number;
  deactivationReason?: DeactivationReason | null;
}

// ============================================================================
// Normalized payload shapes (minor units) — what the provider maps to
// ============================================================================

/** App-level client_credentials token (used for the credential probe). */
export interface TrueLayerAppTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export type TrueLayerAccountIdentifier =
  | {
      type: 'sort_code_account_number';
      sort_code: string;
      account_number: string;
    }
  | { type: 'iban'; iban: string }
  /** Cards report only the masked PAN tail (/cards rows). */
  | { type: 'card_pan_last4'; last_four: string };

/** Normalized bank product row (accounts + cards merged). */
export interface TrueLayerAccount {
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

export interface TrueLayerBalanceResponse {
  currency: string;
  current_balance_in_minor: number;
  available_balance_in_minor?: number | null;
  overdraft_in_minor?: number | null;
}

export interface TrueLayerTransaction {
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

/** RFC 7807 problem+json error body (data endpoints) and OAuth error body (token endpoints). */
export interface TrueLayerProblemDetails {
  type?: string;
  title?: string;
  status?: number;
  trace_id?: string;
  detail?: string;
  errors?: Record<string, string[]>;
  /** Token-endpoint OAuth shape: { error, error_description }. */
  error?: string;
  error_description?: string;
}

// ============================================================================
// Wire payload types (Unified Data Model, DECIMAL MAJOR units)
// ============================================================================

/**
 * Response of the auth server token endpoint (authorization_code and
 * refresh_token grants). TrueLayer rotates the refresh token on renewal,
 * hence `refresh_token` is consumed on every response that carries one.
 */
export interface TrueLayerTokenResponse {
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

/** OAuth-style error body from the token endpoints (not problem+json). */
export interface TrueLayerOAuthError {
  error?: string;
  error_description?: string;
}

/** `GET /data/v1/accounts` and `GET /data/v1/cards` rows — card providers
 * (e.g. Amex) answer 501 on /accounts and only serve products on /cards. */
export interface TrueLayerUdmAccount {
  account_id?: string;
  card_id?: string;
  display_name?: string;
  account_type?: string;
  card_type?: string | null;
  last_four_digits?: string | null;
  name_on_card?: string | null;
  expiry_date?: string | null;
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

export interface TrueLayerUdmAccountsResponse {
  results: TrueLayerUdmAccount[];
}

/** `GET /{accounts|cards}/{id}/balance` row — amounts are DECIMAL MAJOR units. */
export interface TrueLayerUdmBalance {
  currency: string;
  current: number;
  available?: number;
  overdraft?: number;
  credit_limit?: number;
}

export interface TrueLayerUdmBalancesResponse {
  results: TrueLayerUdmBalance[];
}

/** `GET /{accounts|cards}/{id}/transactions` row — `amount` is signed major units, negative = debit. */
export interface TrueLayerUdmTransaction {
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

export interface TrueLayerUdmTransactionsResponse {
  results: TrueLayerUdmTransaction[];
}
