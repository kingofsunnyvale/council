import { useEffect, useRef, useState, type CSSProperties } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, ExternalLink, Maximize2, RotateCcw, Square } from 'lucide-react';
import { active, REQUESTED_MODELS, safeUrl, type Attempt, type Model, type Turn } from '../shared/config';

export const identity = (id: string, models: Model[]) => {
  const known = REQUESTED_MODELS.find(m => m.id === id);
  return { name: known?.name || models.find(m => m.id === id)?.name.split(': ').slice(-1)[0] || id.split('/')[1], provider: known?.provider || id.split('/')[0], color: known?.color || '#b8b8b8' };
};
export const price = (value: unknown) => typeof value === 'string' && Number.isFinite(Number(value)) ? '$' + (Number(value) * 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 3 }) : 'Unknown';
export const cost = (value?: number) => value === undefined ? 'Unavailable' : '$' + value.toFixed(value < 0.01 ? 5 : 3);
export const label = (a?: Attempt) => !a ? 'Waiting' : a.status === 'running' ? (a.text ? 'Responding' : 'Waiting for response') : a.status === 'pending' ? 'Connecting' : { complete: 'Complete', stopped: 'Stopped', interrupted: 'Interrupted', error: 'Error' }[a.status];

function VerdictBadge({ attempt }: { attempt?: Attempt }) {
  if (attempt?.status !== 'complete' || !attempt.verdict) return null;
  return <span className={'verdict-badge verdict-' + attempt.verdict} aria-label={'Conclusion: ' + attempt.verdict.toUpperCase()}>{attempt.verdict.toUpperCase()}</span>;
}

export function Panel({ id, models, turn, attempt, previous, canRetry, onExpand, onStop, onRetry, expanded = false }: {
  id: string; models: Model[]; turn: Turn; attempt?: Attempt; previous: Attempt[]; canRetry: boolean;
  onExpand: () => void; onStop: (a: Attempt) => void; onRetry: (a: Attempt) => void; expanded?: boolean;
}) {
  const who = identity(id, models);
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const previousText = useRef(attempt?.text);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const [, tick] = useState(0);
  const running = !!attempt && active(attempt);
  useEffect(() => { if (previousText.current !== attempt?.text && pinned.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; previousText.current = attempt?.text; }, [attempt?.text]);
  useEffect(() => {
    setCopied(false); setCopyError(false);
    return () => { if (copyTimer.current) clearTimeout(copyTimer.current); };
  }, [attempt?.id]);
  useEffect(() => { if (!running) return; const timer = setInterval(() => tick(n => n + 1), 1000); return () => clearInterval(timer); }, [running]);
  const elapsed = attempt?.started_at ? ((attempt.finished_at || Date.now()) - attempt.started_at) / 1000 : null;
  const citations = attempt?.citations.filter(c => safeUrl(c.url)) || [];
  async function copy() {
    if (!attempt?.text) return;
    try {
      await navigator.clipboard.writeText(attempt.text);
      setCopied(true); setCopyError(false);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 1800);
    } catch { setCopyError(true); }
  }
  return <article className={'panel' + (expanded ? ' expanded-panel' : '')} style={{ '--model-color': who.color } as CSSProperties} aria-label={who.name + ' response'}>
    <header className="panel-header">
      <span className="model-dot" aria-hidden="true"/>
      <h3>{who.name}</h3>
      <span className="panel-status" role="status">{attempt?.status === 'complete' && attempt.verdict ? <VerdictBadge attempt={attempt}/> : label(attempt)}</span>
      {!expanded && <button className="icon-btn" aria-label={'Expand ' + who.name} title="Expand response" onClick={onExpand}><Maximize2 size={16}/></button>}
    </header>
    {expanded && <div className="expanded-question"><span>Question {turn.sequence}</span><p>{turn.prompt}</p></div>}
    <div className="panel-scroll" ref={scroll} tabIndex={0} aria-label={who.name + ' answer'} onScroll={() => { const s = scroll.current!; pinned.current = s.scrollHeight - s.scrollTop - s.clientHeight < 70; }}>
      {attempt?.text && <div className="markdown"><Markdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={url => safeUrl(url) || ''} components={{ a: ({ children, href }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>, img: ({ alt }) => <span className="image-placeholder">[Image: {alt || 'not loaded'}]</span> }}>{attempt.text}</Markdown></div>}
      {running && <div className="thinking" aria-hidden="true"><span/><span/><span/></div>}
      {attempt?.error && <p className="response-error">{attempt.error}</p>}
      {attempt?.status === 'stopped' && <p className="muted">Response stopped. {attempt.text ? 'Partial answer saved.' : 'No answer returned.'}</p>}
      {!running && attempt?.status === 'complete' && !attempt.text && <p className="muted">No answer returned.</p>}
    </div>
    <div className="response-info">
      {citations.length > 0 && <details className="sources"><summary>Sources ({citations.length})</summary><ol>{citations.map(c => <li key={c.url}><a href={c.url} target="_blank" rel="noreferrer noopener">{c.title}<ExternalLink size={12}/></a></li>)}</ol></details>}
      {previous.length > 0 && <details className="prior-attempts"><summary>{previous.length} previous {previous.length === 1 ? 'attempt' : 'attempts'}</summary>{previous.map(a => <div key={a.id}><p>Attempt {a.number} · {label(a)} · Cost: {cost(a.usage?.cost)} <VerdictBadge attempt={a}/></p><pre>{a.text || a.error || 'No answer returned.'}</pre></div>)}</details>}
    </div>
    <footer className="panel-footer">
      <details className="response-details"><summary>Details</summary><dl><div><dt>Model</dt><dd>{id}</dd></div><div><dt>Time</dt><dd>{elapsed === null ? 'Unavailable' : elapsed.toFixed(1) + 's'}</dd></div><div><dt>Tokens</dt><dd>{attempt?.usage?.total_tokens === undefined ? 'Unavailable' : attempt.usage.total_tokens.toLocaleString()}</dd></div><div><dt>Cost</dt><dd>{cost(attempt?.usage?.cost)}</dd></div></dl></details>
      <div className="panel-actions">
        {running && <button className="icon-btn" aria-label={'Stop ' + who.name} title="Stop response" onClick={() => onStop(attempt!)}><Square size={16}/></button>}
        {canRetry && attempt && !running && <button className="icon-btn" aria-label={'Retry ' + who.name} title="Retry response" onClick={() => onRetry(attempt)}><RotateCcw size={16}/></button>}
        <button className="icon-btn" disabled={!attempt?.text} aria-label={'Copy ' + who.name} title={copied ? 'Copied' : 'Copy response'} onClick={() => void copy()}>{copied ? <Check size={16}/> : <Copy size={16}/>}</button>
      </div>
    </footer>
    <span className={copyError ? 'copy-error' : 'sr-only'} role="status">{copyError ? 'Could not copy. Select and copy the answer text.' : copied ? 'Copied' : ''}</span>
  </article>;
}
