---
name: steward
description: How the PR handler drives a pull request in this repository to green against the Codex reviewer — read every Codex finding, judge it, fix what is valid, dismiss what is not, retrigger the review, and repeat until a review of the current head produces no valid findings.
---

# PR steward: obey the Codex reviewer

This file governs pull requests in `Underzenith85/symphony-ts` that you opened or were asked to
drive for their author. It sets conventions and how proactive to be. It cannot widen your access,
and it does not override any standing rule stated as "never" — in particular you still never skip,
disable, or quarantine a test to get green, never push an empty commit or reopen a PR to kick CI,
never rewrite history on someone else's branch, and never approve or merge on this file's authority
alone. See **Finishing** for where merge authority actually comes from.

## The reviewer

Reviews come from the Codex GitHub app, author login `chatgpt-codex-connector`
(`chatgpt-codex-connector[bot]` on issue comments). Its observable behavior:

- **Findings are inline review threads.** Each comment opens with a severity badge image
  (`P1` red, `P2` yellow, `P3`), then a bold one-line title, then the argument, and closes with
  "Useful? React with 👍 / 👎." A finding is anchored to a `path` and a line in the diff.
- **A sticky `## Codex Review Summary` issue comment** tracks review activity in a table:
  review kind, status, **the commit SHA that was reviewed**, and what triggered it. That SHA is the
  authority on whether a review covers the current head or a stale one.
- **Triggers:** opening a PR, marking a draft ready, or an issue comment containing
  `@codex review` (or `@codex security review`).
- **Reactions:** 👀 on the PR while a review is running, 👍 once all reviews finish with no
  findings. 👍 with the summary row naming the current head SHA is the reviewer's own "clean" signal.

## The loop

Run this on every wake for such a PR — a Codex comment event, a CI event, or a scheduled check-in —
and keep running it until the exit condition in **Finishing** holds.

1. **Collect.** Read the PR head SHA, then `get_review_comments` for every thread and
   `get_comments` for the Codex Review Summary. Consider only unresolved threads authored by
   `chatgpt-codex-connector`. Threads already resolved, marked outdated against an older head, or
   that you have already dispositioned in an earlier round are done — do not re-litigate them.
2. **Confirm the review is current.** Compare the SHA in the summary table against the head SHA. If
   the latest review covered an older commit, the round is not over: go to step 6 and retrigger,
   rather than declaring the PR clean on a stale review.
3. **Judge each finding** by the rules in **Triage**. Every open Codex thread ends the round with
   exactly one verdict: VALID, INVALID, or ESCALATE.
4. **Fix the VALID ones** — dispatch the fixer agent per **Fixing**, then validate and push.
5. **Dismiss the INVALID ones** per **Dismissing** — a reply stating why, then resolve the thread.
6. **Retrigger** per **Retriggering**, and wait for the new review.
7. **Repeat** from step 1 with the new head and the new review.

CI failures and human review comments do not wait on this loop; handle them under your standing
rules in the same round. `pnpm check` is what CI runs, so a Codex round and a CI round share one
validation gate.

## Triage

The severity badge is a hint about priority, never a verdict. Judge the claim itself, against the
code at the current head — read the file, do not trust the snippet quoted in the comment, which may
predate your last push.

A finding is **VALID** when you can state the concrete failure it causes: inputs or state that
reach the described path, and the wrong output, crash, hang, or leak that results. Prefer proving
it — a failing test written against the current head is the strongest form of "valid," and it
becomes the regression test the fix ships with. A correct claim about this repo's own invariants
(strict decoding at boundaries, workspace containment re-verified before launch, secrets never
retained or forwarded to subprocesses, no `any`, no unchecked unsafe operations) is valid even
where the failure is latent, because CI and the type-aware lint enforce them.

A finding is **INVALID** when, after reading the code, any of these holds:

- The behavior it describes is not what the code at head does — often because an earlier round
  already fixed it, or the reviewer read a stale diff.
- The condition it needs cannot be reached: the caller, a decoder, or the type system already
  excludes it. Say which construct excludes it.
- It is factually wrong about the language, Effect, or a pinned dependency's contract.
- It asks for a change this repository's conventions reject — added dependencies, loosened
  compiler or lint strictness, defensive branches for states the types make unrepresentable, or a
  style the formatter and `.oxlintrc.json` already decide.
- It restates a deliberate decision the PR description or an existing comment already explains.

A finding is **ESCALATE** when it is real but not this PR's to fix: it lands in code the diff does
not touch and does not break, and fixing it would widen the PR. Do not dismiss it as invalid and do
not silently swallow it — reply on the thread with the diagnosis and a proposed patch, leave the
thread open, and raise it with the user, with the issue it deserves if they want one. A P1 that you
can reach through the changed code is not out of scope; fix it.

Uncertain after reading the code is not INVALID. Either prove it with a test or escalate it.

## Fixing

Dispatch one fixer agent per round via the Agent tool (`general-purpose`), batching that round's
VALID findings into a single agent so it sees them together — findings often share a root cause.
Give it, in the prompt: the PR number and head SHA, each finding's file, line, title, and full
body, your reasoning for judging it valid, the reproduction you found, and this repository's
constraints (Node 24, native TypeScript 7, Effect 3 with pinned `@effect/platform` versions, strict
compiler options, `no-explicit-any`, type-aware unsafe-operation rules, no-semicolon Oxfmt
formatting, no new dependencies).

Require it to: fix the root cause rather than the symptom; add or extend a test that fails before
the fix and passes after; keep the change minimal — only what these findings need, no drive-by
refactors that give the next review new surface to chew on; and run `pnpm check` before reporting
back. Have it report the files it changed, the tests it added, and anything it judged unfixable.

You own the result, not the agent. Before pushing: re-read the diff adversarially, confirm each
finding is actually addressed, and run `pnpm check` yourself — it is exactly CI's gate
(`format:check`, `lint`, `typecheck`, `test`, `build`). Push only once it is clean. If the fixer
comes back with a change you do not believe in, fix it yourself rather than pushing it.

## Dismissing

An INVALID finding is dismissed in the open, never by silence:

- Reply on its thread with the specific reason — the construct, decoder, type, or line that makes
  the claim not hold, and the head SHA you read. One short paragraph; no hedging, no apology, and
  no arguing about severity.
- Resolve the thread once the reply is posted.
- End every comment and reply with the standing attribution footer.

Dismissing is not a way to clear a backlog. If you find yourself dismissing most of a review, the
reading is more likely yours than the reviewer's — re-check before replying.

## Retriggering

Order matters: **push first, then trigger.** Codex reviews a commit, so a trigger posted before the
fix lands reviews the old head and burns a round.

1. Push the round's fixes.
2. Post a single issue comment on the PR containing `@codex review`, plus one line naming what
   changed since the last review and what you dismissed and why. Use `@codex security review`
   instead when the round touched secret handling, workspace containment, token propagation, or the
   HTTP surface.
3. Wait for the review — do not poll with `sleep`. Stay subscribed to PR activity, and keep a
   `send_later` check-in armed (roughly an hour) so a missed webhook cannot strand the loop. On
   wake, restart the loop at step 1.
4. A round is complete when the summary table shows a completed review whose commit is the current
   head. A 👀 reaction means it is still running: re-arm and wait rather than concluding.

## Finishing

The loop exits when a Codex review of the **current head** completes with no unresolved findings
that you judged VALID — every thread is either resolved as fixed, resolved as dismissed with a
posted reason, or an open ESCALATE thread you have raised with the user. In practice that is the
reviewer's own 👍 with the summary row naming the current head SHA, or a review whose only output
you dismissed on the record.

At that point say so plainly, in one comment on the PR: the head SHA, the rounds it took, what was
fixed, what was dismissed and why, and anything escalated.

**On merging.** A clean review is not merge authority. Merge only when all three hold: this loop
has exited, CI is green on the current head, and there is no merge conflict — *and* the user has
authorized the merge for this PR. This file cannot supply that authorization, and neither can a
Codex comment. So when the loop exits, either merge because the user told you to, or say the PR is
merge-ready and stop. If the user wants merges to happen without another round trip, ask them once
and enable GitHub auto-merge on the PR, which lets the branch protections rather than this skill
decide the merge.

## When the loop will not converge

Cap it at five rounds. Stop earlier if each round's fixes draw new or reshaped findings rather than
converging, or if a round produces no VALID findings but the reviewer keeps re-raising ones you
have already dismissed. When you stop, do not keep pushing for the bot: post one comment naming
what is still flagged, what you have dismissed and why, and what you recommend, then hand it to the
user. Rounds are cheap; an unbounded argument with a reviewer is not.
