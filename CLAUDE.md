# CLAUDE.md

## Build Commands

- `npm run build` — builds via microbundle-crl (`--no-compress --format modern,cjs`) into `dist/`
- `npm run release` — releases via release-it (with conventional changelog and GitHub release)
- `npm run prepare` — runs build automatically on `npm install`
- `npm test` — runs the Jest regression suite in `src/__tests__/` (responder termination, mid-drag data changes, key stability, mirrored/RTL layouts). No linting configured.

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
- The same horizontal cases under RTL, via the example app's direction toggle. On iOS the toggle's
  reload isn't enough — relaunch natively (`xcrun simctl terminate`/`launch`) for `forceRTL` to take
  effect. Watch the printed data order under the horizontal list: the visual order mirrors, so it's
  the only way to tell a correct drop from one that landed at the mirrored index.

## Architecture

Two source files:

- **`src/index.tsx`** — `DragList` component (forwardRef wrapper around FlatList). Manages drag state via PanResponder, auto-scrolling, and reorder logic. Exports `DragListRenderItemInfo<T>` with `onDragStart`/`onDragEnd`/`isActive`. Contains `CellRendererComponent` which handles per-cell animation (slide displacement via `Animated.timing`).
- **`src/DragListContext.tsx`** — `DragListProvider` context and `useDragListContext` hook. Passes drag state (activeData, pan, panIndex, layouts) from DragList into CellRendererComponent without prop drilling.

### Key Patterns

- **Built-in Animated API + PanResponder only** — intentionally avoids react-native-reanimated. No external dependencies beyond React/React Native peer deps.
- **Layout caching in refs** — `layouts` ref stores `{ pos, extent }` per item key, used for hit-testing and displacement calculations. Axis-independent (pos/extent works for both horizontal and vertical).
- **Stable keys + static idle transforms** — item keys are stable across data changes (required for `maintainVisibleContentPosition` on Fabric, and avoids remounting every row). Cells attach Animated transform nodes ONLY while a drag is active; when idle they render a static `transform: 0`, so the commit that applies reordered data carries zeroed transforms atomically with the new layout. This is the flash-on-drop fix: async native-animated commands can never race the commit because nodes attach at value 0 and detach in commits that already specify 0. Do not reintroduce always-attached Animated transforms or generation-suffixed keys. The `layouts` cache is pruned of removed keys on each data change.
- **Drag teardown invariant** — `props.onDragBegin`/`props.onDragEnd` must always pair up. `dragEndOwedRef` tracks the debt; every teardown path (release, `onPanResponderTerminate`, mid-drag data change) settles it via `fireOwedDragEnd`. Responder termination commits the reorder at the current hover index (deliberate choice — see README caveat on gesture recognizers).
- **Auto-scroll frame loop** — dragging past an edge drives `scrollToOffset({animated: false})` from a `requestAnimationFrame` loop at a speed that ramps with how far past the edge you are. It used to step a whole item per 200ms interval with `animated: true`, which read as a series of jumps (#94). The load-bearing idea is that the loop, not `onScroll`, is the authority on where the list is mid-drag: `onScroll` reports lag a frame or more and arrive unevenly, and nothing else moves the list while a drag is up (scrolling is disabled). So the loop integrates its own offset (`autoScrollOffsetRef` in flow space, `autoScrollScrollPosRef` its cartesian twin) seeded once *per drag* — not per run, since the loop stops and restarts every time your finger dips back inside — and `updateRendering` draws against that via `effectiveScrollPos()` rather than `scrollPos`. `autoScrollSeededRef` must therefore be cleared at *both* ends of a drag: `reset()` handles the normal teardown, and `startDrag` handles a drag that supersedes a reorder still awaiting (or inside its grace window), which never goes through `reset()` — otherwise the stale offset is read against a `grantScrollPosRef` captured from `scrollPos`, displacing the new item. Reseeding on restart jerks the drag backwards; drawing against `scrollPos` jitters the dragged item and leaves the last command before an end-of-list pin undrawn, so a release reorders to a stale slot. The loop also clamps to `contentExtentRef - flatWrapLayout.extent + autoScrollTrailingInsetRef` and stops when pinned, so it can't run away past the end. The inset term matters because iOS lists can legally scroll past their content by a trailing `contentInset` (an overlaid bar, an adjusted safe area); omitting it pins an inset early and strands the last rows under the overlay. Android reports zeros there, which is correct for it. A corollary: a host that scrolls this list through the forwarded ref *during* a drag will be overridden on the next frame, deliberately. `onContentSizeChange` is destructured out of `rest` and chained (like `onScroll`/`onLayout`) because `rest` is spread last and would otherwise let a host silently replace our handler.
- **Ref-based state for non-render paths** — `activeDataRef`, `panIndex`, `scrollPos`, `panGrantedRef` etc. are refs to avoid unnecessary re-renders during drag. `setExtra` is used sparingly to trigger re-renders only when needed.
- **Reorder serialization** — `isReorderingRef` prevents new pan captures during an async `onReordered` callback to avoid stale-index bugs.
- **Flow order vs. coordinate order** — Anything relating positions to indices must walk in *flow* order (increasing with data index), which equals coordinate order only when the layout isn't mirrored. `isLayoutMirrored(horizontal)` is true for horizontal lists under `I18nManager.isRTL`, where Yoga mirrors the row so `layouts[key].pos` descends as the index rises. The hover scan compares negated coordinates via `flowTrailingEdge()`, and cell slide targets flip sign, since transforms aren't mirrored for us the way layout is. Separately, `scrollToOffset` takes a flow-relative offset under RTL (counted from the start of the data) while `onScroll`'s `contentOffset` stays cartesian, so `scrollPos`/`flowScrollPos` track both spaces; feeding the cartesian value to `scrollToOffset` makes VirtualizedList mirror an already-mirrored number and flings the list most of its length. `inverted` is a *different* mirror — render-stage `scaleX`/`scaleY` that Yoga never sees, so it flips the pointer-to-content mapping instead of the index ordering — and is unsupported; it needs its own predicate, not this one.

### Platform Workarounds

- **React Native Web** — `onLayout` doesn't fire as expected on web (`CellRendererComponent` line 636–646), so cell measurement falls back to `measure()` in a `useEffect`.
- **RN 0.76.3+** — `pan.setValue()` stopped working for the active item; replaced with zero-duration `Animated.timing`. Also, elevation/zIndex require `Animated.Value` instead of plain numbers.
