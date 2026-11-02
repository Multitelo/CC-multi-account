<div align="center">

# CC-multi-account

### Never hit a Claude Code limit mid-task again.

`ccm` runs Claude Code across all your Claude subscriptions and moves your session to
another account **the moment one runs low**: same conversation, no restart, no re-login.

[![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?logo=windows&logoColor=white)](#install)
[![macOS](https://img.shields.io/badge/macOS-supported-000000?logo=apple&logoColor=white)](#install)
[![Linux](https://img.shields.io/badge/Linux-supported-FCC624?logo=linux&logoColor=black)](#install)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<img src="docs/dashboard.svg" alt="The ccm dashboard: usage bars for three accounts, one about to run out, with ccm already on the next" width="100%">

</div>

---

## You know the feeling

You're deep in a refactor. Claude Code is mid-edit. Then:

> *You've reached your usage limit. Resets at 6:20 PM.*

You switch accounts by hand, start a new session, and re-explain everything.
Or you use an account switcher, and every few hours it asks you to **log in again**.

**`ccm` fixes both.**

## What you get

🔄 **Switches mid-session, automatically.** When an account reaches your
threshold, the next message goes to the account with the most room left.
Your conversation carries on as if nothing happened.

🛟 **Catches the limit you didn't see coming.** If Anthropic refuses a message
because the account just ran out, ccm resends **that same message** on another
account. Claude Code never sees the error.

📈 **Switches before you run out.** ccm watches how fast you're burning
through the 5-hour window. If at this pace you'd hit the wall within 15
minutes, it moves you now.

🔐 **Never logs you out.** Each account is signed in once, just for ccm, and
only ccm refreshes it. No other tool can invalidate it. Logins are encrypted
at rest (Windows DPAPI, the macOS Keychain, or a private key file on Linux).

⏱️ **Gets your next 5-hour window started sooner.** The window only starts
counting at your first message. ccm starts a new one the second the last one
ends, so it resets hours earlier. Or stagger them across accounts so one is
always nearly fresh.

📌 **Pin a project to an account.** Client work on the work account, side
projects on your own: per folder, automatically.

🖥️ **A dashboard that shows everything.** Usage bars, reset times, burn
rate, switch history, daily peaks, Anthropic's live status. One command: `ccm`.

🧩 **Nothing else changes.** Your skills, plugins, MCP servers, hooks, memory
and history work exactly as before. VS Code and the terminal both work.
The Claude Desktop app keeps its own login, untouched.

💻 **Windows, macOS and Linux.** Starts with your computer, sends desktop
notifications, and restarts itself if it ever crashes.

🪶 **Tiny.** Plain Node.js, zero dependencies.

## Quick start

```bash
git clone https://github.com/Multitelo/CC-multi-account.git
cd CC-multi-account
npm install -g .
```

```bash
ccm             # open the dashboard, press n to add each account
ccm install     # connect VS Code, the status line and start-at-login
```

Reload VS Code (*Developer: Reload Window*) and you're done. In a terminal,
use `ccm start` instead of `claude`.

> **Windows shortcut:** on Windows you can also type `cc` instead of `ccm`
> (`cc`, `cc start`, `cc status`, ...). It isn't added on macOS or Linux,
> where `cc` is the C compiler.

> When you add an account, a browser window opens. **Check it shows the
> account you mean before you approve.** If it picks the wrong one, use a
> private window. On a machine without a browser (SSH, a server), use
> `ccm login <name> --manual`: you get a link to open on any device and paste
> the code back.

## See it

<details open>
<summary><b>History</b>: every switch, and why</summary>
<br>
<img src="docs/history.svg" alt="History tab: switches with their reasons, window starts, and highest usage per day for each account" width="100%">
</details>

<details>
<summary><b>Settings</b>: tune it from the dashboard</summary>
<br>
<img src="docs/settings.svg" alt="Settings tab: auto-switch, thresholds, window start and staggering, early switching, notifications" width="100%">
</details>

And in every terminal session, the status line:

```
ccm backup | 5h 31% | wk 24%
```

## Why other switchers log you out (and this doesn't)

A Claude login carries a refresh token that **works only once**: every refresh
replaces it. Most switchers work by copying login files in and out of
`~/.claude`. Then the switcher and Claude Code both refresh the same login,
and whichever goes second is left holding a dead token. You're logged out.

`ccm` takes a different route. Claude Code talks to a small relay on your own
machine, and the relay attaches the right account to each request:

```
 Claude Code  (VS Code, or `ccm start` in a terminal)
      │   ANTHROPIC_BASE_URL = http://127.0.0.1:47821
      ▼
 ccm relay  ── local only; owns each account's login; picks the account per request
      │
      ▼
 api.anthropic.com
```

| | File-swapping switchers | **ccm** |
|---|:---:|:---:|
| Switch in the middle of a session | ⚠️ on the next refresh, sometimes | ✅ on the next message |
| Retry the message that hit the limit | ❌ | ✅ |
| Switch early based on burn rate | rare | ✅ |
| Random "please log in again" | ⚠️ common | ✅ no: logins aren't shared |
| Leaves the Desktop app's login alone | ❌ | ✅ |
| Starts 5-hour windows early / staggered | some | ✅ |
| Per-folder account pins | rare | ✅ |
| Logins encrypted at rest | varies | ✅ |

## Install

**Requirements:** [Node.js](https://nodejs.org) 18+,
[Claude Code](https://docs.claude.com/en/docs/claude-code) installed (`claude`
works in a terminal), and two or more Claude accounts with Claude Code access
(Pro, Max, Team or Enterprise).

```bash
git clone https://github.com/Multitelo/CC-multi-account.git
cd CC-multi-account
npm install -g .
```

Then open the dashboard with `ccm`, press **n** to add each account, and run
`ccm install`.

| | Windows | macOS | Linux |
|---|---|---|---|
| Command | `ccm` (shortcut: `cc`) | `ccm` | `ccm` |
| Logins encrypted with | DPAPI (your Windows user) | AES-256-GCM, key in your login Keychain | AES-256-GCM, key in `~/.cc/master.key` (mode 600) |
| Starts with your computer | Startup folder | LaunchAgent | systemd user service (or XDG autostart) |
| Notifications | Windows toasts | Notification Center | `notify-send` (libnotify) |
| VS Code settings | `%APPDATA%\Code\User` | `~/Library/Application Support/Code/User` | `~/.config/Code/User` |
| Status | used daily | covered by automated tests; sign-in verified; reports welcome | covered by automated tests; sign-in verified; reports welcome |

> **Please read.** This project is not affiliated with Anthropic. Using several
> personal subscriptions to get past usage limits may not be allowed under
> Anthropic's consumer terms. Check them and decide for yourself before
> relying on it.

---

## Reference

Paths are shown as `~/.cc`, which is `%USERPROFILE%\.cc` on Windows.

### The dashboard

Run `ccm`.

| Tab | Shows | Keys |
|---|---|---|
| overview | 5-hour and weekly usage, reset times, burn rate and state per account; the switching order | **enter** switch to it · **n** add account · **l** sign in again · **x** remove · **shift+↑↓** reorder · **p** pin the current folder |
| history | switches, limits, sign-ins, window starts; highest usage per day | |
| pins | pinned folders | **p** pin a folder · **d** unpin |
| settings | auto-switch, thresholds, window start and staggering, early switching, notifications, check interval | **enter** toggle · **- / +** change |
| status | Anthropic's live status (status.claude.com) and open incidents | |

Everywhere: **←→** tabs, **a** auto-switch on/off, **r** re-check usage,
**c** start Claude Code here, **q** quit.

### Commands

| Command | What it does |
|---|---|
| `ccm` | Open the dashboard |
| `ccm start [claude args]` | Start Claude Code through ccm; any `claude` flag works (`ccm start --resume`, or directly `ccm --resume`) |
| `ccm start --account backup` | One session on one account only |
| `ccm login <name> [--manual]` | Sign an account in (or in again); `--manual` for machines without a browser |
| `ccm remove <name> --yes` | Forget an account |
| `ccm status [--refresh]` | Usage and state of every account |
| `ccm use <name>` | Switch now |
| `ccm auto on\|off` | Automatic switching |
| `ccm threshold <5h> [week]` | When to switch, in percent (`ccm threshold 90 97`) |
| `ccm order <a> <b> ...` | Priority order |
| `ccm pin [account] [folder]` | Always use one account in a folder |
| `ccm unpin [folder]` / `ccm pins` | Remove a pin / list pins |
| `ccm log [-n 50]` / `ccm log --usage` | Switch history / highest usage per day |
| `ccm notify on\|off` | Desktop notifications |
| `ccm doctor` | Check everything |
| `ccm install` / `ccm uninstall` | Connect to or disconnect from VS Code, the status line and start-at-login |
| `ccm serve` / `ccm stop` / `ccm restart` | Control the relay |

On Windows, every command also works with `cc` in place of `ccm`.

### How switching decides

On every request, the active account counts as **low** if:

1. its 5-hour usage ≥ the 5-hour threshold, or weekly usage ≥ the weekly threshold, or
2. at the pace of the last 30 minutes it would hit 100% within the early-switch
   time (15 min), before its window resets.

When it's low, ccm moves to the account with the most room left, notifies you
and logs why. If every account is low, ccm keeps going on whatever still works.
If a request is refused for the limit, it's retried on each other account
before the error reaches Claude Code. Pinned folders and `--account` sessions
never switch.

Usage comes from the rate-limit headers on every response (live) and from
Anthropic's usage endpoint, checked every 3 minutes for every account.

### Settings

In the dashboard's settings tab, or `~/.cc/config.json` (picked up within 30 seconds).

| Key | Default | Meaning |
|---|---|---|
| `auto` | `true` | Switch automatically |
| `threshold5h` | `95` | Switch at this 5-hour usage % |
| `threshold7d` | `98` | Switch at this weekly usage % |
| `burnAware` | `true` | Switch early when usage is rising fast |
| `burnMinutes` | `15` | ...if at the current pace the limit is this many minutes away |
| `startWindow` | `true` | Start a new 5-hour window as soon as the last one ends |
| `staggerWindows` | `false` | Space accounts' windows 5h ÷ accounts apart instead |
| `notify` | `true` | Desktop notifications |
| `pollSeconds` | `180` | How often to check every account's usage |
| `port` | `47821` | Relay port on 127.0.0.1 |

### Good to know

- **VS Code needs the relay running.** It starts with your computer and restarts
  itself if it crashes. `ccm doctor` tells you if it's down. In a terminal,
  `ccm start` starts it on demand and falls back to your normal login if it can't.
- **"Total cost" in the VS Code panel is only an estimate.** Claude Code shows it
  because it was started with a key instead of a claude.ai login. Nothing is
  charged: requests use your subscription logins.
- **claude.ai connectors are off in ccm sessions**, because the login comes from ccm.
  Local MCP servers still work.
- **After a switch, the conversation continues on the other account.** Only mix
  accounts whose data you're allowed to share.
- **Window starts need the computer awake.** If it's asleep when a window ends,
  the next one starts when it wakes.

### Security

- The relay listens on **127.0.0.1 only** and requires a random local key.
- Logins live in `~/.cc/accounts/*.dat`, encrypted (see the table under
  [Install](#install)), and are sent only to Anthropic (`api.anthropic.com`,
  `platform.claude.com`). The only other host contacted is `status.claude.com`.
- Sign-in uses the same OAuth flow (PKCE) and client as Claude Code. On
  Windows, Claude Code itself performs the sign-in and ccm deletes the temporary
  plain-text copy right after encrypting it.
- `ccm install` backs up every settings file it changes to `~/.cc/backups/`.
- The local key in VS Code's settings only unlocks the relay on 127.0.0.1. It isn't
  an Anthropic credential.

### Files

| Path | Contents |
|---|---|
| `~/.cc/config.json` | Settings, pins, account emails (no logins) |
| `~/.cc/accounts/*.dat` | Encrypted logins |
| `~/.cc/state.json` | Live usage (used by the status line) |
| `~/.cc/history.jsonl` | Switch and usage history |
| `~/.cc/relay.log` | Relay log (`CC_DEBUG=1` logs every request) |

### Troubleshooting

| Problem | Fix |
|---|---|
| VS Code Claude can't connect | `ccm doctor`, then `ccm restart` |
| An account shows "login broken" | Select it in the dashboard and press **l**, or `ccm login <name>` |
| The browser signs in the wrong account | Cancel, use a private window signed into the right account, try again |
| No browser on this machine | `ccm login <name> --manual` |
| `ccm` not found after installing | Open a new terminal; check that npm's global folder (`npm prefix -g`) is on your PATH |
| No notifications on Linux | Install libnotify (`notify-send`), e.g. `sudo apt install libnotify-bin` |
| Usage numbers look stale | Press **r** in the dashboard, or `ccm status --refresh` |
| Anything else | `~/.cc/relay.log` |

### Uninstall

```bash
ccm uninstall     # disconnect VS Code, status line, start-at-login
ccm stop          # stop the relay
npm uninstall -g cc-multi-account
rm -rf ~/.cc      # deletes saved logins and history
                  # (Windows PowerShell: Remove-Item -Recurse "$env:USERPROFILE\.cc")
```

On macOS, ccm also keeps its encryption key in the Keychain under
`cc-multi-account`; delete it in Keychain Access if you want it gone.

## Contributing

Issues and pull requests are welcome. Reports from macOS and Linux are
especially useful.

```bash
npm test
```

The tests run the relay against a fake Anthropic server in a throwaway folder,
and run the macOS and Linux code paths on any OS. They never touch your real
accounts.

| File | Role |
|---|---|
| `cc.js` | Command line and launcher |
| `lib/relay.js` | Relay: choosing accounts, forwarding, refresh, retries, window starts, burn rate |
| `lib/tui.js` | Dashboard |
| `lib/platform.js` | What differs per OS: paths, notifications, start-at-login |
| `lib/vault.js` | Encryption of saved logins (DPAPI / Keychain / key file) |
| `lib/signin.js` | Browser sign-in (OAuth with PKCE) |
| `lib/anthropic.js` | Token refresh, usage, profile, 1-token message |
| `lib/store.js` | Config, state, saved logins |
| `lib/install.js` | VS Code, status line, start-at-login, terminal shim |
| `lib/sessions.js` | Folder pins (session → project folder) |
| `lib/history.js` | History and log |

## License

[MIT](LICENSE). If ccm saves you from a limit, a ⭐ helps others find it.
