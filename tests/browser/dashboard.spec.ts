import { test, expect, type Page } from '@playwright/test';
import { REQUESTED_MODELS, type Attempt, type ConversationDetail } from '../../shared/config';

type Options = { decisions?: boolean; hold?: Promise<void>; failures?: boolean; long?: boolean; missingUsage?: boolean };
async function fixture(page: Page, options: Options = {}) {
  let detail: ConversationDetail | null = null;
  let launches = 0;
  const models = [...REQUESTED_MODELS, { id: 'test/eighth', name: 'Eighth model', provider: 'Test', color: '#aaa' }];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const data = request.method() === 'POST' ? request.postDataJSON() : null;
    const send = (json: unknown) => route.fulfill({ json });
    if (path === '/api/session') return send({ owner: { login: 'Shared workspace' } });
    if (path === '/api/models') return send({ models: models.map(m => ({ ...m, context_length: 1000000, top_provider: { max_completion_tokens: 128000 }, supported_parameters: ['tools', 'reasoning', 'max_tokens'], reasoning: { supported_efforts: ['high'] }, pricing: { prompt: '0.000002', completion: '0.00001' } })), fetchedAt: Date.now(), missing: [] });
    if (path === '/api/account') return send({ connected: true, valid: true, managed: true });
    if (path === '/api/conversations' && request.method() === 'GET') return send({ conversations: detail ? [detail.conversation] : [] });
    if (path === '/api/conversations') {
      detail = { conversation: { id: data.id, title: 'New conversation', models: data.models, version: 0, created_at: Date.now(), updated_at: Date.now() }, turns: [], attempts: [] };
      return send(detail.conversation);
    }
    if (path.endsWith('/turns') && detail) {
      const turn = { id: crypto.randomUUID(), sequence: detail.turns.length + 1, prompt: data.prompt, search: Number(data.search), created_at: Date.now() };
      detail.turns.push(turn); detail.conversation.version++;
      if (detail.turns.length === 1) detail.conversation.title = data.prompt.slice(0, 80);
      for (const id of detail.conversation.models) detail.attempts.push({ id: crypto.randomUUID(), turn_id: turn.id, conversation_id: detail.conversation.id, model_id: id, number: 1, status: 'pending', text: '', verdict: null, citations: [], usage: null, error: null, started_at: null, finished_at: null, created_at: Date.now(), provider_id: null });
      return send(detail);
    }
    if (path.endsWith('/stream') && detail) {
      launches++;
      await options.hold;
      const a = detail.attempts.find(x => path.includes(x.id))!;
      if (a.status !== 'stopped') {
        const sequence = detail.turns.find(t => t.id === a.turn_id)!.sequence;
        const paragraphs = options.long && a.model_id === models[0].id ? '\n\n' + Array.from({ length: 45 }, (_, i) => `Paragraph ${i + 1}. A longer answer with enough text to exercise independent scrolling and readable line lengths.`).join('\n\n') : '';
        const text = `## Answer to question ${sequence}\n\nResponse from **${a.model_id}**.${paragraphs}\n\n[Unsafe link](javascript:alert(1))\n\n<script>alert('unsafe')</script>`;
        const verdict = options.decisions ? (a.model_id === models[0].id ? (a.number === 1 ? 'yes' : 'no') : a.model_id === models[1].id ? 'no' : null) : null;
        Object.assign(a, { text, verdict, status: 'complete', started_at: Date.now() - 800, finished_at: Date.now(), usage: options.missingUsage ? null : { total_tokens: 42, cost: 0.017 }, citations: [{ url: 'https://example.com/source', title: 'Reference document' }] });
        if (options.failures && a.model_id === models[1].id) Object.assign(a, { status: 'error', error: 'The model is unavailable. Try again.', verdict: null });
        if (options.failures && a.model_id === models[2].id) Object.assign(a, { status: 'interrupted', error: 'Connection interrupted. Partial answer saved.', verdict: null });
      }
      return route.fulfill({ contentType: 'text/event-stream', body: [{ type: 'started', started_at: a.started_at }, { type: 'delta', text: a.text }, { type: 'finished', attempt: a }].map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') });
    }
    if (path.endsWith('/stop') && detail) {
      const targets = path.startsWith('/api/attempts/') ? detail.attempts.filter(a => path.includes(a.id)) : detail.attempts;
      for (const a of targets.filter(a => ['pending', 'running'].includes(a.status))) Object.assign(a, { status: 'stopped', text: 'Saved partial answer.', finished_at: Date.now() });
      return send({ ok: true });
    }
    if (path.endsWith('/retry') && detail) {
      const prior = detail.attempts.find(x => path.includes(x.id))!;
      const next: Attempt = { ...prior, id: crypto.randomUUID(), number: prior.number + 1, status: 'pending', verdict: null, text: '', citations: [], usage: null, error: null, started_at: null, finished_at: null };
      detail.attempts.push(next); return send(next);
    }
    if (path.startsWith('/api/conversations/') && detail) return send(detail);
    return route.fulfill({ status: 404, json: { error: 'No fixture' } });
  });
  return { launches: () => launches };
}
const question = (page: Page, n: number) => page.getByRole('region', { name: `Question ${n}`, exact: true });
async function send(page: Page, text: string) {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByLabel('Send to all models').click();
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}

test('empty composer, grouped responses, sources, safe Markdown, and saved history', async ({ page }, info) => {
  const f = await fixture(page); await page.goto('/');
  await expect(page).toHaveTitle('Council');
  await expect(page.getByRole('heading', { name: 'New conversation' })).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByLabel('Selected models').locator('.selected-model')).toHaveCount(7);
  await page.screenshot({ path: `work/empty-${info.project.name}.png`, fullPage: true });
  await send(page, 'What changed this week?');
  await expect.poll(f.launches).toBe(7);
  await expect(question(page, 1).getByRole('heading', { name: 'What changed this week?', exact: true })).toHaveCount(1);
  await expect(question(page, 1).getByRole('article')).toHaveCount(7);
  await expect(question(page, 1).getByText('Answer to question 1', { exact: true })).toHaveCount(7);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);
  await expect(page.locator('.markdown script')).toHaveCount(0);
  const first = question(page, 1).getByRole('article').first();
  await expect(first.getByRole('link', { name: 'Reference document' })).not.toBeVisible();
  await first.getByText('Sources (1)', { exact: true }).click();
  await expect(first.getByRole('link', { name: 'Reference document' })).toBeVisible();
  await first.getByText('Details', { exact: true }).click();
  await expect(first.getByText('$0.017', { exact: true })).toBeVisible();
  await page.reload();
  await expect(question(page, 1).getByRole('article')).toHaveCount(7);
  await page.screenshot({ path: `work/completed-${info.project.name}.png`, fullPage: true });
  await noOverflow(page);
});

test('follow-ups show one prompt and expand the correct historical answer', async ({ page }, info) => {
  await fixture(page, { long: true }); await page.goto('/');
  await send(page, 'First question');
  await expect(question(page, 1).getByText('Answer to question 1', { exact: true })).toHaveCount(7);
  await send(page, 'Second question');
  await expect(question(page, 2).getByText('Answer to question 2', { exact: true })).toHaveCount(7);
  await expect(question(page, 1).getByRole('heading', { name: 'First question', exact: true })).toHaveCount(1);
  await expect(question(page, 2).getByRole('heading', { name: 'Second question', exact: true })).toHaveCount(1);
  await expect(question(page, 1).getByLabel('Retry GPT-6 Astra', { exact: true })).toHaveCount(0);
  await expect(question(page, 2).getByLabel('Retry GPT-6 Astra', { exact: true })).toBeVisible();
  await page.reload();
  await expect(question(page, 2).getByRole('article')).toHaveCount(7);
  const expand = question(page, 1).getByLabel('Expand GPT-6 Astra', { exact: true });
  await expand.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('First question', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Answer to question 1', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Answer to question 2', { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel('Retry GPT-6 Astra', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `work/expanded-${info.project.name}.png`, fullPage: true });
  await page.keyboard.press('Escape'); await expect(expand).toBeFocused();
  const reader = question(page, 1).getByLabel('GPT-6 Astra answer', { exact: true });
  expect(await reader.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  expect(await reader.evaluate(el => el.scrollTop)).toBe(0);
  await noOverflow(page);
});

test('conclusions wait for completion, survive reload, and retain previous attempts', async ({ page }, info) => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(page, { decisions: true, hold }); await page.goto('/');
  await send(page, 'Should we proceed?');
  await expect.poll(f.launches).toBe(7);
  await expect(page.locator('.verdict-badge')).toHaveCount(0);
  await page.screenshot({ path: `work/streaming-${info.project.name}.png`, fullPage: true });
  release();
  const first = question(page, 1).getByRole('article', { name: 'GPT-6 Astra response', exact: true });
  await expect(first.getByLabel('Conclusion: YES')).toBeVisible();
  await expect(page.locator('.panel-header .verdict-badge')).toHaveCount(2);
  await page.reload(); await expect(first.getByLabel('Conclusion: YES')).toBeVisible();
  await first.getByLabel('Retry GPT-6 Astra', { exact: true }).click();
  await expect(first.locator('.panel-header .verdict-no')).toHaveText('NO');
  await first.getByText('1 previous attempt').click();
  await expect(first.locator('.prior-attempts .verdict-yes')).toHaveText('YES');
  await noOverflow(page);
});

for (const count of [1, 2, 3, 7, 8]) {
  test(`${count} selected models preserve order and fit the viewport`, async ({ page }) => {
    await fixture(page); await page.goto('/');
    await page.getByRole('button', { name: 'Change models', exact: true }).click();
    const boxes = page.getByRole('dialog').getByRole('checkbox');
    for (let i = 0; i < 8; i++) await boxes.nth(i).setChecked(i < count);
    await page.getByRole('button', { name: `Use ${count} ${count === 1 ? 'model' : 'models'}`, exact: true }).click();
    await expect(page.getByRole('article')).toHaveCount(0);
    await send(page, 'Compare these results.');
    await expect(question(page, 1).getByText('Answer to question 1', { exact: true })).toHaveCount(count);
    const names = await question(page, 1).locator('.panel-header h3').allTextContents();
    expect(names).toEqual([...REQUESTED_MODELS.map(m => m.name), 'Eighth model'].slice(0, count));
    await noOverflow(page);
  });
}

test('failures and missing metrics stay distinct from completed answers', async ({ page }, info) => {
  await fixture(page, { failures: true, missingUsage: true }); await page.goto('/');
  await send(page, 'x'.repeat(300));
  const first = question(page, 1).getByRole('article').first();
  await expect(first.getByText('Answer to question 1', { exact: true })).toBeVisible();
  await expect(question(page, 1).getByText('The model is unavailable. Try again.')).toBeVisible();
  await first.getByText('Details', { exact: true }).click();
  await expect(first.locator('dd').filter({ hasText: 'Unavailable' })).toHaveCount(2);
  await page.screenshot({ path: `work/errors-${info.project.name}.png`, fullPage: true });
  await noOverflow(page);
});

test('Stop preserves partial answers and Stop all ends remaining attempts', async ({ page }) => {
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(page, { hold }); await page.goto('/');
  await send(page, 'Stop test'); await expect.poll(f.launches).toBe(7);
  await page.getByLabel('Stop GPT-6 Astra', { exact: true }).click();
  const first = question(page, 1).getByRole('article').first();
  await expect(first.getByText('Saved partial answer.', { exact: true })).toBeVisible();
  await expect(first.getByText('Response stopped. Partial answer saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Stop all', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop all', exact: true })).toHaveCount(0);
  release();
});

test('draft protection, search setting, model changes, and keyboard input', async ({ page }) => {
  await fixture(page); await page.goto('/');
  const editor = page.getByRole('textbox', { name: 'Message', exact: true });
  await editor.fill('My unsent draft');
  if (await page.getByLabel('Open navigation').isVisible()) await page.getByLabel('Open navigation').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  if (await page.getByLabel('Close navigation panel').isVisible()) await page.keyboard.press('Escape');
  await expect(editor).toHaveValue('My unsent draft');
  const search = page.getByRole('button', { name: 'Web search Auto' });
  await search.click();
  await expect(page.getByRole('button', { name: 'Web search Off' })).toHaveAttribute('aria-pressed', 'false');
  await editor.press('Shift+Enter');
  await expect(page.getByRole('article')).toHaveCount(0);
  await editor.press('Enter');
  await expect(question(page, 1).getByRole('article')).toHaveCount(7);
  await page.getByRole('button', { name: '7 models', exact: true }).click();
  await page.getByLabel('Search models').fill('Kimi');
  await page.getByRole('dialog').getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: 'Use 6 models', exact: true }).click();
  await expect(page.getByRole('article')).toHaveCount(0);
  await expect(page.getByLabel('Selected models').locator('.selected-model')).toHaveCount(6);
});

test('workspace discloses sharing, hides credential controls, and dialogs restore focus', async ({ page }) => {
  await fixture(page); await page.goto('/');
  const settings = page.getByRole('button', { name: 'OpenRouter connected', exact: true });
  await settings.click();
  await expect(page.getByRole('dialog').getByText('Conversations are shared with everyone. Usage is paid from the owner’s OpenRouter credits.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reconnect OpenRouter' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Disconnect account' })).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(settings).toBeFocused();
  await page.getByRole('button', { name: 'Change models', exact: true }).click();
  await expect(page.getByLabel('Search models')).toBeFocused();
  await page.screenshot({ path: `work/models-${test.info().project.name}.png`, fullPage: true });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Change models', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Prices & limits', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Prices & limits' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Search pricing' })).toBeVisible();
  await noOverflow(page);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Prices & limits', exact: true })).toBeFocused();
});

test('session failures show direct recovery copy', async ({ page }) => {
  await page.route('**/api/session', route => route.fulfill({ status: 503, json: { error: 'Connection unavailable.' } }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Couldn’t open Council' })).toBeVisible();
  await expect(page.getByText('Connection unavailable.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});
