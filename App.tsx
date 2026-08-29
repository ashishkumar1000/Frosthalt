/**
 * Frosthalt app root (Story 1.3).
 *
 * Keeps the Story 1.1 wrapper — `SafeAreaProvider` + `StatusBar` +
 * `useColorScheme` — and replaces the `@react-native/new-app-screen` scaffold
 * body with the window `<Shell/>` (sidebar + persistent status header + active
 * surface placeholder). The shell owns the active-surface UI-chrome state and
 * the keyboard/focus/VoiceOver wiring; see `src/components/Shell.tsx`.
 *
 * Story 6.1 adds a mount-only effect that calls `initializeMenuBar()` exactly
 * once, standing up the native NSStatusItem + NSMenu skeleton at app startup.
 */

import { useEffect } from 'react';
import { StatusBar, useColorScheme } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Shell } from './src/components/Shell';
import { initializeMenuBar } from './src/native/menuBar';

function App() {
  const isDarkMode = useColorScheme() === 'dark';

  useEffect(() => {
    initializeMenuBar();
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <Shell />
    </SafeAreaProvider>
  );
}

export default App;
