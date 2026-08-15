//
//  ShellRunner.swift
//  Frosthalt-macOS
//
//  Story 1.5 — ShellRunner TurboModule (the ONLY privileged adapter).
//
//  Owns the privileged write to /etc/hosts + the hosts-line contract
//  enforcement (AD-3 / AD-4). The single `writeHosts(lines)` method runs
//  EXACTLY ONE `osascript ... with administrator privileges` per call that
//  batches, in strict order:
//
//    1. cp /etc/hosts /etc/hosts.fh.bak            (backup)
//    2. full-section rewrite of `# BEGIN FROSTHALT`..`# END FROSTHALT`
//       (preserve everything outside; never incremental; append the section
//       if the markers don't yet exist; abort with no write if the markers
//       are malformed — unpaired or duplicated — so /etc/hosts is never
//       silently truncated)
//    3. chown root:wheel + chmod 644               (restore owner/mode)
//    4. dscacheutil -flushcache + killall -HUP mDNSResponder (DNS flush)
//
//  Injection safety, two layers (NFR-5) — revised in review loop 1:
//    L1 — every line is validated against the strict hosts-line regex (after
//         trim + lowercase) BEFORE any elevation. A failure resolves
//         {ok:false, error:"invalid-lines"} with NO prompt and /etc/hosts
//         untouched.
//    L2 — the validated lines reach root ONLY via a data-only temp file
//         (`LINES_FILE`, app-written mode 0600) that awk reads and prints,
//         never executes or sources. The `osascript ... with administrator
//         privileges` command string is a STATIC script body (the backup ->
//         splice -> chown/chmod -> flush sequence) containing NO user content
//         — only the system-generated `LINES_FILE` path — and it is carried
//         base64-encoded so no AppleScript string quoting is needed. No
//         user-writable file is ever executed as root: a same-user attacker
//         who swaps `LINES_FILE` can at worst inject a hosts *line* (bounded,
//         data-only), never root *code*. (The original design ran a
//         user-writable temp script as root — a local priv-esc; revised.)
//         The `LINES_FILE` path is sanitised (no `'` / `\`) before it is
//         interpolated into the single-quoted body, as defence-in-depth.
//
//  Threading (NFR-8): the LINES_FILE write + privileged call are dispatched
//  off the main thread; the JS Promise resolves on completion; the UI never
//  blocks. Only the synchronous line validation + marker pre-scan (and their
//  no-prompt early-resolves) run on the calling JSI thread.
//
//  Every call returns the uniform { ok, error? } envelope over JSI. The
//  Promise ALWAYS resolves, never rejects — errors ride inside the envelope
//  (consistent with ConfigStore's never-throw). The `reject` block is
//  intentionally unused (see the never-reject contract).
//
//  Glued into the Obj-C++ TurboModule (NativeShellRunner.mm) via the
//  Xcode-generated "<product>-Swift.h" header. The bridging header
//  (Frosthalt-macOS-Bridging-Header.h) imports <React/RCTBridgeModule.h> so
//  Swift can name RCTPromiseResolveBlock / RCTPromiseRejectBlock.
//

import Foundation

@objc(NativeShellRunner)
final class ShellRunner: NSObject {

  // MARK: - Validation (defence-in-depth layer 1)

  /// The strict hosts-line regex. Applied AFTER trim + lowercase. Allows only
  /// `0.0.0.0` or `::` (never loopback) + a single whitespace-separated
  /// lowercase hostname made of [a-z0-9.-], starting and ending alphanumeric.
  /// Anything that isn't a `target hostname` pair (e.g. `"; rm -rf /"`,
  /// `127.0.0.1 x`) fails here and never reaches LINES_FILE.
  ///
  /// `try!` is deliberate: the pattern is a compile-time constant and a bug
  /// here is a fatal programming error, not a runtime user condition.
  private static let hostsLineRegex = try! NSRegularExpression(
    pattern: "^(0\\.0\\.0\\.0|::)\\s+[a-z0-9]([a-z0-9.-]*[a-z0-9])?$"
  )

  /// True iff `raw` (after trim + lowercase) matches the hosts-line regex.
  private static func isValidHostsLine(_ raw: String) -> Bool {
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalized.isEmpty else { return false }
    let range = NSRange(location: 0, length: normalized.utf16.count)
    return ShellRunner.hostsLineRegex.firstMatch(
      in: normalized, options: [], range: range
    ) != nil
  }

  // MARK: - Marker scan (pre-elevation, no-prompt guard for a corrupt hosts)

  /// Tolerant managed-section marker match: case-insensitive, anchored at the
  /// start of the line (`^#`, no leading-whitespace tolerance — managed
  /// sections are never indented), any run of spaces/tabs between `#`,
  /// `BEGIN`/`END`, and `FROSTHALT`, an optional trailing comment
  /// (`# BEGIN FROSTHALT (note)` is recognised and normalised on write), and
  /// optional trailing whitespace. This is kept EXACTLY in sync with the awk
  /// marker patterns in `privilegedBody(linesFilePath:)` so the pre-scan and
  /// the splice agree on what a marker is (a divergence would make the scan
  /// see a clean pair while awk sees no markers -> awk appends a second
  /// section). Both operate on the raw line with no leading-whitespace trim.
  private static let beginMarkerRegex = try! NSRegularExpression(
    pattern: "^#[ \\t]*begin[ \\t]+frosthalt([ \\t]+.*)?$",
    options: [.caseInsensitive]
  )
  private static let endMarkerRegex = try! NSRegularExpression(
    pattern: "^#[ \\t]*end[ \\t]+frosthalt([ \\t]+.*)?$",
    options: [.caseInsensitive]
  )

  /// Counts (begin, end) managed-section markers in /etc/hosts (tolerant match,
  /// raw line). Returns nil if /etc/hosts cannot be read — distinguished from
  /// a clean (0,0) so a missing/unreadable hosts file is refused BEFORE any
  /// admin prompt rather than prompting then failing on `cp`. /etc/hosts is
  /// world-readable, so this unprivileged read is free (parallel to the
  /// invalid-lines no-prompt guard).
  private static func markerCounts(in path: String = "/etc/hosts") -> (Int, Int)? {
    guard let contents = try? String(contentsOfFile: path, encoding: .utf8) else {
      return nil
    }
    var begin = 0
    var end = 0
    for raw in contents.split(separator: "\n", omittingEmptySubsequences: false) {
      let line = String(raw)
      let r = NSRange(location: 0, length: line.utf16.count)
      if ShellRunner.beginMarkerRegex.firstMatch(in: line, options: [], range: r) != nil {
        begin += 1
      } else if ShellRunner.endMarkerRegex.firstMatch(in: line, options: [], range: r) != nil {
        end += 1
      }
    }
    return (begin, end)
  }

  // MARK: - Threading

  /// The privileged osascript call runs here, off the main thread (NFR-8).
  /// `userInitiated` because the user explicitly triggered an Apply; we want
  /// the prompt + write to land promptly, but never on the main queue.
  private static let backgroundQueue = DispatchQueue(
    label: "com.frosthalt.shellrunner",
    qos: .userInitiated
  )

  // MARK: - writeHosts (the single privileged method)

  /// Rewrites the managed `# BEGIN/END FROSTHALT` section of /etc/hosts with
  /// `lines` via one privileged osascript batch (backup -> full-section rewrite
  /// -> restore owner/mode -> DNS flush), off the main thread.
  ///
  /// `lines` MUST already be normalised (apex + `www.` on `0.0.0.0` + `::`,
  /// lowercase) — producing them from a domain list is 1.6's `normaliseDomain`.
  /// This method re-validates each line (layer 1) before any elevation.
  ///
  /// Always resolves the promise, never rejects (`reject` is intentionally
  /// unused — see the never-reject contract):
  ///   - { ok: true }                           on success
  ///   - { ok: false, error: "invalid-lines" }  on a regex failure (no prompt)
  ///   - { ok: false, error: "hosts-unreadable" } if /etc/hosts can't be read
  ///   - { ok: false, error: "markers-mismatch" } on a corrupt managed section
  ///   - { ok: false, error: "admin-denied" }   on user-cancel
  ///   - { ok: false, error: "<detail>" }       on any other OS error
  @objc
  func writeHosts(
    _ lines: [String],
    resolve: @escaping RCTPromiseResolveBlock,
    reject: @escaping RCTPromiseRejectBlock
  ) {
    // reject is intentionally unused — the never-reject contract routes every
    // outcome through `resolve` with the { ok, error? } envelope. Both blocks
    // are @escaping: `resolve` is called from the background-queue async closure
    // below (the privileged osascript runs off the main thread — NFR-8), so the
    // closure outlives this synchronous function frame.
    _ = reject

    // Layer 1: validate EVERY line BEFORE any elevation. A single bad line
    // rejects the whole batch — no prompt, /etc/hosts untouched.
    for raw in lines {
      if !ShellRunner.isValidHostsLine(raw) {
        resolve(["ok": false, "error": "invalid-lines"])
        return
      }
    }

    // Pre-elevation marker scan: refuse a corrupt managed section BEFORE any
    // admin prompt, so /etc/hosts is never silently truncated. The only
    // accepted states are zero markers (first write) or exactly one clean
    // pair; everything else (unpaired, duplicated) is a <detail> error. A nil
    // result means /etc/hosts itself is unreadable (distinct from 0 markers).
    guard let (beginCount, endCount) = ShellRunner.markerCounts() else {
      resolve(["ok": false, "error": "hosts-unreadable"])
      return
    }
    let cleanPair =
      (beginCount == 0 && endCount == 0) || (beginCount == 1 && endCount == 1)
    if !cleanPair {
      resolve(["ok": false, "error": "markers-mismatch"])
      return
    }

    // Write the validated lines to a data-only LINES_FILE (mode 0600, one
    // step). This is the ONLY user-derived artifact; awk reads/prints it,
    // never executes it.
    let linesFilePath: String
    do {
      linesFilePath = try ShellRunner.writeLinesFile(lines: lines)
    } catch {
      resolve([
        "ok": false,
        "error": "lines-file-failed: \(error.localizedDescription)",
      ])
      return
    }

    // Defence-in-depth: the path is interpolated into a single-quoted sh
    // string inside the static body. It comes from NSTemporaryDirectory() +
    // UUID (no quotes/backslashes in practice), but refuse anything that
    // could break out of the single-quote context rather than trust that.
    if linesFilePath.contains("'") || linesFilePath.contains("\\") {
      try? FileManager.default.removeItem(atPath: linesFilePath)
      resolve(["ok": false, "error": "lines-file-failed: unsafe temp path"])
      return
    }

    // Build + run the single privileged osascript off the main thread. The
    // command string is a STATIC body (base64-encoded) referencing only the
    // system-generated LINES_FILE path — no user content, no user-writable
    // file executed as root (NFR-5). The Promise resolves on completion; the
    // UI never blocks (NFR-8).
    ShellRunner.backgroundQueue.async {
      let result = ShellRunner.runOsaScript(linesFilePath: linesFilePath)
      // Best-effort cleanup of the data-only LINES_FILE (it's /tmp content;
      // leaving it would be harmless but tidy is better).
      try? FileManager.default.removeItem(atPath: linesFilePath)

      let envelope: [String: Any]
      switch result {
      case .success:
        envelope = ["ok": true]
      case .adminDenied:
        envelope = ["ok": false, "error": "admin-denied"]
      case .failure(let detail):
        envelope = ["ok": false, "error": detail]
      }
      resolve(envelope)
    }
  }

  // MARK: - LINES_FILE (layer 2: data-only temp file the app writes)

  /// Writes the validated lines to a fresh temp file under the system temp dir
  /// (UUID-named, no subprocess fork) with mode 0600 in a single create step
  /// (so there is no world-readable window between create and chmod), and
  /// returns its path. `awk` reads and prints this file — it is data, never
  /// executed or sourced. An empty `lines` yields an empty file (managed
  /// section gets markers only -> unblocks all; spec I/O Matrix: empty
  /// blocklist).
  private static func writeLinesFile(lines: [String]) throws -> String {
    let dir = NSTemporaryDirectory()
    // NSTemporaryDirectory() is documented to return "" on failure; an empty
    // dir would yield a relative path, and `do shell script ... with
    // administrator privileges` runs with CWD /, so awk could not open it.
    // Refuse up front rather than risk a silent markers-only write.
    guard !dir.isEmpty else {
      throw NSError(
        domain: "ShellRunner", code: 3,
        userInfo: [NSLocalizedDescriptionKey: "no temporary directory"]
      )
    }
    let path = (dir as NSString).appendingPathComponent("fh_lines.\(UUID().uuidString)")
    let body = Data(lines.joined(separator: "\n").utf8)
    // createFile applies the permissions at create time; umask can only clear
    // bits, and 0600 has no group/other bits to clear, so the file is 0600
    // from the first byte (no brief world-readable window in shared /tmp).
    let created = FileManager.default.createFile(
      atPath: path,
      contents: body,
      attributes: [.posixPermissions: 0o600]
    )
    guard created else {
      throw NSError(
        domain: "ShellRunner", code: 4,
        userInfo: [NSLocalizedDescriptionKey: "could not create LINES_FILE"]
      )
    }
    return path
  }

  // MARK: - The privileged static body

  /// Returns the static privileged sh body that rewrites the managed section,
  /// referencing `linesFilePath` (system-generated, sanitised, no user
  /// content). The body is base64-encoded before going into the `do shell
  /// script` string, so its embedded quotes / newlines never touch AppleScript
  /// string parsing.
  ///
  /// The awk splice (tolerant marker match — identical patterns to the Swift
  /// `markerCounts`, canonical re-emit):
  ///   - one clean marker pair -> replace the section body with LINES_FILE
  ///   - no markers -> append a fresh section (END block, printed=0)
  ///   - markers normalised to `# BEGIN/END FROSTHALT` on write
  ///   - any marker-pair drift the pre-scan missed (e.g. a TOCTOU edit between
  ///     the scan and the `cp`) -> awk counts the markers itself and
  ///     `exit 1`s with "markers-mismatch" before `mv`, so /etc/hosts stays
  ///     untouched rather than being silently truncated/duplicated.
  /// `set -e` aborts the whole body on any critical-path failure; the EXIT
  /// trap removes a partial /etc/hosts.new so no stale root-owned artifact
  /// accumulates across runs.
  private static func privilegedBody(linesFilePath: String) -> String {
    return """
#!/bin/sh
set -e
trap 'rm -f /etc/hosts.new' 0

LINES_FILE='\(linesFilePath)'
if [ ! -r "$LINES_FILE" ]; then
  echo "lines-file-unreadable" >&2
  exit 1
fi

cp /etc/hosts /etc/hosts.fh.bak

awk -v L="$LINES_FILE" '
  BEGIN { in_section = 0; printed = 0; bcount = 0; ecount = 0 }
  tolower($0) ~ /^#[ \\t]*begin[ \\t]+frosthalt([ \\t]+.*)?$/ { bcount++; in_section = 1; print "# BEGIN FROSTHALT"; next }
  tolower($0) ~ /^#[ \\t]*end[ \\t]+frosthalt([ \\t]+.*)?$/ {
    ecount++
    while ((getline line < L) > 0) print line
    close(L)
    in_section = 0
    print "# END FROSTHALT"
    printed = 1
    next
  }
  in_section { next }
  { print }
  END {
    if (bcount != ecount || bcount > 1) {
      print "markers-mismatch" > "/dev/stderr"
      exit 1
    }
    if (!printed) {
      print "# BEGIN FROSTHALT"
      while ((getline line < L) > 0) print line
      close(L)
      print "# END FROSTHALT"
    }
  }
' /etc/hosts.fh.bak > /etc/hosts.new

mv /etc/hosts.new /etc/hosts
chown root:wheel /etc/hosts
chmod 644 /etc/hosts
dscacheutil -flushcache || true
killall -HUP mDNSResponder 2>/dev/null || true
"""
  }

  // MARK: - Privileged run (single osascript, off the main thread)

  private enum OsaResult {
    case success
    case adminDenied
    case failure(String)
  }

  /// Runs the single `osascript -e 'do shell script "echo <b64> | base64 -d |
  /// /bin/sh" with administrator privileges'`. The command string carries the
  /// STATIC body base64-encoded (no user content — only the LINES_FILE path);
  /// root decodes + runs it, never a user-writable file.
  ///
  /// Cancellation mapping (spec Design Notes): osascript cancel surfaces as an
  /// AppleScript error whose text ENDS with `(-128)` (userCanceledErr). We
  /// match that exact suffix (after trimming), not a loose substring, so a
  /// hard OS error that merely contains `(-128)` somewhere is not masked as
  /// admin-denied. Any other non-zero exit is a hard OS error -> `<detail>`
  /// (first non-empty stderr line).
  ///
  /// `base64 -d` is supported on macOS 10.15+ (the react-native-macos 0.81
  /// deployment floor). On older builds `-D` was the decode flag; if a future
  /// target drops below 10.15, switch to `base64 -D`.
  private static func runOsaScript(linesFilePath: String) -> OsaResult {
    let body = ShellRunner.privilegedBody(linesFilePath: linesFilePath)
    let base64 = Data(body.utf8).base64EncodedString()

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    let command = "do shell script \"echo '\(base64)' | base64 -d | /bin/sh\" with administrator privileges"
    proc.arguments = ["-e", command]

    let errPipe = Pipe()
    proc.standardError = errPipe
    // The static body writes nothing to stdout (awk's output is redirected to
    // /etc/hosts.new), so send stdout to /dev/null — no pipe to drain, no
    // buffer-deadlock, no leaked drain thread.
    proc.standardOutput = FileHandle(forWritingAtPath: "/dev/null")

    do {
      try proc.run()
    } catch {
      return .failure("osascript-launch-failed: \(error.localizedDescription)")
    }

    // Drain stderr concurrently. `do shell script` embeds the privileged
    // body's stderr into the AppleScript error text, which can be multi-line;
    // if it ever exceeded the pipe buffer, reading it only after
    // waitUntilExit would deadlock. The drain is armed AFTER `run()` succeeds
    // so a launch failure (which returns above) never strands a blocked
    // readDataToEndOfFile() thread. The body's stderr is small (a few lines
    // at most), so the brief window between run() and arming is safe.
    var stderrData = Data()
    let sem = DispatchSemaphore(value: 0)
    DispatchQueue.global().async {
      stderrData = errPipe.fileHandleForReading.readDataToEndOfFile()
      sem.signal()
    }
    proc.waitUntilExit()
    sem.wait()

    if proc.terminationStatus == 0 {
      return .success
    }

    let stderr = String(data: stderrData, encoding: .utf8) ?? ""

    // Exact admin-cancel match: AppleScript errors end with ` (-128)`. Match
    // that precise suffix (after trimming), not a bare `-128` substring.
    if stderr.trimmingCharacters(in: .whitespacesAndNewlines).hasSuffix("(-128)") {
      return .adminDenied
    }

    // Single-line, trimmed detail: take the first non-empty line so a
    // multi-line osascript error doesn't blob a status line / toast.
    let firstLine = stderr
      .split(separator: "\n", omittingEmptySubsequences: true)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first(where: { !$0.isEmpty })
      ?? ""
    return .failure(
      firstLine.isEmpty ? "osascript exited \(proc.terminationStatus)" : firstLine
    )
  }
}