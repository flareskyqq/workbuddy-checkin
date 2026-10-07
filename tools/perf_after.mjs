import { chromium } from 'playwright-core';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
const TRACKERS = ['doubleclick.net','googletagmanager.com','google-analytics.com','googlesyndication.com','galileotelemetry.tencent.com','ping.cloud.tencent.com','hm.baidu.com'];
function cpu(dir){const out=execSync('ps -A -o %cpu,command',{encoding:'utf8',maxBuffer:8*1024*1024});let t=0;for(const l of out.split('\n'))if(l.includes(dir)){const m=l.trim().match(/^([\d.]+)/);if(m)t+=parseFloat(m[1]);}return Math.round(t*10)/10;}
const avg=(a)=>Math.round(a.reduce((x,y)=>x+y,0)/a.length*10)/10;
const dir=fs.mkdtempSync('/tmp/perfafter-');
const ctx=await chromium.launchPersistentContext(dir,{headless:false,channel:'chrome',viewport:null,args:['--no-first-run','--no-default-browser-check','--window-position=-3000,-3000']});
for(const h of TRACKERS) await ctx.route(`**://*.${h}/**`,r=>r.abort()).catch(()=>{});
const page=ctx.pages()[0]||await ctx.newPage();
await page.goto('https://www.workbuddy.cn/',{waitUntil:'domcontentloaded'});
await page.waitForTimeout(10000);
const s=[];for(let i=0;i<6;i++){await page.waitForTimeout(1000);s.push(cpu(dir));}
const st=await page.evaluate(()=>({n:performance.getEntriesByType('resource').length}));
console.log(`屏蔽埋点+系统Chrome 后空闲CPU: ${avg(s)}%   [${s.join(', ')}]  请求数 ${st.n}`);
const errs=await page.evaluate(()=>document.body?document.body.innerText.slice(0,120):'(空)');
console.log('页面是否正常渲染:', errs.replace(/\s+/g,' ').slice(0,80)||'(首屏文案为空)');
await ctx.close();
