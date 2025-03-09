# Welcome

Thank you for being willing to contribute to this project. To make edits and verify what
you've done is correct/ok, please use the example project (in `/example`) to validate your changes.

```console
npm install
cd example
npm install
npm run android   # or `npm run ios`, which takes longer to build
```

Note that whenever you make changes to code in the package itself (e.g. `index.tsx`), you'll need to
update the example app to use it:

```console
npm run build
cd example
npm i .. # This reinstalls the stuff you just built into `/dist`
npm run android
npm run ios
```

## Validation
I've unfortunately had no time to write tests for this, nor do I have the expertise to know how to
test panResponder stuff correctly. So if you can believe it, all changes need to be manually tested
in this package.

### Test Cases

**You must test on both Android and iOS!** Annoyingly, the native implementations of lists and
animations are different enough between the platforms that we often find one OS works great while
the other goes janky/wonky.

When testing in the example app, please consider at least the following:
- Dragging items in the short list. This is the basic case.
- Beginning to drag an item, but then placing it back where you started.
- Dragging items in the long, scrolling list.
- Dragging items in the scrolling list beyond its bottom or top extent to test auto-scrolling.
- Tapping "Scroll to Top" to make sure forwardRefs aren't broken.
- Dragging in the horizontal list.

## Thank You!
I will try to be active on PRs and issues to help contributors as much as possible. Thanks!