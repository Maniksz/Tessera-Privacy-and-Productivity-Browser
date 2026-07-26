import {
  CARRIED_ATTRIBUTES,
  HARVEST_NODE_BUDGET,
  MAX_HARVEST_DEPTH,
  NEVER_CONTENT_TAGS,
  asReaderDocument,
  type ReaderDocument
} from '@shared/reader/wire.js'

/**
 * Getting the page's DOM to the core.
 *
 * ## The route, and why it is this one
 *
 * A visited page has no IPC bridge at all (spec 6): only its preload can speak to the core. That
 * leaves two ways to read a page's content, and this file is the second of them.
 *
 *   1. **A preload module**, like `preload/cosmetic.ts`. The preload runs in the isolated world that
 *      `contextIsolation` gives it — same DOM, separate script context — so the page cannot see it,
 *      cannot patch what it calls, and cannot know it ran.
 *   2. **`webContents.executeJavaScript` from the core**, which is what this is. The code runs in the
 *      page's **main** world, alongside the page's own scripts.
 *
 * ## What the main world costs, precisely
 *
 * Three things, and they should be written down rather than discovered later:
 *
 *   - **The page can observe it.** A site that has replaced `Element.prototype.checkVisibility`, or
 *     defined a getter on `Node.prototype.nodeValue`, learns the moment reader mode is used. That is
 *     a signal for fingerprinting and for analytics — "this reader opened reader view" — that the
 *     preload route would not have given away.
 *   - **The page can lie.** Anything reachable from the script can be patched, so a hostile page can
 *     hand back text it never displayed. The bound on the damage is that the result is *data*: it
 *     comes back as a JSON string, `asReaderDocument` rebuilds it and refuses anything off-shape, and
 *     `content.ts` cannot express a script, a style, an iframe or an event handler. The worst case is
 *     therefore a wrong article, not code running anywhere.
 *   - **A page script could interfere with the walk.** A `MutationObserver` reacting mid-walk changes
 *     the tree under it. The result is a partial or inconsistent document, which is a wrong article
 *     again rather than anything worse.
 *
 * For reading the text of an article the user has already loaded and is already looking at, that is
 * an acceptable price: the page knows its own content, and it knows the user is reading it. It would
 * **not** be acceptable for anything where the page's answer is trusted — a password field, a form's
 * state, a permission decision — and reader mode must not grow in that direction while it lives here.
 *
 * ## What the preload would have changed
 *
 * With `src/preload/` available, the walk would move there and the core would ask for it over a
 * channel like `PICKER_START_CHANNEL`: unobservable to the page, untamperable by the page, and with
 * one capability this route cannot have at all — the preload owns cosmetic filtering
 * (`preload/cosmetic.ts`), so it knows *which* elements the blocker hid and could say so, instead of
 * inferring it from a computed style the way `checkVisibility` does here.
 *
 * ## Why the walk itself is a generated string and not a function sent through `toString()`
 *
 * Serialising a real function into the page is the tempting shortcut and it is a trap: the bundler is
 * free to rewrite a function body, hoist a helper out of it, or reference a module-scope binding that
 * does not exist in the page. It would compile and then fail at runtime in the built application
 * only. So the injected text is written as text, it is deliberately the dullest possible transcription
 * with no judgement in it, and every decision it *appears* to make comes from a constant in
 * `shared/reader/wire.ts` that the extractor reads from the same place.
 */

export interface ReaderPageScriptHost {
  /** `WebContents.executeJavaScript`. Declared as `unknown` so nothing `any` leaks out of Electron. */
  executeJavaScript(code: string): Promise<unknown>
  /** `WebContents.getURL`, for the link back when the page could not be read at all. */
  getURL(): string
}

/**
 * The transcription, as source for the page's main world.
 *
 * Every constant is interpolated as JSON from `shared/reader/wire.ts`, so the skip list the page
 * applies and the drop list the extractor applies are the same list. A skip list that were wider than
 * the drop list would remove content the extractor would have kept, and neither side could tell.
 *
 * The whole body is wrapped in `try`. A page can leave the DOM in states this walk does not expect —
 * a document with no `body`, a navigation completing mid-walk — and a rejected `executeJavaScript`
 * carries a message about our script rather than about the page, which is a slow diagnosis. Returning
 * a value that fails `asReaderDocument` produces the `unreadable` refusal, which the reader page
 * words for the user.
 */
export function harvestSource(): string {
  const skip = JSON.stringify([...NEVER_CONTENT_TAGS])
  const attributes = JSON.stringify(CARRIED_ATTRIBUTES)
  return `(() => {
  try {
    const skip = new Set(${skip});
    const carried = ${attributes};
    const maxDepth = ${String(MAX_HARVEST_DEPTH)};
    let budget = ${String(HARVEST_NODE_BUDGET)};
    let truncated = false;

    const attributesOf = (element) => {
      const carriedValues = {};
      for (const name of carried) {
        if (!element.hasAttribute(name)) continue;
        // The DOM *property* for an address, so it arrives absolute: nothing downstream resolves a
        // relative URL, and nothing downstream needs the page's base address in order to.
        const value = name === 'href' || name === 'src' ? element[name] : element.getAttribute(name);
        if (typeof value === 'string' && value !== '') carriedValues[name] = value;
      }
      return carriedValues;
    };

    const isHidden = (element) => {
      if (typeof element.checkVisibility !== 'function') return false;
      return !element.checkVisibility({
        contentVisibilityAuto: true,
        opacityProperty: false,
        visibilityProperty: true
      });
    };

    const elementOf = (element, depth) => {
      const node = {
        kind: 'element',
        tag: element.tagName.toLowerCase(),
        id: typeof element.id === 'string' ? element.id : '',
        classes: Array.from(element.classList),
        attributes: attributesOf(element),
        children: []
      };
      // A hidden element becomes a childless leaf: a collapsed mega-menu costs one node instead of
      // four hundred, and the decision to drop it stays where a test can reach it.
      if (isHidden(element)) {
        node.hidden = true;
        return node;
      }
      if (depth >= maxDepth) {
        truncated = true;
        return node;
      }
      for (const child of element.childNodes) {
        if (budget <= 0) {
          truncated = true;
          break;
        }
        if (child.nodeType === 3) {
          budget -= 1;
          node.children.push({ kind: 'text', text: child.nodeValue === null ? '' : child.nodeValue });
          continue;
        }
        if (child.nodeType !== 1) continue;
        if (skip.has(child.tagName.toLowerCase())) continue;
        budget -= 1;
        node.children.push(elementOf(child, depth + 1));
      }
      return node;
    };

    const meta = {};
    const head = document.head;
    if (head !== null) {
      for (const tag of head.querySelectorAll('meta')) {
        const property = tag.getAttribute('property');
        const name = tag.getAttribute('name');
        const key = (property === null ? (name === null ? '' : name) : property).trim().toLowerCase();
        const value = tag.getAttribute('content');
        // First wins: a page repeating og:title states the same thing twice, and the second is as
        // often a template's default as it is a correction.
        if (key !== '' && value !== null && value !== '' && !(key in meta)) meta[key] = value;
      }
    }

    const root = document.body === null ? document.documentElement : document.body;
    const documentElement = document.documentElement;
    return JSON.stringify({
      root: elementOf(root, 0),
      meta,
      documentTitle: typeof document.title === 'string' ? document.title : '',
      lang: documentElement === null ? '' : (documentElement.getAttribute('lang') || ''),
      url: location.href,
      truncated
    });
  } catch (error) {
    // Deliberately not the document shape, so \`asReaderDocument\` refuses it and the reader page
    // shows a worded refusal instead of an empty article.
    return JSON.stringify({ readerHarvestError: String(error) });
  }
})()`
}

/**
 * Asks a page to describe itself, or `null`.
 *
 * `null` for every failure, of which there are four kinds and none of them is exceptional: the view
 * was destroyed, the page navigated mid-call, the script threw and returned its error marker, or the
 * page tampered with the result. All four mean the same thing to the caller — the `unreadable`
 * refusal — so distinguishing them here would only move the decision somewhere it cannot be worded.
 */
export async function harvestDocument(page: ReaderPageScriptHost): Promise<ReaderDocument | null> {
  try {
    const raw = await page.executeJavaScript(harvestSource())
    if (typeof raw !== 'string') return null
    // Annotated `unknown` rather than left as `JSON.parse`'s `any`: the value came out of a page's
    // main world, which is the least trustworthy input this process handles.
    const parsed: unknown = JSON.parse(raw)
    return asReaderDocument(parsed)
  } catch {
    return null
  }
}
