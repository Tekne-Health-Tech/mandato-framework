import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { useColorScheme } from 'react-native';

import { tenant } from '../../src/tenant';

const tabs = {
  index: { label: 'Início', icon: 'home-outline' },
  mandato: { label: 'Mandato', icon: 'business-outline' },
  causas: { label: 'Causas', icon: 'heart-outline' },
  agenda: { label: 'Agenda', icon: 'calendar-outline' },
  participe: { label: 'Participe', icon: 'people-outline' },
} as const;

export default function TabLayout() {
  const colors = tenant.theme[useColorScheme() === 'dark' ? 'dark' : 'light'].colors;
  return (
    <Tabs screenOptions={{ headerTitle: tenant.name, tabBarActiveTintColor: colors.link, tabBarStyle: { backgroundColor: colors.surface } }}>
      {Object.entries(tabs).map(([name, tab]) => (
        <Tabs.Screen
          key={name}
          name={name}
          options={{
            title: tab.label,
            tabBarAccessibilityLabel: tab.label,
            tabBarIcon: ({ color, size }) => <Ionicons accessibilityLabel={tab.label} name={tab.icon} color={typeof color === 'number' ? colors.link : color ?? colors.link} size={size} />,
          }}
        />
      ))}
    </Tabs>
  );
}
