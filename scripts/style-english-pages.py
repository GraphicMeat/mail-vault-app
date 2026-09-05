"""Apply the reviewed English shell to generated and existing English content pages.
Run after generating pages; locales are intentionally untouched.
"""
from pathlib import Path
import re

root=Path(__file__).resolve().parents[1]/'website'
home=(root/'index.html').read_text()
header=re.search(r'<header class="mv-header">[\s\S]*?</header>',home).group()
footer=re.search(r'<footer\b[\s\S]*?</footer>',home).group()
studio=re.search(r'<aside class="mv-studio"[\s\S]*?</aside>',home).group()
changed=[]
for p in root.rglob('*.html'):
 s=p.read_text()
 if not re.search(r'<html[^>]*lang="en"',s) or 'mv-site' in s or 'i18n' in p.parts: continue
 if '/oauth/' in str(p):
  if 'by Graphic Meat' in s: continue
  s=s.replace('#1a1a2e','#fafaf8').replace('#e0e0e0','#20212c').replace('#a0a0b0','#575b69').replace('#6c9fff','#4f46df')
  s=s.replace('<h2>','<a href="https://graphicmeat.com" style="color:#575b69;text-decoration:none;font-size:14px">MailVault · by Graphic Meat</a><h2>',1)
  p.write_text('\n'.join(line.rstrip() for line in s.splitlines())+'\n');changed.append(str(p.relative_to(root)));continue
 pageheader=header
 # Keep the equivalent translated page when the source declares one.
 for lang,url in re.findall(r'<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"',s):
  if lang=='x-default':continue
  path=url.replace('https://mailvaultapp.com','')
  pageheader=re.sub(r'(<a href=")[^"]+(" lang="[^"]+" hreflang="'+re.escape(lang)+r'")',lambda m:m[1]+path+m[2],pageheader)
 # Replace legacy navigation only; article headers remain article headers.
 nav=re.search(r'<nav\b[\s\S]*?</nav>',s)
 if nav:
  s=s[:nav.start()]+pageheader+s[nav.end():]
 else:
  s=re.sub(r'(<body[^>]*>)',lambda m:m[1]+pageheader,s,count=1)
 s=re.sub(r'<body[^>]*>', '<body class="mv-site mv-content-page">',s,count=1)
 s=re.sub(r'<a[^>]+href="#main"[^>]*>Skip[^<]*</a>','',s,count=1)
 s=s.replace('<body class="mv-site mv-content-page">','<body class="mv-site mv-content-page"><a class="mv-skip" href="#main">Skip to content</a>',1)
 if '<main' in s:
  s=re.sub(r'<main([^>]*)>',lambda m:'<main'+(' id="main"' if 'id=' not in m[1] else '')+m[1]+'>',s,count=1)
 else:
  end=s.index('</header>')+len('</header>');bodyend=s.index('<script',end) if '<script' in s[end:] else s.index('</body>')
  s=s[:end]+'<main id="main" class="mv-status-page">'+s[end:bodyend]+'</main>'+studio+footer+s[bodyend:]
 if re.search('<footer',s) and 'mv-studio' not in s:
  s=re.sub(r'<footer\b[\s\S]*?</footer>',lambda m:studio+footer,s,count=1)
 # Preserve page-specific scripts sharing a block with the old navigation.
 def clean_script(m):
  js=m[1]
  if 'themeToggle' not in js and 'mobileMenuBtn' not in js:return m[0]
  for marker in ['// Deep links minted','// Fetch and render stats']:
   if marker in js:return '<script>\n'+js[js.index(marker):]+'</script>'
  return ''
 s=re.sub(r'<script>\s*([\s\S]*?)</script>',clean_script,s)
 s=s.replace('</head>','<link rel="stylesheet" href="/assets/english-site.css?v=2">\n<link rel="stylesheet" href="/assets/english-content.css?v=1">\n</head>')
 s=s.replace('</body>','<script defer src="/assets/english-site.js?v=2"></script>\n</body>')
 p.write_text('\n'.join(line.rstrip() for line in s.splitlines())+'\n');changed.append(str(p.relative_to(root)))
print('Styled',len(changed),'English pages:',', '.join(changed))
