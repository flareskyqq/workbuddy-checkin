import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
function stat(dir,keyword){
  const out=execSync('ps -A -o %cpu,command',{encoding:'utf8',maxBuffer:8*1024*1024});
  let mine=0, ws=0;
  for(const l of out.split('\n')){
    const m=l.trim().match(/^([\d.]+)/); if(!m) continue;
    const c=parseFloat(m[1]);
    if(l.includes(dir)) mine+=c;
    if(l.includes('WindowServer')) ws=c;
  }
  return {mine:Math.round(mine*10)/10, ws:Math.round(ws*10)/10};
}
const avg=(a)=>Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10;

async function run(label, { position, url, size }) {
  const dir=fs.mkdtempSync('/tmp/onscreen-');
  const args=['--no-first-run','--no-default-browser-check','--window-size='+size];
  if (position) args.push('--window-position='+position);
  const ctx=await chromium.launchPersistentContext(dir,{headless:false,channel:'msedge',viewport:null,args,
    ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation']});
  for(const h of ['doubleclick.net','googletagmanager.com','google-analytics.com','galileotelemetry.tencent.com','ping.cloud.tencent.com'])
    await ctx.route(`**://*.${h}/**`,r=>r.abort()).catch(()=>{});
  const page=ctx.pages()[0]||await ctx.newPage();
  const t0=Date.now();
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  const dom=Date.now()-t0;
  await page.waitForTimeout(6000);
  const mine=[],ws=[];
  for(let i=0;i<6;i++){await page.waitForTimeout(1000);const s=stat(dir);mine.push(s.mine);ws.push(s.ws);}
  const info=await page.evaluate(()=>({url:location.href, n:performance.getEntriesByType('resource').length})).catch(()=>({}));
  await ctx.close();
  console.log(`${label}\n   最终URL ${info.url}\n   请求 ${info.n} | DOM ${dom}ms | 浏览器CPU ${avg(mine)}% | WindowServer ${avg(ws)}%\n`);
}

const U='https://www.workbuddy.cn/login/';
await run('① 窗口移出屏幕（我测试时的情况）',{position:'-3000,-3000',url:U,size:'1280,900'});
await run('② 窗口在屏幕内（你现在遇到的情况）',{position:'120,80',url:U,size:'1280,900'});
await run('③ 屏幕内 + 小窗口 1000×740',{position:'120,80',url:U,size:'1000,740'});
