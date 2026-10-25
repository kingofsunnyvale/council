import { test, expect, type Page } from '@playwright/test';
import { REQUESTED_MODELS, type ConversationDetail } from '../../shared/config';

async function fixture(page: Page) {
  let detail: ConversationDetail | null=null;
  let launches=0;
  await page.route('**/api/**', async route => {
    const r=route.request(),path=new URL(r.url()).pathname;
    const data=r.method()==='POST'?r.postDataJSON():null;
    const send=(json:unknown)=>route.fulfill({json});
    if(path==='/api/session')return send({owner:{login:'Private workspace'}});
    if(path==='/api/models')return send({models:REQUESTED_MODELS.map(m=>({...m,context_length:1000000,top_provider:{max_completion_tokens:128000},supported_parameters:['tools','reasoning','max_tokens'],reasoning:{supported_efforts:['high']},pricing:{prompt:'0.000002',completion:'0.00001'}})),fetchedAt:Date.now(),missing:[]});
    if(path==='/api/account')return send({connected:true,valid:true,limitRemaining:10});
    if(path==='/api/conversations' && r.method()==='GET')return send({conversations:detail?[detail.conversation]:[]});
    if(path==='/api/conversations') {
      detail={conversation:{id:data.id,title:'New conversation',models:data.models,version:0,created_at:Date.now(),updated_at:Date.now()},turns:[],attempts:[]};return send(detail.conversation);
    }
    if(path.endsWith('/turns') && detail) {
      const turn={id:crypto.randomUUID(),sequence:detail.turns.length+1,prompt:data.prompt,search:Number(data.search),created_at:Date.now()};detail.turns.push(turn);detail.conversation.version++;detail.conversation.title=data.prompt;
      for(const id of detail.conversation.models) detail.attempts.push({id:crypto.randomUUID(),turn_id:turn.id,conversation_id:detail.conversation.id,model_id:id,number:1,status:'pending',text:'',citations:[],usage:null,error:null,started_at:null,finished_at:null,created_at:Date.now(),provider_id:null});
      return send(detail);
    }
    if(path.endsWith('/stream') && detail) {
      launches++;
      const a=detail.attempts.find(x=>path.includes(x.id))!;const text=`## An independent answer\n\nPerspective from **${a.model_id}**.\n\n[Unsafe link](javascript:alert(1))\n\n<script>alert('unsafe')</script>`;
      Object.assign(a,{text,status:'complete',started_at:Date.now()-800,finished_at:Date.now(),usage:{total_tokens:42,cost:0.017},citations:[{url:'https://example.com/source',title:'Returned source'}]});
      return route.fulfill({contentType:'text/event-stream',body:[{type:'started',started_at:a.started_at},{type:'delta',text},{type:'finished',attempt:a}].map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')});
    }
    if(path.startsWith('/api/conversations/') && detail)return send(detail);
    return route.fulfill({status:404,json:{error:'No fixture'}});
  });
  return { launches:()=>launches };
}
test('seven independent panels, safe Markdown, sources, reload, expansion, and lineup changes', async ({page},info) => {
  const f=await fixture(page);await page.goto('/');
  await expect(page.getByRole('heading',{name:'One question. More perspective.'})).toBeVisible();
  await expect(page.getByRole('article')).toHaveCount(7);
  await page.getByLabel('Message your council').fill('What changed this week?');await page.getByLabel('Send to all models').click();
  await expect.poll(f.launches).toBe(7);
  await expect(page.getByText('An independent answer',{exact:true})).toHaveCount(7);
  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0);await expect(page.locator('.markdown script')).toHaveCount(0);
  await expect(page.getByRole('link',{name:'1 Returned source'})).toHaveCount(7);
  await page.getByLabel('Expand GPT-6 Astra').click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');
  await page.reload();await expect(page.getByText('An independent answer',{exact:true})).toHaveCount(7);
  await page.screenshot({path:`work/dashboard-${info.project.name}.png`,fullPage:true});
  await page.getByRole('button',{name:'7 models'}).click();await page.getByLabel('Search models').fill('Kimi');
  await expect(page.getByRole('dialog').getByText('Kimi K3.1 Pro',{exact:true})).toBeVisible();
  await page.getByRole('dialog').getByRole('checkbox').uncheck();await page.getByRole('button',{name:'Use 6 models'}).click();
  await expect(page.getByRole('article')).toHaveCount(6);await expect(page.getByRole('heading',{name:'One question. More perspective.'})).toBeVisible();
  const overflows=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);expect(overflows).toBe(false);
});
test('unsent draft is protected when starting a new conversation', async ({page})=>{
  await fixture(page);await page.goto('/');await page.getByLabel('Message your council').fill('My unsent draft');
  if(await page.getByLabel('Open navigation').isVisible())await page.getByLabel('Open navigation').click();
  page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'New conversation'}).click();
  await expect(page.getByLabel('Message your council')).toHaveValue('My unsent draft');
});
