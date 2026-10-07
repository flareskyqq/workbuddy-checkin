import { chromium } from 'playwright-core';
import fs from 'node:fs';
const dir=fs.mkdtempSync('/tmp/loginscreen-');
const ctx=await chromium.launchPersistentContext(dir,{
  headless:false, channel:'msedge', viewport:null,
  args:['--no-first-run','--no-default-browser-check','--window-size=1100,800'],
  ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation']});
for(const h of ['doubleclick.net','googletagmanager.com','google-analytics.com','galileotelemetry.tencent.com','ping.cloud.tencent.com'])
  await ctx.route(`**://*.${h}/**`,r=>r.abort()).catch(()=>{});
const page=ctx.pages()[0]||await ctx.newPage();
await page.goto('https://www.workbuddy.cn/login/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
await page.waitForTimeout(9000);
console.log('最终URL:', page.url());
console.log('标题:', await page.title());
const txt=(await page.evaluate(()=>document.body.innerText.replace(/\n{2,}/g,'\n'))).split('\n').map(s=>s.trim()).filter(Boolean);
console.log('页面文字(前 18 行):'); txt.slice(0,18).forEach(l=>console.log('   '+l.slice(0,60)));
const imgs=await page.evaluate(()=>[...document.images].map(i=>i.src.slice(0,40)).slice(0,4));
console.log('图片:', imgs.length?imgs.join(' | '):'无');
const canvases=await page.evaluate(()=>document.querySelectorAll('canvas').length);
console.log('canvas 数量:', canvases);
await page.screenshot({path:'/tmp/login_page_view.png'});
await ctx.close();
