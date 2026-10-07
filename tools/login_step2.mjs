import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
function cpu(dir){const out=execSync('ps -A -o %cpu,command',{encoding:'utf8',maxBuffer:8*1024*1024});let t=0,ws=0;for(const l of out.split('\n')){const m=l.trim().match(/^([\d.]+)/);if(!m)continue;const c=+m[1];if(l.includes(dir))t+=c;if(l.includes('WindowServer'))ws=c;}return {t:Math.round(t*10)/10,ws:Math.round(ws*10)/10};}
const avg=(a)=>Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10;
const dir=fs.mkdtempSync('/tmp/step2-');
const ctx=await chromium.launchPersistentContext(dir,{headless:false,channel:'msedge',viewport:null,
  args:['--no-first-run','--no-default-browser-check','--window-size=1100,800'],
  ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation']});
for(const h of ['doubleclick.net','googletagmanager.com','google-analytics.com','galileotelemetry.tencent.com','ping.cloud.tencent.com'])
  await ctx.route(`**://*.${h}/**`,r=>r.abort()).catch(()=>{});
const page=ctx.pages()[0]||await ctx.newPage();
await page.goto('https://www.workbuddy.cn/login/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
await page.waitForTimeout(6000);
// 点“同意”
const clicked = await page.evaluate(()=>{
  const el=[...document.querySelectorAll('button,a,div,span')].find(e=>/^同意$/.test((e.textContent||'').trim()));
  if(el){el.click();return true;} return false;
});
console.log('是否点到「同意」:', clicked);
await page.waitForTimeout(9000);
console.log('点完之后 URL:', page.url());
const txt=(await page.evaluate(()=>document.body.innerText.replace(/\n{2,}/g,'\n'))).split('\n').map(s=>s.trim()).filter(Boolean).slice(0,12);
console.log('页面文字:'); txt.forEach(l=>console.log('   '+l.slice(0,60)));
const s=[];const w=[];for(let i=0;i<6;i++){await page.waitForTimeout(1000);const c=cpu(dir);s.push(c.t);w.push(c.ws);}
console.log(`空闲CPU: 浏览器 ${avg(s)}% | WindowServer ${avg(w)}%`);
await page.screenshot({path:'/tmp/login_step2.png'});
await ctx.close();
