# Prompt — Slide 03 diagram: Manual coordination vs DisruptionOps

Paste the block below into your image/diagram generator. The verbatim text
section matters most: generators invent plausible-looking labels unless you
pin every string, and an invented timestamp on a judging deck is worse than
no diagram.

---

## THE PROMPT

```
A clean, flat vector infographic for a disaster-response software deck.
16:9 landscape, wide format, white background, generous whitespace.
Editorial and restrained — think a broadsheet newspaper's explainer graphic,
not a startup landing page. No gradients, no drop shadows, no 3D, no glow,
no photographic elements, no stock-photo people.

SUBJECT: a side-by-side comparison of how one morning unfolds under two
systems. Same six events, same six timestamps, two very different outcomes.

STRUCTURE — two columns of equal width, separated by a narrow vertical
timeline spine running down the centre:

  - CENTRE SPINE: a thin vertical line with six time markers down it,
    reading top to bottom: 09:12, 09:14, 09:19, 09:21, 09:26, 09:31.
    Each marker is a small filled circle with the time beside it.
  - LEFT COLUMN, headed "MANUAL COORDINATION" — a warm red/terracotta
    accent (#B23A24). Six event cards, one per time marker.
  - RIGHT COLUMN, headed "DISRUPTIONOPS" — a deep navy accent (#11253C)
    with a teal highlight (#2E7D8F). Six event cards, one per time marker.

CRITICAL: the two columns must be ROW-ALIGNED to the spine, so a reader's
eye travels horizontally at each timestamp and sees the two outcomes for the
same moment directly opposite each other. This alignment is the entire point
of the graphic.

ROW EMPHASIS: at 09:21 and 09:31 the two sides diverge most sharply. Mark
those two rows with a subtle tinted band running the full width behind them
so the eye lands there first.

CARD STYLE: white cards, 1px light grey-blue border (#9FAFBE), 6px corner
radius, comfortable internal padding. Left-column cards carry a small red
warning mark; right-column cards carry a small teal check mark. Icons should
be simple line glyphs, not filled illustrations.

FOOTER: a full-width band across the bottom, split in two halves matching the
columns above, holding the outcome summary for each side.

PALETTE, exactly:
  ink / headings      #11253C
  body text           #3D5468
  muted / secondary   #6E8194
  failure accent      #B23A24
  success accent      #2E7D8F
  card fill           #FFFFFF
  panel tint          #F3F6F9
  borders             #9FAFBE

TYPOGRAPHY: one clean humanist sans throughout (Calibri, Inter or Source Sans).
Column headings bold and clearly larger than body. Timestamps tabular and
monospaced-feeling. Body text must remain legible when the image is projected
— err large. Nothing smaller than roughly 11px at 1920px wide.

TEXT — reproduce these strings EXACTLY. Do not paraphrase, shorten, re-order,
correct, or add any label, heading, caption, logo or annotation not listed here.

LEFT COLUMN HEADING: MANUAL COORDINATION
  09:12  Zone A reports 12 people stranded.
  09:14  Officer calls fire brigade. Two boats dispatched.
  09:19  Zone D reports a shelter at capacity.
  09:21  A second agency, unaware, also sends a boat to Zone A.
  09:26  Zone C reports rising water. No unit is free.
  09:31  Crew radios that the Zone A road is blocked. Nobody re-plans.

LEFT FOOTER:
  Three units on one incident. Two zones waiting. Nothing written down.

RIGHT COLUMN HEADING: DISRUPTIONOPS
  09:12  Report parsed, trust-scored, clustered. Zone A → severity 5.
  09:12  Solver assigns 2 boats — the nearest with water-rescue capability.
  09:19  Zone D arrives. Re-plan: a bus is re-tasked, cost of switch weighed.
  09:21  Second agency request matched to the open incident. Duplicate blocked.
  09:26  Zone C: no free pump. Shortfall raised to the officer, not hidden.
  09:31  Road reported blocked → removed from the graph → route re-solved.

RIGHT FOOTER:
  Every step recorded with the event that caused it.
  Total re-plan time: under two seconds.

NOTE ON THE RIGHT COLUMN: it has seven entries against six time markers,
because two events happen at 09:12. Place both 09:12 rows against the first
marker, stacked, rather than inventing a seventh timestamp.

DO NOT: add a title, a company logo, a watermark, page furniture, arrows
between the two columns, decorative stripes down the slide edge, or any text
beyond the strings given above.
```

---

## SHORT VARIANT

If the tool truncates long prompts, use this and add the verbatim text
afterwards in a second pass.

```
Flat vector infographic, 16:9, white background, lots of whitespace, editorial
newspaper-explainer style. Two equal columns either side of a central vertical
timeline with six markers: 09:12, 09:14, 09:19, 09:21, 09:26, 09:31.

Left column "MANUAL COORDINATION", terracotta accent #B23A24, small red warning
marks — coordination by phone that loses track. Right column "DISRUPTIONOPS",
navy #11253C with teal #2E7D8F, small check marks — the same events handled by
a solver that re-plans.

Rows must align horizontally across the spine so each timestamp's two outcomes
sit directly opposite. Tint the 09:21 and 09:31 rows to mark where the two
sides diverge. White cards, thin #9FAFBE borders, 6px radius. Footer band
across the bottom, split in two, for the outcome of each side.

Clean humanist sans. Large, legible, projector-safe text. No gradients, no
shadows, no 3D, no photos, no logos, no accent stripes.
```

---

## Two things to check before you drop it in

1. **Read every string in the output against the list above.** Generators
   routinely alter a timestamp or soften a phrase. "Duplicate blocked" becoming
   "duplicate detected" changes the claim.

2. **Zoom to 100% and read the smallest text.** This is the failure that made
   the old slide-06 image unusable: it looked fine as a thumbnail and was
   unreadable on a projector. If the body text is soft or aliased at full size,
   the image is too low-resolution — regenerate larger rather than scaling up.

A generated image cannot be edited later, and it will not know when the system
changes underneath it — the old architecture image still showed mesh reporting
weeks after it was removed. Native shapes avoid both problems.
