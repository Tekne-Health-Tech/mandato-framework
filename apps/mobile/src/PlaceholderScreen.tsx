import { FlatList, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { useRecords } from './store';
import { tenant } from './tenant';

export function PlaceholderScreen({ title, projection }: { title: string; projection: string }) {
  const records = useRecords(projection);
  const colors = tenant.theme[useColorScheme() === 'dark' ? 'dark' : 'light'].colors;
  return (
    <View style={[styles.container, { backgroundColor: colors.bg }]}>
      <Text allowFontScaling accessibilityRole="header" style={[styles.heading, { color: colors.fg }]}>{title}</Text>
      <FlatList
        data={records}
        keyExtractor={({ id }) => id}
        ListEmptyComponent={<Text allowFontScaling style={{ color: colors.muted }}>Conteúdo disponível após a primeira sincronização.</Text>}
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
