#!/bin/bash
# PreToolUse hook: deny Edit/Write/NotebookEdit on files inside the PRIMARY
# checkout of this repo. All work must happen in a per-session git worktree
# (see AGENTS.md "Work in a worktree"). Linked worktrees are detected by
# git-dir != git-common-dir, so it works wherever the worktree lives.
#
# Escape hatch for local-only work the user explicitly asks for in the main
# checkout (it cannot be pushed: main only accepts PRs):
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
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"BLOCKED by project policy: this file is in the MAIN checkout. All work must happen in a per-session git worktree (AGENTS.md, 'Work in a worktree'). Create one now with the EnterWorktree tool (or `git worktree add`), redo the change there, commit on the worktree branch, and reach main through a PR (gh pr create), merged only after the user approves. Even an urgent fix goes through a PR: main refuses direct pushes."}}
EOF
exit 0