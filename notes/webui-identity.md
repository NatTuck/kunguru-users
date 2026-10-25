# WebUI per-turn identity

Status: **deployed on `feature/groups`; the fleet update is done (all 8 accounts
on the pinned fork at `b3caae7`).** The WebUI patch lives on
`NatTuck/hermes-webui`, branch `kunguru/trusted-user-identity` (draft upstream PR
[nesquena/hermes-webui#8522](https://github.com/nesquena/hermes-webui/pull/8522)).
The identity hook plugin is installed by `scripts/hermes/ensure.sh` for **group**
accounts. Per-member session scoping is **not** implemented (see §5).

Related: `auth-protocol.md`, `groups-and-apps.md` §10, `topology.md` §3.

---

## 1. Why

A group's WebUI (`<group>-agent.<base>`) is one process serving several members.
The WebUI already knows who is signed in — nginx injects `Remote-User`, the
WebUI resolves it to its own session — but chat turns carried no user, so the
model could not tell which member was speaking. The XMPP gateway already sets
`user_id`/`user_name` on inbound messages; the WebUI's in-process chat path did
not.

## 2. The chain

| Step | What carries the identity |
|---|---|
| Browser → gateway | `kunguru_sid` (gateway session cookie, `Domain=<base>`) |
| Gateway → WebUI | nginx `auth_request` → `X-Auth-User`; nginx strips `kunguru_sid` and sets `Remote-User` (+ `X-Kunguru-Identity`) |
| WebUI request | `ensure_trusted_auth_session` accepts `Remote-User` only from a trusted proxy, then keeps `{username, bound_profile}` in its own signed `hermes_session` cookie / server-side session store |
| WebUI chat handler | `_handle_chat_start` resolves the username from that session (None when trusted auth is off) |
| WebUI → agent | `_start_run` → `_start_chat_stream_for_session` → `_run_agent_streaming(user=…)` → `AIAgent(user_id=…, user_name=…)` |
| Agent turn | `agent._user_id` is exposed to `pre_llm_call` as `sender_id` |
| Prompt | the hook's `{"context": …}` is appended to the **current user message's API copy** (not the system prompt, not the persisted transcript) |

## 3. The WebUI patch

Three small edits (see the PR):

- `_handle_chat_start` resolves `ensure_trusted_auth_session(handler)["username"]`
  and passes it through `_start_run` → `_start_chat_stream_for_session` →
  `_run_agent_streaming`, including the regeneration launch site.
- `_apply_turn_user_identity` adds `user_id`/`user_name` to a fresh agent's
  constructor kwargs (when the installed Agent supports them) and re-stamps a
  **cached** agent immediately before the turn. It is deliberately not part of
  the agent-cache signature: the identity is per turn, and the per-session run
  lock serializes turns.
- Server-initiated turns (`start_session_turn`, `/btw`, background) pass no
  user; the gateway chat backend (`HERMES_WEBUI_CHAT_BACKEND=gateway`) is
  unchanged (it would need an API-side identity field).

The agent needs **no** change: it already accepts `user_id`/`user_name` and
passes `sender_id` to `pre_llm_call`.

## 4. The identity plugin (on change, not every turn)

`kunguru-group-identity` (installed in the account's `~/.hermes/plugins/` and
enabled in `plugins.enabled` for groups only) keeps the last announced speaker
per `session_id`:

| Situation | Injected into the user turn | Cost |
|---|---|---|
| First turn of a session | `[shared group session; current speaker: alice]` | ~10 tokens, once |
| Speaker changes | `[speaker changed: bob]` | ~5 tokens |
| Same speaker continues | nothing | 0 |
| Anonymous / trusted auth off | nothing | 0 |
| Process restart mid-session | re-announce once | ~10 tokens, once |

The announcement is committed in `post_llm_call`, so a turn that fails before
the model call is re-announced next time. It only applies to `platform ==
"webui"`; platform gateways already label inbound messages. For a 1:1 user
account the plugin is not installed (the owner is the only speaker).

## 5. Sessions are shared (open decision)

WebUI chat sessions are **not** scoped by user: the session list is global to
the WebUI state, so any member can open any session and a session can alternate
speakers. The on-change announcement handles that correctly.

The design notes' "sessions per `Remote-User`" is **not** implemented. Scoping
sessions per member would:

- make the speaker fixed per session (announce once, or a stable per-session
  system-prompt line), and
- stop members seeing each other's chat threads.

It is a materially bigger WebUI change (session ownership, list/API filtering,
migration of existing/CLI-imported sessions) and a product decision. Keep it as
a separate phase; the current design is correct either way.

## 6. Fork and patch maintenance

- Both places that manage the checkout use `WEBUI_REPO` / `WEBUI_REF`
  (defaults: the fork + `kunguru/trusted-user-identity`):
  - `scripts/webui/ensure.sh` (clone / update);
  - `scripts/hermes/ensure.sh` (the agent-update step — this one **used to**
    reset the WebUI to upstream `master`, which would silently wipe the patch).
- Updating the WebUI: rebase the fork branch onto `upstream/master`, push, and
  re-run the webui step (or an agent update). The scripts reset to the branch
  tip and print the deployed commit.
- Rollout: `POST /api/users/:id/update` converges one account (Hermes + WebUI),
  `POST /api/users/update` runs the serialized fleet update; progress is at
  `GET /api/users/update/status`. The 2026-10-24 cutover ran the fleet update:
  8/8 accounts (7 tenants + the `ops` group) are on `b3caae7`.
- For a frozen deployment, tag the fork (e.g. `kunguru-2026-10-24`) and set
  `WEBUI_REF` to the tag; the scripts fetch the ref and reset to it.
- When #8522 merges: set `WEBUI_REPO=https://github.com/nesquena/hermes-webui.git`
  and `WEBUI_REF=master`, and drop the branch.
- A missing fork/ref fails the step loudly; the WebUI keeps running whatever
  checkout it has (per-turn identity disappears, and the agent falls back to
  asking).

## 7. Security

- The WebUI accepts `Remote-User` only from `HERMES_WEBUI_TRUSTED_PROXY_CIDRS`
  (the gateway's address, or loopback when co-located), and keeps its own
  signed session cookie.
- **One-host caveat**: loopback is a trusted proxy, so a co-located tenant can
  spoof `Remote-User` to the WebUI. The signed `X-Kunguru-Identity` token is
  already forwarded by nginx; phase 2 should have the WebUI verify it
  (public key via env, `aud` = its host) and use `sub`.
- Within a group, members share the home and can read the agent's key/config;
  per-turn identity is advisory *within* the group, consistent with "no secrecy
  between members". Other tenants cannot read the group home.
- The plugin trusts only the `sender_id` the agent received from the WebUI; it
  does not read request headers itself.

## 8. Verification

- WebUI fork: `tests/test_trusted_user_identity.py` (fresh kwargs, cached agent
  re-stamped, older agent without the identity params, anonymous turns) passes.
- Plugin behaviour (extracted from `scripts/hermes/ensure.sh`): first turn,
  same speaker, speaker change, new session, non-WebUI platform, anonymous,
  and a failed turn re-announcing.
- End-to-end after deploy: a group with two members; each opens the group WebUI
  and asks "who am I?"; the agent answers with the right name; a speaker change
  is announced once; the transcript does not accumulate the markers.
- `pnpm check` and `pnpm build` in this repo.

## 9. Open items

1. Merge #8522 upstream and switch `WEBUI_REPO`/`WEBUI_REF` back.
2. WebUI verification of `X-Kunguru-Identity` (one-host hardening).
3. Per-member session scoping (product decision; §5).
4. Gateway chat backend identity (`/v1/runs` needs an identity field).
5. The unused `/api/chat` sync fallback is not threaded (the frontend does not
   use it).
