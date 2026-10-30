import { t } from './i18n/index.js';
import { relative } from './util.js';

/// The one line an attachment shows about where its bytes live and how long
/// they will: "Hosted on X, expires in 6 days". Host only, expiry only, or
/// neither — whatever the attachment can actually say.
export function hostingNote(host, att, now = Date.now()) {
  const at = att?.expires_at;
  if (host && at != null) {
    if (at > now) return t('chat.attachment.hostedExpires', { host, when: relative(at) });
    return t('chat.attachment.hostedExpired', { host });
  }
  if (host) return t('chat.attachment.hostedOn', { host });
  if (at != null && at > now) return t('chat.attachment.expiresIn', { when: relative(at) });
  if (at != null) return t('chat.attachment.expired');
  return null;
}
