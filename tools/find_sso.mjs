import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
function cpu(dir){const out=execSync('ps -A -o %cpu,command',{encoding:'utf8',maxBuffer:8*1024*1024});let t=0;for(const l of out.split('\n'))if(l.includes(dir)){const m=l.trim().match(/^([\d.]+)/);if(m)t+=parseFloat(m[1]);}return Math.round(t*10)/10;}
const avg=(a)=>Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10;
const dir=fs.mkdtempSync('/tmp/ssoprof-');
const ctx=await chromium.launchPersistentContext(dir,{headless:false,channel:'chrome',viewport:null,
  args:['--no-first-run','--no-default-browser-check','--disable-infobars','--window-position=-3000,-3000'],
  ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation']});
const page=ctx.pages()[0]||await ctx.newPage();
await page.goto('https://www.workbuddy.cn/login/',{waitUntil:'domcontentloaded',timeout:60000}).catch(()=>{});
await page.waitForTimeout(7000);
console.log('初始页面:', page.url());
// 找登录按钮
const btns = await page.evaluate(()=>[...document.querySelectorAll('button,a')].map(e=>({t:(e.textContent||'').trim(),c:e.className})).filter(x=>/登录|立即登录|扫码/.test(x.t)).slice(0,5));
console.log('候选按钮:', JSON.stringify(btns));
for (const sel of ['button:has-text("登录")','a:has-text("登录")','text=立即登录']) {
  try { await page.click(sel,{timeout:3000}); console.log('点击了:', sel); break; } catch {}
}
await page.waitForTimeout(9000);
console.log('跳转后页面:', page.url());
const s=[]; for(let i=0;i<5;i++){await page.waitForTimeout(1000);s.push(cpu(dir));}
const n=await page.evaluate(()=>performance.getEntriesByType('resource').length).catch(()=>-1);
console.log(`该页面空闲CPU: ${avg(s)}%  [${s.join(', ')}]  请求数 ${n}`);
await ctx.close();
