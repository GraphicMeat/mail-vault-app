// Tiered catalog of shared UI building blocks (atoms -> molecules -> organisms
// -> templates). Add a new file to the tier it belongs in so the settings
// pages (and everything else) keep reaching for one of these instead of
// hand-rolling a look-alike.

// Atoms — single-purpose, no composition of other catalog pieces.
export { Button } from './Button';
export { ToggleSwitch } from './ToggleSwitch';
export { XLogo, LinkedInLogo } from './BrandGlyphs';

// Molecules — a label/control pair or small composite built from atoms.
export { SettingRow } from './SettingRow';
export { SettingsField, SegmentedControl } from './SettingsForm';
export { Combobox } from './Combobox';
export { DateTimePicker } from './DateTimePicker';
export { TypeaheadChips } from './TypeaheadChips';
export { TomSelectField } from './TomSelectField';
export { Spin } from './SpinField';
export { SegmentedChoice } from './SegmentedChoice';
export { SampleConversation } from './SampleConversation';
export { Popover, MenuItem } from './Popover';

// Organisms — a full section or dialog assembled from molecules/atoms.
export { Dialog } from './Dialog';
export { ToastShell } from './ToastShell';
export { SettingsCard, SettingsSection } from './SettingsForm';
export { SettingsTabs } from './SettingsTabs';

// Templates — the page-level shell a settings page mounts into.
export { SettingsPageLayout } from './SettingsForm';

// Misc
export { Z } from './layers';
