// Much of this comes from concepts in https://github.com/computerjazz/react-native-draggable-flatlist/blob/main/src/context/draggableFlatListContext.tsx
import React, { useContext, useMemo } from "react";
import { Animated } from "react-native";

// Tracks the position and extent (width or height) in an axis-independent way
// (i.e. if horizontal, then pos is an x and extent is a width).
export interface PosExtent {
  pos: number; // The x or y position
  extent: number; // The width or height
}

// A map of each item's layout rectangle, used to calculate how much space to
// make for an item being dragged.
export interface LayoutCache {
  [key: string]: PosExtent;
}

export interface ActiveData {
  key: string;
  index: number;
}

// A tiny subscription bus that broadcasts hover-index changes to mounted
// cells without going through React state. Re-rendering the whole FlatList
// (via extraData) on every hover change was the main source of dropped
// frames during drags; cells instead subscribe here and start their own
// slide animations. Memory is bounded by the number of *mounted* cells
// (FlatList's render window), not by data length, because cells unsubscribe
// on unmount.
export interface HoverBus {
  // The current hover index (where the dragged item would land if dropped).
  index: number;
  subscribe: (cb: (hoverIndex: number) => void) => () => void;
  notify: (hoverIndex: number) => void;
}

export function createHoverBus(): HoverBus {
  const listeners = new Set<(hoverIndex: number) => void>();
  return {
    index: -1,
    subscribe(cb: (hoverIndex: number) => void) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    notify(hoverIndex: number) {
      this.index = hoverIndex;
      listeners.forEach(cb => cb(hoverIndex));
    },
  };
}

// This all basically enables us to pass data into a CellRendererComponent,
// which we otherwise don't control the props to.
type ContextProps<T> = {
  activeData: ActiveData | null;
  keyExtractor: (item: T, index: number) => string;
  pan: Animated.Value;
  hoverBus: HoverBus;
  layouts: LayoutCache;
  horizontal: boolean | null | undefined;
  children: React.ReactNode;
};

type DragListContextValue<T> = Omit<ContextProps<T>, "children">;

const DragListContext = React.createContext<
  DragListContextValue<any> | undefined
>(undefined);

export function DragListProvider<T>({
  activeData,
  keyExtractor,
  pan,
  hoverBus,
  layouts,
  horizontal,
  children,
}: ContextProps<T>) {
  const value = useMemo(
    () => ({
      activeData,
      keyExtractor,
      pan,
      hoverBus,
      layouts,
      horizontal,
    }),
    [activeData, keyExtractor, pan, hoverBus, layouts, horizontal]
  );

  return (
    <DragListContext.Provider value={value}>
      {children}
    </DragListContext.Provider>
  );
}

export function useDragListContext<T>() {
  const value = useContext(DragListContext);
  if (!value) {
    throw new Error(
      "useDragListContext must be called within DragListProvider"
    );
  }
  return value as DragListContextValue<T>;
}
