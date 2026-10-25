import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, ExternalLink, Maximize2, RotateCcw, Square } from 'lucide-react';
import { active, REQUESTED_MODELS, safeUrl, type Attempt, type Model, type Turn } from '../shared/config';

export const identity = (id: string, models: Model[]) => {
  const known = REQUESTED_MODELS.find(m => m.id === id);
  return { name: known?.name || models.find(m => m.id === id)?.name.split(': ').slice(-1)[0] || id.split('/')[1], provider: known?.provider || id.split('/')[0], color: known?.color || '#c4bbef' };
};
export const price = (value: unknown) => typeof value === 'string' && Number.isFinite(Number(value)) ? '$' + (Number(value) * 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 3 }) : 'Unknown';
export const cost = (value?: number) => value === undefined ? 'Cost unavailable' : '$' + value.toFixed(value < 0.01 ? 5 : 3);
export const label = (a?: Attempt) => !a ? 'Ready' : a.status === 'running' ? (a.text ? 'Responding' : 'Waiting for response') : a.status === 'pending' ? 'Connecting' : { complete: 'Complete', stopped: 'Stopped', interrupted: 'Interrupted', error: 'Error' }[a.status];

export function Panel({ id, models, turns, attempts, onExpand, onStop, onRetry, expanded = false }: {
  id: string; models: Model[]; turns: Turn[]; attempts: Attempt[]; onExpand: () => void; onStop: (a: Attempt) => void; onRetry: (a: Attempt) => void; expanded?: boolean;
}) {
  const who = identity(id, models); const scroll = useRef<HTMLDivElement>(null); const pinned = useRef(true); const [copied, setCopied] = useState(false); const [, tick] = useState(0);
  const latestFor = (turn: Turn) => attempts.filter(a => a.turn_id === turn.id && a.model_id === id).sort((a,b) => b.number-a.number)[0];
  const last = turns.length ? latestFor(turns[turns.length - 1]) : undefined;
  const running = last && active(last);
  const model = models.find(m => m.id === id);
  const noSearch = model && !model.supported_parameters.includes('tools');
  useEffect(() => { if (pinned.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [last?.text, turns.length]);
  useEffect(() => { if (!running) return; const timer = setInterval(() => tick(n => n+1), 1000); return () => clearInterval(timer); }, [running]);
  const elapsed = last?.started_at ? ((last.finished_at || Date.now()) - last.started_at) / 1000 : null;
  async function copy() { if (!last?.text) return; try { await navigator.clipboard.writeText(last.text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); } }
  return <article className={'panel' + (expanded ? ' expanded-panel' : '')} style={{ '--model-color': who.color } as React.CSSProperties} aria-label={who.name + ' response'}>
    <header className="panel-header"><div className="model-avatar">{who.provider.slice(0,1)}</div><div className="model-heading"><h2>{who.name}</h2><span>{who.provider}{noSearch ? ' · No web search' : ''}</span></div><span className={'panel-status ' + (running ? 'live' : '')}><i />{label(last)}</span>{!expanded && <button className="icon-btn" aria-label={'Expand ' + who.name} onClick={onExpand}><Maximize2 size={15}/></button>}</header>
    <div className="panel-scroll" ref={scroll} onScroll={() => { const s=scroll.current!; pinned.current=s.scrollHeight-s.scrollTop-s.clientHeight<70; }}>
      {!turns.length && <div className="panel-empty"><div className="orbit-mark">✳</div><p>A fresh perspective,<br/>ready when you are.</p><span>Independent conversation history</span></div>}
      {turns.map((turn, index) => {
        const a = latestFor(turn); const older = attempts.filter(x => x.turn_id === turn.id && x.model_id === id && x.id !== a?.id);
        return <section className="exchange" key={turn.id}>
          <div className="panel-prompt"><span>YOU · {index + 1}</span><p>{turn.prompt}</p></div>
          {a?.text && <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => safeUrl(url) || ''} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>, img: ({ alt }) => <span className="image-placeholder">[Image: {alt || 'not loaded'}]</span> }}>{a.text}</Markdown></div>}
          {a && active(a) && <div className="thinking"><span/><span/><span/><span className="sr-only">{label(a)}</span></div>}
          {a?.error && <div className="response-error">{a.error}</div>}
          {a?.status === 'stopped' && <p className="muted">Response stopped. {a.text ? 'Partial answer saved.' : 'No answer returned.'}</p>}
          {a?.citations.length ? <div className="sources"><span>RETURNED SOURCES</span>{a.citations.map((c,i) => safeUrl(c.url) && <a key={c.url} href={c.url} target="_blank" rel="noreferrer noopener"><b>{i+1}</b>{c.title}<ExternalLink size={11}/></a>)}</div> : null}
          {older.length > 0 && <details className="prior-attempts"><summary>{older.length} previous {older.length === 1 ? 'attempt' : 'attempts'}</summary>{older.map(x => <div key={x.id}><small>Attempt {x.number} · {label(x)} · {cost(x.usage?.cost)}</small><pre>{x.text || x.error || 'No answer returned.'}</pre></div>)}</details>}
        </section>;
      })}
    </div>
    <footer className="panel-footer"><div className="metrics">{last ? <><span>{elapsed === null ? '—' : elapsed.toFixed(1) + 's'}</span><span>{last.usage?.total_tokens === undefined ? 'Tokens unavailable' : last.usage.total_tokens.toLocaleString() + ' tokens'}</span><span>{cost(last.usage?.cost)}</span></> : <span className="model-id" title={id}>{id}</span>}</div><div className="panel-actions">
      {running ? <button className="icon-btn" aria-label={'Stop ' + who.name} onClick={() => onStop(last!)}><Square size={13}/></button> : last && <button className="icon-btn" aria-label={'Retry ' + who.name} onClick={() => onRetry(last)}><RotateCcw size={14}/></button>}
      <button className="icon-btn" disabled={!last?.text} aria-label={'Copy ' + who.name} onClick={() => void copy()}>{copied ? <Check size={14}/> : <Copy size={14}/>}</button>
    </div></footer>
  </article>;
}
