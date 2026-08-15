#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <ReactCommon/RCTTurboModule.h>
#import <string.h> // strcmp

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
  
  return [super applicationDidFinishLaunching:notification];
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
  }
  return nil;
}

@end
