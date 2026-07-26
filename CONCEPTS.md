# Concepts

Shared domain vocabulary for this project — entities, named processes, and status
concepts with project-specific meaning. Seeded with core domain vocabulary, then
accretes as ce-compound and ce-compound-refresh process learnings; direct edits are
fine. Glossary only, not a spec or catch-all.

## Relationships

Every renderer is classified as exactly one of three **Sender Kinds** — Chrome UI,
Internal Page, or Web Content — and that classification decides what it may reach. A
Content View is not one of them: it is the surface, and the Sender Kind describes what
the surface currently displays. The same Content View moves between Internal Page and
Web Content by navigating, and what the browser accepts from it changes with it.

A Window owns one Chrome UI and many Content Views. It also owns an ordered list of
Tabs and a Layout of Tiles, and those two are deliberately independent: a Tab may exist
without a Tile, but a Tile shows at most one Tab.

A Window also owns at most one Overlay Surface, above every Content View. It counts as
Chrome UI for the purpose of Sender Kinds — it is the browser's own interface, drawn on a
different layer — so the three-way classification stays three-way. The layering runs
Chrome UI at the bottom, Content Views above it, Overlay Surface above those.

## Split view

### Tile
One region of a Window's Layout, showing at most one Tab. A Tile is a full,
independently navigable view rather than a preview — its own process, its own history,
its own audio.
*Avoid:* pane, split, frame

Three rules make a Tile different from a mere pane. A website's fullscreen request is
scoped to the Tile it came from: the page is told it is fullscreen so its player
switches, but the surrounding Tiles stay visible and keep playing. A Tile is never
throttled for being unfocused, because the whole point is watching several at once.
And a Tile has a minimum size below which its divider stops moving, so a drag cannot
collapse one to nothing.

A Tile can also be *maximised* — grown to the whole Window temporarily — which is
distinct from fullscreen and does not discard the Layout.

### Layout
The arrangement of Tiles in a Window, chosen from a fixed set of shapes and adjustable
by dragging the dividers between Tiles.

Divider positions are stored as fractions of the Window rather than pixel offsets, so a
Layout survives a resize. Shrinking a Layout never closes a Tab — Tabs that lose their
Tile become unassigned and stay loaded, so switching back restores them.

### Tab
A loaded page belonging to a Window, listed in the tab strip. A Tab is not the same as
a Tile: a Tab is what is loaded, a Tile is where it is shown.
*Avoid:* page, view

A Tab keeps running whether or not a Tile displays it, which is what makes reducing a
Layout non-destructive. Tab strip order is independent of Tile assignment, so
reordering the strip does not rearrange the Tiles.

## Renderer roles

### Chrome UI
The browser's own interface — tab strip, toolbar, address bar — rendered by a
Window's own web contents rather than by a Content View. It is the only renderer
trusted with the full set of core operations.
*Avoid:* browser UI, shell

The Chrome UI is recognised by identity, not by the address it was loaded from. A
development build serves it over plain HTTP, so any address-based rule loose enough to
accept that would also accept a visited page.

### Content View
An independently rendering surface that displays one page, with its own renderer
process, navigation history and audio state. Each Tab is one Content View, and a Tile
displays one.

Content Views are layered above the Chrome UI rather than inside it. The browser relies
on an engine behaviour that follows from that layering — interface elements drawn
beneath a Content View receive no pointer events — which is why anything draggable
between Tiles needs a gap that no Content View covers, and why interface elements that
have to appear *over* a page belong to the Overlay Surface instead.

### Overlay Surface
The single layer above every Content View, and therefore the only place browser
interface can be both visible and clickable over a page. It is transparent and empty
until something is presented on it, so a page stays visible behind a menu rather than
being hidden to make room for one.

The Chrome UI does not draw on the Overlay Surface directly; it *describes* what should
appear and where, and the core presents it. That keeps one account of what is on screen
instead of two that can disagree, and it makes each surface's payload part of the typed
core boundary.
*Avoid:* popup layer, floating window, modal

Distinct from the full-window panels, which take the opposite approach: those suspend
every Content View and use the Chrome UI's own surface. That is reasonable for something
occupying the whole window and wrong for a dropdown.

### Internal Page
A page the browser serves itself — the start page and its siblings — distinguished by
its own address scheme rather than by being bundled with the application. It is still
Content, so it renders in a Content View and is sandboxed like any page.

An Internal Page is trusted more than Web Content and less than the Chrome UI: it
receives a deliberately narrow set of core operations, not the full set. The narrowness
is the point — nothing stops Web Content from linking to an Internal Page, so its
privileges have to survive being reached that way.

### Web Content
Any visited page that is neither the Chrome UI nor an Internal Page. Web Content
receives no path into the core at all: no bridge is exposed to it, and the core refuses
every operation it attempts.

### Preload Role
The label a renderer is created with — Chrome or Content — that decides which Bridge,
if any, gets exposed to it.

The Role is supplied by the core when it creates the renderer, which makes it the one
input a page cannot influence. An absent or unrecognised Role is treated as Content,
because the restrictive reading has to be the default. Role governs only what is
*exposed*; the core independently decides what it *accepts*, so a renderer that somehow
held a Bridge it should not still gets refused.

### Bridge
The set of core operations exposed into a renderer. There are two: a full one for the
Chrome UI and a narrow one for Internal Pages. Web Content gets none.

Every Bridge channel is name-checked against an allowlist before it is forwarded, and
every subscription returns the function that ends it — nothing may stay attached to the
core after the view that created it is gone.

## Start page

### Quick Link
A saved destination on the start page, shown as a card. A Quick Link is either a link,
which has an address, or a folder, which has none and holds links.
*Avoid:* bookmark, favourite, speed dial entry, start-page tile

Quick Links are not bookmarks: they are the start page's own ordered set, and their
order within a parent is the order they are stored in rather than a separate rank.
Folders hold links but never other folders, so the arrangement is exactly one level
deep. Deleting a folder deletes what it contains rather than leaving those links
parentless. An address is resolved by the same rule the address bar uses, and a search
term is refused rather than quietly turned into a search.

## Flagged ambiguities

- "Chrome" in this codebase means the browser's own interface, never the Google
  browser. The Chrome UI and the underlying Chromium engine are unrelated concepts
  that share a syllable. The one exception is a build-target string naming the engine
  version, where the engine sense is meant.
- "Content" is used in two senses that are worth keeping apart: a Content View is the
  surface, while Web Content is one of the things that surface may display — the other
  being an Internal Page.
- "Tile" had been used for both a split-view region and a start-page entry. Tile now
  means the split-view region only; a start-page entry is a Quick Link, and its visual
  form is a card. The two are unrelated: one is a place a Tab is shown, the other is a
  saved destination.
