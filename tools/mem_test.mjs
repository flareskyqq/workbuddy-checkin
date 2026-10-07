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
  const dir=fs.mkdtempSync('/tmp/mem-');
  let ctx;
  try{ ctx=await chromium.launchPersistentContext(dir,opts); }catch(e){ console.log(label,'❌',String(e.message).split('\n')[0]); return; }
  const page=ctx.pages()[0]||await ctx.newPage();
  await page.goto('https://www.workbuddy.cn/login/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  await page.waitForTimeout(7000);
  const s=[]; const mm=[]; let procs=0;
  for(let i=0;i<5;i++){await page.waitForTimeout(1000);const p=stat(dir);s.push(p.cpu);mm.push(p.mb);procs=p.n;}
  const qr=await page.evaluate(()=>({t:/微信扫码|扫码/.test(document.body.innerText),imgs:document.images.length})).catch(()=>({}));
  console.log(`${label}\n   CPU ${avg(s)}% | 内存 ${avg(mm)}MB | 进程 ${procs} | 页面扫码:${qr.t}`);
  await ctx.close();
}

const U='https://www.workbuddy.cn/login/';
await run('① 当前：Edge 有窗口 1280×900',{headless:false,channel:'msedge',viewport:null,args:['--no-first-run','--no-default-browser-check','--window-size=1280,900'],ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation']});
await run('② Edge 小窗口 + 省内存参数',{headless:false,channel:'msedge',viewport:{width:900,height:700},
  args:['--no-first-run','--no-default-browser-check','--window-size=900,700','--renderer-process-limit=2','--process-per-site',
        '--disable-site-isolation-trials','--disable-features=IsolateOrigins,site-per-process,Translate',
        '--js-flags=--max-old-space-size=256','--disable-background-networking'],
  ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation']});
await run('③ 无窗口（headless）',{headless:true,channel:'msedge',
  args:['--no-first-run','--renderer-process-limit=2','--process-per-site','--js-flags=--max-old-space-size=256'],
  ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation']});
