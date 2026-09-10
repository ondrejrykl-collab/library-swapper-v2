# Library swapper v2

Plugin identity:
- displayName: Library swapper v2
- description: Experimental library swapper with new features
- id: 707e6b66-f98f-4ebb-8b40-f050c3a8d2d4

## Saved version (baseline)

- SHA: d1776ae7a7d7e9b83430d5a6153baf29f6e33593
- Date: 2026-09-10
- Status: Working — user confirmed plugin works well after fixing component publish issue

## What it does

Swaps deprecated component instances from old libraries to the new **Components** and **Compositions** libraries. Features:

1. **Component mapping** — `FULL_MAP` maps old component names to new library keys (component key + type + library name)
2. **Exclude list** — `EXCLUDE_KEYS` prevents certain components from being swapped
3. **Smart variant matching** — `findBestVariant` scores variants by property overlap to find the closest match in the new component set
4. **Deep override preservation**:
   - Collects all component properties (BOOLEAN, TEXT, VARIANT, INSTANCE_SWAP) before swap
   - Collects all text node content with path-based matching
   - After swap, restores component properties with path + base-name matching
   - Instance swap restoration uses 3 strategies: FULL_MAP lookup, preferred values search, direct key re-import
   - Text restoration uses 3 strategies: exact path match, suffix path matching, name matching
5. **Multi-pass processing** — runs up to 10 passes to catch nested instances that become swappable after parent swap
6. **Ancestor deduplication** — skips instances whose ancestor will also be swapped
7. **Needs-update detection** — re-imports components already in new library to get latest published version
8. **UI** with Preview (dry run) and Swap modes, scope selection (Selection / Entire page), filterable results with clickable navigation

## Controls

- **Scope**: Selection or Entire page (fig-options)
- **Preview button**: Dry run showing what would be swapped
- **Swap button**: Executes the swap
- Results section with summary tags (swapped/skipped/errors/already-new) and clickable detail rows
