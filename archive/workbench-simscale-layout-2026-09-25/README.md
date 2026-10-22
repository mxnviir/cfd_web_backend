# The Workbench and dashboard before the 25 Sep 2026 redesign

On 25 Sep 2026 the owner asked for the Workbench to stop being a 1:1 SimScale
copy: a race-engineering look of its own (DESIGN_RULES.md), and a layout built
around the car and its runs instead of SimScale's tree, scene column, centred
toolbar and job table. These are the files as they were just before that, same
paths as in the repo. To put the old Workbench back, copy this folder over the
repo root, delete src/workbench/RunBoard.jsx (new in the redesign), and
rebuild. Not built, not served.

Six of the files come from Claude Code's per-turn file history (the state
before the first edit of the turn). tokens.css had no snapshot, because its top
half was replaced by a script; that half was transcribed from the file as read
before the change, and the file has the original 519 lines.
