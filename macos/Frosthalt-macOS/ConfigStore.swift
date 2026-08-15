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

@objc(NativeConfigStore)
final class ConfigStore: NSObject {

  // MARK: - Path resolution

  /// ~/Library/Application Support/Frosthalt/config.json
  /// Resolved via NSSearchPathForApplicationSupportDirectory (AD-1 / config
  /// path contract). Returns nil only on a catastrophically broken user
  /// environment (no app-support dir), which is surfaced as an { ok:false }.
  private static func configURL() -> URL? {
    guard let supportDir = FileManager.default.urls(
      for: .applicationSupportDirectory,
      in: .userDomainMask
    ).first else {
      return nil
    }
    let appDir = supportDir.appendingPathComponent("Frosthalt", isDirectory: true)
    return appDir.appendingPathComponent("config.json", isDirectory: false)
  }

  // MARK: - Read

  /// Reads config.json and returns its raw string contents.
  ///
  /// Missing file is NOT an error: returns `{ ok: true, data: nil }`.
  /// An unrecoverable IO error returns `{ ok: false, error: "<reason>" }`.
  /// Never parses JSON.
  @objc
  func readConfig() -> [String: Any] {
    guard let url = ConfigStore.configURL() else {
      return ["ok": false, "error": "application-support-dir-unavailable"]
    }

    guard FileManager.default.fileExists(atPath: url.path) else {
      // Missing file -> empty config. The TS port maps this to DEFAULT_CONFIG.
      return ["ok": true, "data": NSNull()]
    }

    do {
      let raw = try String(contentsOf: url, encoding: .utf8)
      return ["ok": true, "data": raw as NSString]
    } catch {
      return ["ok": false, "error": "read-failed: \(error.localizedDescription)"]
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
    guard let url = ConfigStore.configURL() else {
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
