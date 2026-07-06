#!/bin/bash
# PreToolUse hook: deny Edit/Write/NotebookEdit on files inside the PRIMARY
# checkout of this repo. All work must happen in a per-session git worktree
# (see CLAUDE.md "Work in a worktree"). Linked worktrees are detected by
# git-dir != git-common-dir, so it works wherever the worktree lives.
#
# Escape hatch for user-approved direct fixes on main (e.g. urgent CI fix):
#   touch .claude/allow-main-edits   (delete it when done; it is gitignored)

input=$(cat)
f=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
[ -z "$f" ] && exit 0

d=$(dirname "$f")
while [ -n "$d" ] && [ "$d" != "/" ] && [ ! -d "$d" ]; do d=$(dirname "$d"); done
[ -d "$d" ] || exit 0

gitdir=$(git -C "$d" rev-parse --path-format=absolute --git-dir 2>/dev/null) || exit 0
common=$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0

# Linked worktree: its git-dir lives under <main>/.git/worktrees/<name>
[ "$gitdir" != "$common" ] && exit 0

top=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null)
[ -n "$top" ] && [ -f "$top/.claude/allow-main-edits" ] && exit 0

cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED by project policy: this file is in the MAIN checkout. All work must happen in a per-session git worktree (CLAUDE.md, 'Work in a worktree'). Create one now with the EnterWorktree tool (or `git worktree add`), redo the change there, commit on the worktree branch, and merge to main only after the user approves. If the user has explicitly approved a direct fix on main (e.g. urgent CI repair), ask them to confirm creating the override file `.claude/allow-main-edits`, retry, and delete it when done."}}
EOF
exit 0