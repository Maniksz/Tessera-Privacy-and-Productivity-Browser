import { MAX_RANKED_ROWS, mergeKeyOf, rankCandidates } from './rank.js'

/**
 * Which of a window's tabs the tab search lists, in what order (U22, R31).
 *
 * ## Ranked by the address bar's ranker, and why that needs a second step
 *
 * A non-empty search is ordered by `rankCandidates` (KTD11), so the tab search and the address bar agree
 * about what "matches best" means: an address that starts with the text, then a title word, then either
 * containing it. But the ranker merges candidates on one page into one row, which is right for
 * suggestions — nobody wants `github.com` offered three times — and wrong here, where every row is a tab
 * to switch to. Two tabs open on the same page would leave one of them unfindable. So each ranked row is
 * expanded back into every tab it stands for, in the order the tabs were given.
 *
 * ## An empty field lists every tab
 *
 * In the order given, which is the strip's (`displayOrder()`), including the members of a folded group —
 * the strip draws those as a chip alone, and this list is then the only one that still has them. Not
 * capped: a window's tabs are a list somebody can scroll, where a ranked answer is the best few.
 *
 * Pure, with the ranker's own guarantees: nothing here reaches the network, and the renderer that calls
 * it on every keystroke carries no validation library for it.
 */

/** What the search reads of a tab. The caller's own objects come back, with every field they had. */
export interface SearchableTab {
  readonly id: string
  readonly title: string
  readonly url: string
}

/**
 * The rows for `text`: all of `tabs` while it is blank, otherwise the ranked matches, at most
 * {@link MAX_RANKED_ROWS} of them.
 *
 * The clock the ranker asks for is fixed at zero because a tab carries no visits; every candidate weighs
 * the same, so order falls to the match class and the ranker's tie-breaks.
 */
export function tabSearchRows<T extends SearchableTab>(tabs: readonly T[], text: string): T[] {
  if (text.trim() === '') return [...tabs]

  const ranked = rankCandidates(
    tabs.map((tab) => ({ source: 'tab' as const, title: tab.title, url: tab.url })),
    text,
    0
  )

  // At most eight rows, so a scan of the tabs per row is cheaper than building an index to look in.
  return ranked
    .flatMap((row) => {
      const key = mergeKeyOf(row.url)
      return tabs.filter((tab) => mergeKeyOf(tab.url) === key)
    })
    .slice(0, MAX_RANKED_ROWS)
}
