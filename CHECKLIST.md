# Trust checklist

What "solid-proof for other developers" actually means here. If you fork this and want to ship it inside your own org without losing sleep, every box below should stay checked.

## Code surface

- [x] Each piece is a single file you can read top-to-bottom in under twenty minutes (`plugin/index.js`, `agent/server.js`, `gate/server.js`, `overlay/overlay.js`).
- [x] The gate has **zero npm dependencies**. Only Node built-ins.
- [x] The agent has **one** dependency (`ws`). The plugin pulls in `@babel/parser` for TS scanning.
- [x] No telemetry, no analytics, no phone-home of any kind. Audit `grep -r 'fetch\(\|http\.request\|new WebSocket' .` and the only external host you'll find is `api.linear.app/graphql` (called by the gate server-side, never from the browser).

## Authentication & authorization

- [x] Admin password is scrypt-hashed with a random 16-byte salt, never stored in plain text after first change.
- [x] Default password is shown on the login page only while it remains the default.
- [x] First login forces a password change before any state is editable.
- [x] Password change requires the current password (except when changing from the default — by design).
- [x] Minimum 8-character new passwords. Confirm-password mismatch caught in the UI.
- [x] Login is rate-limited per-IP (5/min). Verified by sending 7 wrong attempts in a row and getting the expected `401 401 429 429 429 429 429`.
- [x] All admin endpoints are cookie-gated. Cookie is `HttpOnly; SameSite=Lax`. Add `Secure` once you serve the admin over HTTPS.
- [x] Testers sign in with **email + scrypt-hashed password** set by the gate admin. Passwords are never sent back to the client. Min 8 characters.
- [x] Tester user record is checked against the project's `users` dict on **every** report (instant revocation by deleting the user; not waiting for JWT expiry).
- [x] Unknown email, wrong password, locked-out account, missing-password (post-migration), and disabled project all return the same `invalid-credentials` error after the same ~300ms delay. Enumeration is impractical.
- [x] 5 wrong passwords for the same email triggers a 15-minute lockout. Correct password is rejected during the lockout window. Lockout clears on admin password reset.
- [x] Tester login (20/min per IP) and report-issue (20/min per IP) are independently rate-limited.

## Production safety

- [x] Edit + Dev TODO modes are physically not enabled in prod bundles. The overlay's mode palette filters by `enabledModes`, the agent WebSocket isn't attempted, the i18n-map fetch is skipped.
- [x] The plugin only runs when `process.env.NODE_ENV !== 'production'` (consumer-controlled in their build config).
- [x] The agent never opens a network port that's reachable from the public internet — it binds to localhost and is only invoked by the dev overlay.
- [x] The gate is the **only** piece that takes external requests in production. Its surface is six routes, all listed in this README.

## Secrets & data

- [x] Linear API keys live exclusively in the gate's `data.json` (on whichever machine the gate runs on). They are never sent to a browser. They are never logged.
- [x] `gate/data.json` is in `.gitignore`. If you accidentally `git add` it, the diff is small and obvious.
- [x] `GATE_JWT_SECRET` is the signing key for both admin sessions and tester JWTs. Rotating it instantly invalidates every active session — a useful "kick everyone" button. If unset at startup, a 32-byte random secret is generated per process (sessions don't survive restarts; fine for development).

## Edits are accurate, not approximate

- [x] The agent validates on-disk bytes match the expected `oldText` **before writing**. If the file moved out from under the rendered page, the edit is rejected with `out-of-sync` rather than silently writing the wrong thing.
- [x] String-literal edits preserve quote style (single vs double).
- [x] Template-literal-quasi edits escape backticks and `${` so the literal stays syntactically valid.
- [x] Edits inside the agent are atomic relative to the file (single `writeFileSync`). HMR catches the change and reloads.
- [x] The agent only walks paths inside the project root passed at startup. Symlinks aren't followed. `node_modules`, build outputs, config files, lock files, dot-dirs are skipped.

## What I'd want to know before installing this in my own org

- [ ] If the gate is breached, what can the attacker do? *Answer:* file Linear issues to your configured project. Read your tester emails. Read your Linear API key. **Cannot** read or modify your application source — that's behind the agent, which never accepts remote connections.
- [ ] If a tester's account is compromised (their email + password leak), what's the blast radius? *Answer:* file false bug reports to Linear. Cannot edit source, cannot read Linear data (the gate is write-only against Linear from this surface), cannot escalate to admin. Rotate the tester's password from the admin Testers card — that revokes nothing, but the next time they sign in with the old password the JWT-issuance flow will reject them; existing live tokens stay valid until expiry. To kill existing sessions for one tester, delete them and re-add. To kill **all** sessions, rotate `GATE_JWT_SECRET`.
- [ ] If the plugin itself is malicious, what could it do? *Answer:* the plugin runs in your dev build. It has full access to your source tree at build time. **Read the source before installing.** It's ~400 lines.
- [ ] What if I want to remove this entirely? *Answer:* remove the plugin from `vite.config.js`, remove the script tag from `app.head.script`, delete `gate/data.json`. No state lives in your application source — every artifact is in `gate/data.json`.

## Coverage of the trust spectrum

| If you're… | This is enough |
|---|---|
| A solo dev on a portfolio | Way more than enough. The default config is fine. |
| A team of 5–20 with one product | Solid. Set a strong admin password, deploy the gate to a VPS, keep `gate/data.json` backed up. |
| A larger team with compliance requirements | You'll want TOTP on the admin, magic-link email verification, audit logs, and an SSO-aware version of the gate. None of those are here yet. |
| Filing tickets for end-users (not employees) | This isn't the right tool — there's no spam protection, no abuse handling, no CAPTCHA. Use a hosted feedback tool. |

If you stay inside the green rows, this is meant to be installable and trustable today.