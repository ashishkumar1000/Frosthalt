//
//  NativeConfigStore.mm
//  Frosthalt-macOS
//
//  Story 1.4 — Obj-C++ TurboModule glue for the ConfigStore adapter.
//
//  Conforms to the codegen-generated <NativeConfigStoreSpecSpec> protocol
//  (generated from src/native/specs/NativeConfigStoreSpec.ts via the app-level
//  `codegenConfig` in package.json: name `FrosthaltSpecs`). The real file I/O
//  logic lives in ConfigStore.swift (@objc(NativeConfigStore)); this file is
//  the thin JSI bridge that delegates each method to the Swift class via the
//  Xcode-generated `Frosthalt-Swift.h` header.
//
//  This is the FIRST TurboModule in the repo and the template for ShellRunner
//  (1.5) and MenuBar (Epic 6): codegen TS spec -> this Obj-C++ glue -> Swift
//  business logic. AD-2 (New Architecture only — no legacy RCT bridge module).
//
//  The class is named `NativeConfigStoreModule` (not `NativeConfigStore`) to
//  avoid an Obj-C runtime symbol collision with the Swift class that is
//  `@objc(NativeConfigStore)`. `RCT_EXPORT_MODULE(NativeConfigStore)` still
//  registers the JS-visible module name as `NativeConfigStore`, which is what
//  `TurboModuleRegistry.getEnforcing('NativeConfigStore')` resolves to.
//
//  MANUAL XCODE STEP (cannot be done from the node sandbox): add this file and
//  ConfigStore.swift to the Frosthalt-macOS target. Adding the first .swift
//  file makes Xcode auto-create Frosthalt-macOS-Bridging-Header.h. Then
//  `cd macos && pod install && pnpm macos` builds + links everything.
//

#import <FrosthaltSpecs/FrosthaltSpecs.h>

// The Swift module header. PRODUCT_NAME is `Frosthalt` (see the xcconfig),
// so the generated header is `Frosthalt-Swift.h`. It exposes the
// @objc(NativeConfigStore) class declared in ConfigStore.swift.
#import "Frosthalt-Swift.h"

@interface NativeConfigStoreModule : NativeConfigStoreSpecSpecBase <NativeConfigStoreSpecSpec>
@end

@implementation NativeConfigStoreModule

// Registers this class under the JS module name `NativeConfigStore`, matching
// `TurboModuleRegistry.getEnforcing<Spec>('NativeConfigStore')` on the JS side.
RCT_EXPORT_MODULE(NativeConfigStore)

// Lazily-instantiated Swift business-logic adapter. We don't hold state across
// calls beyond this one instance; ConfigStore is stateless file I/O.
- (NativeConfigStore *)swiftImpl
{
  static NativeConfigStore *impl;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    impl = [NativeConfigStore new];
  });
  return impl;
}

#pragma mark - NativeConfigStoreSpecSpec

// readConfig -> NSDictionary (codegen maps the `ConfigResult` object return
// type to NSDictionary *). The Swift impl returns a `[String: Any]` dict that
// bridges cleanly to NSDictionary. See ConfigStore.swift for the resilience
// rules (missing file -> { ok: true, data: NSNull() }; IO error ->
// { ok: false, error: ... }).
- (NSDictionary *)readConfig
{
  return [self.swiftImpl readConfig];
}

// writeConfig: takes the raw JSON string (the TS port has already
// JSON.stringify'd it) and writes it atomically. Returns { ok: true } or
// { ok: false, error: ... }.
- (NSDictionary *)writeConfig:(NSString *)json
{
  // A nil `json` would bridge to a Swift non-optional `String` as UB/crash;
  // guard it and surface a ConfigResult-shaped error instead.
  if (!json) {
    return @{ @"ok": @NO, @"error": @"nil-json" };
  }
  return [self.swiftImpl writeConfig:json];
}

@end
