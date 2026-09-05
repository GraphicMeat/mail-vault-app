import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup(ok) {
 const dom = new JSDOM(readFileSync('website/index.html','utf8'), {url:'https://mailvaultapp.com',runScripts:'outside-only'});
 let posts=0;
 dom.window.fetch=async (url,options) => {
  if(options?.method==='POST') posts++;
  return {ok:options?.method==='POST'?ok:true,json:async()=>url.includes('github.com')?{stargazers_count:123}:{count:options?.method==='POST'?43:42}};
 };
 dom.window.eval(readFileSync('website/assets/community-support.js','utf8'));
 await settle();
 return {dom,posts:()=>posts,button:dom.window.document.getElementById('want-this-btn')};
}
it('loads real counts and submits a heart only once',async()=>{
 const {dom,button,posts}=await setup(true);
 expect(dom.window.document.getElementById('github-stars').textContent).toBe('123');
 button.click();await settle();button.click();await settle();
 expect(posts()).toBe(1);
 expect(dom.window.localStorage.getItem('mailvault-voted')).toBe('true');
 expect(button.getAttribute('aria-pressed')).toBe('true');
 dom.window.close();
});
it('does not record failed votes and allows retry',async()=>{
 const {dom,button,posts}=await setup(false);
 button.click();await settle();
 expect(dom.window.localStorage.getItem('mailvault-voted')).toBeNull();
 expect(button.disabled).toBe(false);
 expect(dom.window.document.getElementById('vote-status').textContent).toContain('try again');
 button.click();await settle();expect(posts()).toBe(2);
 dom.window.close();
});
