//
//  NativeShellRunner.mm
//  Frosthalt-macOS
//
//  Story 1.5 — Obj-C++ TurboModule glue for the ShellRunner adapter.
//
//  Conforms to the codegen-generated <NativeShellRunnerSpecSpec> protocol
//  (generated from src/native/specs/NativeShellRunnerSpec.ts via the app-level
//  `codegenConfig` in package.json: name `FrosthaltSpecs`). The privileged
//  /etc/hosts write logic lives in ShellRunner.swift (@objc(NativeShellRunner));
//  this file is the thin JSI bridge that delegates `writeHosts:resolve:reject:`
//  to the Swift class via the Xcode-generated `Frosthalt-Swift.h` header.
//
//  Template: NativeConfigStore.mm (Story 1.4). AD-2 (New Architecture only — no
//  legacy RCT bridge module). This is the SECOND TurboModule in the repo.
//
//  The class is named `NativeShellRunnerModule` (not `NativeShellRunner`) to
//  avoid an Obj-C runtime symbol collision with the Swift class that is
//  `@objc(NativeShellRunner)`. `RCT_EXPORT_MODULE(NativeShellRunner)` still
//  registers the JS-visible module name as `NativeShellRunner`, which is what
//  `TurboModuleRegistry.getEnforcing('NativeShellRunner')` resolves to.
//
//  MANUAL XCODE STEP (cannot be done from the node sandbox): add this file and
//  ShellRunner.swift to the Frosthalt-macOS target (PBXGroup + Sources build
//  phase). The bridging header already imports <React/RCTBridgeModule.h> so
//  Swift can name the promise block types. Then `cd macos && pod install &&
//  pnpm macos` builds + links everything.
//

#import <FrosthaltSpecs/FrosthaltSpecs.h>

// The Swift module header. PRODUCT_NAME is `Frosthalt` (see the xcconfig), so
// the generated header is `Frosthalt-Swift.h`. It exposes the
// @objc(NativeShellRunner) class declared in ShellRunner.swift.
#import "Frosthalt-Swift.h"

#include <memory> // std::make_shared / std::shared_ptr for getTurboModule:

@interface NativeShellRunnerModule : NativeShellRunnerSpecSpecBase <NativeShellRunnerSpecSpec>
@end

@implementation NativeShellRunnerModule

// Registers this class under the JS module name `NativeShellRunner`, matching
// `TurboModuleRegistry.getEnforcing<Spec>('NativeShellRunner')` on the JS side.
RCT_EXPORT_MODULE(NativeShellRunner)

// Returns the codegen-generated C++ JSI wrapper for this spec. The TurboModule
// manager calls this (via `respondsToSelector:@selector(getTurboModule:)`) when
// JS requires the module; the wrapper's constructor populates its `methodMap_`
// with the `writeHosts` host function (see FrosthaltSpecs-generated.mm), which
// is what binds that name to a callable JS function. WITHOUT this,
// `getEnforcing` finds the module object but its method is `undefined`
// ("writeHosts is not a function"). The codegen `*SpecBase` class does NOT
// supply this — every hand-written TurboModule impl must.
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeShellRunnerSpecSpecJSI>(params);
}

// Lazily-instantiated Swift business-logic adapter. We don't hold state across
// calls beyond this one instance; ShellRunner is stateless (each writeHosts
// writes a fresh data-only LINES_FILE and dispatches a fresh osascript).
- (NativeShellRunner *)swiftImpl
{
  static NativeShellRunner *impl;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    impl = [NativeShellRunner new];
  });
  return impl;
}

#pragma mark - NativeShellRunnerSpecSpec

// writeHosts -> async (codegen maps `Promise<WriteResult>` to a
// resolve/reject-block method). The Swift impl validates each line against the
// hosts-line regex (no elevation on failure), else dispatches the single
// privileged osascript off the main thread and resolves the promise with the
// { ok, error? } envelope on completion. The Swift side ALWAYS resolves, never
// rejects; we forward both blocks straight through so that contract holds
// end-to-end.
- (void)writeHosts:(NSArray *)lines
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  // Guard the input before it reaches Swift. A nil `lines` would bridge to a
  // Swift non-optional `[String]` as UB/crash, and a non-NSString element
  // (a JS number/boolean/null inside the array) would trap the `[String]`
  // bridge. Both are misuse, not normal outcomes — surface the spec-documented
  // `invalid-lines` envelope (no elevation) rather than crashing. Maps to the
  // same vocabulary the Swift regex gate uses, so the 1.6 layer has one case
  // for "bad input" (parallel to NativeConfigStore.mm's nil-json guard).
  if (!lines) {
    resolve(@{ @"ok": @NO, @"error": @"invalid-lines" });
    return;
  }
  for (id el in lines) {
    if (![el isKindOfClass:[NSString class]]) {
      resolve(@{ @"ok": @NO, @"error": @"invalid-lines" });
      return;
    }
  }
  [self.swiftImpl writeHosts:lines resolve:resolve reject:reject];
}

// readHostsSection -> NSDictionary (codegen maps the sync `ReadSectionResult`
// object return type to NSDictionary * — the same mapping ConfigStore.readConfig
// uses). The Swift impl returns a `[String: Any]` dict that bridges cleanly to
// NSDictionary: { ok:true, section:[lines] } | { ok:true, section:NSNull() } |
// { ok:false, error:"hosts-unreadable" | "markers-mismatch" }. This is an
// UNPRIVILEGED sync read (`/etc/hosts` is world-readable) — no osascript, no
// background queue (parallel to NativeConfigStore.mm:81 `readConfig`).
- (NSDictionary *)readHostsSection
{
  return [self.swiftImpl readHostsSection];
}

@end