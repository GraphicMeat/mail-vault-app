import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  ChevronLeft,
  ChevronRight,
  FolderInput,
  MailCheck,
  MoreHorizontal,
  Send,
  Trash2,
} from "lucide-react";
import { Popover } from "./ui/Popover";
import { useQuickActionConfiguration } from "../hooks/useQuickActionConfiguration";
import { useT } from "../i18n/index.js";
import { quickActionColorFor } from "../utils/quickActionColors";
import { groupRadialEntries } from "../utils/quickActions";
import "../styles/quick-actions.css";

const DESTRUCTIVE = new Set(["delete", "deleteServer", "deleteEverywhere"]);
const UNSAFE_FAVORITE = new Set([...DESTRUCTIVE, "unarchive"]);
const PAGE_SIZE = 8;
const CATEGORY_ICONS = {
  send: Send,
  mark: MailCheck,
  organize: FolderInput,
  delete: Trash2,
  more: MoreHorizontal,
};
// Radii, in % of the wheel box. A categorized wheel keeps its inner ring
// inside INNER_RING and fans a category's actions out in the ARC_RING band.
// Both bands are about as thick as each other (64px and 62px on the 400px
// wheel), and the inner one starts right outside the 126px center disc, so a
// category and its actions are each a wedge nearly a whole band deep. The
// categorized wheel's CSS (rim stops, backdrop inset) follows INNER_RING.outer.
const INNER_RING = { outer: 33, inner: 17, content: 25 };
const ARC_RING = { outer: 50, inner: 34.5, content: 42.25 };
const ARC_SLOT = 34;
// Hover intent: with an arc open, a move onto another category (or a direct
// wedge) waits this long before swapping, and reaching the open arc cancels
// it. A straight path from a category to its far arc items crosses its
// neighbours' wedges.
const ARC_SWAP_DELAY = 100;
const WHEEL_SIZE = 304;
const CATEGORY_WHEEL_SIZE = 400;
export const CATEGORY_WHEEL = {
  size: CATEGORY_WHEEL_SIZE, inner: INNER_RING, arc: ARC_RING,
};
// A wedge's clip-path depends only on its position, count and ring, all
// bounded: cache it at module level so hovering never re-walks the trig and
// rebuilds the polygon string.
const wedgeClipCache = new Map();
export function wedgeClip(index, count, ring = null) {
  const key = `${count}:${index}:${ring ? ring.outer : ""}`;
  const cached = wedgeClipCache.get(key);
  if (cached) return cached;
  const gap = Math.min(1.3, 10 / Math.max(count, 1));
  const clip = ringClip(
    -90 + index * 360 / count + gap,
    -90 + (index + 1) * 360 / count - gap,
    ring ? ring.outer : 50,
    ring ? ring.inner : 24,
  );
  wedgeClipCache.set(key, clip);
  return clip;
}

// The angles of one action in a category's arc: slots of ARC_SLOT degrees
// (fewer degrees when many would wrap past the full circle), centered on the
// category's own wedge.
function arcAngles(innerIndex, innerCount, index, count) {
  const slot = Math.min(ARC_SLOT, 360 / count);
  const gap = Math.min(1.3, 10 / Math.max(count, 1));
  const mid = -90 + (innerIndex + .5) * 360 / innerCount;
  const start = mid - slot * count / 2 + index * slot;
  return { start: start + gap, end: start + slot - gap, mid: start + slot / 2 };
}

const arcClipCache = new Map();
function arcClip(innerIndex, innerCount, index, count) {
  const key = `${innerCount}:${innerIndex}:${count}:${index}`;
  const cached = arcClipCache.get(key);
  if (cached) return cached;
  const { start, end } = arcAngles(innerIndex, innerCount, index, count);
  const clip = ringClip(start, end, ARC_RING.outer, ARC_RING.inner);
  arcClipCache.set(key, clip);
  return clip;
}

function polarPosition(angle, radius) {
  const radians = angle * Math.PI / 180;
  return {
    left: `${50 + Math.cos(radians) * radius}%`,
    top: `${50 + Math.sin(radians) * radius}%`,
  };
}

function ringClip(start, end, outerRadius, innerRadius) {
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
  const outer = arc(start, end, outerRadius);
  const inner = arc(end, start, innerRadius);
  return `polygon(${[...outer, ...inner].join(", ")})`;
}

export function radialContentPosition(index, count, radius = 37) {
  return polarPosition(-90 + (index + .5) * 360 / count, radius);
}

// A categorized wheel's outer arc: the one piece of state that changes when
// the pointer or focus moves between categories lives here, so swapping arcs
// re-renders only this component, never the inner ring. The wheel reaches it
// through `arcRef`, like RadialCenter's hover setter:
// - `open(id, { focus, intent })` shows `id`'s arc (null folds it). `focus`
//   also moves focus to its first action (keyboard entry); `intent` is a
//   pointer move, which waits ARC_SWAP_DELAY before replacing an open arc.
// - `hold()` cancels a waiting swap: the pointer reached the open arc.
function RadialArc({ arcRef, inner, renderItem }) {
  const [openId, setOpenId] = useState(null);
  const [, requestFocus] = useReducer((count) => count + 1, 0);
  const openIdRef = useRef(null);
  const focusFirstRef = useRef(false);
  const swapTimerRef = useRef(null);
  const rootRef = useRef(null);
  useEffect(() => {
    const hold = () => {
      clearTimeout(swapTimerRef.current);
      swapTimerRef.current = null;
    };
    arcRef.current = {
      open(id, { focus = false, intent = false } = {}) {
        hold();
        const apply = () => {
          swapTimerRef.current = null;
          openIdRef.current = id;
          focusFirstRef.current = focus;
          setOpenId(id);
          if (focus) requestFocus();
        };
        if (intent && openIdRef.current !== null && openIdRef.current !== id) {
          swapTimerRef.current = setTimeout(apply, ARC_SWAP_DELAY);
        } else apply();
      },
      hold,
    };
    return () => {
      hold();
      arcRef.current = null;
    };
  }, [arcRef]);
  const index = openId === null
    ? -1
    : inner.findIndex((wedge) => wedge.category === openId);
  const open = index >= 0 ? inner[index] : null;
  // The open category's wedge is marked straight on the DOM: those buttons
  // belong to the wheel, and re-rendering it to flip one attribute is what
  // this component exists to avoid. React never renders these two attributes
  // on a category wedge, so nothing overwrites them.
  useLayoutEffect(() => {
    const wheel = rootRef.current?.parentElement;
    wheel?.querySelectorAll("[data-radial-category]").forEach((button) => {
      const isOpen = !!open && button.dataset.radialCategory === open.category;
      button.setAttribute("aria-expanded", String(isOpen));
      if (isOpen) button.setAttribute("data-open", "");
      else button.removeAttribute("data-open");
    });
    if (focusFirstRef.current) {
      focusFirstRef.current = false;
      rootRef.current?.querySelector("button:not(:disabled)")?.focus();
    }
  });
  return (
    <div
      ref={rootRef}
      className="quick-action-radial-arc"
      data-radial-arc={open ? open.category : undefined}
      role={open ? "group" : undefined}
      aria-label={open ? open.label : undefined}
    >
      {open?.items.map((item, itemIndex) =>
        renderItem(
          item,
          arcClip(index, inner.length, itemIndex, open.items.length),
          polarPosition(
            arcAngles(index, inner.length, itemIndex, open.items.length).mid,
            ARC_RING.content,
          ),
        )
      )}
    </div>
  );
}

// Owns the one bit of "which wedge is active" state on its own, so a hover or
// focus move only re-renders this label, never the 16 wedges around it. The
// wheel hands its setter out through `hoverRef` instead of a prop, since the
// wedges are siblings, not children, of this component.
const RadialCenter = React.memo(function RadialCenter({
  hoverRef,
  menuEntries,
  page,
  pageCount,
  onPrevPage,
  onNextPage,
  previousPageLabel,
  nextPageLabel,
}) {
  const [activeId, setActiveId] = useState(null);
  useEffect(() => {
    hoverRef.current = setActiveId;
    return () => {
      hoverRef.current = null;
    };
  }, [hoverRef]);
  // Only what is actually hovered or focused: a wheel opened with the pointer
  // on its center (not clickable) names nothing.
  const active = activeId === null
    ? null
    : menuEntries.find((item) => item.entry.id === activeId);
  const ActiveIcon = active?.descriptor.Icon;
  // An arc action names its category above itself, small, as in the
  // reference wheel.
  const group = active?.group;
  return (
    <div
      className={`quick-actions-radial-center ${
        pageCount > 1 ? "has-pages" : ""
      }`}
      aria-live="polite"
    >
      {ActiveIcon && <ActiveIcon size={25} aria-hidden="true" />}
      {group && <small className="quick-actions-radial-center-group">{group}</small>}
      <span>{active?.descriptor.label}</span>
      {pageCount > 1 && (
        <div className="quick-action-radial-pages">
          <button
            type="button"
            role="menuitem"
            aria-label={previousPageLabel}
            disabled={page === 0}
            onClick={onPrevPage}
          >
            <ChevronLeft size={15} />
          </button>
          <span>{page + 1}/{pageCount}</span>
          <button
            type="button"
            role="menuitem"
            aria-label={nextPageLabel}
            disabled={page >= pageCount - 1}
            onClick={onNextPage}
          >
            <ChevronRight size={15} />
          </button>
        </div>
      )}
    </div>
  );
});

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
  openAt,
}) {
  const t = useT();
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const actionsRef = useRef(null);
  const [anchor, setAnchor] = useState(null);
  const [radialPage, setRadialPage] = useState(0);
  // The hovered/focused wedge only repaints the center label: this ref holds
  // that leaf's own setter, so telling it which item is active never
  // re-renders the wheel itself (16 wedges rebuilding clip-paths on hover was
  // the actual lag).
  const radialHoverRef = useRef(null);
  // A categorized wheel's arc setter (RadialArc), and a flag that keeps the
  // focus the menu gives its first wedge on opening from fanning that wedge's
  // category out: an arc opens on a real hover, focus move or click.
  const radialArcRef = useRef(null);
  const openingFocusRef = useRef(false);
  // Opened from a right-click rather than the trigger: every action is on
  // offer, whatever the inline or favorite slots already show.
  const [atPointer, setAtPointer] = useState(false);
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
  const remaining = atPointer
    ? configured
    : mode === "favorite-menu"
    ? configured.filter((item) => item !== favorite)
    : mode === "inline"
    ? configured.slice(maxInline)
    : configured;
  const categories = radial && config?.radialLayout === "categories";
  const radialSize = categories ? CATEGORY_WHEEL_SIZE : WHEEL_SIZE;
  const paged = radial && !categories && config?.radialPagination;
  const pageCount = paged
    ? Math.max(1, Math.ceil(remaining.length / PAGE_SIZE))
    : 1;
  const page = Math.min(radialPage, pageCount - 1);
  const visibleRadial = paged
    ? remaining.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    : remaining;
  const menuEntries = radial ? visibleRadial : remaining;
  // The categorized inner ring: direct wedges hold an item, category wedges
  // the items their arc fans out. Visibility already applied (hidden
  // descriptors never reach `remaining`). The favorite stays in its category:
  // it belongs to the favorite-plus-menu layout, not the wheel. Built only
  // while the wheel shows (a closed row menu renders on every live row).
  let inner = [];
  let centerEntries = menuEntries;
  if (categories && (opened || preview)) {
    const byId = new Map(remaining.map((item) => [item.entry.id, item]));
    inner = groupRadialEntries(remaining.map((item) => item.entry)).map((group) =>
      group.type === "action" ? { item: byId.get(group.entry.id) } : {
        category: group.id,
        label: t(`quickActions.category.${group.id}`),
        Icon: CATEGORY_ICONS[group.id],
        items: group.entries.map((entry) => byId.get(entry.id)),
      }
    );
    centerEntries = inner.flatMap((wedge) =>
      wedge.item ? [wedge.item] : [
        {
          entry: { id: `category:${wedge.category}` },
          descriptor: { label: wedge.label, Icon: wedge.Icon },
        },
        ...wedge.items.map((item) => ({ ...item, group: wedge.label })),
      ]
    );
  }
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
    // The bar's count and Clear share its width, as SelectionActionBar measures.
    const measure = () => {
      const label = parent.querySelector("[data-selection-label]");
      const width = parent.getBoundingClientRect().width -
        (label?.getBoundingClientRect().width || 0) - 86;
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
    setAtPointer(false);
    radialHoverRef.current?.(null);
    radialArcRef.current?.open(null);
    onOpenChange?.(false);
    // A menu opened at the pointer has no trigger to go back to: focusing the
    // row's hidden one would pin the row's hover bar open.
    if (restoreFocus && !atPointer) requestAnimationFrame(() => triggerRef.current?.focus());
  }, [onOpenChange, atPointer]);
  // Popover's Escape (a document capture listener, so ahead of onMenuKeyDown)
  // and its outside click both land here. Escape from inside an open arc
  // steps back to the arc's category; everything else closes the menu.
  const dismiss = useCallback(() => {
    const arc = document.activeElement?.closest?.("[data-radial-arc]");
    if (arc && panelRef.current?.contains(arc)) {
      panelRef.current.querySelector(
        `[data-radial-category="${arc.dataset.radialArc}"]`,
      )?.focus();
      return;
    }
    close();
  }, [close]);
  useEffect(() => {
    if (opened) {
      openingFocusRef.current = true;
      panelRef.current?.querySelector("button:not(:disabled)")?.focus();
      openingFocusRef.current = false;
    }
  }, [opened, page]);
  useEffect(() => {
    if (page === previousPageRef.current) return;
    previousPageRef.current = page;
    requestAnimationFrame(() => {
      const root = preview ? actionsRef.current : panelRef.current;
      // The pointer is still on the page button in the center: this focus
      // names nothing, like the one on opening.
      openingFocusRef.current = true;
      root?.querySelector(".quick-action-radial-item:not(:disabled)")?.focus();
      openingFocusRef.current = false;
    });
  }, [page, preview]);
  // A new identity (another message) closes the menu. Not on mount: a row
  // mounts this inside the right-click that opens it (`openAt` below).
  const identityRef = useRef(identity);
  useEffect(() => {
    if (identityRef.current === identity) return;
    identityRef.current = identity;
    setAnchor(null);
    setAtPointer(false);
    setRadialPage(0);
    radialHoverRef.current?.(null);
    onOpenChange?.(false);
  }, [identity, onOpenChange]);
  // A right-click on the row hands in the pointer. Only a new point opens the
  // menu: a re-render with the same one must not reopen what was just closed.
  // Layout, not passive: the pointerdown that hands in `openAt` already fired
  // this frame, so the anchor must land before paint, not after.
  useLayoutEffect(() => {
    if (!openAt) return;
    onOpenChange?.(true);
    setRadialPage(0);
    setAtPointer(true);
    const size = radial ? radialSize : 0;
    setAnchor({
      top: radial
        ? Math.max(8, Math.min(window.innerHeight - size - 8, openAt.y - size / 2))
        : openAt.y,
      left: radial
        ? Math.max(8, Math.min(window.innerWidth - size - 8, openAt.x - size / 2))
        : Math.max(8, Math.min(window.innerWidth - 232, openAt.x)),
    });
  }, [openAt]);
  const open = (event) => {
    event.stopPropagation();
    setAtPointer(false);
    onOpenChange?.(true);
    const rect = event.currentTarget.getBoundingClientRect();
    const size = radial ? radialSize : 0;
    setRadialPage(0);
    setAnchor({
      top: radial
        ? Math.max(
          8,
          Math.min(
            window.innerHeight - size - 8,
            rect.top + rect.height / 2 - size / 2,
          ),
        )
        : rect.bottom + 6,
      left: radial
        ? Math.max(
          8,
          Math.min(
            window.innerWidth - size - 8,
            rect.left + rect.width / 2 - size / 2,
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
    const focused = document.activeElement;
    // A categorized wheel: arrows walk the inner ring, or the open arc when
    // focus is in it; Right, Enter or Space on a category fans it out and
    // enters it; Left goes back to the category (Escape too, see `dismiss`).
    const arc = categories ? focused?.closest?.("[data-radial-arc]") : null;
    const category = categories && !arc
      ? focused?.dataset?.radialCategory
      : null;
    if (arc && event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.querySelector(
        `[data-radial-category="${arc.dataset.radialArc}"]`,
      )?.focus();
      return;
    }
    if (category && ["ArrowRight", "Enter", " "].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      radialArcRef.current?.open(category, { focus: true });
      return;
    }
    const root = event.currentTarget;
    const buttons = categories
      ? [...(arc || root).querySelectorAll("button:not(:disabled)")].filter(
        (button) => arc || button.parentElement === root,
      )
      : [...root.querySelectorAll("button:not(:disabled)")];
    const index = buttons.indexOf(focused);
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
  // `inArc`: one of an open category's actions; reaching it keeps its arc.
  // Any other wedge folds an open arc away: at once on focus, after the
  // hover-intent wait on a pointer move.
  const radialButton = (item, clipPath, position, inArc = false) => {
    const { descriptor, entry: saved } = item;
    const Icon = descriptor.Icon;
    const color = quickActionColorFor(item.entry, config.palette);
    const arc = () => radialArcRef.current;
    const enter = () => {
      radialHoverRef.current?.(saved.id);
      if (inArc) arc()?.hold();
      else arc()?.open(null, { intent: true });
    };
    // The focus the menu hands its first wedge on opening names nothing: the
    // pointer is still on the center.
    const focus = () => {
      if (!openingFocusRef.current) radialHoverRef.current?.(saved.id);
      if (!inArc) arc()?.open(null);
    };
    const leave = () => radialHoverRef.current?.(null);
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
        disabled={!!descriptor.disabled}
        style={{
          clipPath,
          ...(color ? { "--quick-action-color": color } : {}),
        }}
        onMouseEnter={enter}
        onMouseLeave={leave}
        onFocus={focus}
        onClick={(event) => activate(item, event)}
      >
        <span
          className="quick-action-radial-content"
          style={position}
        >
          {Icon && <Icon size={categories ? 22 : 19} aria-hidden="true" />}
        </span>
      </button>
    );
  };
  const categoryButton = (wedge, index, count) => {
    const Icon = wedge.Icon;
    const fanOut = (intent = false) =>
      radialArcRef.current?.open(wedge.category, { intent });
    return (
      <button
        key={`category:${wedge.category}`}
        type="button"
        role="menuitem"
        aria-haspopup="true"
        className="quick-action-radial-item quick-action-radial-category"
        data-radial-category={wedge.category}
        aria-label={wedge.label}
        style={{ clipPath: wedgeClip(index, count, INNER_RING) }}
        onMouseEnter={() => {
          radialHoverRef.current?.(`category:${wedge.category}`);
          fanOut(true);
        }}
        onMouseLeave={() => radialHoverRef.current?.(null)}
        onFocus={() => {
          if (openingFocusRef.current) return;
          radialHoverRef.current?.(`category:${wedge.category}`);
          fanOut();
        }}
        onClick={(event) => {
          event.stopPropagation();
          fanOut();
        }}
      >
        <span
          className="quick-action-radial-content"
          style={radialContentPosition(index, count, INNER_RING.content)}
        >
          {Icon && <Icon size={22} aria-hidden="true" />}
        </span>
      </button>
    );
  };
  if (!configured.length && !renderExtra) return null;
  const panelStyle = radial
    ? {
      top: anchor?.top || 0,
      left: anchor?.left || 0,
      width: radialSize,
      height: radialSize,
    }
    : {
      top: anchor?.top || 0,
      left: anchor?.left || 0,
      width: 224,
      maxHeight: "min(70vh, 520px)",
      overflowY: "auto",
    };
  const changePage = (next) => {
    radialHoverRef.current?.(null);
    setRadialPage(next);
  };
  const wheel = (
    <>
      {categories
        ? inner.map((wedge, index) =>
          wedge.item
            ? radialButton(
              wedge.item,
              wedgeClip(index, inner.length, INNER_RING),
              radialContentPosition(index, inner.length, INNER_RING.content),
            )
            : categoryButton(wedge, index, inner.length)
        )
        : menuEntries.map((item, index) =>
          radialButton(
            item,
            wedgeClip(index, menuEntries.length),
            radialContentPosition(index, menuEntries.length),
          )
        )}
      {categories && (
        <RadialArc
          arcRef={radialArcRef}
          inner={inner}
          renderItem={(item, clipPath, position) =>
            radialButton(item, clipPath, position, true)}
        />
      )}
      <RadialCenter
        hoverRef={radialHoverRef}
        menuEntries={centerEntries}
        page={page}
        pageCount={pageCount}
        onPrevPage={() => changePage(page - 1)}
        onNextPage={() => changePage(page + 1)}
        previousPageLabel={t("quickActions.previousPage")}
        nextPageLabel={t("quickActions.nextPage")}
      />
    </>
  );
  // Leaving a categorized wheel folds its arc away.
  const foldArc = categories ? () => radialArcRef.current?.open(null) : undefined;
  // The see-through band between the inner ring and the wheel's edge is still
  // the panel, so a click there would land nowhere: close the menu, as a
  // click outside would. A click inside the inner disc (the center, a gap
  // between wedges) stays a miss.
  const panelClick = (event) => {
    event.stopPropagation();
    if (event.target !== event.currentTarget) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const distance = Math.hypot(
      event.clientX - (rect.left + rect.width / 2),
      event.clientY - (rect.top + rect.height / 2),
    );
    if (distance > rect.width * INNER_RING.outer / 100) close();
  };
  if (preview && radial) {
    return (
      <div
        ref={actionsRef}
        className="quick-actions-radial quick-actions-radial-preview"
        role="menu"
        aria-label={triggerText}
        data-radial-layout={categories ? "categories" : undefined}
        onKeyDown={onMenuKeyDown}
        onMouseLeave={foldArc}
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
        onClose={dismiss}
        handlesTab
        role="menu"
        aria-label={triggerText}
        onKeyDown={onMenuKeyDown}
        onMouseLeave={foldArc}
        {...(categories ? { onClick: panelClick } : {})}
        data-surface={surface}
        data-radial-layout={categories ? "categories" : undefined}
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
