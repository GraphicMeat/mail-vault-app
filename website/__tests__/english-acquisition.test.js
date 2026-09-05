import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('website');
const source = readFileSync(resolve(root, 'assets/english-site.js'), 'utf8');
const sessions = [];
function page(file, search = '', fetch = vi.fn().mockRejectedValue(new Error('offline'))) {
  const dom = new JSDOM(readFileSync(resolve(root, file), 'utf8'), {url:'https://mailvaultapp.com/' + file + search, runScripts:'outside-only'});
  sessions.push(dom);
  const w = dom.window;
  w.matchMedia = () => ({matches:false});
  w.fetch = fetch;
  w.AbortSignal.timeout = () => undefined;
  w.navigator.sendBeacon = vi.fn();
  w.eval(source);
  return {w, doc:w.document, fetch};
}
afterEach(() => { sessions.splice(0).forEach(d => d.window.close()); });
const tick = () => new Promise(r => setTimeout(r, 0));

describe('English acquisition journey', () => {
  it('carries both billing choices to setup with matching price and trial copy', () => {
    const {w,doc} = page('pricing.html');
    const cta = doc.querySelector('[data-premium-cta]');
    expect(cta.href).toContain('?plan=yearly');
    const monthly = doc.querySelector('input[value="monthly"]');
    monthly.checked = true;
    monthly.dispatchEvent(new w.Event('change'));
    expect(cta.href).toContain('?plan=monthly');
    expect(doc.querySelector('[data-billing-panel="yearly"]').hidden).toBe(true);
    expect(doc.querySelector('[data-billing-panel="monthly"]').hidden).toBe(false);
    const yearly = doc.querySelector('input[value="yearly"]');
    yearly.checked = true;
    yearly.dispatchEvent(new w.Event('change'));
    expect(cta.href).toContain('?plan=yearly');
  });
  it.each(['free','monthly','yearly'])('retains %s instructions after navigation and reload', plan => {
    for (let i=0;i<2;i++) {
      const {doc} = page('get-started.html','?plan='+plan);
      for (const el of doc.querySelectorAll('[data-plan-copy]')) expect(el.hidden).toBe(el.dataset.planCopy !== plan);
    }
  });
  it('does not treat arbitrary URL values as plan names or markup', () => {
    const {doc} = page('get-started.html','?plan=%3Cimg%20src=x%3E');
    expect(doc.querySelector('[data-plan-copy="free"]').hidden).toBe(false);
    expect(doc.querySelectorAll('img[src="x"]')).toHaveLength(0);
  });
  it('keeps usable release links when GitHub is unavailable', async () => {
    const {doc} = page('get-started.html');
    await tick();
    expect(doc.querySelector('[data-download="mac"]').href).toBe('https://github.com/GraphicMeat/mail-vault-app/releases/latest');
    expect(doc.querySelector('[data-download-status]').textContent).toContain('could not load');
  });
  it('resolves desktop assets and counts only actual download actions', async () => {
    const base='https://github.com/GraphicMeat/mail-vault-app/releases/download/v2.11.3/';
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({tag_name:'v2.11.3',assets:['MailVault.dmg','MailVault_amd64.deb','MailVault_arm64.deb'].map(name=>({name,browser_download_url:base+name}))})});
    const {w,doc}=page('get-started.html','?plan=yearly',fetch);
    await tick();
    expect(doc.querySelector('[data-download="mac"]').href).toBe(base+'MailVault.dmg');
    expect(w.navigator.sendBeacon).not.toHaveBeenCalled();
    const link=doc.querySelector('[data-download="mac"]');
    link.addEventListener('click',e=>e.preventDefault());
    link.click();
    expect(w.navigator.sendBeacon).toHaveBeenCalledExactlyOnceWith('/api/metrics/e','download_click');
  });
  it('rejects an unexpected release download destination', async()=>{
    const {doc}=page('get-started.html','',vi.fn().mockResolvedValue({ok:true,json:async()=>({assets:[{name:'app.dmg',browser_download_url:'https://untrusted.example/app.dmg'}]})}));
    await tick();
    expect(doc.querySelector('[data-download="mac"]').href).toMatch(/releases\/latest$/);
  });
  it('reports signup failure honestly, reenables retry, and preserves the address', async()=>{
    const {w,doc}=page('index.html','',vi.fn().mockResolvedValue({ok:false,status:503}));
    const form=doc.querySelector('[data-subscribe]');
    form.elements.email.value='review@example.com';
    form.dispatchEvent(new w.Event('submit',{cancelable:true}));
    expect(form.querySelector('button').disabled).toBe(true);
    await tick();
    expect(form.querySelector('button').disabled).toBe(false);
    expect(form.elements.email.value).toBe('review@example.com');
    expect(form.querySelector('[role="status"]').textContent).toContain('could not save');
  });
  it('keeps every local link, anchor, stylesheet, script, and screenshot resolvable',()=>{
    for(const file of ['index.html','pricing.html','get-started.html']) {
      const {doc}=page(file);
      const ids=Array.from(doc.querySelectorAll('[id]'),e=>e.id);
      expect(new Set(ids).size).toBe(ids.length);
      for(const el of doc.querySelectorAll('[href],[src]')) {
        const value=el.getAttribute('href') || el.getAttribute('src');
        if(/^(https?:|mailto:)/.test(value)) continue;
        const url=new URL(value,'https://mailvaultapp.com/'+file);
        if(url.pathname==='/gm.js') continue;
        const path=resolve(root,'.'+(url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname));
        expect(existsSync(path), `${file}: ${value}`).toBe(true);
        if(url.hash) {
          const target=new JSDOM(readFileSync(path,'utf8'));
          expect(target.window.document.getElementById(url.hash.slice(1)), `${file}: ${value}`).not.toBeNull();
          target.window.close();
        }
      }
      for(const image of doc.querySelectorAll('img[srcset]')) {
        for(const entry of image.srcset.split(',')) expect(existsSync(resolve(root,'.'+entry.trim().split(/\s+/)[0]))).toBe(true);
      }
    }
  });
});
