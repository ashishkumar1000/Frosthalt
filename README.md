# Frosthalt

Frosthalt is a free, self-hosted website blocker for macOS — a personal
replacement for Cold Turkey. It blocks distracting sites (YouTube, Twitter,
Reddit, etc.) across **every browser** by managing the `/etc/hosts` file, with
no third-party app installation required.

Built with React Native for macOS because the target machine (a work
MacBook) doesn't allow installing third-party apps, but does allow running
your own code with `sudo` access.

## Why

- Cannot install third-party apps on the office laptop, so Cold Turkey and
  similar tools are out.
- Cold Turkey's useful features are paid anyway.
- Full admin (`sudo`) access is available, so a hosts-file-based blocker
  works without installing anything.

See [`Frosthalt-PRD.md`](./Frosthalt-PRD.md) for the full product
requirements, feature roadmap, and design decisions.

## Core features (v1)

- **Blocklist** — add/remove domains, mark them always-on, apply to
  `/etc/hosts` in one batched admin-password prompt.
- **Focus timer** — block a set of domains for a chosen duration; auto-unblock
  on expiry.
- **Schedule** — block domains automatically during a recurring day/time
  window (e.g. weekdays 9–5).
- **Password gate** — a password protects against impulsively disabling
  blocks or removing them mid-session.
- **Status header** — always-visible view of what's blocked and any active
  timer countdown.

## How it works

Frosthalt writes a marked `# BEGIN/END FROSTHALT` section into `/etc/hosts`,
mapping blocked domains (apex + `www.`) to `127.0.0.1` / `::1` on both IPv4
and IPv6, then flushes the DNS cache. Because this happens at the hosts-file
level, blocking applies system-wide with no per-browser setup. Edits run
through macOS's native `osascript … with administrator privileges` prompt —
there's no background daemon and no elevated process running all the time.

This means blocking is limited to named domains and subdomains you add
explicitly (no wildcards), and it's a self-discipline tool, not tamper-proof
parental control — a determined admin user can always edit `/etc/hosts`
directly. See the PRD's Risks & Mitigations section for the full list of
trade-offs.

## Tech stack

- React Native for macOS (`react-native-macos`), Hermes JS engine
- A small Swift native module (`ShellRunner`) for privileged shell access
- Local JSON config at `~/Library/Application Support/Frosthalt/config.json`
  — no network calls, fully offline

## Getting started

> **Note**: Make sure you have completed the [Set Up Your Environment](https://reactnative.dev/docs/set-up-your-environment) guide before proceeding.

### Step 1: Start Metro

Run the Metro dev server from the root of the project:

```sh
npm start
```

### Step 2: Install CocoaPods dependencies

The macOS target needs its CocoaPods dependencies installed (first clone,
or after updating native deps). The macOS Podfile lives in the `macos/`
folder:

```sh
bundle install
bundle exec pod install --project-directory=macos
```

### Step 3: Build and run the macOS app

With Metro still running from Step 1:

```sh
npx react-native run-macos
```

The first run may take a while since it builds the entire project and all
dependencies.

Alternatively, open the workspace directly in Xcode and run it from there:

```sh
xed -b macos
```

Or build without launching:

```sh
npx react-native build-macos
```

> **Note**: Keep the `react-native` and `react-native-macos` versions on the
> same minor version to avoid compatibility issues. See the
> [react-native-macos Getting Started guide](https://microsoft.github.io/react-native-macos/docs/getting-started)
> for details.

### Step 4: Modify the app

Open `App.tsx` in your editor and make changes — Fast Refresh updates the
running app automatically.

To forcefully reload and reset app state, select **"Reload"** from the Dev
Menu, accessed via <kbd>Cmd ⌘</kbd> + <kbd>D</kbd> in the app window.

## Troubleshooting

If you're having issues getting the above steps to work, see the React
Native [Troubleshooting](https://reactnative.dev/docs/troubleshooting) page.
