import { THEME_ERRORS } from '../../lib/themes.js';

/// One sentence per way an install or import can fail, shared by the catalog
/// grid and Your themes so the same problem always reads the same way.
export function themeOutcomeMessage(outcome, t) {
  switch (outcome?.error) {
    case THEME_ERRORS.noMeta: return t('settings.market.noMeta');
    case THEME_ERRORS.quota: return t('settings.market.quota');
    case THEME_ERRORS.tooLarge: return t('settings.market.tooLarge');
    case THEME_ERRORS.blocked:
      return outcome.blocked?.length
        ? t('settings.market.blocked', { hosts: outcome.blocked.slice(0, 3).join(', ') })
        : t('settings.market.blockedImport');
    case THEME_ERRORS.invalid: return t('settings.market.unreadable');
    default: return t('settings.market.error');
  }
}
