# Full Page Screenshot

A small Chrome extension that captures a screenshot — full page or just the
current viewport — and either downloads it as a PNG or copies it to the
clipboard. Created with Claude because the previous extension I was using
got banned from the chrome web store, so why not skip the vulns and just
create one instead?

It supports two capture methods, selectable in the popup:

- **Scroll and stitch** (default) — scrolls the page in viewport-height
  steps, screenshots each step with `chrome.tabs.captureVisibleTab`, and
  stitches the tiles together on a canvas. The traditional approach most
  full-page screenshot tools use.
- **Chrome DevTools Protocol (CDP)** — resizes the capture region with
  `Page.getLayoutMetrics` + `Page.captureScreenshot`'s
  `captureBeyondViewport`/`clip`, the same calls DevTools' own Command Menu
  actions *"Capture full size screenshot"* and *"Capture screenshot"* use
  internally. Nothing on the page scrolls; the browser renders the whole
  page (or just the viewport) in one shot.

Both methods run in the background service worker (`background.js`), not the
popup. MV3 popups are torn down the instant they lose focus, which would
otherwise risk aborting a capture mid-flight if the popup closed while it was
running — leaving the CDP debugger stuck attached to the tab (and its
"started debugging this browser" banner stuck up), or the page left scrolled
wherever the scroll-and-stitch loop happened to be. The popup sends the
service worker a message to trigger the capture, then — once the result
comes back — handles the output step itself (downloading the PNG or writing
it to the clipboard; see "Limitations" for what that means if the popup
closes before the result arrives).

## Choosing a capture method

Each method has a real footgun the other one doesn't:

**Scroll and stitch** drives a genuine scroll, so anything that only renders
*because* a scroll event fired — lazy-loaded images gated on
`IntersectionObserver`, virtualized/windowed lists (e.g. `react-window`),
infinite-scroll feeds — shows up correctly. It also detects fixed/sticky
headers, footers, and sidebars automatically: before the main capture loop,
it nudges the page by a small fixed amount and diffs the before/after
screenshots. Real content shifts by that same amount; any row or column
that comes back pixel-identical despite the page having genuinely scrolled
can only be something that doesn't move with the page — i.e. a `position:
fixed`/`sticky` element. A header/footer spans the full width and sits at
the top/bottom edge (detected as a matching *row* band); a sidebar spans
the full height and sits at the left/right edge (a matching *column*
band). Headers/footers are drawn once, from the tile where they naturally
belong, with the scroll step shrunk to match so nothing in between is
missed. Sidebars are drawn once from the first tile — since they're fixed,
every tile's copy is identical, so there's no gain in redrawing one, and
(unlike a header) no scroll trick reveals whatever's behind it — so the
rest of the page is left with a plain gap where it was, rather than
repeating it.

This is a pixel-based heuristic, not real DOM inspection, so it isn't
foolproof. It tolerates a small amount of noise per row/column (a
handful of live pixels — a badge, a caret, minor anti-aliasing jitter —
out of an otherwise-static header is still recognized as fixed), but an
element whose content changes substantially between the two probe shots
(a live clock, an animation) won't register as fixed, and it only
recognizes bands that span a full edge — a floating corner widget (e.g. a
chat bubble) isn't detected, since neither its row nor its column fully
matches. In those cases it falls back to drawing every tile in full, i.e.
plain duplication. What it fundamentally still can't do: **the thing that
scrolls isn't always "the page."** A lot of modern sites (chat apps, docs
viewers, admin dashboards, anything built as an SPA) don't scroll `<body>`
at all — the real scroll container is some inner `<div>` with
`overflow: auto`. Scrolling `window` does nothing to that content, so a
"full page" capture there ends up as the same viewport repeated. It's also
slower for long pages — one `captureVisibleTab` call per viewport-height, a
few hundred milliseconds apart to stay under Chrome's rate limit and let
each step repaint, plus one extra probe step up front.

**CDP** sidesteps all of that — nothing on the page ever scrolls, so nested
scroll containers, sticky/fixed elements, and scroll-linked effects are
captured exactly as laid out, in one call. The trade-off is the flip side:
lazy-loaded/virtualized/infinite-scroll content that depends on a real
scroll event never renders, showing up blank or truncated. It also
occasionally misbehaves on some pages — if a capture comes back wrong, or
fails, try switching methods.

There's no way to get the benefits of both without walking the DOM for
scrollable regions and handling each one specially, which this tool
intentionally doesn't do. **Scroll and stitch is the default** since it
matches most other full-page screenshot tools and handles the more common
case (lazy-loaded content) correctly out of the box, with fixed-header
duplication largely handled too; switch to CDP for SPA-style pages with an
inner scroll container, or if a scroll-and-stitch capture comes back wrong.

## Permissions, and why each one is there

| Permission | Why |
| --- | --- |
| `debugger` | Only exercised when you pick the **CDP** method — the only way to call `Page.captureScreenshot`/`Page.getLayoutMetrics` with `captureBeyondViewport`. This is the same permission real DevTools implicitly has, just exposed to an extension. It's the scariest-looking permission Chrome offers: while attached, Chrome shows a **"\<extension\> started debugging this browser"** banner across the browser window. That's a hardcoded Chrome behavior for *any* extension using `chrome.debugger` and can't be suppressed. This extension attaches, takes one screenshot, and detaches immediately, so the banner should only flash briefly. Two consequences worth knowing: you can't attach to `chrome://` pages, the Web Store, or other extensions' pages (Chrome blocks it), and only one debugger client can attach to a tab at a time — if real DevTools is already open on that tab, the capture will fail until you close it. |
| `scripting` | Used by the **scroll and stitch** method to run the scroll steps (`window.scrollTo`) and read page metrics (`scrollHeight`, etc.) inside the tab. Scoped by `activeTab`, same as `debugger` — no standing access to any page. |
| `activeTab` | Grants temporary access to *only* the tab you're currently looking at, and only because you clicked the toolbar icon to open the popup. Combined with `debugger`/`scripting`, this is enough to act on that one tab — the extension deliberately does **not** request `<all_urls>`/host permissions, so it has no standing access to anything you haven't explicitly invoked it on. |
| `downloads` | Needed to save the captured PNG to disk when you click **Download**. |

**Copy** uses the standard `navigator.clipboard.write()` Web API
directly from the popup's click handler, which counts as a user gesture —
that doesn't require the `clipboardWrite` extension permission, so it isn't
requested.

## Limitations

- Won't work on `chrome://`, the Chrome Web Store, or other extensions' pages
  (both methods).
- **Scroll and stitch**: only follows the page's own window scroll, not an
  inner scroll container some SPAs use instead (see "Choosing a capture
  method"). Fixed/sticky headers, footers, and sidebars are detected and
  drawn once rather than duplicated, but that detection is a pixel
  heuristic — an element whose content changes on its own (a clock, an
  animation), or one that doesn't span a full edge (a floating corner
  widget), won't be recognized and falls back to repeating per tile. A
  detected sidebar is drawn once from the first tile and left as a plain
  gap for the rest of the page, rather than repeated — there's no scroll
  trick that reveals what (if anything) is really behind it. Full-page
  captures on long pages take proportionally longer — one
  `captureVisibleTab` call per viewport-height, spaced out to respect
  Chrome's capture rate limit, plus one extra probe step up front to check
  for fixed elements.
- **CDP**: fails if another debugger (DevTools itself, or another extension)
  is already attached to the tab — close DevTools on that tab and retry.
  Lazy-loaded/virtualized content that only renders on scroll may appear
  blank or cut off in "Full page" mode.
- The capture itself runs in the background service worker, so it
  completes — and cleans up after itself (debugger detach, or restoring
  scroll position) — even if you close the popup mid-capture. What you lose
  in that case is just the output step: the download or clipboard write
  happens in the popup, so it's skipped if the popup isn't around to receive
  the result. A viewport capture completes in well under a second; a
  full-page scroll-and-stitch capture takes longer on long pages (see
  above).

## Building

Requires `make`, `python3` (stdlib only, no pip installs), and `zip`.

```sh
make          # = make zip: validates manifest.json, stages src/ into
              # dist/chrome-fullpage-screenshot/, and zips it to
              # dist/chrome-fullpage-screenshot-<version>.zip
make build    # stage the unpacked extension into dist/ without zipping
make lint     # just validate manifest.json
make clean    # remove dist/
```

There's no real "build" step — it's plain HTML/CSS/JS — so `make` is mostly
doing validation and packaging. That's also where a bundler/minifier would
slot in later if this grows.

## Installing a local build into Chrome

1. `make` (or `make build` if you just want the unpacked folder, no zip).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select `dist/chrome-fullpage-screenshot` (the staged, unpacked folder —
   *not* the `.zip`; Chrome's "Load unpacked" wants a directory).
   - For active development you can instead point it straight at `src/`
     and skip the build step.
6. Pin the extension (puzzle-piece icon → pin) so its toolbar button is
   visible.

To pick up changes after editing: re-run `make build` (or edit `src/`
directly if you loaded that folder), then click the refresh icon on the
extension's card in `chrome://extensions`.

## Usage

1. Navigate to the page you want to capture.
2. Click the extension's toolbar icon.
3. Choose **Full page** or **Current viewport**.
4. Choose a capture method — **Scroll and stitch** (default) or
   **Chrome DevTools Protocol** (see "Choosing a capture method" above).
5. Click **Copy** or **Download**.

The status line under the buttons reports the result (saved filename, "Copied
to clipboard", or an error). The debugger-banner hint only appears when the
CDP method is selected.
