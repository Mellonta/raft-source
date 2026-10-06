// MessageInput owns the composer spacing and safe-area inset. RUI panel
// footers also provide spacing by default; neutralize it at both hosts.
//
// z-20 on BOTH branches: the composer (and everything it pops, e.g. the "@"
// suggestion list) must paint above the timeline's floating overlays - the
// "N new messages" pill sits at z-10 in the timeline and used to cover open
// suggestions in the non-overlay composer. Layering the host keeps the whole
// composer one layer instead of each popover carrying its own hard-coded
// z-index.
export function composerHostClassName(overlay: boolean): string {
  return `!flex !shrink-0 !flex-col !items-stretch !p-0 !border-0 before:!hidden ${overlay ? "!absolute inset-x-0 bottom-0 z-20" : "!relative z-20"}`;
}
