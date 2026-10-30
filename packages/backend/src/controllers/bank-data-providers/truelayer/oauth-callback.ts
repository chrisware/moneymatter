import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { recordId } from '@common/lib/zod/custom-types';
import { findOrThrowNotFound } from '@common/utils/find-or-throw-not-found';
import { createController } from '@controllers/helpers/controller-factory';
import { t } from '@i18n/index';
import { logger } from '@js/utils/logger';
import BankDataProviderConnections from '@models/bank-data-provider-connections.model';
import { bankProviderRegistry } from '@root/services/bank-data-providers';
import { queueConnectionSync } from '@root/services/bank-data-providers/sync/sync-manager';
import { TrueLayerProvider } from '@root/services/bank-data-providers/truelayer';
import { z } from 'zod';

const schema = z.object({
  body: z.object({
    connectionId: recordId(),
    /** Authorization code from the redirect. */
    code: z.string().min(1).max(500).optional(),
    /** OAuth state echoed by TrueLayer. */
    state: z.string().max(200).optional(),
    /** Manual-confirm fallback: the full pasted redirect URL. */
    redirectUrl: z.string().max(2000).optional(),
  }),
});

/**
 * POST /api/bank-data-providers/truelayer/oauth-callback
 * Confirm a pending TrueLayer authorization after the hosted page returned
 * the user to /bank-callback (or after a manual paste): exchanges the OAuth
 * code for the connection's rotating token pair.
 */
export default createController(schema, async ({ body, user }) => {
  const { connectionId, code, state, redirectUrl } = body;

  // Verify connection exists and belongs to user
  await findOrThrowNotFound({
    query: BankDataProviderConnections.findOne({
      where: {
        id: connectionId,
        userId: user.id,
        providerType: BANK_PROVIDER_TYPE.TRUELAYER,
      },
    }),
    message: t({ key: 'errors.connectionNotFoundOrNotYours' }),
  });

  const provider = bankProviderRegistry.get(BANK_PROVIDER_TYPE.TRUELAYER) as TrueLayerProvider;

  // Throws BadRequest on state mismatch / dead code; retrying starts a fresh
  // authorization journey.
  await provider.handleAuthorizationCallback(connectionId, {
    code,
    state,
    redirectUrl,
  });

  // Confirmation is idempotent, so a failed enqueue can simply be retried by
  // the manual sync button — don't fail the request on queue errors.
  try {
    await queueConnectionSync({ userId: user.id, connectionId });
  } catch (err) {
    logger.error(
      {
        message: `[TrueLayer] Failed to queue sync after authorization callback for connection ${connectionId}`,
        error: err as Error,
      },
      { userId: user.id },
    );
  }

  return {
    data: {
      success: true,
      message: t({ key: 'bankDataProviders.connectionEstablished' }),
      connectionId,
    },
  };
});
