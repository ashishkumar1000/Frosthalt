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
//  to JS (`emitOnQuickStart` / `emitOnShowWindow` / `emitOnQuit` /
//  `emitOnQuitRequested` are provided by the codegen-generated
//  `NativeMenuBarSpecSpecBase` this class inherits from — see
//  FrosthaltSpecs-generated.mm). Since 6.5 the emitters are re-wired on every
//  module creation (the NativeWindow.mm reload-survival pattern).
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

// The shared Swift business-logic adapter. NOT `[NativeMenuBar new]` — since
// Story 6.5 AppDelegate.mm's `applicationShouldTerminate:` consults the SAME
// instance (its terminate-confirm flag + `onQuitRequested` closure), so a
// `new` here would hand the gate a different object than the module. The
// class owns the shared resolution (`sharedInstance()`, the WindowPersistence
// resolveShared pattern).
//
// The emitter closures are RE-WIRED on EVERY `swiftImpl` access (Story 6.5,
// the NativeWindow.mm reload-survival pattern — NOT dispatch_once): a bridge
// reload creates a NEW NativeMenuBarModule whose emitters must point at the
// NEW module instance; a closure wired once would keep targeting the dead
// first module and every emitted event (including `onQuitRequested`) would
// vanish after a reload. Re-wiring is idempotent (last writer wins, and the
// newest instance is by definition the live one). The closures capture
// `self` weakly — a fired event with a deallocated module is dropped on the
// floor, which cannot happen while the app runs.
//
// The re-wire alone is NOT enough for reload survival, though: it only heals
// once JS next touches the module. In the gap between a reload and that first
// access, the shared impl still holds the OLD closure targeting the dead
// module — and for the Quit gate a stale-but-non-nil closure is worse than
// none: `handleShouldTerminate()` would emit into the void and CANCEL every
// quit, the exact opposite of the documented fail-open. `-invalidate` below
// detaches the closures the moment the old module dies, so the gate sees nil
// and FAILS OPEN (terminate) — the same safe failure as the
// quit-before-JS-subscribes case — until JS re-subscribes.
//
// Writes go through the Swift-side `attachEmitterClosures` (one lock scope
// covering all four): the re-wire runs on the JSI calling thread while
// `handleShouldTerminate` reads `onQuitRequested` on the main thread —
// unsynchronized block-pointer writes/read would be a data race.
- (NativeMenuBar *)swiftImpl
{
  NativeMenuBar *impl = [NativeMenuBar sharedInstance];

  __weak NativeMenuBarModule *weakSelf = self;
  [impl attachEmitterClosuresWithOnQuickStart:^{
    [weakSelf emitOnQuickStart];
  }
      onShowWindow:^{
        [weakSelf emitOnShowWindow];
      }
      onQuit:^{
        [weakSelf emitOnQuit];
      }
      onQuitRequested:^{
        [weakSelf emitOnQuitRequested];
      }];
  return impl;
}

// Story 6.5 review — the reload-survival half of the re-wire (see the
// `swiftImpl` comment above): as the MODULE dies (bridge reload, teardown),
// nil the shared impl's emitter closures immediately. Detached, the Quit gate
// fails OPEN (nil closure -> terminate) instead of cancelling every quit
// behind a stale closure that can no longer deliver. No `[super invalidate]`:
// the codegen `*SpecBase` declares no Obj-C `-invalidate` (its lifecycle
// hook is the C++ `getTurboModule` path), and a bare override matches that
// reality — re-check on an RN upgrade.
- (void)invalidate
{
  [[NativeMenuBar sharedInstance] detachEmitterClosures];
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

// quit (Story 6.3) — the JS `onQuit` handler's quit ENTRY. Plain dictionary
// return over a NO-ARG method: the 6.2 named-object-struct crash lesson
// (`JS::NativeMenuBarSpec::<Type> &` params) cannot apply here — there is no
// parameter to convert, so this is the same shape as `initialize`. Since 6.5
// the dispatched termination rides through
// `applicationShouldTerminate:`/`handleShouldTerminate()` like every other
// quit source; this method just forwards and returns { ok: true }.
- (NSDictionary *)quit
{
  return [self.swiftImpl quit];
}

// confirmQuit (Story 6.5) — the JS "go" leg of the quit confirm: sets the
// terminate-confirm flag and dispatches `NSApp.terminate(nil)` on the main
// queue, whose `applicationShouldTerminate:` consumes the flag and proceeds.
// Plain-dict return, no args — same shape as `quit`, no struct-lesson param.
- (NSDictionary *)confirmQuit
{
  return [self.swiftImpl confirmQuit];
}

// presentQuitConfirm (Story 6.5) — fronts the main window so the JS confirm
// sheet is visible when the window was closed to the menu bar. Called ONLY
// when a dialog is about to show. Plain-dict return, no args — same shape as
// `quit`; the fronting is main-queue dispatched inside the Swift impl.
- (NSDictionary *)presentQuitConfirm
{
  return [self.swiftImpl presentQuitConfirm];
}

@end
