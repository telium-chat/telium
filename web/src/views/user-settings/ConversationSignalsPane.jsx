import { useState } from 'react';
import { useStore } from '../../hooks/useStore.jsx';
import {
  Button, Pill, Section, Switch,
} from '../../components/index.js';
import { conversationTitle } from '../../lib/conversations.js';

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
          label="Send and receive read receipts"
          hint={'You see how far someone has read only while they can see yours. A receipt '
            + 'is sent encrypted, and the servers carrying it cannot tell it from a message.'}
          checked={store.readReceiptsIn(null)}
          onChange={(next) => set(() => store.setSignal('read', next))}
        />
        <Switch
          label="Acknowledge delivery"
          hint={'Turn this off and your own messages stop showing Delivered. Like read '
            + 'receipts, these go out encrypted and look like any other message on the wire.'}
          checked={store.deliveryAcksIn(null)}
          onChange={(next) => set(() => store.setSignal('delivered', next))}
        />
        <Switch
          label="Show when I am typing"
          hint={'This one is not encrypted. Your server, everyone else\u2019s server and '
            + 'everyone in the conversation can see that you are typing, where, and when. It '
            + 'is sent in the clear so that it arrives while it still means something; '
            + 'turning it off stops it being sent at all.'}
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
    </Section>
  );
}
