// The selection bar's frame: the count, the actions between, a divider and the clear button.
// Presentational and store-free, so the desktop bar (SelectionActionBar.jsx) and the phone's
// (src/mobile/selection/SelectionBar.jsx) draw one bar. `children` is the quick actions
// (QuickActions on desktop, QuickActionsConfigured on the phone).
import React from "react";
import { X } from "lucide-react";
import { Button } from "./ui/Button";

export function SelectionBarFrame({ label, labelRef, preview = false, clearTitle, onClear, children }) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-1.5 bg-mail-surface border border-mail-strong
                         rounded-xl
                         max-w-[calc(100vw-1.5rem)] min-w-0 pointer-events-auto"
      data-quick-actions-preview={preview || undefined}
    >
      {/* Selection count */}
      <span
        ref={labelRef}
        data-selection-label
        className="text-sm font-medium text-mail-text px-3 whitespace-nowrap"
      >
        {label}
      </span>

      {children}

      <div className="w-px h-6 bg-mail-border" />

      {/* Clear */}
      <Button
        variant="ghost"
        icon
        size="md"
        onClick={onClear}
        title={clearTitle}
      >
        <X size={16} className="text-mail-text-muted" />
      </Button>
    </div>
  );
}
