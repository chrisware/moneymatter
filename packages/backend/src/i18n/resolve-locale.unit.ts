import { SUPPORTED_LOCALES, resolveLocale } from '@bt/shared/i18n/locales';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

describe('resolveLocale', () => {
  it.each([
    ['uk', 'uk'],
    ['UK', 'uk'],
    ['en-US', 'en'],
    ['de-AT', 'de'],
    ['fr-CA,fr;q=0.9,en;q=0.8', 'fr'],
    ['xx-YY, de;q=0.5', 'de'],
    ['', 'en'],
    [undefined, 'en'],
    [null, 'en'],
  ])('resolves %p to %p', (tag, expected) => {
    expect(resolveLocale({ tag })).toBe(expected);
  });

  describe('with a regional locale registered', () => {
    // No regional locale ships yet, so register one to exercise the full-tag match.
    const locales = SUPPORTED_LOCALES as Record<string, string>;
    beforeAll(() => {
      locales.TEST_PT_BR = 'pt-BR';
    });
    afterAll(() => {
      delete locales.TEST_PT_BR;
    });

    it.each([
      ['pt-BR', 'pt-BR'],
      ['pt-br', 'pt-BR'],
      ['pt-PT', 'en'],
      ['pt', 'en'],
      ['pt-PT,pt-BR;q=0.5', 'pt-BR'],
    ])('resolves %p to %p', (tag, expected) => {
      expect(resolveLocale({ tag })).toBe(expected);
    });
  });
});
