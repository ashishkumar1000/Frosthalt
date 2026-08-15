//
//  Use this file to import your target's public headers that you would like to expose to Swift.
//

// Exposes the RN promise block types (RCTPromiseResolveBlock /
// RCTPromiseRejectBlock) used by ShellRunner.swift's @objc writeHosts method.
// Without this import Swift cannot name those block types in an @objc signature
// and the TurboModule glue in NativeShellRunner.mm cannot forward the blocks.
#import <React/RCTBridgeModule.h>

