import { useEffect, useReducer } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import { useT } from '../../lib/i18n/react.jsx';
import { renderContent } from '../../lib/markdown.jsx';
import {
  attachInteractions, dismissEphemeral, ephemeralFor, subscribeEphemeral,
} from '../../lib/interactions.js';
import { CloseIcon, VisibilityOffIcon } from '../../components/index.js';
import { AppMessage } from '../../components/message-ui/AppMessage.jsx';

export function EphemeralMessages({ surface, channelId, me }) {
  const t = useT();
  const store = useStore();
  const [, bump] = useReducer((n) => n + 1, 0);

  useEffect(() => subscribeEphemeral(bump), []);
  useEffect(() => attachInteractions(store), [store]);

  const held = ephemeralFor(channelId);
  if (!held.length) return null;

  return (
    <>
      {held.map((msg) => {
        const member = surface.memberOf(msg.author);
        return (
          <div key={msg.id} className="mc-ghost" role="note">
            <div className="mc-ghost__mark">
              <VisibilityOffIcon className="mc-ghost__glyph" aria-hidden="true" />
              <span>{t('chat.ephemeral.mark')}</span>
              <span className="mc-ghost__spacer" />
              <button
                type="button"
                className="mc-ghost__dismiss"
                onClick={() => dismissEphemeral(channelId, msg.id)}
              >
                <CloseIcon className="mc-ghost__glyph" aria-hidden="true" />
                {t('chat.ephemeral.dismiss')}
              </button>
            </div>

            {msg.content ? (
              <div className="md mc-ghost__body">
                {renderContent(msg.content, { me, store, guildId: surface.guildId })}
              </div>
            ) : null}

            <AppMessage msg={msg} member={member} base={surface.avatarBase} />
          </div>
        );
      })}
    </>
  );
}
