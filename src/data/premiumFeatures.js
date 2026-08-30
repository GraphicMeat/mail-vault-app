import {
  CalendarClock, ShieldCheck, Sparkles, Clock, EyeOff,
  Trash2, ArrowLeftRight, Server, Image, Monitor,
} from 'lucide-react';

/**
 * Every premium feature, once. The onboarding gallery, the Billing list, the
 * Help gallery and the catalog tests all read this array — before it existed
 * the Billing tab listed nothing at all and tracker removal was sold only on
 * the website.
 *
 * `tab` is a `SettingsPage` TAB id and is what the Open button navigates to.
 * `null` means the feature has no settings surface: export-as-image lives in
 * the email viewer, and the device allowance is a property of the plan itself.
 * `shot` is the basename under `src/assets/premium/<locale>/`.
 */
export const PREMIUM_FEATURES = Object.freeze([
  { id: 'backup-schedule',  icon: CalendarClock,  titleKey: 'premium.backupSchedule.title',  blurbKey: 'premium.backupSchedule.blurb',  shot: 'premium-backup-schedule',  tab: 'backup' },
  { id: 'backup-health',    icon: ShieldCheck,    titleKey: 'premium.backupHealth.title',    blurbKey: 'premium.backupHealth.blurb',    shot: 'premium-backup-health',    tab: 'backup' },
  { id: 'cleanup',          icon: Sparkles,       titleKey: 'premium.cleanup.title',         blurbKey: 'premium.cleanup.blurb',         shot: 'premium-cleanup',          tab: 'cleanup' },
  { id: 'time-capsule',     icon: Clock,          titleKey: 'premium.timeCapsule.title',     blurbKey: 'premium.timeCapsule.blurb',     shot: 'premium-time-capsule',     tab: 'time-capsule' },
  { id: 'tracker-blocking', icon: EyeOff,         titleKey: 'premium.trackerBlocking.title', blurbKey: 'premium.trackerBlocking.blurb', shot: 'premium-tracker-blocking', tab: 'tracking' },
  { id: 'auto-cleanup',     icon: Trash2,         titleKey: 'premium.autoCleanup.title',     blurbKey: 'premium.autoCleanup.blurb',     shot: 'premium-auto-cleanup',     tab: 'storage' },
  { id: 'migration',        icon: ArrowLeftRight, titleKey: 'premium.migration.title',       blurbKey: 'premium.migration.blurb',       shot: 'premium-migration',        tab: 'migration' },
  { id: 'server-change',    icon: Server,         titleKey: 'premium.serverChange.title',    blurbKey: 'premium.serverChange.blurb',    shot: 'premium-server-change',    tab: 'accounts' },
  { id: 'export-image',     icon: Image,          titleKey: 'premium.exportImage.title',     blurbKey: 'premium.exportImage.blurb',     shot: 'premium-export-image',     tab: null },
  { id: 'devices',          icon: Monitor,        titleKey: 'premium.devices.title',         blurbKey: 'premium.devices.blurb',         shot: null,                       tab: 'billing' },
]);
