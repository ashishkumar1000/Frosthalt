//
//  WindowPersistence.swift
//  Frosthalt-macOS
//
//  Story 6.4 — Window Size/Position Persistence and Restoration.
//
//  Owns the main window's frame lifecycle end to end:
//
//    1. RESTORE (launch-time, native-only): `attach()` is called from
//       `applicationDidFinishLaunching` AFTER `super` — the window is on
//       screen by then (RCTAppDelegate's `loadReactNativeWindow:` created and
//       keyed it inside the same method), and a setFrame in the same launch
//       tick paints no default-then-jump flash. It reads config.json via the
//       shared `ConfigStoreFile` helper (the public ConfigStore contract is
//       untouched), picks `settings.windowFrame` out of the parsed
//       NSDictionary with defensive numeric checks ONLY (no schema knowledge
//       — the documented, deliberate stretch of the dumb-string rule), and:
//         - field absent / file missing / unreadable / parse failure -> SKIP
//           (one-shot migration: whatever RN's own autosave
//           `RCTAppDelegateMainWindow` restored stays on screen);
//         - field present but corrupt (wrong types incl. JSON booleans,
//           non-finite, non-positive width/height) -> apply the PINNED
//           standard size, keeping the window's current origin.
//       Then it clears `window.frameAutosaveName` so RN stops writing its
//       autosave key — config.json becomes the single persistence source.
//
//    2. CAPTURE: observers on `didEndLiveResizeNotification` +
//       `didMoveNotification` start/replace a ~500 ms trailing debounce; the
//       settled frame is handed to `onFrameChanged` — a closure
//       NativeWindow.mm sets to the codegen emitter — which carries it to the
//       domain subscriber (`src/domain/windowFrame.ts`), which validates and
//       commits it. Capture is SUPPRESSED around a zoom-initiated setFrame
//       (a zoom must never overwrite the user's custom size) and while the
//       window is miniaturized/absent (nothing sensible to capture — the
//       `handleShowWindow` nil-guard lesson). Every eligibility condition is
//       re-checked at debounce-fire time, not arm time.
//
//    3. ZOOM: the class is the window's NSWindowDelegate (the RN window has
//       no delegate today, so owning it is safe);
//       `windowShouldZoom(_:toFrame:)` returns false — Apple's
//       fill-the-screen zoom never runs — and the toggle instead setFrame-
//       swaps app-standard ⇄ user-custom with the origin preserved. The
//       direction is DERIVED (current size vs the standard within a 1pt
//       tolerance), never stored; the "back to custom" target is the last
//       captured/restored custom frame, in-memory only.
//
//  Single sources of truth:
//    - The RUN-TIME sizes (min/max clamps + the zoom standard size) are
//      handed over by JS (`configureWindow(rules)` from
//      `startWindowFrameSync()` / src/domain/windowFrame.ts WINDOW_RULES).
//    - The SIX pinned numbers below (standard + min + max pairs) are the
//      LAUNCH-TIME copies: they run at attach() time, before the JS bundle
//      exists, so JS cannot hand them over yet. They MUST match WINDOW_RULES
//      in src/domain/windowFrame.ts — one "must match" comment block covers
//      them all, and the drift is guarded by a RUNNING test
//      (__tests__/windowFrame.test.ts reads this file as text), not just by
//      the comment.
//
//  Every NSWindow access is nil-guarded; `attachShared()` is safe whether or
//  not a window exists yet (a nil window skips restore/delegate/observers and
//  capture/zoom simply no-op — no crash, ever).
//
//  Glued into the Obj-C++ TurboModule (NativeWindow.mm) via the
//  Xcode-generated "<product>-Swift.h" header, same as MenuBar.swift, and
//  registered in the Frosthalt-macOS target's PBXGroup + Sources build phase
//  directly in project.pbxproj (the MenuBar.swift precedent).
//

import AppKit

@objc(WindowPersistence)
final class WindowPersistence: NSObject, NSWindowDelegate {

  // MARK: - Pinned launch-time sizes (corrupt-restore fallback + restore clamp)
  //
  // MUST match WINDOW_RULES in src/domain/windowFrame.ts — see the header.
  // These run at attach() time, before the JS bundle exists: the standard
  // pair is the CORRUPT-restore fallback size; the min/max pairs clamp a
  // valid-but-bounds-violating restored frame (hand-edited 1x1 or 5000x3000)
  // down/up into [min, max] at restore time, because AppKit's minSize/maxSize
  // (set later by `configureWindow`) do not retroactively resize an
  // already-applied frame. One comment block covers all six; the drift is
  // guarded by a running test (windowFrame.test.ts), not just comments.

  /// MUST match `standardWidth` in src/domain/windowFrame.ts (1280).
  private static let pinnedStandardWidth: CGFloat = 1280
  /// MUST match `standardHeight` in src/domain/windowFrame.ts (720).
  private static let pinnedStandardHeight: CGFloat = 720
  /// MUST match `minWidth` in src/domain/windowFrame.ts (880).
  private static let pinnedMinWidth: CGFloat = 880
  /// MUST match `minHeight` in src/domain/windowFrame.ts (560).
  private static let pinnedMinHeight: CGFloat = 560
  /// MUST match `maxWidth` in src/domain/windowFrame.ts (2560).
  private static let pinnedMaxWidth: CGFloat = 2560
  /// MUST match `maxHeight` in src/domain/windowFrame.ts (1440).
  private static let pinnedMaxHeight: CGFloat = 1440

  /// The frame-autosave name RN's window template assigns the main window.
  /// Looked up (never assigned) — resolution fallback in `attach()` and
  /// `bringMainWindowToFront()` when neither mainWindow nor keyWindow
  /// resolves. One constant, two lookups (the literal used to live in both
  /// call sites); the comment in `attach()` explains why it is only cleared,
  /// never re-registered.
  private static let rctMainWindowAutosaveName = "RCTAppDelegateMainWindow"

  // MARK: - Shared singleton

  /// The one instance, created by the FIRST `attachShared()` (from
  /// `applicationDidFinishLaunching`, main thread) and then handed the SAME
  /// instance by `sharedInstance()` (NativeWindow.mm) so the TurboModule's
  /// event closure and the launch-time window state are shared, not
  /// duplicated.
  private static var shared: WindowPersistence?

  /// Guards the `shared` read/create/write: `attachShared()` runs on the main
  /// thread (app delegate), but `sharedInstance()` is reachable from the JSI
  /// thread on first module access, so the static needs a lock (6.4 review).
  private static let sharedLock = NSLock()

  /// Locked shared-instance resolution used by both entry points. `attach`
  /// marks whether the freshly created instance should run `attach()`
  /// immediately (only the creation path does — a re-attach on an existing
  /// instance would double-install the window observers).
  private static func resolveShared(attachIfCreated: Bool) -> WindowPersistence {
    sharedLock.lock()
    defer { sharedLock.unlock() }
    if let existing = shared {
      return existing
    }
    let created = WindowPersistence()
    shared = created
    if attachIfCreated {
      created.attach()
    }
    return created
  }

  /// Launch-time entry point: creates the singleton if needed and runs
  /// `attach()`. Called from `applicationDidFinishLaunching` on the main
  /// thread. If the instance already exists, restore already ran — a second
  /// call is a no-op (not a second observer install).
  @objc
  static func attachShared() {
    _ = resolveShared(attachIfCreated: true)
  }

  /// The TurboModule-glue accessor: NativeWindow.mm calls this on every module
  /// creation to install the `onFrameChanged` emission closure on the SAME
  /// instance `attach()` configured. Creates the singleton lazily if the
  /// launch attach somehow never ran, so the module is still wired (capture
  /// just stays quiet).
  @objc
  static func sharedInstance() -> WindowPersistence {
    resolveShared(attachIfCreated: false)
  }

  // MARK: - bringMainWindowToFront() (Story 6.5)

  /// The shared "put the main window in front of the user" move, with ONE
  /// implementation for both callers: MenuBar.swift's `handleShowWindow`
  /// ("Show window") and its `presentQuitConfirm()` (before the JS quit
  /// confirm — `Alert.alert` is a sheet on the RN window, which is invisible
  /// while that window is `orderOut`, so the window must come front first,
  /// and only then).
  ///
  /// Activation + the deminiaturize/order-front body that
  /// `handleShowWindow` owned in 6.3, plus the same window resolution
  /// `attach()` uses (a bare `NSApp.mainWindow` can be nil at the instant of
  /// the call — after a ⌘W the RN window is ordered out but still resolvable
  /// via its autosave-name scan). Main-thread dispatched, fire-and-forget,
  /// nil-guarded: a no-window moment is an activation-only no-op, never a
  /// crash. NOTE this deliberately does NOT interact with the frame-capture
  /// observers — ordering a window front fires no move/resize notifications,
  /// so nothing here can disturb 6.4's capture.
  @objc
  static func bringMainWindowToFront() {
    DispatchQueue.main.async {
      NSApp.activate(ignoringOtherApps: true)
      let resolved =
        NSApp.mainWindow
        ?? NSApp.keyWindow
        ?? NSApp.windows.first {
          $0.frameAutosaveName == Self.rctMainWindowAutosaveName
        }
      guard let window = resolved else {
        return
      }
      if window.isMiniaturized {
        window.deminiaturize(nil)
      } else {
        window.makeKeyAndOrderFront(nil)
      }
    }
  }

  // MARK: - JS event forwarding (the MenuBar closure-bridging precedent)

  /// Set by NativeWindow.mm right after `sharedInstance()`. Fires the
  /// debounced frame payload (`{x, y, width, height}`) into the codegen
  /// `emitOnWindowFrameChanged` emitter. `@objc` so the property is visible
  /// to the Obj-C++ bridge as a settable block property.
  @objc var onFrameChanged: (([String: Any]) -> Void)?

  // MARK: - State (main-thread only, like everything it touches)

  /// The RN main window captured at attach time. Held by WEAK reference — a
  /// torn-down window must never be resurrected by this class.
  private weak var window: NSWindow?

  /// The zoom-target standard size, updated by `configureWindow(rules)` from
  /// JS. Seeded with the pinned standard until that first configure lands.
  private var standardSize = NSSize(width: WindowPersistence.pinnedStandardWidth,
                                    height: WindowPersistence.pinnedStandardHeight)

  /// The last known user-custom frame — seeded from a valid restored frame and
  /// updated by every captured non-standard frame — so "zoom on the standard
  /// frame" can restore the user's framing. In-memory only (deliberately not
  /// persisted; the toggle state derives from frame-vs-standard comparison).
  private var lastCustomFrame: CGRect?

  /// The zoom-suppression DEADLINE (6.4 review, replaces the old boolean +
  /// `defer`): a zoom-initiated `setFrame(animate: true)` posts
  /// didMove/didEndLiveResize ASYNCHRONOUSLY, so a boolean cleared when
  /// `toggleZoom` returns races those notifications — a post-return
  /// notification re-arms the ~500 ms debounce and the custom->standard zoom
  /// leg's standard-size frame gets emitted + committed to config.json,
  /// DESTROYING the persisted custom size (the frozen "No frame capture
  /// during zoom" clause). The deadline outlasts the notification window
  /// (debounce duration + animation headroom) and is checked at FIRE time.
  /// A COMPARISON means the suppression clears ITSELF when the deadline
  /// passes — there is no flag a throwing setFrame could leave stuck on
  /// (the former `defer` guarantee survives: suppression can never get
  /// permanently stuck, and BOTH zoom legs never emit).
  private var suppressUntil = Date.distantPast

  /// How long a zoom's suppression outlasts the setFrame: the ~500 ms
  /// debounce duration plus animation notification headroom.
  private static let suppressDuration: TimeInterval = 1.2

  /// The capture debounce duration (the spec's ~500 ms trailing debounce).
  private static let debounceInterval: TimeInterval = 0.5

  /// The pending debounce work item; canceled + replaced on every observed
  /// frame change so only the LAST settle is emitted (~500 ms trailing).
  private var debounceWork: DispatchWorkItem?

  /// willTerminate token (drains a pending captured frame before quit).
  private var terminateObserver: NSObjectProtocol?

  /// main-window willClose token (drains a pending capture before the frame
  /// the window is holding disappears with it).
  private var closeObserver: NSObjectProtocol?

  deinit {
    // The singleton normally lives for the whole process, but if the class is
    // ever torn down it must not leave stale observers behind.
    NotificationCenter.default.removeObserver(self)
    if let terminateObserver = terminateObserver {
      NotificationCenter.default.removeObserver(terminateObserver)
    }
    if let closeObserver = closeObserver {
      NotificationCenter.default.removeObserver(closeObserver)
    }
    debounceWork?.cancel()
    debounceWork = nil
  }

  // MARK: - attach() — launch-time native restore

  /// Captures the RN main window, restores the persisted frame (clamped into
  /// the pinned [min, max] bounds), or falls back to the corrupt ->
  /// pinned-standard size, clears RN's autosave, installs self as the window
  /// delegate, and observes resize-end + move + terminate/close (drain).
  /// Runs on the main thread from `applicationDidFinishLaunching`
  /// (AFTER `super`), so all window work here is already main-thread.
  /// Nil-guarded: with no window resolvable this is a safe no-op
  /// (never-crash contract).
  @objc
  func attach() {
    // Window resolution (6.4 review — a bare NSApp.mainWindow can be nil at
    // this moment and would silently PERMANENTLY skip restore/delegate/
    // observers/autosave-clear for the whole session). Resolve in order:
    // the RN key window, then a scan for the RN main window by
    // frameAutosaveName — searched BEFORE the autosave name is cleared
    // below (the clear itself is one of the things at risk if this
    // resolution failed).
    let resolved =
      NSApp.mainWindow
      ?? NSApp.keyWindow
      ?? NSApp.windows.first {
        $0.frameAutosaveName == Self.rctMainWindowAutosaveName
      }
    guard let window = resolved else {
      return
    }
    self.window = window

    // RN's own frame autosave stops here: config.json is the single
    // persistence source (two persistence layers would fight — restore,
    // overwrite, resave on every move). Legacy `RCTAppDelegateMainWindow`
    // values already in NSUserDefaults are simply never read again.
    // `frameAutosaveName` is a get-only Swift property on this SDK; the
    // setter form is the `setFrameAutosaveName(_:)` call (Bool result — a
    // failure to unset the legacy name is harmless, the stored value is
    // simply never read again either way).
    window.setFrameAutosaveName("")

    // One config read decides the restore branch. config.json is small
    // (Epic 1 bounds it) and the frame must land before the window is first
    // shown, so the synchronous read is deliberate.
    let storedPayload = WindowPersistence.readStoredFramePayload()

    if let payload = storedPayload, let rawFrame = WindowPersistence.validFrame(from: payload) {
      // Valid persisted frame: apply it in the same launch tick (no visible
      // jump — the window has not painted yet). The four numbers come from
      // config.json in AppKit coordinates, CLAMPED into the pinned [min,
      // max] bounds (6.4 review): AppKit's minSize/maxSize — handed over
      // later by `configureWindow` — do not retroactively resize a frame
      // that is already applied, so a hand-edited 1x1 or 5000x3000 frame
      // would come to life out-of-bounds before JS ever ran. The clamp is
      // surgical: size only, origin untouched, min <= standard <= max per
      // WINDOW_RULES so a clamped standard restore still reads as standard
      // to the zoom toggle. ("Dragging beyond bounds" is unaffected — that
      // is drag-time clamping, owned by minSize/maxSize below.)
      let clampedWidth = min(max(rawFrame.width, WindowPersistence.pinnedMinWidth),
                             WindowPersistence.pinnedMaxWidth)
      let clampedHeight = min(max(rawFrame.height, WindowPersistence.pinnedMinHeight),
                              WindowPersistence.pinnedMaxHeight)
      let frame = CGRect(origin: rawFrame.origin,
                         size: NSSize(width: clampedWidth, height: clampedHeight))
      window.setFrame(frame, display: false)
      // A restored CUSTOM frame is also the user's framing record — seed the
      // zoom's "back to custom" target from it.
      if !WindowPersistence.isStandard(size: frame.size, standard: standardSize) {
        lastCustomFrame = frame
      }
    } else if storedPayload != nil {
      // Present but CORRUPT: apply ONLY the pinned standard SIZE, keeping the
      // window's current origin (never clobber a valid position with a guess).
      var fallback = window.frame
      fallback.size = NSSize(width: WindowPersistence.pinnedStandardWidth,
                             height: WindowPersistence.pinnedStandardHeight)
      window.setFrame(fallback, display: false)
    }
    // (else: field absent / file missing / unreadable / parse failure ->
    // never-persisted: SKIP — one-shot migration, touch nothing.)

    // This class is now the window's delegate (the RN window had none, so
    // owning it is safe per the spec).
    window.delegate = self

    // Capture observers. Scope = this window only; notifications from any
    // other window (none exist today, but the MenuBar forward-compat rule
    // holds) never trigger a capture.
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleFrameStateChange),
      name: NSWindow.didEndLiveResizeNotification,
      object: window
    )
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(handleFrameStateChange),
      name: NSWindow.didMoveNotification,
      object: window
    )

    // Termination drains (6.4 review): a frame captured but still sitting in
    // the ~500 ms debounce when the user resizes then hits Cmd-Q would be
    // LOST. Drain the pending item synchronously at willTerminate, and at the
    // main window's willClose (which fires while the window still holds its
    // final frame). (Since 6.5, NSSupportsSuddenTermination is FALSE — the
    // SIGKILL vector that would skip willTerminate entirely — but the drain
    // still closes the ordinary lost-window case and must keep running.) The
    // 6.5 applicationShouldTerminate: confirm lives in MenuBar.swift /
    // AppDelegate.mm and does not interact with these observers.
    terminateObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.willTerminateNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.flushPendingCapture()
    }
    closeObserver = NotificationCenter.default.addObserver(
      forName: NSWindow.willCloseNotification,
      object: window,
      queue: .main
    ) { [weak self] _ in
      self?.flushPendingCapture()
    }
  }

  // MARK: - configureWindow(rules:) — JS hands over the size constants

  /// Applies the min/max clamps and updates the zoom-target standard size,
  /// all from `WINDOW_RULES` (src/domain/windowFrame.ts). Main-thread
  /// dispatched (may be called from the JSI thread), fire-and-forget
  /// (`{ ok: true }` always — there is nothing to report: a no-window moment
  /// is a no-op, and every dictionary read is defensive), nil-guarded.
  @objc
  func configureWindow(_ rules: [String: Any]) -> [String: Any] {
    let rulesCopy = rules
    DispatchQueue.main.async { [weak self] in
      guard let self = self else {
        return
      }
      if let w = WindowPersistence.number(rulesCopy["standardWidth"]),
         let h = WindowPersistence.number(rulesCopy["standardHeight"]),
         w > 0, h > 0 {
        self.standardSize = NSSize(width: CGFloat(w), height: CGFloat(h))
      }
      guard let window = self.window else {
        return
      }
      if let w = WindowPersistence.number(rulesCopy["minWidth"]),
         let h = WindowPersistence.number(rulesCopy["minHeight"]),
         w > 0, h > 0 {
        window.minSize = NSSize(width: CGFloat(w), height: CGFloat(h))
      }
      if let w = WindowPersistence.number(rulesCopy["maxWidth"]),
         let h = WindowPersistence.number(rulesCopy["maxHeight"]),
         w > 0, h > 0 {
        window.maxSize = NSSize(width: CGFloat(w), height: CGFloat(h))
      }
    }
    return ["ok": true]
  }

  // MARK: - Capture (debounced notifications)

  /// The shared notification handler for didEndLiveResize + didMove: (re)arms
  /// the ~500 ms trailing debounce — each change cancels the pending item and
  /// schedules a fresh one, so a drag's many intermediate frames coalesce into
  /// ONE emission with the final frame.
  @objc
  private func handleFrameStateChange() {
    debounceWork?.cancel()
    let work = DispatchWorkItem { [weak self] in
      self?.captureAndEmitIfEligible()
    }
    debounceWork = work
    DispatchQueue.main.asyncAfter(deadline: .now() + WindowPersistence.debounceInterval,
                                  execute: work)
  }

  /// Drains a PENDING debounce synchronously (termination close-out): the
  /// final captured frame is emitted NOW instead of being dropped with the
  /// unscheduled work item. No-op when nothing is pending; the same
  /// eligibility checks as the debounce path still apply (suppressed zoom
  /// coverage never emits, even here).
  private func flushPendingCapture() {
    guard let work = debounceWork, !work.isCancelled else {
      return
    }
    cancelDebounce()
    captureAndEmitIfEligible()
  }

  /// Runs when the debounce settles. Re-checks EVERY eligibility condition at
  /// FIRE time (state may have changed during the ~500 ms — a zoom's
  /// suppression deadline may cover this run, the window may have been
  /// miniaturized), then emits the frame. Nothing emits without a window and
  /// a live, un-suppressed frame (the spec's Never-capture matrix).
  private func captureAndEmitIfEligible() {
    guard let window = self.window,
          !window.isMiniaturized,
          Date() >= suppressUntil else {
      return
    }
    let frame = window.frame
    // A non-standard frame is the user's custom framing — track it as the
    // zoom toggle's "back to custom" target (standard-size captures would
    // corrupt that target, so only custom frames are recorded).
    if !WindowPersistence.isStandard(size: frame.size, standard: standardSize) {
      lastCustomFrame = frame
    }
    onFrameChanged?([
      "x": Double(frame.origin.x),
      "y": Double(frame.origin.y),
      "width": Double(frame.size.width),
      "height": Double(frame.size.height),
    ])
  }

  // MARK: - Zoom (windowShouldZoom override + derived toggle)

  /// Blocking AppKit's zoom: the green button / titlebar double-click must
  /// toggle app-standard ⇄ user-custom instead of filling the screen.
  /// Returning false means Apple's fill-the-screen zoom never runs; the
  /// toggle is performed right here (setFrame), origin preserved.
  func windowShouldZoom(_ window: NSWindow, toFrame newFrame: NSRect) -> Bool {
    toggleZoom(on: window)
    return false
  }

  /// The derived zoom toggle. Direction from comparing the CURRENT size
  /// against the standard within a 1pt tolerance (never a stored flag):
  ///   - standard now  -> restore `lastCustomFrame` (or stay put when none
  ///     exists — the I/O matrix's "if none exists, stays standard");
  ///   - custom now    -> setFrame to the standard size, origin preserved,
  ///     keeping the current frame as the way back.
  /// Capture is suppressed on BOTH legs (a zoom must never overwrite the
  /// user's custom size in config.json — committing a standard-size frame
  /// would destroy it). The suppression is a DEADLINE (`suppressUntil`,
  /// ~1.2 s), not a boolean cleared on return: `setFrame(animate: true)`
  /// posts didMove/didEndLiveResize asynchronously, so those notifications
  /// land AFTER `toggleZoom` returns and would re-arm the ~500 ms debounce
  /// against a flag that is already false — the zoom-emitted frame would be
  /// captured + committed, destroying the custom size. The deadline outlasts
  /// the notification window and clears ITSELF by comparison, so it cannot
  /// get stuck on even if setFrame throws (the old `defer` guarantee).
  /// cancelDebounce kills anything already armed. Nil-guards: no window or a
  /// miniaturized window -> no-op.
  private func toggleZoom(on window: NSWindow) {
    guard !window.isMiniaturized else {
      return
    }
    let current = window.frame
    // BOTH legs arm the deadline BEFORE touching the frame, so a notification
    // from the animation is guaranteed to land inside the suppression window.
    suppressUntil = Date().addingTimeInterval(WindowPersistence.suppressDuration)
    cancelDebounce()
    if WindowPersistence.isStandard(size: current.size, standard: standardSize) {
      // Zoom OFF the standard -> back to the user's custom framing, if any
      // was ever captured.
      if let custom = lastCustomFrame {
        window.setFrame(custom, display: true, animate: true)
      } else {
        // Nothing to restore to: the deadline is harmless (no setFrame ran,
        // no notifications either) — it simply expires.
        return
      }
    } else {
      // Zoom ON a custom frame: app-standard size, origin preserved, and
      // remember the custom frame as the way back.
      lastCustomFrame = current
      window.setFrame(
        CGRect(origin: current.origin, size: standardSize),
        display: true,
        animate: true
      )
    }
  }

  /// Cancels any pending capture debounce (used around zoom transitions so a
  /// scheduled emission cannot fire after the suppression window closes).
  private func cancelDebounce() {
    debounceWork?.cancel()
    debounceWork = nil
  }

  // MARK: - Config read (the shared ConfigStoreFile helper)

  /// Reads + parses config.json via the shared target-internal helper and
  /// returns `settings.windowFrame` as a raw `[String: Any]` — or nil when it
  /// is absent, the file is missing/unreadable, JSON parsing fails, `settings`
  /// is not a dictionary, or `windowFrame` itself is not a dictionary (an
  /// array / string / number / boolean / null there all land in the same
  /// "skip / one-shot migration" branch as a missing field — the caller's
  /// `storedPayload != nil` corruptions branch sees only
  /// present-but-genuinely-invalid FRAMES). Deliberate structure blindness:
  /// this reads ONE well-known key path, nothing else —
  /// `WindowPersistence` never becomes a schema-aware config reader.
  private static func readStoredFramePayload() -> [String: Any]? {
    guard let rawText = ConfigStoreFile.readRawConfigText(),
          let data = rawText.data(using: .utf8),
          let json = try? JSONSerialization.jsonObject(with: data),
          let root = json as? [String: Any],
          let settings = root["settings"] as? [String: Any] else {
      return nil
    }
    return settings["windowFrame"] as? [String: Any]
  }

  // MARK: - Frame validation (the native half of `normaliseWindowFrame`)

  /// Validates + extracts the frame from a plain dict: four REAL numeric
  /// fields, finite, positive width/height. Nil for anything corrupt.
  private static func validFrame(from payload: [String: Any]) -> CGRect? {
    guard let x = number(payload["x"]),
          let y = number(payload["y"]),
          let w = number(payload["width"]),
          let h = number(payload["height"]) else {
      return nil
    }
    guard x.isFinite, y.isFinite, w.isFinite, h.isFinite, w > 0, h > 0 else {
      return nil
    }
    return CGRect(x: CGFloat(x), y: CGFloat(y), width: CGFloat(w), height: CGFloat(h))
  }

  /// The JSON field read: a REAL number only. JSON booleans arrive as
  /// NSNumber with objCType 'c' and would otherwise coerce to 1.0/0.0 — a
  /// `"width": true` must fail validation, not masquerade as 1.0. JSON
  /// numbers arrive as 'd' (double) or an integer char, both accepted.
  private static func number(_ value: Any?) -> Double? {
    guard let n = value as? NSNumber else {
      return nil
    }
    let type = String(cString: n.objCType)
    guard type != "c", type != "B" else {
      return nil // JSON true/false — reject, never coerce
    }
    return n.doubleValue
  }

  /// The 1pt-tolerance size comparison the zoom toggle derives from.
  private static func isStandard(size: NSSize, standard: NSSize) -> Bool {
    abs(size.width - standard.width) <= 1.0
      && abs(size.height - standard.height) <= 1.0
  }
}