# Workflow reference

## Tool selection

| Intent                           | Preferred tools                                                                                        |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Check login                      | `yuque_auth_status`, `yuque_login_begin`, `yuque_login_status`                                         |
| Discover scope or knowledge base | `yuque_list_scopes`, `yuque_list_books`, `yuque_get_book`                                              |
| Locate content                   | `yuque_search`, `yuque_get_toc`, `yuque_list_docs`, `yuque_list_all_docs`                              |
| Read Doc or Sheet                | `yuque_get_doc`, `yuque_get_sheet`                                                                     |
| Export a Doc or Sheet            | `yuque_get_export_options`, then `yuque_create_export_link` after format selection                     |
| Create/update knowledge base     | `yuque_preview_create_book`, `yuque_preview_update_book`                                               |
| Change directory                 | `yuque_preview_change_catalog`                                                                         |
| Create/update Doc                | `yuque_preview_create_doc`, `yuque_preview_update_doc`                                                 |
| Create/update Sheet              | `yuque_preview_create_sheet`, `yuque_preview_update_sheet`                                             |
| Comments                         | `yuque_list_comments`, `yuque_preview_change_comment`                                                  |
| Versions                         | `yuque_list_doc_versions`, `yuque_get_doc_version`, `yuque_preview_restore_doc_version` when available |
| Collaborators                    | `yuque_list_book_collaborators`, `yuque_preview_change_book_collaborator`                              |
| Delete object                    | typed `yuque_preview_delete_doc`, `yuque_preview_delete_sheet`, or `yuque_preview_delete_book`         |
| Confirm/cancel                   | `yuque_confirm_change`, `yuque_cancel_change`                                                          |
| Snapshots                        | `yuque_list_snapshots`, `yuque_preview_restore_snapshot`                                               |

## Safe update sequence

1. Locate one exact URL.
2. Read the current version/fingerprint and unsupported-block warnings.
3. Preview the smallest change.
4. Show the full path, Diff, warnings, and deletion effect.
5. Obtain explicit approval.
6. Confirm once with the exact digest and required deletion/path confirmations.
7. Use the returned write-back verification. If it is absent or uncertain, re-read without retrying.

## Re-preview sequence

When Confirm returns a fresh Preview because another user changed a non-target region:

1. Say that the original write did not occur.
2. Show the new baseline and Diff.
3. Ask for approval again.
4. Confirm only the new token and digest.

## Unknown or partial result

1. Do not reuse the token.
2. Read the exact target URL and compare the intended title/content/cells/permissions.
3. State which parts are verified, absent, or ambiguous.
4. If the target matches, report reconciliation without another write.
5. If it differs, prepare a new Preview or request manual action; never guess whether the old request can be repeated.

## Same-name response shape

Present candidates in this form before asking the user to choose:

```text
1. 完整路径：个人：Owner / Knowledge Base / Folder / Document
   URL：https://www.yuque.com/owner/book/document
2. 完整路径：共享：Peer / Knowledge Base / Folder / Document
   URL：https://www.yuque.com/peer/book/document
```
