#!/usr/bin/env python3
"""Serve a review copy without billing, signup, or analytics side effects.

Usage: python3 scripts/preview-website.py --directory website --port 3080
Only the public pricing GET is proxied. All POST requests are rejected.
"""
import argparse
import json
import re
from pathlib import Path
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.parse import urlsplit, unquote, parse_qs, urlencode

class PreviewHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Robots-Tag', 'noindex, nofollow')
        super().end_headers()

    def reply(self, code, content, kind='application/json'):
        self.send_response(code)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(content)

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == '/gm.js':
            return self.reply(200, b'/* Analytics disabled in review preview. */', 'text/javascript')
        if path == '/api/billing/pricing':
            try:
                currency = parse_qs(urlsplit(self.path).query).get('currency', [''])[0]
                query = '?' + urlencode({'currency': currency}) if currency in ('eur', 'usd', 'gbp') else ''
                req = Request('https://mailvaultapp.com/api/billing/pricing' + query, headers={'Accept': 'application/json', 'User-Agent': 'MailVaultPreview/1.0'})
                with urlopen(req, timeout=8) as res:
                    data = json.loads(res.read())
                return self.reply(200, json.dumps(data).encode())
            except Exception:
                return self.reply(503, b'{"error":"pricing_unavailable"}')
        if any(part.startswith('.') for part in path.split('/') if part) or path.startswith(('/api/', '/node_modules/', '/i18n/')):
            return self.reply(404, b'{"error":"not_available_in_preview"}')
        # Sharing a LAN preview must fetch its image from this preview, not
        # from the production domain where the unapproved asset does not exist.
        file = Path(self.translate_path(self.path))
        if file.is_dir():
            file = file / 'index.html'
        host = self.headers.get('Host', '')
        if file.suffix == '.html' and file.is_file() and re.fullmatch(r'[a-zA-Z0-9.\-:]+', host):
            content = file.read_text(encoding='utf-8')
            image = '/assets/og-mailvault-en-v2.png'
            if 'https://mailvaultapp.com' + image in content:
                content = content.replace('https://mailvaultapp.com' + image, 'http://' + host + image)
                return self.reply(200, content.encode('utf-8'), 'text/html; charset=utf-8')
        return super().do_GET()

    def do_HEAD(self):
        return self.do_GET()

    def do_POST(self):
        return self.reply(503, b'{"error":"Forms and checkout are disabled in this review preview."}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', default='website')
    parser.add_argument('--bind', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=3080)
    args = parser.parse_args()
    handler = lambda *a, **kw: PreviewHandler(*a, directory=args.directory, **kw)
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    print(f'MailVault review: http://{args.bind}:{args.port} (no writes, no analytics)', flush=True)
    server.serve_forever()
