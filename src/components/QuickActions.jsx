import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronLeft, ChevronRight, MoreHorizontal } from "lucide-react";
import { Popover } from "./ui/Popover";
import { useQuickActionConfiguration } from "../hooks/useQuickActionConfiguration";
import { useT } from "../i18n/index.js";
import { quickActionColorFor } from "../utils/quickActionColors";
import "../styles/quick-actions.css";

const DESTRUCTIVE = new Set(["delete", "deleteServer", "deleteEverywhere"]);
const UNSAFE_FAVORITE = new Set([...DESTRUCTIVE, "unarchive"]);
const PAGE_SIZE = 8;
function wedgeClip(index, count) {
  const gap = Math.min(1.3, 10 / Math.max(count, 1));
  const start = -90 + index * 360 / count + gap;
  const end = -90 + (index + 1) * 360 / count - gap;
  const point = (angle, radius) =>
    `${50 + Math.cos(angle * Math.PI / 180) * radius}% ${
      50 + Math.sin(angle * Math.PI / 180) * radius
    }%`;
  const arc = (from, to, radius) => {
    const segments = Math.max(2, Math.ceil(Math.abs(to - from) / 4) + 1);
    return Array.from(
      { length: segments },
      (_, index) => point(from + (to - from) * index / (segments - 1), radius),
    );
  };
  const outer = arc(start, end, 50);
  const inner = arc(end, start, 24);
  return `polygon(${[...outer, ...inner].join(", ")})`;
}

function radialContentPosition(index, count) {
  const angle = (-90 + (index + .5) * 360 / count) * Math.PI / 180;
  const radius = 37;
  return {
    left: `${50 + Math.cos(angle) * radius}%`,
    top: `${50 + Math.sin(angle) * radius}%`,
  };
}

function QuickActionsConfigured({
  surface = "row",
  config,
  descriptors = [],
  className = "",
  buttonClassName = "",
  display = "icon-label",
  triggerLabel,
  renderExtra,
  identity,
  onActionStart,
  onOpenChange,
  inlineLimit,
  inlineAvailableWidth,
  preview = false,
}) {
  const t = useT();
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const actionsRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const [radialPage, setRadialPage] = useState(0);
  const [activeRadial, setActiveRadial] = useState(null);
  const [parentAvailableWidth, setParentAvailableWidth] = useState(null);
  const previousPageRef = useRef(0);
  const id = useId();
  const entries = config?.entries || [];
  const available = useMemo(
    () => new Map(descriptors.map((item) => [item.id, item])),
    [descriptors],
  );
  const configured = entries.map((entry) => ({
    entry,
    descriptor: available.get(entry.id),
  })).filter((item) => item.descriptor && !item.descriptor.hidden);
  const requestedFavorite = configured.find((item) =>
    item.entry.id === config.favoriteId
  );
  const favorite = requestedFavorite ||
    configured.find((item) => !UNSAFE_FAVORITE.has(item.entry.action));
  const mode = config?.mode || "menu";
  const opened = !!anchor;
  const radialFits = typeof window !== "undefined" &&
    window.innerWidth >= 420 && window.innerHeight >= 430;
  const radial = mode === "radial" && (radialFits || preview);
  const requestedInlineLimit = inlineLimit
    ? Math.max(1, Math.min(6, Number(inlineLimit)))
    : configured.length;
  const [fittedInlineLimit, setFittedInlineLimit] = useState(
    requestedInlineLimit,
  );
  const maxInline = Math.max(
    0,
    Math.min(requestedInlineLimit, fittedInlineLimit),
  );
  const inlineIdentity = configured.map((item) =>
    `${item.entry.id}:${item.descriptor.label}`
  ).join("|");
  const inlineOverflow = mode === "inline" && configured.length > maxInline;
  const remaining = mode === "favorite-menu"
    ? configured.filter((item) => item !== favorite)
    : mode === "inline"
    ? configured.slice(maxInline)
    : configured;
  const paged = radial && config?.radialPagination;
  const pageCount = paged
    ? Math.max(1, Math.ceil(remaining.length / PAGE_SIZE))
    : 1;
  const page = Math.min(radialPage, pageCount - 1);
  const visibleRadial = paged
    ? remaining.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    : remaining;
  const menuEntries = radial ? visibleRadial : remaining;
  const triggerText = triggerLabel ||
    (surface === "reader" ? t("email.sender.more") : t("quickActions.title"));
  const shouldShowMenu = mode === "menu" || mode === "radial" ||
    mode === "favorite-menu" || inlineOverflow;
  const availableInlineWidth = inlineAvailableWidth ?? parentAvailableWidth;

  useEffect(() => {
    if (
      surface !== "selection" || inlineAvailableWidth ||
      !actionsRef.current?.parentElement
    ) return undefined;
    const parent = actionsRef.current.parentElement;
    const measure = () => {
      const copy = parent.querySelector(".quick-actions-preview-copy");
      const width = parent.getBoundingClientRect().width -
        (copy?.getBoundingClientRect().width || 0) - 16;
      setParentAvailableWidth(Math.max(34, width));
    };
    measure();
    const observer = typeof ResizeObserver === "function"
      ? new ResizeObserver(measure)
      : null;
    observer?.observe(parent);
    return () => observer?.disconnect();
  }, [inlineAvailableWidth, mode, surface]);

  useLayoutEffect(() => {
    setFittedInlineLimit(requestedInlineLimit);
  }, [
    requestedInlineLimit,
    availableInlineWidth,
    display,
    inlineIdentity,
    mode,
  ]);
  useLayoutEffect(() => {
    if (
      mode !== "inline" || !availableInlineWidth || !actionsRef.current ||
      fittedInlineLimit !== requestedInlineLimit
    ) {
      return;
    }
    const buttons = [
      ...actionsRef.current.querySelectorAll(".quick-action-button"),
    ];
    const widths = buttons.map((button) =>
      button.getBoundingClientRect().width
    );
    const directWidth = widths.reduce(
      (sum, width, index) => sum + width + (index ? 2 : 0),
      0,
    );
    const needsOverflow = configured.length > requestedInlineLimit ||
      directWidth > availableInlineWidth;
    let used = needsOverflow ? 34 : 0;
    let fit = 0;
    for (const width of widths) {
      if (used + width + (fit ? 2 : 0) > availableInlineWidth) break;
      used += width + (fit ? 2 : 0);
      fit++;
    }
    setFittedInlineLimit(Math.min(requestedInlineLimit, fit));
  }, [
    availableInlineWidth,
    configured.length,
    display,
    fittedInlineLimit,
    inlineIdentity,
    mode,
    requestedInlineLimit,
  ]);

  const close = useCallback((restoreFocus = true) => {
    setAnchor(null);
    setActiveRadial(null);
    onOpenChange?.(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onOpenChange]);
  useEffect(() => {
    if (opened) {
      panelRef.current?.querySelector("button:not(:disabled)")?.focus();
    }
  }, [opened, page]);
  useEffect(() => {
    if (page === previousPageRef.current) return;
    previousPageRef.current = page;
    requestAnimationFrame(() => {
      const root = preview ? actionsRef.current : panelRef.current;
      root?.querySelector(".quick-action-radial-item:not(:disabled)")?.focus();
    });
  }, [page, preview]);
  useEffect(() => {
    setAnchor(null);
    setRadialPage(0);
    setActiveRadial(null);
    onOpenChange?.(false);
  }, [identity, onOpenChange]);
  const open = (event) => {
    event.stopPropagation();
    onOpenChange?.(true);
    const rect = event.currentTarget.getBoundingClientRect();
    const radialSize = radial ? 304 : 0;
    setRadialPage(0);
    setAnchor({
      top: radial
        ? Math.max(
          8,
          Math.min(
            window.innerHeight - radialSize - 8,
            rect.top + rect.height / 2 - radialSize / 2,
          ),
        )
        : rect.bottom + 6,
      left: radial
        ? Math.max(
          8,
          Math.min(
            window.innerWidth - radialSize - 8,
            rect.left + rect.width / 2 - radialSize / 2,
          ),
        )
        : Math.max(8, Math.min(window.innerWidth - 232, rect.right - 232)),
    });
  };
  const activate = (item, event) => {
    event.stopPropagation();
    if (item.descriptor.disabled) return;
    const confirmationTrigger = panelRef.current?.contains(event.currentTarget)
      ? triggerRef.current || event.currentTarget
      : event.currentTarget;
    onActionStart?.(event, confirmationTrigger, item.entry);
    close(item.descriptor.restoreFocus !== false);
    try {
      Promise.resolve(item.descriptor.onActivate?.(event, item.entry)).catch(
        (error) =>
          console.error(`[QuickActions] ${item.entry.action} failed:`, error),
      );
    } catch (error) {
      console.error(`[QuickActions] ${item.entry.action} failed:`, error);
    }
  };
  const onMenuKeyDown = (event) => {
    if (event.key === "Tab") {
      if (preview) return;
      event.preventDefault();
      event.stopPropagation();
      close(true);
      return;
    }
    const buttons = [
      ...event.currentTarget.querySelectorAll("button:not(:disabled)"),
    ];
    const index = buttons.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" || event.key === "ArrowRight"
      ? (index + 1 + buttons.length) % buttons.length
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
      ? (index - 1 + buttons.length) % buttons.length
      : event.key === "Home"
      ? 0
      : event.key === "End"
      ? buttons.length - 1
      : null;
    if (next !== null && buttons[next]) {
      event.preventDefault();
      event.stopPropagation();
      buttons[next].focus();
    }
  };
  const regularButton = (item, menuEntry = false, index = 0) => {
    const { descriptor, entry: saved } = item;
    const Icon = descriptor.Icon;
    const color = quickActionColorFor(item.entry, config.palette);
    return (
      <button
        key={saved.id}
        ref={descriptor.buttonRef}
        type="button"
        role={menuEntry ? "menuitem" : undefined}
        className={[
          "quick-action-button",
          buttonClassName,
          config.palette === "neutral" &&
            (descriptor.isDestructive || DESTRUCTIVE.has(saved.action))
            ? "quick-action-destructive"
            : "",
        ].filter(Boolean).join(" ")}
        data-quick-action={saved.action}
        title={descriptor.titleLabel || descriptor.label}
        aria-label={descriptor.titleLabel || descriptor.label}
        aria-expanded={descriptor.expanded}
        disabled={!!descriptor.disabled}
        style={color ? { "--quick-action-color": color } : undefined}
        onClick={(event) => activate(item, event)}
      >
        {Icon && display !== "text-only" && (
          <Icon size={15} aria-hidden="true" />
        )}
        {(display !== "icon-only" || menuEntry) && (
          <span>{descriptor.label}</span>
        )}
      </button>
    );
  };
  const radialButton = (item, index, count) => {
    const { descriptor, entry: saved } = item;
    const Icon = descriptor.Icon;
    const color = quickActionColorFor(item.entry, config.palette);
    return (
      <button
        key={saved.id}
        ref={descriptor.buttonRef}
        type="button"
        role="menuitem"
        className="quick-action-radial-item"
        data-quick-action={saved.action}
        aria-label={descriptor.titleLabel || descriptor.label}
        aria-expanded={descriptor.expanded}
        aria-current={activeRadial?.entry.id === saved.id ? "true" : undefined}
        disabled={!!descriptor.disabled}
        style={{
          clipPath: wedgeClip(index, count),
          ...(color ? { "--quick-action-color": color } : {}),
        }}
        onMouseEnter={() => setActiveRadial(item)}
        onFocus={() => setActiveRadial(item)}
        onClick={(event) => activate(item, event)}
      >
        <span
          className="quick-action-radial-content"
          style={radialContentPosition(index, count)}
        >
          {Icon && <Icon size={19} aria-hidden="true" />}
        </span>
      </button>
    );
  };
  if (!configured.length && !renderExtra) return null;
  const panelStyle = radial
    ? {
      top: anchor?.top || 0,
      left: anchor?.left || 0,
      width: 304,
      height: 304,
    }
    : {
      top: anchor?.top || 0,
      left: anchor?.left || 0,
      width: 224,
      maxHeight: "min(70vh, 520px)",
      overflowY: "auto",
    };
  const active =
    menuEntries.find((item) => item.entry.id === activeRadial?.entry.id) ||
    menuEntries[0];
  const ActiveIcon = active?.descriptor.Icon;
  const changePage = (next) => {
    setActiveRadial(null);
    setRadialPage(next);
  };
  const wheel = (
    <>
      {menuEntries.map((item, index) =>
        radialButton(item, index, menuEntries.length)
      )}
      <div
        className={`quick-actions-radial-center ${
          pageCount > 1 ? "has-pages" : ""
        }`}
        aria-live="polite"
      >
        {ActiveIcon && <ActiveIcon size={25} aria-hidden="true" />}
        <span>{active?.descriptor.label}</span>
        {pageCount > 1 && (
          <div className="quick-action-radial-pages">
            <button
              type="button"
              role="menuitem"
              aria-label={t("quickActions.previousPage")}
              disabled={page === 0}
              onClick={() => changePage(page - 1)}
            >
              <ChevronLeft size={15} />
            </button>
            <span>{page + 1}/{pageCount}</span>
            <button
              type="button"
              role="menuitem"
              aria-label={t("quickActions.nextPage")}
              disabled={page >= pageCount - 1}
              onClick={() => changePage(page + 1)}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}
      </div>
    </>
  );
  if (preview && radial) {
    return (
      <div
        ref={actionsRef}
        className="quick-actions-radial quick-actions-radial-preview"
        role="menu"
        aria-label={triggerText}
        onKeyDown={onMenuKeyDown}
      >
        {wheel}
      </div>
    );
  }
  return (
    <>
      <div
        ref={actionsRef}
        className={`quick-actions ${className}`}
        data-layout={mode}
        data-surface={surface}
        style={availableInlineWidth
          ? { maxWidth: availableInlineWidth }
          : undefined}
      >
        {mode === "inline" &&
          configured.slice(0, maxInline).map((item, index) =>
            regularButton(item, false, index)
          )}
        {mode === "favorite-menu" && favorite && regularButton(favorite)}
        {shouldShowMenu && (
          <button
            ref={triggerRef}
            type="button"
            className="quick-actions-trigger"
            aria-label={triggerText}
            title={triggerText}
            aria-haspopup="menu"
            aria-expanded={opened}
            aria-controls={opened ? id : undefined}
            onClick={open}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
            {mode === "menu" && <span>{triggerText}</span>}
          </button>
        )}
        {renderExtra}
      </div>
      <Popover
        ref={panelRef}
        id={id}
        open={opened}
        onClose={close}
        handlesTab
        role="menu"
        aria-label={triggerText}
        onKeyDown={onMenuKeyDown}
        data-surface={surface}
        className={radial ? "quick-actions-radial" : "quick-actions-menu"}
        style={panelStyle}
      >
        {radial
          ? wheel
          : menuEntries.map((item, index) => regularButton(item, true, index))}
      </Popover>
    </>
  );
}

export function QuickActions(
  { surface = "row", config, scope, descriptors = [], ...rest },
) {
  if (config) {
    return (
      <QuickActionsConfigured
        surface={surface}
        config={config}
        descriptors={descriptors}
        {...rest}
      />
    );
  }
  return (
    <StoredQuickActions
      surface={surface}
      scope={scope}
      descriptors={descriptors}
      {...rest}
    />
  );
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
