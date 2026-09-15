# Archived intel cards

The nine cards that were here before the workbench was cleared to start over.
Moved rather than deleted: `lib/` is not in git (the only commit is Create
Next App), so a delete would have been final.

To bring one back, move it into `lib/intel/cards/` and run `npm run intel`.

They are out of the way here because `scripts/gen-intel.ts` reads
`lib/intel/cards/*.md` and does not descend into directories.
