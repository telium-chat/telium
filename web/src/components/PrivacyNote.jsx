export function PrivacyNote({ head, parties = null, note = null, className }) {
  return (
    <div className={className ? `privacy-note ${className}` : 'privacy-note'}>
      <p className="privacy-note__head">{head}</p>
      {parties?.length ? (
        <ul className="privacy-note__list">
          {parties.map((party) => (
            <li className="privacy-note__party" key={party.who}>
              <span className="privacy-note__name">{party.who}</span>
              <span className="privacy-note__sees">{party.sees}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {note ? <p className="privacy-note__note">{note}</p> : null}
    </div>
  );
}
