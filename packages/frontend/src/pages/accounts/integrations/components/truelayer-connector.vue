<template>
  <div class="space-y-4">
    <!-- Step 1: Enter TrueLayer credentials -->
    <template v-if="currentStep === 1">
      <div class="space-y-4">
        <div class="space-y-4">
          <div>
            <InputField
              v-model="clientId"
              type="text"
              :label="t('pages.integrations.trueLayerConnector.clientIdLabel')"
              :placeholder="t('pages.integrations.trueLayerConnector.clientIdPlaceholder')"
            />
            <div class="text-muted-foreground mt-1 text-xs">
              {{ t('pages.integrations.trueLayerConnector.clientIdHint') }}
            </div>
          </div>
          <div>
            <InputField
              v-model="clientSecret"
              type="password"
              :label="t('pages.integrations.trueLayerConnector.clientSecretLabel')"
              :placeholder="t('pages.integrations.trueLayerConnector.clientSecretPlaceholder')"
            />
            <div class="text-muted-foreground mt-1 text-xs">
              {{ t('pages.integrations.trueLayerConnector.clientSecretHint') }}
            </div>
          </div>
          <div>
            <SelectField
              :model-value="selectedEnvironment"
              :values="environmentOptions"
              value-key="value"
              :label="t('pages.integrations.trueLayerConnector.environmentLabel')"
              @update:model-value="(value) => (environment = value ? value.value : 'production')"
            />
            <div class="text-muted-foreground mt-1 text-xs">
              {{ t('pages.integrations.trueLayerConnector.environmentHint') }}
            </div>
          </div>
          <div>
            <SelectField
              :model-value="selectedReturnMode"
              :values="returnModeOptions"
              value-key="value"
              :label="t('pages.integrations.trueLayerConnector.returnModeLabel')"
              @update:model-value="(value) => (returnMode = value ? value.value : 'auto')"
            />
            <div class="text-muted-foreground mt-1 text-xs">
              {{
                returnMode === 'manual'
                  ? t('pages.integrations.trueLayerConnector.returnModeManualHint')
                  : t('pages.integrations.trueLayerConnector.returnModeAutoHint', { url: callbackUrl || '' })
              }}
            </div>
          </div>

          <CredentialsHelpTrigger
            :label="t('pages.integrations.trueLayerConnector.help.trigger')"
            @click="showHelp = true"
          />
        </div>
        <div class="flex justify-between gap-2">
          <UiButton variant="outline" @click="$emit('cancel')" :disabled="isLoading">
            {{ t('pages.integrations.trueLayerConnector.backButton') }}
          </UiButton>

          <DemoRestricted :message="t('demo.featureNotAvailable')" feature="bank_connect_truelayer">
            <UiButton @click="handleConnectProvider" :disabled="!canConnect || isLoading || isDemo">
              {{
                isLoading
                  ? t('pages.integrations.trueLayerConnector.connectingButton')
                  : t('pages.integrations.trueLayerConnector.connectButton')
              }}
            </UiButton>
          </DemoRestricted>
        </div>
      </div>
    </template>

    <!-- Step 2: Redirect to TrueLayer authorization -->
    <template v-else-if="currentStep === 2">
      <div class="space-y-4">
        <div class="space-y-2">
          <div class="font-medium">{{ t('pages.integrations.trueLayerConnector.continueTitle') }}</div>
          <p class="text-muted-foreground text-sm">
            {{
              isManualReturn
                ? t('pages.integrations.trueLayerConnector.manualReturnDescription')
                : t('pages.integrations.trueLayerConnector.continueDescription')
            }}
          </p>
        </div>

        <div class="flex flex-wrap gap-2 pt-4">
          <UiButton @click="openAuthUrl">
            {{
              isManualReturn
                ? t('pages.integrations.trueLayerConnector.openAuthTabButton')
                : t('pages.integrations.trueLayerConnector.continueButton')
            }}
          </UiButton>
          <UiButton v-if="isManualReturn" :disabled="isLoading" @click="handleManualConfirm">
            {{
              isLoading
                ? t('pages.integrations.trueLayerConnector.confirmingButton')
                : t('pages.integrations.trueLayerConnector.confirmAuthButton')
            }}
          </UiButton>
          <UiButton variant="outline" @click="currentStep = 1" :disabled="isLoading">
            {{ t('pages.integrations.trueLayerConnector.backButton') }}
          </UiButton>
        </div>
      </div>
    </template>

    <InstructionsDialog v-model:open="showHelp" :title="t('pages.integrations.trueLayerConnector.help.title')">
      <div class="space-y-2">
        <InstructionStep :step="1">
          <template #title>
            <i18n-t keypath="pages.integrations.trueLayerConnector.help.step1" tag="span">
              <template #link>
                <ExternalLink :href="TRUELAYER_CONSOLE_URL" />
              </template>
            </i18n-t>
          </template>
        </InstructionStep>
        <InstructionStep :step="2" :title="t('pages.integrations.trueLayerConnector.help.step2')" default-open>
          <ClickToCopy v-if="callbackUrl" class="w-auto max-w-68.75 min-w-auto sm:max-w-125" :value="callbackUrl" />
        </InstructionStep>
        <InstructionStep :step="3" :title="t('pages.integrations.trueLayerConnector.help.step3')" />
      </div>

      <template #footer>
        <UiButton as="a" :href="TRUELAYER_CONSOLE_URL" target="_blank" rel="noopener">
          <ExternalLinkIcon class="size-4" />
          {{ t('pages.integrations.trueLayerConnector.footer.openConsole') }}
        </UiButton>
      </template>
    </InstructionsDialog>
  </div>
</template>

<script lang="ts" setup>
import {
  type BankProvider,
  completeTrueLayerAuthorization,
  connectProvider,
  listProviders,
} from '@/api/bank-data-providers';
import { VUE_QUERY_CACHE_KEYS } from '@/common/const';
import ClickToCopy from '@/components/common/click-to-copy.vue';
import { DemoRestricted } from '@/components/demo';
import ExternalLink from '@/components/external-link.vue';
import InputField from '@/components/fields/input-field.vue';
import SelectField from '@/components/fields/select-field.vue';
import UiButton from '@/components/lib/ui/button/Button.vue';
import { useNotificationCenter } from '@/components/notification-center';
import { useUserStore } from '@/stores';
import { BANK_PROVIDER_TYPE } from '@bt/shared/types';
import { ExternalLinkIcon } from '@lucide/vue';
import { useQuery } from '@tanstack/vue-query';
import { storeToRefs } from 'pinia';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

import CredentialsHelpTrigger from './shared/credentials-help-trigger.vue';
import InstructionStep from './shared/instruction-step.vue';
import InstructionsDialog from './shared/instructions-dialog.vue';

const TRUELAYER_CONSOLE_URL = 'https://console.truelayer.com';

const { t } = useI18n();

// `connected` completes on the OAuth callback page after the redirect, or on
// the manual "authorization completed" confirmation; it is declared here so the
// dialog wiring matches the sibling connectors.
const emit = defineEmits<{
  connected: [];
  cancel: [];
}>();

const { addErrorNotification, addSuccessNotification } = useNotificationCenter();
const { isDemo } = storeToRefs(useUserStore());

const currentStep = ref(1);
const isLoading = ref(false);
const showHelp = ref(false);

// Step 1 data — TrueLayer Data API v3 credentials from the app console.
const clientId = ref('');
const clientSecret = ref('');
type TrueLayerEnvironment = 'sandbox' | 'production';
const environment = ref<TrueLayerEnvironment>('production');

const environmentOptions = computed(() => [
  {
    value: 'production' as TrueLayerEnvironment,
    label: t('pages.integrations.trueLayerConnector.environmentProduction'),
  },
  { value: 'sandbox' as TrueLayerEnvironment, label: t('pages.integrations.trueLayerConnector.environmentSandbox') },
]);
const selectedEnvironment = computed(
  () => environmentOptions.value.find((item) => item.value === environment.value) ?? null,
);

// How the hosted journey returns the user. "manual" ends on TrueLayer's
// console redirect page (valid HTTPS, works for self-hosters without a
// registered Redirect URI); the user then confirms from this dialog.
type TrueLayerReturnMode = 'auto' | 'manual';
const isLocalOrigin = ['localhost', '127.0.0.1', '0.0.0.0'].includes(window.location.hostname);
const returnMode = ref<TrueLayerReturnMode>(
  window.location.protocol === 'https:' && !isLocalOrigin ? 'auto' : 'manual',
);

const returnModeOptions = computed(() => [
  {
    value: 'auto' as TrueLayerReturnMode,
    label: t('pages.integrations.trueLayerConnector.returnModeAuto'),
  },
  { value: 'manual' as TrueLayerReturnMode, label: t('pages.integrations.trueLayerConnector.returnModeManual') },
]);
const selectedReturnMode = computed(
  () => returnModeOptions.value.find((item) => item.value === returnMode.value) ?? null,
);
const isManualReturn = computed(() => returnMode.value === 'manual');

// connect creates a fresh connection each time, so a retry with unchanged credentials
// must reuse the connection (and its authUrl) claimed by the first attempt instead of
// creating a duplicate one.
const claimed = ref<{
  clientId: string;
  clientSecret: string;
  environment: TrueLayerEnvironment;
  returnMode: TrueLayerReturnMode;
  connectionId: string;
  authUrl: string;
} | null>(null);

const canConnect = computed(() => clientId.value.trim().length > 0 && clientSecret.value.trim().length > 0);

// The redirect URI TrueLayer has been registered with MoneyMatter, echoed by the
// backend so self-hosters see their own instance's callback URL.
const { data: providers } = useQuery({
  queryKey: VUE_QUERY_CACHE_KEYS.bankProviders,
  queryFn: listProviders,
  staleTime: Infinity,
  placeholderData: [] as BankProvider[],
});

const callbackUrl = computed(() => providers.value?.find((p) => p.type === BANK_PROVIDER_TYPE.TRUELAYER)?.redirectUrl);

const handleConnectProvider = async () => {
  const id = clientId.value.trim();
  const secret = clientSecret.value.trim();
  if (!id || !secret || isLoading.value || isDemo.value) return;

  try {
    isLoading.value = true;

    if (
      !claimed.value ||
      claimed.value.clientId !== id ||
      claimed.value.clientSecret !== secret ||
      claimed.value.environment !== environment.value ||
      claimed.value.returnMode !== returnMode.value
    ) {
      const response = await connectProvider(BANK_PROVIDER_TYPE.TRUELAYER, {
        clientId: id,
        clientSecret: secret,
        environment: environment.value,
        manualReturn: returnMode.value === 'manual',
      });
      if (!response.authUrl) {
        addErrorNotification(t('pages.integrations.trueLayerConnector.errors.noAuthUrl'));
        return;
      }
      claimed.value = {
        clientId: id,
        clientSecret: secret,
        environment: environment.value,
        returnMode: returnMode.value,
        connectionId: response.connectionId,
        authUrl: response.authUrl,
      };
      // Store connection ID for the OAuth callback page (auto return only).
      if (returnMode.value === 'auto') {
        localStorage.setItem('pendingTrueLayerConnectionId', String(response.connectionId));
      }
    }

    currentStep.value = 2;
  } catch (error) {
    const message = getErrorMessage(error) || t('pages.integrations.trueLayerConnector.errors.connectFailed');
    addErrorNotification(message);
  } finally {
    isLoading.value = false;
  }
};

const openAuthUrl = () => {
  if (!claimed.value?.authUrl) return;
  if (returnMode.value === 'manual') {
    // Keep MoneyMatter open: the user authorizes in the new tab (TrueLayer's
    // console redirect page) and returns here to confirm.
    window.open(claimed.value.authUrl, '_blank', 'noopener');
    return;
  }
  window.location.href = claimed.value.authUrl;
};

const handleManualConfirm = async () => {
  if (!claimed.value || isLoading.value) return;
  try {
    isLoading.value = true;
    await completeTrueLayerAuthorization(claimed.value.connectionId);
    addSuccessNotification(t('pages.integrations.trueLayerConnector.manualReturnConfirmed'));
    emit('connected');
  } catch (error) {
    // While the bank journey is still open/pending the backend answers with
    // its "authorizationPending" message; surface it verbatim.
    addErrorNotification(getErrorMessage(error) || t('pages.integrations.trueLayerConnector.errors.connectFailed'));
  } finally {
    isLoading.value = false;
  }
};

const getErrorMessage = (error: unknown): string | undefined => {
  const apiMessage = (error as { data?: { message?: string } })?.data?.message;
  if (apiMessage) return apiMessage;
  if (error instanceof Error && error.message) return error.message;
  return undefined;
};
</script>
