import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';
const root=resolve('website');
// `/demo/` is a Vite application entry, so it intentionally does not carry
// the static marketing shell audited by this suite.
function files(dir) { return readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()&&!['node_modules','api','i18n','demo'].includes(e.name)?files(resolve(dir,e.name)):e.isFile()&&e.name.endsWith('.html')?[resolve(dir,e.name)]:[]); }
const english=files(root).filter(p=>/<html[^>]*lang="en"/.test(readFileSync(p,'utf8'))&&!p.includes('/oauth/'));
describe('English visual rollout',()=>{
 it('has one shared shell, a main landmark and matching language links on every page',()=>{
  for(const p of english){
   const d=new JSDOM(readFileSync(p,'utf8')).window.document;
   expect(d.querySelectorAll('.mv-header').length,p).toBe(1);
   expect(d.querySelectorAll('main').length,p).toBe(1);
   expect(d.querySelectorAll('.mv-studio').length,p).toBe(1);
   expect(d.querySelector('#main'),p).not.toBeNull();
   const locale=d.querySelector('.mv-language a[hreflang="de"]');
   const alternate=d.querySelector('link[hreflang="de"]');
   if(alternate) expect(locale.getAttribute('href'),p).toBe(new URL(alternate.href).pathname);
   for(const script of d.querySelectorAll('script:not([src]):not([type="application/ld+json"])')) new Script(script.textContent,{filename:p});
  }
 });
 it('keeps local stylesheet and script dependencies resolvable',()=>{
  for(const p of english){
   const d=new JSDOM(readFileSync(p,'utf8')).window.document;
   for(const el of d.querySelectorAll('link[rel="stylesheet"][href],script[src]')){
    const src=el.getAttribute('src')||el.getAttribute('href');
    if(/^(https?:|\/\/)/.test(src)||src.startsWith('/gm.js'))continue;
    const path=src.split('?')[0];
    expect(existsSync(path.startsWith('/')?resolve(root,'.'+path):resolve(dirname(p),path)),p+': '+src).toBe(true);
   }
  }
 });
 it('keeps reports accessible without exposing personal email addresses',()=>{
  const d=new JSDOM(readFileSync(resolve(root,'index.html'),'utf8')).window.document;
  expect(d.querySelectorAll('.mv-case-detail').length).toBe(2);
  expect(d.querySelectorAll('.mv-feedback-action').length).toBe(2);
  expect(d.querySelector('#feedback').textContent).not.toMatch(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/i);
  for(const img of d.querySelectorAll('.mv-product-icon'))expect(img.src).toMatch(/^https:\/\/graphicmeat.com\/assets\//);
 });
});
