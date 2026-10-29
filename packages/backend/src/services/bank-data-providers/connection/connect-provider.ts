import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { t } from '@i18n/index';
import { NotAllowedError } from '@js/errors';
import BankDataProviderConnections from '@models/bank-data-provider-connections.model';
import { withTransaction } from '@root/services/common/with-transaction';

import { EnableBankingProvider } from '../enablebanking';
import { isProviderAvailableForUser } from '../provider-availability';
import { bankProviderRegistry } from '../registry';
import { TrueLayerProvider } from '../truelayer';

export const connectProvider = withTransaction(
  async ({
    providerType,
    userId,
    credentials,
    providerName,
  }: {
    providerType: BANK_PROVIDER_TYPE;
    userId: number;
    credentials: Record<string, unknown>;
    providerName?: string;
  }): Promise<{ connectionId: string; authUrl?: string; message: string }> => {
    if (!(await isProviderAvailableForUser({ userId, providerType }))) {
      throw new NotAllowedError({ message: t({ key: 'bankDataProviders.providerNotAvailable' }) });
    }

    const provider = bankProviderRegistry.get(providerType);

    // Create connection (stores encrypted credentials)
    const connectionId = await provider.connect(userId, credentials);

    // Update provider name if provided
    if (providerName) {
      await BankDataProviderConnections.update({ providerName: providerName }, { where: { id: connectionId } });
    }

    // For OAuth-redirect providers (Enable Banking, TrueLayer), get the
    // authorization URL the frontend must send the user to.
    let authUrl: string | undefined;
    if (providerType === BANK_PROVIDER_TYPE.ENABLE_BANKING) {
      const enableBankingProvider = provider as EnableBankingProvider;
      authUrl = await enableBankingProvider.getAuthorizationUrl(connectionId);
    } else if (providerType === BANK_PROVIDER_TYPE.TRUELAYER) {
      const trueLayerProvider = provider as TrueLayerProvider;
      authUrl = await trueLayerProvider.getAuthorizationUrl(connectionId);
    }

    return {
      connectionId,
      authUrl,
      message: authUrl
        ? 'Connection created. Please authorize access via the provided URL.'
        : 'Provider connected successfully',
    };
  },
);
