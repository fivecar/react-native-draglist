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
  LayoutChangeEvent,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  StyleProp,
  View,
  ViewStyle,
} from "react-native";
import {
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
  const activeKey = useRef<string | null>(null);
  const activeIndex = useRef(-1);
  const reorderingRef = useRef(false);
  // panIndex tracks the location where the dragged item would go if dropped
  const panIndex = useRef(-1);
  const [extra, setExtra] = useState<ExtraData>({
    activeKey: activeKey.current,
    panIndex: -1,
  });
  const layouts = useRef<LayoutCache>({}).current;
  const dataRef = useRef(data);
  const panGrantedRef = useRef(false);
  const grantScrollPosRef = useRef(0); // Scroll pos when granted
  // The amount you need to add to the touched position to get to the active
  // item's center.
  const grantActiveCenterOffsetRef = useRef(0);
  const autoScrollTimerRef = useRef<ReturnType<typeof setInterval> | null>(
    null
  );
  const hoverRef = useRef(props.onHoverChanged);
  const reorderRef = useRef(props.onReordered);
  const flatRef = useRef<FlatList<T> | null>(null);
  const flatWrapRef = useRef<View>(null);
  const flatWrapLayout = useRef<PosExtent>({
    pos: 0,
    extent: 1,
  });
  const scrollPos = useRef(0);
  // pan is the drag dy
  const pan = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () =>
        !!activeKey.current && !reorderingRef.current,
      onStartShouldSetPanResponder: () =>
        !!activeKey.current && !reorderingRef.current,
      onMoveShouldSetPanResponder: () =>
        !!activeKey.current && !reorderingRef.current,
      onMoveShouldSetPanResponderCapture: () =>
        !!activeKey.current && !reorderingRef.current,
      onPanResponderGrant: (_, gestate) => {
        grantScrollPosRef.current = scrollPos.current;
        pan.setValue(0);
        panGrantedRef.current = true;

        flatWrapRef.current?.measure(
          (_x, _y, _width, _height, pageX, pageY) => {
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
          }
        );

        if (activeKey.current && layouts.hasOwnProperty(activeKey.current)) {
          const itemLayout = layouts[activeKey.current];
          const screenPos = props.horizontal ? gestate.x0 : gestate.y0;
          const clientViewPos = screenPos - flatWrapLayout.current.pos;
          const clientPos = clientViewPos + scrollPos.current;
          const posOnActiveItem = clientPos - itemLayout.pos;

          grantActiveCenterOffsetRef.current =
            itemLayout.extent / 2 - posOnActiveItem;
        } else {
          grantActiveCenterOffsetRef.current = 0;
        }

        onDragBegin?.();
      },
      onPanResponderMove: (_, gestate) => {
        if (autoScrollTimerRef.current) {
          clearInterval(autoScrollTimerRef.current);
          autoScrollTimerRef.current = null;
        }

        if (!activeKey.current || !layouts.hasOwnProperty(activeKey.current)) {
          return;
        }

        const posOrigin = props.horizontal ? gestate.x0 : gestate.y0;
        const pos = props.horizontal ? gestate.dx : gestate.dy;
        const wrapPos = posOrigin + pos - flatWrapLayout.current.pos;

        function updateRendering() {
          const movedAmount = props.horizontal ? gestate.dx : gestate.dy;
          const panAmount =
            scrollPos.current - grantScrollPosRef.current + movedAmount;

          // https://github.com/fivecar/react-native-draglist/issues/53
          // Starting RN 0.76.3, pan.setValue(whatever) no longer animates the
          // isActive item. Dunno whether it's the useNativeDriver or what that
          // gets this working again. So, lamely, we set the value using a
          // zero-duration Animated.timing.
          Animated.timing(pan, {
            duration: 0,
            easing: Easing.inOut(Easing.linear),
            toValue: panAmount,
            useNativeDriver: true,
          }).start();

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
              (key = keyExtractor(dataRef.current[curIndex], curIndex))
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

        const dragItemExtent = layouts[activeKey.current].extent;
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
      onPanResponderRelease: async (_, _gestate) => {
        if (autoScrollTimerRef.current) {
          clearInterval(autoScrollTimerRef.current);
          autoScrollTimerRef.current = null;
        }
        onDragEnd?.();
        if (
          activeIndex.current !== panIndex.current &&
          // Ignore the case where you drag the last item beyond the end
          !(
            activeIndex.current === dataRef.current.length - 1 &&
            panIndex.current > activeIndex.current
          )
        ) {
          try {
            // We serialize reordering so that we don't capture any new pan
            // attempts during this time. Otherwise, onReordered could be called
            // with indices that would be stale if you panned several times
            // quickly (e.g. if onReordered deletes an item, the next
            // onReordered call would be made on a list whose indices are
            // stale).
            reorderingRef.current = true;
            await reorderRef.current?.(activeIndex.current, panIndex.current);
          } finally {
            reorderingRef.current = false;
          }
        }
        reset();
      },
    })
  ).current;

  const reset = useCallback(() => {
    activeIndex.current = -1;
    activeKey.current = null;
    panIndex.current = -1;
    setExtra({ activeKey: null, panIndex: -1 });
    pan.setValue(0);
    panGrantedRef.current = false;
    grantActiveCenterOffsetRef.current = 0;
    if (autoScrollTimerRef.current) {
      clearInterval(autoScrollTimerRef.current);
      autoScrollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    reorderRef.current = props.onReordered;
  }, [props.onReordered]);

  const renderDragItem = useCallback(
    (info: ListRenderItemInfo<T>) => {
      const key = keyExtractor(info.item, info.index);
      const isActive = key === activeKey.current;
      const onDragStart = () => {
        // We don't allow dragging for lists less than 2 elements
        if (data.length > 1) {
          activeIndex.current = info.index;
          activeKey.current = key;
          panIndex.current = activeIndex.current;
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
        if (activeKey.current !== null && !panGrantedRef.current) {
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
      activeKey={activeKey.current}
      activeIndex={activeIndex.current}
      keyExtractor={keyExtractor}
      pan={pan}
      panIndex={panIndex.current}
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
          keyExtractor={keyExtractor}
          data={data}
          renderItem={renderDragItem}
          CellRendererComponent={CellRendererComponent}
          extraData={extra}
          scrollEnabled={!activeKey.current}
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

type CellRendererProps<T> = {
  item: T;
  index: number;
  children: React.ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
};

function CellRendererComponent<T>(props: CellRendererProps<T>) {
  const { item, index, children, style, onLayout, ...rest } = props;
  const {
    keyExtractor,
    activeKey,
    activeIndex,
    pan,
    panIndex,
    layouts,
    horizontal,
  } = useDragListContext<T>();
  const [isOffset, setIsOffset] = useState(false); // Whether anim != 0
  const key = keyExtractor(item, index);
  const isActive = key === activeKey;
  const ref = useRef<View>(null);
  const anim = useRef(new Animated.Value(0)).current;
  // https://github.com/fivecar/react-native-draglist/issues/53
  // Starting RN 0.76.3, we need to use Animated.Value instead of a plain number
  // for Animated.View's elevation and zIndex. I (fivecar) don't understand why.
  // If you use raw numbers, the elevation and zIndex don't have an effect.
  const elevations = useMemo(
    () =>
      isActive
        ? { elevation: new Animated.Value(1), zIndex: new Animated.Value(999) }
        : { elevation: new Animated.Value(0), zIndex: new Animated.Value(0) },
    [isActive]
  );

  useEffect(() => {
    if (activeKey && !isActive && layouts.hasOwnProperty(activeKey)) {
      if (index >= panIndex && index <= activeIndex) {
        Animated.timing(anim, {
          duration: SLIDE_MILLIS,
          easing: Easing.inOut(Easing.linear),
          toValue: layouts[activeKey].extent,
          useNativeDriver: true,
        }).start();
        setIsOffset(true);
        return;
      } else if (index >= activeIndex && index <= panIndex) {
        Animated.timing(anim, {
          duration: SLIDE_MILLIS,
          easing: Easing.inOut(Easing.linear),
          toValue: -layouts[activeKey].extent,
          useNativeDriver: true,
        }).start();
        setIsOffset(true);
        return;
      }
    }
    if (!activeKey) {
      anim.setValue(0);
    }
    setIsOffset(false);
  }, [activeKey, index, panIndex, key, activeIndex, horizontal]);

  useEffect(() => {
    if (!isOffset) {
      Animated.timing(anim, {
        duration: SLIDE_MILLIS,
        easing: Easing.inOut(Easing.linear),
        toValue: 0,
        useNativeDriver: true,
      }).start();
    }
  }, [isOffset]);

  function onCellLayout(evt: LayoutChangeEvent) {
    if (onLayout) {
      onLayout(evt);
    }

    const layout = evt.nativeEvent.layout;
    layouts[key] = horizontal
      ? { pos: layout.x, extent: layout.width }
      : { pos: layout.y, extent: layout.height };
  }

  return (
    <Animated.View
      ref={ref}
      key={key}
      {...rest}
      style={[
        style,
        isActive
          ? {
              ...elevations,
              transform: [
                horizontal ? { translateX: pan } : { translateY: pan },
              ],
            }
          : {
              ...elevations,
              transform: [
                horizontal ? { translateX: anim } : { translateY: anim },
              ],
            },
      ]}
      onLayout={onCellLayout}
    >
      {children}
    </Animated.View>
  );
}

declare module "react" {
  function forwardRef<T, P = {}>(
    render: (props: P, ref: React.Ref<T>) => React.ReactNode | null
  ): (props: P & React.RefAttributes<T>) => React.ReactNode | null;
}

const DragList = React.forwardRef(DragListImpl);

export default DragList;
