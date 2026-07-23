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
  const autoScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );

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
  const scrollPos = useRef(0);

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
    return !!activeDataRef.current && !isReorderingRef.current;
  }, []);

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
      clearAutoScrollTimer();

      if (
        !flatWrapRefPosUpdatedRef.current ||
        !activeDataRef.current ||
        !layouts.hasOwnProperty(activeDataRef.current.key)
      ) {
        return;
      }

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

      function updateRendering() {
        const panAmount =
          scrollPos.current - grantScrollPosRef.current + pos;

        setPan(panAmount);

        // Now we figure out what your panIndex should be based on everyone's
        // heights, starting from the first element. Note that we can't do
        // this math if any element up to your drag point hasn't been measured
        // yet. I don't think that should ever happen, but take note.
        const clientPos = wrapPos + scrollPos.current;
        let curIndex = 0;
        let key;
        while (
          curIndex < dataRef.current.length &&
          layouts.hasOwnProperty(
            (key = keyExtractorRef.current(dataRef.current[curIndex], curIndex))
          ) &&
          layouts[key].pos + layouts[key].extent <
            clientPos + grantActiveCenterOffsetRef.current
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
      }

      const leadingEdge = wrapPos - dragItemExtent / 2;
      const trailingEdge = wrapPos + dragItemExtent / 2;
      let offset = 0;

      // We auto-scroll the FlatList a bit when you drag off the top or
      // bottom edge (or right/left for horizontal ones). These calculations
      // can be a bit finnicky. You need to consider client coordinates and
      // coordinates relative to the screen.
      if (props.scrollEnabled === false) {
        offset = 0;
      } else if (leadingEdge < 0) {
        offset = -dragItemExtent;
      } else if (trailingEdge > flatWrapLayout.current.extent) {
        offset = dragItemExtent;
      }

      if (offset !== 0) {
        function scrollOnce(distance: number) {
          flatRef.current?.scrollToOffset({
            animated: true,
            offset: Math.max(0, scrollPos.current + distance),
          });
          updateRendering();
        }

        scrollOnce(offset);
        autoScrollTimerRef.current = setInterval(() => {
          scrollOnce(offset);
        }, AUTO_SCROLL_MILLIS);
      } else {
        updateRendering();
      }
    },
    []
  );

  const onPanResponderRelease = useCallback(
    async (_: GestureResponderEvent, _gestate: PanResponderGestureState) => {
      const activeIndex = activeDataRef.current?.index;

      clearAutoScrollTimer();
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

          await reorderRef.current?.(activeIndex, panIndex.current);
        } finally {
          isReorderingRef.current = false;
          // #76 - Normally we don't reset here; the parent's data change
          // (in response to onReordered) resets us in the same commit that
          // moves items, which is what keeps the drop atomic. But if the
          // parent never hands us new data (e.g. it mutated in place), we
          // must still tear the drag down or the list stays stuck.
          //
          // This does not race the parent's commit. On React 18+, a setData
          // called during onReordered is still pending when this microtask
          // runs, so reset()'s setState batches with it into a single commit
          // (new data + cleared drag state together). On React 17, setData
          // flushed synchronously during onReordered, which already ran
          // reset(false) via the data-change render, so activeDataRef is
          // null here and we skip. Only parents that defer setData past the
          // microtask queue (setTimeout etc.) see a reset against old data —
          // a brief snap-back, which beats a permanently stuck drag.
          if (activeDataRef.current) {
            reset();
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

  const clearAutoScrollTimer = useCallback(() => {
    if (autoScrollTimerRef.current) {
      clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }, []);

  /**
   * When you don't want to trigger a re-render, pass false so we don't setExtra.
   */
  const reset = useCallback((shouldSetExtra = true) => {
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
    clearAutoScrollTimer();
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
  useLayoutEffect(() => {
    setPan(0);
    // If a data change killed a live drag (reset(false) above), the host
    // still deserves its onDragEnd. This is a no-op when the drag already
    // ended via release/termination.
    fireOwedDragEnd();
  }, [data]);

  const renderDragItem = useCallback(
    (info: ListRenderItemInfo<T>) => {
      const key = keyExtractorRef.current(info.item, info.index);
      const isActive = key === activeDataRef.current?.key;
      const onDragStart = () => {
        // We don't allow dragging for lists less than 2 elements
        if (data.length > 1) {
          // Zero pan synchronously before the activation render attaches it,
          // so the new active item can't inherit a stale offset from a
          // previous drag (setValue also pushes to the native side before the
          // attach command lands, since animated-module commands run in
          // order).
          pan.setValue(0);
          activeDataRef.current = { index: info.index, key: key };
          panIndex.current = info.index;
          hoverBus.index = info.index;
          setExtra({ activeKey: key });
        }
      };
      const onDragEnd = () => {
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
      };

      return props.renderItem({
        ...info,
        onDragStart,
        onStartDrag: onDragStart,
        onDragEnd,
        onEndDrag: onDragEnd,
        isActive,
      });
    },
    [props.renderItem, data.length]
  );

  const onDragScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      scrollPos.current = props.horizontal
        ? event.nativeEvent.contentOffset.x
        : event.nativeEvent.contentOffset.y;
      if (onScroll) {
        onScroll(event);
      }
    },
    [onScroll]
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
          scrollEventThrottle={16} // From react-native-draggable-flatlist; no idea why.
          removeClippedSubviews={false} // https://github.com/facebook/react-native/issues/18616
          {...rest}
        />
      </View>
    </DragListProvider>
  );
}

const SLIDE_MILLIS = 200;
const AUTO_SCROLL_MILLIS = 200;
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
            elevation: 0,
            zIndex: 0,
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
        if (index >= hoverIndex && index <= activeIndex) {
          target = layouts[activeKey].extent;
        } else if (index >= activeIndex && index <= hoverIndex) {
          target = -layouts[activeKey].extent;
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
