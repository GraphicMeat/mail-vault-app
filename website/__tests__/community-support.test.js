import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
async function setup(ok, { copy, label, voted } = {}) {
 let markup = readFileSync('website/index.html','utf8');
 if (copy) markup = markup.replace(/(<script id="mv-runtime-copy" type="application\/json">)[\s\S]*?(<\/script>)/, `$1${JSON.stringify(copy)}$2`);
 if (label) markup = markup.replace(/(<span id="vote-label">)[^<]*/, `$1${label}`);
 const dom = new JSDOM(markup, {url:'https://mailvaultapp.com',runScripts:'outside-only'});
 if (voted) dom.window.localStorage.setItem('mailvault-voted','true');
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
it('uses localized vote copy without replacing the initial translated label',async()=>{
 const copy = {
  voteThanks: 'Merci pour votre soutien !',
  voteAlreadyCounted: 'Votre vote a déjà été compté. Merci !',
  voteSupporting: 'Merci de soutenir MailVault !',
  voteSendError: 'Impossible d’envoyer votre vote. Réessayez bientôt.',
 };
 const {dom,button}=await setup(true,{copy,label:'Je le veux !'});
 expect(dom.window.document.getElementById('vote-label').textContent).toBe('Je le veux !');
 button.click(); await settle();
 expect(dom.window.document.getElementById('vote-label').textContent).toBe(copy.voteThanks);
 expect(dom.window.document.getElementById('vote-status').textContent).toBe(copy.voteSupporting);
 dom.window.close();
});
