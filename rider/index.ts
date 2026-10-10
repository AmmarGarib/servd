// Entry point. The background location task has to be defined at module
// scope before anything renders — including when Android starts the app
// headless to deliver a location update after the rider swiped it away — so
// it is imported here, ahead of expo-router's own entry.

import './src/lib/location'
import 'expo-router/entry'
