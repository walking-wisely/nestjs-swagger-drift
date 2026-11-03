# Generalizing to Python (DRF): the review-cost tradeoff

> Speculative — not part of the implementation plan, not cited from code as
> `PLAN §n`. Captures a conclusion from exploring whether this tool's
> approach generalizes to Django REST Framework, for whoever picks this up
> next.

## Why this doesn't just port

The Nest tool's determinism rests on `ts.Program` giving a _sound_ way to
resolve a call chain (`this.usersService.create()` → jump to the real method,
because the constructor parameter is typed) and on Nest's DI forcing that
typing convention everywhere. DRF has neither: no DI container forcing typed
service dependencies, and Python's dynamic dispatch means resolving an
untyped `self.x.method()` to a concrete target is, for the genuinely
runtime-determined cases (factories, config-driven service selection,
duck-typed interfaces), **undecidable by any static analyzer in any
language** — not an engineering gap, a Rice's-theorem-shaped wall.

Some of the surface is unaffected by this and stays fully sound/free, same as
the Nest tool: DRF's declarative config (`permission_classes`,
`throttle_classes`, `serializer.is_valid(raise_exception=True)`, generic
mixins, direct `raise`s) is decidable from syntax alone, zero call-graph
needed. Call this the **certain tier** — it should ship first, needs no
review, and is probably a larger share of real-world DRF drift than it looks
at first (`drf-spectacular` defaults undocumented statuses to `[200, 201]`,
so even this "easy" tier finds real gaps).

The tier that _doesn't_ survive is the one that made the Nest tool worth
building in the first place: a status thrown two calls deep in business
logic that the controller doesn't document. That's exactly the part that
needs a real call-graph, and it's exactly the part Python's dynamism makes
unsound to fully automate.

## The conclusion: review is unavoidable for that tier, but it's a toll, not a tax

There's no lazy, fully-automatic equivalent for the deep-call-chain case in
Python — a human has to confirm intent at some point, because no tool can
soundly prove it. That's permanent, not a gap more engineering closes.

But the cost model isn't "review every PR forever." Once a human approves a
finding for a given path (e.g. "yes, `InvoiceService.void` really can raise
409, document it"), commit it as both the schema annotation _and_ a
regression test. From that point that path is sound and automatic forever —
nobody re-reviews it. **Review is paid once per code path, ever, not once
per CI run.** A healthy rollout's review queue should shrink toward zero
over time, not stay a steady-state per-merge cost.

So the product shape isn't "automatic vs. drop the feature" — it's:

- **Certain tier**: automatic, CI-blocking, free, forever (parity with Nest).
- **Everything requiring inference/observation**: a shrinking, one-time-per-path
  review queue that graduates into the certain tier once approved.

Framing this honestly to a team matters: not "fully automatic like the Nest
version" (that's an overclaim that breaks on the first undecidable case),
but "automatic where it can be sound, front-loaded-but-shrinking review
where it can't, and once reviewed, locked in forever."

## What makes the review queue cheap enough to survive (the actual design lever)

Since review can't be eliminated for that tier, the only lever left is
cost-per-item and trust-per-item:

- **Every finding must resolve to a yes/no domain question**, with the exact
  raising source line (and a reproducing test, if one exists) attached
  inline. "Is this status intended?" is a 10-second read. "Here's a call
  graph, figure out if this is real" reintroduces the work the tool was
  supposed to remove.
- **Small batches, grouped by code owner.** A 400-item PR gets rubber-stamped,
  not reviewed — which quietly reintroduces the exact soundness gap the
  review step exists to close.
- **Rejecting must be as cheap as approving**, and a rejection must produce a
  durable, typed, _expiring_ suppression — otherwise the same wrong finding
  gets re-litigated every time it resurfaces, and the toll never amortizes
  down to zero.
- **Track rejection rate per inference class as a metric.** A detector
  rejected ~40% of the time needs a better evidence format, a lower
  confidence tier, or retirement — the review queue doubles as calibration
  data for the tool, not just a workflow to get through.

Bootstrapping note: for a codebase with no test suite (common case for this),
don't ask a human to write tests first as a prerequisite. Use staging/prod
traffic observation (or, absent that, fuzzing a seeded local instance) to
_originate_ characterization tests targeted at exactly the paths the certain
tier couldn't resolve — the review queue then also builds the test suite as
a byproduct, rather than requiring one to already exist.
