// The phone's icons, one place: each is the lucide glyph desktop draws for the same action or
// destination (desktop's quick actions in src/utils/quickActionIcons.jsx, its reader, compose and
// sidebar), hidden from assistive tech (the button carries the name). 22px unless a caller says
// otherwise. `BackButton` is the back control every full-screen layer starts with.
import React from 'react';
import {
  Bell, BookTemplate, BookmarkCheck, BookmarkPlus, Check, ChevronDown, ChevronLeft, Clock, Eye, EyeOff,
  FileText, FolderInput, Forward, Inbox, Mail, MailOpen, Menu, MoreHorizontal, Paperclip, PenSquare,
  Plus, RefreshCw, Reply, ReplyAll, Search, Send, ShieldAlert, Sparkles, Star, Trash2, X,
} from 'lucide-react';
import { Button } from '../components/ui/Button.jsx';
import { useT } from './i18n.js';

const glyph = (Icon, defaultSize = 22, extra = {}) => function PhoneIcon({ size = defaultSize, className }) {
  return <Icon size={size} className={className} aria-hidden="true" focusable="false" {...extra} />;
};

/**
 * Read state, as desktop's toggle draws it: an open envelope while the message is read (the
 * action marks it unread), a closed one while it is unread (the action marks it read).
 */
export function EnvelopeIcon({ open = false, size = 22 }) {
  const Icon = open ? MailOpen : Mail;
  return <Icon size={size} aria-hidden="true" focusable="false" />;
}

/** Desktop's star, filled while the message is starred (flagged). */
export function FlagIcon({ filled = false, size = 22 }) {
  return <Star size={size} aria-hidden="true" focusable="false" fill={filled ? 'currentColor' : 'none'} />;
}

/** Keep in bubble: desktop's bookmark with a plus, a check once the message is kept. */
export function BookmarkIcon({ filled = false, size = 22 }) {
  const Icon = filled ? BookmarkCheck : BookmarkPlus;
  return <Icon size={size} aria-hidden="true" focusable="false" />;
}

/** Tracking pixels found in a message: desktop's crossed-out eye once they are blocked, an open eye when Premium would block them. */
export function ShieldIcon({ state = 'blocked', size = 22 }) {
  const Icon = state === 'blocked' ? EyeOff : Eye;
  return <Icon size={size} aria-hidden="true" focusable="false" />;
}

export const MoveIcon = glyph(FolderInput);
export const TrashIcon = glyph(Trash2);
export const ReplyIcon = glyph(Reply);
export const ReplyAllIcon = glyph(ReplyAll);
export const ForwardIcon = glyph(Forward);
/** Move to Junk. */
export const SpamIcon = glyph(ShieldAlert);
/** More actions. */
export const MoreIcon = glyph(MoreHorizontal);
export const MenuIcon = glyph(Menu);
export const SearchIcon = glyph(Search);
/** A new message (the compose button). */
export const ComposeIcon = glyph(PenSquare, 24);
export const ChevronDownIcon = glyph(ChevronDown, 14);
export const PaperclipIcon = glyph(Paperclip);
/** Send later. */
export const ClockIcon = glyph(Clock);
/** Remove or dismiss. */
export const CloseIcon = glyph(X, 14);
export const CheckIcon = glyph(Check, 18);
export const PlusIcon = glyph(Plus, 20);
/** Unsent mail (the outbox). */
export const SendIcon = glyph(Send, 18);
/** A file on the device. */
export const FileIcon = glyph(FileText, 20);
/** Try again. */
export const RetryIcon = glyph(RefreshCw, 20);
/** All Inboxes: desktop's sidebar glyph for it. */
export const AllInboxesIcon = glyph(Inbox, 18);
/** Follow-up reminders. */
export const BellIcon = glyph(Bell, 16);
/** Compose templates: desktop compose's glyph for them. */
export const TemplateIcon = glyph(BookTemplate);
/** Compose's AI actions: desktop's AiComposeActions glyph. */
export const AiIcon = glyph(Sparkles);

/**
 * The back control every full-screen layer starts with: a 44px ghost icon button with a chevron
 * pointing to where the layer came from (mirrored right to left), named Back. `data-*`, `onClick`
 * and `className` pass through.
 */
export function BackButton({ className = '', ...rest }) {
  const t = useT();
  return (
    <Button variant="ghost" size="touch" icon className={`mv-back ${className}`} aria-label={t('common.back')} {...rest}>
      <ChevronLeft size={24} aria-hidden="true" focusable="false" className="mv-back__glyph" />
    </Button>
  );
}
