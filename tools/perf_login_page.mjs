import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
function cpu(dir){const out=execSync('ps -A -o %cpu,command',{encoding:'utf8',maxBuffer:8*1024*1024});let t=0;for(const l of out.split('\n'))if(l.includes(dir)){const m=l.trim().match(/^([\d.]+)/);if(m)t+=parseFloat(m[1]);}return Math.round(t*10)/10;}
const avg=(a)=>Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10;
const dir=fs.mkdtempSync('/tmp/perflogin-');
const ctx=await chromium.launchPersistentContext(dir,{headless:false,channel:'chrome',viewport:null,args:['--no-first-run','--no-default-browser-check','--window-position=-3000,-3000']});
const page=ctx.pages()[0]||await ctx.newPage();

// 1) 先看官网首页里“登录”按钮指向哪
await page.goto('https://www.workbuddy.cn/',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(4000);
const links = await page.evaluate(() => [...document.querySelectorAll('a')].map(a=>({t:(a.textContent||'').trim(), h:a.href}))
  .filter(x=>/登录|login|signin|sign/i.test(x.t+x.h)).slice(0,6));
console.log('登录相关链接:', JSON.stringify(links, null, 1));

// 2) 依次测几个候选地址的 CPU
for (const url of ['https://www.workbuddy.cn/login','https://www.workbuddy.cn/user/login','https://www.workbuddy.cn/passport/login']) {
  try {
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
    await page.waitForTimeout(7000);
    const s=[];for(let i=0;i<5;i++){await page.waitForTimeout(1000);s.push(cpu(dir));}
    const info=await page.evaluate(()=>({n:performance.getEntriesByType('resource').length,url:location.href,
      txt:(document.body.innerText||'').replace(/\s+/g,' ').slice(0,60)}));
    console.log(`${url}\n   → 实际 ${info.url}\n   空闲CPU ${avg(s)}%  请求${info.n}  首屏: ${info.txt}`);
  } catch(e){ console.log(url,'失败', e.message.split('\n')[0]); }
}
await ctx.close();
