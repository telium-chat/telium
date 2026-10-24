import { useState } from 'react';
import { useModal } from '../../hooks/useModal.jsx';
import {
  Button, Checkbox, Field, Hint, ModalShell, Notice, Section, Select, TextArea, TextInput,
} from '../../components/index.js';
import { DangerAction, useElevatedRun } from './StepUp.jsx';
import { useControlPlane } from './context.js';
import { clock } from './format.js';

const DEFAULT_NOTICE_DAYS = 30;

function toLocalField(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalField(text) {
  const at = new Date(text).getTime();
  return Number.isFinite(at) ? at : null;
}

function AnnounceSunset({ reload }) {
  const { home } = useControlPlane();
  const elevated = useElevatedRun();
  const [mode, setMode] = useState('shutdown');
  const [domain, setDomain] = useState('');
  const [when, setWhen] = useState(
    () => toLocalField(Date.now() + DEFAULT_NOTICE_DAYS * 24 * 3600 * 1000),
  );
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const at = fromLocalField(when);
  const relocating = mode === 'relocate';
  const target = domain.trim();
  const problem = (relocating && !target && 'A relocation needs the domain it is moving to.')
    || (!at && 'That date could not be read.')
    || (at < Date.now() && 'That date has already passed.')
    || null;

  const announce = async () => {
    setBusy(true);
    const ok = await elevated(
      'Announce',
      () => home.adminSetSunset({
        mode,
        effective_at: at,
        ...(relocating ? { new_domain: target } : {}),
        ...(message.trim() ? { message: message.trim() } : {}),
      }),
      relocating ? 'The move has been announced.' : 'The shutdown has been announced.',
    );
    setBusy(false);
    if (ok) reload?.();
  };

  return (
    <div className="cp-ops__form">
      <Select
        label="What is happening"
        value={mode}
        onChange={(e) => setMode(e.target.value)}
        options={[
          ['shutdown', 'This server is closing'],
          ['relocate', 'This server is moving to another domain'],
        ]}
        hint={relocating
          ? 'Members and peers are told to follow the new name. Accounts and guilds survive.'
          : 'Members are told to export or move their accounts before the date below.'}
      />
      {relocating ? (
        <TextInput
          label="New domain"
          value={domain}
          placeholder="new.example"
          onChange={(e) => setDomain(e.target.value)}
          hint="A successor key is minted under this name and signed by the current one.
            The move itself happens when this server is restarted under the new name."
        />
      ) : null}
      <Field label="Effective">
        <input
          type="datetime-local"
          className="telium-field cp-ops__when"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
      </Field>
      <TextArea
        label="Message to members"
        value={message}
        rows={3}
        onChange={(e) => setMessage(e.target.value)}
        hint="Shown on the sign-in page and in the notice peers receive. Optional, and the
          one part of this that anybody outside the operator team will read."
      />
      {problem ? <Notice tone="warn">{problem}</Notice> : null}
      <div className="cp-ops__row">
        <Button
          variant="danger"
          isDisabled={busy || Boolean(problem)}
          onClick={announce}
        >
          {relocating ? 'Announce the move' : 'Announce the shutdown'}
        </Button>
        <Hint>
          Registration closes the moment this is announced. It can be withdrawn until the date
          arrives.
        </Hint>
      </div>
    </div>
  );
}

export function FinalizeDialog({ serverName, onFinalize, close }) {
  const [typed, setTyped] = useState('');
  const [abandon, setAbandon] = useState(false);
  const [busy, setBusy] = useState(false);
  const held = typed.trim() !== serverName;

  return (
    <ModalShell
      title="Shut this server down for good"
      footer={(
        <>
          <Button variant="tertiary" onClick={close}>Cancel</Button>
          <Button
            variant="danger"
            isDisabled={busy || held}
            onClick={async () => {
              setBusy(true);
              try { await onFinalize(abandon); close(); } finally { setBusy(false); }
            }}
          >
            Shut down
          </Button>
        </>
      )}
    >
      <p className="text-base leading-[1.6] text-muted">
        Every account and guild still on
        {' '}
        <strong>{serverName}</strong>
        {' '}
        is tombstoned. From then on this server answers nothing but sign-ins and account
        exports, so that somebody who arrives late can still take their data away. There is
        no undo, and no route that reverses it.
      </p>
      <TextInput
        autoFocus
        label={`Type ${serverName} to confirm`}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
      />
      <Checkbox
        label="Abandon any account moves still in flight"
        checked={abandon}
        onChange={setAbandon}
        hint="Leave this off first. The server will refuse and tell you how many are waiting,
          which is usually the more useful answer than losing them."
      />
    </ModalShell>
  );
}

function SunsetOps({ sunset, serverName, reload }) {
  const { home } = useControlPlane();
  const modal = useModal();
  const elevated = useElevatedRun();

  const shuttingDown = sunset.mode === 'shutdown';
  const due = (sunset.effective_at ?? Infinity) <= Date.now();

  const finalize = (abandon) => elevated(
    'Shut down',
    () => home.adminFinalizeSunset({ confirm: serverName, abandon_pending: abandon }),
    'This server has been shut down.',
  ).then((ok) => { if (ok) reload?.(); });

  return (
    <div className="cp-ops__row">
      <DangerAction
        label="Withdraw"
        title={shuttingDown ? 'Withdraw the shutdown' : 'Withdraw the move'}
        body={shuttingDown
          ? `The announced shutdown of ${serverName} is cancelled and registration reopens.
             Members who have already exported or moved their accounts are not brought back.`
          : `The announced move is cancelled, registration reopens, and the successor key
             minted for the new domain is destroyed. Peers that have already been told where
             to follow are told again that it is off.`}
        confirmLabel="Withdraw it"
        run={() => home.adminSetSunset({ mode: 'none' })}
        done="The announcement has been withdrawn."
        onDone={reload}
      />

      {shuttingDown ? (
        <DangerAction
          label="Run the moves now"
          title="Run every account move that is ready"
          body={`Every account that has consented to move away from ${serverName} and whose
            waiting period has elapsed is moved to its destination now. Accounts still inside
            their waiting period are left alone and reported back. Undoing this means asking
            each destination server to hand those accounts back.`}
          confirmLabel="Run them"
          run={() => home.adminExecuteSunset()}
          done="The pending moves have been run."
          onDone={reload}
        />
      ) : null}

      {shuttingDown && due ? (
        <Button
          variant="danger"
          size="sm"
          onClick={() => modal.open((close) => (
            <FinalizeDialog serverName={serverName} onFinalize={finalize} close={close} />
          ))}
        >
          Shut down for good
        </Button>
      ) : null}

      {shuttingDown && !due ? (
        <Hint>
          {`The final shutdown becomes available on ${clock(sunset.effective_at, true)}.`}
        </Hint>
      ) : null}
    </div>
  );
}

function HandOver({ standby: s, serverName, reload }) {
  const { home } = useControlPlane();
  const behind = s.behind_entries;
  const loss = behind == null
    ? `${s.domain} has never acknowledged anything written here, so how much it holds is
       unknown.`
    : (behind > 0
      ? `${behind} change${behind === 1 ? '' : 's'} written here ${behind === 1 ? 'has' : 'have'}
         not been acknowledged by ${s.domain} and would be lost.`
      : `${s.domain} has acknowledged everything written here.`);

  return (
    <div className="cp-ops__row">
      <DangerAction
        label={`Hand over to ${s.domain}`}
        title={`Hand ${serverName} to ${s.domain}`}
        body={`${s.domain} becomes the authority for ${serverName} and this process drops to
          read-only. The handover is fenced by a sequence number that only goes up, so there
          is no route back: this server sees the higher number and stands down. ${loss}`}
        confirmLabel="Hand it over"
        run={() => home.adminPromoteFailover('server', serverName)}
        done={`${s.domain} is now the authority.`}
        onDone={reload}
      />
      <Hint>Planned handover. Use this when this machine is going away on purpose.</Hint>
    </div>
  );
}

function FailoverOps({ continuity, reload }) {
  const { home } = useControlPlane();
  const standbys = continuity?.standbys || [];
  const serverName = continuity?.server_name;
  const unpaired = standbys.filter((s) => !s.paired);
  const paired = standbys.filter((s) => s.paired);
  const [chosen, setChosen] = useState('');

  const pick = chosen || unpaired[0]?.domain || '';

  return (
    <>
      {unpaired.length ? (
        <div className="cp-ops__row">
          <Select
            label="Authorise a standby"
            value={pick}
            onChange={(e) => setChosen(e.target.value)}
            options={unpaired.map((s) => [s.domain, s.domain])}
          />
          <DangerAction
            label="Authorise"
            title={`Let ${pick} answer for ${serverName}`}
            body={`This signs, now, a consent that ${pick} may take over ${serverName} later.
              It changes nothing today: ${serverName} keeps answering and nothing is handed
              over until somebody promotes it. What it buys is that the promotion does not
              need this server to be reachable, which is the entire point — on the day it is
              used, nobody here is available to be asked.`}
            confirmLabel="Sign the consent"
            run={() => home.adminAuthorizeFailover({
              subject_type: 'server',
              subject_id: serverName,
              standby: pick,
            })}
            done="The standby is authorised."
            onDone={reload}
          />
        </div>
      ) : null}

      {paired.map((s) => (
        <HandOver key={s.domain} standby={s} serverName={serverName} reload={reload} />
      ))}
    </>
  );
}

function TakeOver({ mirror: m, reload }) {
  const { home } = useControlPlane();
  const staleness = m.stale
    ? ' This copy is already marked stale, which is a reason to find out why before promoting it.'
    : '';

  return (
    <div className="cp-ops__row">
      <DangerAction
        label={`Take over for ${m.origin}`}
        title={`Answer for ${m.origin} from here`}
        body={`This server starts answering for ${m.origin} under a signed record other servers
          will believe, using the copy it holds. Anything ${m.origin} wrote that this copy has
          not received is lost, and the record cannot be withdrawn — if ${m.origin} comes back,
          it finds itself superseded.${staleness}`}
        confirmLabel="Take over"
        run={() => home.adminPromoteStandby(m.origin)}
        done={`This server now answers for ${m.origin}.`}
        onDone={reload}
      />
      <Hint>
        {m.applied_at
          ? `This copy last applied a change ${clock(m.applied_at, true)}.`
          : 'This copy has never applied a change.'}
      </Hint>
    </div>
  );
}

function MirrorOps({ continuity, reload }) {
  const { home } = useControlPlane();
  const mirrors = (continuity?.mirrors || []).filter((m) => !m.promoted);
  if (!mirrors.length) return null;

  return (
    <>
      {mirrors.map((m) => <TakeOver key={m.origin} mirror={m} reload={reload} />)}
    </>
  );
}

export function ContinuityOps({ continuity, reload }) {
  const c = continuity;
  const serverName = c?.server_name;
  const sunset = c?.sunset;

  if (c?.shut_down) {
    return (
      <Section
        title="Operations"
        description="What an operator can still do from here."
      >
        <Notice tone="danger">
          This server has been shut down for good. Accounts and guilds are tombstoned and the
          only thing it still answers is sign-ins and account exports, so that somebody
          arriving late can take their data away. Nothing here can be undone from the console.
        </Notice>
      </Section>
    );
  }

  return (
    <Section
      title="Operations"
      description="The verbs the state above describes. Each one asks for your password again,
        and each one is written to the audit log whether it succeeds or is refused."
    >
      <div className="cp-ops">
        <div className="cp-ops__group">
          <h4 className="cp-ops__title">
            {sunset ? 'The announced end' : 'Ending or moving this server'}
          </h4>
          {sunset
            ? <SunsetOps sunset={sunset} serverName={serverName} reload={reload} />
            : <AnnounceSunset reload={reload} />}
        </div>

        <div className="cp-ops__group">
          <h4 className="cp-ops__title">Failover</h4>
          {(c?.standbys || []).length ? (
            <FailoverOps continuity={c} reload={reload} />
          ) : (
            <Hint>
              No standby is configured, so there is nothing to authorise and nothing to hand
              over. Standbys are named in <code>[failover]</code> in the server configuration,
              which is read at startup.
            </Hint>
          )}
          <MirrorOps continuity={c} reload={reload} />
        </div>
      </div>
    </Section>
  );
}
