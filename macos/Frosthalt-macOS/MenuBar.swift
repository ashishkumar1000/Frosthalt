//
//  MenuBar.swift
//  Frosthalt-macOS
//
//  Story 6.1 — MenuBar TurboModule (NSStatusItem + NSMenu skeleton).
//
//  Owns the one NSStatusItem + NSMenu the app presents in the system menu
//  bar. `initialize()` builds them exactly once, guarded by `isInitialized`,
//  dispatched onto the main thread (all NSStatusItem/NSMenu creation and
//  mutation must happen there). A second call is a no-op — no duplicate
//  status item is created — and both calls return `{ ok: true }`.
//
//  Menu order top-to-bottom (frozen intent — 6.2 swaps the placeholder row's
//  text, not the item):
//    1. disabled placeholder label row ("Free · no active timer")
//    2. separator
//    3. "Start 25-min focus"
//    4. "Show window"
//    5. "Quit"
//
//  No status-item icon asset exists yet (Ask First boundary), so the status
//  item's button falls back to a plain text title.
//
//  Each actionable item's target/action forwards to a plain Swift closure
//  (`onQuickStart` / `onShowWindow` / `onQuit`) rather than emitting the JSI
//  event directly — this class knows nothing about TurboModule/JSI. The
//  Obj-C++ bridge (NativeMenuBar.mm) sets these closures once, right after
//  instantiating the singleton, to call the codegen-generated
//  `emitOnQuickStart` / `emitOnShowWindow` / `emitOnQuit` on itself. No live
//  badge/countdown wiring (6.2) or click-handling logic beyond firing the
//  closure (6.3) happens here — emitted events may stay unlistened in this
//  story.
//
//  Glued into the Obj-C++ TurboModule (NativeMenuBar.mm) via the
//  Xcode-generated "<product>-Swift.h" header, same as ConfigStore.swift /
//  ShellRunner.swift.
//
//  This file and NativeMenuBar.mm are registered in the Frosthalt-macOS
//  target's PBXGroup + Sources build phase directly in project.pbxproj
//  (mirroring the ShellRunner/ConfigStore entries) — no Xcode GUI step is
//  needed to pick them up. `cd macos && pod install && pnpm macos` still
//  builds + links everything.
//

import AppKit

@objc(NativeMenuBar)
final class MenuBar: NSObject {

  // MARK: - JS event forwarding

  /// Set by NativeMenuBar.mm right after this singleton is created. Each
  /// closure is a plain `() -> Void` (no payload) so it bridges cleanly from
  /// an Obj-C block; firing it calls the matching codegen `emitOn...` on the
  /// JS-visible TurboModule instance. `@objc` so the property is visible to
  /// the Obj-C++ bridge as a settable block-typed property.
  @objc var onQuickStart: (() -> Void)?
  @objc var onShowWindow: (() -> Void)?
  @objc var onQuit: (() -> Void)?

  // MARK: - State

  /// Guards `initialize()` so a second call is a no-op (no duplicate status
  /// item). Only ever read/written on the main thread (inside the
  /// `DispatchQueue.main.async` block below), so no lock is needed.
  private var isInitialized = false

  private var statusItem: NSStatusItem?

  // MARK: - initialize()

  /// Idempotently builds the status item + menu skeleton. The actual
  /// NSStatusItem/NSMenu construction is dispatched onto the main thread
  /// (required for AppKit UI objects); this method itself may be called from
  /// any thread (the JSI calling thread) and always returns `{ ok: true }`
  /// synchronously without waiting for that dispatch to complete — there is
  /// nothing for the caller to react to on failure (no I/O, no user input),
  /// so a fire-and-forget dispatch is sufficient here.
  @objc
  func initialize() -> [String: Any] {
    DispatchQueue.main.async { [weak self] in
      self?.buildStatusItemIfNeeded()
    }
    return ["ok": true]
  }

  /// Builds the NSStatusItem + NSMenu exactly once. MUST run on the main
  /// thread. The `isInitialized` check happens here (not in `initialize()`)
  /// so it is only ever evaluated/mutated on the main thread, avoiding a race
  /// between two overlapping `initialize()` calls from different threads.
  private func buildStatusItemIfNeeded() {
    guard !isInitialized else {
      return
    }
    isInitialized = true

    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    // No status-item icon asset exists yet — plain text title fallback
    // (Ask First boundary: confirm before adding new asset files).
    item.button?.title = "Frosthalt"

    let menu = NSMenu()

    // 1. Disabled placeholder label row. 6.2 swaps this item's title for the
    // live Zustand-driven badge/countdown text; the item itself (and its
    // disabled state) doesn't change here.
    let placeholder = NSMenuItem(
      title: "Free · no active timer",
      action: nil,
      keyEquivalent: ""
    )
    placeholder.isEnabled = false
    menu.addItem(placeholder)

    // 2. Separator.
    menu.addItem(NSMenuItem.separator())

    // 3-5. Actionable items. Each forwards its click to the matching closure
    // (set by NativeMenuBar.mm) rather than emitting a JSI event directly.
    menu.addItem(makeActionItem(title: "Start 25-min focus", action: #selector(handleQuickStart)))
    menu.addItem(makeActionItem(title: "Show window", action: #selector(handleShowWindow)))
    menu.addItem(makeActionItem(title: "Quit", action: #selector(handleQuit)))

    item.menu = menu
    self.statusItem = item
  }

  private func makeActionItem(title: String, action: Selector) -> NSMenuItem {
    let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: "")
    menuItem.target = self
    return menuItem
  }

  // MARK: - Menu-item actions (main thread — NSMenu always calls actions there)

  @objc private func handleQuickStart() {
    onQuickStart?()
  }

  @objc private func handleShowWindow() {
    onShowWindow?()
  }

  @objc private func handleQuit() {
    onQuit?()
  }
}
