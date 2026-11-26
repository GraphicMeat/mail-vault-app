// Desktop's quick actions: the saved configuration (settings, mail and view stores) around the
// presentational wheel, menu and inline bar in QuickActionsWheel.jsx. That file reaches no store,
// service or desktop i18n, because the phone renders it too (src/mobile/quickActions/); this one
// hands it the desktop's translator and re-exports what other desktop modules import from here.
import React from "react";
import { useQuickActionConfiguration } from "../hooks/useQuickActionConfiguration";
import { useT } from "../i18n/index.js";
import { SettingsViewProvider } from "./settings/views/viewContext";
import { QuickActionsConfigured } from "./QuickActionsWheel";

export {
  CATEGORY_WHEEL,
  QuickActionWheelInPlace,
  radialContentPosition,
  wedgeClip,
} from "./QuickActionsWheel";

export function QuickActions(
  { surface = "row", config, scope, descriptors = [], ...rest },
) {
  const t = useT();
  const wheel = config
    ? (
      <QuickActionsConfigured
        surface={surface}
        config={config}
        descriptors={descriptors}
        {...rest}
      />
    )
    : (
      <StoredQuickActions
        surface={surface}
        scope={scope}
        descriptors={descriptors}
        {...rest}
      />
    );
  return <SettingsViewProvider t={t}>{wheel}</SettingsViewProvider>;
}

function StoredQuickActions({ surface, scope, descriptors, ...rest }) {
  const resolved = useQuickActionConfiguration(surface, scope);
  return (
    <QuickActionsConfigured
      surface={surface}
      config={resolved.config}
      descriptors={descriptors}
      {...rest}
    />
  );
}
