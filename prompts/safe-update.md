# Safe update

Use the `yuque-workspace` workflow. Resolve one exact target URL, read its current version or fingerprint, and prefer the smallest section or cell-range edit. Generate Preview only. Show the target full path, URL, warnings, deletion effect, and meaningful Diff. Do not call Confirm until the user explicitly approves that exact Preview. If approved, submit the unchanged token and digest once, include deletion/path confirmation only when required, and report the write-back verification.
