// Production-artifact regression: run after build:feedback. Only synthetic data.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root = resolve('dist');
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = resolve(root, '.' + url.pathname + (url.pathname.endsWith('/') ? 'index.html' : ''));
  if (!file.startsWith(root + '/')) { res.writeHead(403).end(); return; }
  try { const body = await readFile(file); res.setHeader('Content-Type', ({'.js':'text/javascript','.css':'text/css','.html':'text/html'})[extname(file)] ?? 'application/octet-stream'); res.end(body); }
  catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
const apiOrigin = process.env.FEEDBACK_TEST_API_ORIGIN ?? origin;
const browser = await chromium.launch();
try {
  for (const [theme,mode] of [['brutal','light'],['elegant','light'],['elegant','dark']]) {
    const page = await browser.newPage({viewport:{width:390,height:844}});
    await page.addInitScript(({theme,mode,apiOrigin})=>{window.__events=[];window.RaftFeedback={version:'raft-feedback-v1',session:{accountId:'synthetic',sessionGeneration:1,webViewGeneration:1,accessToken:'synthetic-token',apiOrigin,clientKind:'android',clientVersion:'1',locale:'en',theme,mode},emit:(event,binding)=>window.__events.push({event,binding})};},{theme,mode,apiOrigin});
    let postCount=0;const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('**/api/product-feedback**',async r=>{
      assert.equal(r.request().headers()['x-raft-client-kind'],'android');
      if(r.request().method()==='POST') {postCount++; await r.fulfill({status:401,json:{code:'auth_required'}});return;}
      await r.fulfill({json:{tickets:[{id:'fixture',kind:'feedback',status:'open',message:'A long synthetic feedback title that must wrap inside a narrow phone screen '+ 'x'.repeat(100),created_at:1700000000000,updated_at:1700000000000,unread:false,unread_count:0,attachment_count:0,comment_count:0}],next_cursor:null,unread_total:0}});
    });
    await page.route('**/api/privacy-mode', r => r.fulfill({ json: { enabled: false }, headers: { 'access-control-allow-origin': '*' } }));
    await page.goto(origin+'/feedback/');
    await page.locator('.hands-feedback-ticket-card').waitFor();
    const bounds=await page.locator('.hands-feedback-ticket-card').boundingBox();assert(bounds.x+ bounds.width<=390);
    await page.getByRole('button',{name:'New feedback',exact:true}).click();
    const text=page.locator('textarea');await text.fill('Synthetic draft survives native auth refresh');
    await page.evaluate(()=>{window.RaftFeedback.session.accessToken='rotated-token';window.dispatchEvent(new Event('raft:feedback-session-updated'));});
    await text.waitFor();assert.equal(await text.inputValue(),'Synthetic draft survives native auth refresh');
    await page.getByRole('button',{name:'Submit',exact:true}).click();
    await page.waitForFunction(()=>window.__events.some(x=>x.event==='auth-required'));
    assert.equal(await text.inputValue(),'Synthetic draft survives native auth refresh');assert.equal(postCount,1);
    const overlayStyle = await page.locator('.feedback-auth-status').evaluate(el => { const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.fillStyle=getComputedStyle(el).backgroundColor;ctx.fillRect(0,0,1,1);return {background:getComputedStyle(el).backgroundColor,color:getComputedStyle(el).color,rgba:Array.from(ctx.getImageData(0,0,1,1).data)}; });
    assert.equal(overlayStyle.rgba[3],255);assert.notEqual(overlayStyle.background, overlayStyle.color);
    await page.evaluate(()=>{window.RaftFeedback.session.accessToken='refreshed-token';window.dispatchEvent(new Event('raft:feedback-session-updated'));});
    await page.getByRole('button',{name:'Submit',exact:true}).waitFor();assert.equal(await text.inputValue(),'Synthetic draft survives native auth refresh');
    await page.getByRole('alert').getByText('Your draft is kept. After signing in, submit again when ready.', {exact:true}).waitFor();
    assert.equal(await page.getByText('Your feedback session expired. Reopen feedback and try again.', {exact:true}).count(),0);
    assert.equal(await page.evaluate(()=>window.__events.filter(x=>x.event==='ready').length),1);
    assert.deepEqual(errors,[]);console.log(`${theme}/${mode}: long card fits; refresh and 401 preserve draft; no retry`);await page.close();
  }
  const missing = await browser.newPage({locale: 'zh-CN', colorScheme: 'dark'});
  let requests = 0;
  await missing.route('**/api/**', r => { requests++; return r.abort(); });
  await missing.route('**/api/privacy-mode', r => r.fulfill({ json: { enabled: false }, headers: { 'access-control-allow-origin': '*' } }));
  await missing.goto(origin + '/feedback/');
  await missing.getByText('请从 Raft App 打开反馈页。', {exact: true}).waitFor();
  assert.equal(requests, 0);
  const style = await missing.locator('.feedback-host-status').evaluate(el => {const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.fillStyle=getComputedStyle(el).backgroundColor;ctx.fillRect(0,0,1,1);return {padding:getComputedStyle(el).paddingTop,rgba:Array.from(ctx.getImageData(0,0,1,1).data)};});
  assert.equal(style.padding, '24px');assert.equal(style.rgba[3],255);assert(style.rgba.slice(0,3).every(channel=>channel<128));
  console.log('missing host: localized, themed, no API');await missing.close();
} finally {await browser.close(); await new Promise(done=>server.close(done));}
