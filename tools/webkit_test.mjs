import { chromium, webkit } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
function proc(dir){
  const out=execSync('ps -A -o %cpu,rss,command',{encoding:'utf8',maxBuffer:8*1024*1024});
  let cpu=0,mem=0,n=0;
  for(const l of out.split('\n')){
    if(!l.includes(dir)) continue;
    const m=l.trim().match(/^([\d.]+)\s+(\d+)/); if(!m) continue;
    cpu+=parseFloat(m[1]); mem+=parseInt(m[2]); n++;
  }
  return {cpu:Math.round(cpu*10)/10, memMB:Math.round(mem/1024), n};
}
const avg=(a)=>Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10;
const URL='https://www.workbuddy.cn/login/';

async function run(label, type, opts){
  const dir=fs.mkdtempSync('/tmp/wk-');
  let ctx;
  try {
    ctx = await type.launchPersistentContext(dir, { ...opts, viewport:{width:1200,height:860} });
  } catch(e) { console.log(`${label}\n  ❌ 启动失败: ${String(e.message).split('\n')[0]}\n`); return; }
  const page=ctx.pages()[0]||await ctx.newPage();
  const t0=Date.now();
  await page.goto(URL,{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
  const dom=Date.now()-t0;
  await page.waitForTimeout(8000);
  const info=await page.evaluate(()=>({url:location.href,n:performance.getEntriesByType('resource').length,
    txt:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,40)})).catch(()=>({}));
  const s=[]; const mm=[];
  for(let i=0;i<6;i++){await page.waitForTimeout(1000);const p=proc(dir);s.push(p.cpu);mm.push(p.memMB);}
  const qr = await page.evaluate(()=>({imgs:document.images.length, canvases:document.querySelectorAll('canvas').length,
    hasQR:/扫码|二维码|微信/.test(document.body.innerText)})).catch(()=>({}));
  console.log(`${label}`);
  console.log(`   URL ${info.url}`);
  console.log(`   DOM ${dom}ms | 请求 ${info.n} | 文本 "${info.txt}"`);
  console.log(`   CPU ${avg(s)}% | 内存 ${avg(mm)}MB | 页面元素: 图${qr.imgs} canvas${qr.canvases} 有扫码文案:${qr.hasQR}`);
  await page.screenshot({path:`/tmp/wk-${label.slice(0,2)}.png`}).catch(()=>{});
  await ctx.close();
  console.log('');
}

await run('① Edge (Chromium)', chromium, { headless:false, channel:'msedge', viewport:null,
  args:['--no-first-run','--no-default-browser-check','--window-size=1200,860'], ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation'] });
await run('② WebKit (Safari 内核)', webkit, { headless:false });
