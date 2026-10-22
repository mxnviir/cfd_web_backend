# Workbench UI review

15 September 2026. Measured against the deployed `turboflow-test` workbench
with a real finished run open (Run 4, drag 0.127 N), not read off the source.
Every number below came from instrumenting the live DOM.

Where a claim is untested it says so.

---

## The short version

The workbench is in much better shape than the marketing site, and the numbers
say so rather than my opinion. It is a genuinely dense, disciplined engineering
interface. The defects are specific, not systemic.

The one structural problem is that **the workbench and the website are two
separate design systems** that share a product.

---

## What is measurably good

I went looking for the usual signs of a generated interface and mostly did not
find them.

| Check | Marketing site | Workbench |
|---|---|---|
| Distinct font sizes on one screen | 13 | **6** |
| Text at weight 700 | 33 of 72 nodes | **1 of 145** |
| Typefaces | 2 | 2 |
| Distinct corner radii | 1 + circles | 1 + a tokenised pill |
| Controls with no accessible name | - | **0 of 81** |
| Colour pairs failing AA | 0 | **0 of 153**, across 3 themes |

The weight distribution is the striking one. The workbench renders 127 nodes at
400, 12 at 600, 5 at 500 and **one** at 700. That is what restraint looks like
in a number, and it is the opposite of the home page, where more than half the
text was bold and therefore nothing was.

Three more things I expected to be wrong and were not:

- **The progress bar is honest.** It reads SimScale's own `body.progress` and
  interpolates it onto a slice of the run's overall bar. No invented
  percentages. (`poll_operation` in `simscale_job.py`.)
- **The stage labels are specific**: "Uploading to the solver", "Meshing 43%",
  "Checking the setup", "Downloading the results". Not "Loading...".
- **The empty state for runs says what will appear**: "Finish the steps and
  queue one. Its progress, its forces and its convergence all appear here."
  That is what an empty state is for.

I also want to correct something I said mid-review. I first reported "zero
contrast failures" from a pass that read `color` on SVG text. SVG text is
painted with `fill`, so that pass measured a property nothing draws with. Redone
against `fill`: tick labels are **4.7:1** and axis titles **7.18:1**. The
conclusion held, but the first measurement did not support it.

---

## Fixed in this pass

### P1. No chart had an x axis

Every plot was titled "Iteration" and carried **not one x value**. Measured:
`xTickCount: 1` on all three plots, and that one element was the axis title.

So a team could see their residuals fall and could not say whether that
happened by iteration 80 or iteration 800, which is the single thing you open a
convergence plot to find out.

Ticks now land on 1, 2 or 5 times a power of ten, so they read 200, 400, 600,
800 rather than 237, 474, 711. Verified live on all three plots.

### P1. Two of the six series were painted in the state colours

The chart took its palette from the semantic tokens:

```js
const COLOURS = [
  "var(--wb-accent)", "var(--wb-bad)", "var(--wb-ok)",
  "var(--wb-warn)", "var(--wb-assigned-other)", "var(--wb-hover)",
];
```

Series 2 was `--wb-bad` and series 4 was `--wb-warn`. On a residual plot, one of
the six lines was drawn in the colour that means **error** everywhere else in
the product, and another in **warning**. A perfectly converging Uy residual was
red.

Series 5 and 6 were worse in a different way: `--wb-assigned-other` and
`--wb-hover` are a selection state and a hover state doing duty as data ink, and
series 1 and 6 were `#4a90d9` and `#7ab3e0` - two blues that cannot be told
apart on a 1.4px line.

There is now a categorical ramp, `--wb-series-1` to `-6`, defined in all three
theme blocks. Six well-separated hues, no accent, no state colour, and **no red
at all**: in this product red means something, and a data series is not it.
Verified live - the six strokes are now distinct and neither the error red nor
the warning yellow appears.

### P2. `toPrecision(4)` in the plot legend

The same significant-figures problem I fixed in the run summary, in a second
place. On a residual it is unreadable: a converged Ux of 1.234e-6 printed as
`0.000001234`. Residuals now go exponential, forces and moments keep fixed
places and line up, and the readout is mono and tabular so the legend does not
reflow on every mouse move.

---

## Found, not fixed

### P1. Two design systems

`src/workbench/tokens.css` defines a `--wb-*` / `--tf-*` system. `src/styles.css`
defines a completely separate one for the site. The workbench does not load
`type.css` or `buttons.css`, so the type scale and the button hierarchy built
this week stop at the workbench door.

In practice that means a button in the workbench and a button on the billing
page are different components that happen to look similar, and a change to one
does not reach the other. It is the largest consistency problem in the product
and it is a real piece of work, not a tidy-up: the two systems have different
surface models (`--panel`/`--inset` against `--wb-panel`/`--wb-panel-2`) and
merging them means re-checking contrast across both.

### P2. There is no spacing scale

One spacing token exists, `--wb-gap: 10px`. Measured on a live screen:

- **14 distinct padding values** - 1, 2, 4, 6, 8, 10, 12, 14 px and more
- **8 distinct gap values** - 2, 4, 6, 7, 8, 9, 10, 28 px

7px and 9px are one-off magic numbers; 1px and 2px padding are almost certainly
accidents. Nothing on screen looks broken, which is why it has survived, but it
means every new panel is a fresh guess and the rhythm drifts one component at a
time. A four or five step scale would cover all of it.

### P2. Eight tap targets under 28px

Measured: the view cube buttons (Iso / Front / Top) are **22px** high, the
Model / Results / Split tabs are **26px**. On a mouse that is tight but usable.
On a touch screen it is below any sensible guideline, and the workbench is
reachable on a tablet.

Not fixed because raising them changes the density of a toolbar that is
deliberately dense, and that is a judgement about who uses it on what.

### P3. Chart tick labels at 10px

They pass contrast at 4.7:1 and 10px is conventional for chart furniture, but
it is the smallest text in the product by 2px and the first thing anyone over
forty will complain about. 11px would cost nothing.

### P3. `.wb-chip` is a pill

I flagged this as breaking the one-radius system and then found
`--wb-radius-pill: 999px` is a defined token, so it is deliberate rather than an
accident. Toggle tracks are legitimately pills. The status chip is a judgement
call I would probably make the other way, at 37px tall for the words "1
finished", but it is not a defect.

### P2. The queue does not explain itself

From earlier work in this repo I know the roughly three minute wait before a run
starts is Cloud Run Job container startup. The UI shows "Queued" at 0% for that
whole time with no explanation, which is exactly the state where a user starts
wondering whether something is broken. An ETA is not available, but "waiting for
a solver machine, usually about three minutes" is, and is worth more than a
bar that does not move.

### P3. One thin empty state

`JobStatus` says "Nothing has been run in this group yet." and stops. The
Results empty state does this properly - it says what will appear - and this one
should match it.

---

## Not reviewed

Being explicit, because a review that does not say what it skipped is not
finished:

- **The CFD setup form** beyond a glance. Fields are grouped into four steps,
  which is right, but I did not check every input for a unit, a range, a default
  and a validation message. Section 19 and 20 of the brief.
- **Error states** under real failure. I read the code path; I did not make runs
  fail in each of the ways they can fail and look at the result.
- **The 3D viewer**, selection, and the geometry panel.
- **Responsive behaviour** of the workbench. It was measured at 1440 only. A
  three-pane CAD interface on a phone needs a designed answer, not a stacked
  one, and I do not know what it currently does.
- **Keyboard navigation** through the panel tree, and focus order.
- **The dashboard**, which is a third surface again.

---

## Suggested order

1. The queue explanation. Smallest change, removes the "is it broken" moment.
2. A spacing scale in `tokens.css`, applied as panels are next touched rather
   than in one sweep.
3. The setup form audit: units and ranges on every numeric input.
4. Then the two design systems, which is a project rather than a task.
