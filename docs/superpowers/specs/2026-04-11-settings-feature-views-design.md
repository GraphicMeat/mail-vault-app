# Settings Feature Views: Email Cleanup & Time Capsule

## Context

AI Cleanup and Time Capsule are currently accessed via sidebar buttons that open standalone modals. This creates two problems: the sidebar gets cluttered with feature-specific buttons, and the features are disconnected from their configuration in Settings. The goal is to consolidate both features into the Settings panel as integrated views with account selection, removing the sidebar buttons entirely.

Additionally, the "AI & Cleanup" tab name is misleading — there's no AI/LLM involved. The classifier is Naive Bayes. Rename to "Email Cleanup".

## Design

### Settings sidebar split

The settings sidebar splits into two visual sections with a label and divider:

**Features** (top):
- Email Cleanup (icon: Sparkles) — renamed from "AI & Cleanup"
- Time Capsule (icon: Clock)

**Settings** (bottom, after divider):
- General, Accounts, Templates, Storage, Backup, Migration, Background Daemon, Billing, Security, Logs, Help & Support

Features go on top since they're the primary interactive views.

### Feature tab layout

Feature tabs use a three-part layout:

1. **Header row**: Tab title on the left, gear icon button on the right to navigate to the config sub-view
2. **Account pills**: Horizontal row of account buttons below the header. Active account is highlighted. Defaults to the currently active account from `useAccountStore`
3. **Feature content**: The existing feature view rendered inline (not as a modal)

### Sub-view navigation

`SettingsPage` gains a `subView` state variable:
- `null` (default): Renders the feature view (classification results / snapshot browser)
- `'config'`: Renders the config view (learned rules & categories / auto-snapshot settings)

The gear icon sets `subView = 'config'`. The config view shows a back arrow that sets `subView = null`. Switching tabs resets `subView` to `null`.

Only feature tabs use sub-views. Regular settings tabs ignore `subView`.

### Component refactoring

**CleanupModal -> CleanupView** (`src/components/settings/CleanupSettings.jsx`):
- Strip the fixed overlay, backdrop, and modal container
- Remove `isOpen`/`onClose` props
- Add `accountId` prop (replaces internal `useAccountStore` read for active account)
- Inner content unchanged: summary cards, category tabs, virtualized results list, inline progress bar, email preview, bulk actions, correction dropdowns
- Export as `CleanupView`

**TimeCapsule -> TimeCapsuleView** (`src/components/TimeCapsule.jsx`):
- Strip the modal wrapper (fixed overlay, backdrop, close button)
- Remove `isOpen`/`onClose` props
- Add `accountId` prop
- Keep the 3-page state machine: snapshot list -> snapshot browser -> email viewer
- Internal back navigation (viewer -> browser -> list) stays as-is via `useSnapshotStore`
- Export as `TimeCapsuleView`

**SettingsPage.jsx**:
- Split tab list into `featureTabs` and `settingsTabs` arrays
- Render them in two sidebar sections with "Features" / "Settings" labels and a divider
- Add `subView` state, reset on tab change
- For feature tabs: render account pills + header with gear icon
- `activeTab === 'cleanup'` renders `<CleanupView accountId={selectedAccountId} />` or `<AISettings />` based on `subView`
- `activeTab === 'time-capsule'` renders `<TimeCapsuleView accountId={selectedAccountId} />` or `<TimeCapsuleSettings />` based on `subView`
- Add `selectedFeatureAccountId` state for the account pills, defaulting to `activeAccountId`

**App.jsx**:
- Remove `showCleanup` and `showTimeCapsule` state variables
- Remove `<CleanupModal>` and `<TimeCapsule>` modal renders
- Remove `onOpenTimeCapsule` and `onOpenCleanup` props from `<Sidebar>`

**Sidebar.jsx**:
- Remove the Time Capsule button (lines ~972-980)
- Remove the AI Cleanup button (lines ~982-1015)
- Remove classification status polling (`classStatus` state, `classPollRef`, the polling `useEffect`)
- Remove `onOpenTimeCapsule` and `onOpenCleanup` from the props destructuring

### Tab ID rename

Change the AI tab ID from `'ai'` to `'cleanup'` across:
- `SettingsPage.jsx` tab definitions and conditionals
- Any `onOpenSettings('ai')` calls in the codebase (search for `'ai'` passed to settings)

## Files modified

| File | Changes |
|------|---------|
| `src/components/SettingsPage.jsx` | Split tabs into sections, add sub-view state, account pills, render feature views inline |
| `src/components/settings/CleanupSettings.jsx` | Refactor CleanupModal to CleanupView (strip modal wrapper, add accountId prop) |
| `src/components/TimeCapsule.jsx` | Refactor to TimeCapsuleView (strip modal wrapper, add accountId prop) |
| `src/App.jsx` | Remove modal state/renders for cleanup and time capsule |
| `src/components/Sidebar.jsx` | Remove both feature buttons and classification polling |

## Verification

1. `npx vite build` passes
2. `npm run test -- --run` passes (no regressions)
3. Open Settings -> "Email Cleanup" shows classification results for active account
4. Account pills switch the view to a different account's classifications
5. Gear icon navigates to rules/categories config, back arrow returns
6. Open Settings -> "Time Capsule" shows snapshot browser for active account
7. Account pills switch to different account's snapshots
8. Gear icon navigates to auto-snapshot config, back arrow returns
9. Sidebar no longer shows Time Capsule or AI Cleanup buttons
10. ESC closes Settings (not individual feature views)
