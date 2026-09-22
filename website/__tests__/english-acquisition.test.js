import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('website');
const source = readFileSync(resolve(root, 'assets/english-site.js'), 'utf8');
const sessions = [];
function page(file, search = '', fetch = vi.fn().mockRejectedValue(new Error('offline')), { userAgent, gm, hostname = 'mailvaultapp.com', path = file, markup } = {}) {
  const dom = new JSDOM(markup || readFileSync(resolve(root, file), 'utf8'), {url:'https://' + hostname + '/' + path + search, runScripts:'outside-only'});
  sessions.push(dom);
  const w = dom.window;
  if (userAgent) Object.defineProperty(w.navigator, 'userAgent', { configurable:true, value:userAgent });
  w.matchMedia = () => ({matches:false});
  w.fetch = fetch;
  w.gm = gm;
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
  it('keeps billing handoff in the visitor’s localized path', () => {
    const {w,doc} = page('pricing.html', '', undefined, {path:'de/pricing.html'});
    const monthly = doc.querySelector('input[value="monthly"]');
    monthly.checked = true;
    monthly.dispatchEvent(new w.Event('change'));
    expect(doc.querySelector('[data-premium-cta]').pathname).toBe('/de/get-started.html');
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
  it('emits the initial setup view once after deferred tracker readiness', () => {
    const gm = vi.fn();
    const {w} = page('get-started.html', '?plan=yearly', undefined, {gm});
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    expect(gm.mock.calls.filter(([name]) => name === 'setup_view')).toEqual([['setup_view', {page_version:'homepage-en-20260922',plan:'yearly'}]]);
  });
  it('keeps usable release links when GitHub is unavailable', async () => {
    const {doc} = page('get-started.html');
    await tick();
    expect(doc.querySelector('[data-download="mac"]').href).toBe('https://github.com/GraphicMeat/mail-vault-app/releases/latest');
    expect(doc.querySelector('[data-download-status]').textContent).toContain('could not load');
  });
  it.each([
    ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'mac'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'fallback'],
    ['unknown desktop', 'Mozilla/5.0 (ExampleOS)', 'fallback'],
    ['mobile', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 'fallback'],
  ])('uses %s hero action for %s', (_name, userAgent, visible) => {
    const {doc} = page('index.html', '', undefined, {userAgent});
    for (const action of ['mac','linux','fallback']) expect(doc.querySelector('[data-hero-platform="'+action+'"]').hidden).toBe(action !== visible);
    expect(doc.querySelector('a[href="/get-started.html?plan=free#platforms"]')).not.toBeNull();
  });
  it('resolves the macOS homepage action with the shared release resolver', async () => {
    const base='https://github.com/GraphicMeat/mail-vault-app/releases/download/v2.11.3/';
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({tag_name:'v2.11.3',assets:['MailVault.dmg','MailVault_amd64.deb','MailVault_arm64.deb'].map(name=>({name,browser_download_url:base+name}))})});
    const {doc}=page('index.html','',fetch,{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'});
    await tick();
    expect(doc.querySelector('[data-hero-platform="mac"]').href).toBe(base+'MailVault.dmg');
  });
  it('keeps the macOS homepage fallback safe without release data or a tracker', async () => {
    const {doc}=page('index.html','',vi.fn().mockRejectedValue(new Error('offline')),{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'});
    await tick();
    const link=doc.querySelector('[data-hero-platform="mac"]');
    expect(link.href).toMatch(/releases\/latest$/);
    link.addEventListener('click',e=>e.preventDefault());
    expect(() => link.click()).not.toThrow();
  });
  it('queues production acquisition events until the tracker loads, without queuing locally', () => {
    const {w,doc} = page('index.html');
    const link = doc.querySelector('[data-acquisition-destination="demo"]');
    link.addEventListener('click', e => e.preventDefault());
    link.click();
    expect(w.gm.q).toEqual([['home_cta', {page_version:'homepage-en-20260922',placement:'hero',destination:'demo'}]]);
    const tracker = vi.fn();
    w.gm.q.forEach(args => tracker(...args));
    expect(tracker).toHaveBeenCalledExactlyOnceWith('home_cta', {page_version:'homepage-en-20260922',placement:'hero',destination:'demo'});

    const local = page('index.html', '', undefined, {hostname:'127.0.0.1'});
    const localLink = local.doc.querySelector('[data-acquisition-destination="demo"]');
    localLink.addEventListener('click', e => e.preventDefault());
    localLink.click();
    expect(local.w.gm).toBeUndefined();
  });
  it('resolves desktop assets and counts only actual download actions', async () => {
    const base='https://github.com/GraphicMeat/mail-vault-app/releases/download/v2.11.3/';
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({tag_name:'v2.11.3',assets:['MailVault.dmg','MailVault_amd64.deb','MailVault_arm64.deb'].map(name=>({name,browser_download_url:base+name}))})});
    const gm=vi.fn();
    const {w,doc}=page('get-started.html','?plan=yearly',fetch,{gm});
    await tick();
    expect(doc.querySelector('[data-download="mac"]').href).toBe(base+'MailVault.dmg');
    expect(w.navigator.sendBeacon).not.toHaveBeenCalled();
    const link=doc.querySelector('[data-download="mac"]');
    link.addEventListener('click',e=>e.preventDefault());
    link.click();
    expect(w.navigator.sendBeacon).toHaveBeenCalledExactlyOnceWith('/api/metrics/e','download_click');
    expect(gm).toHaveBeenLastCalledWith('download_action', {page_version:'homepage-en-20260922',platform:'mac',destination:'file'});
    expect(gm.mock.calls.filter(([name]) => name === 'download_action')).toHaveLength(1);
  });
  it('rejects an unexpected release download destination', async()=>{
    const gm=vi.fn();
    const {doc}=page('get-started.html','',vi.fn().mockResolvedValue({ok:true,json:async()=>({assets:[{name:'app.dmg',browser_download_url:'https://untrusted.example/app.dmg'}]})}),{gm});
    await tick();
    const link=doc.querySelector('[data-download="mac"]');
    expect(link.href).toMatch(/releases\/latest$/);
    link.addEventListener('click',e=>e.preventDefault());
    link.click();
    expect(gm).toHaveBeenLastCalledWith('download_action', {page_version:'homepage-en-20260922',platform:'mac',destination:'fallback'});
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
  it('uses localized newsletter runtime status text', async()=>{
    const markup = readFileSync(resolve(root, 'index.html'), 'utf8')
      .replace('<html lang="en"', '<html lang="de"')
      .replace('"newsletterSaveError":"We could not save your email. Please try again in a moment."', '"newsletterSaveError":"Die E-Mail-Adresse konnte nicht gespeichert werden."');
    const {w,doc}=page('index.html','',vi.fn().mockResolvedValue({ok:false,status:503}),{markup});
    const form=doc.querySelector('[data-subscribe]');
    form.elements.email.value='review@example.com';
    form.dispatchEvent(new w.Event('submit',{cancelable:true}));
    await tick();
    expect(form.querySelector('[role="status"]').textContent).toBe('Die E-Mail-Adresse konnte nicht gespeichert werden.');
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
        // `/demo/` is the gitignored `npm run build:demo` bundle; CI unit runs never build it.
        if(url.pathname==='/gm.js' || url.pathname.startsWith('/demo/')) continue;
        const path=resolve(root,'.'+(url.pathname.endsWith('/')?url.pathname+'index.html':url.pathname));
        expect(existsSync(path), `${file}: ${value}`).toBe(true);
        if(url.hash) {
          const target=new JSDOM(readFileSync(path,'utf8'));
          expect(target.window.document.getElementById(url.hash.slice(1)), `${file}: ${value}`).not.toBeNull();
          target.window.close();
        }
      }
      for(const image of doc.querySelectorAll('img[srcset]')) {
        for(const entry of image.srcset.split(',')) {
          const src=entry.trim().split(/\s+/)[0];
          if(!src.startsWith('/demo/')) expect(existsSync(resolve(root,'.'+src)), `${file}: ${src}`).toBe(true);
        }
      }
    }
  });
});
