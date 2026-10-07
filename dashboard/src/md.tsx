// A small, safe Markdown renderer: builds React elements (never innerHTML), links only to http(s),
// no images (a model-written image could be used as a tracking beacon).
import { Fragment, type ReactNode } from "react";

function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  // code | bold | italic | link
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    const s = m[0];
    if (m[1]) out.push(<code key={k}>{s.slice(1, -1)}</code>);
    else if (m[2] || m[3]) out.push(<strong key={k}>{inline(s.slice(2, -2), k)}</strong>);
    else if (m[4]) out.push(<em key={k}>{inline(s.slice(1, -1), k)}</em>);
    else if (m[5]) {
      const label = s.slice(1, s.indexOf("]("));
      out.push(<a key={k} href={m[6]} target="_blank" rel="noopener noreferrer nofollow">{label}</a>);
    }
    last = m.index + s.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0, k = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++}><code>{buf.join("\n")}</code></pre>);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { blocks.push(<h3 key={k++}>{inline(h[2])}</h3>); i++; continue; }
    if (/^\s*[-*•]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*•]\s+/, ""));
      blocks.push(<ul key={k++}>{items.map((t, j) => <li key={j}>{inline(t, `l${j}`)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ""));
      blocks.push(<ol key={k++}>{items.map((t, j) => <li key={j}>{inline(t, `o${j}`)}</li>)}</ol>);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ""));
      blocks.push(<blockquote key={k++}>{inline(buf.join("\n"))}</blockquote>);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const row = (s: string) => s.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const head = row(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) body.push(row(lines[i++]));
      blocks.push(
        <div key={k++} style={{ overflowX: "auto" }}>
          <table><thead><tr>{head.map((c, j) => <th key={j}>{inline(c, `h${j}`)}</th>)}</tr></thead>
            <tbody>{body.map((r, a) => <tr key={a}>{r.map((c, j) => <td key={j}>{inline(c, `c${a}${j}`)}</td>)}</tr>)}</tbody></table>
        </div>,
      );
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*[-*•]\s+|\s*\d+[.)]\s+|>)/.test(lines[i])) buf.push(lines[i++]);
    blocks.push(<p key={k++}>{buf.map((b, j) => <Fragment key={j}>{j > 0 && "\n"}{inline(b, `p${j}`)}</Fragment>)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
