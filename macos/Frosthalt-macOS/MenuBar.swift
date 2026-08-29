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
//  `emitOnQuickStart` / `emitOnShowWindow` / `emitOnQuit` on itself. Since
//  Story 6.2 the class also renders the LIVE badge mirror
//  (`setBadgeState(_:)`): the button's attributed title + the first menu
//  row's text, painted from strings JS derived — this class does no
//  derivation of its own. Story 6.3: "Show window" is decided entirely
//  natively (activation in the click handler — no JS round-trip) and `quit()`
//  terminates on main; the quick-start/quit DECISIONS still live in JS
//  (`src/domain/menuBarActions.ts`) via the emitted events — 6.5's
//  quit-confirm extends them.
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

  /// The disabled first menu row — held so `setBadgeState(_:)` can swap its
  /// title for the live badge/countdown text (Story 6.2) without rebuilding
  /// the menu. Main-thread only, like everything it touches.
  private var badgeRow: NSMenuItem?

  // MARK: - setBadgeState(_:) (Story 6.2)

  /// Renders the live badge mirror: the status-item button's attributed
  /// title (text + badge-state foreground color) and the first menu row's
  /// title. A DUMB renderer — all derivation (badge word, countdown text,
  /// which state) happened in JS (the domain mirror); this class only maps
  /// the `state` key to an NSColor and paints the strings it was handed.
  ///
  /// Main-thread dispatched, fire-and-forget, always `{ ok: true }` — same
  /// contract as `initialize()`. The payload's fields are read defensively:
  /// a missing/junk value keeps the current text rather than crashing (and
  /// an unknown `state` fails toward blocked/red, mirroring the JS
  /// derivation's fail-safe direction).
  @objc
  func setBadgeState(_ badge: [String: Any]) -> [String: Any] {
    DispatchQueue.main.async { [weak self] in
      guard let self = self else {
        return
      }
      let state = badge["state"] as? String
      let buttonTitle = badge["buttonTitle"] as? String
      let rowTitle = badge["rowTitle"] as? String

      if let button = self.statusItem?.button, let buttonTitle = buttonTitle {
        button.attributedTitle = NSAttributedString(
          string: buttonTitle,
          attributes: [.foregroundColor: Self.badgeColor(for: state)]
        )
      }
      if let rowTitle = rowTitle {
        self.badgeRow?.title = rowTitle
      }
    }
    return ["ok": true]
  }

  /// The badge-state foreground color for the status-item title. The SAME
  /// NSColor semantic names the JS `tokens.status` map uses
  /// (`systemGreenColor` / `systemOrangeColor` / `systemRedColor`), so the
  /// menu-bar mirror adapts to light/dark identically to the in-window pill
  /// fill. An unknown/missing key fails toward red — the over-blocking
  /// fail-safe the JS `computeBadgeState` already carries.
  private static func badgeColor(for state: String?) -> NSColor {
    switch state {
    case "free": return .systemGreen
    case "amber": return .systemOrange
    default: return .systemRed
    }
  }

  // MARK: - quit() (Story 6.3)

  /// Quits the app via `NSApp.terminate(nil)`, dispatched onto the main
  /// thread (like every other mutation here). The QUIT DECISION was already
  /// made in JS — the `onQuit` handler (`src/domain/menuBarActions.ts`)
  /// called this deliberately, and Story 6.5's confirm dialog will live
  /// there — so this method emits nothing and asks nothing: it terminates.
  /// Fire-and-forget, same contract as `initialize()`: the dispatch may be
  /// called from any thread, the return is always `{ ok: true }`.
  @objc
  func quit() -> [String: Any] {
    // No `self` capture — `NSApp` is global, so the block retains nothing.
    DispatchQueue.main.async {
      NSApp.terminate(nil)
    }
    return ["ok": true]
  }

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

    // Story 6.2: `variableLength` — the item's title is now LIVE TEXT (the
    // countdown while a session runs), which does not fit the fixed square
    // width 6.1 used for its static placeholder title.
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    // No status-item icon asset exists yet — plain text title fallback
    // (Ask First boundary: confirm before adding new asset files). 6.2's
    // `setBadgeState(_:)` replaces this with the live mirror text + color on
    // the first push; this is only what shows before that lands.
    item.button?.title = "Frosthalt"

    let menu = NSMenu()

    // 1. Disabled badge/countdown label row. Since 6.2 its title carries the
    // LIVE mirror text (the `badgeRow` reference is held above); the item
    // itself (and its disabled state) never changes.
    let placeholder = NSMenuItem(
      title: "Free · no active timer",
      action: nil,
      keyEquivalent: ""
    )
    placeholder.isEnabled = false
    menu.addItem(placeholder)
    self.badgeRow = placeholder

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
    // Story 6.3 — "Show window" is pure AppKit activation, decided entirely
    // on this click and never routed through JS (the event still fires — it
    // stays unlistened, which the TurboModule tolerates). Activation alone
    // is NOT enough for a Dock-minimized window (the app would come forward
    // with the window still miniaturized), so a miniaturized main window is
    // deminiaturized first; otherwise it is ordered front + key. The
    // nil-guard makes a no-main-window moment a harmless activation-only
    // no-op, not a crash.
    NSApp.activate(ignoringOtherApps: true)
    if let window = NSApp.mainWindow {
      if window.isMiniaturized {
        window.deminiaturize(nil)
      } else {
        window.makeKeyAndOrderFront(nil)
      }
    }
    onShowWindow?()
  }

  @objc private func handleQuit() {
    onQuit?()
  }
}
