/**
 * A tab's icon, or the placeholder square when it has none.
 *
 * Shared by the tab strip, the split tile headers and the tab search, so the three draw the same icon
 * under the same rules.
 */
export function TabFavicon({ url }: { url: string | null }): React.ReactNode {
  return (
    <span className="tab__favicon" aria-hidden="true">
      {url !== null && (
        <img
          /*
            Keyed on the address so a refreshed icon gets a fresh element. Without that, an element
            hidden by the handler below would stay hidden when a working icon finally arrived — React
            reuses the node and never resets what was set on it.
          */
          key={url}
          className="tab__faviconImage"
          src={url}
          alt=""
          /*
            Not draggable, because the address carries the token that makes the icon cache answer at
            all. Dropped into a web page it would hand that page the key.
          */
          draggable={false}
          /*
            A cache miss answers 204, which fails to decode — by design, and the common case rather than
            an error, since most sites are seen before their icon has been fetched. Hiding the image lets
            the placeholder square underneath show instead of Chromium's broken-image glyph.
          */
          onError={(event) => {
            event.currentTarget.hidden = true
          }}
        />
      )}
    </span>
  )
}
