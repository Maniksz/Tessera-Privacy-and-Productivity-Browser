import { blocksOf, inlineTextOf, type ReaderBlock } from './content.js'
import { metadataOf } from './metadata.js'
import { MIN_PROSE_MASS, type ReaderMeasurement, type ReaderOutcome } from './outcome.js'
import { chooseContainer, type ProseChoice } from './prose.js'
import type { ReaderDocument } from './wire.js'

/**
 * Whether this page is an article, and if so which one.
 *
 * ## Refusing is the feature
 *
 * The failure that matters is not "reader mode showed the wrong thing" — the user sees that at once and
 * presses back. It is **reader mode showing three paragraphs of a nine-paragraph article**: the text is
 * right, the formatting is right, and the user only finds out on reaching the end, where the piece
 * simply stops. Nothing on the page says so. That is worse than a refusal, because a refusal costs one
 * click and this costs the reader their understanding of what they read.
 *
 * Two mechanisms answer it and only the second is a threshold:
 *
 *  1. **The container is chosen by descent, not by density.** `prose.ts` walks down from the body for
 *     as long as one child still holds nine tenths of the *document's* prose, which makes the property
 *     structural rather than statistical: whatever comes out holds at least nine tenths of every
 *     character of prose on the page. Truncation is not made unlikely, it is bounded — as far as
 *     furniture detection is correct, which is where the honest caveat lives and is reported as such.
 *  2. **A minimum in a unit that means something.** `MIN_PROSE_MASS` is characters of body text with
 *     link text subtracted, so it can be argued with. Below it the answer is "this does not look like an
 *     article", with the measured figure shown beside it.
 *
 * Everything else in reader mode is presentation. This file is where it says no.
 */

function measurementOf(choice: ProseChoice, truncated: boolean): ReaderMeasurement {
  const { measure } = choice
  return {
    mass: measure.mass,
    documentMass: choice.documentMass,
    required: MIN_PROSE_MASS,
    blocks: measure.blocks,
    linkDensity: measure.text === 0 ? 0 : measure.linkText / measure.text,
    truncated
  }
}

/**
 * Drops the article's own headline when the page will render it as the title anyway.
 *
 * Only the first block, and only on an exact match. A page whose `<h1>` differs from its `og:title` has
 * said two things and both are worth keeping; a page that repeats itself would otherwise show the
 * headline twice, which reads as a rendering bug rather than as fidelity.
 */
function withoutDuplicateHeadline(
  blocks: readonly ReaderBlock[],
  title: string | null
): readonly ReaderBlock[] {
  if (title === null) return blocks
  const wanted = title.trim().toLowerCase()
  const duplicated = blocks
    .slice(0, 1)
    .filter(
      (block) => block.kind === 'heading' && inlineTextOf(block.inlines).toLowerCase() === wanted
    )
  return duplicated.length === 0 ? blocks : blocks.slice(1)
}

/**
 * Reads an article out of a transcribed page, or says why it did not.
 *
 * Total: every document produces an outcome. The order of the checks is the order of how much they
 * know — a partial document invalidates every measurement taken from it, so it is refused before
 * anything at all is concluded from the numbers.
 */
export function extractArticle(document: ReaderDocument): ReaderOutcome {
  const choice = chooseContainer(document.root)
  const measurement = measurementOf(choice, document.truncated)
  const { url } = document

  if (document.truncated) return { kind: 'refused', url, reason: 'truncated', measurement }
  if (measurement.mass === 0) return { kind: 'refused', url, reason: 'no-prose', measurement }
  if (measurement.mass < MIN_PROSE_MASS) {
    return { kind: 'refused', url, reason: 'too-little-prose', measurement }
  }

  const metadata = metadataOf(document, choice)
  const blocks = withoutDuplicateHeadline(blocksOf(choice.container), metadata.title)
  return { kind: 'article', url, article: { ...metadata, blocks }, measurement }
}
