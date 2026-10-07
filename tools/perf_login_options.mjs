import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
function cpu(dir){const out=execSync('ps -A -o %cpu,command',{encoding:'utf8',maxBuffer:8*1024*1024});let t=0;for(const l of out.split('\n'))if(l.includes(dir)){const m=l.trim().match(/^([\d.]+)/);if(m)t+=parseFloat(m[1]);}return Math.round(t*10)/10;}
const avg=(a)=>Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10;
const TRACK=['doubleclick.net','googletagmanager.com','google-analytics.com','googlesyndication.com','galileotelemetry.tencent.com','ping.cloud.tencent.com','hm.baidu.com'];

async function run(label, { url, channel='chrome', killAnim=false, blockMedia=false }) {
  const dir=fs.mkdtempSync('/tmp/perfopt-');
  const ctx=await chromium.launchPersistentContext(dir,{ headless:false, channel, viewport:null,
    args:['--no-first-run','--no-default-browser-check','--disable-infobars','--window-position=-3000,-3000'],
    ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation'] });
  for(const h of TRACK) await ctx.route(`**://*.${h}/**`,r=>r.abort()).catch(()=>{});
  if (blockMedia) await ctx.route('**/*.{mp4,webm,ogg,mp3}', r=>r.abort()).catch(()=>{});
  const page=ctx.pages()[0]||await ctx.newPage();
  if (killAnim) await page.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;animation-duration:0s!important}'}).catch(()=>{});
  const t0=Date.now();
  await page.goto(url,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  const dom=Date.now()-t0;
  if (killAnim) {
    for (const p of ctx.pages()) await p.addStyleTag({content:'*,*::before,*::after{animation:none!important;transition:none!important;animation-duration:0s!important}'}).catch(()=>{});
  }
  await page.waitForTimeout(9000);
  const s=[]; for(let i=0;i<6;i++){await page.waitForTimeout(1000);s.push(cpu(dir));}
  const info=await page.evaluate(()=>({url:location.href,n:performance.getEntriesByType('resource').length,
    txt:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,50)})).catch(()=>({}));
  await ctx.close();
  console.log(`${label}\n   → ${info.url}\n   DOM就绪 ${dom}ms | 请求 ${info.n} | 空闲CPU ${avg(s)}%  [${s.join(', ')}]\n`);
}

await run('A. 现状：Chrome + 官网首页', { url:'https://www.workbuddy.cn/' });
await run('B. Chrome + 直接打开登录页', { url:'https://www.workbuddy.cn/login/' });
await run('C. Chrome + 首页 + 禁用动画', { url:'https://www.workbuddy.cn/', killAnim:true });
await run('D. Edge + 直接打开登录页', { url:'https://www.workbuddy.cn/login/', channel:'msedge' });
