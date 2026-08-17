---
name: yuque-workspace
description: Safely locate, read, export, create, update, restore, share, and remove Yuque knowledge bases, directories, documents, sheets, comments, and versions through the yuque-web-mcp tools. Use when a user asks to find, summarize, or export Yuque content, resolve duplicate names by full path, prepare or confirm a Yuque change, collaborate with reader/editor roles, recover from conflicts, or inspect the server's available capabilities.
---

# Yuque Workspace

Use the configured `yuque_*` MCP tools. Never ask for or handle Yuque cookies, CSRF values, encryption keys, or the service's bearer token.

## Start safely

1. Call `yuque_get_capabilities` before the first operation in a conversation that may write, delete, restore, or change permissions.
2. Call `yuque_auth_status`. If login is required, call `yuque_login_begin` with the user's chosen provider and return the one-time URL. Do not open or scan it on the user's behalf.
3. Respect `available`, `preview_only`, and `disabled`. Do not substitute an unverified endpoint or raw HTTP request.
4. Treat personal and organization scopes as distinct. Do not switch scope or inspect an organization unless the user selected it.

## Locate before reading or changing

1. Use title/path search or the location index before fetching full bodies.
2. Always show the complete display path and URL before presenting content or proposing a change.
3. If names collide, list every matching full path and URL. Wait for the user to choose; never pick by list order.
4. For shared content, preserve the `共享：<owner>` prefix so it cannot be confused with an owned knowledge base.
5. For large documents or sheets, request only the needed cursor segment or A1 range.

## Read and answer

- State the selected full path and URL first.
- Distinguish source content from your summary or inference.
- Report proprietary or unsupported Lake blocks before suggesting edits.
- For sheets, preserve value types, formulas, and the requested basic formatting metadata.

## Export a document or sheet

- Locate one exact Doc or LakeSheet URL and show its full path.
- If the user did not already choose a format, call `yuque_get_export_options`, show every returned option, and wait for the user to choose before calling `yuque_create_export_link`.
- Use only a format returned for that exact target. Ordinary Docs support `word`, `markdown`, `pdf`, `lake`, and `jpg`; LakeSheets support `excel` and `lakesheet`. Never substitute a guessed cross-type format or endpoint.
- Return the generated link once. If `browser_login_required=true`, tell the user to open it in a browser signed into the same Yuque account.
- Treat a signed link as a short-lived access credential. Do not copy it into notes, logs, prompts, or unrelated messages.
- Do not fetch the link, download the file, or claim that the MCP stored an export.

## Change through Preview and Confirm

1. Prefer the smallest operation: append or section/range update before whole-content replacement.
2. Call the matching `yuque_preview_*` tool. Do not claim that Preview changed Yuque.
3. Present the target full path, URL, structured summary, deletion count, warnings, and meaningful Diff. Never hide removed text or cleared cells.
4. Ask for explicit user approval after showing the Preview.
5. Confirm only with the exact, unmodified `change_token` and `diff_digest` from that Preview.
6. If the Preview contains deletions, set `confirm_deletions=true` only after explicit approval. For whole-object deletion, also submit the exact `confirmation_text` returned by Preview.
7. Never reuse a token, auto-confirm a destructive operation, or confirm after its expiry.
8. Report the write-back path, URL, version/fingerprint, and final state returned by Confirm.

If the deployment is in `strict` mode, stop after Preview and explain that remote Confirm is intentionally disabled. Do not advise weakening the setting unless the deployment owner is making that decision.

## Handle conflicts and uncertainty

- `repreview_required`: show that no target-region write occurred, present the new Preview, and request approval again.
- `conflict`: re-read the target. Preserve both users' non-overlapping work; never overwrite the changed region automatically.
- `unknown` or `partial`: do not retry Confirm. Re-read and reconcile the target, then ask for human direction.
- Permission errors: do not log out or erase a healthy session.
- Login expiry: request a new login only for the current instance owner.
- Contract mismatch or disabled capability: stop. Do not guess a payload or endpoint.

## Delete and permissions

- Treat paragraph deletion, cell clearing, comment deletion, directory deletion, and whole-object deletion as different effects.
- Require explicit Diff approval for content deletion and exact-path confirmation for whole-object deletion.
- Explain that a deleted Doc or Sheet snapshot can only recreate a copy; it does not restore the original URL, ID, or history.
- Explain that full knowledge-base deletion has no complete local recovery guarantee.
- For collaborator changes, show the target login, current role, proposed role/action, and full knowledge-base path before confirmation.

Read [references/workflows.md](references/workflows.md) when choosing among similar tools or recovering from a failed write.
