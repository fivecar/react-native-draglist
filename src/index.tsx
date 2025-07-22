import React, {
  useCallback,
  useEffect,
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

// Used merely to trigger FlatList to re-render when necessary. Changing the
// activeKey or the panIndex should both trigger re-render.
interface ExtraData {
  activeKey: string | null;
  panIndex: number;
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
  const [extra, setExtra] = useState<ExtraData>({
    activeKey: activeDataRef.current?.key ?? null,
    panIndex: -1,
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

  // #76 When we finalize a reordering (i.e. when our parent gets `onReordered`), we need to
  // insulate ourselves from the parent changing the data we render without us controlling the
  // syncing of that change with all our animation state. So we render from dataRef instead of data
  // directly, so that during reordering, we don't see the parent's data change.
  const dataRef = useRef(data);

  const flatRef = useRef<FlatList<T> | null>(null);
  const flatWrapRef = useRef<View>(null);
  const flatWrapLayout = useRef<PosExtent>({
    pos: 0,
    extent: 1,
  });
  const flatWrapRefPosUpdatedRef = useRef(false);
  const scrollPos = useRef(0);

  // pan is the drag dy
  const pan = useRef(new Animated.Value(0)).current;
  const setPan = useCallback(
    (value: number) => {
      // Starting RN 0.76.3, pan.setValue(whatever) no longer animates the isActive item. Dunno whether
      // it's the useNativeDriver or what that gets this working again. So, lamely, we set the value
      // using a zero-duration Animated.timing.
      Animated.timing(pan, {
        duration: 0,
        toValue: value,
        useNativeDriver: true,
      }).start();
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

      onDragBegin?.();
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
      const pos = props.horizontal ? gestate.dx : gestate.dy;
      const wrapPos = posOrigin + pos - flatWrapLayout.current.pos;

      function updateRendering() {
        const movedAmount = props.horizontal ? gestate.dx : gestate.dy;
        const panAmount =
          scrollPos.current - grantScrollPosRef.current + movedAmount;

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

        // This simply exists to trigger a re-render.
        if (panIndex.current != curIndex) {
          setExtra({ ...extra, panIndex: curIndex });
          hoverRef.current?.(curIndex);
          panIndex.current = curIndex;
        }
      }

      const dragItemExtent = layouts[activeDataRef.current.key].extent;
      const leadingEdge = wrapPos - dragItemExtent / 2;
      const trailingEdge = wrapPos + dragItemExtent / 2;
      let offset = 0;

      // We auto-scroll the FlatList a bit when you drag off the top or
      // bottom edge (or right/left for horizontal ones). These calculations
      // can be a bit finnicky. You need to consider client coordinates and
      // coordinates relative to the screen.
      if (leadingEdge < 0) {
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
      onDragEnd?.();

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

          // #76 We need to control what we render so it's always in sync with our animation
          // state. When we call onReordered, the parent can change the data we render without us
          // being able to sync that change with our own state, so we insulate ourselves during
          // this render by keeping our own copy of data. Our `useEffect` will run after the
          // render that onReordered triggers, which will then restore our ref back to pointing at
          // the parent's data.
          const dataCopy = [...dataRef.current];
          const itemToMove = dataCopy.splice(activeIndex, 1);
          dataCopy.splice(panIndex.current, 0, itemToMove[0]);
          dataRef.current = dataCopy;

          await reorderRef.current?.(activeIndex, panIndex.current);
        } finally {
          // This needs to come before reset(), which causes a re-render that depends on
          // isReorderingRef.current reflecting the fact we're not reordering anymore.
          isReorderingRef.current = false;
          reset(); // Guarantee resetting by putting this in finally
        }
      } else {
        // #76 - Only reset here if we're not going to reorder the list. If we are instead
        // reordering the list, we shouldn't reset until after the useLayoutEffect is done, or
        // else things will animate/jump around briefly.
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
    })
  ).current;

  const clearAutoScrollTimer = useCallback(() => {
    if (autoScrollTimerRef.current) {
      clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }, []);

  const reset = useCallback(() => {
    activeDataRef.current = null;
    panIndex.current = -1;
    setExtra({
      activeKey: null,
      panIndex: -1,
      detritus: Math.random().toString(),
    });
    setPan(0);
    panGrantedRef.current = false;
    grantActiveCenterOffsetRef.current = 0;
    clearAutoScrollTimer();
  }, []);

  useEffect(() => {
    // #76 Deliberately sync dataRef with a useEffect, not a useMemo, so that we update it after
    // rendering. This only truly matters during a reorder-triggered rendering, where we keep our
    // own copy of `data`.
    dataRef.current = data;
    setExtra({
      activeKey: null,
      panIndex: -1,
      detritus: Math.random().toString(),
    }); // Trigger a re-render whenever data changes
  }, [data]);

  const renderDragItem = useCallback(
    (info: ListRenderItemInfo<T>) => {
      const key = keyExtractorRef.current(info.item, info.index);
      const isActive = key === activeDataRef.current?.key;
      const onDragStart = () => {
        // We don't allow dragging for lists less than 2 elements
        if (data.length > 1) {
          activeDataRef.current = { index: info.index, key: key };
          panIndex.current = info.index;
          setExtra({ activeKey: key, panIndex: info.index });
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
      panIndex={panIndex.current}
      isReordering={isReorderingRef.current}
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
          keyExtractor={keyExtractorRef.current}
          data={dataRef.current}
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
  const {
    keyExtractor,
    activeData,
    pan,
    panIndex,
    isReordering,
    layouts,
    horizontal,
  } = useDragListContext<T>();
  const cellRef = useRef<View>(null);
  const key = keyExtractor(item, index);
  const isActive = key === activeData?.key;
  const anim = useRef(new Animated.Value(0)).current;
  // https://github.com/fivecar/react-native-draglist/issues/53
  // Starting RN 0.76.3, we need to use Animated.Value instead of a plain number
  // for Animated.View's elevation and zIndex. I (fivecar) don't understand why.
  // If you use raw numbers, the elevation and zIndex don't have an effect.
  const style = useMemo(() => {
    return [
      props.style,
      isActive
        ? {
            elevation: ANIM_VALUE_ONE,
            zIndex: ANIM_VALUE_NINER,
            transform: [horizontal ? { translateX: pan } : { translateY: pan }],
          }
        : {
            elevation: ANIM_VALUE_ZERO,
            zIndex: ANIM_VALUE_ZERO,
            transform: [
              horizontal ? { translateX: anim } : { translateY: anim },
            ],
          },
    ];
  }, [props.style, isActive, horizontal, pan, anim]);
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
  // #76 This is done as a memo instead of an effect because we want the anim change to start right
  // away, even on this very render (e.g. cases where we set it immediately to zero), whereas an
  // effect would render this without that change first, and then start changing anim.
  const _animCharge = useMemo(() => {
    if (isReordering) {
      // Do not change anim when reordering. Even though it seems safe to do, iOS v. Android
      // could/do recycle views and changing the anim will cause things to visually jump even if you
      // think your rendering code shouldn't have that problem.
      return;
    }

    if (activeData != null) {
      const activeKey = activeData.key;
      const activeIndex = activeData.index;

      if (!isActive && layouts.hasOwnProperty(activeKey)) {
        if (index >= panIndex && index <= activeIndex) {
          return Animated.timing(anim, {
            duration: SLIDE_MILLIS,
            easing: Easing.inOut(Easing.linear),
            toValue: layouts[activeKey].extent,
            useNativeDriver: true,
          }).start();
        } else if (index >= activeIndex && index <= panIndex) {
          return Animated.timing(anim, {
            duration: SLIDE_MILLIS,
            easing: Easing.inOut(Easing.linear),
            toValue: -layouts[activeKey].extent,
            useNativeDriver: true,
          }).start();
        }
      }
    }
    return Animated.timing(anim, {
      duration: activeData?.key ? SLIDE_MILLIS : 0,
      easing: Easing.inOut(Easing.linear),
      toValue: 0,
      useNativeDriver: true,
    }).start();
  }, [index, panIndex, key, activeData, horizontal, isReordering]);

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
    >
      {children}
    </Animated.View>
  );
}

const DragList = React.forwardRef(DragListImpl) as <T>(
  props: Props<T> & { ref?: React.ForwardedRef<FlatList<T>> }
) => React.ReactElement;

export default DragList;
