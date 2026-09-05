import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const script=readFileSync('website/pricing-localize.js','utf8');
async function render(currency,monthly,yearly,fail=false){
 const dom=new JSDOM('<html lang="en"><body><div data-mv-saving><strong data-mv-price="Save {savingsPercent}%">Save 48%</strong><span data-mv-price="{annualSavings} saved vs {annualMonthly}">$23 saved vs $48</span></div></body></html>',{runScripts:'outside-only'});
 Object.defineProperty(dom.window.navigator,'languages',{value:[currency==='eur'?'lt-LT':currency==='gbp'?'en-GB':'en-US']});
 dom.window.fetch=()=>fail?Promise.reject(new Error('offline')):Promise.resolve({ok:true,json:async()=>({currency,plans:[{interval:'month',amount:monthly,formattedAmount:'monthly',currency},{interval:'year',amount:yearly,formattedAmount:'yearly',currency}]})});
 dom.window.eval(script);await new Promise(r=>setTimeout(r,0));return dom.window.document;
}
it('compares one year against twelve monthly payments',async()=>{const d=await render('usd',400,2500);expect(d.body.textContent).toBe('Save 48%$23 saved vs $48');});
it('calculates savings for the resolved currency',async()=>{const d=await render('eur',450,3000);expect(d.body.textContent).toBe('Save 44%€24 saved vs €54');});
it('hides savings when no discount exists or amounts are missing',async()=>{for(const year of [4800,undefined])expect((await render('usd',400,year)).querySelector('[data-mv-saving]').hidden).toBe(true);});
it('retains the matching USD fallback offline',async()=>{const d=await render(null,null,null,true);expect(d.body.textContent).toBe('Save 48%$23 saved vs $48');expect(d.querySelector('[data-mv-saving]').hidden).toBe(false);});
for (const [tags,expected,currency] of [
 [['en-US'],'$4 / $25 / 48%','usd'],
 [['en-GB'],'£3.50 / £21 / 50%','gbp'],
 [['lt-LT'],'€4 / €25 / 48%','eur'],
 [['en','de-DE'],'€4 / €25 / 48%','eur'],
 [['bad_tag','en-GB'],'£3.50 / £21 / 50%','gbp'],
 [['en'],'€4 / €25 / 48%','eur'],
 [['ja-JP'],'€4 / €25 / 48%','eur'],
]) it('uses browser regions '+tags.join(','),async()=>{
 const dom=new JSDOM('<html lang="en"><span data-mv-price="{monthly} / {yearly} / {savingsPercent}%"></span></html>',{runScripts:'outside-only'});
 Object.defineProperty(dom.window.navigator,'languages',{value:tags});
 Object.defineProperty(dom.window.navigator,'language',{value:tags[0]});
 let requested;dom.window.fetch=url=>{requested=url;return Promise.reject(new Error('offline'));};
 dom.window.eval(script);await new Promise(r=>setTimeout(r,0));
 expect(dom.window.document.body.textContent).toBe(expected);
 expect(requested).toBe('/api/billing/pricing');
});
it('uses billing country over browser language in automatic mode',async()=>{
 const dom=new JSDOM('<html lang="en"><span data-mv-price="{monthly}"></span></html>',{runScripts:'outside-only'});
 Object.defineProperty(dom.window.navigator,'languages',{value:['en-GB']});
 dom.window.fetch=async()=>({ok:true,json:async()=>({currency:'eur',plans:[{interval:'month',formattedAmount:'€4'},{interval:'year',formattedAmount:'€25'}]})});
 dom.window.eval(script);await new Promise(r=>setTimeout(r,0));expect(dom.window.document.body.textContent).toBe('€4');
});
it('keeps the initial fallback concealed until location pricing resolves',async()=>{
 const dom=new JSDOM('<html lang="en" class="mv-prices-pending"><main><span data-mv-price="{monthly}">$4</span></main></html>',{runScripts:'outside-only',url:'https://mailvaultapp.com/pricing.html'});
 Object.defineProperty(dom.window.navigator,'languages',{value:['en-GB']});
 let reply;dom.window.fetch=()=>new Promise(r=>{reply=r;});
 dom.window.eval(script);
 expect(dom.window.document.documentElement.classList.contains('mv-prices-pending')).toBe(true);
 reply({ok:true,json:async()=>({currency:'eur',plans:[{interval:'month',amount:400,formattedAmount:'€4'},{interval:'year',amount:2500,formattedAmount:'€25'}]})});
 await new Promise(r=>setTimeout(r,0));
 expect(dom.window.document.querySelector('[data-mv-price]').textContent).toBe('€4');
 expect(dom.window.document.documentElement.classList.contains('mv-prices-pending')).toBe(false);
 expect(dom.window.localStorage.getItem('mv-last-auto-currency')).toBe('eur');dom.window.close();
});
