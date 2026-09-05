import { it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { JSDOM } from 'jsdom';
it('explains every feature in the app onboarding catalog with its exact English copy',()=>{
 const source=readFileSync('src/data/premiumFeatures.js','utf8');
 const strings=JSON.parse(readFileSync('src/i18n/locales/en.json','utf8'));
 const d=new JSDOM(readFileSync('website/pricing.html','utf8')).window.document;
 const catalog=[...source.matchAll(/\{ id: '([^']+)'.*?titleKey: '([^']+)'.*?blurbKey: '([^']+)'.*?shot: (null|'[^']+')/g)];
 expect(d.querySelectorAll('.mv-premium-detail').length).toBe(catalog.length);
 for(const [,id,title,blurb,shot] of catalog){
  const detail=d.getElementById('premium-'+id);
  expect(detail.querySelector('summary').textContent).toBe(strings[title]);
  expect(detail.textContent).toContain(strings[blurb]);
  expect(d.querySelector('.mv-premium-links a[href="#premium-'+id+'"]')).not.toBeNull();
  if(shot!=='null')expect(existsSync('website'+detail.querySelector('img').getAttribute('src'))).toBe(true);
 }
});
