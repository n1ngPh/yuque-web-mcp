# Conflict recovery

Use the `yuque-workspace` workflow to recover from a Yuque `conflict`, `repreview_required`, `partial`, or `unknown` result. Never retry the consumed Confirm token. Re-read the exact URL, identify which intended changes are present, preserve concurrent non-overlapping work, and prepare a new Preview only when the remote state is known. Explain any remaining ambiguity and request human direction before another write.
