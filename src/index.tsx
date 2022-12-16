import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  FlatList,
  FlatListProps,
  LayoutChangeEvent,
  LayoutRectangle,
  ListRenderItemInfo,
  NativeScrollEvent,
  NativeSyntheticEvent,
  PanResponder,
  Platform,
  StyleProp,
  UIManager,
  View,
  ViewStyle,
} from "react-native";
import {
  DragListProvider,
  LayoutCache,
  useDragListContext,
} from "./DragListContext";

if (Platform.OS === "android") {
  if (UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
  }
}

// Each renderItem call is given this when rendering a DragList
export interface DragListRenderItemInfo<T> extends ListRenderItemInfo<T> {
  // Call this function whenever you detect a drag motion starting.
  onStartDrag: () => void;
  // Whether the item is being dragged at the moment.
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
  keyExtractor: (item: T) => string;
  renderItem: (info: DragListRenderItemInfo<T>) => React.ReactElement | null;
  containerStyle?: StyleProp<ViewStyle>;
  onDragBegin?: () => void;
  onDragEnd?: () => void;
  onReordered?: (fromIndex: number, toIndex: number) => Promise<void>;
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onLayout?: (e: LayoutChangeEvent) => void;
}

export default function DragList<T>(props: Props<T>) {
  const {
    containerStyle,
    data,
    keyExtractor,
    onDragBegin,
    onDragEnd,
    onScroll,
    onLayout,
    renderItem,
    ...rest
  } = props;
  // activeKey and activeIndex track the item being dragged
  const activeKey = useRef<string | null>(null);
  const activeIndex = useRef(-1);
  // panIndex tracks the location where the dragged item would go if dropped
  const panIndex = useRef(-1);
  const [extra, setExtra] = useState<ExtraData>({
    activeKey: activeKey.current,
    panIndex: -1,
  });
  const layouts = useRef<LayoutCache>({}).current;
  const dataRef = useRef(data);
  const reorderRef = useRef(props.onReordered);
  const flatRef = useRef<FlatList<T>>(null);
  const flatWrapRef = useRef<View>(null);
  const flatWrapLayout = useRef<LayoutRectangle>({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  const scrollPos = useRef(0);
  // pan is the drag dy
  const pan = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponderCapture: () => !!activeKey.current,
      onStartShouldSetPanResponder: () => !!activeKey.current,
      onMoveShouldSetPanResponder: () => !!activeKey.current,
      onMoveShouldSetPanResponderCapture: () => !!activeKey.current,
      onPanResponderGrant: (_, gestate) => {
        pan.setValue(gestate.dy);
        onDragBegin?.();
      },
      onPanResponderMove: (_, gestate) => {
        const wrapY = gestate.y0 + gestate.dy - flatWrapLayout.current.y;
        const clientY = wrapY + scrollPos.current;

        if (activeKey.current && layouts.hasOwnProperty(activeKey.current)) {
          const dragItemHeight = layouts[activeKey.current].height;
          const topEdge = wrapY - dragItemHeight / 2;
          const bottomEdge = wrapY + dragItemHeight / 2;
          let offset = 0;

          // We auto-scroll the FlatList a bit when you drag off the top or
          // bottom edge. These calculations can be a bit finnicky. You need to
          // consider client coordinates and coordinates relative to the screen.
          if (topEdge < 0) {
            offset =
              scrollPos.current >= dragItemHeight
                ? -dragItemHeight
                : -scrollPos.current;
          } else if (bottomEdge > flatWrapLayout.current.height) {
            offset = scrollPos.current + dragItemHeight;
          }
          if (offset !== 0) {
            flatRef.current?.scrollToOffset({
              animated: true,
              offset: scrollPos.current + offset,
            });
          }

          // Now we figure out what your panIndex should be based on everyone's
          // heights, starting from the first element. Note that we can't do
          // this math if any element up to your drag point hasn't been measured
          // yet. I don't think that should ever happen, but take note.
          let curIndex = 0;
          let key;
          while (
            curIndex < dataRef.current.length &&
            layouts.hasOwnProperty(
              (key = keyExtractor(dataRef.current[curIndex]))
            ) &&
            layouts[key].y + layouts[key].height < clientY
          ) {
            curIndex++;
          }

          // Note that the pan value assumes you're dragging the item by its
          // vertical center. We could potentially be more awesome by asking
          // onStartDrag to pass us the relative y position of the drag handle.
          pan.setValue(
            clientY - (layouts[activeKey.current].y + dragItemHeight / 2)
          );
          panIndex.current = curIndex;

          // This simply exists to trigger a re-render.
          setExtra({ ...extra, panIndex: panIndex.current });
        }
      },
      onPanResponderRelease: async (_, _gestate) => {
        onDragEnd?.();
        if (
          activeIndex.current !== panIndex.current &&
          // Ignore the case where you drag the last item beyond the end
          !(
            activeIndex.current === dataRef.current.length - 1 &&
            panIndex.current > activeIndex.current
          )
        ) {
          await reorderRef.current?.(activeIndex.current, panIndex.current);
        }
        activeIndex.current = -1;
        activeKey.current = null;
        panIndex.current = -1;
        setExtra({ activeKey: null, panIndex: -1 });
        pan.setValue(0);
      },
    })
  ).current;

  useEffect(() => {
    dataRef.current = data;
  }, [data]);

  useEffect(() => {
    reorderRef.current = props.onReordered;
  }, [props.onReordered]);

  function renderDragItem(info: ListRenderItemInfo<T>) {
    const key = keyExtractor(info.item);
    const isActive = key === activeKey.current;

    return props.renderItem({
      ...info,
      onStartDrag: () => {
        // We don't allow dragging for lists less than 2 elements
        if (data.length > 1) {
          activeIndex.current = info.index;
          activeKey.current = key;
          panIndex.current = activeIndex.current;
          setExtra({ activeKey: key, panIndex: info.index });
        }
      },
      isActive,
    });
  }

  function onDragScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    scrollPos.current = event.nativeEvent.contentOffset.y;
    if (onScroll) {
      onScroll(event);
    }
  }

  function onDragLayout(evt: LayoutChangeEvent) {
    flatWrapRef.current?.measure((_x, _y, width, height, pageX, pageY) => {
      flatWrapLayout.current = { x: pageX, y: pageY, width, height };
    });
    if (onLayout) {
      onLayout(evt);
    }
  }

  return (
    <DragListProvider
      activeKey={activeKey.current}
      activeIndex={activeIndex.current}
      keyExtractor={keyExtractor}
      pan={pan}
      panIndex={panIndex.current}
      layouts={layouts}
    >
      <View
        ref={flatWrapRef}
        style={containerStyle}
        {...panResponder.panHandlers}
        onLayout={onDragLayout}
      >
        <FlatList
          ref={flatRef}
          keyExtractor={keyExtractor}
          data={data}
          renderItem={renderDragItem}
          CellRendererComponent={CellRendererComponent}
          extraData={extra}
          onScroll={onDragScroll}
          scrollEventThrottle={16} // From react-native-draggable-flatlist; no idea why.
          removeClippedSubviews={false} // https://github.com/facebook/react-native/issues/18616
          {...rest}
        />
      </View>
    </DragListProvider>
  );
}

const SLIDE_MILLIS = 300;

type CellRendererProps<T> = {
  item: T;
  index: number;
  children: React.ReactNode;
  onLayout?: (e: LayoutChangeEvent) => void;
  style?: StyleProp<ViewStyle>;
};

function CellRendererComponent<T>(props: CellRendererProps<T>) {
  const { item, index, children, style, onLayout, ...rest } = props;
  const { keyExtractor, activeKey, activeIndex, pan, panIndex, layouts } =
    useDragListContext<T>();
  const [isOffset, setIsOffset] = useState(false); // Whether anim != 0
  const key = keyExtractor(item, index);
  const isActive = key === activeKey;
  const ref = useRef<View>(null);
  const anim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (activeKey && !isActive && layouts.hasOwnProperty(activeKey)) {
      if (index >= panIndex && index <= activeIndex) {
        Animated.timing(anim, {
          duration: SLIDE_MILLIS,
          easing: Easing.inOut(Easing.linear),
          toValue: layouts[activeKey].height,
          useNativeDriver: true,
        }).start();
        setIsOffset(true);
        return;
      } else if (index >= activeIndex && index <= panIndex) {
        Animated.timing(anim, {
          duration: SLIDE_MILLIS,
          easing: Easing.inOut(Easing.linear),
          toValue: -layouts[activeKey].height,
          useNativeDriver: true,
        }).start();
        setIsOffset(true);
        return;
      }
    }
    setIsOffset(false);
  }, [activeKey, index, panIndex, key, activeIndex]);

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

    ref.current?.measure((x, y, width, height) => {
      layouts[key] = { x, y, width, height };
    });
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
              elevation: 1,
              zIndex: 999,
              transform: [{ translateY: pan }],
            }
          : { elevation: 0, zIndex: 0, transform: [{ translateY: anim }] },
      ]}
      onLayout={onCellLayout}
    >
      {children}
    </Animated.View>
  );
}
