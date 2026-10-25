import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowRight, ArrowUp, Check, ChevronDown, Globe2, Menu, MessageSquare, Plus, Search, Settings2, Square, X } from 'lucide-react';
import { active, MAX_COMPLETION, MAX_PROMPT, REQUESTED_MODELS, SEARCH_DOCS, type Attempt, type Conversation, type ConversationDetail, type Model, type Turn } from '../shared/config';
import { readSSE } from '../shared/sse';
import { api, ApiError } from './api';
import { identity, Panel, price } from './Panel';

type Account = { managed?: boolean; connected: boolean; valid?: boolean; limitRemaining?: number | null; error?: string };
type Catalog = { models: Model[]; fetchedAt: number; missing: { id: string; name: string }[] };
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Something went wrong. Please try again.';
function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => { const d = ref.current!; d.showModal(); d.querySelector<HTMLElement>('[data-autofocus]')?.focus(); return () => { d.close(); if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); }; }, []);
  return <dialog ref={ref} className={wide ? 'modal wide' : 'modal'} onCancel={close} onClick={e => { if (e.target === ref.current) close(); }} aria-label={title}>
    <div className="modal-heading"><h2>{title}</h2><button className="icon-btn" aria-label="Close dialog" onClick={close}><X size={19}/></button></div>{children}
  </dialog>;
}
export function App() {
  const [owner, setOwner] = useState<{ login: string } | null>(null); const [booting, setBooting] = useState(true);
  const [catalog, setCatalog] = useState<Catalog>({ models: [], fetchedAt: 0, missing: [] });
  const [account, setAccount] = useState<Account>({ connected: false }); const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<string[]>(REQUESTED_MODELS.map(m => m.id));
  const [current, setCurrent] = useState<ConversationDetail | null>(null); const currentRef = useRef(current); currentRef.current = current;
  const [draft, setDraft] = useState(''); const draftRef = useRef<HTMLTextAreaElement>(null); const [search, setSearch] = useState(true);
  const [error, setError] = useState(''); const [submitting, setSubmitting] = useState(false); const busy = useRef(false);
  const [picker, setPicker] = useState(false); const [picks, setPicks] = useState(selected); const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<{ turnId: string; modelId: string } | null>(null); const [settings, setSettings] = useState(false); const [prices, setPrices] = useState(false); const [sidebar, setSidebar] = useState(false);
  const scrollToTurn = useRef<string | null>(null);
  const turnElements = useRef(new Map<string, HTMLElement>());
  const navigationButton = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const streams = useRef(new Map<string, AbortController>()); const launched = useRef(new Set<string>()); const retryKeys = useRef(new Map<string,string>());
  const submission = useRef<{ prompt: string; search: boolean; key: string; version: number; conversationId: string } | null>(null);
  const draftConversationId = useRef(crypto.randomUUID());
  const lineup = current?.conversation.models || selected; const running = !!current?.attempts.some(active);
  const modelsReady = lineup.every(id => catalog.models.some(m => m.id === id));
  const searchReady = !search || lineup.every(id => catalog.models.find(m => m.id === id)?.supported_parameters.includes('tools'));

  useEffect(() => {
    if (!scrollToTurn.current) return;
    const element = turnElements.current.get(scrollToTurn.current);
    if (!element) return;
    scrollToTurn.current = null;
    element.scrollIntoView({ block: 'start' });
    draftRef.current?.focus({ preventScroll: true });
  }, [current?.turns.length, current?.conversation.id]);

  useEffect(() => {
    if (!sidebar) return;
    const close = () => { setSidebar(false); navigationButton.current?.focus(); };
    const keys = (e: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') {
        const controls = [...(sidebarRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
        const first = controls[0], last = controls.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    sidebarRef.current?.querySelector('button')?.focus();
    window.addEventListener('keydown', keys);
    return () => { window.removeEventListener('keydown', keys); navigationButton.current?.focus({ preventScroll: true }); };
  }, [sidebar]);

  const refreshList = useCallback(async () => setConversations((await api<{ conversations: Conversation[] }>('/conversations')).conversations), []);
  const merge = useCallback((data: ConversationDetail) => {
    setCurrent(prev => {
      if (prev?.conversation.id !== data.conversation.id) return prev;
      return { ...data, attempts: data.attempts.map(a => {
        const local = prev.attempts.find(x => x.id === a.id);
        return local && active(a) && (streams.current.has(a.id) || !active(local)) ? local : a;
      }) };
    });
  }, []);
  const refresh = useCallback(async (id: string) => { const data = await api<ConversationDetail>('/conversations/' + id); merge(data); }, [merge]);
  useEffect(() => {
    let mounted = true;
    async function boot() {
      try {
        const data = await api<{ owner: { login: string } }>('/session', { method: 'POST', body: {} }); if (!mounted) return; setOwner(data.owner);
        const results = await Promise.allSettled([api<Catalog>('/models'), api<Account>('/account'), api<{ conversations: Conversation[] }>('/conversations')]);
        if (!mounted) return;
        if (results[0].status === 'fulfilled') setCatalog(results[0].value); else setError(errorText(results[0].reason));
        if (results[1].status === 'fulfilled') setAccount(results[1].value);
        if (results[2].status === 'fulfilled') setConversations(results[2].value.conversations);
        const id = new URLSearchParams(location.search).get('c');
        if (id) { const detail = await api<ConversationDetail>('/conversations/' + encodeURIComponent(id)); if (mounted) setCurrent(detail); }
        if (new URLSearchParams(location.search).has('auth_error')) setError('Authorization failed or expired. Please start the connection again.');
      } catch (e) { if (!(e instanceof ApiError && e.status === 401)) setError(errorText(e)); }
      finally { if (mounted) setBooting(false); }
    }
    void boot(); return () => { mounted = false; };
  }, []);
  useEffect(() => {
    if (!owner) return;
    const timer = setInterval(() => { void api<Catalog>('/models').then(setCatalog).catch(e => setError(errorText(e))); }, 300_000);
    return () => clearInterval(timer);
  }, [owner]);
  useEffect(() => {
    if (!current || !running) return;
    const timer = setInterval(() => { void refresh(current.conversation.id).catch(e => setError(errorText(e))); }, 2500);
    return () => clearInterval(timer);
  }, [current?.conversation.id, running, refresh]);
  useEffect(() => {
    const guard = (e: BeforeUnloadEvent) => { if (draft || running) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', guard); return () => window.removeEventListener('beforeunload', guard);
  }, [draft, running]);

  async function connect(provider: 'openrouter') {
    setError(''); try { const { url } = await api<{ url: string }>('/auth/' + provider + '/start', { method: 'POST', body: {} }); location.assign(url); } catch (e) { setError(errorText(e)); }
  }
  function reset(ids = selected) {
    if (draft && !confirm('Start a new conversation and discard your unsent draft?')) return false;
    setSelected(ids); setCurrent(null); setExpanded(null); setDraft(''); submission.current = null; draftConversationId.current = crypto.randomUUID();
    history.replaceState(null, '', '/'); setSidebar(false); setError(''); draftRef.current?.focus(); return true;
  }
  async function openConversation(id: string) {
    if (busy.current || (draft && !confirm('Switch conversations and discard your unsent draft?'))) return;
    try { const data = await api<ConversationDetail>('/conversations/' + id); setCurrent(data); setExpanded(null); setDraft(''); submission.current = null; history.replaceState(null,'','/?c=' + id); setSidebar(false); setError(''); } catch (e) { setError(errorText(e)); }
  }
  function updateAttempt(id: string, fn: (a: Attempt) => Attempt) { setCurrent(prev => prev ? { ...prev, attempts: prev.attempts.map(a => a.id === id ? fn(a) : a) } : prev); }
  async function launch(a: Attempt) {
    if (launched.current.has(a.id)) return; launched.current.add(a.id);
    const abort = new AbortController(); streams.current.set(a.id, abort);
    try {
      const response = await fetch('/api/attempts/' + a.id + '/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: abort.signal });
      if (!response.ok) { const failure = await response.json() as { error?: string }; throw new Error(failure.error || 'Could not start response.'); }
      if (!response.body) throw new Error('The response could not be opened. Try again.');
      for await (const raw of readSSE(response.body)) {
        const event = JSON.parse(raw);
        if (event.type === 'started') updateAttempt(a.id, old => ({ ...old, status: 'running', started_at: event.started_at }));
        if (event.type === 'delta') updateAttempt(a.id, old => ({ ...old, text: old.text + event.text }));
        if (event.type === 'citations') updateAttempt(a.id, old => ({ ...old, citations: event.citations }));
        if (event.type === 'usage') updateAttempt(a.id, old => ({ ...old, usage: event.usage }));
        if (event.type === 'finished') updateAttempt(a.id, () => event.attempt);
      }
    } catch (e) { if (!abort.signal.aborted) setError(errorText(e)); }
    finally { streams.current.delete(a.id); void refresh(a.conversation_id).catch(() => {}); }
  }
  async function send() {
    if (busy.current || running || !draft.trim() || !modelsReady || !searchReady || !account.valid) return;
    busy.current = true; setSubmitting(true); setError('');
    try {
      let c = currentRef.current?.conversation;
      if (!c) {
        c = await api<Conversation>('/conversations', { method: 'POST', body: { id: draftConversationId.current, models: lineup } });
        setCurrent({ conversation: c, turns: [], attempts: [] }); history.replaceState(null,'','/?c=' + c.id);
      }
      const same = submission.current?.prompt === draft.trim() && submission.current.search === search && submission.current.conversationId === c.id;
      if (!same) submission.current = { prompt: draft.trim(), search, key: crypto.randomUUID(), version: c.version, conversationId: c.id };
      const result = await api<ConversationDetail>('/conversations/' + c.id + '/turns', { method: 'POST', body: submission.current });
      scrollToTurn.current = result.turns.at(-1)?.id || null;
      setCurrent(result); setDraft(''); submission.current = null;
      // Calling each async function immediately starts every independent fetch before awaiting any one.
      for (const a of result.attempts.filter(x => x.status === 'pending')) void launch(a);
      void refreshList().catch(() => {});
    } catch (e) { setError(errorText(e)); if (currentRef.current) void refresh(currentRef.current.conversation.id).catch(() => {}); }
    finally { busy.current = false; setSubmitting(false); }
  }
  async function stop(a?: Attempt) {
    try {
      await api(a ? '/attempts/' + a.id + '/stop' : '/conversations/' + current!.conversation.id + '/stop', { method: 'POST', body: {} });
      if (a) streams.current.get(a.id)?.abort(); else for (const attempt of current!.attempts.filter(active)) streams.current.get(attempt.id)?.abort();
      if (current) await refresh(current.conversation.id);
    } catch (e) { setError(errorText(e)); }
  }
  async function retry(a: Attempt) {
    if (!retryKeys.current.has(a.id)) retryKeys.current.set(a.id, crypto.randomUUID());
    try {
      const next = await api<Attempt>('/attempts/' + a.id + '/retry', { method: 'POST', body: { key: retryKeys.current.get(a.id) } });
      setCurrent(prev => prev && prev.conversation.id === a.conversation_id ? { ...prev, attempts: [...prev.attempts.filter(x => x.id !== next.id), next] } : prev);
      if (next.status === 'pending') void launch(next);
    } catch (e) { setError(errorText(e)); }
  }
  const turns = current?.turns || [];
  const hasTurns = turns.length > 0;
  const openPicker = () => { setPicks(lineup); setFilter(''); setPicker(true); };
  const response = (turn: Turn, modelId: string, isExpanded = false) => {
    const attempts = (current?.attempts || []).filter(a => a.turn_id === turn.id && a.model_id === modelId).sort((a, b) => b.number - a.number);
    return <Panel key={turn.id + modelId} id={modelId} models={catalog.models} turn={turn} attempt={attempts[0]} previous={attempts.slice(1)} canRetry={turn.id === turns.at(-1)?.id && !!attempts[0] && !active(attempts[0])}
      onStop={a => void stop(a)} onRetry={a => void retry(a)} expanded={isExpanded} onExpand={() => setExpanded({ turnId: turn.id, modelId })}/>;
  };
  const expandedTurn = turns.find(t => t.id === expanded?.turnId);
  const composer = <div className={'composer-wrap' + (hasTurns ? ' follow-up' : '')}>
    <div className="composer">
      <textarea ref={draftRef} aria-label="Message" placeholder={hasTurns ? 'Ask a follow-up' : 'Ask a question'} value={draft} maxLength={MAX_PROMPT} rows={2} onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}/>
      <div className="composer-tools">
        <button className={'search-toggle ' + (search ? 'on' : '')} aria-pressed={search} onClick={() => setSearch(v => !v)}><Globe2 size={16}/>Web search <span>{search ? 'Auto' : 'Off'}</span></button>
        <div><span className="key-hint">Enter to send</span>{running ? <button className="stop-all" onClick={() => void stop()}><Square size={14}/>Stop all</button> : <button className="send" aria-label="Send to all models" disabled={submitting || !draft.trim() || !modelsReady || !searchReady || !account.valid} onClick={() => void send()}><ArrowUp size={19}/></button>}</div>
      </div>
    </div>
    <div className="composer-note"><span>Shared with everyone</span><button className="text-button" onClick={() => setPrices(true)}>Prices & limits</button></div>
    {!searchReady && <p className="error" role="alert">A selected model does not support web search. Turn search off or change models.</p>}
  </div>;

  if (booting) return <div className="gate"><img src="/council.svg" width="36" alt=""/><p>Loading Council…</p></div>;
  if (!owner) return <div className="gate"><div className="gate-card"><div className="brand"><img src="/council.svg" alt=""/>Council</div><h1>Couldn’t open Council</h1><p>{error || 'The connection is unavailable. Try again.'}</p><button className="primary" onClick={() => location.reload()}>Try again<ArrowRight size={16}/></button></div></div>;

  return <div className="app-shell">
    {sidebar && <button className="sidebar-scrim" aria-label="Close navigation" onClick={() => { setSidebar(false); navigationButton.current?.focus(); }}/>}
    <aside ref={sidebarRef} className={'sidebar ' + (sidebar ? 'open' : '')} aria-label="Navigation">
      <div className="brand"><img src="/council.svg" alt=""/>Council<button className="icon-btn mobile-only" aria-label="Close navigation panel" onClick={() => { setSidebar(false); navigationButton.current?.focus(); }}><X size={18}/></button></div>
      <button className="new-chat" disabled={submitting} onClick={() => reset()}><Plus size={17}/>New conversation</button>
      <div className="sidebar-label">Conversations<span>{conversations.length}</span></div>
      <nav aria-label="Saved conversations">{conversations.length ? conversations.map(c => <button key={c.id} disabled={submitting} className={'conversation-link ' + (current?.conversation.id === c.id ? 'selected' : '')} aria-current={current?.conversation.id === c.id ? 'page' : undefined} onClick={() => void openConversation(c.id)}><MessageSquare size={15}/><span>{c.title}</span></button>) : <p className="sidebar-empty">No conversations yet</p>}</nav>
      <div className="sidebar-bottom"><p className="sharing-note">Conversations are shared with everyone.</p><button className="workspace-settings" onClick={() => setSettings(true)}><Settings2 size={17}/><span>Workspace settings</span></button></div>
    </aside>
    <main inert={sidebar || undefined}>
      <header className="topbar"><div className="page-title"><button ref={navigationButton} className="icon-btn mobile-only" aria-label="Open navigation" onClick={() => setSidebar(true)}><Menu size={20}/></button><h1 title={current?.conversation.title}>{current?.conversation.title || 'New conversation'}</h1></div><div className="topbar-actions"><button className="secondary model-selector" disabled={submitting} onClick={openPicker}>{lineup.length} {lineup.length === 1 ? 'model' : 'models'}<ChevronDown size={14}/></button><button className="connection" aria-label={account.valid ? 'OpenRouter connected' : 'OpenRouter connection settings'} onClick={() => setSettings(true)}><i className={account.valid ? 'connected' : ''}/><span>{account.valid ? 'Connected' : account.managed ? 'Unavailable' : 'Connect OpenRouter'}</span></button></div></header>
      <div className={'conversation-scroll' + (!hasTurns ? ' is-empty' : '')}>
        <div className="notices">
          {!account.connected && !account.managed && <div className="connect-banner"><p>Connect OpenRouter to send messages.</p><button className="secondary" onClick={() => void connect('openrouter')}>Connect OpenRouter<ArrowRight size={15}/></button></div>}
          {account.managed && !account.valid && <p className="error" role="alert">{account.error || 'The shared connection is unavailable. The workspace owner manages this account.'}</p>}
          {error && <div className="error global-error" role="alert"><span>{error}</span><button className="icon-btn" aria-label="Dismiss error" onClick={() => setError('')}><X size={16}/></button></div>}
          {!modelsReady && <div className="error" role="alert"><span>{catalog.models.length ? 'A selected model is unavailable. Change models to continue.' : 'The model catalog has not loaded.'}</span><button className="text-button" onClick={() => void api<Catalog>('/models').then(setCatalog).catch(e => setError(errorText(e)))}>Reload catalog</button></div>}
        </div>
        {hasTurns ? <div className="transcript">{turns.map(turn => <section className="question-group" key={turn.id} aria-label={'Question ' + turn.sequence} ref={element => { if (element) turnElements.current.set(turn.id, element); else turnElements.current.delete(turn.id); }}>
          <div className="question-heading"><span>Question {turn.sequence}</span><h2>{turn.prompt}</h2></div>
          <div className={'panel-grid count-' + lineup.length}>{lineup.map(id => response(turn, id))}</div>
        </section>)}</div> : <div className="empty-workspace"><h2>Ask a question</h2>{composer}<div className="selected-models" aria-label="Selected models">{lineup.map(id => { const who = identity(id, catalog.models); return <span className="selected-model" key={id}><i style={{ background: who.color }}/>{who.name}</span>; })}<button className="text-button" disabled={submitting} onClick={openPicker}>Change models</button></div></div>}
      </div>
      {hasTurns && composer}
    </main>
    {picker && <Modal title="Choose models" close={() => setPicker(false)}><p className="modal-intro">Choose 1–8 models. Changing the selection starts a new conversation.</p><div className="search-field"><Search size={17}/><input data-autofocus aria-label="Search models" placeholder="Search models or providers" value={filter} onChange={e => setFilter(e.target.value)}/><span>{picks.length}/8</span></div><div className="model-options">{[...catalog.models].sort((a,b) => Number(REQUESTED_MODELS.some(m => m.id === b.id)) - Number(REQUESTED_MODELS.some(m => m.id === a.id))).filter(m => (m.name + m.id).toLowerCase().includes(filter.toLowerCase())).map(m => <label key={m.id} className={'model-option ' + (picks.includes(m.id) ? 'chosen' : '')}><input type="checkbox" checked={picks.includes(m.id)} disabled={!picks.includes(m.id) && picks.length >= 8} onChange={() => setPicks(ids => ids.includes(m.id) ? ids.filter(x => x !== m.id) : [...ids, m.id])}/><div><strong>{m.name}</strong><code>{m.id}</code><small>{m.context_length.toLocaleString()} context · {m.supported_parameters.includes('tools') ? 'Tools' : 'No tools'} · {m.reasoning?.supported_efforts?.includes('high') ? 'High reasoning' : 'Default reasoning'}</small></div><span>{price(m.pricing.prompt)} / {price(m.pricing.completion)}<small>per 1M input / output</small></span></label>)}</div>{catalog.missing.length > 0 && <p className="error">Unavailable: {catalog.missing.map(m => m.name).join(', ')}. Choose other models to continue.</p>}<footer className="modal-footer"><span>Prices from OpenRouter</span><button className="primary" disabled={!picks.length} onClick={() => { if (JSON.stringify(picks) === JSON.stringify(lineup) || reset(picks)) setPicker(false); }}><Check size={16}/>Use {picks.length} {picks.length === 1 ? 'model' : 'models'}</button></footer></Modal>}
    {expanded && expandedTurn && <Modal wide title={identity(expanded.modelId, catalog.models).name} close={() => setExpanded(null)}>{response(expandedTurn, expanded.modelId, true)}</Modal>}
    {prices && <Modal title="Prices & limits" close={() => setPrices(false)}><div className="price-content"><p>Base prices per 1M tokens · Input / output</p>{lineup.map(id => { const m = catalog.models.find(x => x.id === id); return <div className="price-row" key={id}><span>{identity(id, catalog.models).name}<small>{m?.reasoning?.supported_efforts?.includes('high') ? 'High reasoning' : 'Default reasoning'} · {Math.min(MAX_COMPLETION, m?.top_provider.max_completion_tokens || MAX_COMPLETION).toLocaleString()} output cap{m?.pricing.overrides ? ' · Tiered pricing may apply' : ''}</small></span><b>{price(m?.pricing.prompt)} / {price(m?.pricing.completion)}</b></div>; })}<p>Output limits include reasoning. Input, cached tokens, context length, and tool usage can affect cost. Actual charges appear when reported by OpenRouter.</p><p>{search ? 'Exa Auto: up to 3 searches with 5 results each per model. Base charge: $0.007/search, plus model tokens (checked Oct 24, 2026).' : 'Web search is off for the next message.'} <a href={SEARCH_DOCS} target="_blank" rel="noreferrer">Search pricing <ArrowRight size={12}/></a></p><small>Catalog updated {catalog.fetchedAt ? new Date(catalog.fetchedAt).toLocaleTimeString() : '—'}.</small></div></Modal>}
    {settings && <Modal title="Workspace settings" close={() => setSettings(false)}><div className="account-panel">
      <p>Conversations are shared with everyone. Usage is paid from the owner’s OpenRouter credits.</p>
      <div className="account-status"><span>OpenRouter</span><b>{account.valid ? 'Connected' : account.connected ? 'Needs attention' : 'Not connected'}</b></div>
      {account.managed ? <p>The workspace owner manages the connection. Visitors cannot replace or disconnect the account.</p> : <>
        {account.connected && <p>{account.error || (account.limitRemaining == null ? 'Remaining credit limit unavailable.' : `$${account.limitRemaining.toFixed(2)} remaining on this key’s limit.`)}</p>}
        <button className="primary" onClick={() => void connect('openrouter')}>{account.connected ? 'Reconnect OpenRouter' : 'Connect OpenRouter'}<ArrowRight size={16}/></button>
        {account.connected && <button className="secondary" onClick={() => { void api('/account', { method: 'DELETE' }).then(() => { setAccount({ connected: false }); setSettings(false); }).catch(e => setError(errorText(e))); }}>Disconnect account</button>}
        <small>Disconnecting removes the stored credential. Revoke the key in <a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">OpenRouter</a> to disable it there.</small>
      </>}
    </div></Modal>}
  </div>;
}
