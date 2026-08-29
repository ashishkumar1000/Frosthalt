//
//  ConfigStore.swift
//  Frosthalt-macOS
//
//  Story 1.4 — ConfigStore TurboModule (unprivileged adapter).
//
//  The real business logic for reading/writing
//  ~/Library/Application Support/Frosthalt/config.json.
//
//  This is a DUMB STRING-FILE ADAPTER (architecture AD-11): it knows nothing
//  about the config shape and does NOT parse or validate JSON. readConfig
//  returns the raw file string (data nil when the file is missing); writeConfig
//  writes the string it is given, atomically. JSON parse/serialize + the
//  missing/corrupt -> empty resilience rule live in the typed JS port
//  (src/config/configStore.ts).
//
//  Every method returns the uniform { ok, error?, data? } envelope (AC 4).
//
//  Glued into the Obj-C++ TurboModule (NativeConfigStore.mm) via the
//  Xcode-generated "<product>-Swift.h" header. This is the first Swift file in
//  the macOS target, so Xcode auto-creates Frosthalt-macOS-Bridging-Header.h
//  when the file is added to the target — that is a manual Xcode step.
//

import Foundation

/// Story 6.4 — target-internal helpers shared by `ConfigStore` and
/// `WindowPersistence`: the single config.json path resolution + a raw-text
/// read, extracted verbatim from `ConfigStore`'s private implementation so the
/// launch-time restore can read the SAME file WITHOUT widening `ConfigStore`'s
/// public `{ ok, error?, data? }` contract (which stays untouched — the
/// spec's Never clause). Internal visibility (Swift `enum` at target scope):
/// visible to every file in the Frosthalt-macOS target, invisible to any
/// external module.
enum ConfigStoreFile {

  /// ~/Library/Application Support/Frosthalt/config.json
  /// Resolved via NSSearchPathForApplicationSupportDirectory (AD-1 / config
  /// path contract). Returns nil only on a catastrophically broken user
  /// environment (no app-support dir), which is surfaced as an { ok:false }.
  static func configURL() -> URL? {
    guard let supportDir = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first else {
      return nil
    }
    let appDir = supportDir.appendingPathComponent("Frosthalt", isDirectory: true)
    return appDir.appendingPathComponent("config.json", isDirectory: false)
  }

  /// Reads config.json as a raw string. Returns nil when the file is MISSING
  /// (not an error for the restore path — "no frame on record"), or when an
  /// unrecoverable IO error occurs (indistinguishable to the caller — restore
  /// treats both the same way: skip, keep whatever framing the window has).
  /// Never parses JSON. The single READ PATH: both `readConfig` (which must
  /// distinguish missing from failed for its envelope) and the restore path
  /// funnel through `readRawConfig()` below, so there is exactly ONE place
  /// where config.json is opened.
  static func readRawConfigText() -> String? {
    switch readRawConfig() {
    case .text(let raw):
      return raw
    case .missing, .failed:
      return nil
    }
  }

  /// The single config.json READ: the raw-text outcome, distinguishing the
  /// three cases (`ConfigStore.readConfig` needs missing-vs-failed for its
  /// `{ ok: true, data: nil }` envelope; the restore path collapses both).
  /// Errors duplicate `readConfig`'s exact error strings from before the
  /// extraction so the envelopes stay byte-identical.
  static func readRawConfig() -> RawConfigRead {
    guard let url = configURL() else {
      return .failed("application-support-dir-unavailable")
    }
    guard FileManager.default.fileExists(atPath: url.path) else {
      return .missing
    }
    do {
      return .text(try String(contentsOf: url, encoding: .utf8))
    } catch {
      return .failed("read-failed: \(error.localizedDescription)")
    }
  }
}

/// The outcome of one config.json read, shared by `readConfig` (needs
/// missing-vs-failed for its public envelopes) and the restore path (treats
/// both as "skip").
enum RawConfigRead {
  case missing
  case text(String)
  case failed(String)
}

@objc(NativeConfigStore)
final class ConfigStore: NSObject {

  // MARK: - Read

  /// Reads config.json and returns its raw string contents.
  ///
  /// Missing file is NOT an error: returns `{ ok: true, data: nil }`.
  /// An unrecoverable IO error returns `{ ok: false, error: "<reason>" }`.
  /// Never parses JSON.
  @objc
  func readConfig() -> [String: Any] {
    // THE single read path (`ConfigStoreFile.readRawConfig`): same envelopes
    // and error strings as before the extraction — observable behaviour
    // (envelopes, missing -> nil data, raw UTF-8 string) is IDENTICAL. The
    // public dumb-string contract is untouched.
    switch ConfigStoreFile.readRawConfig() {
    case .failed(let error):
      return ["ok": false, "error": error]
    case .missing:
      // Missing file -> empty config. The TS port maps this to DEFAULT_CONFIG.
      return ["ok": true, "data": NSNull()]
    case .text(let raw):
      return ["ok": true, "data": raw as NSString]
    }
  }

  // MARK: - Write

  /// Atomically writes `json` to config.json (temp file + rename), creating
  /// the ~/Library/Application Support/Frosthalt directory if it is absent.
  ///
  /// On an IO error the target file is left unchanged (the temp file is
  /// discarded and no rename happens). Returns `{ ok: true }` on success or
  /// `{ ok: false, error: "<reason>" }` on failure. Never parses/validates the
  /// string.
  @objc
  func writeConfig(_ json: String) -> [String: Any] {
    guard let url = ConfigStoreFile.configURL() else {
      return ["ok": false, "error": "application-support-dir-unavailable"]
    }

    let dir = url.deletingLastPathComponent()
    let fm = FileManager.default

    // Create the Frosthalt directory (and any missing parents) if absent.
    if !fm.fileExists(atPath: dir.path) {
      do {
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
      } catch {
        return ["ok": false, "error": "mkdir-failed: \(error.localizedDescription)"]
      }
    }

    // Atomic write: Data.WritingOptions.atomic writes to a temp file in the
    // same directory and renames over the destination on success. On failure
    // the temp is discarded and the destination is left untouched — exactly
    // the I/O Matrix "native IO error on write" contract.
    let data = Data(json.utf8)
    do {
      try data.write(to: url, options: [.atomic])
      return ["ok": true]
    } catch {
      return ["ok": false, "error": "write-failed: \(error.localizedDescription)"]
    }
  }
}
