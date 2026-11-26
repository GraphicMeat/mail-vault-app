// Settings > Appearance > Quick actions on desktop: the saved configuration, the live samples drawn
// with the real list row, selection bar and wheel, and the presets, around the editor both apps
// render (views/QuickActionsEditorView.jsx).
import React, { useMemo } from "react";
import { QuickActionPresets, QuickActionSample } from "./QuickActionSamples";
import { useMailStore } from "../../stores/mailStore";
import { useTagStore } from "../../stores/tagStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useQuickActionConfiguration } from "../../hooks/useQuickActionConfiguration";
import { useQuickActionSamples } from "../../hooks/useQuickActionSamples";
import { QUICK_ACTION_SURFACES } from "../../utils/quickActions";
import { DesktopViewEnv } from "./DesktopViewEnv";
import { QuickActionsView } from "./views/QuickActionsView";
import { QuickActionsEditorView } from "./views/QuickActionsEditorView";

const EMPTY_ARRAY = Object.freeze([]);

export function QuickActionsSettings() {
  const quickActions = useSettingsStore((state) => state.quickActions);
  const setSurface = useSettingsStore((state) => state.setQuickActionSurface);
  const setStyle = useSettingsStore((state) => state.setQuickActionStyle);
  const setStyleLink = useSettingsStore((state) => state.setQuickActionStyleLink);
  const resetScope = useSettingsStore((state) => state.resetQuickActionScope);
  const labels = useTagStore((state) => state.tags) || EMPTY_ARRAY;
  const createTag = useTagStore((state) => state.createTag);
  const templates = useSettingsStore((state) => state.emailTemplates) || EMPTY_ARRAY;
  const mailboxes = useMailStore((state) => state.mailboxes) || EMPTY_ARRAY;
  const activeAccountId = useMailStore((state) => state.activeAccountId);
  const activeMailbox = useMailStore((state) => state.activeMailbox);
  const accounts = useMailStore((state) => state.accounts) || EMPTY_ARRAY;
  const samples = useQuickActionSamples();
  const { scope } = useQuickActionConfiguration("row");
  const scopeAccount = accounts.find((account) =>
    account.id === scope.accountId || account.id === activeAccountId
  )?.email || "";
  const folders = useMemo(
    () => mailboxes.filter((item) => !item.noselect && item.path && item.path !== activeMailbox),
    [mailboxes, activeMailbox],
  );
  const store = useMemo(() => ({ setSurface, setStyle, setStyleLink, resetScope }), [setSurface, setStyle, setStyleLink, resetScope]);
  return (
    <DesktopViewEnv>
      <QuickActionsView>
        <QuickActionsEditorView
          quickActions={quickActions}
          scope={scope}
          scopeAccount={scopeAccount}
          surfaces={QUICK_ACTION_SURFACES}
          labels={labels}
          templates={templates}
          folders={folders}
          activeAccountId={activeAccountId}
          createLabel={(name) => createTag(name).catch(() => null)}
          store={store}
          renderPresets={(presetScope) => <QuickActionPresets scope={presetScope} />}
          renderSample={(surface, config) => <QuickActionSample key={surface} surface={surface} config={config} rows={samples} />}
        />
      </QuickActionsView>
    </DesktopViewEnv>
  );
}
