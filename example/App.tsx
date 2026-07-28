import React, {useMemo, useState} from 'react';
import {
  Alert,
  Button,
  DevSettings,
  FlatList,
  I18nManager,
  SafeAreaView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import DragList, {DragListRenderItemInfo} from 'react-native-draglist';

const SOUND_OF_SILENCE = ['hello', 'darkness', 'my', 'old', 'friend'];
// Long enough to overflow the screen, so horizontal auto-scroll is exercised.
const HORZ_ITEMS = Array.from({length: 20}, (_, i) => `h${i}`);

function toggleRTL() {
  const next = !I18nManager.isRTL;

  I18nManager.allowRTL(next);
  I18nManager.forceRTL(next);
  Alert.alert(
    `Switching to ${next ? 'RTL' : 'LTR'}`,
    'Reloading. If the direction does not change, fully quit and relaunch the app.',
    [{text: 'OK', onPress: () => DevSettings.reload()}],
  );
}

export default function DraggableLyrics() {
  const [data, setData] = useState(SOUND_OF_SILENCE);
  const [scrollData, setScrollData] = useState(
    [8, 6, 7, 5, 3, 0, 9]
      .map(num => SOUND_OF_SILENCE.map(word => `${word}${num}`))
      .flat(),
  );
  const [horzData, setHorzData] = useState(HORZ_ITEMS);
  const listRef = React.useRef<FlatList<string> | null>(null);
  const header = useMemo(() => {
    return (
      <View>
        <Text>Drag my header</Text>
      </View>
    );
  }, []);
  const footer = useMemo(() => {
    return (
      <View>
        <Text>Drag my footer</Text>
      </View>
    );
  }, []);

  function keyExtractor(str: string) {
    return str;
  }

  function renderItem(info: DragListRenderItemInfo<string>) {
    const {item, onDragStart, onDragEnd, isActive} = info;

    return (
      <TouchableOpacity
        key={item}
        style={[styles.item, isActive && styles.active]}
        onPressIn={onDragStart}
        onPressOut={onDragEnd}>
        <Text style={styles.text}>{item}</Text>
      </TouchableOpacity>
    );
  }

  function renderHorzItem(info: DragListRenderItemInfo<string>) {
    const {item, onDragStart, onDragEnd, isActive} = info;

    return (
      <TouchableOpacity
        key={item}
        style={[styles.item, styles.horzItem, isActive && styles.active]}
        onPressIn={onDragStart}
        onPressOut={onDragEnd}>
        <Text style={styles.text}>{item}</Text>
      </TouchableOpacity>
    );
  }

  async function onReordered(fromIndex: number, toIndex: number) {
    const copy = [...data]; // Don't modify react data in-place
    const removed = copy.splice(fromIndex, 1);

    copy.splice(toIndex, 0, removed[0]); // Now insert at the new pos
    setData(copy);
  }

  async function onScrollReordered(fromIndex: number, toIndex: number) {
    const copy = [...scrollData]; // Don't modify react data in-place
    const removed = copy.splice(fromIndex, 1);

    copy.splice(toIndex, 0, removed[0]); // Now insert at the new pos
    setScrollData(copy);
  }

  async function onReorderedHorz(fromIndex: number, toIndex: number) {
    const copy = [...horzData]; // Don't modify react data in-place
    const removed = copy.splice(fromIndex, 1);

    copy.splice(toIndex, 0, removed[0]); // Now insert at the new pos
    setHorzData(copy);
  }

  return (
    // SafeAreaView overwrites its own padding with the window insets, so the
    // layout padding has to live on a child.
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.dirRow}>
          <Text style={styles.dirLabel}>
            Direction: {I18nManager.isRTL ? 'RTL' : 'LTR'}
          </Text>
          <Button
            onPress={toggleRTL}
            title={`Switch to ${I18nManager.isRTL ? 'LTR' : 'RTL'}`}
          />
        </View>
        <Text style={styles.header}>Basic List</Text>
        <DragList
          data={data}
          keyExtractor={keyExtractor}
          onReordered={onReordered}
          renderItem={renderItem}
        />
        <Text style={styles.header}>Auto-Scrolling List</Text>
        <DragList
          style={styles.scrolledList}
          ref={listRef} // Verify that using the ref works
          data={scrollData}
          keyExtractor={keyExtractor}
          onReordered={onScrollReordered}
          ListHeaderComponent={header}
          ListFooterComponent={footer}
          renderItem={renderItem}
        />
        <Button
          onPress={() => listRef.current?.scrollToIndex({index: 0})}
          title="Scroll to Top"
        />
        <Text style={styles.header}>Horizontal List</Text>
        <DragList
          data={horzData}
          horizontal
          keyExtractor={keyExtractor}
          onReordered={onReorderedHorz}
          renderItem={renderHorzItem}
        />
        {/* The visual order mirrors under RTL, so print the logical order to
            tell a correct drop apart from one that landed at the wrong index. */}
        <Text style={styles.order}>{horzData.join(' ')}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  container: {
    marginTop: 16,
    padding: 20,
    flex: 1,
  },
  header: {
    fontSize: 20,
    marginTop: 16,
    marginBottom: 8,
  },
  item: {
    backgroundColor: 'gray',
    borderWidth: 1,
    borderColor: 'black',
    minHeight: 30,
  },
  text: {
    fontWeight: 'bold',
    fontSize: 20,
  },
  active: {
    backgroundColor: 'yellow',
  },
  scrolledList: {
    height: 300,
  },
  dirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  dirLabel: {
    fontSize: 16,
    fontWeight: 'bold',
  },
  horzItem: {
    paddingHorizontal: 12,
    justifyContent: 'center',
  },
  order: {
    marginTop: 8,
    fontSize: 12,
  },
});
