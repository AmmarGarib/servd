import { Tabs } from 'expo-router'

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: { backgroundColor: '#0C0D10', borderTopColor: '#1a1d24' },
        tabBarActiveTintColor: '#00D4B1',
        tabBarInactiveTintColor: '#666',
        headerStyle: { backgroundColor: '#0C0D10' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: '900' },
      }}>
      <Tabs.Screen name="index"   options={{ title: 'Browse',  tabBarLabel: 'Browse'  }} />
      <Tabs.Screen name="orders"  options={{ title: 'Orders',  tabBarLabel: 'Orders'  }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarLabel: 'Account' }} />
    </Tabs>
  )
}
