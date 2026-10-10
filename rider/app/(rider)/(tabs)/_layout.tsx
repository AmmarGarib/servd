// Two tabs — Jobs and Profile. Text labels on a tall bar (no emoji icons):
// a gloved thumb has to hit them on a moving bike.

import { Tabs } from 'expo-router'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { colors } from '../../../src/lib/theme'

function TabMark({ focused }: { focused: boolean }) {
  // A simple bar above the active label — a shape, not an icon font.
  return (
    <View style={{
      width: 32, height: 4, borderRadius: 2, marginTop: 6,
      backgroundColor: focused ? colors.green : colors.transparent,
    }} />
  )
}

export default function TabsLayout() {
  const insets = useSafeAreaInsets()
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.onPurple,
        tabBarInactiveTintColor: colors.onPurpleDim,
        tabBarStyle: {
          backgroundColor: colors.purple,
          borderTopColor: colors.purpleDeep,
          height: 68 + insets.bottom,
          paddingTop: 4,
          paddingBottom: 10 + insets.bottom,
        },
        tabBarLabelStyle: { fontSize: 16, fontWeight: '800', letterSpacing: 0.4 },
        tabBarIcon: ({ focused }) => <TabMark focused={focused} />,
        sceneStyle: { backgroundColor: colors.bone },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Jobs', tabBarAccessibilityLabel: 'Jobs' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile', tabBarAccessibilityLabel: 'Profile' }} />
    </Tabs>
  )
}
