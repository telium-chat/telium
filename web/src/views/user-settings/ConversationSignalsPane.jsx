import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import {
  Button, Pill, Section, Switch,
} from '../../components/index.js';
import { conversationTitle } from '../../lib/conversations.js';
import { CallsPane } from './CallsPane.jsx';

export function ConversationSignalsPane() {
  const store = useStore();
  const [, bump] = useState(0);
  const set = (fn) => { fn(); bump((n) => n + 1); };

  const signals = store.prefs.signals || {};
  const overrides = Object.entries(signals.conversations || {});

  return (
    <Section>
      <div className="divide-y divide-border panel px-3">
        <Switch
          label="Read receipts"
          hint={'Let others see where you have read up to, and see theirs in return. A '
            + 'receipt is sent encrypted, and the servers carrying it cannot tell it '
            + 'from a message.'}
          checked={store.readReceiptsIn(null)}
          onChange={(next) => set(() => store.setSignal('read', next))}
        />
        <Switch
          label="Delivery receipts"
          hint={'Tell the other side when your messages arrive. Turn this off and your '
            + 'own messages stop showing Delivered. Like read receipts, these go out '
            + 'encrypted and look like any other message on the wire.'}
          checked={store.deliveryAcksIn(null)}
          onChange={(next) => set(() => store.setSignal('delivered', next))}
        />
        <Switch
          label="Show when I'm typing"
          hint={'Let others see when you are typing. This one is not encrypted: your '
            + 'server, everyone else\u2019s server, and everyone in the conversation can '
            + 'see it. Turn it off to stop sharing it completely.'}
          checked={store.typingSignalsIn(null)}
          onChange={(next) => set(() => store.setSignal('typing', next))}
        />
      </div>

      {overrides.length ? (
        <Section
          title="Per-conversation"
          description="Set from a conversation’s details panel. These win over the switches above."
        >
          <div className="flex flex-col gap-1.5">
            {overrides.map(([id, per]) => {
              const convo = store.conversations.find((c) => c.id === id);
              return (
                <div className="flex items-center gap-2" key={id}>
                  <span className="min-w-0 flex-1 truncate text-base">
                    {convo ? conversationTitle(store, convo) : id}
                  </span>
                  {per.read === undefined ? null : (
                    <Pill tone={per.read ? 'success' : 'default'}>
                      {per.read ? 'receipts on' : 'receipts off'}
                    </Pill>
                  )}
                  {per.delivered === undefined ? null : (
                    <Pill tone={per.delivered ? 'success' : 'default'}>
                      {per.delivered ? 'delivery on' : 'delivery off'}
                    </Pill>
                  )}
                  {per.typing === undefined ? null : (
                    <Pill tone={per.typing ? 'success' : 'default'}>
                      {per.typing ? 'typing on' : 'typing off'}
                    </Pill>
                  )}
                  <Button
                    onClick={() => set(() => {
                      store.setSignal('read', null, id);
                      store.setSignal('delivered', null, id);
                      store.setSignal('typing', null, id);
                    })}
                  >
                    Reset
                  </Button>
                </div>
              );
            })}
          </div>
        </Section>
      ) : null}

      <CallsPane />
    </Section>
  );
}
