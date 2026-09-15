# Archived intel cards

Cards that are not in play. `scripts/gen-intel.ts` reads `lib/intel/cards/*.md`
and does not descend into directories, so nothing here is compiled into
`cards.generated.ts`, routed to, or shown on the tool rail.

To bring one back, move it into `lib/intel/cards/` and run `npm run intel`,
then `npm test`: the eval suite in `lib/evals/cases.ts` is the list of phrases
the live cards are expected to answer, and a card returning to play needs its
cases back with it.

The tool rail keeps a `PRESENTATION` entry only for cards in play. A card
brought back without one still lands on the rail, under an improvised name and
the generic graph glyph, which is `improvise()` doing its job rather than a
bug.

Everything here is in git, so `git log --diff-filter=D -- lib/tools/broll-plan.ts`
and friends will find code that was deleted alongside a card rather than moved.
