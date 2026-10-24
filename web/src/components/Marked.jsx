export function Marked({ text, positions = [], hitClassName = 'text-accent' }) {
  if (!positions.length) return text;
  const parts = [];
  let cut = 0;
  for (let i = 0; i < positions.length;) {
    let end = i;
    while (end + 1 < positions.length && positions[end + 1] === positions[end] + 1) end += 1;
    const from = positions[i];
    const to = positions[end] + 1;
    if (from > cut) parts.push(text.slice(cut, from));
    parts.push(<b key={from} className={hitClassName} style={{ fontWeight: 'inherit' }}>{text.slice(from, to)}</b>);
    cut = to;
    i = end + 1;
  }
  if (cut < text.length) parts.push(text.slice(cut));
  return parts;
}

export function MarkedHandle({ text, positions = [], hitClassName }) {
  const cut = text.startsWith('@') ? text.indexOf(':') : -1;
  if (cut < 0) return <Marked text={text} positions={positions} hitClassName={hitClassName} />;
  return (
    <>
      <Marked text={text.slice(0, cut)} positions={positions.filter((p) => p < cut)} hitClassName={hitClassName} />
      <span className="opacity-60">
        <Marked
          text={text.slice(cut)}
          positions={positions.filter((p) => p >= cut).map((p) => p - cut)}
          hitClassName={hitClassName}
        />
      </span>
    </>
  );
}
