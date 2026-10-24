import { useState } from 'react';
import { Button, Checkbox, GlobeIcon, ModalShell, WarnIcon } from '../../components/index.js';
import { trustHost } from '../../lib/link-trust.js';

export function ExternalLinkDialog({ store, destination, onOpen, close }) {
  const [trust, setTrust] = useState(false);

  const go = () => {
    if (trust) trustHost(store, destination.host);
    close();
    onOpen();
  };

  return (
    <ModalShell
      title="Leaving Telium"
      subtitle="This link goes to a site outside the servers you are signed in to."
      footer={(
        <>
          <Button variant="tertiary" onClick={close}>Cancel</Button>
          <Button variant="primary" onClick={go}>Visit site</Button>
        </>
      )}
    >
      <div className="external-link">
        <GlobeIcon className="external-link__icon size-4" />
        <div className="min-w-0">
          <div className="external-link__host">{destination.host}</div>
          {destination.path ? (
            <div className="external-link__path">{destination.path}</div>
          ) : null}
        </div>
      </div>

      {destination.disguised ? (
        <div className="external-link__warn">
          <WarnIcon className="size-4 shrink-0" />
          <p>
            {destination.userinfo
              ? 'This link carries a username in front of the address, which is an old way of making it look like it goes somewhere else. The host above is where it really goes.'
              : destination.punycoded
                ? 'This address is written in non-Latin characters. It is shown above the way your browser will resolve it, which may not match what the link appeared to say.'
                : 'This address mixes characters from more than one alphabet, which is how a site imitates the name of another one. Check it carefully.'}
          </p>
        </div>
      ) : null}

      <Checkbox
        label={`Trust ${destination.host}, don't ask again`}
        hint="Applies to this domain and anything under it, on all your devices."
        checked={trust}
        onChange={setTrust}
      />
    </ModalShell>
  );
}
