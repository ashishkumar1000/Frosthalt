//
//  NativeWindow.mm
//  Frosthalt-macOS
//
//  Story 6.4 — Obj-C++ TurboModule glue for the Window adapter.
//
//  Conforms to the codegen-generated <NativeWindowSpecSpec> protocol
//  (generated from src/native/specs/NativeWindowSpec.ts via the app-level
//  `codegenConfig` in package.json: name `FrosthaltSpecs`). The real frame
//  logic lives in WindowPersistence.swift (@objc(WindowPersistence)); this
//  file is the thin JSI bridge that delegates `configureWindow` to the shared
//  Swift singleton (`[WindowPersistence sharedInstance]` — the SAME instance
//  `attachShared()` configured at launch) and wires the Swift
//  `onFrameChanged` closure to the codegen `emitOnWindowFrameChanged`.
//
//  Template: NativeMenuBar.mm (Story 6.1/6.2). AD-2 (New Architecture only).
//  This is the FOURTH TurboModule in the repo; it emits ONE object-payload
//  event (`emitOnWindowFrameChanged`, provided by the codegen-generated
//  `NativeWindowSpecSpecBase` this class inherits from).
//
//  The class is named `NativeWindowModule` (not `NativeWindow`) to avoid an
//  Obj-C runtime symbol collision with the Swift class that is
//  `@objc(WindowPersistence)`; `RCT_EXPORT_MODULE(NativeWindow)` registers the
//  JS-visible module name `NativeWindow`, which
//  `TurboModuleRegistry.getEnforcing('NativeWindow')` resolves to.
//
//  This file and WindowPersistence.swift are registered in the
//  Frosthalt-macOS target's PBXGroup + Sources build phase directly in
//  project.pbxproj (the MenuBar.swift precedent) — no Xcode GUI step needed.
//

#import <FrosthaltSpecs/FrosthaltSpecs.h>

// The Swift module header. PRODUCT_NAME is `Frosthalt` (see the xcconfig),
// so the generated header is `Frosthalt-Swift.h`. It exposes the
// @objc(WindowPersistence) class declared in WindowPersistence.swift.
#import "Frosthalt-Swift.h"

#include <memory> // std::make_shared / std::shared_ptr for getTurboModule:

@interface NativeWindowModule : NativeWindowSpecSpecBase <NativeWindowSpecSpec>
@end

@implementation NativeWindowModule

// Registers this class under the JS module name `NativeWindow`, matching
// `TurboModuleRegistry.getEnforcing<Spec>('NativeWindow')` on the JS side.
RCT_EXPORT_MODULE(NativeWindow)

// The codegen-generated C++ JSI wrapper for this spec (the getTurboModule:
// contract every hand-written TurboModule impl must supply — see the long
// comment in NativeMenuBar.mm). The wrapper's constructor wires the
// `configureWindow` host function and the eventEmitterMap_ entry that backs
// `emitOnWindowFrameChanged:`.
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeWindowSpecSpecJSI>(params);
}

// The shared Swift business-logic adapter. NOT `[WindowPersistence new]` —
// Story 6.4's restore runs at LAUNCH (`[WindowPersistence attachShared]` in
// AppDelegate's applicationDidFinishLaunching), so `sharedInstance()` hands
// back the SAME already-attached instance: the launch-time window/delegate/
// observer state and this module's event closure are one object.
//
// The emitter closure is RE-WIRED on EVERY module creation (6.4 review, NOT
// dispatch_once like NativeMenuBar): a bridge reload (Num Pad / Hot Reload)
// creates a NEW NativeWindowModule whose emitter `emitOnWindowFrameChanged:`
// must point at the NEW module instance — a closure wired once into the
// Swift singleton would keep targeting the dead first module, and every
// emitted frame would vanish after a reload. Re-wiring is idempotent (last
// writer wins, and the newest instance is by definition the live one). The
// closure is captured weakly — an emitted frame with a deallocated module is
// dropped on the floor, which cannot happen while the app runs.
- (WindowPersistence *)swiftImpl
{
  WindowPersistence *impl = [WindowPersistence sharedInstance];

  __weak NativeWindowModule *weakSelf = self;
  impl.onFrameChanged = ^(NSDictionary *payload) {
    [weakSelf emitOnWindowFrameChanged:payload];
  };
  return impl;
}

#pragma mark - NativeWindowSpecSpec

// configureWindow: — hands native the JS-single-sourced size constants
// (src/domain/windowFrame.ts WINDOW_RULES).
//
// SIGNATURE (crash lesson, 6.2 verification): the param is the CODEGEN'D C++
// struct `JS::NativeWindowSpec::WindowRules &` — exactly what the generated
// <NativeWindowSpecSpec> protocol declares — NOT an `NSDictionary *` (ARC
// would treat the struct pointer as a strong ObjC object and segfault on the
// first call). Number fields come out as raw `double` accessors (`size_t`
// spec numbers), so each is boxed into the plain dictionary the Swift impl
// reads defensively.
- (NSDictionary *)configureWindow:(JS::NativeWindowSpec::WindowRules &)rules
{
  return [self.swiftImpl configureWindow:@{
    @"standardWidth": @(rules.standardWidth()),
    @"standardHeight": @(rules.standardHeight()),
    @"minWidth": @(rules.minWidth()),
    @"minHeight": @(rules.minHeight()),
    @"maxWidth": @(rules.maxWidth()),
    @"maxHeight": @(rules.maxHeight()),
  }];
}

// (No frame-application method exists here — restore is native + launch-time
// inside WindowPersistence.attach(); JS never applies a frame. The spec's
// Never clause.)

@end