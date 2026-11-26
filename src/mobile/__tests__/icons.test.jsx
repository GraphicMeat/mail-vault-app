// @vitest-environment jsdom
// One icon family and one back control. The phone's icons (icons.jsx) are lucide glyphs, each the
// one desktop draws for the same action, hidden from assistive tech; no phone file draws an icon of
// its own (the attachment chip's download ring is a progress meter, not an icon). Every
// full-screen layer starts with BackButton: a 44px icon button with a chevron, named Back.
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { t } from '../i18n.js';

const icons = await import('../icons.jsx');

afterEach(cleanup);

const glyph = (el) => {
  const { container } = render(el);
  const svg = container.querySelector('svg');
  expect(svg.getAttribute('aria-hidden')).toBe('true');
  return { name: [...svg.classList].find((c) => c.startsWith('lucide-')), svg };
};

describe('icons.jsx draws desktop glyphs', () => {
  it('each action wears the glyph desktop gives it', () => {
    const cases = [
      [<icons.EnvelopeIcon open />, 'lucide-mail-open'],
      [<icons.EnvelopeIcon />, 'lucide-mail'],
      [<icons.FlagIcon />, 'lucide-star'],
      [<icons.BookmarkIcon />, 'lucide-bookmark-plus'],
      [<icons.BookmarkIcon filled />, 'lucide-bookmark-check'],
      [<icons.MoveIcon />, 'lucide-folder-input'],
      [<icons.TrashIcon />, 'lucide-trash2'],
      [<icons.SpamIcon />, 'lucide-shield-alert'],
      [<icons.ReplyIcon />, 'lucide-reply'],
      [<icons.ReplyAllIcon />, 'lucide-reply-all'],
      [<icons.ForwardIcon />, 'lucide-forward'],
      [<icons.MoreIcon />, 'lucide-more-horizontal'],
      [<icons.ShieldIcon state="blocked" />, 'lucide-eye-off'],
      [<icons.ShieldIcon state="locked" />, 'lucide-eye'],
      [<icons.MenuIcon />, 'lucide-menu'],
      [<icons.SearchIcon />, 'lucide-search'],
      [<icons.ComposeIcon />, 'lucide-pen-square'],
      [<icons.PaperclipIcon />, 'lucide-paperclip'],
      [<icons.ClockIcon />, 'lucide-clock'],
      [<icons.CloseIcon />, 'lucide-x'],
      [<icons.CheckIcon />, 'lucide-check'],
      [<icons.PlusIcon />, 'lucide-plus'],
      [<icons.SendIcon />, 'lucide-send'],
      [<icons.AllInboxesIcon />, 'lucide-inbox'],
    ];
    for (const [el, name] of cases) {
      expect(glyph(el).name).toBe(name);
      cleanup();
    }
  });

  it('a starred message fills the star', () => {
    expect(glyph(<icons.FlagIcon filled />).svg.getAttribute('fill')).toBe('currentColor');
    cleanup();
    expect(glyph(<icons.FlagIcon />).svg.getAttribute('fill')).toBe('none');
  });
});

describe('BackButton', () => {
  it('is a 44px icon button with a chevron, named Back, passing its hooks through', () => {
    const onClick = vi.fn();
    render(<icons.BackButton data-mv-viewer-close className="mv-viewer__back" onClick={onClick} />);
    const back = screen.getByRole('button', { name: t('common.back') });
    expect(back.textContent).toBe('');
    expect(back.querySelector('svg.lucide-chevron-left')).toBeTruthy();
    expect(back.className).toMatch(/min-w-11/);
    expect(back.className).toMatch(/min-h-11/);
    expect(back.classList.contains('mv-viewer__back')).toBe(true);
    expect(back.hasAttribute('data-mv-viewer-close')).toBe(true);
    fireEvent.click(back);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

// jsdom's import.meta.url is not a file URL: walk from the repo root.
const root = join(process.cwd(), 'src/mobile/');
const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  if (statSync(p).isDirectory()) return f === '__tests__' ? [] : walk(p);
  return /\.jsx$/.test(f) ? [p] : [];
});
const sources = walk(root).map((p) => [p.slice(root.length), readFileSync(p, 'utf8')]);

describe('one icon family', () => {
  it('no phone file draws an icon of its own', () => {
    const drawn = [];
    for (const [file, src] of sources) {
      const count = (src.match(/<svg\b/g) || []).length;
      // AttachmentChip draws its download progress ring: a meter, not an icon.
      const allowed = file === 'AttachmentChip.jsx' ? 1 : 0;
      if (count > allowed) drawn.push(`${file}: ${count}`);
    }
    expect(drawn).toEqual([]);
  });

  it('the account switcher marks the open account and Add account with icons, not text glyphs', () => {
    const switcher = sources.find(([f]) => f === 'AccountSwitcher.jsx')[1];
    expect(switcher).not.toMatch(/'✓'|>\+</);
  });

  it('every full-screen layer starts with BackButton, not a text Back', () => {
    const texts = sources.filter(([, src]) => /mv-(compose|viewer)__back"[^>]*>\s*\{t\('common\.back'\)\}/.test(src)).map(([f]) => f);
    expect(texts).toEqual([]);
    for (const file of ['Viewer.jsx', 'ThreadView.jsx', 'Compose.jsx', 'ChatView.jsx', 'DraftsList.jsx', 'FollowUpList.jsx', 'ViewResults.jsx', 'Premium.jsx', 'Settings.jsx']) {
      const src = sources.find(([f]) => f === file)[1];
      expect(src, file).toMatch(/<BackButton\b/);
    }
  });
});
