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
//  (`onQuickStart` / `onShowWindow` / `onQuit` / `onQuitRequested`) rather
//  than emitting the JSI event directly — this class knows nothing about
//  TurboModule/JSI. The Obj-C++ bridge (NativeMenuBar.mm) sets these closures,
//  re-wiring them on every module creation (the NativeWindow.mm reload-survival
//  pattern) to call the codegen-generated `emitOn...` on itself. Since
//  Story 6.2 the class also renders the LIVE badge mirror
//  (`setBadgeState(_:)`): the button's attributed title + the first menu
//  row's text, painted from strings JS derived — this class does no
//  derivation of its own. Story 6.3: "Show window" is decided entirely
//  natively (activation in the click handler — no JS round-trip) and `quit()`
//  is the quit ENTRY. Story 6.5: `quit()`'s `NSApp.terminate` (and every other
//  quit source — ⌘Q, Dock, the storyboard Quit item) funnels through the app
//  delegate's `applicationShouldTerminate:`, which calls
//  `handleShouldTerminate()` HERE: the single arbitration point. Any quit
//  that is not yet JS-confirmed is cancelled and re-raised as
//  `onQuitRequested`; the confirm DECISION still lives in JS
//  (`src/domain/menuBarActions.ts`), which answers with `confirmQuit()` (no
//  live session — quit now, invisibly) or `presentQuitConfirm()` + its own
//  `Alert.alert` (live session), and `confirmQuit()` re-enters
//  `NSApp.terminate` with the flag set.
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

  // MARK: - Shared instance

  /// The one instance, resolved via `sharedInstance()` by BOTH consumers that
  /// must agree: NativeMenuBar.mm (the TurboModule glue — its closures and its
  /// `confirmQuit()` flag writes land here) and AppDelegate.mm's
  /// `applicationShouldTerminate:` (reads the same flag + closure). Two
  /// separate instances would break the quit gate outright — the delegate
  /// would consume a flag the module never set — so the WindowPersistence
  /// resolveShared pattern (6.4 review: lock, not just a main-thread read) is
  /// mirrored here.
  private static var shared: MenuBar?

  /// Guards the `shared` read/create/write: `sharedInstance()` is reachable
  /// from the JSI thread (first module access) and from the main thread
  /// (`applicationShouldTerminate:`), so the static needs a lock.
  private static let sharedLock = NSLock()

  /// Locked shared-instance resolution. Both entry points call this; the
  /// first caller creates the singleton, everyone else gets that same one.
  @objc
  static func sharedInstance() -> MenuBar {
    sharedLock.lock()
    defer { sharedLock.unlock() }
    if let existing = shared {
      return existing
    }
    let created = MenuBar()
    shared = created
    return created
  }

  // MARK: - JS event forwarding

  /// Set (re-set) by NativeMenuBar.mm on EVERY module creation — the
  /// NativeWindow.mm re-wire pattern, so a bridge reload points the emitters
  /// at the live module instance. Each closure is a plain `() -> Void` (no
  /// payload) so it bridges cleanly from an Obj-C block; firing it calls the
  /// matching codegen `emitOn...` on the JS-visible TurboModule instance.
  /// `@objc` so the property is visible to the Obj-C++ bridge as a settable
  /// block-typed property.
  @objc var onQuickStart: (() -> Void)?
  @objc var onShowWindow: (() -> Void)?
  @objc var onQuit: (() -> Void)?
  /// Story 6.5 — fired when `applicationShouldTerminate:` defers an
  /// un-confirmed quit (any source); JS decides confirm-vs-continue.
  @objc var onQuitRequested: (() -> Void)?

  /// Guards the four emitter closures (Story 6.5 review hardening). The
  /// WRITES happen on the JSI calling thread (NativeMenuBar.mm's re-wire on
  /// every module access, and `detachEmitterClosures()` on invalidate), while
  /// `handleShouldTerminate()` READS `onQuitRequested` on the main thread —
  /// unsynchronized block-pointer assignment/read would be a data race.
  private let emitterLock = NSLock()

  /// The single attach point the Obj-C++ bridge uses instead of writing the
  /// four `@objc var` closures directly — one lock scope for all four keeps
  /// the closure set internally consistent. Called from the JSI thread.
  // The Obj-C selector is PINNED explicitly: Swift's default mangling of a
  // first label that starts with a preposition ("on") merges it into the base
  // name as "attachEmitterClosuresOnQuickStart:...", while NativeMenuBar.mm
  // (and reading convention) expect "...WithOnQuickStart:...". An implicit
  // @objc here ships the mangled name and the bridge "declares no selector"
  // at compile time — the real-build 6.5 lesson. Pinning removes the
  // toolchain-dependent heuristic from the contract. (detach/handleShouldTerminate/
  // confirmQuit etc. are single-segment and mangle identically.)
  @objc(attachEmitterClosuresWithOnQuickStart:onShowWindow:onQuit:onQuitRequested:)
  func attachEmitterClosures(
    onQuickStart: (() -> Void)?,
    onShowWindow: (() -> Void)?,
    onQuit: (() -> Void)?,
    onQuitRequested: (() -> Void)?
  ) {
    emitterLock.lock()
    defer { emitterLock.unlock() }
    self.onQuickStart = onQuickStart
    self.onShowWindow = onShowWindow
    self.onQuit = onQuit
    self.onQuitRequested = onQuitRequested
  }

  /// Nils all four emitter closures. NativeMenuBar.mm calls this from its
  /// `-invalidate` (bridge reload/teardown): the dying module's closures would
  /// otherwise keep targeting a deallocated instance — weak captures dropped
  /// every emit — and, critically for the Quit gate, `handleShouldTerminate()`
  /// would see a NON-nil stale closure it cannot deliver through, cancelling
  /// every quit forever. Detaching makes the gate fail open (nil → terminate),
  /// exactly like the quit-before-JS-subscribes case, until JS re-subscribes.
  @objc
  func detachEmitterClosures() {
    emitterLock.lock()
    defer { emitterLock.unlock() }
    onQuickStart = nil
    onShowWindow = nil
    onQuit = nil
    onQuitRequested = nil
  }

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

  // MARK: - Quit gate (Story 6.5)

  /// The JS-confirmed terminate flag. Set by `confirmQuit()` immediately
  /// before the `NSApp.terminate(nil)` it dispatches onto the main queue, and
  /// CONSUMED (reset to false) by `handleShouldTerminate()` so the gate
  /// re-arms for the next, un-confirmed attempt. Only ever read/written on
  /// the main thread — `handleShouldTerminate()` runs inside the app
  /// delegate's `applicationShouldTerminate:` (main), and `confirmQuit()`
  /// does its write inside the same main-queue block as the terminate — so
  /// no lock is needed.
  private var terminateConfirmedByJS = false

  /// The single arbitration point for EVERY quit source (⌘Q, Dock quit, the
  /// storyboard Quit menu item, the JS `quit()` entry): the app delegate's
  /// `applicationShouldTerminate:` forwards here. The decision lives in JS:
  ///
  ///   - `terminateConfirmedByJS` set  -> this terminate IS the JS-issued
  ///     `confirmQuit()` ride: consume the flag (reset — the gate re-arms for
  ///     the next quit) and return terminate. No bypass path: the confirm's
  ///     termination comes back through this same gate by construction.
  ///   - `onQuitRequested` closure nil -> FAIL OPEN and return terminate. A
  ///     quit that arrives before JS has subscribed (the startup window)
  ///     must never brick the app's ability to quit: terminating without a
  ///     confirm is always the safe failure for a quit.
  ///   - otherwise -> fire `onQuitRequested` (JS decides confirm vs
  ///     unconditional go) and return CANCEL — the pending quit is re-raised
  ///     as an event, and a live-session confirm (if JS wants one) comes back
  ///     through `confirmQuit()`.
  ///
  /// Main thread only (NSApp.terminate + the app delegate both are).
  @objc
  func handleShouldTerminate() -> Bool {
    if terminateConfirmedByJS {
      terminateConfirmedByJS = false
      return true
    }
    // Snapshot the closure under the emitter lock (the writer is on the JSI
    // thread), but fire it OUTSIDE the lock — the emit may run arbitrary JS,
    // and blocking the JSI thread's writer behind a held lock would invite
    // deadlock.
    emitterLock.lock()
    let emit = onQuitRequested
    emitterLock.unlock()
    guard let emit = emit else {
      return true
    }
    emit()
    return false
  }

  /// The quit ENTRY the JS `quitApp()` adapter reaches through the
  /// TurboModule. Since 6.5 this is deliberately NOT an immediate terminate:
  /// the dispatched `NSApp.terminate(nil)` funnels through the app delegate's
  /// `applicationShouldTerminate:` → `handleShouldTerminate()` like every
  /// other quit source — no confirm flag is set first, so the gate cancels
  /// the terminate and raises `onQuitRequested`; JS then answers
  /// `confirmQuit()` (no live session) or fronts the window + its confirm
  /// Alert. Fire-and-forget, always `{ ok: true }`.
  ///
  /// NOTE: distinct from the status-menu click handler `handleQuit()`, which
  /// only re-raises the `onQuit` event (JS owns the decision) — that path also
  /// funnels here through the gate.
  @objc
  func quit() -> [String: Any] {
    DispatchQueue.main.async {
      NSApp.terminate(nil)
    }
    return ["ok": true]
  }

  /// The JS "go" leg of the quit confirm: sets the flag and dispatches
  /// `NSApp.terminate(nil)` on the main queue, so the delegate's
  /// `applicationShouldTerminate:` re-enters `handleShouldTerminate()`,
  /// consumes the flag and returns terminate — re-entrancy is flag-based,
  /// there is no bypass path. Called from the `onQuitRequested` handler only
  /// (no live session, or the dialog's Quit press). `NSApp.terminate` — NEVER
  /// `exit()`/forced termination — so 6.4's `willTerminateNotification`
  /// frame flush still runs. Fire-and-forget, always `{ ok: true }`.
  @objc
  func confirmQuit() -> [String: Any] {
    // The flag is set inside the main-queue block, immediately before the
    // terminate, so the delegate always sees it in the same run-loop turn —
    // and no other quit attempt can race in between the two.
    DispatchQueue.main.async { [weak self] in
      self?.terminateConfirmedByJS = true
      NSApp.terminate(nil)
    }
    return ["ok": true]
  }

  /// Fronts the main window so the JS confirm `Alert.alert` — a sheet on the
  /// RN window — is visible even when the window was closed to the menu bar
  /// (`orderOut`). Only the live-session quit path calls it, and only when a
  /// dialog is about to show: the no-timer quit path skips this so ⌘Q never
  /// flashes the window. The fronting body itself lives in the shared
  /// `WindowPersistence.bringMainWindowToFront()` helper (the same body
  /// `handleShowWindow` uses — deduped, 6.5).
  ///
  /// SYNCHRONOUS, deliberately (6.5 review): the JS handler only calls
  /// `Alert.alert` after this returns, so the window must already be front by
  /// then. A fire-and-forget main-queue dispatch would return first and let
  /// the Alert's bridge hop overtake the fronting — the sheet could attach to
  /// a still-ordered-out (invisible) window. The `dispatch_sync` from the JSI
  /// thread is safe here: module invocations never have the main thread
  /// blocked on the JSI thread.
  @objc
  func presentQuitConfirm() -> [String: Any] {
    if Thread.isMainThread {
      WindowPersistence.bringMainWindowToFront()
    } else {
      DispatchQueue.main.sync {
        WindowPersistence.bringMainWindowToFront()
      }
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
    // Story 6.5 — the status-menu Quit gains the ⌘Q display (the app-standard
    // look; parity with the storyboard's Quit item). DISPLAY ONLY: a status
    // menu's key equivalent only applies while that very menu is open — the
    // storyboard item (Main.storyboard) owns the real ⌘Q handling, and both
    // sources funnel into the same applicationShouldTerminate: gate anyway.
    let quitItem = makeActionItem(title: "Quit", action: #selector(handleQuit))
    quitItem.keyEquivalent = "q"
    quitItem.keyEquivalentModifierMask = .command
    menu.addItem(quitItem)

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
    // no-op, not a crash. Story 6.5 — the body moved into the shared
    // `WindowPersistence.bringMainWindowToFront()` helper: the quit-confirm
    // dialog needs to front the exact same window the exact same way, and
    // there must be one activation implementation, not two.
    WindowPersistence.bringMainWindowToFront()
    onShowWindow?()
  }

  @objc private func handleQuit() {
    onQuit?()
  }
}
