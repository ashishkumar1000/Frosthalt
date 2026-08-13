# Frosthalt — Product Requirements Document

| | |
|---|---|
| **Product name** | Frosthalt |
| **Document version** | 1.1 |
| **Date** | 13 August 2026 |
| **Status** | Name frozen — Frosthalt |
| **Owner** | Developer (self-built, single user) |
| **Platform** | macOS (native, React Native for macOS) |

---

## 1. Overview

Frosthalt is a free, self-hosted productivity application for macOS that blocks distracting websites so the user can focus. It is a personal replacement for Cold Turkey (`getcoldturkey.com`), built to work around two constraints on the user's office MacBook: third-party applications cannot be installed (policy), and paid tools are not an option.

Instead of installing software, Frosthalt runs the user's own code. It blocks websites at the system level by managing the `/etc/hosts` file, which means blocking works across **every browser** with no per-browser setup. The user has full admin (`sudo`) access on the machine, which makes this approach possible.

---

## 2. Problem statement

The user gets distracted by websites (YouTube, Twitter, Reddit, etc.) during work. They want a blocking tool like Cold Turkey, but:

1. **Cannot install third-party apps** on the office laptop — rules out Cold Turkey and any normal installer.
2. **Cold Turkey's useful features are paid** — the free tier is limited.
3. **Is a developer** — can write and run their own code on the machine, and has admin access.

The gap: there is no acceptable off-the-shelf tool. The user is willing to build one themselves, in their existing skill set (React Native), as long as it requires no third-party installation.

---

## 3. Goals & non-goals

### Goals
- Block specified websites across all browsers on macOS, with zero third-party installation.
- Provide the core Cold Turkey workflows: a permanent blocklist, a focus timer, and a time-based schedule.
- Make casual bypass annoying (password gate) so the tool actually helps discipline.
- Be buildable and runnable by one developer in React Native for macOS, using only their own code + a well-known sudo mechanism.
- Keep the user's existing `/etc/hosts` entries safe (only manage a marked section).

### Non-goals (for v1)
- Blocking desktop applications (Slack, games, etc.) — not just websites.
- A hardened, tamper-proof parental-control system. A determined admin user can always edit `/etc/hosts`.
- Cross-platform support (Windows/Linux).
- An app store release, code signing, or an installer.
- Cloud sync, accounts, or multi-device.
- Wildcard / subdomain DNS blocking (e.g. `*.youtube.com`).

---

## 4. Target users

**Primary (and only) user:** the developer themselves.
- Technical, has admin access, comfortable with the terminal and `/etc/hosts`.
- Uses macOS daily for work; distractions are browser-based.
- Wants something they control and can modify, not a black-box paid product.

No other personas are considered for v1.

---

## 5. User stories

1. **As the user**, I want to add a website (e.g. `youtube.com`) to a blocklist so it stops loading in every browser.
2. **As the user**, I want to remove a site from the blocklist when I no longer need it blocked.
3. **As the user**, I want to start a focus session ("block these sites for 25 minutes") that automatically unblocks them when the timer ends.
4. **As the user**, I want a daily schedule ("block Twitter 9:00–17:00 on weekdays") so blocking is automatic during work hours.
5. **As the user**, I want to set a password so I cannot easily disable blocking mid-session out of impulse.
6. **As the user**, I want to see at a glance which sites are currently blocked and how long a focus session has left.
7. **As the user**, I want a panic button to remove all blocks (password-gated) for emergencies.

---

## 6. Functional requirements

### 6.1 Blocklist management
- **FR-1:** Add a domain by typing it; the app validates the format and normalises it (strip `https://`, `www.`, paths; lowercase).
- **FR-2:** Each entry blocks the apex domain and the `www.` subdomain, on both IPv4 (`127.0.0.1`) and IPv6 (`::1`).
- **FR-3:** Each domain can be marked **always-on** (persistently blocked) or used only via timer/schedule.
- **FR-4:** Remove a domain from the list.
- **FR-5:** An **Apply** button writes the current effective blocklist to `/etc/hosts` (one admin password prompt per apply).

### 6.2 Focus timer
- **FR-6:** Start a focus session for a chosen duration (presets: 25/45/60 min, plus custom) over a chosen set of domains.
- **FR-7:** While the timer is active, those domains are blocked; the UI shows a live countdown.
- **FR-8:** When the timer expires (app open), the domains are automatically unblocked — unless they are also always-on.
- **FR-9:** "End early" is allowed but requires the password.
- **FR-10:** If the app is closed mid-session, the blocks remain in `/etc/hosts` (anti-cheat); they are cleared on the next app launch once the timer has expired.

### 6.3 Schedule
- **FR-11:** Create a named schedule: choose domains, days of week, start time, end time, and an enable/disable toggle.
- **FR-12:** While a schedule window is active (and enabled), its domains are blocked; outside the window they are not.
- **FR-13:** Schedule transitions (start/end) take effect while the app is running. (Limitation: see §10.)

### 6.4 Security / anti-bypass
- **FR-14:** The user can set a password (stored as a salt-free SHA-256 hash — sufficient for a self-discipline tool).
- **FR-15:** Once a password is set, any change to settings or removal of blocks requires the password.
- **FR-16:** A **Panic** action removes all blocks immediately (password-gated).

### 6.5 Status & transparency
- **FR-17:** A persistent status header shows: number of blocked domains, active timer countdown, and a Blocked/Free badge.
- **FR-18:** Settings screen can display the current managed section of `/etc/hosts` so the user can see exactly what is blocked.

---

## 7. Non-functional requirements

- **NFR-1 — No third-party install:** the app is loaded/run as the user's own code; no installer, no app store, no admin-gated setup beyond the per-change password prompt.
- **NFR-2 — System-wide blocking:** works across all browsers because it operates on `/etc/hosts`, not a browser extension.
- **NFR-3 — Safety of hosts file:** only a marked `# BEGIN/END FROSTHALT` section is managed; the existing hosts content is preserved; a backup (`/etc/hosts.fh.bak`) is taken before every change.
- **NFR-4 — Privilege model:** edits to `/etc/hosts` run as root via macOS's native `osascript … with administrator privileges` prompt. No always-on background daemon.
- **NFR-5 — Injection safety:** any variable content placed into the privileged shell script (domain names) is validated against a strict regex and inserted via a quoted heredoc.
- **NFR-6 — Tech stack:** React Native for macOS (`react-native-macos` 0.81.x line), Hermes JS engine, one small Swift native module for shell access. No Node built-ins available at runtime.
- **NFR-7 — Data storage:** a single JSON config at `~/Library/Application Support/Frosthalt/config.json`, user-owned.
- **NFR-8 — Performance:** UI stays responsive; shell/privileged operations run off the main thread. Apply operations are batched behind one button to minimise password prompts.
- **NFR-9 — Offline only:** no network calls; fully local.

---

## 8. User experience

### 8.1 Main layout
A single window with a top tab bar: **Blocklist · Timer · Schedule · Settings**. A status header sits above the tabs and is always visible.

### 8.2 Key flows
- **Block a site forever:** Blocklist tab → Add domain → confirm → toggle always-on → **Apply** → enter Mac password (once) → site is blocked in all browsers.
- **Focus session:** Timer tab → pick duration → pick domains → **Start focus** → countdown begins, sites blocked → (auto-unblock on expiry, or End early with password).
- **Work-hours schedule:** Schedule tab → new schedule → name it, pick domains, Mon–Fri, 09:00–17:00 → enable → while the app is running, sites auto-block in that window.
- **Emergency unblock:** Settings tab → **Panic: remove all blocks** → enter password → all blocks removed.

### 8.3 What the user sees when blocked
The browser shows its native "can't connect / connection refused" page. Frosthalt does not render a custom blocked page (no browser extension involved).

---

## 9. Technical overview (high level)

> Detailed implementation lives in the engineering plan; this is the PRD-level summary.

- **Blocking mechanism:** managed section of `/etc/hosts` mapping blocked domains to `127.0.0.1` / `::1`; DNS cache flushed after each change (`dscacheutil -flushcache`, `killall -HUP mDNSResponder`).
- **Privilege escalation:** a Swift `ShellRunner` native module runs `osascript -e 'do shell script "…" with administrator privileges'`. The macOS native admin dialog appears once per apply.
- **State:** `config.json` holds the blocklist, schedules, timer state, and password hash. An "effective blocklist" is computed as `always-on ∪ active-timer ∪ active-schedule` and written to hosts on changes.
- **Persistence behaviour:** hosts entries survive app quit; the app recomputes the effective set on launch to clear expired timer/schedule blocks.

---

## 10. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Schedule unblocking only works while the app is running | Blocks may stay past a schedule end if app is closed | On launch, recompute and clear expired blocks. Document the limitation. Future: a `launchd` agent. |
| User can bypass by editing `/etc/hosts` with sudo | Defeats blocking | Accepted for v1 — this is a self-discipline tool, not parental control. Password gate stops casual bypass only. |
| Admin password prompt on every Apply | Annoying friction | Batch all changes behind one Apply button. Future: a privileged helper daemon to remove repeated prompts. |
| Only `www.` + apex blocked, not subdomains | `m.youtube.com` etc. still load | User adds needed subdomains manually. Wildcard blocking is out of scope (would need a real DNS resolver). |
| Desktop apps not blocked | Slack/Discord still work if distraction | Out of scope for v1; browser focus only. |
| Corrupting `/etc/hosts` could break DNS | High | Always back up to `/etc/hosts.fh.bak` first; only manage the marked section; preserve ownership `root:wheel` and mode `644`. |
| React Native for macOS native-module/codegen friction | Build delays | Have an Obj-C++ fallback for the native module; run `pod install` if codegen doesn't pick up the spec. |

---

## 11. Out of scope / future

- Desktop app blocking.
- Wildcard / full subdomain blocking (requires a local DNS resolver or network extension).
- A `launchd`/`SMJobBless` helper daemon for schedule transitions and password-prompt-free applies.
- Menu-bar-only background mode.
- Code signing, notarisation, and an installer for distribution.
- Cross-platform (Windows/Linux) and cloud sync.
- A custom "blocked" landing page (needs a browser extension or proxy).

---

## 12. Phase 1 — MVP milestones

The first release delivers the core blocking loop (the functional requirements in §6). Later, researched features are organised into phases in §13.

| Milestone | Scope |
|---|---|
| **M1 — Project scaffold** | RN macOS project created, runs an empty window. |
| **M2 — Native shell module** | `ShellRunner` can run a command and a privileged script from JS. |
| **M3 — Core blocking** | Add/remove domains, Apply writes the managed `/etc/hosts` section, DNS flush, verified in a browser. |
| **M4 — Config & password** | Persistent config, password gate on mutations. |
| **M5 — Focus timer** | Start/countdown/auto-unblock, end-early with password. |
| **M6 — Schedule** | Create/edit/enable schedules, live transitions while app open. |
| **M7 — Status & polish** | Status header, settings transparency, panic button, final verification. |

---

## 13. Feature roadmap (researched, phased)

Based on research into comparable apps — **Cold Turkey**, **Freedom**, **FocusMe**, **DigitalZen**, and **Digital Carrot** — the features below are grouped into phases. Each is tagged with its **feasibility under the v1 `/etc/hosts` + sudo architecture**:

- ✅ Feasible with the current hosts-file approach
- 🟡 Feasible but needs extra sudo-based machinery (process monitor, firewall, or `launchd`)
- 🔴 Needs a new architecture (local DNS resolver or HTTP proxy) — deferred to a future major rework

### Phase 2 — Pomodoro & enforcement
| Feature | Feas. | Notes |
|---|---|---|
| Pomodoro mode (work/break intervals) | ✅ | Break windows temporarily unblock the session's domains |
| Break system inside a long session | ✅ | Configurable short / long breaks |
| Locked mode (cannot end a session early) | ✅ | A running timer cannot be stopped; only a harsh challenge unlocks it |
| Random password / challenge text | ✅ | App generates a long random string the user never sees, used as the unlock password |
| Streaks & focus-time stats | ✅ | Consecutive sessions + total focus time (no site-attempt tracking) |

### Phase 3 — Lists, UX & persistence
| Feature | Feas. | Notes |
|---|---|---|
| Named blocklists / groups (Social, News, Deep Work) | ✅ | Group domains; start sessions against a whole group |
| Built-in category import lists | ✅ | Curated lists for social, news, video, etc. |
| Import / export config | ✅ | Backup and replicate across machines |
| Menu-bar background app | 🟡 | Run as an `NSStatusItem`; keeps schedules alive with no window |
| Launch at login (`launchd`) | 🟡 | Schedule transitions work even when the app window is closed |
| Focus sounds (ambient audio) | ✅ | Low-value but cheap; played inside the app |

### Phase 4 — Advanced enforcement
| Feature | Feas. | Notes |
|---|---|---|
| Daily allowance per group | 🟡 | Feasible as an *allowed-time window*; true usage-time measurement needs a proxy (Phase 5) |
| Pause / cooldown limits | ✅ | Cap the number and length of pauses per day |
| Accountability-partner mode | ✅ | A friend sets/holds the password; or a remote unlock code |
| App blocking (desktop apps) | 🟡 | Via `socketfilterfw` network blocking or a process-killer monitor — needs sudo |
| Frozen mode (lock screen / shutdown on schedule) | 🟡 | Aggressive; uses `pmset` / shutdown via sudo |

### Phase 5 — Beyond hosts (new architecture: local DNS resolver or HTTP proxy)
| Feature | Feas. | Notes |
|---|---|---|
| Wildcard / full subdomain blocking (`*.youtube.com`) | 🔴 | `/etc/hosts` has no wildcards |
| Allowlist / allow-only mode (block everything except X) | 🔴 | Needs to intercept *all* DNS, not just listed domains |
| Block the entire internet | 🔴 | Same — needs a proxy/resolver |
| Site-attempt tracking & rich analytics | 🔴 | A proxy can log which blocked sites were attempted |
| True usage-time tracking (for real daily allowances) | 🔴 | Requires seeing traffic, not just failing DNS |

**Phase 5 is a major architectural shift.** The hosts-file approach is simple and robust but can only block *named* domains. Features that need to intercept *all* traffic (allowlist mode, whole-internet block, usage tracking) mean running a local DNS resolver (e.g. `dnsmasq`) or an HTTP/HTTPS proxy on `127.0.0.1`, set as the system DNS/proxy. That is a separate project — only undertake it if those features become essential.

**Research sources:** [Cold Turkey guide](https://productivitystack.io/guides/cold-turkey-blocker-guide/) · [Cold Turkey review](https://productivitystack.io/tools/cold-turkey/) · [Cold Turkey vs FocusMe](https://www.chronoid.app/blog/cold-turkey-vs-focusme) · [Freedom features](https://flow.freedom.to/features) · [FocusMe](https://focusme.com/website-blocker/) · [DigitalZen](https://www.digitalzen.app/windows-website-blocker-app-blocker/) · [Digital Carrot](https://www.digitalcarrot.app/features/) · [Pomodoro + blocker roundup](https://sipandscroll.app/blog/pomodoro-timer-blocker.html)

---

## 14. Open questions

1. Should adding *more* blocks (stricter) be exempt from the password, with only *removal* gated? (v1 currently gates all mutations once a password is set.)
2. Is a one-minute minimum on the focus timer acceptable, or do we need a "seconds" option for testing?
3. Should the app live in the menu bar (always-on background) for v1, or is a normal window enough? (PRD assumes a normal window; menu bar is Phase 3.)
4. Where exactly should the project be created on disk? (Default proposed: `~/projects/Frosthalt`.)
5. For Phase 4 app blocking — should we use the macOS application firewall (`socketfilterfw`) or a background process-killer monitor? Both need sudo; they have different trade-offs.
6. Is Phase 5 (local DNS resolver / proxy) ever in scope, or should Frosthalt stay hosts-only forever? This decides whether allowlist mode and usage tracking are ever built.