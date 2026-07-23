# CLAUDE.md

## Build Commands

- `npm run build` — builds via microbundle-crl (`--no-compress --format modern,cjs`) into `dist/`
- `npm run release` — releases via release-it (with conventional changelog and GitHub release)
- `npm run prepare` — runs build automatically on `npm install`
- No automated tests or linting configured in the root project

## Development Workflow

After making changes to source files, rebuild and test in the example app:

```sh
npm run build
cd example
npm i ..          # reinstalls the freshly built dist/ into the example
npm run android   # or npm run ios
```

All validation is manual — test on **both iOS and Android**. Key test cases:
- Drag reorder in short and long/scrolling lists
- Auto-scroll when dragging beyond list bounds
- Drag-and-release back to original position
- "Scroll to Top" button (verifies forwardRef)
- Horizontal list dragging

## Architecture

Two source files:

- **`src/index.tsx`** — `DragList` component (forwardRef wrapper around FlatList). Manages drag state via PanResponder, auto-scrolling, and reorder logic. Exports `DragListRenderItemInfo<T>` with `onDragStart`/`onDragEnd`/`isActive`. Contains `CellRendererComponent` which handles per-cell animation (slide displacement via `Animated.timing`).
- **`src/DragListContext.tsx`** — `DragListProvider` context and `useDragListContext` hook. Passes drag state (activeData, pan, panIndex, layouts) from DragList into CellRendererComponent without prop drilling.

### Key Patterns

- **Built-in Animated API + PanResponder only** — intentionally avoids react-native-reanimated. No external dependencies beyond React/React Native peer deps.
- **Layout caching in refs** — `layouts` ref stores `{ pos, extent }` per item key, used for hit-testing and displacement calculations. Axis-independent (pos/extent works for both horizontal and vertical).
- **Generation-based key extraction** — `dataGenRef` increments on each data change. Keys are suffixed with the generation number to force React Native to avoid reusing stale native views.
- **Ref-based state for non-render paths** — `activeDataRef`, `panIndex`, `scrollPos`, `panGrantedRef` etc. are refs to avoid unnecessary re-renders during drag. `setExtra` is used sparingly to trigger re-renders only when needed.
- **Reorder serialization** — `isReorderingRef` prevents new pan captures during an async `onReordered` callback to avoid stale-index bugs.

### Platform Workarounds

- **React Native Web** — `onLayout` doesn't fire as expected on web (`CellRendererComponent` line 636–646), so cell measurement falls back to `measure()` in a `useEffect`.
- **RN 0.76.3+** — `pan.setValue()` stopped working for the active item; replaced with zero-duration `Animated.timing`. Also, elevation/zIndex require `Animated.Value` instead of plain numbers.
