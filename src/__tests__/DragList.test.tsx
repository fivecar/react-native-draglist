import React from "react";
import { FlatList, PanResponder, Text } from "react-native";
import TestRenderer, { act, ReactTestRenderer } from "react-test-renderer";
import DragList, { DragListRenderItemInfo } from "../index";

const DATA = ["alpha", "beta", "gamma"];
const ITEM_EXTENT = 100;
const LIST_EXTENT = 600;

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
  flatList: () => ReturnType<ReactTestRenderer["root"]["findByType"]>;
}

function renderDragList(props: {
  data?: string[];
  onDragBegin?: () => void;
  onDragEnd?: () => void;
  onHoverChanged?: (hoverIndex: number) => void;
  onReordered?: (from: number, to: number) => Promise<void> | void;
}): Harness {
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
        keyExtractor={(item: string) => item}
        renderItem={renderItem}
        onDragBegin={props.onDragBegin}
        onDragEnd={props.onDragEnd}
        onHoverChanged={props.onHoverChanged}
        onReordered={props.onReordered}
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
        ) => cb(0, 0, 300, LIST_EXTENT, 0, 0),
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
        ) => cb(0, 0, 300, LIST_EXTENT, 0, 0);
      });
  }
  patchMeasure();

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
            layout: { x: 0, y: 0, width: 300, height: LIST_EXTENT },
          },
        });
      });
    },
    // Fires onLayout on each cell so the internal layout cache is populated.
    layoutCells: () => {
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
        act(() => {
          view.props.onLayout({
            nativeEvent: {
              layout: {
                x: 0,
                y: index * ITEM_EXTENT,
                width: 300,
                height: ITEM_EXTENT,
              },
            },
          });
        });
      });
    },
    flatList: () => renderer.root.findByType(FlatList),
  };
  return harness;
}

// Starts a drag on DATA[0] and grants the pan responder, centered on item 0.
async function startGrantedDrag(harness: Harness) {
  harness.layoutWrapper();
  harness.layoutCells();
  await act(async () => {
    harness.infos["alpha"].onDragStart();
  });
  await act(async () => {
    harness.config.onPanResponderGrant?.(
      {} as any,
      { x0: 0, y0: ITEM_EXTENT / 2, dx: 0, dy: 0 } as any
    );
  });
}

beforeEach(() => {
  // Fake timers keep the slide/pan Animated timers from firing after teardown.
  jest.useFakeTimers();
});

afterEach(() => {
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
