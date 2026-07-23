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
  update: (data: string[]) => void;
  layoutCells: () => void;
  layoutWrapper: () => void;
  flatList: () => ReturnType<ReactTestRenderer["root"]["findByType"]>;
}

function renderDragList(props: {
  data?: string[];
  onDragBegin?: () => void;
  onDragEnd?: () => void;
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
  const renderItem = (info: DragListRenderItemInfo<string>) => {
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

  it("tears down the drag even when the parent never echoes new data after onReordered", async () => {
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
    // Parent deliberately does NOT update data.

    expect(onDragEnd).toHaveBeenCalledTimes(1);
    expect(
      Object.values(harness.infos).every(info => !info.isActive)
    ).toBe(true);
    expect(harness.flatList().props.scrollEnabled).toBe(true);
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
