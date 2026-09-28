import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Archive, ArchiveRestore, Mail, MailOpen, Moon, Star, Sun } from 'lucide-react';
import { FilledStar, QUICK_ACTION_ICONS, quickActionIcon } from '../quickActionIcons';
import { QUICK_ACTION_TYPES } from '../quickActions';

// The real lucide, not a double: this is what proves the installed version
// lets `fill` override the outline default it puts on every <svg>.
const fillOf = Icon => /<svg[^>]*\sfill="([^"]*)"/.exec(renderToStaticMarkup(<Icon size={15} />))?.[1];

describe('quick action icons', () => {
  it('draws a filled star for a starred message and an outline one otherwise', () => {
    expect(fillOf(FilledStar)).toBe('currentColor');
    expect(fillOf(Star)).toBe('none');
  });

  it('shows the state the message is in: filled once starred, restore once archived', () => {
    expect(quickActionIcon('star')).toBe(Star);
    expect(quickActionIcon('star', { flagged: true })).toBe(FilledStar);
    expect(quickActionIcon('unstar')).toBe(FilledStar);
    expect(quickActionIcon('archive')).toBe(Archive);
    expect(quickActionIcon('archive', { archived: true })).toBe(ArchiveRestore);
    expect(quickActionIcon('unarchive')).toBe(ArchiveRestore);
  });

  it('shows the direction read and theme will take, like their labels', () => {
    expect(quickActionIcon('toggleRead', { read: false })).toBe(MailOpen);
    expect(quickActionIcon('toggleRead', { read: true })).toBe(Mail);
    expect(quickActionIcon('theme', { dark: true })).toBe(Sun);
    expect(quickActionIcon('theme', { dark: false })).toBe(Moon);
  });

  it('has one glyph for every action type', () => {
    expect(QUICK_ACTION_TYPES.filter(action => !QUICK_ACTION_ICONS[action])).toEqual([]);
    expect(QUICK_ACTION_TYPES.filter(action => !quickActionIcon(action))).toEqual([]);
  });
});
