//
//  NativeMenuBar.mm
//  Frosthalt-macOS
//
//  Story 6.1 — Obj-C++ TurboModule glue for the MenuBar adapter.
//
//  Conforms to the codegen-generated <NativeMenuBarSpecSpec> protocol
//  (generated from src/native/specs/NativeMenuBarSpec.ts via the app-level
//  `codegenConfig` in package.json: name `FrosthaltSpecs`). The real
//  NSStatusItem/NSMenu logic lives in MenuBar.swift (@objc(NativeMenuBar));
//  this file is the thin JSI bridge that delegates `initialize()` to the
//  Swift class via the Xcode-generated `Frosthalt-Swift.h` header, and wires
//  each Swift click closure to the matching codegen `emitOn...` method.
//
//  Template: NativeConfigStore.mm (Story 1.4) / NativeShellRunner.mm
//  (Story 1.5). AD-2 (New Architecture only — no legacy RCT bridge module).
//  This is the THIRD TurboModule in the repo and the FIRST that emits events
//  to JS (`emitOnQuickStart` / `emitOnShowWindow` / `emitOnQuit` are provided
//  by the codegen-generated `NativeMenuBarSpecSpecBase` this class inherits
//  from — see FrosthaltSpecs-generated.mm).
//
//  The class is named `NativeMenuBarModule` (not `NativeMenuBar`) to avoid an
//  Obj-C runtime symbol collision with the Swift class that is
//  `@objc(NativeMenuBar)`. `RCT_EXPORT_MODULE(NativeMenuBar)` still registers
//  the JS-visible module name as `NativeMenuBar`, which is what
//  `TurboModuleRegistry.getEnforcing('NativeMenuBar')` resolves to.
//
//  This file and MenuBar.swift are registered in the Frosthalt-macOS target's
//  PBXGroup + Sources build phase directly in project.pbxproj (mirroring the
//  ShellRunner/ConfigStore entries) — no Xcode GUI step is needed to pick
//  them up. `cd macos && pod install && pnpm macos` still builds + links
//  everything.
//

#import <FrosthaltSpecs/FrosthaltSpecs.h>

// The Swift module header. PRODUCT_NAME is `Frosthalt` (see the xcconfig),
// so the generated header is `Frosthalt-Swift.h`. It exposes the
// @objc(NativeMenuBar) class declared in MenuBar.swift.
#import "Frosthalt-Swift.h"

#include <memory> // std::make_shared / std::shared_ptr for getTurboModule:

@interface NativeMenuBarModule : NativeMenuBarSpecSpecBase <NativeMenuBarSpecSpec>
@end

@implementation NativeMenuBarModule

// Registers this class under the JS module name `NativeMenuBar`, matching
// `TurboModuleRegistry.getEnforcing<Spec>('NativeMenuBar')` on the JS side.
RCT_EXPORT_MODULE(NativeMenuBar)

// Returns the codegen-generated C++ JSI wrapper for this spec. The TurboModule
// manager calls this (via `respondsToSelector:@selector(getTurboModule:)`) when
// JS requires the module; the wrapper's constructor populates its `methodMap_`
// with the `initialize` host function (see FrosthaltSpecs-generated.mm), which
// is what binds that name to a callable JS function, and wires up the
// eventEmitterMap_ that backs `emitOnQuickStart`/`emitOnShowWindow`/
// `emitOnQuit`. WITHOUT this, `getEnforcing` finds the module object but its
// method is `undefined` ("initialize is not a function"). The codegen
// `*SpecBase` class does NOT supply this — every hand-written TurboModule
// impl must.
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeMenuBarSpecSpecJSI>(params);
}

// Lazily-instantiated Swift business-logic adapter, created exactly once for
// the process lifetime (dispatch_once). Right after creation, wire each Swift
// click closure to the matching codegen `emitOn...` method on THIS module
// instance (`self` here is captured weakly — the closures live on the Swift
// singleton for the app's lifetime, so a weak self avoids a retain cycle and
// is safe: a deallocated module simply drops the click on the floor, which
// cannot happen in practice since this module is never torn down while the
// app runs).
- (NativeMenuBar *)swiftImpl
{
  static NativeMenuBar *impl;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    impl = [NativeMenuBar new];

    __weak NativeMenuBarModule *weakSelf = self;
    impl.onQuickStart = ^{
      [weakSelf emitOnQuickStart];
    };
    impl.onShowWindow = ^{
      [weakSelf emitOnShowWindow];
    };
    impl.onQuit = ^{
      [weakSelf emitOnQuit];
    };
  });
  return impl;
}

#pragma mark - NativeMenuBarSpecSpec

// initialize -> NSDictionary (codegen maps the `MenuBarResult` object return
// type to NSDictionary *, same mapping ConfigStore.readConfig uses). The
// Swift impl builds the NSStatusItem/NSMenu skeleton on the main thread,
// idempotently, and always returns { ok: true }.
- (NSDictionary *)initialize
{
  return [self.swiftImpl initialize];
}

// setBadgeState: (Story 6.2) — the live badge mirror.
//
// SIGNATURE (crash lesson, 6.2 verification): the param is the CODEGEN'D C++
// struct `JS::NativeMenuBarSpec::MenuBarBadgeState &` — exactly what the
// generated <NativeMenuBarSpecSpec> protocol declares — NOT an `NSDictionary *`.
// Because `MenuBarBadgeState` is a NAMED object type (not a primitive/array
// like ConfigStore's `writeConfig:(NSString *)` or ShellRunner's
// `writeHosts:(NSArray *)`), codegen installs a per-arg converter
// (`setMethodArgConversionSelector(... JS_NativeMenuBarSpec_MenuBarBadgeState:)`)
// and the TurboModule runtime then packs the struct POINTER into the
// NSInvocation argument slot. Declaring `(NSDictionary *)` here compiles
// (ObjC never enforces signatures at runtime) but makes ARC treat that C++
// struct pointer as a strong ObjC object — objc_storeStrong dereferences a
// non-object address and the app segfaults on the first push. The runtime
// derives the method signature from OUR compiled method, so this file must
// mirror the generated protocol signature verbatim.
//
// The struct's accessors (`state()` / `buttonTitle()` / `rowTitle()`) are
// `RCTBridgingToString` reads over the JS-side dictionary — nil-tolerant, no
// throwing validation — and are coalesced to `@""` so a dictionary literal
// can never get a nil insert; Swift's `as? String` reads map empty back to
// the same fail-safe defaults (unknown state -> red).
- (NSDictionary *)setBadgeState:(JS::NativeMenuBarSpec::MenuBarBadgeState &)badge
{
  return [self.swiftImpl setBadgeState:@{
    @"state": badge.state() ?: @"",
    @"buttonTitle": badge.buttonTitle() ?: @"",
    @"rowTitle": badge.rowTitle() ?: @"",
  }];
}

@end
