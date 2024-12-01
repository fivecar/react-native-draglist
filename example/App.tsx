import React, {useState} from 'react';
import {
  Button,
  FlatList,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import DragList, {DragListRenderItemInfo} from 'react-native-draglist';

const SOUND_OF_SILENCE = ['hello', 'darkness', 'my', 'old', 'friend'];

export default function DraggableLyrics() {
  const [data, setData] = useState(SOUND_OF_SILENCE);
  const [scrollData, setScrollData] = useState(
    Array(8, 6, 7, 5, 3, 0, 9)
      .map(num => SOUND_OF_SILENCE.map(word => `${word}${num}`))
      .flat(),
  );
  const [horzData, setHorzData] = useState(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  const listRef = React.useRef<FlatList<string> | null>(null);

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
    <View style={styles.container}>
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
        ListHeaderComponent={() => (
          <View>
            <Text>Drag my header</Text>
          </View>
        )}
        ListFooterComponent={() => (
          <View>
            <Text>Drag my footer</Text>
          </View>
        )}
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
        renderItem={renderItem}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 16,
    padding: 40,
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
});
