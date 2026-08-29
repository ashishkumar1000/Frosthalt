#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <ReactCommon/RCTTurboModule.h>
#import <string.h> // strcmp

// Story 6.4 — exposes the @objc(WindowPersistence) class (WindowPersistence.swift)
// so the launch-time native restore can be wired here.
#import "Frosthalt-Swift.h"

// App-level TurboModules live in this target (e.g. NativeConfigStore.mm). Their
// Obj-C class interfaces are private to the .mm that implements them (no public
// header), so we resolve them at runtime by name via NSClassFromString instead
// of sending a class message to a @class forward declaration (Clang rejects the
// latter: "receiver for class message is a forward declaration"). The class is
// linked into this same binary, so the lookup always succeeds post-load.

@implementation AppDelegate

- (void)applicationDidFinishLaunching:(NSNotification *)notification
{
  self.moduleName = @"Frosthalt";
  // You can add your custom initial props in the dictionary below.
  // They will be passed down to the ViewController used by React Native.
  self.initialProps = @{};
  self.dependencyProvider = [RCTAppDependencyProvider new];

  // Story 6.4 — the launch-time NATIVE window restore (the spec's Always
  // constraint: "called from applicationDidFinishLaunching AFTER super").
  // `super` has already created + keyed the RN main window
  // (loadReactNativeWindow:) — the window is on screen, but has not painted,
  // so the setFrame inside `attachShared()` lands in the same launch tick
  // with no default-then-jump flash. JS never restores a frame (the Never
  // clause); the persisted frame read happens in WindowPersistence.swift via
  // the ConfigStoreFile read helper.
  [super applicationDidFinishLaunching:notification];

  [WindowPersistence attachShared];
}

// Story 6.5 — close-to-menu-bar: closing the last window (⌘W / the red
// close button) must NOT terminate the app. RN's default behavior terminates
// on last-window-close; returning NO keeps the process (and any live timer,
// plus the 6.1 status item — the surface the app "lives" on with the window
// closed) alive. The window itself is merely closed, never destroyed: No
// JS/React-tree teardown, state survives, and "Show window" re-fronts it.
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender
{
  return NO;
}

// Story 6.5 — the single arbitration point for EVERY quit source (⌘Q, Dock
// quit, the storyboard Quit item, and the JS `quit()` entry's dispatched
// `NSApp.terminate`). Forwarding to the shared MenuBar Swift instance keeps
// it on the same instance NativeMenuBar.mm wired the emitters + confirm flag
// on (a separate instance would break the flag-based re-entrancy outright —
// see the sharedInstance comment in MenuBar.swift). NOTE the Obj-C-visible
// class name is `NativeMenuBar` (@objc(NativeMenuBar); `MenuBar` is the Swift
// name, invisible to this file).
//
//   - quit already JS-confirmed -> MenuBar consumed the confirm flag, returns
//     terminate (flag reset — the gate re-arms for the next attempt);
//   - not confirmed -> MenuBar emits `onQuitRequested` to JS and cancels the
//     terminate; JS answers with `confirmQuit()` (no live session — quit
//     immediately, invisibly) or fronts the window + its own confirm Alert;
//     a later confirm re-enters NSApp.terminate with the flag set.
//   - fail-open: nil event closure (a quit before JS subscribes) -> MenuBar
//     returns terminate — a quitting app is never bricked by a missing
//     bridge.
//
// The Bool -> reply enum mapping is EXPLICIT and load-bearing:
// NSApplicationTerminateReply's numeric values are inverted against Bool
// (NSTerminateNow = 0, NSTerminateCancel = 1), so returning the raw BOOL
// would cancel every confirmed quit and terminate every cancelled one.
//
// RN's base delegate (RCTAppDelegate.mm) implements NEITHER this selector nor
// `applicationShouldTerminateAfterLastWindowClosed:` today; on an RN upgrade,
// re-check whether a base implementation appeared and decide explicitly
// whether to call super.
- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender
{
  return [[NativeMenuBar sharedInstance] handleShouldTerminate]
             ? NSTerminateNow
             : NSTerminateCancel;
}

// Story 6.5 review — closes the loop on close-to-menu-bar. Before this story
// a Dock click could never observe a closed-and-alive app (closing the window
// quit it); now the app survives, and the standard macOS reopen contract
// requires a Dock click to bring the window back — otherwise the only way
// back is the status menu. Same fronting helper the "Show window" item and
// the quit confirm use, so reopen behaves identically to them (including the
// deminiaturize/autosave-scan fallbacks).
- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender
                    hasVisibleWindows:(BOOL)visibleFlag
{
  [WindowPersistence bringMainWindowToFront];
  return YES;
}

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

/// This method controls whether the `concurrentRoot`feature of React18 is turned on or off.
///
/// @see: https://reactjs.org/blog/2022/03/29/react-v18.html
/// @note: This requires to be rendering on Fabric (i.e. on the New Architecture).
/// @return: `true` if the `concurrentRoot` feature is enabled. Otherwise, it returns `false`.
- (BOOL)concurrentRootEnabled
{
#ifdef RN_FABRIC_ENABLED
  return true;
#else
  return false;
#endif
}

/// Registers app-level TurboModules with the RCTTurboModuleManager.
///
/// On react-native-macos 0.81 (and RN 0.81 generally), TurboModules declared in
/// the app's own `package.json codegenConfig` get their codegen spec headers
/// generated (so the .mm impl compiles), but they are NOT aggregated into the
/// autolinked `RCTModuleProviders` map — autolinking only lists real
/// dependencies, not the app's own modules. The TurboModuleManager has no
/// `RCT_EXPORT_MODULE` bridge fallback either: it resolves a name only via
/// `getModuleProvider:` (the generated map, empty for app modules) and
/// `getModuleClassFromName:` (RCTCoreModulesClassProvider, core modules only).
///
/// So an app TurboModule that isn't registered here is invisible to
/// `TurboModuleRegistry.getEnforcing(<name>)`, which throws
/// "could not be found ... registered in the native binary" at JS import time.
///
/// Returning the Obj-C module class instance here is the registration hook:
/// RCTTurboModuleManager uses `[provider class]` as the module class, then
/// instantiates + JSI-wraps it (the same path core Obj-C TurboModules take).
/// This is the template for future app TurboModules (ShellRunner 1.5, MenuBar
/// Epic 6): add a branch per module name.
- (id<RCTModuleProvider>)getModuleProvider:(const char *)name
{
  if (strcmp(name, "NativeConfigStore") == 0) {
    Class cls = NSClassFromString(@"NativeConfigStoreModule");
    return cls ? (id<RCTModuleProvider>)[cls new] : nil;
  } else if (strcmp(name, "NativeShellRunner") == 0) {
    // Story 1.5 — the privileged ShellRunner TurboModule. Without this branch
    // `TurboModuleRegistry.getEnforcing('NativeShellRunner')` throws at JS
    // import time (verified on 1.4). Same pattern as NativeConfigStore above.
    Class cls = NSClassFromString(@"NativeShellRunnerModule");
    return cls ? (id<RCTModuleProvider>)[cls new] : nil;
  } else if (strcmp(name, "NativeMenuBar") == 0) {
    // Story 6.1 — the MenuBar TurboModule (NSStatusItem + NSMenu). Without
    // this branch `TurboModuleRegistry.getEnforcing('NativeMenuBar')` throws
    // at JS import time. Same pattern as NativeConfigStore/NativeShellRunner
    // above.
    Class cls = NSClassFromString(@"NativeMenuBarModule");
    return cls ? (id<RCTModuleProvider>)[cls new] : nil;
  } else if (strcmp(name, "NativeWindow") == 0) {
    // Story 6.4 — the Window TurboModule (frame persistence/zoom/capture).
    // Without this branch `TurboModuleRegistry.getEnforcing('NativeWindow')`
    // throws at JS import time. Same pattern as the three branches above.
    Class cls = NSClassFromString(@"NativeWindowModule");
    return cls ? (id<RCTModuleProvider>)[cls new] : nil;
  }
  return nil;
}

@end
