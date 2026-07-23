# CLAUDE.md

## Build Commands

- `npm run build` — builds via microbundle-crl (`--no-compress --format modern,cjs`) into `dist/`
- `npm run release` — releases via release-it (with conventional changelog and GitHub release)
- `npm run prepare` — runs build automatically on `npm install`
- `npm test` — runs the Jest regression suite in `src/__tests__/` (responder termination, mid-drag data changes, key stability). No linting configured.

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
- **Stable keys + static idle transforms** — item keys are stable across data changes (required for `maintainVisibleContentPosition` on Fabric, and avoids remounting every row). Cells attach Animated transform nodes ONLY while a drag is active; when idle they render a static `transform: 0`, so the commit that applies reordered data carries zeroed transforms atomically with the new layout. This is the flash-on-drop fix: async native-animated commands can never race the commit because nodes attach at value 0 and detach in commits that already specify 0. Do not reintroduce always-attached Animated transforms or generation-suffixed keys. The `layouts` cache is pruned of removed keys on each data change.
- **Drag teardown invariant** — `props.onDragBegin`/`props.onDragEnd` must always pair up. `dragEndOwedRef` tracks the debt; every teardown path (release, `onPanResponderTerminate`, mid-drag data change) settles it via `fireOwedDragEnd`. Responder termination commits the reorder at the current hover index (deliberate choice — see README caveat on gesture recognizers).
- **Ref-based state for non-render paths** — `activeDataRef`, `panIndex`, `scrollPos`, `panGrantedRef` etc. are refs to avoid unnecessary re-renders during drag. `setExtra` is used sparingly to trigger re-renders only when needed.
- **Reorder serialization** — `isReorderingRef` prevents new pan captures during an async `onReordered` callback to avoid stale-index bugs.

### Platform Workarounds

- **React Native Web** — `onLayout` doesn't fire as expected on web (`CellRendererComponent` line 636–646), so cell measurement falls back to `measure()` in a `useEffect`.
- **RN 0.76.3+** — `pan.setValue()` stopped working for the active item; replaced with zero-duration `Animated.timing`. Also, elevation/zIndex require `Animated.Value` instead of plain numbers.
