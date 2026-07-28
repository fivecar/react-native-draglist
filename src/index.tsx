import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Animated,
  Easing,
  FlatList,
  FlatListProps,
  GestureResponderEvent,
  I18nManager,
  LayoutChangeEvent,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  PanResponderGestureState,
  Platform,
  StyleProp,
  View,
  ViewStyle,
} from "react-native";
import {
  ActiveData,
  createHoverBus,
  DragListProvider,
  LayoutCache,
  PosExtent,
  useDragListContext,
} from "./DragListContext";

// Each renderItem call is given this when rendering a DragList
export interface DragListRenderItemInfo<T> extends ListRenderItemInfo<T> {
  /**
   * Call this function whenever you detect a drag motion starting.
   */
  onDragStart: () => void;

  /**
   * Call this function whenever a drag motion ends (e.g. onPressOut)
   */
  onDragEnd: () => void;

  /**
   * @deprecated Use onDragStart instead
   * @see onDragStart
   */
  onStartDrag: () => void;

  /**
   * @deprecated Use onDragEnd instead
   * @see onDragEnd
   */
  onEndDrag: () => void;

  /**
   * Whether the item is being dragged at the moment.
   */
  isActive: boolean;
}

// Used merely to trigger FlatList to re-render when necessary — only when a
// drag starts or ends (attaching/detaching the Animated transform nodes).
// Hover-index changes mid-drag deliberately do NOT re-render; they're
// broadcast to cells through the hover bus instead.
interface ExtraData {
  activeKey: string | null;
  // Used only to assure WDYR that we're intentionally re-rendering with a "different" object
  detritus?: string;
}

interface Props<T> extends Omit<FlatListProps<T>, "renderItem"> {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DragListRenderItemInfo<T>) => React.ReactElement | null;
  containerStyle?: StyleProp<ViewStyle>;
  onDragBegin?: () => void;
  onDragEnd?: () => void;
  onHoverChanged?: (hoverIndex: number) => Promise<void> | void;
  onReordered?: (fromIndex: number, toIndex: number) => Promise<void> | void;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLayout?: (e: LayoutChangeEvent) => void;
  CustomFlatList?: typeof FlatList;
}

type DragListItemProps<T> = {
  item: T;
  index: number;
  itemKey: string;
  isActive: boolean;
  separators: ListRenderItemInfo<T>["separators"];
  renderItem: (info: DragListRenderItemInfo<T>) => React.ReactElement | null;
  startDrag: (index: number, key: string) => void;
  endDrag: () => void;
  // Not rendered directly — these exist so the memo comparator honors
  // FlatList's extraData contract and pre-memoization length-dependence.
  extraData: any;
  numItems: number;
};

function DragListItemImpl<T>(props: DragListItemProps<T>) {
  const {
    item,
    index,
    itemKey,
    isActive,
    separators,
    renderItem,
    startDrag,
    endDrag,
  } = props;
  const onDragStart = useCallback(
    () => startDrag(index, itemKey),
    [startDrag, index, itemKey]
  );

  return renderItem({
    item,
    index,
    separators,
    onDragStart,
    onStartDrag: onDragStart,
    onDragEnd: endDrag,
    onEndDrag: endDrag,
    isActive,
  });
}

// Memoizes user row content so list-level re-renders (drag start/end, data
// identity changes, FlatList virtualization churn) only re-invoke the host's
// renderItem for rows whose inputs actually changed. The comparator must
// include `renderItem` itself: a host whose renderItem closes over its own
// state re-renders by passing a new closure, and skipping that would freeze
// its rows. It must also include the host's `extraData` (FlatList's
// documented escape hatch for rows driven by external state) and the item
// count (pre-memoization, renderDragItem depended on data.length, so length
// changes repainted every row). `separators` is deliberately excluded —
// VirtualizedList recreates the info object per render, but each cell's
// separator callbacks are stable.
const DragListItem = React.memo(
  DragListItemImpl,
  (prev, next) =>
    prev.item === next.item &&
    prev.index === next.index &&
    prev.itemKey === next.itemKey &&
    prev.isActive === next.isActive &&
    prev.renderItem === next.renderItem &&
    prev.startDrag === next.startDrag &&
    prev.endDrag === next.endDrag &&
    prev.extraData === next.extraData &&
    prev.numItems === next.numItems
) as unknown as typeof DragListItemImpl;

// Whether the list's layout runs opposite to its coordinate axis, i.e.
// whether an item's cached `pos` DESCENDS as its index rises. Horizontal
// lists do this under RTL: Yoga mirrors the row, so index 0 gets the largest
// x, while touch coordinates and `contentOffset` stay plain left-origin.
// Anything that relates positions to indices must therefore walk the axis in
// "flow" order (increasing with index) rather than in coordinate order.
//
// This is deliberately only about the *layout* stage. The `inverted` prop
// mirrors at the render stage instead — VirtualizedList applies a scaleX/
// scaleY of -1 that Yoga never sees — which leaves `pos` ascending and
// instead flips the mapping from touch coordinates into content
// coordinates. That's an independent flag; supporting it means a second
// predicate here plus its own handling, and it is currently unsupported.
function isLayoutMirrored(horizontal: boolean | null | undefined) {
  return !!horizontal && I18nManager.isRTL;
}

// An item's far edge in flow order: the edge you must drag past for the item
// to count as sitting before you in the data. Mirrored layouts run backwards
// through coordinate space, so their flow edge is the near one, negated to
// keep flow positions ascending with index.
function flowTrailingEdge(layout: PosExtent, mirrored: boolean) {
  return mirrored ? -layout.pos : layout.pos + layout.extent;
}

function DragListImpl<T>(
  props: Props<T>,
  ref?: React.ForwardedRef<FlatList<T> | null>
) {
  const {
    containerStyle,
    data,
    keyExtractor,
    onDragBegin,
    onDragEnd,
    onScroll,
    onLayout,
    // Pulled out of `rest` deliberately. We need this to size the auto-scroll
    // clamp, and `rest` is spread last onto the list, so a host that passes
    // its own would otherwise silently replace ours instead of chaining.
    onContentSizeChange,
    renderItem,
    CustomFlatList = FlatList,
    ...rest
  } = props;
  // activeKey and activeIndex track the item being dragged
  const activeDataRef = useRef<ActiveData | null>(null);
  const isReorderingRef = useRef(false); // Whether we're actively rendering a reorder right now.
  // panIndex tracks the location where the dragged item would go if dropped
  const panIndex = useRef(-1);
  // Broadcasts hover-index changes to mounted cells without re-rendering.
  const hoverBus = useRef(createHoverBus()).current;
  const [extra, setExtra] = useState<ExtraData>({
    activeKey: activeDataRef.current?.key ?? null,
  });
  const layouts = useRef<LayoutCache>({}).current;
  const panGrantedRef = useRef(false);
  const grantScrollPosRef = useRef(0); // Scroll pos when granted
  // The amount you need to add to the touched position to get to the active
  // item's center.
  const grantActiveCenterOffsetRef = useRef(0);
  // Auto-scroll state. Dragging past an edge runs a frame loop that nudges
  // the list a few pixels at a time; stepping a whole item per timer tick
  // (what this used to do) reads as a series of jumps.
  const autoScrollFrameRef = useRef<number | null>(null);
  // Signed cartesian speed, in pixels per second, at which the content should
  // slide under the viewport. Zero means we aren't auto-scrolling.
  const autoScrollVelocityRef = useRef(0);
  // The offset the loop last handed scrollToOffset, i.e. its own idea of
  // where the list is. It has to be integrated here rather than read back
  // from scrollPos every frame: onScroll lands a frame or more late, so
  // re-reading it would keep re-applying travel the list already made.
  const autoScrollOffsetRef = useRef(0);
  // The same position in cartesian space, kept in lockstep with the above so
  // the drag can be drawn against what we commanded instead of what onScroll
  // last reported. See effectiveScrollPos.
  const autoScrollScrollPosRef = useRef(0);
  // Whether the loop's offsets have been seeded during the current drag. They
  // survive the loop stopping and restarting (which happens every time your
  // finger dips back inside the list), because reseeding from the lagging
  // scrollPos would command a position the list has already passed and jerk
  // the drag backwards.
  const autoScrollSeededRef = useRef(false);
  const autoScrollTimeRef = useRef(0);
  const autoScrollMirroredRef = useRef(false);
  // Main-axis content length, used to clamp the loop at the end of the list.
  // Zero means nobody has told us yet.
  const contentExtentRef = useRef(0);
  // The pan geometry from the last move event, so the frame loop can redo the
  // drag's rendering as content slides beneath a stationary finger.
  const moveGeometryRef = useRef<{
    pos: number;
    wrapPos: number;
    mirrored: boolean;
  } | null>(null);
  // Fallback teardown for reorders whose parent never hands back new data
  // (see the grace-timer comment in onPanResponderRelease).
  const graceResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const clearGraceResetTimer = useCallback(() => {
    if (graceResetTimerRef.current) {
      clearTimeout(graceResetTimerRef.current);
      graceResetTimerRef.current = null;
    }
  }, []);

  // #78 - keep onHoverChanged up to date in our ref
  const hoverRef = useRef(props.onHoverChanged);
  hoverRef.current = props.onHoverChanged;
  const reorderRef = useRef(props.onReordered);
  reorderRef.current = props.onReordered;
  const keyExtractorRef = useRef(keyExtractor);
  keyExtractorRef.current = keyExtractor;
  const onDragBeginRef = useRef(onDragBegin);
  onDragBeginRef.current = onDragBegin;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  // Whether we still owe the host an onDragEnd for the current drag. Every
  // teardown path (release, termination, mid-drag data change) must settle
  // this debt so hosts can rely on onDragBegin/onDragEnd always pairing up.
  const dragEndOwedRef = useRef(false);
  const fireOwedDragEnd = useCallback(() => {
    if (dragEndOwedRef.current) {
      dragEndOwedRef.current = false;
      onDragEndRef.current?.();
    }
  }, []);

  // Keys must stay stable across data changes. We used to suffix keys with a
  // data-generation number to force full remounts on every data change (to
  // clear stale native transforms), but that broke
  // maintainVisibleContentPosition on Fabric (the anchor child gets
  // destroyed, so mVCP applies garbage offsets) and remounted every row on
  // every data change. Stale transforms can't occur anymore because idle
  // cells render static zero transforms (see CellRendererComponent).
  const stableKeyExtractor = useCallback((item: T, index: number) => {
    return keyExtractorRef.current(item, index);
  }, []);

  const dataRef = useRef(data);
  dataRef.current = data;

  const lastDataRef = useRef(data);

  const flatRef = useRef<FlatList<T> | null>(null);
  const flatWrapRef = useRef<View>(null);
  const flatWrapLayout = useRef<PosExtent>({
    pos: 0,
    extent: 1,
  });
  const flatWrapRefPosUpdatedRef = useRef(false);
  // The cartesian scroll offset, i.e. what `contentOffset` reports and what
  // cached layouts are expressed in.
  const scrollPos = useRef(0);
  // The same position counted from the start of the data instead of from the
  // origin of the axis. The two only differ under a mirrored layout, where
  // the data starts at the far end — but that's the space scrollToOffset
  // works in, so auto-scroll targets have to be built here.
  const flowScrollPos = useRef(0);

  // pan is the drag dy.
  //
  // IMPORTANT: all Animated values in this library are JS-driven
  // (useNativeDriver: false), deliberately. The native driver keeps values in
  // a native-side overlay that is re-applied on top of every React commit and
  // is NOT restored when nodes detach on Fabric. That overlay is what caused
  // years of drop glitches: items flashing at their old position (#76, #107,
  // #114), items turning invisible after a drag (#81, #95), and setValue
  // silently not applying (#53). With JS-driven values, what we render is a
  // pure function of JS state and commits atomically with layout changes.
  const pan = useRef(new Animated.Value(0)).current;
  const setPan = useCallback(
    (value: number) => {
      pan.setValue(value);
    },
    [pan]
  );

  const shouldCapturePan = useCallback(() => {
    // While a reorder's grace timer is pending, activeDataRef is still set
    // (the drag posture is held for the parent's data change), but a stray
    // touch must not be captured as a pan of the old item — releasing it
    // could fire a second onReordered with stale indices. A deliberate new
    // drag still works: the row's onDragStart disarms the timer first.
    return (
      !!activeDataRef.current &&
      !isReorderingRef.current &&
      !graceResetTimerRef.current
    );
  }, []);

  // The scroll position the drag should be drawn against. Once auto-scroll has
  // run during this drag, that's the offset we commanded rather than the one
  // onScroll last reported: reports lag a frame or more and arrive unevenly,
  // so drawing against them jitters the dragged item against smoothly moving
  // content, and the loop's last command before it pins at an end would never
  // be drawn at all — leaving a release to reorder to a stale slot. Nothing
  // else moves the list mid-drag (scrolling is disabled), so the commanded
  // value stays authoritative even while the loop is stopped.
  const effectiveScrollPos = useCallback(
    () =>
      autoScrollSeededRef.current
        ? autoScrollScrollPosRef.current
        : scrollPos.current,
    []
  );

  // Repaints the drag against the current scroll position: where the dragged
  // item sits, and which slot it would drop into. It reads the last move's
  // geometry from a ref rather than taking arguments, so the auto-scroll loop
  // can replay it frame by frame while the finger holds still.
  const updateRendering = useCallback(() => {
    const geometry = moveGeometryRef.current;

    if (!geometry) {
      return;
    }

    const { pos, wrapPos, mirrored } = geometry;
    const scrolled = effectiveScrollPos();
    const panAmount = scrolled - grantScrollPosRef.current + pos;

    setPan(panAmount);

    // Now we figure out what your panIndex should be based on everyone's
    // heights, starting from the first element. Note that we can't do this
    // math if any element up to your drag point hasn't been measured yet. I
    // don't think that should ever happen, but take note.
    //
    // The walk runs in flow order, which is coordinate order only when the
    // layout isn't mirrored. Negating both sides under a mirrored layout
    // keeps the comparison (and hence the loop) pointing the same way as the
    // data.
    const clientPos = wrapPos + scrolled;
    const dragCenter = clientPos + grantActiveCenterOffsetRef.current;
    const flowDragCenter = mirrored ? -dragCenter : dragCenter;
    let curIndex = 0;
    let key;
    while (
      curIndex < dataRef.current.length &&
      layouts.hasOwnProperty(
        (key = keyExtractorRef.current(dataRef.current[curIndex], curIndex))
      ) &&
      flowTrailingEdge(layouts[key], mirrored) < flowDragCenter
    ) {
      curIndex++;
    }

    // Broadcast the new hover index straight to the mounted cells (which
    // start their own slide animations) instead of setState'ing the whole
    // FlatList. Re-rendering every row via extraData on each hover change
    // used to blow the frame budget by 2+ frames per change.
    if (panIndex.current != curIndex) {
      panIndex.current = curIndex;
      hoverBus.notify(curIndex);
      hoverRef.current?.(curIndex);
    }
  }, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollFrameRef.current !== null) {
      cancelAnimationFrame(autoScrollFrameRef.current);
      autoScrollFrameRef.current = null;
    }
    autoScrollVelocityRef.current = 0;
  }, []);

  const autoScrollFrame = useCallback(() => {
    autoScrollFrameRef.current = null;

    if (!activeDataRef.current || autoScrollVelocityRef.current === 0) {
      return;
    }

    const now = Date.now();
    // A frame that lands after a stall (blocked JS thread, backgrounded app)
    // reports a huge elapsed time; integrating it would teleport the list.
    const elapsed = Math.min(
      now - autoScrollTimeRef.current,
      AUTO_SCROLL_MAX_FRAME_MILLIS
    );
    autoScrollTimeRef.current = now;

    if (elapsed <= 0) {
      // Two frames inside the same millisecond. Nothing to integrate, and
      // falling through would look like being pinned against an end.
      autoScrollFrameRef.current = requestAnimationFrame(autoScrollFrame);
      return;
    }

    // Velocity is cartesian — which way the content slides under the
    // viewport — while scrollToOffset works in flow space, measured from the
    // start of the data. A mirrored layout runs the two against each other,
    // so the nudge flips sign. Feeding it the cartesian value instead makes
    // VirtualizedList mirror an already-mirrored number and fling the list
    // most of its length.
    const mirrored = autoScrollMirroredRef.current;
    const travel = (autoScrollVelocityRef.current * elapsed) / 1000;
    const offset = Math.min(
      Math.max(autoScrollOffsetRef.current + (mirrored ? -travel : travel), 0),
      // Unknown content size leaves the far end unbounded, which just defers
      // to the platform's own clamp.
      contentExtentRef.current
        ? Math.max(0, contentExtentRef.current - flatWrapLayout.current.extent)
        : Number.POSITIVE_INFINITY
    );
    const applied = offset - autoScrollOffsetRef.current;

    if (applied === 0) {
      // Pinned against an end of the list. Nothing else moves the offset
      // while a drag is up, so idle until a move event revives us.
      stopAutoScroll();
      return;
    }

    autoScrollOffsetRef.current = offset;
    // The clamp above is in flow space, so the cartesian twin has to follow
    // the travel that actually got applied rather than what we asked for.
    autoScrollScrollPosRef.current += mirrored ? -applied : applied;
    flatRef.current?.scrollToOffset({ animated: false, offset });
    updateRendering();
    autoScrollFrameRef.current = requestAnimationFrame(autoScrollFrame);
  }, []);

  // Points the auto-scroll loop at a new speed, starting it if it isn't
  // already running. `overshoot` is how far the dragged item pokes past the
  // viewport edge, signed the way the content has to slide to follow it.
  const setAutoScrollVelocity = useCallback(
    (overshoot: number, dragItemExtent: number, mirrored: boolean) => {
      if (overshoot === 0) {
        stopAutoScroll();
        return;
      }

      // Speed ramps with how far past the edge you are, so grazing the edge
      // creeps while shoving well past it races. The ramp spans one item,
      // bounded so that neither tiny rows nor full-screen ones distort it.
      const ramp = Math.min(
        Math.max(dragItemExtent, AUTO_SCROLL_MIN_RAMP_PIXELS),
        AUTO_SCROLL_MAX_RAMP_PIXELS
      );
      const intensity = Math.min(Math.abs(overshoot) / ramp, 1);

      autoScrollVelocityRef.current =
        Math.sign(overshoot) *
        (AUTO_SCROLL_MIN_PIXELS_PER_SEC +
          (AUTO_SCROLL_MAX_PIXELS_PER_SEC - AUTO_SCROLL_MIN_PIXELS_PER_SEC) *
            intensity);

      // Seed once per drag, from the last position the list actually
      // reported. Reseeding on each restart would hand back the lag we
      // integrate our own offset to avoid.
      if (!autoScrollSeededRef.current) {
        autoScrollSeededRef.current = true;
        autoScrollMirroredRef.current = mirrored;
        autoScrollOffsetRef.current = mirrored
          ? flowScrollPos.current
          : scrollPos.current;
        autoScrollScrollPosRef.current = scrollPos.current;
      }

      if (autoScrollFrameRef.current === null) {
        autoScrollTimeRef.current = Date.now();
        autoScrollFrameRef.current = requestAnimationFrame(autoScrollFrame);
      }
    },
    []
  );

  const onPanResponderGrant = useCallback(
    (_: GestureResponderEvent, gestate: PanResponderGestureState) => {
      grantScrollPosRef.current = scrollPos.current;
      setPan(0);
      panGrantedRef.current = true;
      flatWrapRefPosUpdatedRef.current = false;
      flatWrapRef.current?.measure((_x, _y, _width, _height, pageX, pageY) => {
        // Capture the latest y position upon starting a drag, because the
        // window could have moved since we last measured. Remember that moves
        // without resizes _don't_ generate onLayout, so we need to actively
        // measure here. React doesn't give a way to subscribe to move events.
        // We don't overwrite width/height from this measurement because
        // height can come back 0.
        flatWrapLayout.current = {
          ...flatWrapLayout.current,
          pos: props.horizontal ? pageX : pageY,
        };
        if (
          activeDataRef.current &&
          layouts.hasOwnProperty(activeDataRef.current.key)
        ) {
          const itemLayout = layouts[activeDataRef.current.key];
          const screenPos = props.horizontal ? gestate.x0 : gestate.y0;
          const clientViewPos = screenPos - flatWrapLayout.current.pos;
          const clientPos = clientViewPos + scrollPos.current;
          const posOnActiveItem = clientPos - itemLayout.pos;

          grantActiveCenterOffsetRef.current =
            itemLayout.extent / 2 - posOnActiveItem;
        } else {
          grantActiveCenterOffsetRef.current = 0;
        }

        flatWrapRefPosUpdatedRef.current = true;
      });

      dragEndOwedRef.current = true;
      onDragBeginRef.current?.();
    },
    []
  );

  const onPanResponderMove = useCallback(
    (_: GestureResponderEvent, gestate: PanResponderGestureState) => {
      if (
        !flatWrapRefPosUpdatedRef.current ||
        !activeDataRef.current ||
        !layouts.hasOwnProperty(activeDataRef.current.key)
      ) {
        return;
      }

      const mirrored = isLayoutMirrored(props.horizontal);
      const posOrigin = props.horizontal ? gestate.x0 : gestate.y0;
      let pos = props.horizontal ? gestate.dx : gestate.dy;
      let wrapPos = posOrigin + pos - flatWrapLayout.current.pos;

      const dragItemExtent = layouts[activeDataRef.current.key].extent;

      const pointerOffsetWithinItem =
        dragItemExtent / 2 - grantActiveCenterOffsetRef.current;

      if (props.scrollEnabled === false && flatWrapLayout.current.extent > 0) {
        const minWrapPos = pointerOffsetWithinItem;
        const maxWrapPos = Math.max(
          minWrapPos,
          flatWrapLayout.current.extent -
            (dragItemExtent - pointerOffsetWithinItem)
        );
        const clampedWrapPos = Math.min(
          Math.max(wrapPos, minWrapPos),
          maxWrapPos
        );

        if (clampedWrapPos !== wrapPos) {
          wrapPos = clampedWrapPos;
          pos = clampedWrapPos - posOrigin + flatWrapLayout.current.pos;
        }
      }

      const leadingEdge = wrapPos - dragItemExtent / 2;
      const trailingEdge = wrapPos + dragItemExtent / 2;
      let overshoot = 0;

      // We auto-scroll the FlatList when you drag off the top or bottom edge
      // (or right/left for horizontal ones). These calculations can be a bit
      // finnicky. You need to consider client coordinates and coordinates
      // relative to the screen.
      if (props.scrollEnabled === false) {
        overshoot = 0;
      } else if (leadingEdge < 0) {
        overshoot = leadingEdge;
      } else if (trailingEdge > flatWrapLayout.current.extent) {
        overshoot = trailingEdge - flatWrapLayout.current.extent;
      }

      moveGeometryRef.current = { pos, wrapPos, mirrored };
      setAutoScrollVelocity(overshoot, dragItemExtent, mirrored);
      updateRendering();
    },
    []
  );

  const onPanResponderRelease = useCallback(
    async (_: GestureResponderEvent, _gestate: PanResponderGestureState) => {
      // The drag this release belongs to. While onReordered awaits, presses
      // still reach rows (only responder capture is blocked), so a new drag
      // can supersede this one; teardown below must then stand down.
      const releasedData = activeDataRef.current;
      const activeIndex = releasedData?.index;
      let reorderCallback: typeof reorderRef.current;

      stopAutoScroll();
      fireOwedDragEnd();

      if (
        activeIndex != null && // Being paranoid, we exclude both undefined and null here
        activeIndex !== panIndex.current &&
        // Ignore the case where you drag the last item beyond the end
        !(
          activeIndex === dataRef.current.length - 1 &&
          panIndex.current > activeIndex
        )
      ) {
        try {
          // We serialize reordering so that we don't capture any new pan
          // attempts during this time. Otherwise, onReordered could be called
          // with indices that would be stale if you panned several times
          // quickly (e.g. if onReordered deletes an item, the next
          // onReordered call would be made on a list whose indices are
          // stale).
          isReorderingRef.current = true;

          reorderCallback = reorderRef.current;
          await reorderCallback?.(activeIndex, panIndex.current);
        } finally {
          isReorderingRef.current = false;
          // #76 - Normally we don't reset here; the parent's data change
          // (in response to onReordered) resets us in the same commit that
          // moves items, which is what keeps the drop atomic. But if the
          // parent never hands us new data (e.g. it mutated in place), we
          // must still tear the drag down or the list stays stuck.
          //
          // We don't reset the moment onReordered resolves, though: parents
          // backed by async/debounced stores hand back new data later than
          // the microtask queue, and an eager reset would snap the item back
          // and then jump it once the data arrived. Instead we arm a grace
          // timer. In the normal case the data change lands first and the
          // data-change render path resets atomically in the same commit as
          // the move (clearing this timer via reset). Only if nothing
          // arrives within the grace period does this fallback fire.
          // Only tear down if this release still owns the drag state. If a
          // drag started mid-await, arming the grace timer (or resetting)
          // here would freeze and then kill that new drag; its own lifecycle
          // handles teardown instead.
          if (activeDataRef.current && activeDataRef.current === releasedData) {
            if (!reorderCallback) {
              // No onReordered callback means no parent can possibly echo
              // new data — waiting would just hold the list unscrollable.
              reset();
            } else {
              clearGraceResetTimer();
              graceResetTimerRef.current = setTimeout(() => {
                graceResetTimerRef.current = null;
                if (activeDataRef.current) {
                  reset();
                }
              }, REORDER_RESET_GRACE_MILLIS);
            }
          }
        }
      } else {
        // #76 - Only reset here if we're not going to reorder the list. If we are instead
        // reordering the list, we reset once the parent updates data. Otherwise things will jump
        // around visually.
        reset();
      }
    },
    []
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: shouldCapturePan,
      onStartShouldSetPanResponder: shouldCapturePan,
      onMoveShouldSetPanResponder: shouldCapturePan,
      onMoveShouldSetPanResponderCapture: shouldCapturePan,
      onPanResponderGrant,
      onPanResponderMove,
      onPanResponderRelease,
      // If something politely asks to take the responder mid-drag (a JS-side
      // steal), decline: the user is visibly dragging an item.
      onPanResponderTerminationRequest: () => false,
      // Native gestures (e.g. react-native-gesture-handler recognizers,
      // iOS system gestures, incoming calls) can still forcibly terminate us
      // without a termination request. Treat that like a release: the user's
      // finger already did the reordering work, so we commit at the current
      // hover index rather than snapping back — and, either way, we must tear
      // the drag down (reset state, re-enable scrolling, fire onDragEnd) or
      // the item is left floating forever.
      onPanResponderTerminate: onPanResponderRelease,
    })
  ).current;

  /**
   * When you don't want to trigger a re-render, pass false so we don't setExtra.
   */
  const reset = useCallback((shouldSetExtra = true) => {
    clearGraceResetTimer();
    activeDataRef.current = null;
    panIndex.current = -1;
    hoverBus.index = -1;
    // setPan(0); Deliberately not handled here in render path, but in useLayoutEffect
    if (shouldSetExtra) {
      setExtra({
        // Trigger re-render
        activeKey: null,
        detritus: Math.random().toString(),
      });
    }
    panGrantedRef.current = false;
    grantActiveCenterOffsetRef.current = 0;
    moveGeometryRef.current = null;
    autoScrollSeededRef.current = false;
    stopAutoScroll();
  }, []);

  if (lastDataRef.current !== data) {
    lastDataRef.current = data;
    // Prune layouts of keys that no longer exist. Entries are only refreshed
    // by mounted cells' onLayout, so stale rects from removed items would
    // otherwise corrupt the next drag's hover-index math.
    const currentKeys = new Set(
      data.map((item, index) => keyExtractorRef.current(item, index))
    );
    Object.keys(layouts).forEach(key => {
      if (!currentKeys.has(key)) {
        delete layouts[key];
      }
    });
    reset(false); // Don't trigger re-render because we're already rendering.
  }

  // For reasons unclear to me, you need this useLayoutEffect here -- _even if you have an empty
  // function body_. That's right. Having it here changes timings or something in React Native so
  // our rendering is reset correctly, even if you do absolutely nothing in the function. As it
  // stands, we need to reset the pan, so it's all good.
  // Unmount cleanup: disarm the grace fallback if it's pending, and settle
  // any owed onDragEnd. A parent can unmount the list mid-drag (e.g. hiding
  // it based on other state) before any release/terminate event or data
  // change runs the other teardown paths, and onDragBegin/onDragEnd must
  // still pair up.
  useEffect(
    () => () => {
      clearGraceResetTimer();
      stopAutoScroll();
      fireOwedDragEnd();
    },
    [clearGraceResetTimer, stopAutoScroll, fireOwedDragEnd]
  );

  useLayoutEffect(() => {
    setPan(0);
    // If a data change killed a live drag (reset(false) above), the host
    // still deserves its onDragEnd. This is a no-op when the drag already
    // ended via release/termination.
    fireOwedDragEnd();
  }, [data]);

  // Stable identity so memoized rows can keep it forever; reads everything
  // through refs, so a row that skipped re-rendering still starts drags
  // against current state.
  const startDrag = useCallback((index: number, key: string) => {
    // We don't allow dragging for lists less than 2 elements
    if (dataRef.current.length > 1) {
      // If a reorder's grace timer is still pending (parent never echoed new
      // data), starting a fresh drag supersedes it — the timer must not fire
      // later and tear down the new drag. The previous drag's grant flag must
      // also be cleared: reset() normally does that, but the grace window
      // defers reset, and a stale true here would block endDrag's teardown if
      // this new drag ends before being granted (press without movement).
      clearGraceResetTimer();
      panGrantedRef.current = false;
      // Zero pan synchronously before the activation render attaches it,
      // so the new active item can't inherit a stale offset from a
      // previous drag (setValue also pushes to the native side before the
      // attach command lands, since animated-module commands run in
      // order).
      pan.setValue(0);
      activeDataRef.current = { index, key };
      panIndex.current = index;
      hoverBus.index = index;
      setExtra({ activeKey: key });
    }
  }, []);

  const endDrag = useCallback(() => {
    // You can sometimes have started a drag and yet not captured the
    // pan (because you don't capture the responder during onStart but
    // do during onMove, and yet the user hasn't moved). In those cases,
    // you need to reset everything so that items become !isActive.
    // In cases where you DID capture the pan, this function is a no-op
    // because we'll end the drag when it really ends (since we've
    // captured it). This all is necessary because the way the user
    // decided to call onStartDrag is likely in response to an onPressIn,
    // which then triggers on onPressOut the moment we capture (thus
    // leading to a premature call to onEndDrag here).
    if (activeDataRef.current && !panGrantedRef.current) {
      reset();
    }
  }, []);

  const renderDragItem = useCallback(
    (info: ListRenderItemInfo<T>) => {
      const key = keyExtractorRef.current(info.item, info.index);
      const isActive = key === activeDataRef.current?.key;

      return (
        <DragListItem
          item={info.item}
          index={info.index}
          itemKey={key}
          isActive={isActive}
          separators={info.separators}
          renderItem={renderItem}
          startDrag={startDrag}
          endDrag={endDrag}
          extraData={props.extraData}
          numItems={data.length}
        />
      );
    },
    [renderItem, props.extraData, data.length]
  );

  const onDragScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } =
        event.nativeEvent;

      scrollPos.current = props.horizontal ? contentOffset.x : contentOffset.y;
      flowScrollPos.current = isLayoutMirrored(props.horizontal)
        ? contentSize.width - (contentOffset.x + layoutMeasurement.width)
        : scrollPos.current;
      contentExtentRef.current = props.horizontal
        ? contentSize.width
        : contentSize.height;
      if (onScroll) {
        onScroll(event);
      }
    },
    [onScroll]
  );

  const onDragContentSizeChange = useCallback(
    (width: number, height: number) => {
      contentExtentRef.current = props.horizontal ? width : height;
      if (onContentSizeChange) {
        onContentSizeChange(width, height);
      }
    },
    [onContentSizeChange]
  );

  const onDragLayout = useCallback(
    (evt: LayoutChangeEvent) => {
      flatWrapRef.current?.measure((_x, _y, width, height, pageX, pageY) => {
        // Even though we capture x/y during onPanResponderGrant, we still
        // capture height here because measureInWindow can return 0 height.
        flatWrapLayout.current = props.horizontal
          ? { pos: pageX, extent: width }
          : { pos: pageY, extent: height };
      });
      if (onLayout) {
        onLayout(evt);
      }
    },
    [onLayout]
  );

  return (
    <DragListProvider
      activeData={activeDataRef.current}
      keyExtractor={keyExtractorRef.current}
      pan={pan}
      hoverBus={hoverBus}
      layouts={layouts}
      horizontal={props.horizontal}
    >
      <View
        ref={flatWrapRef}
        style={containerStyle}
        {...panResponder.panHandlers}
        onLayout={onDragLayout}
      >
        <CustomFlatList
          ref={r => {
            flatRef.current = r;
            if (!!ref) {
              if (typeof ref === "function") {
                ref(r);
              } else {
                ref.current = r;
              }
            }
          }}
          keyExtractor={stableKeyExtractor}
          data={data}
          renderItem={renderDragItem}
          CellRendererComponent={CellRendererComponent}
          extraData={extra}
          scrollEnabled={!activeDataRef.current}
          onScroll={onDragScroll}
          onContentSizeChange={onDragContentSizeChange}
          scrollEventThrottle={16} // From react-native-draggable-flatlist; no idea why.
          removeClippedSubviews={false} // https://github.com/facebook/react-native/issues/18616
          {...rest}
        />
      </View>
    </DragListProvider>
  );
}

const SLIDE_MILLIS = 200;
// Auto-scroll speed at the moment you cross an edge, and once you're a full
// ramp beyond it. The floor keeps a graze from looking frozen; the ceiling is
// roughly a phone screen per second, past which you can't see where you are.
const AUTO_SCROLL_MIN_PIXELS_PER_SEC = 90;
const AUTO_SCROLL_MAX_PIXELS_PER_SEC = 850;
// Bounds on the overshoot distance the speed ramp is measured against, which
// is otherwise the dragged item's own extent.
const AUTO_SCROLL_MIN_RAMP_PIXELS = 40;
const AUTO_SCROLL_MAX_RAMP_PIXELS = 200;
const AUTO_SCROLL_MAX_FRAME_MILLIS = 50;
// How long, after onReordered resolves, we wait for the parent's data change
// (the atomic teardown path) before force-resetting the drag. Long enough for
// async/debounced stores to round-trip; short enough that a parent that never
// echoes data doesn't leave the list stuck with scrolling disabled.
const REORDER_RESET_GRACE_MILLIS = 1500;
const ANIM_VALUE_ZERO = new Animated.Value(0);
const ANIM_VALUE_ONE = new Animated.Value(1);
const ANIM_VALUE_NINER = new Animated.Value(999);

type CellRendererProps<T> = {
  item: T;
  index: number;
  children: React.ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
};

function CellRendererComponent<T>(props: CellRendererProps<T>) {
  const { item, index, children, onLayout, ...rest } = props;
  const { keyExtractor, activeData, pan, hoverBus, layouts, horizontal } =
    useDragListContext<T>();
  const cellRef = useRef<View>(null);
  const key = keyExtractor(item, index);
  const isActive = key === activeData?.key;
  const anim = useRef(new Animated.Value(0)).current;
  // https://github.com/fivecar/react-native-draglist/issues/53
  // Starting RN 0.76.3, we need to use Animated.Value instead of a plain number
  // for Animated.View's elevation and zIndex. I (fivecar) don't understand why.
  // If you use raw numbers, the elevation and zIndex don't have an effect.
  // Transforms are only backed by Animated values while a drag is in
  // progress. When idle, every cell renders a static zero transform, so the
  // React commit that applies reordered data carries transform 0 atomically
  // with the new layout. This is what prevents dropped items from flashing at
  // their old position: async native-animated resets can never race the
  // commit, because nodes only attach at value 0 and detach in a commit that
  // already specifies 0.
  const style = useMemo(() => {
    return [
      props.style,
      isActive
        ? {
            elevation: ANIM_VALUE_ONE,
            zIndex: ANIM_VALUE_NINER,
            transform: [horizontal ? { translateX: pan } : { translateY: pan }],
          }
        : activeData
        ? {
            elevation: ANIM_VALUE_ZERO,
            zIndex: ANIM_VALUE_ZERO,
            transform: [
              horizontal ? { translateX: anim } : { translateY: anim },
            ],
          }
        : {
            // elevation/zIndex stay Animated-backed even when idle: per the
            // RN 0.76.3+ quirk above, raw numbers here don't take effect, so
            // a just-dropped cell could keep its dragged stacking. These are
            // module-level constants that never animate, so the transform's
            // static-commit guarantee is unaffected.
            elevation: ANIM_VALUE_ZERO,
            zIndex: ANIM_VALUE_ZERO,
            transform: [horizontal ? { translateX: 0 } : { translateY: 0 }],
          },
    ];
  }, [props.style, isActive, !!activeData, horizontal, pan, anim]);
  const onCellLayout = useCallback(
    (evt: LayoutChangeEvent) => {
      if (onLayout) {
        onLayout(evt);
      }

      const layout = evt.nativeEvent.layout;
      layouts[key] = horizontal
        ? { pos: layout.x, extent: layout.width }
        : { pos: layout.y, extent: layout.height };
    },
    [onLayout, horizontal, key, layouts]
  );

  // Tracks the displacement this cell is currently animated toward, so
  // hover-bus notifications that don't change our target are free.
  const slideTargetRef = useRef(0);

  // Slide displacement is driven by hover-bus notifications, not re-renders:
  // DragList broadcasts each hover-index change and only cells whose
  // displacement target actually changed start a new animation. The effect
  // itself re-runs only when a drag starts/ends (activeData) or this cell's
  // index changes. JS-driven on purpose — see the comment on `pan` in
  // DragListImpl.
  useEffect(() => {
    if (activeData == null) {
      slideTargetRef.current = 0;
      anim.setValue(0);
      return;
    }

    const activeKey = activeData.key;
    const activeIndex = activeData.index;
    const applySlide = (hoverIndex: number) => {
      let target = 0;

      if (!isActive && layouts.hasOwnProperty(activeKey)) {
        // How far a displaced neighbor travels to move one slot later in the
        // data. Under a mirrored layout that direction is toward lower
        // coordinates, and transforms aren't mirrored for us the way layout
        // is, so the sign has to be applied by hand.
        const slot = isLayoutMirrored(horizontal)
          ? -layouts[activeKey].extent
          : layouts[activeKey].extent;

        if (index >= hoverIndex && index <= activeIndex) {
          target = slot;
        } else if (index >= activeIndex && index <= hoverIndex) {
          target = -slot;
        }
      }
      if (target === slideTargetRef.current) {
        return;
      }
      slideTargetRef.current = target;
      if (target === 0) {
        // Matches the pre-bus behavior: leaving the displaced range snaps
        // straight back rather than animating.
        anim.setValue(0);
      } else {
        Animated.timing(anim, {
          duration: SLIDE_MILLIS,
          easing: Easing.inOut(Easing.linear),
          toValue: target,
          useNativeDriver: false,
        }).start();
      }
    };

    // Catch up immediately (cells can mount mid-drag during auto-scroll),
    // then follow subsequent hover changes.
    applySlide(hoverBus.index);
    return hoverBus.subscribe(applySlide);
  }, [index, isActive, activeData, hoverBus]);

  if (Platform.OS == "web") {
    // RN Web does not fire onLayout as expected
    // Workaround for https://github.com/necolas/react-native-web/issues/2481
    useEffect(() => {
      cellRef.current?.measure((x, y, w, h) => {
        layouts[key] = horizontal
          ? { pos: x, extent: w }
          : { pos: y, extent: h };
      });
    }, [index]);
  }

  return (
    <Animated.View
      {...rest}
      style={style}
      onLayout={onCellLayout}
      ref={cellRef}
      key={key}
    >
      {children}
    </Animated.View>
  );
}

const DragList = React.forwardRef(DragListImpl) as <T>(
  props: Props<T> & { ref?: React.ForwardedRef<FlatList<T>> }
) => React.ReactElement;

export default DragList;
