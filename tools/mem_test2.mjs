import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
function stat(dir){
  const out=execSync('ps -A -o %cpu,rss,command',{encoding:'utf8',maxBuffer:8*1024*1024});
  let cpu=0,mem=0,n=0;
  for(const l of out.split('\n')){
    if(!l.includes(dir)) continue;
    const m=l.trim().match(/^([\d.]+)\s+(\d+)/); if(!m) continue;
    cpu+=parseFloat(m[1]); mem+=parseInt(m[2]); n++;
  }
  return {cpu:Math.round(cpu*10)/10, mb:Math.round(mem/1024), n};
}
const avg=(a)=>Math.round(a.reduce((x,y)=>x+y,0)/a.length);

async function run(label, opts){
  const dir=fs.mkdtempSync('/tmp/m2-');
  let ctx;
  try{ ctx=await chromium.launchPersistentContext(dir,opts); }catch(e){ console.log(label,'❌',String(e.message).split('\n')[0]); return; }
  const page=ctx.pages()[0]||await ctx.newPage();
  await page.goto('https://www.workbuddy.cn/login/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  await page.waitForTimeout(6000);
  // 点“同意”进入扫码页（用户实际停留的页面）
  await page.evaluate(()=>{const el=[...document.querySelectorAll('button,a,div,span')].find(e=>/^同意$/.test((e.textContent||'').trim()));if(el)el.click();}).catch(()=>{});
  await page.waitForTimeout(6000);
  const s=[],mm=[]; let procs=0;
  for(let i=0;i<5;i++){await page.waitForTimeout(1000);const p=stat(dir);s.push(p.cpu);mm.push(p.mb);procs=p.n;}
  const qr=await page.evaluate(()=>({t:/微信扫码|扫码/.test(document.body.innerText)})).catch(()=>({}));
  console.log(`${label}\n   CPU ${avg(s)}% | 内存 ${avg(mm)}MB | 进程 ${procs} | 扫码页:${qr.t}`);
  await ctx.close();
}
const base=['--no-first-run','--no-default-browser-check'];
const noAuto=['--enable-unsafe-swiftshader','--enable-automation'];
await run('④ 无窗口 + 单进程',{headless:true,channel:'msedge',args:[...base,'--single-process','--no-zygote','--js-flags=--max-old-space-size=192'],ignoreDefaultArgs:noAuto});
await run('⑤ 有窗口 + 关 GPU + 小窗',{headless:false,channel:'msedge',viewport:{width:880,height:680},
  args:[...base,'--window-size=880,680','--disable-gpu','--disable-software-rasterizer','--renderer-process-limit=1'],ignoreDefaultArgs:noAuto});
await run('⑥ 有窗口 + 单进程',{headless:false,channel:'msedge',viewport:{width:880,height:680},
  args:[...base,'--window-size=880,680','--single-process','--no-zygote','--js-flags=--max-old-space-size=192'],ignoreDefaultArgs:noAuto});
