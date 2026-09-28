// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { CATEGORY_WHEEL, QuickActions } from "../QuickActions";

const icon = () => <span aria-hidden="true">•</span>;
const descriptors = [
  {
    id: "archive",
    action: "archive",
    label: "Archive",
    Icon: icon,
    onActivate: vi.fn(),
  },
  {
    id: "reply",
    action: "reply",
    label: "Reply",
    Icon: icon,
    onActivate: vi.fn(),
  },
  {
    id: "delete",
    action: "delete",
    label: "Delete",
    Icon: icon,
    onActivate: vi.fn(),
    tone: "danger",
  },
];
const config = (mode, entries = descriptors, favoriteId = "archive") => ({
  mode,
  entries: entries.map(({ id, action }) => ({ id, action })),
  favoriteId,
  palette: "neutral",
});

afterEach(() => {
  cleanup();
  descriptors.forEach((item) => item.onActivate.mockClear());
});

describe("QuickActions", () => {
  it("renders configured entries in order and applies custom colors without replacing labels", () => {
    const { rerender } = render(
      <QuickActions
        config={{
          ...config("inline"),
          palette: "custom",
          entries: [
            { id: "reply", action: "reply", color: "#123456" },
            { id: "archive", action: "archive" },
          ],
        }}
        descriptors={descriptors}
      />,
    );
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Reply",
      "Archive",
    ]);
    expect(buttons[0].style.getPropertyValue("--quick-action-color")).toBe(
      "#123456",
    );
  });

  it("opens a menu and supports arrow, Home, and End navigation", () => {
    render(<QuickActions config={config("menu")} descriptors={descriptors} />);
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    const menu = screen.getByRole("menu");
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
  });

  it("runs an action once, stops row activation, and restores focus after dismissal", async () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <QuickActions
          config={config("favorite-menu")}
          descriptors={descriptors}
        />
      </div>,
    );
    const favorite = screen.getByRole("button", { name: "Archive" });
    fireEvent.click(favorite);
    expect(descriptors[0].onActivate).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Quick actions" }),
      )
    );
  });

  // A right-click on a row opens the row's actions at the pointer. Inline
  // mode draws some of them on the row already; the pointer menu offers all.
  it("opens every configured action at the pointer, once per right-click", async () => {
    const at = { x: 40, y: 60 };
    const { rerender } = render(
      <QuickActions config={config("inline")} descriptors={descriptors} inlineLimit={1} openAt={at} />,
    );
    const menu = screen.getByRole("menu");
    expect(menu.style.top).toBe("60px");
    expect(menu.style.left).toBe("40px");
    expect(screen.getAllByRole("menuitem").map((item) => item.getAttribute("aria-label")))
      .toEqual(["Archive", "Reply", "Delete"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // The same point again is a re-render, not a second right-click.
    rerender(<QuickActions config={config("inline")} descriptors={descriptors} inlineLimit={1} openAt={at} />);
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(<QuickActions config={config("inline")} descriptors={descriptors} inlineLimit={1} openAt={{ x: 40, y: 60 }} />);
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  // A row mounts its quick actions only once it is live, so a right-click on a
  // row nobody hovered (touch, the keyboard Menu key) mounts this component
  // with `openAt` already set, inside the pointer event itself.
  it("opens at the pointer when mounted by the right-click itself", () => {
    function Row() {
      const [at, setAt] = React.useState(null);
      return (
        <div data-testid="row" onPointerDown={(event) => setAt({ x: event.clientX, y: event.clientY })}>
          {at && <QuickActions config={config("radial")} descriptors={descriptors} identity="row-1" openAt={at} />}
        </div>
      );
    }
    render(<Row />);
    fireEvent.pointerDown(screen.getByTestId("row"), { button: 2, clientX: 200, clientY: 220 });
    // Open, not an exiting panel (AnimatePresence keeps role=menu through exit).
    expect(document.querySelector(".quick-actions-trigger").getAttribute("aria-expanded")).toBe("true");
  });

  it("uses a safe favorite fallback when the saved favorite is unavailable", () => {
    render(
      <QuickActions
        config={{ ...config("favorite-menu", descriptors, "missing") }}
        descriptors={descriptors}
      />,
    );
    expect(screen.getByRole("button", { name: "Archive" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("allows an explicitly chosen destructive favorite to route through its guarded handler", () => {
    render(
      <QuickActions
        config={config("favorite-menu", descriptors, "delete")}
        descriptors={descriptors}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(descriptors[2].onActivate).toHaveBeenCalledOnce();
  });

  it("does not substitute a different saved template or folder for a missing parameterized entry", () => {
    const parameterized = [
      {
        id: "replyTemplate:template-1",
        action: "replyTemplate",
        label: "Template one",
        Icon: icon,
        onActivate: vi.fn(),
      },
      {
        id: "move:account-a:Archive",
        action: "move",
        label: "Move to Archive",
        Icon: icon,
        onActivate: vi.fn(),
      },
    ];
    render(
      <QuickActions
        config={{
          mode: "inline",
          favoriteId: null,
          palette: "neutral",
          entries: [
            {
              id: "replyTemplate:template-2",
              action: "replyTemplate",
              params: { templateId: "template-2" },
            },
            {
              id: "move:account-b:Archive",
              action: "move",
              params: { accountId: "account-b", mailbox: "Archive" },
            },
          ],
        }}
        descriptors={parameterized}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(
      parameterized.every((item) => item.onActivate.mock.calls.length === 0),
    ).toBe(true);
  });

  it("keeps unavailable actions disabled and offers radial actions through keyboard", () => {
    const unavailable = [{
      id: "reply",
      action: "reply",
      label: "Reply",
      Icon: icon,
      disabled: true,
    }];
    render(
      <QuickActions
        config={config("radial", unavailable)}
        descriptors={unavailable}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "Reply" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("keeps a single wheel for many actions unless pagination is enabled", () => {
    const many = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `action-${index}`,
        action: "archive",
        label: `Action ${index}`,
        Icon: icon,
        onActivate: vi.fn(),
      }),
    );
    const entries = many.map(({ id, action }) => ({ id, action }));
    const { rerender } = render(
      <QuickActions
        config={{ mode: "radial", palette: "semantic", entries }}
        descriptors={many}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    expect(screen.getAllByRole("menuitem", { name: /Action/ })).toHaveLength(
      10,
    );

    rerender(
      <QuickActions
        config={{
          mode: "radial",
          palette: "semantic",
          radialPagination: true,
          entries,
        }}
        descriptors={many}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    expect(screen.queryByRole("menuitem", { name: "Action 9" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Next actions" }));
    expect(screen.getByRole("menuitem", { name: "Action 9" })).toBeTruthy();
  });

  it("moves focus to the first action on a newly selected preview wheel page", async () => {
    const many = Array.from(
      { length: 10 },
      (_, index) => ({
        id: `preview-${index}`,
        action: "archive",
        label: `Preview ${index}`,
        Icon: icon,
        onActivate: vi.fn(),
      }),
    );
    render(
      <QuickActions
        config={{
          mode: "radial",
          palette: "semantic",
          radialPagination: true,
          entries: many.map(({ id, action }) => ({ id, action })),
        }}
        descriptors={many}
        preview
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Next actions" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "Preview 8" }),
      )
    );
  });

  it("keeps colors stable when actions are reordered and puts inline overflow in a reachable menu", () => {
    const overflow = [...descriptors, {
      id: "forward",
      action: "forward",
      label: "Forward",
      Icon: icon,
      onActivate: vi.fn(),
    }];
    const base = {
      mode: "inline",
      palette: "semantic",
      entries: overflow.map(({ id, action }) => ({ id, action })),
    };
    const { rerender } = render(
      <QuickActions config={base} descriptors={overflow} inlineLimit={2} />,
    );
    const archiveColor = screen.getByRole("button", { name: "Archive" }).style
      .getPropertyValue("--quick-action-color");
    expect(screen.getByRole("button", { name: "Quick actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Forward" }));
    expect(overflow[3].onActivate).toHaveBeenCalledOnce();

    rerender(
      <QuickActions
        config={{ ...base, entries: [...base.entries].reverse() }}
        descriptors={overflow}
        inlineLimit={4}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Archive" }).style.getPropertyValue(
        "--quick-action-color",
      ),
    ).toBe(archiveColor);
  });

  it("fits selection actions to measured space while retaining every action in overflow", async () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function measuredRect() {
        return {
          width: this.classList?.contains("quick-action-button") ? 100 : 32,
          height: 32,
          top: 0,
          left: 0,
          right: 100,
          bottom: 32,
          x: 0,
          y: 0,
          toJSON() {},
        };
      });
    const actions = [...descriptors, {
      id: "forward",
      action: "forward",
      label: "Forward",
      Icon: icon,
      onActivate: vi.fn(),
    }];
    const { rerender } = render(
      <QuickActions
        surface="selection"
        config={{
          mode: "inline",
          palette: "semantic",
          entries: actions.map(({ id, action }) => ({ id, action })),
        }}
        descriptors={actions}
        inlineLimit={6}
        inlineAvailableWidth={150}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Archive" })).toHaveLength(1)
    );
    expect(screen.getByRole("button", { name: "Quick actions" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    expect(screen.getByRole("menuitem", { name: "Forward" })).toBeTruthy();
    rerender(
      <QuickActions
        surface="selection"
        config={{
          mode: "inline",
          palette: "semantic",
          entries: actions.map(({ id, action }) => ({ id, action })),
        }}
        descriptors={actions}
        inlineLimit={6}
        inlineAvailableWidth={500}
      />,
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Quick actions" })).toBeNull()
    );
    rect.mockRestore();
  });
});

describe("QuickActions radial categories", () => {
  let exportRenders = 0;
  // Counts how often the export wedge (a direct wedge the center never shows
  // unless it is hovered) renders: a hover elsewhere must not repaint it.
  const CountingIcon = () => {
    exportRenders += 1;
    return <span aria-hidden="true">•</span>;
  };
  const make = (id, label, extra = {}) => ({ id, action: id, label, Icon: icon, onActivate: vi.fn(), ...extra });
  const actions = () => [
    make("archive", "Archive"),
    make("reply", "Reply"),
    make("forward", "Forward"),
    make("star", "Star"),
    make("markRead", "Mark read"),
    make("deleteServer", "Delete from server"),
    make("spam", "Move to Junk"),
    make("export", "Export", { Icon: CountingIcon }),
  ];
  const categoryConfig = (list, overrides = {}) => ({
    mode: "radial",
    palette: "neutral",
    radialLayout: "categories",
    favoriteId: "archive",
    entries: list.map(({ id, action }) => ({ id, action })),
    ...overrides,
  });
  const openWheel = (list, overrides) => {
    render(<QuickActions config={categoryConfig(list, overrides)} descriptors={list} />);
    fireEvent.click(screen.getByRole("button", { name: "Quick actions" }));
    return screen.getByRole("menu");
  };
  const category = (id) => document.querySelector(`[data-radial-category="${id}"]`);
  const arcActions = () =>
    [...document.querySelectorAll("[data-radial-arc] [data-quick-action]")]
      .map((button) => button.getAttribute("aria-label"));
  const innerRing = (menu) =>
    [...menu.children].filter((element) => element.tagName === "BUTTON")
      .map((button) => button.dataset.radialCategory
        ? `category:${button.dataset.radialCategory}`
        : button.dataset.quickAction);
  const centerLabel = () => document.querySelector(".quick-actions-radial-center > span:not([aria-hidden])").textContent;
  const trigger = () => document.querySelector(".quick-actions-trigger");

  // Moving from one category to another while an arc is open waits this
  // long (hover intent); the tests step past it with fake timers.
  const pastSwapDelay = () => act(() => {
    vi.advanceTimersByTime(150);
  });
  const fakeTimers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  afterEach(() => {
    exportRenders = 0;
    vi.useRealTimers();
  });

  it("keeps the flat wheel exactly as before when the layout is flat", () => {
    const list = actions();
    const menu = openWheel(list, { radialLayout: "flat" });
    expect(innerRing(menu)).toEqual(list.map((item) => item.id));
    expect(document.querySelector("[data-radial-category]")).toBeNull();
    expect(menu.getAttribute("data-radial-layout")).not.toBe("categories");
    expect(centerLabel()).toBe("");
    fireEvent.click(menu, { clientX: 2, clientY: 2 });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
  });

  it("draws one wedge per non-empty category, single ones as direct wedges", () => {
    const menu = openWheel(actions());
    // Organize and More hold only archive and export, so each is a direct
    // wedge in its category's slot.
    expect(innerRing(menu)).toEqual(["category:send", "category:mark", "archive", "category:delete", "export"]);
    expect(category("send").getAttribute("aria-label")).toBe("Send");
    expect(category("send").hasAttribute("data-quick-action")).toBe(false);
    expect(arcActions()).toEqual([]);
  });

  it("does not fan a category out just because the opening focus landed on it", () => {
    const menu = openWheel(actions(), { favoriteId: "missing" });
    expect(innerRing(menu)[0]).toBe("category:send");
    expect(document.activeElement).toBe(category("send"));
    expect(arcActions()).toEqual([]);
  });

  it("keeps the favorite out of the wheel, also once a category is open", () => {
    // Organize holds archive (the favorite) and unarchive: both stay in its arc.
    const list = [...actions(), make("unarchive", "Unarchive")];
    const menu = openWheel(list);
    expect(innerRing(menu)).toEqual(["category:send", "category:mark", "category:organize", "category:delete", "export"]);
    expect([...menu.children].some((element) => element.dataset.quickAction === "archive")).toBe(false);
    fireEvent.mouseEnter(category("send"));
    expect(innerRing(menu)).toEqual(["category:send", "category:mark", "category:organize", "category:delete", "export"]);
    expect(menu.querySelector('[data-quick-action="archive"]')).toBeNull();
    fireEvent.click(category("organize"));
    expect(arcActions()).toEqual(["Archive", "Unarchive"]);
  });

  it("names nothing in the center until a wedge is hovered or focused", () => {
    const menu = openWheel(actions());
    // The opening focus lands on the first wedge, but the pointer is on the
    // center: no label, no icon.
    expect(centerLabel()).toBe("");
    expect(document.querySelector(".quick-actions-radial-center svg, .quick-actions-radial-center [aria-hidden]")).toBeNull();
    fireEvent.mouseEnter(category("mark"));
    expect(centerLabel()).toBe("Mark");
    fireEvent.mouseLeave(category("mark"));
    expect(centerLabel()).toBe("");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(centerLabel()).toBe("Mark");
  });

  it("makes every category and arc wedge nearly a whole band deep", () => {
    const px = (ring) => (ring.outer - ring.inner) * CATEGORY_WHEEL.size / 100;
    expect(px(CATEGORY_WHEEL.inner)).toBeGreaterThanOrEqual(58);
    expect(px(CATEGORY_WHEEL.arc)).toBeGreaterThanOrEqual(58);
    // The inner band starts right outside the 126px center disc.
    expect(CATEGORY_WHEEL.inner.inner * CATEGORY_WHEEL.size / 100).toBeGreaterThanOrEqual(63);
    expect(CATEGORY_WHEEL.arc.inner - CATEGORY_WHEEL.inner.outer).toBeLessThanOrEqual(2);
  });

  it("fans a category out on hover, swaps on another after a short hover, keeps it while in the arc, closes on leave", () => {
    fakeTimers();
    const menu = openWheel(actions());
    fireEvent.mouseEnter(category("send"));
    expect(arcActions()).toEqual(["Reply", "Forward"]);
    expect(category("send").hasAttribute("data-open")).toBe(true);
    expect(centerLabel()).toBe("Send");

    fireEvent.mouseEnter(category("mark"));
    expect(arcActions()).toEqual(["Reply", "Forward"]);
    pastSwapDelay();
    expect(arcActions()).toEqual(["Star", "Mark read"]);
    expect(category("send").hasAttribute("data-open")).toBe(false);
    expect(category("mark").hasAttribute("data-open")).toBe(true);

    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Star" }));
    expect(arcActions()).toEqual(["Star", "Mark read"]);
    expect(centerLabel()).toBe("Star");

    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Archive" }));
    pastSwapDelay();
    expect(arcActions()).toEqual([]);

    fireEvent.click(category("delete"));
    expect(arcActions()).toEqual(["Delete from server", "Move to Junk"]);
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    fireEvent.mouseLeave(menu);
    expect(arcActions()).toEqual([]);
  });

  it("keeps the open arc when the pointer crosses a neighbour category on its way into the arc", () => {
    fakeTimers();
    openWheel(actions());
    fireEvent.mouseEnter(category("send"));
    // A straight line from Send to its far arc item runs over Mark.
    fireEvent.mouseEnter(category("mark"));
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Forward" }));
    pastSwapDelay();
    expect(arcActions()).toEqual(["Reply", "Forward"]);
    expect(category("send").hasAttribute("data-open")).toBe(true);
    expect(category("mark").hasAttribute("data-open")).toBe(false);
    // Same for a direct wedge crossed on the way.
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Archive" }));
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Reply" }));
    pastSwapDelay();
    expect(arcActions()).toEqual(["Reply", "Forward"]);
  });

  it("stacks the category name above the hovered arc action in the center", () => {
    openWheel(actions());
    const group = () => document.querySelector(".quick-actions-radial-center-group");
    fireEvent.mouseEnter(category("send"));
    expect(centerLabel()).toBe("Send");
    expect(group()).toBeNull();
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Forward" }));
    expect(group().textContent).toBe("Send");
    expect(centerLabel()).toBe("Forward");
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Archive" }));
    expect(group()).toBeNull();
    expect(centerLabel()).toBe("Archive");
  });

  it("closes on a click in the empty band around the ring, not on one inside the disc", () => {
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 360, height: 360, top: 0, left: 0, right: 360, bottom: 360, x: 0, y: 0, toJSON() {},
    });
    try {
      const menu = openWheel(actions());
      fireEvent.click(menu, { clientX: 180, clientY: 180 });
      expect(trigger().getAttribute("aria-expanded")).toBe("true");
      fireEvent.click(menu, { clientX: 180, clientY: 6 });
      expect(trigger().getAttribute("aria-expanded")).toBe("false");
    } finally {
      rect.mockRestore();
    }
  });

  it("runs an arc action and closes the menu", () => {
    const list = actions();
    openWheel(list);
    fireEvent.mouseEnter(category("send"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Forward" }));
    expect(list[2].onActivate).toHaveBeenCalledOnce();
    expect(list[1].onActivate).not.toHaveBeenCalled();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("walks the inner ring with arrows, enters an arc with Right or Enter and leaves it with Left or Escape", () => {
    const menu = openWheel(actions());
    expect(document.activeElement).toBe(category("send"));
    // Arrows stay on the inner ring, even with an arc open beside it.
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(category("mark"));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(category("send"));

    fireEvent.keyDown(menu, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Reply" }));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Forward" }));
    fireEvent.keyDown(menu, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(category("send"));

    fireEvent.keyDown(menu, { key: "Enter" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Reply" }));
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(document.activeElement).toBe(category("send"));
    expect(trigger().getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("repaints only the arc and the center when a category is hovered", () => {
    fakeTimers();
    openWheel(actions());
    const before = exportRenders;
    expect(before).toBeGreaterThan(0);
    fireEvent.mouseEnter(category("send"));
    fireEvent.mouseEnter(category("mark"));
    pastSwapDelay();
    fireEvent.mouseEnter(screen.getByRole("menuitem", { name: "Star" }));
    fireEvent.mouseEnter(category("delete"));
    pastSwapDelay();
    expect(arcActions()).toEqual(["Delete from server", "Move to Junk"]);
    expect(exportRenders).toBe(before);
  });
});
