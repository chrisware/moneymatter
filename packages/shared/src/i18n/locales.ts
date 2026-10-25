/**
 * Shared i18n constants between frontend and backend
 */

export const SUPPORTED_LOCALES = {
  ENGLISH: 'en',
  UKRAINIAN: 'uk',
  SPANISH: 'es',
  GERMAN: 'de',
  FRENCH: 'fr',
  SLOVAK: 'sk',
  INDONESIAN: 'id',
  RUSSIAN: 'ru',
} as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[keyof typeof SUPPORTED_LOCALES];

export const DEFAULT_LOCALE: SupportedLocale = SUPPORTED_LOCALES.ENGLISH;

// Translated by volunteers on Crowdin rather than maintained in-house.
export const COMMUNITY_LOCALES: ReadonlySet<SupportedLocale> = new Set([
  SUPPORTED_LOCALES.SPANISH,
  SUPPORTED_LOCALES.INDONESIAN,
  SUPPORTED_LOCALES.RUSSIAN,
  SUPPORTED_LOCALES.SLOVAK,
  SUPPORTED_LOCALES.GERMAN,
  SUPPORTED_LOCALES.FRENCH,
]);

export const LOCALE_NAMES: Record<SupportedLocale, { native: string; english: string }> = {
  [SUPPORTED_LOCALES.ENGLISH]: {
    native: 'English',
    english: 'English',
  },
  [SUPPORTED_LOCALES.UKRAINIAN]: {
    native: 'Українська',
    english: 'Ukrainian',
  },
  [SUPPORTED_LOCALES.SPANISH]: {
    native: 'Español',
    english: 'Spanish',
  },
  [SUPPORTED_LOCALES.INDONESIAN]: {
    native: 'Bahasa',
    english: 'Indonesian',
  },
  [SUPPORTED_LOCALES.RUSSIAN]: {
    native: 'Русский',
    english: 'Russian',
  },
  [SUPPORTED_LOCALES.SLOVAK]: {
    native: 'Slovenčina',
    english: 'Slovak',
  },
  [SUPPORTED_LOCALES.GERMAN]: {
    native: 'Deutsch',
    english: 'German',
  },
  [SUPPORTED_LOCALES.FRENCH]: {
    native: 'Français',
    english: 'French',
  },
};

/**
 * Check if a locale is supported
 */
export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return Object.values(SUPPORTED_LOCALES).includes(locale as SupportedLocale);
}

/**
 * Get a valid locale, falling back to default if invalid
 */
export function getValidLocale(locale: string | undefined | null): SupportedLocale {
  if (locale && isSupportedLocale(locale)) {
    return locale;
  }
  return DEFAULT_LOCALE;
}
