import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('website');
const source = readFileSync(resolve(root, 'assets/english-site.js'), 'utf8');
const sessions = [];
function page(file, search = '', fetch = vi.fn().mockRejectedValue(new Error('offline')), { userAgent, gm, hostname = 'mailvaultapp.com', path = file, markup, touchPoints } = {}) {
  const dom = new JSDOM(markup || readFileSync(resolve(root, file), 'utf8'), {url:'https://' + hostname + '/' + path + search, runScripts:'outside-only'});
  sessions.push(dom);
  const w = dom.window;
  if (userAgent) Object.defineProperty(w.navigator, 'userAgent', { configurable:true, value:userAgent });
  if (touchPoints !== undefined) Object.defineProperty(w.navigator, 'maxTouchPoints', { configurable:true, value:touchPoints });
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
    expect(gm.mock.calls.filter(([name]) => name === 'setup_view')).toEqual([['setup_view', {page_version:'homepage-en-20261002',plan:'yearly'}]]);
  });
  it('keeps usable release links when GitHub is unavailable', async () => {
    const {doc} = page('thank-you.html', '?platform=mac');
    await tick();
    expect(doc.querySelector('[data-download="mac"]').href).toBe('https://github.com/GraphicMeat/mail-vault-app/releases/latest');
    expect(doc.querySelector('[data-download-status]').textContent).toContain('could not start');
  });
  it.each([
    ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'mac'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['unknown desktop', 'Mozilla/5.0 (ExampleOS)', 'mac'],
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 'mobile'],
    ['Android phone', 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36', 'mobile'],
    ['Android tablet', 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'mobile'],
  ])('uses %s hero action for %s', (_name, userAgent, visible) => {
    const {doc} = page('index.html', '', undefined, {userAgent});
    for (const action of ['mac','windows','linux']) expect(doc.querySelector('.hm-hero-actions [data-hero-platform="'+action+'"]').hidden).toBe(action !== visible);
    // One primary: a computer gets its own download, a phone the open email-me form.
    expect([...doc.querySelectorAll('.hm-hero-actions .mv-button:not(.mv-secondary)')].filter(el => !el.hidden && !el.closest('[hidden]'))).toHaveLength(1);
    expect(doc.getElementById('send-link-hero').hidden).toBe(visible !== 'mobile');
    expect(doc.querySelector('.hm-hero [data-send-link-open]').hidden).toBe(visible === 'mobile');
    expect(doc.querySelector('.hm-hero [data-hero-platform="fallback"]')).toBeNull();
    expect(doc.querySelector('a[href="/get-started.html?plan=free#platforms"]')).not.toBeNull();
    // The closing section makes the same choice: one button, from the same code.
    for (const action of ['mac','windows','linux']) expect(doc.querySelector('#download [data-hero-platform="'+action+'"]').hidden).toBe(action !== visible);
    const shown = sel => [...doc.querySelectorAll(sel + ' .mv-button')].filter(el => !el.closest('[hidden]'));
    expect(shown('.hm-hero-side')).toHaveLength(1);
    expect(shown('#download')).toHaveLength(1);
    expect(doc.getElementById('send-link-final').hidden).toBe(visible !== 'mobile');
    expect(doc.querySelector('#download [data-hero-platform="fallback"]')).toBeNull();
  });
  it.each([
    ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'mac'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64)', 'linux'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['unknown desktop', 'Mozilla/5.0 (ExampleOS)', 'mac'],
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)', 'mobile'],
  ])('gives a feature page one download for %s', (_name, userAgent, visible) => {
    const gm = vi.fn();
    const {doc} = page('features/search.html', '', undefined, {userAgent, gm});
    const shown = [...doc.querySelectorAll('main .mv-button')].filter(el => !el.closest('[hidden]'));
    expect(shown).toHaveLength(1);
    expect(shown[0].dataset.heroPlatform).toBe(visible);
    expect(doc.querySelector('main a.mv-text-link[href="/get-started.html?plan=free#platforms"]').hidden).toBe(false);
    // Not a homepage CTA: the click is counted by where it goes, the download on the thank-you page.
    shown[0].addEventListener('click', e => e.preventDefault());
    shown[0].click();
    const target = {mac:'/thank-you.html', windows:'/thank-you.html', linux:'/thank-you.html', mobile:'/get-started.html'}[visible];
    expect(gm.mock.calls).toEqual([['cta_click', {page_version:'homepage-en-20261002', target, placement:'page'}]]);
  });
  it('treats an iPad that reports a Mac user agent as a tablet, and a Mac as a Mac', () => {
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    const ipad = page('index.html', '', undefined, {userAgent:ua, touchPoints:5}).doc;
    expect(ipad.getElementById('send-link-hero').hidden).toBe(false);
    expect(ipad.querySelector('.hm-hero-actions [data-hero-platform="mac"]').hidden).toBe(true);
    const mac = page('index.html', '', undefined, {userAgent:ua, touchPoints:0}).doc;
    expect(mac.getElementById('send-link-hero').hidden).toBe(true);
    expect(mac.querySelector('.hm-hero-actions [data-hero-platform="mac"]').hidden).toBe(false);
  });
  it('gives desktop visitors the email-me-the-link offer only as quiet links, one per section, and keeps it off other pages', () => {
    const desktop = page('index.html', '', undefined, {userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}).doc;
    for (const el of desktop.querySelectorAll('[data-hero-platform="mobile"], [data-send-link], [data-send-link-done]')) expect(el.hidden).toBe(true);
    const quiet = [...desktop.querySelectorAll('[data-send-link-open]')].filter(el => !el.hidden);
    expect(quiet.map(el => el.getAttribute('aria-controls'))).toEqual(['send-link-hero', 'send-link-final']);
    for (const el of quiet) {
      expect(el.classList.contains('mv-text-link')).toBe(true);
      expect(el.classList.contains('mv-button')).toBe(false);
    }
    // The setup page has no such offer, so a phone still gets its fallback there.
    const setup = page('get-started.html', '', undefined, {userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'}).doc;
    expect(setup.querySelector('[data-hero-platform="fallback"]').hidden).toBe(false);
  });
  it('puts the visitor’s own platform first on the download page, Windows included', () => {
    const {doc,fetch}=page('get-started.html','',undefined,{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'});
    expect(doc.querySelector('.mv-download-options > article').dataset.platform).toBe('windows');
    expect(doc.querySelector('[data-hero-platform="windows"]').hidden).toBe(false);
    for (const link of doc.querySelectorAll('[data-download="windows"]')) expect(link.getAttribute('href')).toBe('/thank-you.html?platform=windows&start=1');
    // Nothing on this page downloads a file itself any more, so it does not ask GitHub.
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/releases/'))).toEqual([]);
    expect(doc.body.textContent).not.toContain('Windows is planned');
  });
  it.each([
    ['index.html', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'mac'],
    ['index.html', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'windows'],
    ['index.html', 'Mozilla/5.0 (X11; Linux x86_64)', 'amd64'],
    ['index.html', 'Mozilla/5.0 (X11; Linux aarch64)', 'arm64'],
    ['features.html', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)', 'mac'],
  ])('%s: the bar’s Download and the hero both lead a %s visitor to the %s thank-you page', (file, userAgent, platform) => {
    for (const prefix of ['', '/de']) {
      const {doc}=page(file,'',undefined,{userAgent,path:prefix.slice(1)+(prefix?'/':'')+file});
      const want=prefix+'/thank-you.html?platform='+platform+'&start=1';
      const bar=[...doc.querySelectorAll('.mv-navtools > a.mv-button:not(.mv-secondary), .mv-mobile-menu nav a[data-download]')];
      expect(bar).toHaveLength(2);
      for (const link of bar) expect(link.getAttribute('href')).toBe(want);
      for (const link of doc.querySelectorAll('[data-hero-platform]:not([hidden]):not([data-hero-platform="fallback"])[data-download]')) expect(link.getAttribute('href')).toBe(want);
    }
  });
  it('leaves the bar’s Download on the setup page when the platform is unknown', () => {
    const {doc}=page('index.html','',undefined,{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)'});
    expect(doc.querySelector('.mv-navtools > a.mv-button:not(.mv-secondary)').getAttribute('href')).toBe('/get-started.html?plan=free');
  });
  it('starts the installer on the thank-you page and shows only that platform’s steps', async () => {
    const base='https://github.com/GraphicMeat/mail-vault-app/releases/download/v2.16.0/';
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({tag_name:'v2.16.0',assets:['MailVault-v2.16.0.dmg','MailVault_2.16.0_x64-setup.exe','MailVault_2.16.0_amd64.deb','MailVault_2.16.0_arm64.deb'].map(name=>({name,browser_download_url:base+name}))})});
    for (const [platform, file, steps] of [['mac','MailVault-v2.16.0.dmg','mac'],['windows','MailVault_2.16.0_x64-setup.exe','windows'],['arm64','MailVault_2.16.0_arm64.deb','linux']]) {
      const markup=readFileSync(resolve(root,'thank-you.html'),'utf8');
      const {w,doc}=page('thank-you.html','?platform='+platform+'&start=1',fetch,{markup});
      const button=doc.querySelector('[data-auto-download]');
      const clicked=[];
      button.addEventListener('click',e=>{ e.preventDefault(); clicked.push(button.href); });
      await tick(); await tick();
      expect(clicked).toEqual([base+file]);
      // A reload keeps the steps but does not download again.
      expect(w.location.search).toBe('?platform='+platform);
      expect([...doc.querySelectorAll('[data-install]')].filter(el=>!el.hidden).map(el=>el.dataset.install)).toEqual([steps]);
    }
  });
  it('shows every platform’s steps and downloads nothing for an unknown platform', async () => {
    const markup=readFileSync(resolve(root,'thank-you.html'),'utf8');
    const {doc,fetch}=page('thank-you.html','?platform=%3Cimg%20src%3Dx%3E&start=1',undefined,{markup});
    await tick();
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/releases/'))).toEqual([]);
    expect(doc.querySelector('[data-auto-download]').href).toBe('https://github.com/GraphicMeat/mail-vault-app/releases/latest');
    expect([...doc.querySelectorAll('[data-install]')].filter(el=>!el.hidden)).toHaveLength(3);
    expect(doc.querySelectorAll('img[src="x"]')).toHaveLength(0);
  });
  it('starts the Windows installer only when the page is reached from a download button', async () => {
    const base='https://github.com/GraphicMeat/mail-vault-app/releases/download/v2.16.0/';
    const release=()=>vi.fn().mockResolvedValue({ok:true,json:async()=>({tag_name:'v2.16.0',assets:[{name:'MailVault_2.16.0_x64-setup.exe',browser_download_url:base+'MailVault_2.16.0_x64-setup.exe'}]})});
    const clicked=[];
    for (const search of ['?start=1','']) {
      const markup=readFileSync(resolve(root,'windows-download.html'),'utf8');
      const {w,doc}=page('windows-download.html',search,release(),{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',markup});
      const button=doc.querySelector('[data-auto-download]');
      button.addEventListener('click',e=>{ e.preventDefault(); clicked.push(button.href); });
      await tick(); await tick();
      expect(button.href).toBe(base+'MailVault_2.16.0_x64-setup.exe');
      expect(w.location.search).toBe('');
    }
    expect(clicked).toEqual([base+'MailVault_2.16.0_x64-setup.exe']);
  });
  it.each([[2081,'2,000+',false],[12345,'12,000+',false],[950,'900+',false],[40,null,true],['nope',null,true]])('shows %s installer downloads under the hero as %s', async (installers, text, hidden) => {
    const fetch=vi.fn(async url=>String(url)==='/api/downloads'?{ok:true,json:async()=>({installers})}:Promise.reject(new Error('offline')));
    const {doc}=page('index.html','',fetch);
    await tick(); await tick();
    const proof=doc.querySelector('.hm-hero [data-download-proof]');
    expect(proof.hidden).toBe(hidden);
    if (text) expect(proof.querySelector('[data-download-total]').textContent).toBe(text);
    expect(proof.querySelector('a').getAttribute('href')).toBe('https://github.com/GraphicMeat/mail-vault-app/releases');
  });
  describe('email me the download link', () => {
    const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    const api = (status) => vi.fn(async (url) => String(url).endsWith('/api/send-link') ? {ok:status < 300, status, json:async()=>({})} : Promise.reject(new Error('offline')));
    const open = (doc, placement = 'hero') => {
      const opener = doc.querySelector('[data-send-link-open][aria-controls="send-link-' + placement + '"]');
      opener.click();
      return { opener, form: doc.getElementById('send-link-' + placement) };
    };
    it.each([['hero', '.hm-hero'], ['final', '#download']])('opens the %s form on a phone without stealing focus', (placement, section) => {
      const gm = vi.fn();
      const {doc} = page('index.html', '', undefined, {userAgent:phone, gm});
      const form = doc.getElementById('send-link-' + placement);
      expect(form.hidden).toBe(false);
      expect(doc.querySelector('[data-send-link-open][aria-controls="send-link-' + placement + '"]').hidden).toBe(true);
      expect(doc.querySelector(section + ' .hm-send-hint').hidden).toBe(false);
      expect(doc.activeElement).not.toBe(form.elements.email);
      expect(gm).not.toHaveBeenCalled();
    });
    it.each([['computer', 'final'], ['computer', 'hero']])('reveals the form in place on a %s (%s) and records the reveal as an email_link CTA', (device, placement) => {
      const gm = vi.fn();
      const {doc} = page('index.html', '', undefined, {userAgent:device === 'phone' ? phone : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', gm});
      const { opener, form } = open(doc, placement);
      expect(opener.hidden).toBe(true);
      expect(opener.getAttribute('aria-expanded')).toBe('true');
      expect(form.hidden).toBe(false);
      expect(doc.activeElement).toBe(form.elements.email);
      expect(form.elements.email.type).toBe('email');
      expect(form.elements.email.required).toBe(true);
      expect(form.elements.email.autocomplete).toBe('email');
      expect(doc.querySelector('label[for="' + form.elements.email.id + '"]')).not.toBeNull();
      expect(form.elements.website.tabIndex).toBe(-1);
      expect(form.elements.website.closest('[aria-hidden="true"]')).not.toBeNull();
      expect(form.getAttribute('method')).toBe('post');
      expect(form.getAttribute('action')).toBe('/api/send-link');
      expect(gm.mock.calls).toEqual([['home_cta', {page_version:'homepage-en-20261002', placement, destination:'email_link'}]]);
    });
    it('sends the address with the page language and shows the sent state', async () => {
      const gm = vi.fn();
      const fetch = api(200);
      const {w,doc} = page('index.html', '', fetch, {userAgent:phone, gm, path:'de/index.html'});
      // On a phone the closing form is already open, as in the hero.
      const form = doc.getElementById('send-link-final');
      expect(form.hidden).toBe(false);
      form.elements.email.value = 'reader@example.com';
      const submit = form.querySelector('[type="submit"]');
      submit.addEventListener('click', e => { e.preventDefault(); form.dispatchEvent(new w.Event('submit', {cancelable:true})); });
      submit.click();
      await tick();
      const [url, options] = fetch.mock.calls.find(([u]) => String(u).endsWith('/api/send-link'));
      expect(new URL(url).pathname).toBe('/api/send-link');
      expect(JSON.parse(options.body)).toEqual({email:'reader@example.com', lang:'de', website:'', placement:'final'});
      expect(form.hidden).toBe(true);
      const done = doc.querySelector('[data-send-link-done="final"]');
      expect(done.hidden).toBe(false);
      expect(doc.activeElement).toBe(done);
      // Only the send: no reveal click, and no generic cta_click for the form's own button.
      expect(gm.mock.calls.map(([name]) => name)).toEqual(['send_link']);
      expect(gm).toHaveBeenLastCalledWith('send_link', {page_version:'homepage-en-20261002', placement:'final'});
    });
    it.each([[400,'Check the email address'],[429,'Too many tries'],[503,'could not send it']])('explains a %s and lets the visitor retry', async (status, text) => {
      const gm = vi.fn();
      const {w,doc} = page('index.html', '', api(status), {userAgent:phone, gm});
      const { form } = open(doc);
      form.elements.email.value = 'reader@example.com';
      form.dispatchEvent(new w.Event('submit', {cancelable:true}));
      await tick();
      expect(form.hidden).toBe(false);
      expect(form.querySelector('[data-send-link-status]').textContent).toContain(text);
      expect(form.querySelector('[type="submit"]').disabled).toBe(false);
      expect(form.elements.email.value).toBe('reader@example.com');
      expect(gm.mock.calls.filter(([name]) => name === 'send_link')).toEqual([]);
    });
    it('shows the result of a form post made without a script', () => {
      const {doc} = page('index.html', '?send_link=sent#download', undefined, {userAgent:phone});
      expect(doc.getElementById('send-link-final').hidden).toBe(true);
      expect(doc.querySelector('[data-send-link-done="final"]').hidden).toBe(false);
      expect(doc.querySelector('[data-send-link-done="hero"]').hidden).toBe(true);
      const limited = page('index.html', '?send_link=limited', undefined, {userAgent:phone}).doc;
      expect(limited.getElementById('send-link-hero').hidden).toBe(false);
      expect(limited.querySelector('#send-link-hero [data-send-link-status]').textContent).toContain('Too many tries');
    });
  });
  it('switches the theme from the bar and from the phone menu', () => {
    const {w,doc}=page('features.html');
    const [bar,menu]=doc.querySelectorAll('.mv-theme');
    expect(menu.classList.contains('mv-menu-theme')).toBe(true);
    const dark=doc.documentElement.classList.contains('dark');
    menu.click();
    expect(doc.documentElement.classList.contains('dark')).toBe(!dark);
    bar.click();
    expect(doc.documentElement.classList.contains('dark')).toBe(dark);
    expect(bar.getAttribute('aria-label')).toBe(menu.getAttribute('aria-label'));
    expect(w.localStorage.theme).toBe(dark ? 'dark' : 'light');
  });
  it('shows GitHub stars and sends one heart from the header', async () => {
    let posts=0;
    const fetch=vi.fn(async (url,options)=>{
      if (options?.method==='POST') { posts++; return {ok:true,json:async()=>({count:43})}; }
      return {ok:true,json:async()=>String(url).includes('api.github.com')?{stargazers_count:1234}:{count:42}};
    });
    const {doc}=page('features.html','',fetch);
    await tick(); await tick();
    expect([...doc.querySelectorAll('[data-github-stars]')].map(n=>[n.textContent,n.hidden])).toEqual([['1,234',false]]);
    expect(doc.querySelector('[data-vote-count]').textContent).toBe('42');
    const heart=doc.querySelector('.mv-nav-social [data-vote]');
    heart.click(); await tick(); await tick();
    heart.click(); await tick();
    expect(posts).toBe(1);
    expect([...doc.querySelectorAll('[data-vote]')].every(b=>b.getAttribute('aria-pressed')==='true')).toBe(true);
    expect(doc.querySelector('[data-vote-count]').textContent).toBe('43');
  });
  it('keeps the macOS homepage action safe without release data or a tracker', async () => {
    const {doc}=page('index.html','',vi.fn().mockRejectedValue(new Error('offline')),{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'});
    await tick();
    const link=doc.querySelector('[data-hero-platform="mac"]');
    expect(link.getAttribute('href')).toBe('/thank-you.html?platform=mac&start=1');
    link.addEventListener('click',e=>e.preventDefault());
    expect(() => link.click()).not.toThrow();
  });
  it('queues production acquisition events until the tracker loads, without queuing locally', () => {
    const {w,doc} = page('index.html');
    const link = doc.querySelector('[data-acquisition-destination="demo"]');
    link.addEventListener('click', e => e.preventDefault());
    link.click();
    expect(w.gm.q).toEqual([['home_cta', {page_version:'homepage-en-20261002',placement:'hero',destination:'demo'}]]);
    const tracker = vi.fn();
    w.gm.q.forEach(args => tracker(...args));
    expect(tracker).toHaveBeenCalledExactlyOnceWith('home_cta', {page_version:'homepage-en-20261002',placement:'hero',destination:'demo'});

    const local = page('index.html', '', undefined, {hostname:'127.0.0.1'});
    const localLink = local.doc.querySelector('[data-acquisition-destination="demo"]');
    localLink.addEventListener('click', e => e.preventDefault());
    localLink.click();
    expect(local.w.gm).toBeUndefined();
  });
  it('counts every other CTA by target and placement, never by its localized text', () => {
    const gm = vi.fn();
    const {doc} = page('index.html', '', undefined, {gm, path:'de/index.html'});
    const click = el => { el.addEventListener('click', e => e.preventDefault()); el.click(); };
    click(doc.querySelector('.mv-nav-download[href^="/demo/"]'));
    click(doc.querySelector('.mv-navlinks a[href="/pricing.html"]'));
    click(doc.querySelector('#want-this-btn'));
    click(doc.querySelector('.mv-footer nav a[href^="https://github.com/"]'));
    expect(gm.mock.calls).toEqual([
      ['cta_click', {page_version:'homepage-en-20261002', target:'/demo/', placement:'header'}],
      ['cta_click', {page_version:'homepage-en-20261002', target:'/pricing.html', placement:'header'}],
      ['cta_click', {page_version:'homepage-en-20261002', target:'#want-this-btn', placement:'newsletter'}],
      ['cta_click', {page_version:'homepage-en-20261002', target:'github.com/GraphicMeat/mail-vault-app', placement:'footer'}],
    ]);
  });
  it('leaves named acquisition CTAs to their own event', () => {
    const gm = vi.fn();
    const {doc} = page('index.html', '', undefined, {gm});
    const link = doc.querySelector('[data-acquisition-destination="demo"]');
    link.addEventListener('click', e => e.preventDefault());
    link.click();
    expect(gm.mock.calls.map(([name]) => name)).toEqual(['home_cta']);
  });
  it('tags the tracker on every tracked page', () => {
    const tagged = (html, tag = 'redesign-2026-09') => new RegExp('<script defer src="/gm\\.js[^"]*" data-site="mailvault" data-tag="' + tag + '">\\s*</script>').test(html);
    for (const file of ['thank-you.html','updates-confirm.html','changelog.html','blog.html','faq.html','use-cases.html','compare/mailvault-vs-apple-mail.html','de/faq.html','ja/blog.html']) {
      expect(tagged(readFileSync(resolve(root, file), 'utf8')), file).toBe(true);
    }
    expect(tagged(readFileSync(resolve('src/demo/index.html'), 'utf8').replace('src="/gm.js"', 'src="/gm.js?v=x"'))).toBe(true);
  });
  // The clips change: the English homepage and the twenty-two English pages with
  // a clip. Their locale copies have no clips and keep the conversion tag.
  it('tags exactly the pages of the conversion and clips changes, in every language', () => {
    const TAG = 'conversion-2026-10';
    const CLIPS_TAG = 'clips-2026-10';
    const clipPages = new Set(['index.html', ...['archive-and-delete', 'scheduled-backups', 'time-capsule', 'email-tracker-blocking', 'link-safety', 'undo-send', 'unified-inbox', 'local-backups', 'saved-views', 'custom-fields', 'ai-writing', 'local-vault', 'sender-verification', 'views', 'layouts', 'scheduled-send', 'insights', 'tagging-rules', 'templates', 'tags', 'keyboard-shortcuts', 'notifications'].map(p => 'features/' + p + '.html')]);
    const tagOf = html => (html.match(/<script defer src="\/gm\.js[^"]*" data-site="mailvault" data-tag="([^"]+)">\s*<\/script>/) || [])[1];
    const english = ['index.html', 'features.html', 'pricing.html', 'get-started.html', ...readdirSync(resolve(root, 'features')).filter(f => f.endsWith('.html')).map(f => 'features/' + f)];
    const locales = ['de','fr','es','it','ja','ko','zh','pt-br'];
    const expected = new Set([...english, ...locales.flatMap(l => english.map(f => l + '/' + f))]);
    expect(english.length).toBeGreaterThan(20);
    expect(tagOf(readFileSync(resolve('index.html'), 'utf8'))).toBe(CLIPS_TAG);
    const walk = dir => readdirSync(resolve(root, dir), {withFileTypes:true}).flatMap(e => {
      const rel = dir ? dir + '/' + e.name : e.name;
      if (e.isDirectory()) return ['api','node_modules','i18n','demo','assets'].includes(e.name) ? [] : walk(rel);
      return e.name.endsWith('.html') ? [rel] : [];
    });
    const seen = new Set();
    for (const file of walk('')) {
      const tag = tagOf(readFileSync(resolve(root, file), 'utf8'));
      if (!tag) continue;
      if (expected.has(file)) { seen.add(file); expect(tag, file).toBe(clipPages.has(file) ? CLIPS_TAG : TAG); }
      else expect(tag, file).toBe('redesign-2026-09');
    }
    expect([...expected].filter(f => !seen.has(f))).toEqual([]);
  });
  it('counts a download once, where the file starts, not on the button that leads there', () => {
    const gm=vi.fn();
    const {w,doc}=page('index.html','',undefined,{gm,userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'});
    for (const link of [doc.querySelector('.hm-hero-actions [data-hero-platform="mac"]'), doc.querySelector('.mv-navtools > a.mv-button:not(.mv-secondary)')]) {
      link.addEventListener('click',e=>e.preventDefault());
      link.click();
    }
    expect(w.navigator.sendBeacon).not.toHaveBeenCalled();
    expect(gm.mock.calls.filter(([name]) => name === 'download_action')).toHaveLength(0);
  });
  it('resolves desktop assets and counts only actual download actions', async () => {
    const base='https://github.com/GraphicMeat/mail-vault-app/releases/download/v2.11.3/';
    const fetch=vi.fn().mockResolvedValue({ok:true,json:async()=>({tag_name:'v2.11.3',assets:['MailVault.dmg','MailVault_amd64.deb','MailVault_arm64.deb'].map(name=>({name,browser_download_url:base+name}))})});
    const gm=vi.fn();
    const {w,doc}=page('thank-you.html','?platform=mac',fetch,{gm});
    await tick();
    expect(doc.querySelector('[data-download="mac"]').href).toBe(base+'MailVault.dmg');
    expect(w.navigator.sendBeacon).not.toHaveBeenCalled();
    const link=doc.querySelector('[data-download="mac"]');
    link.addEventListener('click',e=>e.preventDefault());
    link.click();
    expect(w.navigator.sendBeacon).toHaveBeenCalledExactlyOnceWith('/api/metrics/e','download_click');
    expect(gm).toHaveBeenLastCalledWith('download_action', {page_version:'homepage-en-20261002',platform:'mac',destination:'file'});
    expect(gm.mock.calls.filter(([name]) => name === 'download_action')).toHaveLength(1);
  });
  it('rejects an unexpected release download destination', async()=>{
    const gm=vi.fn();
    const {doc}=page('thank-you.html','?platform=mac',vi.fn().mockResolvedValue({ok:true,json:async()=>({assets:[{name:'app.dmg',browser_download_url:'https://untrusted.example/app.dmg'}]})}),{gm});
    await tick();
    const link=doc.querySelector('[data-download="mac"]');
    expect(link.href).toMatch(/releases\/latest$/);
    link.addEventListener('click',e=>e.preventDefault());
    link.click();
    expect(gm).toHaveBeenLastCalledWith('download_action', {page_version:'homepage-en-20261002',platform:'mac',destination:'fallback'});
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
    // Subdirectory pages too: a root-relative href like "favicon.ico" only resolves at the root.
    const sub = ['features','faq','blog','guides','compare'].flatMap(d => readdirSync(resolve(root,d)).filter(f => f.endsWith('.html')).map(f => d+'/'+f));
    for(const file of ['index.html','pricing.html','get-started.html','thank-you.html',...sub]) {
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
