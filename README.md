# CC-multi-account (`cc`)

Use Claude Code with several Claude subscriptions on Windows. When one
account runs low, `cc` switches to another **in the middle of a session**,
without a restart and without logging anything out.

```
 ▞▚ cc  ● relay running                                  ● All Systems Operational  v1.0.0
 2 accounts  auto-switch on · at 5h 88% / week 93%                            using main
 overview   history   pins   settings   status
╭─ ACCOUNTS ──────────────────────────────────────────────────────────────────────────────╮
│   account  plan  5-hour                       week                         state        │
│ ❯●main     pro   [████░░░░░░░░]  34% 2h 53m   [████████░░░░]  70% 1d 14h   active       │
│   backup   pro   [█████░░░░░░░]  45% 3h 3m    [███░░░░░░░░░]  22% 14h 33m  ready        │
╰─────────────────────────────────────────────────────────────────────────────────────────╯
```

> **Not affiliated with Anthropic.** This is a personal tool. Using several
> personal subscriptions to get past usage limits may not be allowed under
> Anthropic's consumer terms. Read them and decide for yourself before
> relying on it.

## Why

Tools that switch Claude Code accounts by swapping the login file in
`~\.claude` keep logging you out. A Claude login has a refresh token that
**works only once**: each refresh replaces it. When the switching tool and
Claude Code both refresh the same login, whichever goes second is holding a
dead token, and you're asked to log in again.

`cc` never shares a login with anything else, so that can't happen.

## How it works

```
 Claude Code (terminal via `cc start`, or the VS Code extension)
        │   ANTHROPIC_BASE_URL = http://127.0.0.1:47821
        ▼
   cc relay  (local only, 127.0.0.1)
        │   picks an account, puts that account's login on the request
        ▼
   api.anthropic.com
```

- Each account is signed in **once, for cc only**. Its login is encrypted with
  Windows DPAPI, so only your Windows user can read it.
- The relay is the **only** thing that refreshes those logins.
- The **Claude Desktop app is not touched**. It keeps whatever account it's
  signed into.
- Skills, plugins, MCP servers, hooks, memory and history still come from
  `~\.claude`. Only the account each request is billed to changes.

## Features

- **Automatic switching, mid-session.** Switches when the active account
  reaches your 5-hour or weekly threshold (default 95% / 98%). The next request
  goes to the account with the most room left.
- **Retry on the limit.** If Anthropic refuses a request because the account
  hit its limit, the relay retries **that same request** on another account,
  so the session doesn't stop.
- **Switching early on fast usage.** If the current pace would hit the 5-hour
  limit within 15 minutes, cc switches now.
- **Starts the 5-hour window early.** A 5-hour window only starts counting at
  an account's first message. When an account has no window running, cc sends
  it a 1-token message so a new window starts immediately and resets sooner.
  Optionally, windows can be **staggered** across accounts (5h ÷ accounts
  apart) so one account is always close to a fresh window.
- **Folder pins.** Always use one account in a folder (and its subfolders).
- **Dashboard.** Usage bars, reset times, switch history, daily usage peaks,
  pins, settings, and Anthropic's live status.
- **Windows notifications** when it switches or a login breaks.
- **Status line** in terminal sessions: `cc main | 5h 34% | wk 70%`.
- **Starts at Windows sign-in** and restarts itself if it crashes.
- **No dependencies.** Plain Node.js.

## Requirements

- Windows 10 or 11
- [Node.js](https://nodejs.org) 18 or newer
- [Claude Code](https://docs.claude.com/en/docs/claude-code) installed (`claude` works in a terminal)
- Two or more Claude accounts with Claude Code access (Pro, Max, Team or Enterprise)

## Install

```powershell
git clone https://github.com/Multitelo/CC-multi-account.git
cd CC-multi-account
npm install -g .
```

That gives you the `cc` command. (Without npm: run `node cc.js install shim`,
which puts `cc` in `%USERPROFILE%\.local\bin`; that folder must be on your PATH.)

## Set up

1. **Open the dashboard and add your accounts.**

   ```powershell
   cc
   ```

   Press **n**, type a name (for example `main`), and press Enter. A browser
   window opens. **Check that it shows the account you want for this name
   before you approve.** If your browser picks the wrong account, use a private
   window. Repeat for each account (for example `backup`).

   Or from the command line: `cc login main`, `cc login backup`.

2. **Connect it to VS Code, the status line and Windows sign-in.**

   ```powershell
   cc install
   ```

   Then reload VS Code (Command Palette → *Developer: Reload Window*).

3. **Check.**

   ```powershell
   cc doctor
   ```

## Using it

- **VS Code:** after `cc install`, new Claude Code sessions in VS Code go
  through cc automatically.
- **Terminal:** run `cc start` instead of `claude`. All `claude` flags work
  (`cc start --resume`), and flags also work directly (`cc --resume`).
- **Dashboard:** run `cc`.

### The dashboard

| Tab | Shows | Keys |
|---|---|---|
| overview | each account's 5-hour and weekly usage, reset times, pace and state; the switching order | **enter** switch to the selected account · **n** add account · **l** sign in again · **x** remove · **shift+↑↓** reorder · **p** pin the current folder |
| history | switches, limits, sign-ins and window starts; highest usage per day | |
| pins | pinned folders | **p** pin a folder · **d** unpin |
| settings | auto-switch, thresholds, window start and staggering, early switching, notifications, check interval | **enter** toggle · **- / +** change |
| status | Anthropic's live status (status.claude.com) and open incidents | |

Everywhere: **←→** tabs, **a** auto-switch on/off, **r** re-check usage now,
**c** start Claude Code here, **q** quit.

### Commands

| Command | What it does |
|---|---|
| `cc` | Open the dashboard |
| `cc start [claude args]` | Start Claude Code through cc |
| `cc start --account backup` | One session on one account only |
| `cc login <name>` | Sign an account in (or in again) |
| `cc remove <name> --yes` | Forget an account |
| `cc status [--refresh]` | Usage and state of every account |
| `cc use <name>` | Switch now |
| `cc auto on\|off` | Automatic switching |
| `cc threshold <5h> [week]` | When to switch, in percent (for example `cc threshold 90 97`) |
| `cc order <a> <b> ...` | Priority order |
| `cc pin [account] [folder]` | Always use one account in a folder (defaults: the active account, the current folder) |
| `cc unpin [folder]` / `cc pins` | Remove a pin / list pins |
| `cc log [-n 50]` | Switch history |
| `cc log --usage` | Highest usage per day, per account |
| `cc notify on\|off` | Windows notifications |
| `cc doctor` | Check everything |
| `cc install` / `cc uninstall` | Connect to or disconnect from VS Code, the status line and sign-in |
| `cc serve` / `cc stop` / `cc restart` | Control the relay |

## How switching decides

On every request, for the active account:

1. If its 5-hour usage ≥ the 5-hour threshold, or weekly usage ≥ the weekly
   threshold, it's "low".
2. If usage over the last 30 minutes is rising fast enough to reach 100% within
   the early-switch time (15 minutes) and before the window resets, it's "low".
3. If it's low, cc moves to the account with the most room left, sends a
   notification, and logs why.
4. If every account is low, cc keeps going on whatever still works and lets
   Anthropic decide when the real limit is hit.
5. If a request is refused for the limit, it's retried once on each other
   account before the error goes back to Claude Code.

Pinned folders, and sessions started with `--account`, skip all of this.

Usage comes from two places: the rate-limit headers on every response (live),
and Anthropic's usage endpoint, checked every 3 minutes for every account.

## Settings

Change them in the dashboard's settings tab, or in `%USERPROFILE%\.cc\config.json`
(the relay picks up changes within 30 seconds).

| Key | Default | Meaning |
|---|---|---|
| `auto` | `true` | Switch automatically |
| `threshold5h` | `95` | Switch at this 5-hour usage % |
| `threshold7d` | `98` | Switch at this weekly usage % |
| `burnAware` | `true` | Switch early when usage is rising fast |
| `burnMinutes` | `15` | ...if at the current pace the limit is this many minutes away |
| `startWindow` | `true` | Start a new 5-hour window as soon as the last one ends |
| `staggerWindows` | `false` | Space accounts' windows 5h ÷ accounts apart instead |
| `notify` | `true` | Windows notifications |
| `pollSeconds` | `180` | How often to check every account's usage |
| `port` | `47821` | Relay port on 127.0.0.1 |
| `order` | | Account priority |
| `pins` | | Folder → account |

## Things to know

- **VS Code needs the relay running.** It starts at Windows sign-in and
  restarts itself if it crashes; `cc doctor` tells you if it's down. In the
  terminal, `cc start` starts it on demand and falls back to your normal login
  if it can't.
- **The VS Code panel shows a "Total cost".** That's Claude Code's estimate,
  shown because it was started with a key instead of a claude.ai login.
  Nothing is charged: requests use your subscription logins and count against
  plan usage, which `cc` and the status line show.
- **claude.ai connectors are off in cc sessions.** Claude Code shows "claude.ai
  connectors are disabled" because the login comes from cc. Local MCP servers
  still work.
- **After a switch, the rest of the conversation goes to the other account.**
  Only mix accounts whose data you're allowed to share.
- **Window starts need the PC awake.** If it's asleep when a window ends, the
  new window starts when it wakes.
- **The local key** in VS Code's settings (`ANTHROPIC_AUTH_TOKEN`) only
  unlocks the relay on 127.0.0.1. It isn't an Anthropic credential.

## Security

- The relay listens on **127.0.0.1 only** and requires a random local key.
- Logins are stored in `%USERPROFILE%\.cc\accounts\*.dat`, encrypted with
  Windows DPAPI (CurrentUser). They are sent only to Anthropic
  (`api.anthropic.com`, `platform.claude.com`).
- The only other host contacted is `status.claude.com` (public status page).
- During `cc login`, Claude Code writes a temporary plain-text copy of the
  login, which cc deletes right after encrypting it.
- `cc install` backs up every settings file it changes to
  `%USERPROFILE%\.cc\backups\`.

## Files

| Path | Contents |
|---|---|
| `%USERPROFILE%\.cc\config.json` | Settings, pins, account emails (no logins) |
| `%USERPROFILE%\.cc\accounts\*.dat` | Encrypted logins |
| `%USERPROFILE%\.cc\state.json` | Live usage (used by the status line) |
| `%USERPROFILE%\.cc\history.jsonl` | Switch and usage history |
| `%USERPROFILE%\.cc\relay.log` | Relay log (`CC_DEBUG=1` logs every request) |
| `%USERPROFILE%\.cc\backups\` | Settings files from before `cc install` changed them |

## Troubleshooting

| Problem | Fix |
|---|---|
| VS Code Claude says it can't connect | `cc doctor`, then `cc restart` |
| An account shows "login broken" | Select it in the dashboard and press **l**, or `cc login <name>` |
| The browser signs in the wrong account | Cancel, use a private window signed into the right account, and sign in again |
| Usage numbers look stale | Press **r** in the dashboard, or `cc status --refresh` |
| Something else | Look in `%USERPROFILE%\.cc\relay.log` |

## Uninstall

```powershell
cc uninstall      # disconnect VS Code, status line, start at sign-in
cc stop           # stop the relay
npm uninstall -g cc-multi-account
Remove-Item -Recurse "$env:USERPROFILE\.cc"   # deletes your saved logins and history
```

## Development

```powershell
npm test
```

The tests run the relay against a fake Anthropic server in a throwaway folder;
they never touch your real accounts or `%USERPROFILE%\.cc`.

| File | Role |
|---|---|
| `cc.js` | Command line and launcher |
| `lib/relay.js` | The relay: choosing accounts, forwarding, refresh, retries, window starts |
| `lib/tui.js` | Dashboard |
| `lib/anthropic.js` | Token refresh, usage, profile, 1-token message |
| `lib/store.js` | Config, state, DPAPI-encrypted logins |
| `lib/install.js` | VS Code, status line, sign-in start, terminal shim |
| `lib/sessions.js` | Folder pins (session → project folder) |
| `lib/history.js` | History and log |
| `lib/notify.js` | Windows notifications |

## License

[MIT](LICENSE)
