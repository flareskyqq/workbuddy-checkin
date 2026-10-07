import { chromium } from 'playwright-core';
import fs from 'node:fs';
const dir=fs.mkdtempSync('/tmp/qr-');
const ctx=await chromium.launchPersistentContext(dir,{headless:true,channel:'msedge',viewport:{width:1000,height:800},
  args:['--no-first-run'],ignoreDefaultArgs:['--enable-unsafe-swiftshader','--enable-automation']});
const page=ctx.pages()[0]||await ctx.newPage();
await page.goto('https://www.workbuddy.cn/login/',{waitUntil:'domcontentloaded',timeout:60000});
await page.waitForTimeout(6000);
await page.evaluate(()=>{const el=[...document.querySelectorAll('button,a,div,span')].find(e=>/^同意$/.test((e.textContent||'').trim()));if(el)el.click();});
await page.waitForTimeout(8000);
const info = await page.evaluate(()=>{
  const out=[];
  document.querySelectorAll('img,canvas,iframe,svg').forEach(el=>{
    const r=el.getBoundingClientRect();
    if(r.width>80 && r.height>80) out.push({tag:el.tagName, w:Math.round(r.width), h:Math.round(r.height),
      src:(el.src||'').slice(0,60), cls:String(el.className).slice(0,40), id:el.id});
  });
  return out;
});
console.log('大尺寸元素：'); info.forEach(i=>console.log('  ', JSON.stringify(i)));
// 找包含“扫码”字样的容器
const box = await page.evaluate(()=>{
  const el=[...document.querySelectorAll('div,section')].find(e=>/微信扫码|请使用微信/.test(e.textContent||'') && e.querySelector('img,canvas'));
  if(!el) return null;
  const r=el.getBoundingClientRect();
  return {w:Math.round(r.width),h:Math.round(r.height),cls:String(el.className).slice(0,50)};
});
console.log('扫码容器:', JSON.stringify(box));
// 截图整个登录卡片
await page.screenshot({path:'/tmp/qr_page.png'});
console.log('整页截图已存 /tmp/qr_page.png');
await ctx.close();
