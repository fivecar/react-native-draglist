import React from "react";
import { FlatList, I18nManager, PanResponder, Text } from "react-native";
import TestRenderer, { act, ReactTestRenderer } from "react-test-renderer";
import DragList, { DragListRenderItemInfo } from "../index";

const DATA = ["alpha", "beta", "gamma"];
const ITEM_EXTENT = 100;
const LIST_EXTENT = 600;
// The cross-axis size of the list, i.e. the one the drag math ignores.
const LIST_BREADTH = 300;

type Config = Parameters<typeof PanResponder.create>[0];

const renderers: ReactTestRenderer[] = [];

interface Harness {
  renderer: ReactTestRenderer;
  config: Config;
  infos: { [key: string]: DragListRenderItemInfo<string> };
  renderItemCalls: { count: number };
  update: (data: string[]) => void;
  layoutCells: () => void;
  layoutWrapper: () => void;
  scroll: (
    cartesianOffset: number,
    contentLength: number,
    contentInset?: Partial<{
      top: number;
      bottom: number;
      left: number;
      right: number;
    }>
  ) => void;
  // Reports a new main-axis content length, as a list without getItemLayout
  // does when mounting rows revises its estimate.
  growContent: (contentLength: number) => void;
  flatList: () => ReturnType<ReactTestRenderer["root"]["findByType"]>;
}

function renderDragList(props: {
  data?: string[];
  horizontal?: boolean;
  onDragBegin?: () => void;
  onDragEnd?: () => void;
  onHoverChanged?: (hoverIndex: number) => void;
  onReordered?: (from: number, to: number) => Promise<void> | void;
  scrollEnabled?: boolean;
}): Harness {
  const horizontal = !!props.horizontal;
  // Under RTL, Yoga mirrors a horizontal row, so index 0 lands at the far end
  // of the axis and positions descend from there.
  const mirrored = horizontal && I18nManager.isRTL;
  // The rect the wrapper's measure() and onLayout report.
  const wrapRect = horizontal
    ? { width: LIST_EXTENT, height: LIST_BREADTH }
    : { width: LIST_BREADTH, height: LIST_EXTENT };
  const realCreate = PanResponder.create.bind(PanResponder);
  let config: Config | undefined;
  jest
    .spyOn(PanResponder, "create")
    .mockImplementation((cfg: Config) => {
      config = cfg;
      return realCreate(cfg);
    });

  const infos: { [key: string]: DragListRenderItemInfo<string> } = {};
  const renderItemCalls = { count: 0 };
  const renderItem = (info: DragListRenderItemInfo<string>) => {
    renderItemCalls.count++;
    infos[info.item] = info;
    return <Text>{info.item}</Text>;
  };

  function element(data: string[]) {
    return (
      <DragList
        data={data}
        horizontal={horizontal}
        keyExtractor={(item: string) => item}
        renderItem={renderItem}
        onDragBegin={props.onDragBegin}
        onDragEnd={props.onDragEnd}
        onHoverChanged={props.onHoverChanged}
        onReordered={props.onReordered}
        scrollEnabled={props.scrollEnabled}
      />
    );
  }

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element(props.data ?? DATA), {
      createNodeMock: () => ({
        measure: (
          cb: (
            x: number,
            y: number,
            w: number,
            h: number,
            pageX: number,
            pageY: number
          ) => void
        ) => cb(0, 0, wrapRect.width, wrapRect.height, 0, 0),
      }),
    });
  });
  renderers.push(renderer);

  // RN's jest setup stubs instance measure() as a bare jest.fn() that never
  // invokes its callback, which leaves DragList's wrapper measurement hanging.
  // Replace it with one that reports a real window rect.
  function patchMeasure() {
    renderer.root
      .findAll(node => node.instance && typeof node.instance.measure === "function")
      .forEach(node => {
        node.instance.measure = (
          cb: (
            x: number,
            y: number,
            w: number,
            h: number,
            pageX: number,
            pageY: number
          ) => void
        ) => cb(0, 0, wrapRect.width, wrapRect.height, 0, 0);
      });
  }
  patchMeasure();

  // VirtualizedList's metrics aggregator refuses to resolve cell offsets
  // until it knows the content size, because under RTL it mirrors them
  // against the content length. Real lists always report this first.
  function layoutContent(contentLength?: number) {
    // DragList passes its own onContentSizeChange down (VirtualizedList
    // chains it), so several nodes match. The innermost is the scroll view,
    // and only its handler runs VirtualizedList's own bookkeeping.
    const matches = renderer.root.findAll(
      node => typeof node.props?.onContentSizeChange === "function"
    );
    const scrollView = matches[matches.length - 1];
    const main = contentLength ?? (horizontal ? wrapRect.width : wrapRect.height);
    act(() => {
      scrollView.props.onContentSizeChange(
        horizontal ? main : wrapRect.width,
        horizontal ? wrapRect.height : main
      );
    });
  }

  const harness: Harness = {
    renderer,
    // PanResponder.create runs inside a useRef initializer, so the config is
    // captured during the initial render and never replaced.
    config: config!,
    infos,
    renderItemCalls,
    update: (data: string[]) => {
      act(() => {
        renderer.update(element(data));
      });
    },
    // Simulates onLayout on the outer wrapper View (which holds the pan
    // handlers) so flatWrapLayout gets a real extent.
    layoutWrapper: () => {
      const wrapper = renderer.root.findAll(
        node =>
          typeof node.type === "string" &&
          !!node.props.onStartShouldSetResponder &&
          !!node.props.onLayout
      )[0];
      act(() => {
        wrapper.props.onLayout({
          nativeEvent: {
            layout: { x: 0, y: 0, ...wrapRect },
          },
        });
      });
    },
    // Fires onLayout on each cell so the internal layout cache is populated.
    layoutCells: () => {
      layoutContent();
      const cells = renderer.root.findAll(
        node =>
          typeof node.type === "function" &&
          node.type.name === "CellRendererComponent"
      );
      cells.forEach(cell => {
        const index = cell.props.index;
        const view = cell.findAll(
          node =>
            typeof node.type === "string" &&
            typeof node.props.onLayout === "function"
        )[0];
        const pos = mirrored
          ? LIST_EXTENT - (index + 1) * ITEM_EXTENT
          : index * ITEM_EXTENT;
        act(() => {
          view.props.onLayout({
            nativeEvent: {
              layout: horizontal
                ? { x: pos, y: 0, width: ITEM_EXTENT, height: LIST_BREADTH }
                : { x: 0, y: pos, width: LIST_BREADTH, height: ITEM_EXTENT },
            },
          });
        });
      });
    },
    // Reports a scroll at `cartesianOffset` (what contentOffset carries: an
    // offset from the origin of the axis, regardless of layout direction).
    scroll: (cartesianOffset, contentLength, contentInset) => {
      act(() => {
        harness.flatList().props.onScroll({
          nativeEvent: {
            contentOffset: horizontal
              ? { x: cartesianOffset, y: 0 }
              : { x: 0, y: cartesianOffset },
            contentSize: horizontal
              ? { width: contentLength, height: LIST_BREADTH }
              : { width: LIST_BREADTH, height: contentLength },
            layoutMeasurement: wrapRect,
            contentInset: { top: 0, bottom: 0, left: 0, right: 0, ...contentInset },
          },
        });
      });
    },
    growContent: contentLength => layoutContent(contentLength),
    flatList: () => renderer.root.findByType(FlatList),
  };
  return harness;
}

// Starts a drag on DATA[0] and grants the pan responder, centered on item 0.
// The default touch point suits a vertical list; horizontal ones pass their
// own, since item 0 doesn't sit at the origin under a mirrored layout.
async function startGrantedDrag(
  harness: Harness,
  origin: { x0: number; y0: number } = { x0: 0, y0: ITEM_EXTENT / 2 }
) {
  harness.layoutWrapper();
  harness.layoutCells();
  await act(async () => {
    harness.infos["alpha"].onDragStart();
  });
  await act(async () => {
    harness.config.onPanResponderGrant?.(
      {} as any,
      { ...origin, dx: 0, dy: 0 } as any
    );
  });
}

const ORIGINAL_RTL = I18nManager.isRTL;

// Auto-scroll runs on requestAnimationFrame, so tests drive it a frame at a
// time. RN's jest setup routes rAF through a zero-delay setTimeout, which
// under fake timers would re-enter forever inside a single advanceTimersByTime
// (and never move the clock the loop integrates against).
const frameQueue = new Map<number, FrameRequestCallback>();
let nextFrameHandle = 1;

function installFrameQueue() {
  frameQueue.clear();
  jest
    .spyOn(global, "requestAnimationFrame")
    .mockImplementation((callback: FrameRequestCallback) => {
      const handle = nextFrameHandle++;
      frameQueue.set(handle, callback);
      return handle;
    });
  jest
    .spyOn(global, "cancelAnimationFrame")
    .mockImplementation((handle: number) => {
      frameQueue.delete(handle);
    });
}

// Advances the clock and runs whatever frames were pending when it started, so
// a callback that schedules the next frame doesn't run within the same tick.
function advanceFrames(count: number, millisPerFrame = 16) {
  for (let i = 0; i < count; i++) {
    const pending = [...frameQueue];
    pending.forEach(([handle]) => frameQueue.delete(handle));
    jest.advanceTimersByTime(millisPerFrame);
    act(() => {
      pending.forEach(([, callback]) => callback(Date.now()));
    });
  }
}

beforeEach(() => {
  // Fake timers keep the slide/pan Animated timers from firing after teardown.
  jest.useFakeTimers();
});

afterEach(() => {
  (I18nManager as { isRTL: boolean }).isRTL = ORIGINAL_RTL;
  renderers.forEach(renderer => {
    act(() => renderer.unmount());
  });
  renderers.length = 0;
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("responder termination (bug: zombified drags)", () => {
  it("declines termination requests while a drag is active", async () => {
    const harness = renderDragList({});
    await startGrantedDrag(harness);

    expect(harness.config.onPanResponderTerminationRequest).toBeDefined();
    expect(
      harness.config.onPanResponderTerminationRequest?.(
        {} as any,
        { x0: 0, y0: 50, dx: 10, dy: 0 } as any
      )
    ).toBe(false);
  });

  it("tears down the drag and fires onDragEnd when the responder is terminated", async () => {
    const onDragEnd = jest.fn();
    const harness = renderDragList({ onDragEnd });
    await startGrantedDrag(harness);

    expect(harness.config.onPanResponderTerminate).toBeDefined();
    await act(async () => {
      harness.config.onPanResponderTerminate?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 0 } as any
      );
    });

    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(
      Object.values(harness.infos).every(info => !info.isActive)
    ).toBe(true);
    expect(harness.flatList().props.scrollEnabled).toBe(true);
  });

  it("commits the reorder at the current hover index when terminated mid-drag", async () => {
    const onReordered = jest.fn().mockResolvedValue(undefined);
    const onDragEnd = jest.fn();
    const harness = renderDragList({ onReordered, onDragEnd });
    await startGrantedDrag(harness);

    // Drag item 0 down past the middle of item 1.
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderTerminate?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });

    expect(onReordered).toHaveBeenCalledWith(0, 1);
    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });
});

describe("mid-drag data changes", () => {
  it("fires onDragEnd when a data change kills a live drag", async () => {
    const onDragBegin = jest.fn();
    const onDragEnd = jest.fn();
    const harness = renderDragList({ onDragBegin, onDragEnd });
    await startGrantedDrag(harness);
    expect(onDragBegin).toHaveBeenCalledTimes(1);
    expect(onDragEnd).not.toHaveBeenCalled();

    harness.update([...DATA]); // New array identity kills the drag

    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(
      Object.values(harness.infos).every(info => !info.isActive)
    ).toBe(true);
  });

  it("fires onDragEnd exactly once when a release-reorder is followed by the parent echoing new data", async () => {
    const onDragEnd = jest.fn();
    const reordered: number[][] = [];
    const harness = renderDragList({
      onDragEnd,
      onReordered: (from, to) => {
        reordered.push([from, to]);
      },
    });
    await startGrantedDrag(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    expect(reordered).toEqual([[0, 1]]);

    // Parent applies the reorder and hands back a new array.
    harness.update(["beta", "alpha", "gamma"]);

    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("fires the owed onDragEnd when the list unmounts mid-drag", async () => {
    // A parent may unmount the list while a drag is live (e.g. hiding it based
    // on other state) before any release/terminate event or data change
    // arrives. The onDragBegin/onDragEnd pairing guarantee must still hold, or
    // hosts tracking isDragging via these callbacks get stuck.
    const onDragBegin = jest.fn();
    const onDragEnd = jest.fn();
    const harness = renderDragList({ onDragBegin, onDragEnd });
    await startGrantedDrag(harness);
    expect(onDragBegin).toHaveBeenCalledTimes(1);
    expect(onDragEnd).not.toHaveBeenCalled();

    act(() => {
      harness.renderer.unmount();
    });

    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("does not fire onDragEnd again on unmount after a drag already ended", async () => {
    const onDragEnd = jest.fn();
    const harness = renderDragList({ onDragEnd });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 0 } as any
      );
    });
    expect(onDragEnd).toHaveBeenCalledTimes(1);

    act(() => {
      harness.renderer.unmount();
    });

    expect(onDragEnd).toHaveBeenCalledTimes(1);
  });

  it("fires onDragEnd on release even when nothing was reordered", async () => {
    const onDragEnd = jest.fn();
    const harness = renderDragList({ onDragEnd });
    await startGrantedDrag(harness);

    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 0 } as any
      );
    });

    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(
      Object.values(harness.infos).every(info => !info.isActive)
    ).toBe(true);
  });
});

describe("atomic transform resets (bug: drop flashes at old position)", () => {
  function cellTransforms(harness: Harness): Array<{ [k: string]: any }> {
    const cells = harness.renderer.root.findAll(
      node =>
        typeof node.type === "function" &&
        node.type.name === "CellRendererComponent"
    );
    // Inspect the composite Animated.View's props (NOT the host view): the
    // host receives resolved numbers either way, but the composite props show
    // whether the transform is a live Animated node or a plain number. Only a
    // plain number is applied atomically with the layout commit.
    return cells.map(cell => {
      const animatedView = cell.findAll(
        (node: any) =>
          typeof node.type !== "string" &&
          node.props &&
          typeof node.props.onLayout === "function" &&
          node.props.style
      )[0];
      const flat = [animatedView.props.style]
        .flat(Infinity)
        .filter(Boolean)
        .reduce((acc: any, s: any) => ({ ...acc, ...s }), {});
      return flat.transform?.[0] ?? {};
    });
  }

  it("renders idle cells with a static zero transform (no Animated node)", () => {
    const harness = renderDragList({});
    for (const transform of cellTransforms(harness)) {
      expect(transform).toEqual({ translateY: 0 });
    }
  });

  it("renders every cell with a static zero transform in the commit that applies reordered data", async () => {
    const harness = renderDragList({ onReordered: () => {} });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    harness.update(["beta", "alpha", "gamma"]);

    for (const transform of cellTransforms(harness)) {
      expect(transform).toEqual({ translateY: 0 });
    }
  });

  it("tears down the drag via the grace fallback when the parent never echoes new data after onReordered", async () => {
    const onDragEnd = jest.fn();
    const harness = renderDragList({ onDragEnd, onReordered: () => {} });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    // Parent deliberately does NOT update data. onDragEnd is owed at release
    // regardless, but the visual teardown waits for the grace period.
    expect(onDragEnd).toHaveBeenCalledTimes(1);

    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    expect(
      Object.values(harness.infos).every(info => !info.isActive)
    ).toBe(true);
    expect(harness.flatList().props.scrollEnabled).toBe(true);
  });

  it("holds the drag state after onReordered resolves instead of resetting before the parent's data arrives", async () => {
    // Parents backed by async/debounced stores hand back new data later than
    // the microtask queue. Resetting the moment onReordered resolves would
    // snap the item back and then jump it once data arrives; instead the
    // reset waits (within a grace period) for the data change, which tears
    // down atomically in the same commit as the move.
    const harness = renderDragList({ onReordered: () => {} });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });

    // No data change and no grace expiry yet: the drag visuals must be held.
    expect(
      Object.values(harness.infos).some(info => info.isActive)
    ).toBe(true);

    // The (late) data change still resets atomically.
    harness.update(["beta", "alpha", "gamma"]);
    expect(
      Object.values(harness.infos).every(info => !info.isActive)
    ).toBe(true);
  });

  it("resets immediately after a moved drop when no onReordered is provided", async () => {
    // Without an onReordered callback, no parent can possibly echo new data,
    // so the grace window would just hold the list unscrollable for nothing.
    const harness = renderDragList({});
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });

    expect(
      Object.values(harness.infos).every(info => !info.isActive)
    ).toBe(true);
    expect(harness.flatList().props.scrollEnabled).toBe(true);
  });

  it("does not capture the pan responder during the grace window", async () => {
    // activeDataRef stays set while we wait for the parent's data, but a
    // stray touch must not be captured as a pan of the old held item — that
    // could fire a second onReordered with stale indices.
    const harness = renderDragList({ onReordered: () => {} });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    // Parent hasn't echoed data yet: grace window is open.

    expect(
      harness.config.onStartShouldSetPanResponderCapture?.(
        {} as any,
        { x0: 0, y0: 250, dx: 0, dy: 0 } as any
      )
    ).toBe(false);
  });

  it("recovers when a drag started during the grace window is released without movement", async () => {
    // Starting a new drag disarms the grace fallback. If that drag then ends
    // before the responder is granted (press without movement), the teardown
    // must not be blocked by grant state left over from the previous drag.
    const harness = renderDragList({ onReordered: () => {} });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });

    // Press a row during the grace window, then release without moving.
    await act(async () => {
      harness.infos["gamma"].onDragStart();
    });
    await act(async () => {
      harness.infos["gamma"].onDragEnd();
    });
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    expect(
      Object.values(harness.infos).every(info => !info.isActive)
    ).toBe(true);
    expect(harness.flatList().props.scrollEnabled).toBe(true);
  });

  it("does not tear down a drag that superseded the released one during an async onReordered", async () => {
    // While onReordered is still awaiting, presses reach rows (only responder
    // capture is blocked), so a user can start a new drag. The release's
    // finally-block teardown must recognize it no longer owns the drag state
    // and leave the superseding drag alone — neither arming a grace timer
    // against it nor resetting it.
    let resolveReorder!: () => void;
    const harness = renderDragList({
      onReordered: () =>
        new Promise<void>(resolve => {
          resolveReorder = resolve;
        }),
    });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });

    // onReordered is still pending; the user starts a new drag.
    await act(async () => {
      harness.infos["gamma"].onDragStart();
    });
    await act(async () => {
      resolveReorder();
    });
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    expect(harness.infos["gamma"].isActive).toBe(true);
    // The new drag must also be capturable (no pending grace timer blocking).
    expect(
      harness.config.onStartShouldSetPanResponderCapture?.(
        {} as any,
        { x0: 0, y0: 250, dx: 0, dy: 0 } as any
      )
    ).toBe(true);
  });

  it("does not let a stale grace timer kill a subsequent drag", async () => {
    const harness = renderDragList({ onReordered: () => {} });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    // Parent echoes the reorder; the pending grace timer must be disarmed.
    harness.update(["beta", "alpha", "gamma"]);

    // Start a new drag, then let any stale timer fire.
    await act(async () => {
      harness.infos["gamma"].onDragStart();
    });
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });

    expect(harness.infos["gamma"].isActive).toBe(true);
  });
});

describe("idle stacking resets (bug: raw elevation/zIndex ignored on RN 0.76.3+)", () => {
  // Returns the flattened {elevation, zIndex} of each cell's composite
  // Animated.View, without resolving Animated nodes to numbers.
  function cellStackingStyles(harness: Harness): Array<{ [k: string]: any }> {
    const cells = harness.renderer.root.findAll(
      node =>
        typeof node.type === "function" &&
        node.type.name === "CellRendererComponent"
    );
    return cells.map(cell => {
      const animatedView = cell.findAll(
        (node: any) =>
          typeof node.type !== "string" &&
          node.props &&
          typeof node.props.onLayout === "function" &&
          node.props.style
      )[0];
      const flat = [animatedView.props.style]
        .flat(Infinity)
        .filter(Boolean)
        .reduce((acc: any, s: any) => ({ ...acc, ...s }), {});
      return { elevation: flat.elevation, zIndex: flat.zIndex };
    });
  }

  it("resets elevation and zIndex via Animated values in the commit that applies reordered data", async () => {
    // On RN 0.76.3+, raw numbers for elevation/zIndex on an Animated.View
    // don't take effect (see issue #53). After a dragged cell rendered with
    // Animated ONE/999, returning to idle with raw zeros can leave stale
    // native stacking, so the idle branch must keep these on Animated values.
    const harness = renderDragList({ onReordered: () => {} });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    harness.update(["beta", "alpha", "gamma"]);

    for (const style of cellStackingStyles(harness)) {
      expect(typeof style.elevation).not.toBe("number");
      expect(style.elevation?.__getValue?.()).toBe(0);
      expect(typeof style.zIndex).not.toBe("number");
      expect(style.zIndex?.__getValue?.()).toBe(0);
    }
  });
});

describe("hover changes don't re-render rows (perf)", () => {
  // Returns the flattened transform of the composite Animated.View inside the
  // cell that renders `item`, without resolving Animated nodes to numbers.
  function cellTransform(harness: Harness, item: string): any {
    const cells = harness.renderer.root.findAll(
      node =>
        typeof node.type === "function" &&
        node.type.name === "CellRendererComponent"
    );
    const cell = cells.find(c => c.props.item === item)!;
    const animatedView = cell.findAll(
      (node: any) =>
        typeof node.type !== "string" &&
        node.props &&
        typeof node.props.onLayout === "function" &&
        node.props.style
    )[0];
    const flat = [animatedView.props.style]
      .flat(Infinity)
      .filter(Boolean)
      .reduce((acc: any, s: any) => ({ ...acc, ...s }), {});
    return flat.transform?.[0] ?? {};
  }

  it("does not re-invoke renderItem when the hover index changes mid-drag", async () => {
    const harness = renderDragList({});
    await startGrantedDrag(harness);

    const callsBefore = harness.renderItemCalls.count;
    // Drag item 0 down past the middle of item 1 (hover index 0 -> 1).
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });

    expect(harness.renderItemCalls.count).toBe(callsBefore);
  });

  it("still slides the displaced neighbor when the hover index changes", async () => {
    const harness = renderDragList({});
    await startGrantedDrag(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    // Let the 200ms slide animation finish.
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    const transform = cellTransform(harness, "beta");
    const value = transform.translateY;
    // Mid-drag, the neighbor's transform is a live Animated value; item 0
    // moving down past beta means beta slides up by one item extent.
    expect(value?.__getValue?.()).toBe(-ITEM_EXTENT);
  });

  it("still fires onHoverChanged with the new hover index", async () => {
    const onHoverChanged = jest.fn();
    const harness = renderDragList({ onHoverChanged });
    await startGrantedDrag(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });

    expect(onHoverChanged).toHaveBeenCalledWith(1);
  });

  it("slides a neighbor back when the hover index moves away again", async () => {
    const harness = renderDragList({});
    await startGrantedDrag(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    // Back to hovering over its own slot.
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 0 } as any
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    const transform = cellTransform(harness, "beta");
    const value = transform.translateY;
    const resolved =
      typeof value === "number" ? value : value?.__getValue?.();
    expect(resolved).toBe(0);
  });
});

describe("mirrored layouts (bug: RTL horizontal drags are frozen)", () => {
  // Under RTL, Yoga mirrors the row so item 0 sits at the far right and
  // cached positions descend with index. Walking the axis in coordinate
  // order then pinned the hover index at 0 for the whole drag: the gap never
  // followed your finger, neighbors slid away from the vacated slot instead
  // of into it, and every drop reordered to index 0.
  function cellTransform(harness: Harness, item: string): any {
    const cells = harness.renderer.root.findAll(
      node =>
        typeof node.type === "function" &&
        node.type.name === "CellRendererComponent"
    );
    const cell = cells.find(c => c.props.item === item)!;
    // Horizontal lists hand CellRendererComponent its own `style` prop, so
    // the cell node itself matches this predicate and has to be excluded to
    // reach the Animated.View underneath.
    const animatedView = cell.findAll(
      (node: any) =>
        node !== cell &&
        typeof node.type !== "string" &&
        node.props &&
        typeof node.props.onLayout === "function" &&
        node.props.style
    )[0];
    const flat = [animatedView.props.style]
      .flat(Infinity)
      .filter(Boolean)
      .reduce((acc: any, s: any) => ({ ...acc, ...s }), {});
    return flat.transform?.[0] ?? {};
  }

  // Item 0's center: at the origin end of the axis for LTR, at the far end
  // for RTL.
  const LTR_ITEM0_CENTER = ITEM_EXTENT / 2;
  const RTL_ITEM0_CENTER = LIST_EXTENT - ITEM_EXTENT / 2;

  it("tracks the hover index across a mirrored horizontal drag", async () => {
    (I18nManager as { isRTL: boolean }).isRTL = true;
    const onHoverChanged = jest.fn();
    const harness = renderDragList({ horizontal: true, onHoverChanged });
    await startGrantedDrag(harness, { x0: RTL_ITEM0_CENTER, y0: 0 });

    // Under RTL, dragging leftward moves toward later indices.
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: RTL_ITEM0_CENTER, y0: 0, dx: -120, dy: 0 } as any
      );
    });

    expect(onHoverChanged).toHaveBeenCalledWith(1);
  });

  it("reorders to the dropped position rather than to index 0 under RTL", async () => {
    (I18nManager as { isRTL: boolean }).isRTL = true;
    const onReordered = jest.fn();
    const harness = renderDragList({ horizontal: true, onReordered });
    await startGrantedDrag(harness, { x0: RTL_ITEM0_CENTER, y0: 0 });

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: RTL_ITEM0_CENTER, y0: 0, dx: -120, dy: 0 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: RTL_ITEM0_CENTER, y0: 0, dx: -120, dy: 0 } as any
      );
    });

    expect(onReordered).toHaveBeenCalledWith(0, 1);
  });

  it("slides a displaced neighbor into the vacated slot under RTL", async () => {
    (I18nManager as { isRTL: boolean }).isRTL = true;
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: RTL_ITEM0_CENTER, y0: 0 });

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: RTL_ITEM0_CENTER, y0: 0, dx: -120, dy: 0 } as any
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    // alpha vacated the rightmost slot, so beta must slide right (toward
    // higher coordinates) to fill it. Sliding left would open the
    // double-width gap this bug was reported for.
    const value = cellTransform(harness, "beta").translateX;
    expect(value?.__getValue?.()).toBe(ITEM_EXTENT);
  });

  // A content length that overflows the viewport, so auto-scroll has
  // somewhere to go.
  const CONTENT_LENGTH = 2 * LIST_EXTENT;

  function spyOnScrollToOffset(harness: Harness) {
    const list = harness.flatList().instance as unknown as {
      scrollToOffset: (params: { animated?: boolean; offset: number }) => void;
    };
    return jest
      .spyOn(list, "scrollToOffset")
      .mockImplementation(() => undefined);
  }

  it("auto-scrolls a mirrored list by offsets measured from the start of the data", async () => {
    (I18nManager as { isRTL: boolean }).isRTL = true;
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: RTL_ITEM0_CENTER, y0: 0 });
    // Showing the very start of the data: under RTL that sits at the far end
    // of the axis, so contentOffset reads LIST_EXTENT while the offset
    // scrollToOffset wants is 0.
    harness.scroll(LIST_EXTENT, CONTENT_LENGTH);
    const scrollToOffset = spyOnScrollToOffset(harness);

    // Drag off the origin end of the axis, which under RTL means asking for
    // later items.
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: RTL_ITEM0_CENTER, y0: 0, dx: -RTL_ITEM0_CENTER, dy: 0 } as any
      );
    });
    advanceFrames(1);

    // Further into the data, i.e. an ascending flow offset. Passing the
    // cartesian position here instead makes VirtualizedList mirror an
    // already-mirrored number and fling the list most of its length.
    const [{ offset }] = scrollToOffset.mock.calls[0];
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(ITEM_EXTENT);
  });

  it("auto-scrolls a non-mirrored list by its cartesian offset", async () => {
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(LIST_EXTENT / 2, CONTENT_LENGTH);
    const scrollToOffset = spyOnScrollToOffset(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(1);

    const [{ offset }] = scrollToOffset.mock.calls[0];
    expect(offset).toBeGreaterThan(LIST_EXTENT / 2);
    expect(offset).toBeLessThan(LIST_EXTENT / 2 + ITEM_EXTENT);
  });

  it("advances a few pixels per frame instead of a whole item per tick", async () => {
    // The jump this replaced was one full item every 200ms, each an OS-
    // animated scroll interrupted by the next. Smoothness is the point: no
    // single frame may move the list anywhere near an item's worth.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(0, CONTENT_LENGTH);
    const scrollToOffset = spyOnScrollToOffset(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(5);

    const offsets = scrollToOffset.mock.calls.map(([params]) => params.offset);
    expect(offsets).toHaveLength(5);
    // Strictly increasing, in steps well under an item.
    offsets.forEach((offset, i) => {
      const previous = i === 0 ? 0 : offsets[i - 1];
      expect(offset).toBeGreaterThan(previous);
      expect(offset - previous).toBeLessThan(ITEM_EXTENT / 2);
    });
    expect(scrollToOffset).not.toHaveBeenCalledWith(
      expect.objectContaining({ animated: true })
    );
  });

  it("stops the frame loop at the end of the content instead of spinning", async () => {
    // Without the content-size clamp, the loop's own idea of the offset runs
    // away past the end of the list and keeps commanding scrolls forever.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    // Already scrolled to the last pixel of content.
    harness.scroll(CONTENT_LENGTH - LIST_EXTENT, CONTENT_LENGTH);
    const scrollToOffset = spyOnScrollToOffset(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(5);

    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it("tracks the hover index against the offset it commanded, not the last reported one", async () => {
    // onScroll reports lag the loop by a frame or more and arrive unevenly, so
    // drawing the drag against them jitters the dragged item and leaves the
    // last command before an end-of-list pin undrawn — a release then reorders
    // to a stale slot. Delivering no scroll reports at all makes the
    // distinction visible: the hover index must still advance.
    installFrameQueue();
    const onHoverChanged = jest.fn();
    // Enough items that the hover index has somewhere left to go once the
    // drag is already held past the edge.
    const harness = renderDragList({
      horizontal: true,
      data: ["alpha", ...Array.from({ length: 11 }, (_, i) => `item${i}`)],
      onHoverChanged,
    });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(0, CONTENT_LENGTH);
    spyOnScrollToOffset(harness);

    // Hold past the trailing edge. This alone puts the hover index partway
    // along; everything past that has to come from auto-scroll.
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    const hoverBeforeScrolling = onHoverChanged.mock.calls.at(-1)?.[0];
    advanceFrames(20);

    expect(onHoverChanged.mock.calls.at(-1)?.[0]).toBeGreaterThan(
      hoverBeforeScrolling
    );
  });

  it("keeps the commanded offset across a loop restart mid-drag", async () => {
    // Dipping back inside the list stops the loop, and crossing the edge again
    // restarts it. Reseeding from scrollPos there would command a position the
    // list has already scrolled past, jerking the drag backwards.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(0, CONTENT_LENGTH);
    const scrollToOffset = spyOnScrollToOffset(harness);

    const pastEdge = { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 };
    const insideList = { x0: LTR_ITEM0_CENTER, y0: 0, dx: 0, dy: 0 };
    await act(async () => {
      harness.config.onPanResponderMove?.({} as any, pastEdge as any);
    });
    advanceFrames(3);
    const beforeRestart = scrollToOffset.mock.calls.at(-1)![0].offset;

    // Back inside (loop stops), then past the edge again, without ever letting
    // an onScroll report land.
    await act(async () => {
      harness.config.onPanResponderMove?.({} as any, insideList as any);
    });
    await act(async () => {
      harness.config.onPanResponderMove?.({} as any, pastEdge as any);
    });
    advanceFrames(1);

    expect(scrollToOffset.mock.calls.at(-1)![0].offset).toBeGreaterThan(
      beforeRestart
    );
  });

  it("scrolls into a trailing content inset instead of pinning an inset early", async () => {
    // iOS lists with a trailing inset (an overlaid bar, an adjusted safe area)
    // can legally scroll past contentSize - viewport. Clamping without it
    // strands the last rows under whatever the inset was reserved for. Pairs
    // with the no-inset case above, which must still pin here.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(CONTENT_LENGTH - LIST_EXTENT, CONTENT_LENGTH, { right: 120 });
    const scrollToOffset = spyOnScrollToOffset(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(1);

    const [{ offset }] = scrollToOffset.mock.calls[0];
    expect(offset).toBeGreaterThan(CONTENT_LENGTH - LIST_EXTENT);
  });

  it("stays inside a leading content inset instead of snapping out of it", async () => {
    // A list resting inside a *leading* inset reports a negative offset, and
    // that's legal — iOS clamps to fmin(-contentInset.left, 0), not to 0. A
    // lower bound of 0 would command the list out of the inset on the drag's
    // very first frame, and since rendering draws against the commanded
    // offset, the dragged item lurches the width of the inset with it.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(-100, CONTENT_LENGTH, { left: 100 });
    const scrollToOffset = spyOnScrollToOffset(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(1);

    const [{ offset }] = scrollToOffset.mock.calls[0];
    expect(offset).toBeLessThan(0);
    expect(offset).toBeGreaterThan(-100);
  });

  it("scrolls into a leading content inset it didn't start inside", async () => {
    // The renderers clamp to fmin(-contentInset.left, 0), so a leading inset
    // is reachable even from a list resting at zero. Flooring at zero instead
    // strands the *first* rows under the overlay — the mirror image of the
    // trailing-inset case.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(0, CONTENT_LENGTH, { left: 100 });
    const scrollToOffset = spyOnScrollToOffset(harness);

    // Drag off the near edge, which scrolls back toward the start of the data.
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: -LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(1);

    const [{ offset }] = scrollToOffset.mock.calls[0];
    expect(offset).toBeLessThan(0);
  });

  it("counts a leading inset as slack at the far end too", async () => {
    // The renderers add fmax(contentInset.top, 0) to their own upper bound, so
    // a list with a leading inset can scroll that much further past its
    // content. Omitting the term pins short of the platform's real end.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(CONTENT_LENGTH - LIST_EXTENT, CONTENT_LENGTH, { left: 100 });
    const scrollToOffset = spyOnScrollToOffset(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(1);

    const [{ offset }] = scrollToOffset.mock.calls[0];
    expect(offset).toBeGreaterThan(CONTENT_LENGTH - LIST_EXTENT);
  });

  it("resumes when measured content grows past the bound it pinned against", async () => {
    // A list without getItemLayout revises its content size as rows mount,
    // which can push the far bound out from under a loop that already pinned
    // against the old estimate. A finger held past the edge produces no move
    // event, so the drag would stall short of the real end of the list.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    // Content barely longer than the viewport, so the loop pins almost at once.
    harness.scroll(0, LIST_EXTENT + 20);
    const scrollToOffset = spyOnScrollToOffset(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(10);

    const pinnedAt = scrollToOffset.mock.calls.at(-1)![0].offset;
    expect(pinnedAt).toBeCloseTo(20);

    // Confirm it really stopped scheduling frames rather than spinning.
    scrollToOffset.mockClear();
    advanceFrames(5);
    expect(scrollToOffset).not.toHaveBeenCalled();

    // More rows mount and the estimate grows, with no move event to follow.
    harness.growContent(LIST_EXTENT + 400);
    advanceFrames(5);

    expect(scrollToOffset.mock.calls.at(-1)?.[0].offset).toBeGreaterThan(
      pinnedAt
    );
  });

  it("tears the loop down when a host starts a new drag mid-scroll", async () => {
    // onDragStart is public API, so a host driving it from its own recognizer
    // can supersede a live drag without any release. A frame still in flight
    // would then repaint the new active item against the old drag's geometry.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(0, CONTENT_LENGTH);
    const scrollToOffset = spyOnScrollToOffset(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(3);
    expect(scrollToOffset).toHaveBeenCalled();
    scrollToOffset.mockClear();

    await act(async () => {
      harness.infos["gamma"].onDragStart();
    });
    advanceFrames(5);

    expect(scrollToOffset).not.toHaveBeenCalled();
  });

  it("does not inherit the commanded offset when a new drag supersedes a reorder", async () => {
    // A drag started while a reorder is still awaiting (or inside its grace
    // window) never went through reset, so the previous drag's auto-scroll
    // offsets are still around. Reading them against a grantScrollPosRef this
    // drag captured from scrollPos would displace the new item the moment you
    // moved it.
    installFrameQueue();
    const harness = renderDragList({ horizontal: true, onReordered: () => {} });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(0, CONTENT_LENGTH);
    spyOnScrollToOffset(harness);

    // Auto-scroll a good distance, never delivering a scroll report, so the
    // loop's offset ends up well ahead of what onScroll last said.
    const pastEdge = { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 };
    await act(async () => {
      harness.config.onPanResponderMove?.({} as any, pastEdge as any);
    });
    advanceFrames(10);
    await act(async () => {
      harness.config.onPanResponderRelease?.({} as any, pastEdge as any);
    });

    // The parent never echoes data, so the grace window holds the drag state.
    // Grab a different row mid-window and move it without any displacement.
    const gammaCenter = 2 * ITEM_EXTENT + ITEM_EXTENT / 2;
    await act(async () => {
      harness.infos["gamma"].onDragStart();
    });
    await act(async () => {
      harness.config.onPanResponderGrant?.(
        {} as any,
        { x0: gammaCenter, y0: 0, dx: 0, dy: 0 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: gammaCenter, y0: 0, dx: 0, dy: 0 } as any
      );
    });

    expect(cellTransform(harness, "gamma").translateX?.__getValue?.()).toBe(0);
  });

  it("disables native scrolling mid-drag even when the host asked for it", async () => {
    // The auto-scroll loop's offset is only authoritative because nothing else
    // moves the list while a drag is live. scrollEnabled used to sit before the
    // {...rest} spread, so a host passing scrollEnabled={true} silently kept
    // native scrolling on and could move the list out from under the loop with
    // a second finger.
    const harness = renderDragList({ scrollEnabled: true });
    expect(harness.flatList().props.scrollEnabled).toBe(true);

    await startGrantedDrag(harness);

    expect(harness.flatList().props.scrollEnabled).toBe(false);
  });

  it("stops auto-scrolling once the drag is released", async () => {
    installFrameQueue();
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });
    harness.scroll(0, CONTENT_LENGTH);
    const scrollToOffset = spyOnScrollToOffset(harness);

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(2);
    const callsBefore = scrollToOffset.mock.calls.length;

    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: LIST_EXTENT, dy: 0 } as any
      );
    });
    advanceFrames(5);

    expect(scrollToOffset.mock.calls.length).toBe(callsBefore);
  });

  it("still tracks the hover index in a non-mirrored horizontal drag", async () => {
    const onHoverChanged = jest.fn();
    const harness = renderDragList({ horizontal: true, onHoverChanged });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: 120, dy: 0 } as any
      );
    });

    expect(onHoverChanged).toHaveBeenCalledWith(1);
  });

  it("still slides a displaced neighbor backwards in a non-mirrored horizontal drag", async () => {
    const harness = renderDragList({ horizontal: true });
    await startGrantedDrag(harness, { x0: LTR_ITEM0_CENTER, y0: 0 });

    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: LTR_ITEM0_CENTER, y0: 0, dx: 120, dy: 0 } as any
      );
    });
    await act(async () => {
      jest.advanceTimersByTime(400);
    });

    const value = cellTransform(harness, "beta").translateX;
    expect(value?.__getValue?.()).toBe(-ITEM_EXTENT);
  });
});

describe("memoized rows (perf: parent re-renders don't re-invoke renderItem)", () => {
  // These tests render DragList directly (instead of via the harness) so we
  // control the identity of `data` and `renderItem` across updates.
  function makeElement(
    data: string[],
    renderItem: (info: DragListRenderItemInfo<string>) => React.ReactElement,
    keyExtractor: (item: string, index: number) => string = item => item,
    extraData?: any
  ) {
    return (
      <DragList
        data={data}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        extraData={extraData}
      />
    );
  }

  function countingRenderItem(calls: { [item: string]: number }) {
    return (info: DragListRenderItemInfo<string>) => {
      calls[info.item] = (calls[info.item] ?? 0) + 1;
      return <Text>{info.item}</Text>;
    };
  }

  it("does not re-invoke renderItem for unchanged items when data identity changes", () => {
    const calls: { [item: string]: number } = {};
    const renderItem = countingRenderItem(calls);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(makeElement(DATA, renderItem));
    });
    renderers.push(renderer);
    const callsBefore = { ...calls };

    // New array identity, same item identities: rows should not re-render.
    act(() => {
      renderer.update(makeElement([...DATA], renderItem));
    });

    expect(calls).toEqual(callsBefore);
  });

  it("re-invokes renderItem when the renderItem prop identity changes", () => {
    const calls: { [item: string]: number } = {};
    const renderItem = countingRenderItem(calls);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(makeElement(DATA, renderItem));
    });
    renderers.push(renderer);

    // A parent passing a new renderItem closure (e.g. it re-rendered with new
    // state the rows depend on) must always reach the rows.
    const calls2: { [item: string]: number } = {};
    const renderItem2 = countingRenderItem(calls2);
    act(() => {
      renderer.update(makeElement(DATA, renderItem2));
    });

    expect(Object.keys(calls2).sort()).toEqual([...DATA].sort());
  });

  it("re-invokes renderItem for an item whose identity changes", () => {
    const calls: { [item: string]: number } = {};
    const renderItem = countingRenderItem(calls);
    let renderer!: ReactTestRenderer;
    // Key by index so replacing an item keeps the same key (no remount) and
    // memoization must detect the item identity change itself.
    const keyByIndex = (_item: string, index: number) => String(index);
    act(() => {
      renderer = TestRenderer.create(
        makeElement(DATA, renderItem, keyByIndex)
      );
    });
    renderers.push(renderer);
    delete calls["beta"];

    act(() => {
      renderer.update(
        makeElement(["alpha", "beta-revised", "gamma"], renderItem, keyByIndex)
      );
    });

    expect(calls["beta-revised"]).toBe(1);
  });

  it("re-invokes renderItem for all rows when the host's extraData changes", () => {
    // FlatList's documented contract: hosts drive row updates from external
    // state (selection etc.) by changing extraData with a stable renderItem.
    // Memoization must not swallow those updates.
    const calls: { [item: string]: number } = {};
    const renderItem = countingRenderItem(calls);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        makeElement(DATA, renderItem, undefined, 1)
      );
    });
    renderers.push(renderer);
    const callsBefore = { ...calls };

    act(() => {
      renderer.update(makeElement(DATA, renderItem, undefined, 2));
    });

    for (const item of DATA) {
      expect(calls[item]).toBeGreaterThan(callsBefore[item]);
    }
  });

  it("re-invokes renderItem for existing rows when the list length changes", () => {
    // Parity with pre-memoization behavior, where renderDragItem depended on
    // data.length: rows whose output reads list length through refs still get
    // repainted when items are added or removed.
    const calls: { [item: string]: number } = {};
    const renderItem = countingRenderItem(calls);
    let renderer!: ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(makeElement(DATA, renderItem));
    });
    renderers.push(renderer);
    const callsBefore = { ...calls };

    act(() => {
      renderer.update(makeElement([...DATA, "delta"], renderItem));
    });

    for (const item of DATA) {
      expect(calls[item]).toBeGreaterThan(callsBefore[item]);
    }
  });

  it("still exposes working drag handles from memoized rows after a data change", async () => {
    // Guards against memoized rows capturing stale onDragStart closures: after
    // the parent swaps in a new data array (same items), starting a drag from
    // a row that skipped re-rendering must still work.
    const harness = renderDragList({});
    harness.update([...DATA]);
    await startGrantedDrag(harness);

    expect(
      Object.values(harness.infos).some(info => info.isActive)
    ).toBe(true);
  });
});

describe("key stability (bug: remounts break maintainVisibleContentPosition)", () => {
  it("keeps item keys stable across data changes", () => {
    const harness = renderDragList({});
    const before = DATA.map((item, i) =>
      harness.flatList().props.keyExtractor(item, i)
    );

    harness.update([...DATA]);
    const after = DATA.map((item, i) =>
      harness.flatList().props.keyExtractor(item, i)
    );

    expect(after).toEqual(before);
  });

  it("keeps item keys stable after a reorder round-trip", async () => {
    const harness = renderDragList({
      onReordered: () => {},
    });
    await startGrantedDrag(harness);
    await act(async () => {
      harness.config.onPanResponderMove?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });
    await act(async () => {
      harness.config.onPanResponderRelease?.(
        {} as any,
        { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 120 } as any
      );
    });

    const newData = ["beta", "alpha", "gamma"];
    harness.update(newData);

    const keys = newData.map((item, i) =>
      harness.flatList().props.keyExtractor(item, i)
    );
    expect(keys).toEqual(newData);
  });
});
