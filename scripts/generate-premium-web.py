"""Build English Premium details from the app's onboarding catalog."""
from pathlib import Path
import re,json,html
root=Path(__file__).resolve().parents[1]
source=(root/'src/data/premiumFeatures.js').read_text()
strings=json.loads((root/'src/i18n/locales/en.json').read_text())
features=re.findall(r"\{ id: '([^']+)'.*?titleKey: '([^']+)'.*?blurbKey: '([^']+)'.*?shot: (null|'[^']+')",source)
links=[];details=[]
for ident,titleKey,blurbKey,shot in features:
 title=html.escape(strings[titleKey]);blurb=html.escape(strings[blurbKey]);target='premium-'+ident
 links.append(f'<li><a href="#{target}">{title}<span aria-hidden="true">↗</span></a></li>')
 media=''
 if shot!='null':
  name=shot.strip("'");assert (root/f'website/screenshots/{name}-1440.webp').exists()
  media=f'<button class="mv-shot" type="button" data-image aria-label="Enlarge: {title}"><img src="/screenshots/{name}-1440.webp" srcset="/screenshots/{name}-720.webp 720w, /screenshots/{name}-1440.webp 1440w, /screenshots/{name}-2880.webp 2880w" sizes="(max-width:760px) 90vw, 680px" width="1440" height="932" loading="lazy" alt="{title} in MailVault"></button>'
  media+='<p class="mv-small">Real app screenshot · Click to enlarge</p>'
 else:media='<div class="mv-device-allowance"><strong>5</strong><span>MailVault installations<br>One Premium subscription</span></div>'
 details.append(f'<details class="mv-premium-detail" id="{target}" name="premium-feature"><summary>{title}</summary><div class="mv-premium-detail-body"><div><p>{blurb}</p><a href="/get-started.html?plan=yearly" class="mv-text-link">Get started with Premium →</a></div><div>{media}</div></div></details>')
p=root/'website/pricing.html';s=p.read_text()
start=s.index('mv-plan mv-premium')
a=s.index('<ul class="mv-premium-links">',start) if '<ul class="mv-premium-links">' in s[start:] else s.index('<ul class="mv-checklist">',start)
b=s.index('</ul>',a)+5
s=s[:a]+'<ul class="mv-premium-links">'+''.join(links)+'</ul>'+s[b:]
if '<!-- premium-catalog:start -->' in s:
 a=s.index('<!-- premium-catalog:start -->');b=s.index('<!-- premium-catalog:end -->',a)+len('<!-- premium-catalog:end -->')
else:
 a=s.rfind('<section',0,s.index('mv-premium-story'))
 b=s.index('</section>',a)+10
catalog='<section class="mv-section mv-wrap" id="premium-features" aria-labelledby="premium-features-title"><div class="mv-section-heading"><h2 id="premium-features-title">See what Premium<br>does for you.</h2><p>The same 10 features you’ll find in the app’s onboarding. Open a feature to explore it.</p></div>'+''.join(details)+'</section>'
s=s[:a]+'<!-- premium-catalog:start -->'+catalog+'<!-- premium-catalog:end -->'+s[b:]
if 'Select one to see how it works.' not in s:s=s.replace('<ul class="mv-premium-links">','<p class="mv-small">Everything in Free, plus these 10 features. Select one to see how it works.</p><ul class="mv-premium-links">',1)
if '/assets/premium-features.js' not in s:s=s.replace('</body>','<script defer src="/assets/premium-features.js"></script>\n</body>')
p.write_text(s)
print('Generated',len(features),'Premium features from the app catalog')
