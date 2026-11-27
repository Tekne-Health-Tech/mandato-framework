import { FlatList, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { useRecords, useSyncState } from './store';
import { strings } from './strings.pt-BR';
import { tenant } from './tenant';

export function PlaceholderScreen({ title, projection }: { title: string; projection: string }) {
  const records = useRecords(projection);
  const sync = useSyncState();
  const colors = tenant.theme[useColorScheme() === 'dark' ? 'dark' : 'light'].colors;
  const syncMessage = sync.status === 'update-required'
    ? strings.updateRequired
    : sync.status === 'failed' ? strings.syncFailed : null;
  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Text allowFontScaling accessibilityRole="header" style={[styles.heading, { color: colors.fg }]}>{title}</Text>
      {syncMessage ? <Text allowFontScaling accessibilityRole="alert" style={{ color: colors.fg }}>{syncMessage}</Text> : null}
      <FlatList
        data={records}
        keyExtractor={({ id }) => id}
        ListEmptyComponent={<Text allowFontScaling style={{ color: colors.muted }}>{strings.empty}</Text>}
        renderItem={({ item }) => (
          <Text allowFontScaling style={[styles.item, { color: colors.fg, borderColor: colors.line }]}>
            {String(item.title ?? item.name ?? item.id)}
          </Text>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24 },
  heading: { fontSize: 24, fontWeight: '700', marginBottom: 16 },
  item: { borderBottomWidth: 1, fontSize: 16, paddingVertical: 12 },
});
